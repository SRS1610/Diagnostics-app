import { db } from "../src/lib/db";
import { sendDigests } from "../src/core/digest";
import { HOUR, OWNER, business, harness, missedCall, reset, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  await reset();
  h = harness();
});
afterAll(() => db.$disconnect());

const MON_7AM = new Date("2026-10-05T11:00:00Z");
const MON_8AM = new Date("2026-10-05T12:00:00Z");

it("goes out Monday 8am local by SMS and email, once a week", async () => {
  await business();
  await missedCall(h);
  await h.sms("need a quote");
  h.clock.now = MON_7AM;
  expect(await sendDigests(h.deps)).toBe(0);
  h.clock.now = MON_8AM;
  expect(await sendDigests(h.deps)).toBe(1);
  const sms = h.fake.smsTo(OWNER).at(-1)!.text;
  expect(sms).toContain("Missed calls: 1");
  expect(sms).toContain("Replied: 1 (100%)");
  expect(sms).toContain("Est. jobs saved: $450");
  expect(h.mailer.sent[0].subject).toBe("Your week: 1 missed calls, 1 customers saved");
  h.advance(2 * HOUR);
  expect(await sendDigests(h.deps)).toBe(0);
  h.clock.now = new Date(MON_8AM.getTime() + 7 * 24 * HOUR);
  expect(await sendDigests(h.deps)).toBe(1);
});

it("uses each business's own timezone and respects opting out", async () => {
  await business({ timezone: "America/Los_Angeles" });
  await business({ digestEnabled: false, phoneNumber: "+15550108888" });
  h.clock.now = MON_8AM; // 5am in LA
  expect(await sendDigests(h.deps)).toBe(0);
  h.clock.now = new Date("2026-10-05T15:00:00Z"); // 8am in LA
  expect(await sendDigests(h.deps)).toBe(1);
});
