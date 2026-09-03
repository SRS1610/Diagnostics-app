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

let nextAssignmentId = 1;
let nextLeaveId = 1;

class RosterStore {
  outlets: Outlet[] = OUTLETS;
  staff: StaffMember[] = STAFF;
  shiftTemplates: ShiftTemplate[] = SHIFT_TEMPLATES;
  leave: LeaveRequest[] = [];
  assignments: ShiftAssignment[] = [];
  lastWarnings: RosterWarning[] = [];

  listOutlets(): Outlet[] {
    return this.outlets;
  }

  listStaff(outletId?: string): StaffMember[] {
    return outletId ? this.staff.filter((s) => s.homeOutletId === outletId) : this.staff;
  }

  listShiftTemplates(outletId?: string): ShiftTemplate[] {
    return outletId ? this.shiftTemplates.filter((t) => t.outletId === outletId) : this.shiftTemplates;
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
      makeAssignmentId: () => `asg-${nextAssignmentId++}`,
    });

    this.assignments.push(...assignments);
    this.lastWarnings = warnings;

    return { assignmentsCreated: assignments.length, warnings };
  }

  listAssignments(filter: { outletId?: string; month?: string; staffId?: string }): ShiftAssignment[] {
    return this.assignments.filter((a) => {
      if (filter.outletId && a.outletId !== filter.outletId) return false;
      if (filter.month && !a.date.startsWith(filter.month)) return false;
      if (filter.staffId && a.staffId !== filter.staffId) return false;
      return true;
    });
  }

  warnings(outletId?: string): RosterWarning[] {
    return outletId ? this.lastWarnings.filter((w) => w.outletId === outletId) : this.lastWarnings;
  }

  requestLeave(input: Omit<LeaveRequest, "leaveRequestId" | "status">): LeaveRequest {
    const request: LeaveRequest = {
      ...input,
      leaveRequestId: `leave-${nextLeaveId++}`,
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
