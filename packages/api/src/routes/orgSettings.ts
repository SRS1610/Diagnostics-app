// src/routes/orgSettings.ts — the tenant admin's own settings.
//
// Distinct from routes/tenants.ts, which is master-console-only
// (requireMasterConsole — provisioning, suspend/activate across the
// whole platform). This is the opposite direction: a tenant managing
// its OWN configuration, tenant-scoped the same way profiles or
// technicians are.
//
// Both settings here are ENFORCED elsewhere, not just stored:
//   minPinLength     -> read by profiles.ts's PIN validation
//   requirePurgeWipe -> read by reportArtifacts.ts's wipe-cert validation
// A settings page that saves a value nothing reads is worse than no
// settings page — CLAUDE.md's own words about the read-only stub this
// replaces ("a form that appears to save but doesn't"). These are real.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const MIN_PIN_LENGTH_FLOOR = 4;
const MIN_PIN_LENGTH_CEILING = 6; // matches profiles.ts's absolute PIN length cap

const PUBLIC_FIELDS = {
  tenantId: true,
  companyName: true,
  primaryContactEmail: true,
  minPinLength: true,
  requirePurgeWipe: true,
} as const;

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const tenant = await prisma.tenant.findFirst({
    where: { tenantId: req.portalSession!.viewingTenantId! },
    select: PUBLIC_FIELDS,
  });
  // Not reachable in practice — requireTenantScope already guarantees a
  // viewingTenantId that came from a real session — but a tenant row
  // that vanished between token issue and this request is a real
  // failure mode worth a clean 404 rather than a thrown TypeError below.
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });
  res.json(tenant);
});

router.patch("/", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot change organisation settings" });
  }

  const { companyName, minPinLength, requirePurgeWipe } = (req.body ?? {}) as Record<string, unknown>;
  const data: Prisma.TenantUpdateManyMutationInput = {};
  const changes: string[] = [];

  if (companyName !== undefined) {
    if (typeof companyName !== "string" || !companyName.trim()) {
      return res.status(400).json({ error: "companyName must be a non-empty string" });
    }
    data.companyName = companyName.trim();
    changes.push("company name");
  }

  if (minPinLength !== undefined) {
    if (
      typeof minPinLength !== "number" ||
      !Number.isInteger(minPinLength) ||
      minPinLength < MIN_PIN_LENGTH_FLOOR ||
      minPinLength > MIN_PIN_LENGTH_CEILING
    ) {
      return res.status(400).json({
        error: `minPinLength must be an integer between ${MIN_PIN_LENGTH_FLOOR} and ${MIN_PIN_LENGTH_CEILING}`,
      });
    }
    data.minPinLength = minPinLength;
    changes.push(`minimum PIN length to ${minPinLength}`);
    // Deliberately NOT retroactive: existing profiles keep whatever PIN
    // they were created with. Raising the floor changes what a NEW or
    // EDITED profile can be assigned, not a promise about profiles
    // already in the field — rewriting someone's PIN out from under them
    // because an admin changed a setting would be a surprise outage for
    // whichever technician has it memorised.
  }

  if (requirePurgeWipe !== undefined) {
    if (typeof requirePurgeWipe !== "boolean") {
      return res.status(400).json({ error: "requirePurgeWipe must be a boolean" });
    }
    data.requirePurgeWipe = requirePurgeWipe;
    changes.push(requirePurgeWipe ? "now requiring Purge-standard wipes" : "no longer requiring Purge-standard wipes");
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "Nothing to update" });
  }

  await prisma.tenant.updateMany({
    where: { tenantId: req.portalSession!.viewingTenantId! },
    data,
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "settings_updated",
      targetType: "tenant",
      targetId: req.portalSession!.viewingTenantId!,
      details: `Updated ${changes.join(", ")}`,
    }),
  });

  const updated = await prisma.tenant.findFirst({
    where: { tenantId: req.portalSession!.viewingTenantId! },
    select: PUBLIC_FIELDS,
  });
  res.json(updated);
});

export default router;
