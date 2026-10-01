import { prisma } from "../src/lib/prisma";
import { runDueJobs, scheduleAppointmentReminders } from "../src/services/scheduler";
import { CALLER, HOUR, MINUTE, makeBusiness, makeHarness, missCall, resetDb, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = makeHarness();
});
afterAll(() => prisma.$disconnect());

describe("follow-up nudge", () => {
  it("sends once, after the delay, if the caller never replied", async () => {
    await makeBusiness();
    await missCall(h);
    h.advance(1 * HOUR);
    await runDueJobs(h.deps);
    expect(h.telephony.to(CALLER)).toHaveLength(1);
    h.advance(1 * HOUR + MINUTE);
    expect(await runDueJobs(h.deps)).toMatchObject({ sent: 1 });
    const texts = h.telephony.to(CALLER);
    expect(texts).toHaveLength(2);
    expect(texts[1].body).toContain("Rapid Rooter Plumbing again");
    expect(texts[1].body).toContain("(555) 010-9999");
    await runDueJobs(h.deps);
    expect(h.telephony.to(CALLER)).toHaveLength(2);
  });

  it("is never scheduled into quiet hours — a 7:30pm miss is nudged at 8am", async () => {
    await makeBusiness();
    h.clock.now = new Date("2026-09-30T23:30:00Z"); // 7:30pm EDT
    await missCall(h);
    const job = await prisma.scheduledJob.findFirstOrThrow();
    expect(job.runAt.toISOString()).toBe("2026-10-01T12:00:00.000Z"); // 8:00am EDT
  });

  it("is skipped if the owner already moved the lead on", async () => {
    await makeBusiness();
    await missCall(h);
    await prisma.lead.updateMany({ data: { status: "BOOKED" } });
    h.advance(3 * HOUR);
    expect(await runDueJobs(h.deps)).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("retries a Twilio failure, then gives up after 3 attempts", async () => {
    await makeBusiness();
    await missCall(h);
    for (let i = 0; i < 3; i++) {
      h.advance(3 * HOUR);
      h.telephony.failNext = true;
      await runDueJobs(h.deps);
    }
    const job = await prisma.scheduledJob.findFirstOrThrow();
    expect(job).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("cannot be double-sent by two workers running at once", async () => {
    await makeBusiness();
    await missCall(h);
    h.advance(3 * HOUR);
    await Promise.all([runDueJobs(h.deps), runDueJobs(h.deps)]);
    expect(h.telephony.to(CALLER)).toHaveLength(2); // text-back + exactly one follow-up
  });
});

describe("appointment reminders", () => {
  it("sends 24h and 2h before, with the local time", async () => {
    const business = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.update({
      where: { id: (await prisma.lead.findFirstOrThrow()).id },
      data: { status: "BOOKED", appointmentAt: new Date("2026-10-02T18:00:00Z") }, // Fri 2pm EDT
    });
    await scheduleAppointmentReminders(h.deps, business, lead, lead.appointmentAt!);
    const jobs = await prisma.scheduledJob.findMany({ where: { type: "APPOINTMENT_REMINDER" }, orderBy: { runAt: "asc" } });
    expect(jobs.map((j) => j.runAt.toISOString())).toEqual(["2026-10-01T18:00:00.000Z", "2026-10-02T16:00:00.000Z"]);

    h.clock.now = new Date("2026-10-01T18:01:00Z");
    await runDueJobs(h.deps);
    expect(h.telephony.to(CALLER).at(-1)!.body).toContain("Fri, Oct 2, 2:00 PM");
  });

  it("moves an early-morning 2h reminder back to the previous evening and collapses duplicates", async () => {
    const business = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.findFirstOrThrow();
    // Fri 7:00am EDT: 24h-before is Thu 7am (quiet → Wed 8:45pm), 2h-before is 5am (quiet → Thu 8:45pm).
    await scheduleAppointmentReminders(h.deps, business, lead, new Date("2026-10-02T11:00:00Z"));
    const jobs = await prisma.scheduledJob.findMany({ where: { type: "APPOINTMENT_REMINDER" }, orderBy: { runAt: "asc" } });
    expect(jobs.map((j) => j.runAt.toISOString())).toEqual(["2026-10-01T00:45:00.000Z", "2026-10-02T00:45:00.000Z"]);
  });

  it("is skipped if the appointment was cancelled", async () => {
    const business = await makeBusiness();
    await missCall(h);
    const lead = await prisma.lead.update({
      where: { id: (await prisma.lead.findFirstOrThrow()).id },
      data: { status: "BOOKED", appointmentAt: new Date("2026-10-02T18:00:00Z") },
    });
    await scheduleAppointmentReminders(h.deps, business, lead, lead.appointmentAt!);
    await prisma.lead.update({ where: { id: lead.id }, data: { status: "LOST" } });
    h.clock.now = new Date("2026-10-02T17:00:00Z");
    const before = h.telephony.sent.length;
    await runDueJobs(h.deps);
    expect(h.telephony.sent.length).toBe(before);
  });
});
