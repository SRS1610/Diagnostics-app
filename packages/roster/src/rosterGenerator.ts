// src/rosterGenerator.ts
//
// Fills a year of shifts for every outlet from its own staff pool.
// Greedy, deterministic, and fairness-aware rather than optimal: for
// each shift slot it picks the eligible staff member who has worked the
// fewest hours this week (ties broken by fewest shifts overall, then
// staffId) so hours spread out instead of piling onto whoever sorts
// first. Slots that can't be filled become "understaffed" assignments
// (staffId: null) plus a warning, rather than silently dropping the
// slot or crashing the run — an admin needs to see the gap.

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

function mondayOf(d: Date): Date {
  const day = d.getDay();
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(d);
  monday.setDate(d.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function isOnLeave(staffId: string, date: string, leave: LeaveRequest[]): boolean {
  return leave.some(
    (l) => l.staffId === staffId && l.status === "approved" && l.startDate <= date && date >= l.startDate && date <= l.endDate,
  );
}

interface GeneratorState {
  /** hours worked this Mon-Sun week, keyed by staffId */
  weekHours: Map<string, number>;
  /** total shifts worked all-time, keyed by staffId — fairness tiebreak */
  totalShifts: Map<string, number>;
  /** last date (ISO) each staff member worked, to cap consecutive days */
  lastWorkedDate: Map<string, string>;
  consecutiveDays: Map<string, number>;
  currentWeekStart: string;
}

const MAX_CONSECUTIVE_DAYS = 6;

function resetWeekIfNeeded(state: GeneratorState, weekStartISO: string) {
  if (state.currentWeekStart !== weekStartISO) {
    state.currentWeekStart = weekStartISO;
    state.weekHours.clear();
  }
}

function dayBefore(dateISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return toISODate(d);
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
      lastWorkedDate: new Map(),
      consecutiveDays: new Map(),
      currentWeekStart: "",
    });
  }

  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));

  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dateISO = toISODate(cursor);
    const weekday = cursor.getUTCDay() as Weekday;
    const weekStartISO = toISODate(mondayOf(cursor));

    for (const outlet of outlets) {
      const state = statesByOutlet.get(outlet.outletId)!;
      resetWeekIfNeeded(state, weekStartISO);
      const pool = staffByOutlet.get(outlet.outletId) ?? [];
      const templates = templatesByOutlet.get(outlet.outletId) ?? [];

      for (const template of templates) {
        const shiftHours = template.endHour - template.startHour;

        for (const [role, count] of Object.entries(template.requiredRoles)) {
          for (let slot = 0; slot < (count ?? 0); slot++) {
            const candidates = pool
              .filter((s) => s.role === role)
              .filter((s) => s.availableDays.includes(weekday))
              .filter((s) => !isOnLeave(s.staffId, dateISO, leave))
              .filter((s) => (state.weekHours.get(s.staffId) ?? 0) + shiftHours <= s.maxHoursPerWeek)
              .filter((s) => {
                const consecutive = state.lastWorkedDate.get(s.staffId) === dayBefore(dateISO) ? state.consecutiveDays.get(s.staffId) ?? 0 : 0;
                return consecutive < MAX_CONSECUTIVE_DAYS;
              })
              // Already booked into another shift/outlet today.
              .filter((s) => state.lastWorkedDate.get(s.staffId) !== dateISO);

            candidates.sort((a, b) => {
              const hoursDiff = (state.weekHours.get(a.staffId) ?? 0) - (state.weekHours.get(b.staffId) ?? 0);
              if (hoursDiff !== 0) return hoursDiff;
              const shiftsDiff = (state.totalShifts.get(a.staffId) ?? 0) - (state.totalShifts.get(b.staffId) ?? 0);
              if (shiftsDiff !== 0) return shiftsDiff;
              return a.staffId.localeCompare(b.staffId);
            });

            const chosen = candidates[0];

            if (!chosen) {
              assignments.push({
                assignmentId: makeAssignmentId(),
                outletId: outlet.outletId,
                date: dateISO,
                shiftTemplateId: template.shiftTemplateId,
                role: role as ShiftAssignment["role"],
                staffId: null,
                status: "understaffed",
              });
              warnings.push({
                date: dateISO,
                outletId: outlet.outletId,
                shiftTemplateId: template.shiftTemplateId,
                role: role as ShiftAssignment["role"],
                message: `No eligible ${role} available for ${template.label} at ${outlet.name} on ${dateISO}`,
              });
              continue;
            }

            state.weekHours.set(chosen.staffId, (state.weekHours.get(chosen.staffId) ?? 0) + shiftHours);
            state.totalShifts.set(chosen.staffId, (state.totalShifts.get(chosen.staffId) ?? 0) + 1);
            const wasYesterday = state.lastWorkedDate.get(chosen.staffId) === dayBefore(dateISO);
            state.consecutiveDays.set(chosen.staffId, wasYesterday ? (state.consecutiveDays.get(chosen.staffId) ?? 0) + 1 : 1);
            state.lastWorkedDate.set(chosen.staffId, dateISO);

            assignments.push({
              assignmentId: makeAssignmentId(),
              outletId: outlet.outletId,
              date: dateISO,
              shiftTemplateId: template.shiftTemplateId,
              role: role as ShiftAssignment["role"],
              staffId: chosen.staffId,
              status: "scheduled",
            });
          }
        }
      }
    }
  }

  return { assignments, warnings };
}
