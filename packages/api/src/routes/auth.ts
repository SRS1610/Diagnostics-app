// src/routes/auth.ts
//
// Implements the login() flow from portalAuth.ts as a real HTTP endpoint.
// See CLAUDE.md "Multi-tenant architecture" — tenant_admin/tenant_staff
// land directly in their own tenant; master_admin lands with
// viewingTenantId: null until they call /auth/enter-tenant-view.

import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { requireAuth, requireMasterAdmin } from "../middleware/auth";
import { buildActivityLogData } from "../lib/activityLog";
import { generateResetToken, validatePassword } from "../lib/passwords";
import { prisma } from "../lib/prisma";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await prisma.portalUser.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  // A deactivated account gets the SAME message as a wrong password.
  // "Your account is disabled" confirms the address is real, which is
  // the one fact an unauthenticated caller should not be able to harvest
  // from a login form.
  if (!user.active) {
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

  await prisma.portalUser.update({
    where: { userId: user.userId },
    data: { lastLoginAt: new Date() },
  });

  res.json({
    token,
    user: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      // The portal uses this to force the password screen before
      // anything else. The token IS issued: they have proved who they
      // are, they just cannot keep using a password an admin has seen.
      mustChangePassword: user.mustChangePassword,
    },
  });
});

// ============================================================
// Passwords
// ============================================================

// Unauthenticated and guessable-by-design (an email address), so the
// only thing standing between it and a mailbox-enumeration sweep or a
// token-generation flood is this limit.
const passwordResetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PASSWORD_RESET_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Changing your own password. Requires the current one — an unattended
 *  logged-in session should not be enough to lock out its owner. */
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;

  const check = validatePassword(newPassword);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const user = await prisma.portalUser.findUnique({ where: { userId: req.portalSession!.userId } });
  if (!user) return res.status(401).json({ error: "Session is no longer valid" });

  if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  if (await bcrypt.compare(newPassword as string, user.passwordHash)) {
    return res.status(400).json({ error: "The new password must be different from the current one" });
  }

  await prisma.portalUser.update({
    where: { userId: user.userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword as string, 10),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  // Any outstanding reset links are void once the password changes.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_password_changed",
      targetType: "portal_user",
      targetId: user.userId,
      details: `${user.email} changed their password`,
    }),
  });

  res.status(204).send();
});

/**
 * Self-service reset request.
 *
 * ALWAYS returns 204, whether or not the address exists — a different
 * response for a known address turns this into a "does this person have
 * an account here?" oracle, and on a multi-tenant platform that leaks
 * customer lists.
 *
 * With no email provider integrated, the token has nowhere to go. It is
 * created and recorded, and the response says plainly that delivery is
 * not wired up, so nobody is left waiting for a message that will never
 * arrive. In development, DEV_RETURN_RESET_TOKEN=1 returns it directly.
 */
router.post("/forgot-password", passwordResetRateLimit, async (req, res) => {
  const { email } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email is required" });
  }

  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });

  let devToken: string | undefined;
  if (user && user.active) {
    const token = generateResetToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // one hour
      },
    });
    if (process.env.DEV_RETURN_RESET_TOKEN === "1") devToken = token;
  }

  res.status(200).json({
    // Deliberately identical for a real and an unknown address.
    message: "If that address has an account, a reset has been prepared.",
    deliveryNote:
      "No email provider is integrated, so nothing was sent. An administrator can reset the password directly from the Team page.",
    ...(devToken ? { devResetToken: devToken } : {}),
  });
});

/** Completes a reset with a token from /forgot-password. */
router.post("/reset-password", passwordResetRateLimit, async (req, res) => {
  const { token, newPassword } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });

  const check = validatePassword(newPassword);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  // One message for every failure mode — expired, already used, never
  // existed. Distinguishing them tells an attacker which tokens were
  // real.
  const invalid = () => res.status(400).json({ error: "That reset link is invalid or has expired" });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) return invalid();
  if (!record.user.active) return invalid();

  // Consume the token conditionally: two submissions of the same link
  // must not both succeed.
  const consumed = await prisma.passwordResetToken.updateMany({
    where: { tokenId: record.tokenId, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count === 0) return invalid();

  await prisma.portalUser.update({
    where: { userId: record.userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword as string, 10),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: record.user.tenantId,
      actorUserId: record.userId,
      actorRole: record.user.role as any,
      action: "portal_password_changed",
      targetType: "portal_user",
      targetId: record.userId,
      details: `${record.user.email} reset their password`,
    }),
  });

  res.status(204).send();
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
