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
import { logActivity } from "@diagnostics/shared";
import { requireAuth, requireMasterAdmin } from "../middleware/auth";

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
    { userId: user.userId, role: user.role, tenantId: user.tenantId, viewingTenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  await prisma.activityLogEntry.create({
    data: logActivity({
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
    data: logActivity({
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
    { userId: req.portalSession!.userId, role: "master_admin", tenantId: null, viewingTenantId: tenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, viewingTenantId: tenantId });
});

export default router;
