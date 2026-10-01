import { db } from "../src/lib/db";
import { CALLER, NUMBER, OWNER, business, harness, missedCall, reset, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

const lastTo = (n: string) => h.fake.smsTo(n).at(-1)?.text ?? "";

describe("intake after a missed call", () => {
  it("asks job → address → emergency, then sends the owner a summary they can reply to", async () => {
    await business();
    await missedCall(h);
    await h.sms("Water heater leaking in the garage");
    expect(lastTo(CALLER)).toContain("address");
    await h.sms("42 Elm St 78701");
    expect(lastTo(CALLER)).toContain("emergency");
    await h.sms("no");
    expect(lastTo(CALLER)).toContain("Dana will get back to you");

    expect(await db.lead.findFirstOrThrow()).toMatchObject({
      job: "Water heater leaking in the garage", address: "42 Elm St 78701", urgent: false, stage: "QUALIFIED", intakeStep: 0, code: 1,
    });
    const alert = lastTo(OWNER);
    expect(alert).toContain("New lead #1 – (555) 010-2000");
    expect(alert).toContain("Need: Water heater leaking");
    expect(alert).toContain("Reply to this text to answer them");
  });

  it("flags urgent from YES or from the job description", async () => {
    await business();
    await missedCall(h);
    await h.sms("Pipe burst, basement flooding");
    await h.sms("12 Oak");
    await h.sms("not sure");
    expect((await db.lead.findFirstOrThrow()).urgent).toBe(true);
    expect(lastTo(OWNER)).toContain("🚨 URGENT");
  });

  it("forwards texts straight to the owner when intake is off", async () => {
    await business({ intakeEnabled: false });
    await missedCall(h);
    await h.sms("Need my AC looked at");
    expect(h.fake.smsTo(CALLER)).toHaveLength(1);
    expect(lastTo(OWNER)).toContain('#1 (555) 010-2000: "Need my AC looked at"');
  });

  it("treats a cold text as a new lead and runs intake", async () => {
    await business();
    await h.sms("Do you do drain cleaning?", "+15550103333");
    expect(await db.lead.findFirstOrThrow()).toMatchObject({ phone: "+15550103333", job: "Do you do drain cleaning?", intakeStep: 2, stage: "ENGAGED" });
  });
});

describe("owner replies by text", () => {
  it("relays a bare reply to the lead from the latest alert", async () => {
    await business();
    await missedCall(h);
    await h.sms("Leaky faucet");
    await h.sms("1 Main St");
    await h.sms("no");
    await h.sms("Hi it's Dana, I can come at 3 {today}", OWNER);
    expect(lastTo(CALLER)).toBe("Hi it's Dana, I can come at 3 {today}");
    const msg = await db.message.findFirstOrThrow({ where: { kind: "OWNER" } });
    expect(msg.direction).toBe("OUT");
  });

  it("targets a specific lead with #code", async () => {
    await business();
    await missedCall(h, "+15550103001");
    await missedCall(h, "+15550103002");
    await h.sms("#1 On my way", OWNER);
    expect(lastTo("+15550103001")).toBe("On my way");
    expect(h.fake.smsTo("+15550103002")).toHaveLength(1); // only the auto text-back
  });

  it("lists open leads on LEADS and explains itself on nonsense", async () => {
    await business();
    await missedCall(h);
    await h.sms("leads", OWNER);
    expect(lastTo(OWNER)).toContain("#1 (555) 010-2000");
    await h.sms("#99 hello", OWNER);
    expect(lastTo(OWNER)).toContain("no lead #99");
  });

  it("stops the bot once the owner takes over", async () => {
    await business();
    await missedCall(h);
    await h.sms("#1 Hey, Dana here — what's going on?", OWNER);
    expect(await db.lead.findFirstOrThrow()).toMatchObject({ stage: "ENGAGED", intakeStep: 0 });
    expect(await db.job.count({ where: { status: "PENDING" } })).toBe(0);
    await h.sms("my sink is clogged");
    expect(lastTo(OWNER)).toContain('"my sink is clogged"'); // forwarded, not an intake question
  });

  it("tells the owner when the customer opted out", async () => {
    await business();
    await missedCall(h);
    await h.sms("STOP");
    await h.sms("#1 hello?", OWNER);
    expect(lastTo(OWNER)).toContain("replied STOP");
  });
});

describe("opt-out", () => {
  it("records STOP silently and cancels scheduled texts", async () => {
    await business();
    await missedCall(h);
    await h.sms("Stop");
    expect(await db.optOut.count()).toBe(1);
    expect(await db.job.count({ where: { status: "PENDING" } })).toBe(0);
    expect(h.fake.smsTo(CALLER)).toHaveLength(1);
  });

  it("re-subscribes on START and tells the owner", async () => {
    await business();
    await missedCall(h);
    await h.sms("STOP");
    await h.sms("START");
    expect(await db.optOut.count()).toBe(0);
    expect(lastTo(OWNER)).toContain("opted back in");
  });

  it("treats YES as an emergency answer for someone who never opted out", async () => {
    await business();
    await missedCall(h);
    await h.sms("leak");
    await h.sms("2 Pine");
    await h.sms("YES");
    expect((await db.lead.findFirstOrThrow()).urgent).toBe(true);
  });
});

describe("delivery status", () => {
  it("updates messages from provider status events", async () => {
    await business();
    await missedCall(h);
    const { providerId } = h.fake.sms[0];
    await h.event({ type: "sms.status", providerId, status: "failed", error: "Carrier rejected" } as never);
    expect(await db.message.findFirstOrThrow()).toMatchObject({ status: "failed", error: "Carrier rejected" });
  });

  it("ignores texts to numbers nobody owns", async () => {
    await business();
    await h.sms("hello", CALLER, "+15550107777");
    expect(await db.lead.count()).toBe(0);
  });

  it("ignores a duplicate provider message id", async () => {
    await business();
    await missedCall(h);
    await h.event({ type: "sms.received", providerId: "dup", from: CALLER, to: NUMBER, text: "hi" } as never);
    await h.event({ type: "sms.received", providerId: "dup", from: CALLER, to: NUMBER, text: "hi" } as never);
    expect(await db.message.count({ where: { direction: "IN" } })).toBe(1);
  });
});
