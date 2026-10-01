import { toE164, formatPhone } from "../src/lib/phone";
import { DEFAULT_BUSINESS_HOURS, isQuietHours, isWithinBusinessHours, shiftOutOfQuietHours } from "../src/lib/time";

describe("phone numbers", () => {
  it.each([
    ["(555) 010-2000", "+15550102000"],
    ["555.010.2000", "+15550102000"],
    ["1-555-010-2000", "+15550102000"],
    ["+44 20 7946 0958", "+442079460958"],
    ["12345", null],
  ])("%s → %s", (input, expected) => expect(toE164(input)).toBe(expected));

  it("formats US numbers for display", () => expect(formatPhone("+15550102000")).toBe("(555) 010-2000"));
});

describe("business hours & quiet hours (America/New_York)", () => {
  const tz = "America/New_York";
  it("knows open vs closed, including DST-correct local time", () => {
    expect(isWithinBusinessHours(new Date("2026-09-30T15:00:00Z"), tz, DEFAULT_BUSINESS_HOURS)).toBe(true); // Wed 11am EDT
    expect(isWithinBusinessHours(new Date("2026-09-30T23:00:00Z"), tz, DEFAULT_BUSINESS_HOURS)).toBe(false); // Wed 7pm
    expect(isWithinBusinessHours(new Date("2026-12-02T12:30:00Z"), tz, DEFAULT_BUSINESS_HOURS)).toBe(true); // Wed 7:30am EST
    expect(isWithinBusinessHours(new Date("2026-10-04T15:00:00Z"), tz, DEFAULT_BUSINESS_HOURS)).toBe(false); // Sunday
  });

  it("treats 9pm–8am as quiet", () => {
    expect(isQuietHours(new Date("2026-10-01T00:59:00Z"), tz)).toBe(false); // 8:59pm
    expect(isQuietHours(new Date("2026-10-01T01:00:00Z"), tz)).toBe(true); // 9:00pm
    expect(isQuietHours(new Date("2026-10-01T11:59:00Z"), tz)).toBe(true); // 7:59am
  });

  it("shifts later to 8am and earlier to 8:45pm", () => {
    const threeAm = new Date("2026-10-01T07:00:00Z");
    expect(shiftOutOfQuietHours(threeAm, tz, "later").toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(shiftOutOfQuietHours(threeAm, tz, "earlier").toISOString()).toBe("2026-10-01T00:45:00.000Z");
    const noon = new Date("2026-10-01T16:00:00Z");
    expect(shiftOutOfQuietHours(noon, tz, "later")).toEqual(noon);
  });
});
