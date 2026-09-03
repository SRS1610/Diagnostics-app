import { generateYearRoster } from "../src/rosterGenerator";
import { OUTLETS, SHIFT_TEMPLATES, STAFF } from "../src/seedData";
import { ShiftAssignment } from "../src/types";

function generate(year = 2026) {
  let id = 1;
  return generateYearRoster({
    outlets: OUTLETS,
    staff: STAFF,
    shiftTemplates: SHIFT_TEMPLATES,
    leave: [],
    year,
    makeAssignmentId: () => `t-${id++}`,
  });
}

describe("generateYearRoster", () => {
  it("covers every day of the year for every outlet/shift/role slot", () => {
    const { assignments } = generate(2026);
    // 2026 is not a leap year: 365 days x 6 outlets x 2 shifts.
    const byOutletShiftDate = new Set(assignments.map((a) => `${a.outletId}|${a.shiftTemplateId}|${a.date}`));
    expect(byOutletShiftDate.size).toBe(365 * 6 * 2);
  });

  it("never double-books a staff member on the same date", () => {
    const { assignments } = generate(2026);
    const seen = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!a.staffId) continue;
      const dates = seen.get(a.staffId) ?? new Set<string>();
      expect(dates.has(a.date)).toBe(false);
      dates.add(a.date);
      seen.set(a.staffId, dates);
    }
  });

  it("never exceeds a staff member's weekly hour cap", () => {
    const { assignments } = generate(2026);
    const templateById = new Map(SHIFT_TEMPLATES.map((t) => [t.shiftTemplateId, t]));
    const staffById = new Map(STAFF.map((s) => [s.staffId, s]));

    const weekHours = new Map<string, Map<string, number>>(); // staffId -> weekStart -> hours
    const mondayOf = (dateISO: string) => {
      const d = new Date(dateISO + "T00:00:00Z");
      const diff = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - diff);
      return d.toISOString().slice(0, 10);
    };

    for (const a of assignments) {
      if (!a.staffId) continue;
      const template = templateById.get(a.shiftTemplateId)!;
      const hours = template.endHour - template.startHour;
      const weekStart = mondayOf(a.date);
      const perStaff = weekHours.get(a.staffId) ?? new Map<string, number>();
      perStaff.set(weekStart, (perStaff.get(weekStart) ?? 0) + hours);
      weekHours.set(a.staffId, perStaff);
    }

    for (const [staffId, perWeek] of weekHours) {
      const cap = staffById.get(staffId)!.maxHoursPerWeek;
      for (const hours of perWeek.values()) {
        expect(hours).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("only schedules staff on days they are marked available", () => {
    const { assignments } = generate(2026);
    const staffById = new Map(STAFF.map((s) => [s.staffId, s]));
    for (const a of assignments) {
      if (!a.staffId) continue;
      const weekday = new Date(a.date + "T00:00:00Z").getUTCDay();
      expect(staffById.get(a.staffId)!.availableDays).toContain(weekday);
    }
  });

  it("produces understaffed placeholders with warnings rather than throwing when coverage is short", () => {
    let id = 1;
    const { assignments, warnings } = generateYearRoster({
      outlets: [OUTLETS[0]],
      staff: STAFF.filter((s) => s.homeOutletId === OUTLETS[0].outletId).slice(0, 1), // way too few staff
      shiftTemplates: SHIFT_TEMPLATES.filter((t) => t.outletId === OUTLETS[0].outletId),
      leave: [],
      year: 2026,
      makeAssignmentId: () => `t-${id++}`,
    });
    const understaffed = assignments.filter((a: ShiftAssignment) => a.status === "understaffed");
    expect(understaffed.length).toBeGreaterThan(0);
    expect(warnings.length).toBe(understaffed.length);
  });

  it("is deterministic for the same inputs", () => {
    const run1 = generate(2027);
    const run2 = generate(2027);
    const strip = (as: ShiftAssignment[]) => as.map((a) => ({ ...a, assignmentId: undefined }));
    expect(strip(run1.assignments)).toEqual(strip(run2.assignments));
  });
});
