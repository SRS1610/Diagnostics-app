// adminActivityLog.ts
//
// Central audit trail for every admin and system action across the
// platform. This has been flagged as a gap three times across this
// project's history — it's the last major structural piece.
//
// Every function that changes state in the system should call
// logActivity() — see the integration list in CLAUDE.md "Admin
// activity log" for which modules are wired up and which call site
// in each one triggers a log entry.

export type ActivityAction =
  // Portal auth
  | "portal_login"
  | "portal_logout"
  | "entered_tenant_view"
  | "exited_tenant_view"
  // Tenant management (master_admin only)
  | "tenant_created"
  | "tenant_suspended"
  | "tenant_activated"
  // Customer profiles
  | "profile_created"
  | "profile_updated"
  | "profile_deleted"
  // Licensing
  | "license_provisioned"
  | "license_suspended"
  | "license_expired"
  | "seat_consumed"
  | "seat_released"
  // Disputes
  | "dispute_received"
  | "dispute_upheld"
  | "dispute_grade_adjusted"
  // Pricing
  | "pricing_uploaded"
  // Settings
  | "settings_updated"
  // Reports / inspections
  | "report_revision_created"
  | "data_wipe_certified"
  // Warranty
  | "warranty_claim_filed"
  | "warranty_claim_resolved"
  // Notifications
  | "notification_sent"
  | "notification_failed";

export interface ActivityLogEntry {
  entryId: string;
  tenantId: string | null; // null for platform-level actions (tenant_created, entered_tenant_view)
  actorUserId: string;
  actorRole: "master_admin" | "tenant_admin" | "tenant_staff" | "system";
  action: ActivityAction;
  targetType: string; // e.g. "profile", "license", "dispute", "tenant", "report"
  targetId: string; // the ID of whatever was acted on
  details?: string; // human-readable description of what changed
  metadata?: Record<string, unknown>; // structured data for programmatic use (e.g. old/new values)
  timestamp: string;
  ipAddress?: string;
}

/**
 * The single entry point for audit logging. Every module listed in the
 * integration map below calls this — never writes its own log format.
 * Persistence is left to the caller's storage layer (database insert,
 * append to a log store, etc.) — this function builds the entry.
 */
export function logActivity(
  entry: Omit<ActivityLogEntry, "entryId" | "timestamp">
): ActivityLogEntry {
  return {
    ...entry,
    entryId: `LOG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Query helper — returns entries for a specific tenant, optionally
 * filtered by action type and/or date range. The actual filtering
 * should happen at the database level in production; this is the
 * interface shape for the admin portal's activity log view.
 */
export interface ActivityLogQuery {
  tenantId?: string | null;
  actions?: ActivityAction[];
  actorUserId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/**
 * Returns the entries that would match a query — in production this
 * is a database query, not an in-memory filter. Shape it here so the
 * admin portal's UI can be built against a known interface.
 */
export async function queryActivityLog(query: ActivityLogQuery): Promise<ActivityLogEntry[]> {
  const params = new URLSearchParams();
  if (query.tenantId) params.set("tenantId", query.tenantId);
  if (query.actions?.length) params.set("actions", query.actions.join(","));
  if (query.actorUserId) params.set("actorUserId", query.actorUserId);
  if (query.fromDate) params.set("from", query.fromDate);
  if (query.toDate) params.set("to", query.toDate);
  if (query.limit) params.set("limit", String(query.limit));
  const response = await fetch(`${process.env.ACTIVITY_LOG_API_BASE}/logs?${params}`);
  return response.json();
}
