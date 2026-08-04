// src/routes/profiles.ts
//
// CustomerProfile CRUD — tenant-scoped, following the requireAuth +
// requireTenantScope + tenantWhere pattern in routes/reports.ts for
// reads and create. PATCH/DELETE use updateMany/deleteMany with the
// tenant + id filter combined in the write itself (rather than a plain
// update/delete keyed on profileId alone after a separate findFirst
// check) — Prisma's WhereUniqueInput for update/delete-by-id can't take
// a compound non-unique filter, so updateMany/deleteMany's plain where
// is the correct equivalent that keeps the tenant scope enforced by the
// query, not by an external invariant. A profile's PIN only needs to be
// unique WITHIN a tenant
// (see CLAUDE.md "Multi-tenant architecture" / customerProfile.ts) — the
// DB enforces this via @@unique([tenantId, pin]) in schema.prisma, and
// POST/PATCH below turn a violation into a friendly 409 rather than a
// raw Prisma error.
//
// Also exposes GET /:profileId/qr, generating the DIAGPROFILE:{tenantId}:
// {pin} payload via customerProfile.ts's generateProfileQrPayload — the
// Test Profiles editor mockup downloads/prints this per profile.
//
// Also exposes GET /tenants/:tenantId/profiles/by-pin/:pin — the mobile
// app's technician-facing PIN resolution (customerProfile.ts's
// resolveProfileByPin, which already expects exactly this URL shape via
// PROFILE_API_BASE). Deliberately NOT behind requireAuth/
// requireTenantScope, same reasoning and same enumeration-risk
// mitigation (rate limiting) as technicians.ts's /login: there is no
// portal session at this point in the mobile flow, and a PIN is a
// low-entropy, non-secret identifier by the same design as badgeCode.

import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { TEST_CATALOG, generateProfileQrPayload } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router();
const prisma = new PrismaClient();

const PIN_PATTERN = /^\d{4,6}$/;
const VALID_TEST_IDS = new Set(TEST_CATALOG.map((t) => t.testId));

// Same enumeration concern as technicians.ts's badgeLoginRateLimit — a
// PIN is short and non-secret, and tenantId isn't secret either (it's
// printed on the same profile QR poster this lookup is resolving).
const pinLookupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  // See the note on badgeLoginRateLimit in routes/technicians.ts: the
  // default is the production value, so an unset env var is secure.
  limit: Number(process.env.PIN_LOOKUP_RATE_LIMIT ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lookup attempts. Try again later." },
});

router.get("/tenants/:tenantId/profiles/by-pin/:pin", pinLookupRateLimit, async (req, res) => {
  const { tenantId, pin } = req.params;
  const profile = await prisma.customerProfile.findFirst({
    where: { tenantId, pin },
  });
  if (!profile) return res.status(404).json({ error: "PIN not recognized for this tenant" });
  res.json(profile);
});

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
  const data: Prisma.CustomerProfileUpdateManyMutationInput = {};

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

  try {
    // updateMany's where accepts the combined tenant + id filter directly
    // (unlike update's WhereUniqueInput) — the tenant check lives in the
    // write itself, not just in a preceding findFirst, so this stays safe
    // even if a future feature ever reassigns a profile's tenantId.
    const result = await prisma.customerProfile.updateMany({
      where: { ...tenantWhere(req), profileId: req.params.profileId },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: "Profile not found" });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "PIN already in use for this tenant" });
    }
    throw e;
  }

  const updated = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "profile_updated",
      targetType: "profile",
      targetId: updated!.profileId,
      details: `Updated profile "${updated!.customerName}"`,
    }),
  });

  res.json(updated);
});

router.delete("/:profileId", requireAuth, requireTenantScope, async (req, res) => {
  const existing = await prisma.customerProfile.findFirst({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (!existing) return res.status(404).json({ error: "Profile not found" });

  // Refused once inspections reference this profile. The delete used to
  // succeed and blank profileId on each of those reports, losing which
  // test set a device was inspected under — which is part of what makes
  // an old report interpretable at all.
  const reportCount = await prisma.report.count({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (reportCount > 0) {
    return res.status(409).json({
      error:
        `This profile has ${reportCount} inspection(s) recorded against it and cannot be deleted — ` +
        `removing it would erase which test set those devices were inspected under.`,
      reportCount,
    });
  }

  // Combined tenant + id filter in the delete itself, not just the
  // preceding findFirst — see the note on PATCH above.
  const result = await prisma.customerProfile.deleteMany({
    where: { ...tenantWhere(req), profileId: req.params.profileId },
  });
  if (result.count === 0) return res.status(404).json({ error: "Profile not found" });

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
