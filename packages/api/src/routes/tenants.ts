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
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { requireAuth, requireMasterConsole } from "../middleware/auth";
import { buildActivityLogData } from "../lib/activityLog";
import { generateTemporaryPassword } from "../lib/passwords";
import { prisma } from "../lib/prisma";

const router = Router();

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

  // Provision the tenant AND its first admin together, in one
  // transaction. Creating the tenant alone produced a company nobody
  // could ever sign into — the only way in was a master_admin using
  // enter-tenant-view, which is a support tool, not a customer's access.
  // If the admin cannot be created (the address is already in use), the
  // tenant must not exist either: a half-provisioned tenant is worse
  // than a failed request.
  const email = String(primaryContactEmail).trim().toLowerCase();
  const temporaryPassword = generateTemporaryPassword();

  let tenant;
  try {
    tenant = await prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: { companyName, primaryContactEmail: email, status: "trial" },
      });
      await tx.portalUser.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(temporaryPassword, 10),
          role: "tenant_admin",
          tenantId: created.tenantId,
          mustChangePassword: true,
        },
      });
      return created;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({
        error: `${email} already has a portal account. Use a different contact address for this tenant's first admin.`,
      });
    }
    throw e;
  }

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

  res.status(201).json({
    ...tenant,
    adminEmail: email,
    temporaryPassword,
    note:
      "Give this password to the tenant's administrator directly — it is shown once and must be changed at first " +
      "sign-in. No email is sent; no email provider is integrated.",
  });
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
