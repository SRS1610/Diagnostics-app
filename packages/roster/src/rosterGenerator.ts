// src/rosterGenerator.ts
//
// Fills a year of shifts for every outlet from its own staff pool.
// Processes one Mon-Sun week at a time (hour caps reset weekly, so a
// week is the natural unit of work) and, within a week, fills the
// scarcest slot first: at each step it computes how many eligible
// candidates remain for every still-open slot and assigns the slot with
// the FEWEST candidates, picking the eligible person with the fewest
// hours worked this week so far (ties: fewest shifts all-time, then
// staffId).
//
// This "fill the hardest slot first" order matters. An earlier version
// filled slots strictly in date order (Mon, Tue, ... Sun) — for a role
// where only 1-2 people are ever available on Sunday (weekend coverage
// is inherently harder to staff), those same people are usually ALSO
// available on 2-3 weekdays, so a date-ordered pass happily spent their
// weekly hours on Monday/Tuesday and left them with nothing by the time
// Sunday came around, even though nobody working Monday had any
// particular need to be scheduled that day over Sunday. The result was
// a wall of "understaffed" Sundays every single week — not a realistic
// staffing gap, just an artifact of processing order. Filling Sunday's
// slots first (fewest candidates) reserves those scarce people's hours
// for the day only they can cover, then lets the rest of the week's
// more flexible candidates fill in around that.
//
// Slots that still have zero eligible candidates once nothing else can
// be assigned become "understaffed" (staffId: null) plus a warning,
// rather than silently dropping the slot or crashing the run — an
// admin needs to see the real gap.

import {
  LeaveRequest,
  Outlet,
  RosterWarning,
  ShiftAssignment,
  ShiftTemplate,
  StaffMember,
  Weekday,
} from "./types";

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isOnLeave(staffId: string, date: string, leave: LeaveRequest[]): boolean {
  return leave.some(
    (l) => l.staffId === staffId && l.status === "approved" && l.startDate <= date && date <= l.endDate,
  );
}

interface GeneratorState {
  /** hours worked this Mon-Sun week, keyed by staffId */
  weekHours: Map<string, number>;
  /** total shifts worked all-time, keyed by staffId — fairness tiebreak */
  totalShifts: Map<string, number>;
  /**
   * Every ISO date each staff member is already assigned to, keyed by
   * staffId. A Set of dates rather than a single "last worked date"
   * scalar — this generator fills the SCARCEST slot first within a
   * week (see module comment), so assignments inside a week don't land
   * in calendar order. A scalar "last date" gets overwritten by
   * whichever assignment happens to be made *last in processing order*,
   * which can be an earlier calendar date than one already recorded —
   * silently erasing the "already booked that day" fact and letting the
   * same person get double-booked on a date already resolved earlier in
   * the run. A Set has no such ordering dependency.
   */
  workedDates: Map<string, Set<string>>;
}

const MAX_CONSECUTIVE_DAYS = 6;

function dayBefore(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return toISODate(d);
}

function dayAfter(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return toISODate(d);
}

/**
 * Length of the run of consecutive worked days that would include
 * `dateISO` if it were added to `workedDates` for this staff member —
 * walks both backward and forward from already-recorded dates, since
 * (per the state comment above) dates aren't necessarily recorded in
 * calendar order.
 */
function consecutiveRunLength(staffId: string, dateISO: string, workedDates: Map<string, Set<string>>): number {
  const dates = workedDates.get(staffId);
  if (!dates) return 1;
  let length = 1;
  for (let d = dayBefore(dateISO); dates.has(d); d = dayBefore(d)) length++;
  for (let d = dayAfter(dateISO); dates.has(d); d = dayAfter(d)) length++;
  return length;
}

interface Task {
  date: string;
  weekday: Weekday;
  template: ShiftTemplate;
  role: ShiftAssignment["role"];
  shiftHours: number;
  filled: boolean;
}

function eligibleCandidates(
  pool: StaffMember[],
  task: Task,
  state: GeneratorState,
  leave: LeaveRequest[],
): StaffMember[] {
  const candidates = pool
    .filter((s) => s.role === task.role)
    .filter((s) => s.availableDays.includes(task.weekday))
    .filter((s) => !isOnLeave(s.staffId, task.date, leave))
    .filter((s) => (state.weekHours.get(s.staffId) ?? 0) + task.shiftHours <= s.maxHoursPerWeek)
    // Already booked into another shift at this outlet today.
    .filter((s) => !state.workedDates.get(s.staffId)?.has(task.date))
    .filter((s) => consecutiveRunLength(s.staffId, task.date, state.workedDates) <= MAX_CONSECUTIVE_DAYS);

  candidates.sort((a, b) => {
    const hoursDiff = (state.weekHours.get(a.staffId) ?? 0) - (state.weekHours.get(b.staffId) ?? 0);
    if (hoursDiff !== 0) return hoursDiff;
    const shiftsDiff = (state.totalShifts.get(a.staffId) ?? 0) - (state.totalShifts.get(b.staffId) ?? 0);
    if (shiftsDiff !== 0) return shiftsDiff;
    return a.staffId.localeCompare(b.staffId);
  });

  return candidates;
}

