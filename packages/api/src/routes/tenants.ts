// src/routes/tenants.ts
//
// Tenant CRUD — master_admin only, and only in genuine Master Console
// context (requireMasterConsole rejects a session that's currently
// "inside" a tenant's view via /auth/enter-tenant-view — see
// middleware/auth.ts). Tenant is the top-level entity, so these routes
// are a deliberate exception to the requireTenantScope pattern in
// routes/reports.ts: there is no single tenant to scope to here.
//
// Activity logging follows adminActivityLog.ts's documented convention:
// tenantId is null for the platform-level tenant_created action (there
// is no tenant yet at creation time), but is the affected tenant's ID
// for tenant_suspended/tenant_activated — matching the reference
// implementation in tenant.ts.

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireMasterConsole } from "../middleware/auth";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router();
const prisma = new PrismaClient();

// Cross-tenant list — legitimate Master Console aggregate view.
router.get("/", requireAuth, requireMasterConsole, async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(tenants);
});

router.get("/:tenantId", requireAuth, requireMasterConsole, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { tenantId: req.params.tenantId },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

router.post("/", requireAuth, requireMasterConsole, async (req, res) => {
  const { companyName, primaryContactEmail } = req.body;
  if (!companyName || !primaryContactEmail) {
    return res.status(400).json({ error: "companyName and primaryContactEmail are required" });
  }

  const tenant = await prisma.tenant.create({
    data: { companyName, primaryContactEmail, status: "trial" },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: null, // platform-level action — see adminActivityLog.ts
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "tenant_created",
      targetType: "tenant",
      targetId: tenant.tenantId,
      details: `Created tenant "${tenant.companyName}"`,
    }),
  });

  res.status(201).json(tenant);
});

router.patch("/:tenantId/suspend", requireAuth, requireMasterConsole, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { tenantId: req.params.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const updated = await prisma.tenant.update({
    where: { tenantId: tenant.tenantId },
    data: { status: "suspended" },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: updated.tenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "tenant_suspended",
      targetType: "tenant",
      targetId: updated.tenantId,
      details: `Suspended tenant "${updated.companyName}"`,
    }),
  });

  res.json(updated);
});

router.patch("/:tenantId/activate", requireAuth, requireMasterConsole, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { tenantId: req.params.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const updated = await prisma.tenant.update({
    where: { tenantId: tenant.tenantId },
    data: { status: "active" },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: updated.tenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "tenant_activated",
      targetType: "tenant",
      targetId: updated.tenantId,
      details: `Activated tenant "${updated.companyName}"`,
    }),
  });

  res.json(updated);
});

export default router;
