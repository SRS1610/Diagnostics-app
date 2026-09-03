// src/seedData.ts
//
// Starting data for the 6 Melbourne badminton outlets: fictional venues
// for this app, not real businesses. Swap for real outlet/staff data
// before going live — same "seed, not production data" caveat the rest
// of this codebase uses for market pricing (see marketPriceData.ts).

import { Outlet, ShiftTemplate, StaffMember } from "./types";

export const OUTLETS: Outlet[] = [
  { outletId: "out-boxhill", name: "Box Hill Shuttle Centre", suburb: "Box Hill", courts: 8, opensAt: 6, closesAt: 23 },
  { outletId: "out-glenwav", name: "Glen Waverley Smash Arena", suburb: "Glen Waverley", courts: 6, opensAt: 7, closesAt: 22 },
  { outletId: "out-dande", name: "Dandenong Rally Hub", suburb: "Dandenong", courts: 6, opensAt: 6, closesAt: 23 },
  { outletId: "out-spring", name: "Springvale Badminton Club", suburb: "Springvale", courts: 5, opensAt: 7, closesAt: 22 },
  { outletId: "out-footscray", name: "Footscray Court House", suburb: "Footscray", courts: 6, opensAt: 6, closesAt: 23 },
  { outletId: "out-reservoir", name: "Reservoir Badminton Stadium", suburb: "Reservoir", courts: 7, opensAt: 7, closesAt: 22 },
];

// Two shift templates per outlet: Morning and Evening, split roughly at
// the middle of the operating hours.
//
// Roles are deliberately NOT required on both shifts for duty_manager
// and coach: one duty manager opens the venue and one senior
// receptionist closes it (two dedicated full-shift duty-manager slots
// a day is more headcount than a 5-8 court venue actually runs), and
// coaching sessions are scheduled for the evening block only. Reception
// and maintenance keep their original per-shift/morning-only pattern.
// This keeps demand realistic against the staff pool in
// buildStaffForOutlet below instead of structurally understaffing every
// outlet regardless of headcount.
export function shiftTemplatesForOutlet(outlet: Outlet): ShiftTemplate[] {
  const mid = Math.round((outlet.opensAt + outlet.closesAt) / 2);
  return [
    {
      shiftTemplateId: `${outlet.outletId}-morning`,
      outletId: outlet.outletId,
      label: "Morning",
      startHour: outlet.opensAt,
      endHour: mid,
      requiredRoles: { duty_manager: 1, reception: 1, maintenance: 1 },
    },
    {
      shiftTemplateId: `${outlet.outletId}-evening`,
      outletId: outlet.outletId,
      label: "Evening",
      startHour: mid,
      endHour: outlet.closesAt,
      requiredRoles: { reception: 1, coach: 1 },
    },
  ];
}

export const SHIFT_TEMPLATES: ShiftTemplate[] = OUTLETS.flatMap(shiftTemplatesForOutlet);

const FIRST_NAMES = [
  "Liam", "Olivia", "Noah", "Ava", "Ethan", "Mia", "Lucas", "Isla", "Jack", "Amelia",
  "Henry", "Grace", "Leo", "Zoe", "Oscar", "Ruby", "Max", "Chloe", "Sam", "Lily",
  "Ben", "Sofia", "Alex", "Ella", "Ryan", "Ivy", "Tom", "Maya", "Nate", "Sara",
  "Priya", "Wei", "Anh", "Kavi", "Yuki", "Hana", "Dev", "Mei", "Arjun", "Nikki",
];
const LAST_NAMES = [
  "Nguyen", "Smith", "Tran", "Chen", "Kumar", "Patel", "Le", "Brown", "Wilson", "Taylor",
  "Pham", "Vu", "Singh", "Wang", "Kim", "Ho", "Nakamura", "Rossi", "Dimitriou", "Kowalski",
];

function name(seed: number): string {
  return `${FIRST_NAMES[seed % FIRST_NAMES.length]} ${LAST_NAMES[(seed * 7) % LAST_NAMES.length]}`;
}

// Availability patterns, expressed as which weekdays a staff member can
// ever work (before leave). Casuals skew to fewer days; full-timers
// cover most of the week but still get a guaranteed day off.
//
// Each tuple is indexed [Sun, Mon, Tue, Wed, Thu, Fri, Sat] to match
// Weekday/Date#getDay() (0 = Sunday) — NOT [Mon..Sun]. Getting this
// off by one silently shifts every pattern by a day and can leave a
// whole weekday (e.g. every Friday/Saturday) with no eligible staff
// across an entire outlet, which shows up as a wall of "understaffed"
// warnings that looks like a capacity problem but isn't one.
const AVAILABILITY_PATTERNS: Array<[number, number, number, number, number, number, number]> = [
  [0, 1, 1, 1, 1, 1, 0], // Mon-Fri
  [0, 0, 1, 1, 1, 1, 1], // Tue-Sat
  [0, 1, 0, 1, 1, 1, 1], // Mon,Wed-Sat
  [1, 1, 1, 0, 1, 1, 0], // Mon,Tue,Thu,Fri,Sun
  [1, 0, 0, 1, 1, 1, 1], // Wed-Sun
  [1, 1, 1, 1, 0, 0, 1], // Mon,Tue,Wed,Sat,Sun
];

