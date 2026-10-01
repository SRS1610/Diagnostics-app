import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { CALLER, HOUR, makeBusiness, makeHarness, missCall, resetDb, text, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = makeHarness();
});
afterAll(() => prisma.$disconnect());

describe("auth", () => {
  it("signs up, logs in, and rejects a wrong password", async () => {
    const signup = await request(h.app)
      .post("/api/auth/signup")
      .send({
        businessName: "Cool Air HVAC",
        ownerName: "Sam",
        email: "Sam@CoolAir.com",
        password: "correct horse",
        ownerPhone: "(555) 010-4444",
        timezone: "America/Chicago",
      })
      .expect(201);
    expect(signup.body.business).toMatchObject({ ownerPhone: "+15550104444", ownerEmail: "sam@coolair.com" });
    expect(signup.body.business.passwordHash).toBeUndefined();

    await request(h.app).post("/api/auth/login").send({ email: "sam@coolair.com", password: "correct horse" }).expect(200);
    await request(h.app).post("/api/auth/login").send({ email: "sam@coolair.com", password: "nope" }).expect(401);
    await request(h.app)
      .post("/api/auth/signup")
      .send({ businessName: "X Co", ownerName: "X", email: "sam@coolair.com", password: "12345678", ownerPhone: "5550104444" })
      .expect(409);
  });

  it("requires a token for the API", async () => {
    await request(h.app).get("/api/leads").expect(401);
    await request(h.app).get("/api/leads").set("Authorization", "Bearer garbage").expect(401);
  });
});

describe("tenant isolation", () => {
  it("never lets one business read or act on another's leads", async () => {
    const a = await makeBusiness();
    const b = await makeBusiness({ twilioNumber: "+15550108888", ownerPhone: "+15550100002" });
    await missCall(h);
    const leadA = await prisma.lead.findFirstOrThrow({ where: { businessId: a.id } });

    const asB = h.api(b);
    expect((await asB.get("/leads")).body.leads).toHaveLength(0);
    await asB.get(`/leads/${leadA.id}`).expect(404);
    await asB.patch(`/leads/${leadA.id}`, { status: "LOST" }).expect(404);
    await asB.post(`/leads/${leadA.id}/messages`, { body: "hi" }).expect(404);
    await asB.put(`/leads/${leadA.id}/appointment`, { at: "2026-10-05T15:00:00Z" }).expect(404);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadA.id } })).status).toBe("NEW");

    const statsB = (await asB.get("/dashboard")).body.current;
    expect(statsB.missedCalls).toBe(0);
    expect((await h.api(a).get("/dashboard")).body.current.missedCalls).toBe(1);
  });

  it("rejects claiming a Twilio number another business already uses", async () => {
    await makeBusiness();
    const b = await makeBusiness({ twilioNumber: null as never, ownerPhone: "+15550100002" });
    await h.api(b).patch("/settings", { twilioNumber: "+15550109999" }).expect(409);
  });
});

