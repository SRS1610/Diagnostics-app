// src/routes/reports.ts
//
// Reference implementation of a correctly tenant-scoped route — every
// other tenant-scoped resource (devices, profiles, disputes, etc.)
// should follow this exact pattern: requireAuth, requireTenantScope,
// then filter every Prisma query with tenantWhere(req).
//
// TWO CLIENTS, TWO AUTH MODELS. The GET routes serve the web portal
// (requireAuth + requireTenantScope). POST / serves the MOBILE app,
// which has no portal session — it authenticates with the technician
// session token issued at badge login (requireTechnicianAuth) and its
// tenantId comes from that token, never from the request body. See
// middleware/technicianAuth.ts for why a write needs that when the
// read-only mobile lookups didn't.

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { computeOverallStatus, DiagnosticResult } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { requireTechnicianAuth, technicianTenantWhere } from "../middleware/technicianAuth";

const router = Router();
const prisma = new PrismaClient();

const CAPTURE_SOURCES = new Set(["barcode", "ocr", "manual"]);
const RESULT_STATUSES = new Set(["pass", "fail", "warning", "skipped"]);
const RESULT_SOURCES = new Set(["api", "manual", "ocr"]);

/**
 * CLAUDE.md: "IMEI is always 15 digits — validate format after capture."
 * Enforced here as well as in the app because the app-side check is a
 * UX affordance, not a guarantee — this is the boundary that actually
 * protects the stored audit record.
 *
 * Deliberately NOT also enforcing the IMEI Luhn check digit, even though
 * real IMEIs carry one: a Luhn failure most often means an OCR misread
 * (CLAUDE.md calls out 0/O and 1/I confusion as common), and the
 * designed remedy for that is the technician confirmation step, not a
 * hard API rejection that would strand a session on a device whose
 * printed label is genuinely worn or nonstandard. Worth revisiting as a
 * soft warning surfaced at the confirm screen.
 */
function isValidImei(value: unknown): value is string {
  return typeof value === "string" && /^\d{15}$/.test(value);
}

function validateResults(results: unknown): { ok: true; value: DiagnosticResult[] } | { ok: false; error: string } {
  if (!Array.isArray(results)) return { ok: false, error: "results must be an array" };

  for (const [i, r] of results.entries()) {
    if (typeof r !== "object" || r === null) return { ok: false, error: `results[${i}] must be an object` };
    const entry = r as Record<string, unknown>;
    if (typeof entry.testId !== "string" || !entry.testId) {
      return { ok: false, error: `results[${i}].testId is required` };
    }
    if (typeof entry.label !== "string" || !entry.label) {
      return { ok: false, error: `results[${i}].label is required` };
    }
    if (typeof entry.status !== "string" || !RESULT_STATUSES.has(entry.status)) {
      return { ok: false, error: `results[${i}].status must be one of: pass, fail, warning, skipped` };
    }
    if (typeof entry.source !== "string" || !RESULT_SOURCES.has(entry.source)) {
      return { ok: false, error: `results[${i}].source must be one of: api, manual, ocr` };
    }
    if (typeof entry.timestamp !== "string" || !entry.timestamp) {
      return { ok: false, error: `results[${i}].timestamp is required` };
    }
    // Duplicate testIds would make the report's own summary counts
    // disagree with its detail table, and testSession.ts's redo logic
    // assumes one entry per testId (applyRedoneResults filters by it).
    const duplicate = results.findIndex((other, j) => j < i && (other as Record<string, unknown>).testId === entry.testId);
    if (duplicate !== -1) {
      return { ok: false, error: `results contains duplicate testId "${entry.testId}"` };
    }
  }

  return { ok: true, value: results as DiagnosticResult[] };
}

// ============================================================
// Portal reads
// ============================================================

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const reports = await prisma.report.findMany({
    where: tenantWhere(req), // NEVER query without this — see tenantScope.ts
    orderBy: { generatedAt: "desc" },
    take: 50,
  });
  res.json(reports);
});

