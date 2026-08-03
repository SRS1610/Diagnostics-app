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
import { PrismaClient, Prisma } from "@prisma/client";
import { ActivityAction } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";

const router = Router();
const prisma = new PrismaClient();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const { actions, actorUserId, fromDate, toDate, limit } = req.query;

  const where: Prisma.ActivityLogEntryWhereInput = { ...tenantWhere(req) };

  if (typeof actions === "string" && actions.length > 0) {
    where.action = { in: actions.split(",") as ActivityAction[] };
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

  let take = DEFAULT_LIMIT;
  if (typeof limit === "string") {
    const parsed = Number.parseInt(limit, 10);
    if (Number.isFinite(parsed) && parsed > 0) take = Math.min(parsed, MAX_LIMIT);
  }

  const entries = await prisma.activityLogEntry.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take,
  });

  res.json(entries);
});

export default router;
