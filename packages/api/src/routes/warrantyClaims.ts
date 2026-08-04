// src/routes/warrantyClaims.ts
//
// Post-sale claims linked back to the original inspection report
// (warrantyTracking.ts). The WarrantyClaim model existed in
// schema.prisma with no endpoints.
//
// Like ReportRevision and DataWipeCertificate, WarrantyClaim carries no
// tenantId column — it inherits tenancy from its report, so every route
// here resolves the parent report through a tenant-scoped lookup and
// that lookup IS the tenant boundary.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const CLAIM_STATUSES = new Set(["open", "investigating", "approved", "denied", "resolved"]);
const DEFAULT_WARRANTY_DAYS = 90;

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  // Claims join through reports, which is where tenancy lives.
  const claims = await prisma.warrantyClaim.findMany({
    where: { report: tenantWhere(req) },
    orderBy: { submittedAt: "desc" },
    take: 200,
  });
  res.json(claims);
});

router.get("/:claimId", requireAuth, requireTenantScope, async (req, res) => {
  const claim = await prisma.warrantyClaim.findFirst({
    where: { claimId: req.params.claimId, report: tenantWhere(req) },
  });
  if (!claim) return res.status(404).json({ error: "Warranty claim not found" });
  res.json(claim);
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { reportId, claimedIssue, warrantyDays } = req.body ?? {};

  if (typeof reportId !== "string" || !reportId) {
    return res.status(400).json({ error: "reportId is required" });
  }
  if (typeof claimedIssue !== "string" || !claimedIssue) {
    return res.status(400).json({ error: "claimedIssue is required" });
  }
  if (warrantyDays !== undefined && (typeof warrantyDays !== "number" || warrantyDays <= 0)) {
    return res.status(400).json({ error: "warrantyDays must be a positive number when provided" });
  }

  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId },
    select: { reportId: true, serialNumber: true, generatedAt: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  // Expiry is computed from the inspection date rather than accepted
  // from the caller — a client-supplied expiry could extend a warranty
  // arbitrarily, and this record is what a claim is judged against.
  const days = warrantyDays ?? DEFAULT_WARRANTY_DAYS;
  const warrantyExpiresAt = new Date(report.generatedAt.getTime() + days * 24 * 60 * 60 * 1000);

  const claim = await prisma.warrantyClaim.create({
    data: {
      reportId: report.reportId,
      deviceSerial: report.serialNumber,
      claimedIssue,
      warrantyExpiresAt,
      status: "open",
    },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "warranty_claim_filed",
      targetType: "report",
      targetId: report.reportId,
      details: `Warranty claim filed for ${report.serialNumber}: ${claimedIssue}`,
    }),
  });

  // Reported rather than enforced: a claim filed after expiry is still a
  // real event worth recording, and whether to honour it is a commercial
  // decision, not something to silently reject at the API.
  res.status(201).json({
    ...claim,
    withinWarranty: warrantyExpiresAt.getTime() >= Date.now(),
  });
});

router.patch("/:claimId", requireAuth, requireTenantScope, async (req, res) => {
  const { status, resolutionNotes } = req.body ?? {};

  if (status !== undefined && (typeof status !== "string" || !CLAIM_STATUSES.has(status))) {
    return res.status(400).json({ error: `status must be one of: ${[...CLAIM_STATUSES].join(", ")}` });
  }
  if (resolutionNotes !== undefined && typeof resolutionNotes !== "string") {
    return res.status(400).json({ error: "resolutionNotes must be a string" });
  }
  // A terminal decision without a reason is unauditable — same standard
  // as dispute resolution.
  if ((status === "approved" || status === "denied") && !resolutionNotes?.trim()) {
    return res.status(400).json({ error: "resolutionNotes is required when approving or denying a claim" });
  }

  const existing = await prisma.warrantyClaim.findFirst({
    where: { claimId: req.params.claimId, report: tenantWhere(req) },
  });
  if (!existing) return res.status(404).json({ error: "Warranty claim not found" });

  const result = await prisma.warrantyClaim.updateMany({
    where: { claimId: req.params.claimId, report: tenantWhere(req) },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(resolutionNotes !== undefined ? { resolutionNotes } : {}),
    },
  });
  if (result.count === 0) return res.status(404).json({ error: "Warranty claim not found" });

  if (status === "approved" || status === "denied" || status === "resolved") {
    await prisma.activityLogEntry.create({
      data: buildActivityLogData({
        tenantId: req.portalSession!.viewingTenantId,
        actorUserId: req.portalSession!.userId,
        actorRole: req.portalSession!.role,
        action: "warranty_claim_resolved",
        targetType: "report",
        targetId: existing.reportId,
        details: `Warranty claim ${status}: ${resolutionNotes ?? ""}`.trim(),
      }),
    });
  }

  const updated = await prisma.warrantyClaim.findFirst({
    where: { claimId: req.params.claimId, report: tenantWhere(req) },
  });
  res.json(updated);
});

export default router;
