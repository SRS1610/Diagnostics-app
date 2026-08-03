// src/lib/activityLog.ts
//
// logActivity() (from @diagnostics/shared) returns an ActivityLogEntry
// with `metadata?: Record<string, unknown>` — a reasonable shape for
// shared, storage-agnostic logic, but not structurally identical to
// Prisma's generated Json input type (InputJsonValue), so passing it
// straight to `prisma.activityLogEntry.create({ data: ... })` fails
// `tsc --noEmit` even though it works correctly at runtime. Cast once,
// here, instead of repeating an `as` at every call site.

import { Prisma } from "@prisma/client";
import { logActivity } from "@diagnostics/shared";

export function buildActivityLogData(
  entry: Parameters<typeof logActivity>[0]
): Prisma.ActivityLogEntryUncheckedCreateInput {
  return logActivity(entry) as unknown as Prisma.ActivityLogEntryUncheckedCreateInput;
}
