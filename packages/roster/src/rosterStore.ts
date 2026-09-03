// src/rosterStore.ts
//
// In-memory store for the roster module. Fine for demoing/driving the
// dashboard; a real deployment needs this backed by Postgres the same
// way packages/api uses Prisma — swapping the implementation behind
// this same interface is the intended path, not a rewrite of the
// callers in src/routes/*.

import { generateYearRoster } from "./rosterGenerator";
import { OUTLETS, SHIFT_TEMPLATES, STAFF } from "./seedData";
import {
  GenerateRosterResult,
  LeaveRequest,
  Outlet,
  RosterWarning,
  ShiftAssignment,
  ShiftTemplate,
  StaffMember,
} from "./types";

interface PersistedState {
  staff: StaffMember[];
  leave: LeaveRequest[];
  assignments: ShiftAssignment[];
  lastWarnings: RosterWarning[];
  nextAssignmentId: number;
  nextLeaveId: number;
  nextStaffId: number;
}

class RosterStore {
  outlets: Outlet[] = OUTLETS;
  staff: StaffMember[] = STAFF;
  shiftTemplates: ShiftTemplate[] = SHIFT_TEMPLATES;
  leave: LeaveRequest[] = [];
  assignments: ShiftAssignment[] = [];
  lastWarnings: RosterWarning[] = [];

  // ID counters live on the instance (not module-level `let`s) so
  // serialize()/hydrate() can carry them along with everything else —
  // needed on Netlify, where each function invocation gets a fresh
  // module instance and the real state round-trips through Blobs
  // between requests (see netlify/functions/api.mts). The Express dev
  // server never calls these; it just keeps one long-lived instance.
  private nextAssignmentId = 1;
  private nextLeaveId = 1;
  private nextStaffId = 1;

  /** Plain-object snapshot of everything that isn't static seed data, for a persistence layer (e.g. Netlify Blobs) to store. */
  serialize(): PersistedState {
    return {
      staff: this.staff,
      leave: this.leave,
      assignments: this.assignments,
      lastWarnings: this.lastWarnings,
      nextAssignmentId: this.nextAssignmentId,
      nextLeaveId: this.nextLeaveId,
      nextStaffId: this.nextStaffId,
    };
  }

  /** Restores a snapshot produced by serialize(). Outlets/shiftTemplates are always the static seed data, never persisted. */
  hydrate(state: PersistedState): void {
    this.staff = state.staff;
    this.leave = state.leave;
    this.assignments = state.assignments;
    this.lastWarnings = state.lastWarnings;
    this.nextAssignmentId = state.nextAssignmentId;
    this.nextLeaveId = state.nextLeaveId;
    this.nextStaffId = state.nextStaffId;
  }

  listOutlets(): Outlet[] {
    return this.outlets;
  }

  listStaff(outletId?: string): StaffMember[] {
    return outletId ? this.staff.filter((s) => s.homeOutletId === outletId) : this.staff;
  }

  listShiftTemplates(outletId?: string): ShiftTemplate[] {
    return outletId ? this.shiftTemplates.filter((t) => t.outletId === outletId) : this.shiftTemplates;
  }

  addStaff(input: Omit<StaffMember, "staffId">): StaffMember {
    const member: StaffMember = { ...input, staffId: `staff-${this.nextStaffId++}` };
    this.staff.push(member);
    return member;
  }

  /**
   * Removing a staff member unassigns them from every future-facing
   * shift rather than deleting those assignment rows outright — the
   * gap needs to show up as understaffed (same as an approved-leave
   * gap) so it isn't silently lost from the roster.
   */
  removeStaff(staffId: string): { ok: true } | { ok: false; error: string } {
    const index = this.staff.findIndex((s) => s.staffId === staffId);
    if (index === -1) return { ok: false, error: "Staff member not found" };
    this.staff.splice(index, 1);

    for (const assignment of this.assignments) {
      if (assignment.staffId === staffId) {
        assignment.staffId = null;
        assignment.status = "understaffed";
      }
    }
    return { ok: true };
  }

  generateYear(year: number): GenerateRosterResult {
    // A regeneration for a year replaces that year's assignments outright
    // rather than appending — same "redo replaces, never duplicates"
    // pattern testSession.ts uses for diagnostic redo.
    this.assignments = this.assignments.filter((a) => !a.date.startsWith(String(year)));

    const { assignments, warnings } = generateYearRoster({
      outlets: this.outlets,
      staff: this.staff,
      shiftTemplates: this.shiftTemplates,
      leave: this.leave,
      year,
      makeAssignmentId: () => `asg-${this.nextAssignmentId++}`,
    });

    this.assignments.push(...assignments);
    this.lastWarnings = warnings;

    return { assignmentsCreated: assignments.length, warnings };
  }

