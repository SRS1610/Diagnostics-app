import { prisma } from "../src/lib/prisma";
import { runWeeklyDigests } from "../src/services/digest";
import { HOUR, OWNER, makeBusiness, makeHarness, missCall, resetDb, text, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await resetDb();
  h = makeHarness();
});
afterAll(() => prisma.$disconnect());

const MON_7AM_NY = new Date("2026-10-05T11:00:00Z");
const MON_8AM_NY = new Date("2026-10-05T12:00:00Z");

describe("weekly digest", () => {
  it("goes out Monday at 8am local, by SMS and email, exactly once", async () => {
    await makeBusiness();
    await missCall(h);
    await text(h, "need a quote");

    h.clock.now = MON_7AM_NY;
    expect(await runWeeklyDigests(h.deps)).toBe(0);

    h.clock.now = MON_8AM_NY;
    expect(await runWeeklyDigests(h.deps)).toBe(1);
    const sms = h.telephony.to(OWNER).at(-1)!.body;
    expect(sms).toContain("Missed calls: 1");
    expect(sms).toContain("Replied: 1 (100%)");
    expect(sms).toContain("Est. pipeline saved: $450");
    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0].subject).toBe("Your week: 1 missed calls, 1 leads saved");

    h.advance(2 * HOUR);
    expect(await runWeeklyDigests(h.deps)).toBe(0);
    h.clock.now = new Date(MON_8AM_NY.getTime() + 7 * 24 * HOUR);
    expect(await runWeeklyDigests(h.deps)).toBe(1);
  });

  it("respects the owner turning it off", async () => {
    await makeBusiness({ weeklyDigestEnabled: false });
    h.clock.now = MON_8AM_NY;
    expect(await runWeeklyDigests(h.deps)).toBe(0);
  });

  it("uses each business's own timezone", async () => {
    await makeBusiness({ timezone: "America/Los_Angeles" });
    h.clock.now = MON_8AM_NY; // 5am in LA
    expect(await runWeeklyDigests(h.deps)).toBe(0);
    h.clock.now = new Date("2026-10-05T15:00:00Z"); // 8am in LA
    expect(await runWeeklyDigests(h.deps)).toBe(1);
  });
});
