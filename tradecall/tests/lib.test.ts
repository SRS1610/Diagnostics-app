import { prettyPhone, spokenPhone, toE164 } from "../src/lib/phone";
import { DEFAULT_HOURS, isOpen, isQuiet, outOfQuiet } from "../src/lib/time";

it.each([
  ["(555) 010-2000", "+15550102000"],
  ["1-555-010-2000", "+15550102000"],
  ["+44 20 7946 0958", "+442079460958"],
  ["anonymous", null],
])("toE164(%s)", (input, out) => expect(toE164(input)).toBe(out));

it("formats numbers for screens and for speech", () => {
  expect(prettyPhone("+15550102000")).toBe("(555) 010-2000");
  expect(spokenPhone("+15550102000")).toBe("5 5 5, 0 1 0, 2 0 0 0");
});

it("knows open hours and quiet hours in local time, across DST", () => {
  const tz = "America/New_York";
  expect(isOpen(new Date("2026-09-30T15:00:00Z"), tz, DEFAULT_HOURS)).toBe(true); // Wed 11am EDT
  expect(isOpen(new Date("2026-12-02T12:30:00Z"), tz, DEFAULT_HOURS)).toBe(true); // Wed 7:30am EST
  expect(isOpen(new Date("2026-10-04T15:00:00Z"), tz, DEFAULT_HOURS)).toBe(false); // Sunday
  expect(isQuiet(new Date("2026-10-01T00:59:00Z"), tz)).toBe(false); // 8:59pm
  expect(isQuiet(new Date("2026-10-01T01:00:00Z"), tz)).toBe(true); // 9pm
  const threeAm = new Date("2026-10-01T07:00:00Z");
  expect(outOfQuiet(threeAm, tz, "later").toISOString()).toBe("2026-10-01T12:00:00.000Z");
  expect(outOfQuiet(threeAm, tz, "earlier").toISOString()).toBe("2026-10-01T00:45:00.000Z");
});
