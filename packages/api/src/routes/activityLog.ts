// src/routes/activityLog.ts
//
// Activity log query endpoint — tenant-scoped, following the requireAuth
// + requireTenantScope + tenantWhere pattern from reports.ts.
// admin_portal_activity_log.html (per CLAUDE.md) is explicitly a
// tenant-scoped page (shows the tenant indicator badge), filterable by
// action type/actor/date range — not a Master Console cross-tenant view,
// so there's no requireMasterConsole exception needed here like
// tenants.ts. Platform-level entries (tenantId: null — tenant_created,
// entered_tenant_view, exited_tenant_view) are intentionally invisible
// through this endpoint; a cross-tenant activity view is Master Console
// scope, not built here.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { ActivityAction } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { parseListWindow, setPaginationHeaders } from "../lib/pagination";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { prisma } from "../lib/prisma";

const router = Router();


// ActivityAction is a TS union with no runtime array of its own — mirror
// its literal values here so an unrecognized ?actions= value gets a
// clear 400 instead of silently reaching Prisma as an always-empty (or
// erroring) filter.
const VALID_ACTIONS = new Set<ActivityAction>([
  "portal_login",
  "portal_logout",
  "portal_password_changed",
  "portal_mfa_enabled",
  "portal_mfa_disabled",
  "api_key_created",
  "api_key_revoked",
  "webhook_created",
  "user_created",
  "user_updated",
  "user_deleted",
  "user_password_reset",
  "entered_tenant_view",
  "exited_tenant_view",
  "tenant_created",
  "tenant_suspended",
  "tenant_activated",
  "profile_created",
  "profile_updated",
  "profile_deleted",
  "license_provisioned",
  "license_suspended",
  "license_expired",
  "seat_consumed",
  "seat_released",
  "dispute_received",
  "dispute_upheld",
  "dispute_grade_adjusted",
  "pricing_uploaded",
  "settings_updated",
  "report_revision_created",
  "data_wipe_certified",
  "warranty_claim_filed",
  "warranty_claim_resolved",
  "notification_sent",
  "notification_failed",
]);

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const { actions, actorUserId, fromDate, toDate } = req.query;

  const where: Prisma.ActivityLogEntryWhereInput = { ...tenantWhere(req) };

  if (typeof actions === "string" && actions.length > 0) {
    const requestedActions = actions.split(",");
    const unknown = requestedActions.filter((a) => !VALID_ACTIONS.has(a as ActivityAction));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown action(s): ${unknown.join(", ")}` });
    }
    where.action = { in: requestedActions as ActivityAction[] };
  }
  if (typeof actorUserId === "string" && actorUserId.length > 0) {
    where.actorUserId = actorUserId;
  }
  if (typeof fromDate === "string" || typeof toDate === "string") {
    where.timestamp = {
      ...(typeof fromDate === "string" ? { gte: new Date(fromDate) } : {}),
      ...(typeof toDate === "string" ? { lte: new Date(toDate) } : {}),
    };
  }

  // Offset paging on top of the filters this route already had — an
  // audit trail is the one list nobody should be able to reach the end
  // of and quietly stop.
  const { limit: take, offset } = parseListWindow(req);

  const total = await prisma.activityLogEntry.count({ where });
  setPaginationHeaders(res, { total, limit: take, offset });

  const entries = await prisma.activityLogEntry.findMany({
    where,
    skip: offset,
    orderBy: { timestamp: "desc" },
    take,
  });

  res.json(entries);
});

export default router;
