// src/routes/licenses.ts
//
// License provisioning + seat consume/release — tenant-scoped, following
// the requireAuth + requireTenantScope + tenantWhere pattern from
// reports.ts. License bills at the TENANT level (see CLAUDE.md
// "Multi-tenant architecture" / licensing.ts) — a tenant_admin views and
// provisions only their own tenant's license via their session's
// viewingTenantId; a master_admin must call /auth/enter-tenant-view
// first, same as every other tenant-scoped resource in this API.
//
// Seat consume/release use updateMany with an atomic Prisma increment/
// decrement, combined with the tenant + license id filter in the same
// query (see the tenant-scope-reviewer finding fixed in profiles.ts —
// same reasoning applies here: the tenant filter must live in the write
// itself, not just a preceding findFirst).

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { checkLicense, License, LicenseType } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router();
const prisma = new PrismaClient();

const VALID_LICENSE_TYPES: LicenseType[] = [
  "per_inspection",
  "seat_subscription",
  "tiered_subscription",
  "enterprise_unlimited",
];

// checkLicense() (licensing.ts) operates on the shared License shape
// (string dates) — Prisma returns Date objects, so convert at the
// boundary rather than widening the shared function's types.
function toSharedLicense(row: {
  licenseId: string;
  tenantId: string;
  type: string;
  status: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  includedQuota: number | null;
  usageThisPeriod: number;
  overageRatePerInspection: number | null;
  seatLimit: number | null;
  activeSeats: number;
}): License {
  return {
    licenseId: row.licenseId,
    tenantId: row.tenantId,
    type: row.type as LicenseType,
    status: row.status as License["status"],
    billingPeriodStart: row.billingPeriodStart.toISOString(),
    billingPeriodEnd: row.billingPeriodEnd.toISOString(),
    includedQuota: row.includedQuota ?? undefined,
    usageThisPeriod: row.usageThisPeriod,
    overageRatePerInspection: row.overageRatePerInspection ?? undefined,
    seatLimit: row.seatLimit ?? undefined,
    activeSeats: row.activeSeats,
  };
}

// Same shape of gap as profiles.ts's by-pin lookup: mobile Step 3
// (License Check, per CLAUDE.md "Licensing model" — checked right after
// the profile QR scan, before device eligibility) only has a tenantId
// at this point (from technician badge login), not a portal session or
// a specific licenseId. Deliberately unauthenticated, rate-limited for
// the same reason as the other mobile-facing lookups (tenantId isn't
// secret — it's on the profile QR poster — though unlike PIN/badgeCode
// there's no second identifier being brute-forced here, so this is
// defense-in-depth rather than the primary mitigation).
const tenantLicenseCheckRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

router.get("/tenants/:tenantId/check", tenantLicenseCheckRateLimit, async (req, res) => {
  const { tenantId } = req.params;

  // OPEN QUESTION — a tenant with several concurrently-active licenses
  // has no defined governing license, and nothing currently stops that
  // state existing (provisionLicense doesn't deactivate a previous one,
  // and the schema permits many active rows per tenant).
  //
  // This was found by an end-to-end run, not in theory: a tenant with
  // one exhausted per_inspection licence and one active seat licence
  // was evaluated against whichever row sorted first, so an
  // out-of-credit organisation could be waved through. Ordering by
  // billingPeriodStart alone is not even stable — those dates tie
  // routinely, since licences tend to start on the 1st.
  //
  // Made deterministic here (stable tie-break on licenseId) so the
  // behaviour is at least predictable and reproducible, but determinism
  // is not correctness. The real fix is a product decision that should
  // not be guessed at:
  //   - should provisioning deactivate any existing active licence, so
  //     "one active licence per tenant" becomes an invariant? (likely,
  //     and it would make this whole question disappear), or
  //   - if concurrent licences are legitimate, which governs — the most
  //     restrictive, the most recently provisioned, or the one matching
  //     the work being attempted?
  // Until that is settled, the count is logged so the ambiguity is
  // visible rather than silent.
  const activeLicenses = await prisma.license.findMany({
    where: { tenantId, status: "active" },
    orderBy: [{ billingPeriodStart: "desc" }, { licenseId: "asc" }],
  });

  if (activeLicenses.length === 0) {
    return res.json({ allowed: false, reason: "No active license found for this organization." });
  }
  if (activeLicenses.length > 1) {
    console.warn(
      `Tenant ${tenantId} has ${activeLicenses.length} concurrently-active licenses; ` +
        `evaluating against ${activeLicenses[0].licenseId}. See the note in routes/licenses.ts.`,
    );
  }

  res.json(checkLicense(toSharedLicense(activeLicenses[0])));
});

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const licenses = await prisma.license.findMany({
    where: tenantWhere(req),
    orderBy: { billingPeriodStart: "desc" },
  });
  res.json(licenses);
});