  listAssignments(filter: { outletId?: string; month?: string; year?: string; staffId?: string }): ShiftAssignment[] {
    return this.assignments.filter((a) => {
      if (filter.outletId && a.outletId !== filter.outletId) return false;
      if (filter.month && !a.date.startsWith(filter.month)) return false;
      if (filter.year && !a.date.startsWith(filter.year)) return false;
      if (filter.staffId && a.staffId !== filter.staffId) return false;
      return true;
    });
  }

  /** One row per outlet: shift counts for the given month, for the cross-outlet overview. */
  summarizeOutlets(month: string): Array<{ outletId: string; total: number; filled: number; gaps: number }> {
    return this.outlets.map((outlet) => {
      const monthAssignments = this.assignments.filter((a) => a.outletId === outlet.outletId && a.date.startsWith(month));
      const filled = monthAssignments.filter((a) => a.staffId).length;
      return { outletId: outlet.outletId, total: monthAssignments.length, filled, gaps: monthAssignments.length - filled };
    });
  }

  warnings(outletId?: string): RosterWarning[] {
    return outletId ? this.lastWarnings.filter((w) => w.outletId === outletId) : this.lastWarnings;
  }

  requestLeave(input: Omit<LeaveRequest, "leaveRequestId" | "status">): LeaveRequest {
    const request: LeaveRequest = {
      ...input,
      leaveRequestId: `leave-${this.nextLeaveId++}`,
      status: "pending",
    };
    this.leave.push(request);
    return request;
  }

  listLeave(staffId?: string): LeaveRequest[] {
    return staffId ? this.leave.filter((l) => l.staffId === staffId) : this.leave;
  }

  /**
   * Approving leave doesn't auto-find a replacement — it clears the
   * staff member off any already-generated shifts in that window and
   * marks them understaffed, mirroring what the year-generator would
   * have produced had the leave existed up front. An admin re-runs
   * generateYear (or fills the gap manually) to actually cover it.
   */
  decideLeave(leaveRequestId: string, status: "approved" | "denied"): LeaveRequest | undefined {
    const request = this.leave.find((l) => l.leaveRequestId === leaveRequestId);
    if (!request) return undefined;
    request.status = status;

    if (status === "approved") {
      for (const assignment of this.assignments) {
        if (
          assignment.staffId === request.staffId &&
          assignment.date >= request.startDate &&
          assignment.date <= request.endDate
        ) {
          assignment.staffId = null;
          assignment.status = "on_leave_covered";
          this.lastWarnings.push({
            date: assignment.date,
            outletId: assignment.outletId,
            shiftTemplateId: assignment.shiftTemplateId,
            role: assignment.role,
            message: `${request.staffId} approved for leave on ${assignment.date} — shift needs a replacement`,
          });
        }
      }
    }

    return request;
  }

  /** Swaps the staff assigned to two existing assignments. Validates role match and that neither staff member is already booked on the other's date. */
  swapAssignments(assignmentIdA: string, assignmentIdB: string): { ok: true } | { ok: false; error: string } {
    const a = this.assignments.find((x) => x.assignmentId === assignmentIdA);
    const b = this.assignments.find((x) => x.assignmentId === assignmentIdB);
    if (!a || !b) return { ok: false, error: "Assignment not found" };
    if (a.role !== b.role) return { ok: false, error: "Can only swap shifts of the same role" };

    const staffAlreadyOnDate = (staffId: string | null, date: string, excludeId: string) =>
      staffId !== null &&
      this.assignments.some((x) => x.assignmentId !== excludeId && x.staffId === staffId && x.date === date);

    if (staffAlreadyOnDate(b.staffId, a.date, a.assignmentId)) {
      return { ok: false, error: "Incoming staff member is already booked that day" };
    }
    if (staffAlreadyOnDate(a.staffId, b.date, b.assignmentId)) {
      return { ok: false, error: "Incoming staff member is already booked that day" };
    }

    const tmp = a.staffId;
    a.staffId = b.staffId;
    b.staffId = tmp;
    a.status = "scheduled";
    b.status = "scheduled";
    return { ok: true };
  }
}

export const rosterStore = new RosterStore();
