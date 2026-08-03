// src/routes/reportArtifacts.ts
//
// Sub-resources hanging off a report: revisions (testSession.ts) and the
// certified data-wipe certificate (dataWipe.ts). Both models existed in
// schema.prisma with no endpoints, so neither could be created.
//
// Mounted under /reports, and every route resolves the parent report
// through a tenant-scoped lookup FIRST. That check is the tenant
// boundary for these resources — ReportRevision and DataWipeCertificate
// carry no tenantId of their own, they inherit it from the report, so
// writing one without confirming the parent belongs to the caller would
// let a technician attach a revision or an erasure attestation to
// another tenant's report.

import { Router } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { requireTechnicianAuth, technicianTenantWhere } from "../middleware/technicianAuth";
import { buildActivityLogData } from "../lib/activityLog";

const router = Router({ mergeParams: true });
const prisma = new PrismaClient();

const WIPE_STANDARDS = new Set(["nist_800_88_clear", "nist_800_88_purge"]);

// ============================================================
// Revisions
// ============================================================

router.get("/:reportId/revisions", requireAuth, requireTenantScope, async (req, res) => {
  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId: req.params.reportId },
    select: { reportId: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  const revisions = await prisma.reportRevision.findMany({
    where: { reportId: report.reportId },
    orderBy: { revisionNumber: "asc" },
  });
  res.json(revisions);
});

/**
 * CLAUDE.md, resolved decision 1: "a same-session correction keeps the
 * SAME reportId, tracked as a revision (displayed as DDA-0217-R1, -R2)
 * rather than becoming a new report." So this appends a revision to an
 * existing report; it never mints a new one.
 *
 * Written by the mobile app (technician auth), since a redo happens
 * during an inspection, not from the portal.
 */
router.post("/:reportId/revisions", requireTechnicianAuth, async (req, res) => {
  const { testIdsRedone, reason } = req.body ?? {};

  if (!Array.isArray(testIdsRedone) || testIdsRedone.length === 0) {
    return res.status(400).json({ error: "testIdsRedone must be a non-empty array" });
  }
  if (!testIdsRedone.every((t) => typeof t === "string" && t)) {
    return res.status(400).json({ error: "testIdsRedone must contain only non-empty strings" });
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return res.status(400).json({ error: "reason must be a string when provided" });
  }

  const tenantFilter = technicianTenantWhere(req);
  const report = await prisma.report.findFirst({
    where: { ...tenantFilter, reportId: req.params.reportId },
    select: { reportId: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  // Revision numbers are per-report and must be gapless, so the count
  // and the insert run in one transaction — two concurrent redos would
  // otherwise both read the same count and produce duplicate R2s.
  const revision = await prisma.$transaction(async (tx) => {
    const existing = await tx.reportRevision.count({ where: { reportId: report.reportId } });
    return tx.reportRevision.create({
      data: {
        reportId: report.reportId,
        revisionNumber: existing + 1,
        revisedByTechnicianId: req.technicianSession!.technicianId,
        testIdsRedone,
        reason: reason ?? null,
      },
    });
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: tenantFilter.tenantId,
      actorUserId: req.technicianSession!.technicianId,
      actorRole: "tenant_staff",
      action: "report_revision_created",
      targetType: "report",
      targetId: `${report.reportId}-R${revision.revisionNumber}`,
      details: `Revision R${revision.revisionNumber}: redid ${testIdsRedone.length} test(s)`,
      metadata: { testIdsRedone, reason: reason ?? undefined },
    }),
  });

  res.status(201).json(revision);
});

// ============================================================
// Data wipe certificate
// ============================================================

router.get("/:reportId/wipe-certificate", requireAuth, requireTenantScope, async (req, res) => {
  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId: req.params.reportId },
    select: { reportId: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  const certificate = await prisma.dataWipeCertificate.findUnique({
    where: { reportId: report.reportId },
  });
  if (!certificate) return res.status(404).json({ error: "No wipe certificate for this report" });
  res.json(certificate);
});

/**
 * CLAUDE.md: the certificate is "an attestation for liability/compliance
 * reasons if personal data on a resold device ever becomes a dispute" —
 * so it records what actually happened, including a FAILED wipe.
 * `passed: false` is a legitimate, meaningful certificate, not an error
 * case: a failed erasure that goes unrecorded is exactly the situation
 * the attestation exists to prevent.
 */
router.post("/:reportId/wipe-certificate", requireTechnicianAuth, async (req, res) => {
  const { standard, passed } = req.body ?? {};

  if (typeof standard !== "string" || !WIPE_STANDARDS.has(standard)) {
    return res.status(400).json({ error: `standard must be one of: ${[...WIPE_STANDARDS].join(", ")}` });
  }
  if (typeof passed !== "boolean") {
    // Not defaulted: a certificate whose outcome was never stated is
    // worse than no certificate, and defaulting either way would be a
    // claim nobody made.
    return res.status(400).json({ error: "passed must be explicitly true or false" });
  }

  const tenantFilter = technicianTenantWhere(req);
  const report = await prisma.report.findFirst({
    where: { ...tenantFilter, reportId: req.params.reportId },
    select: { reportId: true, serialNumber: true, imei: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  let certificate;
  try {
    certificate = await prisma.dataWipeCertificate.create({
      data: {
        reportId: report.reportId,
        deviceSerial: report.serialNumber,
        imei: report.imei,
        standard,
        verifiedByTechnicianId: req.technicianSession!.technicianId,
        passed,
      },
    });
  } catch (e) {
    // reportId is unique on this table — one certificate per report. A
    // second attempt is a conflict rather than a silent overwrite,
    // because replacing an erasure attestation would destroy the record
    // of what was originally certified.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "This report already has a wipe certificate" });
    }
    throw e;
  }

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: tenantFilter.tenantId,
      actorUserId: req.technicianSession!.technicianId,
      actorRole: "tenant_staff",
      action: "data_wipe_certified",
      targetType: "report",
      targetId: report.reportId,
      details: `${standard} wipe ${passed ? "passed" : "FAILED"} for ${report.serialNumber}`,
    }),
  });

  res.status(201).json(certificate);
});

export default router;