function fillWeek(params: {
  tasks: Task[];
  pool: StaffMember[];
  state: GeneratorState;
  leave: LeaveRequest[];
  outlet: Outlet;
  makeAssignmentId: () => string;
  assignments: ShiftAssignment[];
  warnings: RosterWarning[];
}) {
  const { tasks, pool, state, leave, outlet, makeAssignmentId, assignments, warnings } = params;
  const pending = tasks.filter((t) => !t.filled);

  while (pending.length > 0) {
    let bestTask: Task | null = null;
    let bestCandidates: StaffMember[] = [];

    for (const task of pending) {
      const candidates = eligibleCandidates(pool, task, state, leave);
      if (candidates.length === 0) continue;
      if (
        bestTask === null ||
        candidates.length < bestCandidates.length ||
        (candidates.length === bestCandidates.length &&
          (task.date < bestTask.date || (task.date === bestTask.date && task.role.localeCompare(bestTask.role) < 0)))
      ) {
        bestTask = task;
        bestCandidates = candidates;
      }
    }

    if (!bestTask) break; // nothing left is fillable — remaining pending tasks become gaps below

    const chosen = bestCandidates[0];
    state.weekHours.set(chosen.staffId, (state.weekHours.get(chosen.staffId) ?? 0) + bestTask.shiftHours);
    state.totalShifts.set(chosen.staffId, (state.totalShifts.get(chosen.staffId) ?? 0) + 1);
    const dates = state.workedDates.get(chosen.staffId) ?? new Set<string>();
    dates.add(bestTask.date);
    state.workedDates.set(chosen.staffId, dates);

    assignments.push({
      assignmentId: makeAssignmentId(),
      outletId: outlet.outletId,
      date: bestTask.date,
      shiftTemplateId: bestTask.template.shiftTemplateId,
      role: bestTask.role,
      staffId: chosen.staffId,
      status: "scheduled",
    });

    bestTask.filled = true;
    const index = pending.indexOf(bestTask);
    pending.splice(index, 1);
  }

  for (const task of pending) {
    assignments.push({
      assignmentId: makeAssignmentId(),
      outletId: outlet.outletId,
      date: task.date,
      shiftTemplateId: task.template.shiftTemplateId,
      role: task.role,
      staffId: null,
      status: "understaffed",
    });
    warnings.push({
      date: task.date,
      outletId: outlet.outletId,
      shiftTemplateId: task.template.shiftTemplateId,
      role: task.role,
      message: `No eligible ${task.role} available for ${task.template.label} at ${outlet.name} on ${task.date}`,
    });
  }
}

export function generateYearRoster(params: {
  outlets: Outlet[];
  staff: StaffMember[];
  shiftTemplates: ShiftTemplate[];
  leave: LeaveRequest[];
  year: number;
  makeAssignmentId: () => string;
}): { assignments: ShiftAssignment[]; warnings: RosterWarning[] } {
  const { outlets, staff, shiftTemplates, leave, year, makeAssignmentId } = params;

  const assignments: ShiftAssignment[] = [];
  const warnings: RosterWarning[] = [];

  const staffByOutlet = new Map<string, StaffMember[]>();
  for (const outlet of outlets) {
    staffByOutlet.set(
      outlet.outletId,
      staff.filter((s) => s.homeOutletId === outlet.outletId),
    );
  }
  const templatesByOutlet = new Map<string, ShiftTemplate[]>();
  for (const t of shiftTemplates) {
    const list = templatesByOutlet.get(t.outletId) ?? [];
    list.push(t);
    templatesByOutlet.set(t.outletId, list);
  }

  const statesByOutlet = new Map<string, GeneratorState>();
  for (const outlet of outlets) {
    statesByOutlet.set(outlet.outletId, {
      weekHours: new Map(),
      totalShifts: new Map(),
      workedDates: new Map(),
    });
  }

  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));

  // Chunk into real Mon-Sun calendar weeks (not arbitrary 7-day blocks
  // from Jan 1) so "weekly hour cap" means the same thing here as it
  // does to a human reading a roster — align the first chunk's start to
  // the Monday on/before Jan 1, which may fall in the previous year.
  const firstMonday = new Date(start);
  const leadingOffset = (start.getUTCDay() + 6) % 7; // days since Monday
  firstMonday.setUTCDate(firstMonday.getUTCDate() - leadingOffset);

  for (
    let weekCursor = new Date(firstMonday);
    weekCursor <= end;
    weekCursor.setUTCDate(weekCursor.getUTCDate() + 7)
  ) {
    // Days of this Mon-Sun week that fall within the year, in order.
    const weekDates: { dateISO: string; weekday: Weekday }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekCursor);
      d.setUTCDate(d.getUTCDate() + i);
      if (d < start || d > end) continue;
      weekDates.push({ dateISO: toISODate(d), weekday: d.getUTCDay() as Weekday });
    }
    if (weekDates.length === 0) continue;

    for (const outlet of outlets) {
      const state = statesByOutlet.get(outlet.outletId)!;
      state.weekHours.clear();
      const pool = staffByOutlet.get(outlet.outletId) ?? [];
      const templates = templatesByOutlet.get(outlet.outletId) ?? [];

      const tasks: Task[] = [];
      for (const { dateISO, weekday } of weekDates) {
        for (const template of templates) {
          const shiftHours = template.endHour - template.startHour;
          for (const [role, count] of Object.entries(template.requiredRoles)) {
            for (let slot = 0; slot < (count ?? 0); slot++) {
              tasks.push({
                date: dateISO,
                weekday,
                template,
                role: role as ShiftAssignment["role"],
                shiftHours,
                filled: false,
              });
            }
          }
        }
      }

      fillWeek({ tasks, pool, state, leave, outlet, makeAssignmentId, assignments, warnings });
    }
  }

  return { assignments, warnings };
}
