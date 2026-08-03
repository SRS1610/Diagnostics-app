// src/routes/profiles.ts
//
// CustomerProfile CRUD — tenant-scoped, following the exact pattern in
// routes/reports.ts (requireAuth + requireTenantScope + tenantWhere on
// every query). A profile's PIN only needs to be unique WITHIN a tenant
// (see CLAUDE.md "Multi-tenant architecture" / customerProfile.ts) — the
// DB enforces this via @@unique([tenantId, pin]) in schema.prisma, and
// POST/PATCH below turn a violation into a friendly 409 rather than a
// raw Prisma error.
//
// Also exposes GET /:profileId/qr, generating the DIAGPROFILE:{tenantId}:
// {pin} payload via customerProfile.ts's generateProfileQrPayload — the
// Test Profiles editor mockup downloads/prints this per profile.
//
// NOT included here: the mobile app's PIN-resolution endpoint
// (resolveProfileByPin's `/tenants/:tenantId/profiles/by-pin/:pin`) —
// that's a technician-facing, not portal-user-facing, lookup and is
// Sprint 3 (mobile scaffold) scope, with its own auth question to
// resolve (badge login vs. unauthenticated) rather than portal JWT.

import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { TEST_CATALOG, generateProfileQrPayload } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router();
const prisma = new PrismaClient();

const PIN_PATTERN = /^\d{4,6}$/;
const VALID_TEST_IDS = new Set(TEST_CATALOG.map((t) => t.testId));

function validateEnabledTestIds(enabledTestIds: unknown): string[] | null {
  if (!Array.isArray(enabledTestIds) || !enabledTestIds.every((t) => typeof t === "string")) {
    return null;
  }
  if (enabledTestIds.some((t) => !VALID_TEST_IDS.has(t))) return null;
  return enabledTestIds;
}

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const profiles = await prisma.customerProfile.findMany({
    where: tenantWhere(req),
    orderBy: { updatedAt: "desc" },
  });
  res.json(profiles);
});

router.get("/:profileId", requireAuth, requireTenantScope, async (req, res) => {
  const profile = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  res.json(profile);
});

router.get("/:profileId/qr", requireAuth, requireTenantScope, async (req, res) => {
  const profile = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  // generateProfileQrPayload only reads tenantId/pin, but its parameter
  // type is the shared CustomerProfile shape (createdAt/updatedAt as
  // strings, not Prisma's Date) — pass just what it needs, typed against
  // that same parameter type rather than the full Prisma record.
  const qrInput: Parameters<typeof generateProfileQrPayload>[0] = {
    ...profile,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
  res.json({ payload: generateProfileQrPayload(qrInput) });
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { customerName, pin, enabledTestIds } = req.body;
  if (!customerName || !pin) {
    return res.status(400).json({ error: "customerName and pin are required" });
  }
  if (!PIN_PATTERN.test(pin)) {
    return res.status(400).json({ error: "pin must be 4-6 digits" });
  }
  const validatedTestIds = validateEnabledTestIds(enabledTestIds ?? []);
  if (!validatedTestIds) {
    return res.status(400).json({ error: "enabledTestIds must be an array of known testIds from TEST_CATALOG" });
  }

  let profile;
  try {
    profile = await prisma.customerProfile.create({
      data: { ...tenantWhere(req), customerName, pin, enabledTestIds: validatedTestIds },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "PIN already in use for this tenant" });
    }
    throw e;
  }

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "profile_created",
      targetType: "profile",
      targetId: profile.profileId,
      details: `Created profile "${profile.customerName}"`,
    }),
  });

  res.status(201).json(profile);
});

router.patch("/:profileId", requireAuth, requireTenantScope, async (req, res) => {
  const existing = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (!existing) return res.status(404).json({ error: "Profile not found" });

  const { customerName, pin, enabledTestIds } = req.body;
  const data: Prisma.CustomerProfileUpdateInput = {};

  if (customerName !== undefined) data.customerName = customerName;
  if (pin !== undefined) {
    if (!PIN_PATTERN.test(pin)) return res.status(400).json({ error: "pin must be 4-6 digits" });
    data.pin = pin;
  }
  if (enabledTestIds !== undefined) {
    const validatedTestIds = validateEnabledTestIds(enabledTestIds);
    if (!validatedTestIds) {
      return res.status(400).json({ error: "enabledTestIds must be an array of known testIds from TEST_CATALOG" });
    }
    data.enabledTestIds = validatedTestIds;
  }

  let updated;
  try {
    // tenantId + profileId combined in the same query the update targets,
    // via the findFirst 404 check above — Prisma's update-by-id doesn't
    // accept a compound where here, so re-checking existence first (and
    // updating only by the now-verified-owned profileId) is the correct
    // equivalent for a non-unique compound key update.
    updated = await prisma.customerProfile.update({
      where: { profileId: existing.profileId },
      data,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "PIN already in use for this tenant" });
    }
    throw e;
  }

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "profile_updated",
      targetType: "profile",
      targetId: updated.profileId,
      details: `Updated profile "${updated.customerName}"`,
    }),
  });

  res.json(updated);
});

router.delete("/:profileId", requireAuth, requireTenantScope, async (req, res) => {
  const existing = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (!existing) return res.status(404).json({ error: "Profile not found" });

  await prisma.customerProfile.delete({ where: { profileId: existing.profileId } });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "profile_deleted",
      targetType: "profile",
      targetId: existing.profileId,
      details: `Deleted profile "${existing.customerName}"`,
    }),
  });

  res.status(204).send();
});

export default router;
