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
// the middle of the operating hours. Role coverage scales a little with
// court count (more courts -> more reception/coaching demand).
export function shiftTemplatesForOutlet(outlet: Outlet): ShiftTemplate[] {
  const mid = Math.round((outlet.opensAt + outlet.closesAt) / 2);
  const receptionPerShift = outlet.courts >= 7 ? 2 : 1;
  return [
    {
      shiftTemplateId: `${outlet.outletId}-morning`,
      outletId: outlet.outletId,
      label: "Morning",
      startHour: outlet.opensAt,
      endHour: mid,
      requiredRoles: { duty_manager: 1, reception: receptionPerShift, coach: 1, maintenance: 1 },
    },
    {
      shiftTemplateId: `${outlet.outletId}-evening`,
      outletId: outlet.outletId,
      label: "Evening",
      startHour: mid,
      endHour: outlet.closesAt,
      requiredRoles: { duty_manager: 1, reception: receptionPerShift, coach: 1 },
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
const AVAILABILITY_PATTERNS: Array<[number, number, number, number, number, number, number]> = [
  [1, 1, 1, 1, 1, 0, 0], // Mon-Fri
  [0, 1, 1, 1, 1, 1, 0], // Tue-Sat
  [1, 0, 1, 1, 1, 1, 0], // Mon,Wed-Sat
  [1, 1, 0, 1, 1, 0, 1], // Mon,Tue,Thu,Fri,Sun
  [0, 0, 1, 1, 1, 1, 1], // Wed-Sun
  [1, 1, 1, 0, 0, 1, 1], // Mon,Tue,Wed,Sat,Sun
];

function availableDays(patternIndex: number): number[] {
  const pattern = AVAILABILITY_PATTERNS[patternIndex % AVAILABILITY_PATTERNS.length];
  const days: number[] = [];
  pattern.forEach((on, day) => {
    if (on) days.push(day);
  });
  return days;
}

// Roughly 7 staff per outlet: 1 duty manager (full-time), 2 reception,
// 2 coaches, 1-2 maintenance/casual — enough headroom that the
// generator can usually fill every slot without going understaffed.
export function buildStaffForOutlet(outlet: Outlet, seedOffset: number): StaffMember[] {
  const roster: Array<{ role: StaffMember["role"]; employmentType: StaffMember["employmentType"]; maxHoursPerWeek: number }> = [
    { role: "duty_manager", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "reception", employmentType: "full_time", maxHoursPerWeek: 38 },
    { role: "reception", employmentType: "part_time", maxHoursPerWeek: 24 },
    { role: "coach", employmentType: "part_time", maxHoursPerWeek: 20 },
    { role: "coach", employmentType: "casual", maxHoursPerWeek: 16 },
    { role: "maintenance", employmentType: "part_time", maxHoursPerWeek: 20 },
    { role: "maintenance", employmentType: "casual", maxHoursPerWeek: 12 },
  ];

  return roster.map((entry, i) => {
    const seed = seedOffset + i;
    return {
      staffId: `${outlet.outletId}-staff-${i + 1}`,
      name: name(seed),
      role: entry.role,
      homeOutletId: outlet.outletId,
      employmentType: entry.employmentType,
      maxHoursPerWeek: entry.maxHoursPerWeek,
      availableDays: availableDays(seed) as StaffMember["availableDays"],
    };
  });
}

export const STAFF: StaffMember[] = OUTLETS.flatMap((outlet, outletIndex) =>
  buildStaffForOutlet(outlet, outletIndex * 11),
);