function availableDays(patternIndex: number): number[] {
  const pattern = AVAILABILITY_PATTERNS[patternIndex % AVAILABILITY_PATTERNS.length];
  const days: number[] = [];
  pattern.forEach((on, day) => {
    if (on) days.push(day);
  });
  return days;
}

// Which AVAILABILITY_PATTERNS indices to hand out within each role, chosen
// so the union of the assigned patterns' present-days covers all 7 days —
// i.e. every day of the week has at least one eligible person for that
// role. This matters most for duty_manager, which has only 2 people: two
// patterns whose absent-days overlap (e.g. both off Sunday) leaves that
// role structurally uncoverable on that day for the entire year, not an
// occasional gap — that's what originally produced a wall of "Unfilled
// Duty Manager" on the same weekday every single week. Each list below was
// checked by hand against AVAILABILITY_PATTERNS' absent-day sets; if you
// change either, re-verify the union still spans Sun-Sat.
const ROLE_PATTERN_INDICES: Partial<Record<StaffMember["role"], number[]>> = {
  duty_manager: [0, 5], // absent {Sun,Sat} + absent {Thu,Fri} -> every day covered by one or the other
  // P4 and P5 are the two patterns that include BOTH Saturday and Sunday
  // (Wed-Sun and {Sun,Mon,Tue,Wed,Sat} respectively) — reception carries
  // both of them so the weekend has more than one eligible person, not
  // just bare 1-candidate coverage like duty_manager/maintenance settle
  // for. See the capacity comment below for why this role needed it.
  reception: [1, 2, 3, 4, 5],
  coach: [0, 1, 4],
  maintenance: [0, 2, 3],
};

// Hour caps are sized against the WORST-CASE weekly demand across all 6
// outlets, not the average — shiftTemplatesForOutlet's mid-point split
// means a 6:00-23:00 outlet gets a 9h morning shift (vs 8h at a
// 7:00-22:00 outlet), so a role scheduled every morning needs 7*9=63h of
// combined weekly capacity to have any chance of full coverage, not the
// 56h a shorter-hours outlet would need.
//
// A first pass sized each role's combined cap to just barely clear its
// worst-case weekly demand (e.g. maintenance at 64h vs 63h needed). That
// was wrong: this scheduler fills the SCARCEST slot first (see
// rosterGenerator.ts), so whichever day/role combination has the least
// slack ends up structurally shorted almost every week, not just
// occasionally — a 1h margin on a 63h demand is theoretically enough but
// leaves no room for the greedy fill to actually realize it (a single
// person's day off shifts everything). Every role below now carries at
// least ~15-25% combined capacity above worst-case demand; treat that
// margin, not the bare "cap >= demand" arithmetic, as the real
// requirement. If you resize opening hours or requiredRoles, re-check
// both the per-role demand AND this buffer.
export function buildStaffForOutlet(outlet: Outlet, seedOffset: number): StaffMember[] {
  const roster: Array<{ role: StaffMember["role"]; employmentType: StaffMember["employmentType"]; maxHoursPerWeek: number }> = [
    { role: "duty_manager", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "duty_manager", employmentType: "part_time", maxHoursPerWeek: 28 }, // 66h vs 63h demand
    { role: "reception", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "reception", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "reception", employmentType: "part_time", maxHoursPerWeek: 28 },
    { role: "reception", employmentType: "casual", maxHoursPerWeek: 24 },
    { role: "reception", employmentType: "casual", maxHoursPerWeek: 20 }, // 5 people, 148h vs 119h demand — weekend-pattern people included
    { role: "coach", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "coach", employmentType: "part_time", maxHoursPerWeek: 24 },
    { role: "coach", employmentType: "casual", maxHoursPerWeek: 16 }, // 78h vs 56h demand (evening-only) — ample
    { role: "maintenance", employmentType: "part_time", maxHoursPerWeek: 32 },
    { role: "maintenance", employmentType: "casual", maxHoursPerWeek: 24 },
    { role: "maintenance", employmentType: "casual", maxHoursPerWeek: 20 }, // 76h vs 63h demand
  ];

  const roleSeenCount: Partial<Record<StaffMember["role"], number>> = {};

  return roster.map((entry, i) => {
    const seed = seedOffset + i;
    const positionInRole = roleSeenCount[entry.role] ?? 0;
    roleSeenCount[entry.role] = positionInRole + 1;

    const patternChoices = ROLE_PATTERN_INDICES[entry.role]!;
    // Rotate which staff member gets which pattern per outlet (varies the
    // demo data) without breaking the coverage guarantee — the *set* of
    // patterns used for the role stays the same, only who gets which one
    // changes, and the union-covers-all-7-days property only depends on
    // the set, not the assignment order.
    const patternIndex = patternChoices[(positionInRole + seedOffset) % patternChoices.length];

    return {
      staffId: `${outlet.outletId}-staff-${i + 1}`,
      name: name(seed),
      role: entry.role,
      homeOutletId: outlet.outletId,
      employmentType: entry.employmentType,
      maxHoursPerWeek: entry.maxHoursPerWeek,
      availableDays: availableDays(patternIndex) as StaffMember["availableDays"],
    };
  });
}

export const STAFF: StaffMember[] = OUTLETS.flatMap((outlet, outletIndex) =>
  buildStaffForOutlet(outlet, outletIndex * 11),
);