router.get("/:reportId", requireAuth, requireTenantScope, async (req, res) => {
  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId: req.params.reportId }, // tenantWhere FIRST —
    // a report ID guess from another tenant must still 404, not leak data
    include: { revisions: true, wipeCertificate: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });
  res.json(report);
});

// ============================================================
// Mobile write — the Sprint 4 keystone
// ============================================================

router.post("/", requireTechnicianAuth, async (req, res) => {
  const { device, results, routing, profileId } = req.body ?? {};

  if (typeof device !== "object" || device === null) {
    return res.status(400).json({ error: "device is required" });
  }
  const { make, model, serialNumber, imei, imei2, captureSource } = device as Record<string, unknown>;

  if (typeof make !== "string" || !make) return res.status(400).json({ error: "device.make is required" });
  if (typeof model !== "string" || !model) return res.status(400).json({ error: "device.model is required" });
  if (typeof serialNumber !== "string" || !serialNumber) {
    // Devices tab groups by serialNumber (CLAUDE.md), so a blank one
    // would silently collapse unrelated devices into one history.
    return res.status(400).json({ error: "device.serialNumber is required" });
  }
  if (!isValidImei(imei)) return res.status(400).json({ error: "device.imei must be exactly 15 digits" });
  if (imei2 !== undefined && imei2 !== null && !isValidImei(imei2)) {
    return res.status(400).json({ error: "device.imei2 must be exactly 15 digits when provided" });
  }
  if (typeof captureSource !== "string" || !CAPTURE_SOURCES.has(captureSource)) {
    return res.status(400).json({ error: "device.captureSource must be one of: barcode, ocr, manual" });
  }

  const validated = validateResults(results);
  if (!validated.ok) return res.status(400).json({ error: validated.error });

  if (routing !== undefined && routing !== null && typeof routing !== "string") {
    return res.status(400).json({ error: "routing must be a string when provided" });
  }

  const tenantFilter = technicianTenantWhere(req);

  // A profileId from the request body is caller-supplied, so it gets the
  // same treatment as any ID crossing a tenant boundary: confirm it
  // belongs to THIS tenant before attaching it, or a technician could
  // link their report to another tenant's profile.
  if (profileId !== undefined && profileId !== null) {
    if (typeof profileId !== "string") return res.status(400).json({ error: "profileId must be a string" });
    const profile = await prisma.customerProfile.findFirst({
      where: { ...tenantFilter, profileId },
      select: { profileId: true },
    });
    if (!profile) return res.status(404).json({ error: "Profile not found" });
  }

  const report = await prisma.report.create({
    data: {
      ...tenantFilter, // from the token, never the body
      profileId: (profileId as string | undefined) ?? null,
      technicianId: req.technicianSession!.technicianId,
      deviceMake: make,
      deviceModel: model,
      serialNumber,
      imei,
      imei2: (imei2 as string | undefined) ?? null,
      captureSource,
      results: validated.value as unknown as object[],
      overallStatus: computeOverallStatus(validated.value),
      routing: (routing as string | undefined) ?? null,
    },
  });

  // licensing.ts: "Call once per COMPLETED session (report generated),
  // not per test — a session that's abandoned partway through shouldn't
  // consume a credit." A report existing is exactly that completion
  // signal, so usage is recorded here rather than at session start.
  //
  // Metered plans only (per_inspection/tiered_subscription); the
  // updateMany no-ops for seat/enterprise plans. Deliberately NOT
  // failing the request if this finds no active license: the report is
  // already persisted and is an audit record, so refusing to return it
  // would lose inspection work over a billing bookkeeping miss. The
  // licence gate that actually blocks unlicensed work runs at session
  // start (mobile Step 3).
  await prisma.license.updateMany({
    where: {
      ...tenantFilter,
      status: "active",
      type: { in: ["per_inspection", "tiered_subscription"] },
    },
    data: { usageThisPeriod: { increment: 1 } },
  });

  res.status(201).json(report);
});

export default router;
