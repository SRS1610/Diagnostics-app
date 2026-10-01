import { db } from "../src/lib/db";
import { runDueJobs, scheduleReminders } from "../src/core/jobs";
import { CALLER, HOUR, MIN, business, harness, missedCall, reset, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

describe("nudge", () => {
  it("sends one nudge after the delay if the caller never replied", async () => {
    await business();
    await missedCall(h);
    h.advance(HOUR);
    await runDueJobs(h.deps);
    expect(h.fake.smsTo(CALLER)).toHaveLength(1);
    h.advance(HOUR + MIN);
    expect(await runDueJobs(h.deps)).toMatchObject({ sent: 1 });
    expect(h.fake.smsTo(CALLER)[1].text).toContain("Rapid Rooter again");
    expect(h.fake.smsTo(CALLER)[1].text).toContain("(555) 010-9999");
    await runDueJobs(h.deps);
    expect(h.fake.smsTo(CALLER)).toHaveLength(2);
  });

  it("moves out of quiet hours: a 7:30pm miss is nudged at 8am", async () => {
    await business();
    h.clock.now = new Date("2026-09-30T23:30:00Z");
    await missedCall(h);
    expect((await db.job.findFirstOrThrow()).runAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("is cancelled by a reply", async () => {
    await business();
    await missedCall(h);
    await h.sms("yes please, kitchen sink");
    h.advance(3 * HOUR);
    await runDueJobs(h.deps);
    expect(h.fake.smsTo(CALLER).some((m) => m.text.includes("again"))).toBe(false);
  });

  it("retries provider failures, then gives up after 3 attempts", async () => {
    await business();
    await missedCall(h);
    for (let i = 0; i < 3; i++) {
      h.advance(3 * HOUR);
      h.fake.failNextSms = true;
      await runDueJobs(h.deps);
    }
    expect(await db.job.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("can't be sent twice by two workers", async () => {
    await business();
    await missedCall(h);
    h.advance(3 * HOUR);
    await Promise.all([runDueJobs(h.deps), runDueJobs(h.deps)]);
    expect(h.fake.smsTo(CALLER)).toHaveLength(2);
  });
});

describe("appointment reminders", () => {
  it("sends 24h and 2h ahead with the local time", async () => {
    const b = await business();
    await missedCall(h);
    const lead = await db.lead.update({
      where: { id: (await db.lead.findFirstOrThrow()).id },
      data: { stage: "SCHEDULED", appointmentAt: new Date("2026-10-02T18:00:00Z") },
    });
    await scheduleReminders(h.deps, b, lead, lead.appointmentAt!);
    const runAts = (await db.job.findMany({ where: { type: "REMINDER" }, orderBy: { runAt: "asc" } })).map((j) => j.runAt.toISOString());
    expect(runAts).toEqual(["2026-10-01T18:00:00.000Z", "2026-10-02T16:00:00.000Z"]);
    h.clock.now = new Date("2026-10-01T18:01:00Z");
    await runDueJobs(h.deps);
    expect(h.fake.smsTo(CALLER).at(-1)!.text).toContain("Fri, Oct 2, 2:00 PM");
  });

  it("pulls early-morning reminders back to the evening before", async () => {
    const b = await business();
    await missedCall(h);
    const lead = await db.lead.findFirstOrThrow();
    await scheduleReminders(h.deps, b, lead, new Date("2026-10-02T11:00:00Z")); // Fri 7am
    const runAts = (await db.job.findMany({ where: { type: "REMINDER" }, orderBy: { runAt: "asc" } })).map((j) => j.runAt.toISOString());
    expect(runAts).toEqual(["2026-10-01T00:45:00.000Z", "2026-10-02T00:45:00.000Z"]);
  });
});
