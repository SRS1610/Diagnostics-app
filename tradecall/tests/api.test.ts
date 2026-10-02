import request from "supertest";
import { db } from "../src/lib/db";
import { CALLER, HOUR, OWNER, business, harness, missedCall, reset, ringIn, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

describe("accounts", () => {
  it("signup creates a business with its owner; login is per user", async () => {
    const res = await request(h.app)
      .post("/api/auth/signup")
      .send({ businessName: "Cool Air HVAC", ownerName: "Sam", email: "Sam@CoolAir.com", password: "correct horse", ownerPhone: "(555) 010-4444", timezone: "America/Chicago" })
      .expect(201);
    const me = (await h.as(res.body.token).get("/me").expect(200)).body;
    expect(me.business).toMatchObject({ name: "Cool Air HVAC", ownerPhone: "+15550104444", plan: "STARTER", status: "ACTIVE" });
    expect(me.user).toMatchObject({ email: "sam@coolair.com", role: "OWNER", phone: "+15550104444", getsAlerts: true });
    expect(JSON.stringify(me)).not.toContain("passwordHash");

    await request(h.app).post("/api/auth/login").send({ email: "sam@coolair.com", password: "correct horse" }).expect(200);
    await request(h.app).post("/api/auth/login").send({ email: "sam@coolair.com", password: "wrong" }).expect(401);
    await request(h.app).post("/api/auth/signup").send({ businessName: "Again", ownerName: "S", email: "sam@coolair.com", password: "12345678", ownerPhone: "5550104444" }).expect(409);
    await request(h.app).get("/api/leads").expect(401);
    expect((await db.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["tenant_created", "login"]);
  });
});

describe("tenant isolation", () => {
  it("never shows or touches another business's leads, calls or voicemails", async () => {
    const a = await business();
    const b = await business({ phoneNumber: "+15550108888", ownerPhone: "+15550100002" });
    const { sessionId } = await missedCall(h);
    await h.event({ type: "call.recording_ready", sessionId, legId: null, url: "u" } as never);
    const lead = await db.lead.findFirstOrThrow({ where: { businessId: a.id } });
    const call = await db.call.findFirstOrThrow();

    const asB = h.api(b);
    expect((await asB.get("/leads?stage=ALL")).body.leads).toHaveLength(0);
    await asB.get(`/leads/${lead.id}`).expect(404);
    await asB.patch(`/leads/${lead.id}`, { stage: "LOST" }).expect(404);
    await asB.post(`/leads/${lead.id}/messages`, { body: "hi" }).expect(404);
    await asB.put(`/leads/${lead.id}/appointment`, { at: "2026-10-05T15:00:00Z" }).expect(404);
    await asB.get(`/calls/${call.id}/voicemail`).expect(404);
    expect((await asB.get("/dashboard")).body.current.missed).toBe(0);

    await h.api(a).get(`/calls/${call.id}/voicemail`).expect(200);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stage).toBe("NEW");
  });

  it("won't let a business claim a number it doesn't own", async () => {
    await business();
    const b = await business({ phoneNumber: null as never, ownerPhone: "+15550100002" });
    await h.api(b).patch("/settings", { phoneNumber: "+15550109999" }).expect(400); // not settable by tenants at all
    await h.api(b).post("/numbers/buy", { phoneNumber: "+15550109999" }).expect(409);
  });
});

describe("leads", () => {
  it("lists with search by phone, text or #code, plus opt-out flag", async () => {
    const a = await business();
    await missedCall(h);
    await h.sms("STOP");
    const { leads } = (await h.api(a).get("/leads")).body;
    expect(leads[0]).toMatchObject({ code: 1, optedOut: true });
    expect((await h.api(a).get("/leads?q=010-2000")).body.leads).toHaveLength(1);
    expect((await h.api(a).get("/leads?q=%231")).body.leads).toHaveLength(1);
    expect((await h.api(a).get("/leads?q=zzz")).body.leads).toHaveLength(0);
  });

  it("owner reply from the dashboard is sent verbatim and stops the bot", async () => {
    const a = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    await h.api(a).post(`/leads/${lead.id}/messages`, { body: "Can do 3pm {tomorrow}" }).expect(201);
    expect(h.fake.smsTo(CALLER).at(-1)!.text).toBe("Can do 3pm {tomorrow}");
    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ stage: "ENGAGED", intakeStep: 0 });
    expect(await db.job.count({ where: { status: "PENDING" } })).toBe(0);
  });

  it("returns 409 for opted-out contacts and 502 when the provider fails", async () => {
    const a = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    h.fake.failNextSms = true;
    await h.api(a).post(`/leads/${lead.id}/messages`, { body: "hello" }).expect(502);
    await h.sms("STOP");
    await h.api(a).post(`/leads/${lead.id}/messages`, { body: "hello" }).expect(409);
  });

  it("books, reschedules and cancels appointments with reminders", async () => {
    const a = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    await h.api(a).put(`/leads/${lead.id}/appointment`, { at: "2026-10-03T14:00:00Z" }).expect(200);
    let detail = (await h.api(a).get(`/leads/${lead.id}`)).body;
    expect(detail.lead.stage).toBe("SCHEDULED");
    expect(detail.scheduled.map((s: { type: string }) => s.type)).toEqual(["REMINDER", "REMINDER"]);
    await h.api(a).del(`/leads/${lead.id}/appointment`).expect(200);
    detail = (await h.api(a).get(`/leads/${lead.id}`)).body;
    expect(detail.lead.stage).toBe("QUALIFIED");
    expect(detail.scheduled).toHaveLength(0);
    await h.api(a).put(`/leads/${lead.id}/appointment`, { at: "2026-09-01T14:00:00Z" }).expect(400);
  });

  it("doesn't leak provider call ids in lead detail", async () => {
    const a = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    const { calls } = (await h.api(a).get(`/leads/${lead.id}`)).body;
    expect(calls[0]).not.toHaveProperty("callerLegId");
    expect(calls[0]).toMatchObject({ outcome: "MISSED", missReason: "NO_ANSWER", hasVoicemail: false });
  });
});