describe("leads", () => {
  it("lists leads with the latest message and the opt-out flag", async () => {
    const a = await makeBusiness();
    await missCall(h);
    await text(h, "STOP");
    const { leads } = (await h.api(a).get("/leads?status=OPEN")).body;
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ phone: CALLER, optedOut: true });
    expect(leads[0].lastMessage.body).toBe("STOP");
    expect((await h.api(a).get("/leads?search=010-2000")).body.leads).toHaveLength(1);
    expect((await h.api(a).get("/leads?search=nomatch")).body.leads).toHaveLength(0);
  });

  it("lets the owner reply, which stops the bot and the follow-up", async () => {
    const a = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.findFirstOrThrow();
    const res = await h.api(a).post(`/leads/${lead.id}/messages`, { body: "Hi, this is Dana — I can come by at {3pm}" }).expect(201);
    expect(res.body.message).toMatchObject({ direction: "OUTBOUND", kind: "MANUAL" });
    expect(h.telephony.to(CALLER).at(-1)!.body).toBe("Hi, this is Dana — I can come by at {3pm}");
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "CONTACTED", qualifyStep: 0 });
    expect(await prisma.scheduledJob.count({ where: { status: "PENDING" } })).toBe(0);
  });

  it("refuses to text an opted-out contact", async () => {
    const a = await makeBusiness();
    await missCall(h);
    await text(h, "STOP");
    const lead = await prisma.lead.findFirstOrThrow();
    const res = await h.api(a).post(`/leads/${lead.id}/messages`, { body: "hello?" }).expect(409);
    expect(res.body.error).toContain("STOP");
  });

  it("reports a Twilio send failure as 502 and logs the failed message", async () => {
    const a = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.findFirstOrThrow();
    h.telephony.failNext = true;
    await h.api(a).post(`/leads/${lead.id}/messages`, { body: "hello" }).expect(502);
    expect(await prisma.message.count({ where: { status: "failed" } })).toBe(1);
  });

  it("books an appointment, schedules reminders, and cancels them when the job is lost", async () => {
    const a = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.findFirstOrThrow();
    await h.api(a).put(`/leads/${lead.id}/appointment`, { at: "2026-10-03T14:00:00Z" }).expect(200);
    const detail = (await h.api(a).get(`/leads/${lead.id}`)).body;
    expect(detail.lead.status).toBe("BOOKED");
    expect(detail.scheduled.map((s: { type: string }) => s.type)).toEqual(["APPOINTMENT_REMINDER", "APPOINTMENT_REMINDER"]);

    await h.api(a).patch(`/leads/${lead.id}`, { status: "LOST" }).expect(200);
    expect((await h.api(a).get(`/leads/${lead.id}`)).body.scheduled).toHaveLength(0);
  });

  it("rejects an appointment in the past", async () => {
    const a = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.findFirstOrThrow();
    await h.api(a).put(`/leads/${lead.id}/appointment`, { at: "2026-09-01T14:00:00Z" }).expect(400);
  });

  it("counts won jobs and revenue on the dashboard", async () => {
    const a = await makeBusiness({ avgJobValueCents: 50000 });
    await missCall(h);
    await text(h, "Furnace won't start");
    await missCall(h, "+15550103333");
    const lead = await prisma.lead.findFirstOrThrow({ where: { phone: CALLER } });
    await h.api(a).patch(`/leads/${lead.id}`, { status: "WON", jobValue: 1250.5 }).expect(200);

    const { current, previous } = (await h.api(a).get("/dashboard?days=7")).body;
    expect(current).toMatchObject({
      missedCalls: 2,
      missedCallers: 2,
      textBacksSent: 2,
      repliedLeads: 1,
      replyRate: 0.5,
      newLeads: 2,
      wonJobs: 1,
      revenueWonCents: 125050,
      revenueAtRiskCents: 100000,
      pipelineRecoveredCents: 50000,
    });
    expect(current.daily).toHaveLength(7);
    expect(current.daily.at(-1)).toMatchObject({ date: "2026-09-30", missed: 2, replied: 1 });
    expect(previous.missedCalls).toBe(0);
  });
});

describe("settings & numbers", () => {
  it("validates and saves settings", async () => {
    const a = await makeBusiness();
    await h.api(a).patch("/settings", { ringTimeoutSec: 5 }).expect(400);
    await h.api(a).patch("/settings", { timezone: "Mars/Olympus" }).expect(400);
    await h.api(a).patch("/settings", { passwordHash: "x" }).expect(400);
    const res = await h
      .api(a)
      .patch("/settings", {
        callMode: "CARRIER_FORWARD",
        avgJobValue: 799,
        businessHours: { sun: { open: "09:00", close: "12:00" } },
      })
      .expect(200);
    expect(res.body.business).toMatchObject({ callMode: "CARRIER_FORWARD", avgJobValueCents: 79900 });
  });

  it("searches and buys a number for an account without one", async () => {
    const a = await makeBusiness({ twilioNumber: null as never });
    const search = await h.api(a).get("/numbers/search?areaCode=512").expect(200);
    const pick = search.body.numbers[0].phoneNumber;
    const res = await h.api(a).post("/numbers/purchase", { phoneNumber: pick }).expect(201);
    expect(res.body.business.twilioNumber).toBe(pick);
    expect(h.telephony.purchased).toEqual([pick]);
    await h.api(a).post("/numbers/purchase", { phoneNumber: pick }).expect(409);
  });
});

describe("dashboard over time", () => {
  it("attributes a next-day reply to the day of the missed call", async () => {
    const a = await makeBusiness();
    await missCall(h);
    h.advance(20 * HOUR);
    await text(h, "sorry, saw this late — need a drain cleared");
    const { current } = (await h.api(a).get("/dashboard?days=7")).body;
    expect(current.daily.find((d: { date: string }) => d.date === "2026-09-30")).toMatchObject({ missed: 1, replied: 1 });
  });
});
