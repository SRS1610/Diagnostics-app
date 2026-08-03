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

  const result = await prisma.license.updateMany({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
    data: { activeSeats: { increment: 1 } },
  });
  if (result.count === 0) return res.status(404).json({ error: "License not found" });

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
  if (result.count === 0 && license.activeSeats > 0) {
    return res.status(404).json({ error: "License not found" });
  }

  const updated = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId: req.params.licenseId },
  });

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
