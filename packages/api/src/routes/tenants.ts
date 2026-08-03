// src/routes/tenants.ts
//
// Tenant CRUD — master_admin only. Tenant is the top-level entity, so
// these routes are a genuine cross-tenant exception to the
// requireTenantScope pattern in routes/reports.ts: there is no single
// tenant to scope to here, by design. Every route below uses
// requireMasterAdmin instead, and every state-changing action logs to
// ActivityLogEntry via logActivity (tenantId set to the tenant acted on,
// not the actor's — see adminActivityLog.ts / tenant.ts).

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { logActivity } from "@diagnostics/shared";
import { requireAuth, requireMasterAdmin } from "../middleware/auth";

const router = Router();
const prisma = new PrismaClient();

// Cross-tenant list — legitimate Master Console aggregate view.
router.get("/", requireAuth, requireMasterAdmin, async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(tenants);
});

router.get("/:tenantId", requireAuth, requireMasterAdmin, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({
    where: { tenantId: req.params.tenantId },
  });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

router.post("/", requireAuth, requireMasterAdmin, async (req, res) => {
  const { companyName, primaryContactEmail } = req.body;
  if (!companyName || !primaryContactEmail) {
    return res.status(400).json({ error: "companyName and primaryContactEmail are required" });
  }

  const tenant = await prisma.tenant.create({
    data: { companyName, primaryContactEmail, status: "trial" },
  });

  await prisma.activityLogEntry.create({
    data: logActivity({
      tenantId: tenant.tenantId,
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

router.patch("/:tenantId/suspend", requireAuth, requireMasterAdmin, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { tenantId: req.params.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const updated = await prisma.tenant.update({
    where: { tenantId: tenant.tenantId },
    data: { status: "suspended" },
  });

  await prisma.activityLogEntry.create({
    data: logActivity({
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

router.patch("/:tenantId/activate", requireAuth, requireMasterAdmin, async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { tenantId: req.params.tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const updated = await prisma.tenant.update({
    where: { tenantId: tenant.tenantId },
    data: { status: "active" },
  });

  await prisma.activityLogEntry.create({
    data: logActivity({
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
