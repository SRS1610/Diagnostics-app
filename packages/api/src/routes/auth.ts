// src/routes/auth.ts
//
// Implements the login() flow from portalAuth.ts as a real HTTP endpoint.
// See CLAUDE.md "Multi-tenant architecture" — tenant_admin/tenant_staff
// land directly in their own tenant; master_admin lands with
// viewingTenantId: null until they call /auth/enter-tenant-view.

import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { requireAuth, requireMasterAdmin } from "../middleware/auth";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET as string;

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await prisma.portalUser.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const viewingTenantId = user.tenantId; // tenant users land in their own tenant;
                                          // master_admin lands with null (Master Console)

  const token = jwt.sign(
    { kind: "portal", userId: user.userId, role: user.role, tenantId: user.tenantId, viewingTenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_login",
      targetType: "session",
      targetId: user.userId,
      details: `${user.email} logged in`,
    }),
  });

  res.json({ token, user: { userId: user.userId, email: user.email, role: user.role, tenantId: user.tenantId } });
});

// Master admin only — switches the session into a specific tenant's view
router.post("/enter-tenant-view", requireAuth, requireMasterAdmin, async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId is required" });

  const tenant = await prisma.tenant.findUnique({ where: { tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "entered_tenant_view",
      targetType: "tenant",
      targetId: tenantId,
      details: `Master admin entered tenant view for ${tenant.companyName}`,
    }),
  });

  // Issue a new token scoped to this tenant view
  const token = jwt.sign(
    { kind: "portal", userId: req.portalSession!.userId, role: "master_admin", tenantId: null, viewingTenantId: tenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, viewingTenantId: tenantId });
});

// Master admin only — leaves tenant-support view, returning to Master
// Console context (viewingTenantId: null). Required before any
// requireMasterConsole-gated route (tenant CRUD, platform analytics)
// will accept the session again — see middleware/auth.ts.
router.post("/exit-tenant-view", requireAuth, requireMasterAdmin, async (req, res) => {
  const previousTenantId = req.portalSession!.viewingTenantId;

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: previousTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "exited_tenant_view",
      targetType: "tenant",
      targetId: previousTenantId ?? "platform",
      details: "Master admin exited tenant view",
    }),
  });

  const token = jwt.sign(
    { kind: "portal", userId: req.portalSession!.userId, role: "master_admin", tenantId: null, viewingTenantId: null },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, viewingTenantId: null });
});

export default router;
