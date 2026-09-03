// src/csvExport.ts
//
// Turns a month's assignments into a roster CSV — for printing/payroll,
// the same job packages/api's lib/csv.ts does for other exports in this
// codebase, kept local here since the roster module is deliberately
// standalone.

import { Outlet, ShiftAssignment, ShiftTemplate, StaffMember } from "./types";

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function assignmentsToCsv(params: {
  assignments: ShiftAssignment[];
  staff: StaffMember[];
  shiftTemplates: ShiftTemplate[];
  outlets: Outlet[];
}): string {
  const { assignments, staff, shiftTemplates, outlets } = params;
  const staffById = new Map(staff.map((s) => [s.staffId, s]));
  const templateById = new Map(shiftTemplates.map((t) => [t.shiftTemplateId, t]));
  const outletById = new Map(outlets.map((o) => [o.outletId, o]));

  const rows = [["Date", "Outlet", "Shift", "Role", "Staff", "Employment Type", "Status"]];

  const sorted = [...assignments].sort((a, b) => a.date.localeCompare(b.date) || a.role.localeCompare(b.role));

  for (const a of sorted) {
    const outlet = outletById.get(a.outletId);
    const template = templateById.get(a.shiftTemplateId);
    const person = a.staffId ? staffById.get(a.staffId) : undefined;
    rows.push([
      a.date,
      outlet?.name ?? a.outletId,
      template?.label ?? a.shiftTemplateId,
      a.role,
      person?.name ?? "UNFILLED",
      person?.employmentType ?? "",
      a.status,
    ]);
  }

  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}