router.get("/:licenseId", requireAuth, requireTenantScope, async (req, res) => {
  const license = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });
  if (!license) return res.status(404).json({ error: "License not found" });
  res.json(license);
});

// Billing-level action — tenant_staff (mobile-facing role) has no reason
// to provision licenses, only tenant_admin/master_admin (viewing this
// tenant) do.
router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot provision licenses" });
  }

  const {
    type,
    billingPeriodStart,
    billingPeriodEnd,
    includedQuota,
    overageRatePerInspection,
    seatLimit,
  } = req.body;

  if (!VALID_LICENSE_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LICENSE_TYPES.join(", ")}` });
  }
  if (!billingPeriodStart || !billingPeriodEnd) {
    return res.status(400).json({ error: "billingPeriodStart and billingPeriodEnd are required" });
  }

  const license = await prisma.license.create({
    data: {
      ...tenantWhere(req),
      type,
      status: "active",
      billingPeriodStart: new Date(billingPeriodStart),
      billingPeriodEnd: new Date(billingPeriodEnd),
      includedQuota: includedQuota ?? null,
      usageThisPeriod: 0,
      overageRatePerInspection: overageRatePerInspection ?? null,
      seatLimit: seatLimit ?? null,
      activeSeats: 0,
    },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "license_provisioned",
      targetType: "license",
      targetId: license.licenseId,
      details: `Provisioned ${license.type} license`,
      metadata: { type: license.type, quota: license.includedQuota, seats: license.seatLimit },
    }),
  });

  res.status(201).json(license);
});

// Checked at mobile session start (per CLAUDE.md "Licensing model") —
// exposed here as an explicit endpoint so the mobile app (Sprint 3+) can
// call it before the device-eligibility check, without duplicating
// checkLicense()'s gating logic client-side.
router.post("/:licenseId/check", requireAuth, requireTenantScope, async (req, res) => {
  const license = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });
  if (!license) return res.status(404).json({ error: "License not found" });

  res.json(checkLicense(toSharedLicense(license)));
});

router.post("/:licenseId/consume-seat", requireAuth, requireTenantScope, async (req, res) => {
  const license = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });
  if (!license) return res.status(404).json({ error: "License not found" });

  if (license.type !== "seat_subscription") {
    return res.json(license); // no-op for other plan types, matching consumeSeat() in licensing.ts
  }

  const checkResult = checkLicense(toSharedLicense(license));
  if (!checkResult.allowed) {
    return res.status(409).json({ error: checkResult.reason });
  }

  // Ceiling enforced in the same atomic query, not just the checkLicense()
  // read above — otherwise two concurrent calls can both pass the read-
  // based check and both increment, landing over seatLimit. Mirrors
  // release-seat's activeSeats: { gt: 0 } floor guard below.
  const result = await prisma.license.updateMany({
    where: {
      ...tenantWhere(req),
      licenseId: req.params.licenseId,
      ...(license.seatLimit != null ? { activeSeats: { lt: license.seatLimit } } : {}),
    },
    data: { activeSeats: { increment: 1 } },
  });
  if (result.count === 0) {
    // Distinguish "no longer exists for this tenant" from "hit the seat
    // ceiling between the read above and this write" with a fresh read,
    // rather than trusting the now-stale `license` fetched earlier.
    const current = await prisma.license.findFirst({
      where: { ...tenantWhere(req), licenseId: req.params.licenseId },
    });
    if (!current) return res.status(404).json({ error: "License not found" });
    return res.status(409).json({ error: "All technician seats are in use. Add a seat or wait for one to free up." });
  }

  const updated = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "seat_consumed",
      targetType: "license",
      targetId: req.params.licenseId,
      details: `Seat consumed (${updated!.activeSeats}/${updated!.seatLimit ?? "?"})`,
    }),
  });

  res.json(updated);
});

router.post("/:licenseId/release-seat", requireAuth, requireTenantScope, async (req, res) => {
  const license = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });
  if (!license) return res.status(404).json({ error: "License not found" });

  if (license.type !== "seat_subscription") {
    return res.json(license);
  }

  // Floor at 0 — Prisma's decrement has no built-in clamp, so a stray
  // double-release call can't drive activeSeats negative.
  const result = await prisma.license.updateMany({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId, activeSeats: { gt: 0 } },
    data: { activeSeats: { decrement: 1 } },
  });

  const updated = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });

  if (result.count === 0) {
    // count === 0 means either "no longer exists for this tenant" or
    // "already at floor" — re-check current state (not the now-stale
    // `license` fetched before the write) rather than guessing from a
    // pre-read that a concurrent call may have already invalidated.
    if (!updated) return res.status(404).json({ error: "License not found" });
    return res.json(updated); // already at 0 — legitimate no-op, not an error
  }

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "seat_released",
      targetType: "license",
      targetId: req.params.licenseId,
      details: `Seat released (${updated!.activeSeats}/${updated!.seatLimit ?? "?"})`,
    }),
  });

  res.json(updated);
});

export default router;