describe("dashboard", () => {
  it("counts misses by reason, replies, wins and revenue", async () => {
    const a = await business({ avgJobCents: 50000 });
    await missedCall(h);
    await h.sms("Furnace is out");
    const r = await ringIn(h, "+15550103333");
    await h.event({ type: "call.ended", legId: r.callerLeg, cause: "caller_cancel", state: null } as never);
    const answered = await ringIn(h, "+15550104444");
    await h.event({ type: "call.answered", legId: answered.ownerLeg, state: null } as never);
    await h.event({ type: "call.keypress", legId: answered.ownerLeg, digits: "1", outcome: "entered", state: null } as never);
    await h.event({ type: "call.answered", legId: answered.callerLeg, state: null } as never);

    const lead = await db.lead.findFirstOrThrow({ where: { phone: CALLER } });
    await h.api(a).patch(`/leads/${lead.id}`, { stage: "WON", value: 1250.5 }).expect(200);

    const { current, previous } = (await h.api(a).get("/dashboard?days=7")).body;
    expect(current).toMatchObject({
      calls: 3, answered: 1, missed: 2, missedCallers: 2,
      missReasons: { NO_ANSWER: 1, CALLER_HUNG_UP: 1, NOT_ACCEPTED: 0, FORWARDED: 0 },
      textBacks: 2, replied: 1, replyRate: 0.5, newLeads: 2, won: 1, wonCents: 125050, atRiskCents: 100000, savedCents: 50000,
    });
    expect(current.daily).toHaveLength(7);
    expect(current.daily.at(-1)).toMatchObject({ date: "2026-09-30", missed: 2, replied: 1 });
    expect(previous.missed).toBe(0);
  });

  it("credits a next-day reply to the day of the missed call", async () => {
    const a = await business();
    await missedCall(h);
    h.advance(20 * HOUR);
    await h.sms("sorry just saw this — drain is clogged");
    const { current } = (await h.api(a).get("/dashboard")).body;
    expect(current.daily.find((d: { date: string }) => d.date === "2026-09-30")).toMatchObject({ missed: 1, replied: 1 });
  });

  it("excludes the owner's self-test calls", async () => {
    const a = await business();
    await h.event({ type: "call.incoming", legId: "self", sessionId: "s", from: OWNER, to: "+15550109999" } as never);
    expect((await h.api(a).get("/dashboard")).body.current.calls).toBe(0);
  });
});

describe("settings & numbers", () => {
  it("validates and saves", async () => {
    const a = await business();
    await h.api(a).patch("/settings", { ringSeconds: 5 }).expect(400);
    await h.api(a).patch("/settings", { timezone: "Mars/Base" }).expect(400);
    await h.api(a).patch("/settings", { passwordHash: "x" }).expect(400);
    const res = await h.api(a).patch("/settings", { callMode: "FORWARDED", avgJob: 799, hours: { sun: { open: "09:00", close: "12:00" } } }).expect(200);
    expect(res.body.business).toMatchObject({ callMode: "FORWARDED", avgJobCents: 79900 });
  });

  it("buys a number for an account that has none", async () => {
    const a = await business({ phoneNumber: null as never });
    const pick = (await h.api(a).get("/numbers/search?areaCode=512")).body.numbers[0].phoneNumber;
    expect((await h.api(a).post("/numbers/buy", { phoneNumber: pick }).expect(201)).body.business.phoneNumber).toBe(pick);
    expect(h.fake.bought).toEqual([pick]);
    await h.api(a).post("/numbers/buy", { phoneNumber: pick }).expect(409);
  });
});
