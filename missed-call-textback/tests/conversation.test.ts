import { prisma } from "../src/lib/prisma";
import { CALLER, OWNER, TWILIO_NUMBER, makeBusiness, makeHarness, missCall, resetDb, text, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = makeHarness();
});
afterAll(() => prisma.$disconnect());

const lastTo = (n: string) => h.telephony.to(n).at(-1)?.body ?? "";

describe("intake questions after a missed call", () => {
  it("collects job, address and urgency, then alerts the owner with a summary", async () => {
    await makeBusiness();
    await missCall(h);

    await text(h, "Water heater is leaking");
    expect(lastTo(CALLER)).toContain("address");
    await text(h, "42 Elm St, 78701");
    expect(lastTo(CALLER)).toContain("emergency");
    await text(h, "no");
    expect(lastTo(CALLER)).toContain("Dana will reach out shortly");

    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      jobDescription: "Water heater is leaking",
      address: "42 Elm St, 78701",
      urgent: false,
      status: "QUALIFIED",
      qualifyStep: 0,
    });
    const alerts = h.telephony.to(OWNER);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("New lead");
    expect(alerts[0].body).toContain("Need: Water heater is leaking");
    expect(alerts[0].body).toContain("Where: 42 Elm St, 78701");
    expect(await prisma.message.count({ where: { leadId: lead.id } })).toBe(7); // 1 text-back + 3 in + 3 out
  });

  it("flags the lead urgent on YES and says so to the customer and the owner", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "toilet issue");
    await text(h, "12 Oak Ave");
    await text(h, "YES");
    expect(lastTo(CALLER)).toContain("urgent");
    expect(h.telephony.to(OWNER)[0].body).toContain("🚨 URGENT");
    expect((await prisma.lead.findFirstOrThrow()).urgent).toBe(true);
  });

  it("detects urgency from the job description alone", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "Pipe burst, basement is flooding!!");
    await text(h, "12 Oak Ave");
    await text(h, "not sure");
    expect((await prisma.lead.findFirstOrThrow()).urgent).toBe(true);
  });

  it("forwards every text to the owner once intake is done", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "a");
    await text(h, "b");
    await text(h, "no");
    await text(h, "Also can you look at the sink?");
    expect(lastTo(OWNER)).toContain('"Also can you look at the sink?"');
  });

  it("just forwards replies when intake is disabled", async () => {
    await makeBusiness({ qualifyEnabled: false });
    await missCall(h);
    await text(h, "Need AC repair");
    expect(h.telephony.to(CALLER)).toHaveLength(1); // only the text-back
    expect(lastTo(OWNER)).toContain("Need AC repair");
    expect((await prisma.lead.findFirstOrThrow()).status).toBe("CONTACTED");
  });

  it("treats a first text to the business number as a new lead", async () => {
    await makeBusiness();
    await text(h, "Do you install ceiling fans?", "+15550103333");
    const lead = await prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({ phone: "+15550103333", jobDescription: "Do you install ceiling fans?", qualifyStep: 2 });
    expect(lastTo("+15550103333")).toContain("address");
  });

  it("ignores a webhook retry with the same MessageSid", async () => {
    await makeBusiness();
    await missCall(h);
    const params = { MessageSid: "SMdup", From: CALLER, To: TWILIO_NUMBER, Body: "hello" };
    await h.twilioPost("/twilio/sms/incoming", params).expect(200);
    await h.twilioPost("/twilio/sms/incoming", params).expect(200);
    expect(await prisma.message.count({ where: { direction: "INBOUND" } })).toBe(1);
  });

  it("ignores texts to numbers that aren't connected to any business", async () => {
    await makeBusiness();
    await text(h, "hello", CALLER, "+15550107777");
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe("opt-out", () => {
  it("records STOP, stops the intake and cancels scheduled texts", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "stop");
    expect(await prisma.optOut.count()).toBe(1);
    expect(await prisma.scheduledJob.count({ where: { status: "PENDING" } })).toBe(0);
    expect(h.telephony.to(CALLER)).toHaveLength(1); // no reply from us; Twilio sends the confirmation
    expect((await prisma.lead.findFirstOrThrow()).qualifyStep).toBe(0);
  });

  it("lets the person opt back in with START, and tells the owner", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "STOP");
    await text(h, "START");
    expect(await prisma.optOut.count()).toBe(0);
    expect(lastTo(OWNER)).toContain("opted back in");
  });

  it("treats YES as an emergency answer, not an opt-in, for someone who never opted out", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "leak");
    await text(h, "1 Main");
    await text(h, "Yes");
    expect((await prisma.lead.findFirstOrThrow()).urgent).toBe(true);
  });
});
