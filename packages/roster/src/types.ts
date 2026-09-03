// src/types.ts
//
// Domain model for the badminton-outlet staff roster. Deliberately
// self-contained — this is a different business (badminton centres,
// not phone diagnostics) and doesn't share entities with
// @diagnostics/shared's Tenant/CustomerProfile model.

export type Role = "duty_manager" | "reception" | "coach" | "maintenance";

export type EmploymentType = "full_time" | "part_time" | "casual";

// 0 = Sunday ... 6 = Saturday, matching Date#getDay().
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Outlet {
  outletId: string;
  name: string;
  suburb: string;
  courts: number;
  /** Hour of day (0-23) the outlet opens/closes, same every day. */
  opensAt: number;
  closesAt: number;
}

export interface StaffMember {
  staffId: string;
  name: string;
  role: Role;
  homeOutletId: string;
  employmentType: EmploymentType;
  /** Hard cap enforced by the generator — never scheduled past this in a Mon-Sun week. */
  maxHoursPerWeek: number;
  /** Weekdays this person can ever work, before leave is considered. */
  availableDays: Weekday[];
}

export interface ShiftTemplate {
  shiftTemplateId: string;
  outletId: string;
  label: string; // "Morning", "Evening"
  startHour: number;
  endHour: number;
  /** How many staff of each role this shift needs, e.g. { duty_manager: 1, reception: 2 }. */
  requiredRoles: Partial<Record<Role, number>>;
}

export type AssignmentStatus = "scheduled" | "on_leave_covered" | "understaffed";

export interface ShiftAssignment {
  assignmentId: string;
  outletId: string;
  date: string; // ISO date, "YYYY-MM-DD"
  shiftTemplateId: string;
  role: Role;
  staffId: string | null; // null when the slot could not be filled
  status: AssignmentStatus;
}

export interface LeaveRequest {
  leaveRequestId: string;
  staffId: string;
  startDate: string; // ISO date, inclusive
  endDate: string; // ISO date, inclusive
  reason?: string;
  status: "pending" | "approved" | "denied";
}

export interface RosterWarning {
  date: string;
  outletId: string;
  shiftTemplateId: string;
  role: Role;
  message: string;
}

export interface GenerateRosterResult {
  assignmentsCreated: number;
  warnings: RosterWarning[];
}
