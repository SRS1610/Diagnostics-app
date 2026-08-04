// src/routes/users.ts — portal user management.
//
// This did not exist. The only code that had ever created a PortalUser
// was the seed script, which meant provisioning a tenant produced a
// company nobody could log into, there was no way to disable an account,
// and nobody could change a password. Everything here follows from
// fixing that.
//
// Three rules shape the endpoints:
//
//  1. A TENANT ADMIN MANAGES ONLY THEIR OWN TENANT'S USERS. Every query
//     is filtered by tenantWhere(req), the same as any other
//     tenant-scoped resource — a user row is as tenant-owned as a report.
//
//  2. NOBODY CREATES A ROLE ABOVE THEIR OWN. A tenant_admin cannot mint
//     a master_admin; that is privilege escalation with extra steps, and
//     it is the single most valuable thing an attacker could do with a
//     compromised tenant account.
//
//  3. PASSWORDS ARE NEVER EMAILED FROM HERE, because no email provider
//     is integrated. A temporary password is returned to the ADMIN who
//     created the account, exactly once, for them to pass on out of
//     band. Pretending to send a message nobody receives would be worse.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { generateTemporaryPassword, PASSWORD_MIN_LENGTH, validatePassword } from "../lib/passwords";
import { prisma } from "../lib/prisma";

const router = Router();

const BCRYPT_ROUNDS = 10;
const TENANT_ROLES = new Set(["tenant_admin", "tenant_staff"]);

/** Never return passwordHash. Named explicitly rather than deleted from
 *  a spread, so a column added later is private by default. */
const PUBLIC_USER_FIELDS = {
  userId: true,
  email: true,
  displayName: true,
  role: true,
  tenantId: true,
  active: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const users = await prisma.portalUser.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "asc" },
    select: PUBLIC_USER_FIELDS,
  });
  res.json(users);
});

/**
 * Creates a user in THIS tenant and returns a one-time temporary
 * password. The account must change it at first login.
 */
router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot manage users" });
  }

  const { email, displayName, role } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  // Only tenant roles, ever. master_admin is not tenant-scoped and
  // cannot be created from inside a tenant — see rule 2 in the header.
  if (typeof role !== "string" || !TENANT_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of: ${[...TENANT_ROLES].join(", ")}` });
  }

  const temporaryPassword = generateTemporaryPassword();

  let user;
  try {
    user = await prisma.portalUser.create({
      data: {
        ...tenantWhere(req), // tenantId from the session, never the body
        email: email.trim().toLowerCase(),
        displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim() : null,
        role,
        passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS),
        mustChangePassword: true,
      },
      select: PUBLIC_USER_FIELDS,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Email is unique across the whole platform, not per tenant, since
      // it is the login identifier. Said plainly so an admin does not
      // conclude the address is free in their tenant.
      return res.status(409).json({ error: "That email address already has an account on this platform" });
    }
    throw e;
  }

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "user_created",
      targetType: "portal_user",
      targetId: user.userId,
      details: `Created ${role} account for ${user.email}`,
    }),
  });

  res.status(201).json({
    user,
    temporaryPassword,
    note:
      "Give this password to the user directly — it is shown once and never stored in readable form. " +
      "They must change it at first sign-in. No email is sent; no email provider is integrated.",
  });
});

router.patch("/:userId", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot manage users" });
  }

  const existing = await prisma.portalUser.findFirst({
    where: { ...tenantWhere(req), userId: req.params.userId },
  });
  if (!existing) return res.status(404).json({ error: "User not found" });

  const { displayName, role, active } = (req.body ?? {}) as Record<string, unknown>;
  const data: Prisma.PortalUserUpdateManyMutationInput = {};

  if (displayName !== undefined) {
    data.displayName = typeof displayName === "string" && displayName.trim() ? displayName.trim() : null;
  }
  if (role !== undefined) {
    if (typeof role !== "string" || !TENANT_ROLES.has(role)) {
      return res.status(400).json({ error: `role must be one of: ${[...TENANT_ROLES].join(", ")}` });
    }
    data.role = role;
  }
  if (active !== undefined) {
    if (typeof active !== "boolean") return res.status(400).json({ error: "active must be a boolean" });
    data.active = active;
  }

  // Locking yourself out is not a state anyone recovers from without a
  // DBA, so it is refused rather than confirmed.
  if (existing.userId === req.portalSession!.userId && (data.active === false || data.role === "tenant_staff")) {
    return res.status(409).json({ error: "You cannot remove your own access. Ask another admin to do it." });
  }
  // Nor is a tenant with no admin left, which is the same lockout by a
  // slower route.
  if (data.active === false || data.role === "tenant_staff") {
    const remainingAdmins = await prisma.portalUser.count({
      where: { ...tenantWhere(req), role: "tenant_admin", active: true, userId: { not: existing.userId } },
    });
    if (remainingAdmins === 0) {
      return res.status(409).json({ error: "This is the last active admin for this tenant — promote another first" });
    }
  }

  await prisma.portalUser.updateMany({
    where: { ...tenantWhere(req), userId: req.params.userId },
    data,
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "user_updated",
      targetType: "portal_user",
      targetId: existing.userId,
      details: `Updated ${existing.email}${data.active === false ? " (deactivated)" : ""}`,
    }),
  });

  const updated = await prisma.portalUser.findFirst({
    where: { ...tenantWhere(req), userId: req.params.userId },
    select: PUBLIC_USER_FIELDS,
  });
  res.json(updated);
});

/**
 * Admin-initiated password reset. Returns a temporary password to the
 * admin, once — the same out-of-band delivery as account creation, and
 * for the same reason.
 */
router.post("/:userId/reset-password", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot reset passwords" });
  }

  const user = await prisma.portalUser.findFirst({
    where: { ...tenantWhere(req), userId: req.params.userId },
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  const temporaryPassword = generateTemporaryPassword();
  await prisma.portalUser.updateMany({
    where: { ...tenantWhere(req), userId: req.params.userId },
    data: {
      passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
    },
  });

  // Any outstanding self-service reset links for this account are now
  // void: the password has already changed, and a link minted before it
  // should not still work.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "user_password_reset",
      targetType: "portal_user",
      targetId: user.userId,
      details: `Reset password for ${user.email}`,
    }),
  });

  res.json({
    temporaryPassword,
    note: `Give this to ${user.email} directly. They must change it at next sign-in. Minimum length is ${PASSWORD_MIN_LENGTH}.`,
  });
});

router.delete("/:userId", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot manage users" });
  }
  if (req.params.userId === req.portalSession!.userId) {
    return res.status(409).json({ error: "You cannot delete your own account" });
  }

  const existing = await prisma.portalUser.findFirst({
    where: { ...tenantWhere(req), userId: req.params.userId },
  });
  if (!existing) return res.status(404).json({ error: "User not found" });

  if (existing.role === "tenant_admin") {
    const remainingAdmins = await prisma.portalUser.count({
      where: { ...tenantWhere(req), role: "tenant_admin", active: true, userId: { not: existing.userId } },
    });
    if (remainingAdmins === 0) {
      return res.status(409).json({ error: "This is the last admin for this tenant and cannot be deleted" });
    }
  }

  await prisma.portalUser.deleteMany({
    where: { ...tenantWhere(req), userId: req.params.userId },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "user_deleted",
      targetType: "portal_user",
      targetId: existing.userId,
      details: `Deleted account ${existing.email}`,
    }),
  });

  res.status(204).send();
});

export { validatePassword };
export default router;
