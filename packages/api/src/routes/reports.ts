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
import { Prisma } from "@prisma/client";
import { computeOverallStatus, DiagnosticResult } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { requireTechnicianAuth, technicianTenantWhere } from "../middleware/technicianAuth";
import { mintConsumerToken } from "../lib/consumerToken";
import { parseDate, parseListWindow, parseSearch, setPaginationHeaders } from "../lib/pagination";
import { csvDocument, csvFilename } from "../lib/csv";
import { prisma } from "../lib/prisma";
import { dispatchWebhook } from "../lib/webhooks";

const router = Router();

const CAPTURE_SOURCES = new Set(["barcode", "ocr", "manual"]);
const RESULT_STATUSES = new Set(["pass", "fail", "warning", "skipped"]);
// The report-level rollup, as opposed to a single test's status above.
const OVERALL_STATUSES = new Set(["pass", "fail", "pass_with_warnings"]);
const RESULT_SOURCES = new Set(["api", "manual", "ocr"]);
// Mirrors RoutingDecision in deviceRouting.ts. Validated like every
// other enum on this route rather than accepting any string — a stored
// routing value the portal doesn't recognize would render as a blank or
// broken badge on the report and the Devices tab.
const ROUTING_DECISIONS = new Set(["resale", "repair", "parts_harvest", "recycle", "hold_ineligible"]);

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
    if (
      entry.value !== undefined &&
      entry.value !== null &&
      typeof entry.value !== "string" &&
      typeof entry.value !== "number"
    ) {
      return { ok: false, error: `results[${i}].value must be a string or number when provided` };
    }
    if (entry.notes !== undefined && entry.notes !== null && typeof entry.notes !== "string") {
      return { ok: false, error: `results[${i}].notes must be a string when provided` };
    }
  }

  // Reconstruct each entry from whitelisted keys rather than storing the
  // caller's objects verbatim. This column is the audit record and feeds
  // reportRenderer.ts, which assumes the DiagnosticResult shape — passing
  // parsed input straight through would let arbitrary extra keys, or a
  // deeply nested `value`, ride into the stored report and out into a
  // generated PDF.
  const sanitized: DiagnosticResult[] = (results as Record<string, unknown>[]).map((entry) => ({
    testId: entry.testId as string,
    label: entry.label as string,
    status: entry.status as DiagnosticResult["status"],
    source: entry.source as DiagnosticResult["source"],
    timestamp: entry.timestamp as string,
    ...(entry.value !== undefined && entry.value !== null
      ? { value: entry.value as string | number }
      : {}),
    ...(entry.notes !== undefined && entry.notes !== null ? { notes: entry.notes as string } : {}),
  }));

  return { ok: true, value: sanitized };
}

// ============================================================
// Portal reads
// ============================================================

/**
 * The reports list, which is the only view onto a tenant's inspection
 * history and grows for as long as they keep working. It was capped at
 * the 50 most recent with no way to reach anything older and no way to
 * look anything up — fine for a demo, useless for a warehouse.
 *
 * Search covers the identifiers a person actually has in hand when they
 * come looking: a serial number off a label, an IMEI from a customer, or
 * just the model. Case-insensitive contains rather than exact match,
 * because a half-remembered serial is the normal case.
 */
router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const { limit, offset } = parseListWindow(req);
  const search = parseSearch(req.query.q);
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const where: Prisma.ReportWhereInput = { ...tenantWhere(req) };

  if (search) {
    where.OR = [
      { serialNumber: { contains: search, mode: "insensitive" } },
      { imei: { contains: search, mode: "insensitive" } },
      { imei2: { contains: search, mode: "insensitive" } },
      { deviceModel: { contains: search, mode: "insensitive" } },
      { deviceMake: { contains: search, mode: "insensitive" } },
    ];
  }

  // Validated against the known set rather than passed through: an
  // unrecognised status would silently match nothing, which reads as
  // "this tenant has no failed inspections" — a false statement.
  if (typeof req.query.status === "string" && req.query.status) {
    if (!OVERALL_STATUSES.has(req.query.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...OVERALL_STATUSES].join(", ")}` });
    }
    where.overallStatus = req.query.status;
  }
  if (typeof req.query.routing === "string" && req.query.routing) {
    if (!ROUTING_DECISIONS.has(req.query.routing)) {
      return res.status(400).json({ error: `routing must be one of: ${[...ROUTING_DECISIONS].join(", ")}` });
    }
    where.routing = req.query.routing;
  }
  if (from || to) {
    where.generatedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  // Count and page in one round trip. The count is of everything
  // MATCHING, not of the page, so the caller can tell whether there is
  // more to fetch.
  const [total, reports] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { generatedAt: "desc" },
      take: limit,
      skip: offset,
      // Explicit field list, and consumerToken is deliberately not on it.
      // Each token is a capability that lets its bearer act on a
      // customer's offer; the list view has no use for them, and
      // returning fifty in one response puts fifty live credentials into
      // every dashboard load, browser cache and proxy log for no benefit.
      // The detail route below returns the single one a member of staff
      // actually needs to hand over.
      select: {
        reportId: true,
        tenantId: true,
        profileId: true,
        technicianId: true,
        generatedAt: true,
        deviceMake: true,
        deviceModel: true,
        serialNumber: true,
        imei: true,
        imei2: true,
        captureSource: true,
        results: true,
        overallStatus: true,
        routing: true,
        offerDeclinedAt: true,
      },
    }),
  ]);

  setPaginationHeaders(res, { total, limit, offset });
  res.json(reports);
});

/**
 * CSV export of the inspection list.
 *
 * MOUNTED BEFORE /:reportId deliberately — Express matches in
 * declaration order, so with this below, a request for "export.csv"
 * would be read as a report whose id is "export.csv" and 404.
 *
 * Honours the same filters as the list, so what you export is what you
 * were looking at rather than an unrelated dump. Capped: an export is a
 * convenience, not a bulk-extraction channel, and building an unbounded
 * string in memory is how a large tenant takes the process down.
 *
 * consumerToken is NOT a column. Each one lets its bearer act on a
 * customer's offer, and a spreadsheet is the single most forwarded,
 * least controlled artefact this system produces.
 */
router.get("/export.csv", requireAuth, requireTenantScope, async (req, res) => {
  const search = parseSearch(req.query.q);
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const where: Prisma.ReportWhereInput = { ...tenantWhere(req) };
  if (search) {
    where.OR = [
      { serialNumber: { contains: search, mode: "insensitive" } },
      { imei: { contains: search, mode: "insensitive" } },
      { deviceModel: { contains: search, mode: "insensitive" } },
      { deviceMake: { contains: search, mode: "insensitive" } },
    ];
  }
  if (typeof req.query.status === "string" && req.query.status) {
    if (!OVERALL_STATUSES.has(req.query.status)) {
      return res.status(400).json({ error: `status must be one of: ${[...OVERALL_STATUSES].join(", ")}` });
    }
    where.overallStatus = req.query.status;
  }
  if (from || to) {
    where.generatedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const EXPORT_LIMIT = 5000;
  const [total, reports] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: { generatedAt: "desc" },
      take: EXPORT_LIMIT,
      select: {
        reportId: true,
        generatedAt: true,
        deviceMake: true,
        deviceModel: true,
        serialNumber: true,
        imei: true,
        imei2: true,
        captureSource: true,
        overallStatus: true,
        routing: true,
        results: true,
        technician: { select: { displayName: true } },
        profile: { select: { customerName: true } },
      },
    }),
  ]);

  const rows = reports.map((r) => {
    const results = Array.isArray(r.results) ? (r.results as Array<{ status?: string }>) : [];
    return [
      r.reportId,
      r.generatedAt,
      r.deviceMake,
      r.deviceModel,
      r.serialNumber,
      r.imei,
      r.imei2 ?? "",
      r.captureSource,
      r.overallStatus,
      r.routing ?? "",
      r.technician?.displayName ?? "",
      r.profile?.customerName ?? "",
      results.length,
      results.filter((t) => t.status === "pass").length,
      results.filter((t) => t.status === "fail" || t.status === "warning").length,
    ];
  });

  // Truncation is stated IN the file, not just in a header nobody looks
  // at — a spreadsheet that silently stops at 5,000 rows will be treated
  // as complete by whoever opens it.
  if (total > EXPORT_LIMIT) {
    rows.push([]);
    rows.push([
      `TRUNCATED: ${total} inspections matched, ${EXPORT_LIMIT} exported (most recent first). Narrow the date range to export the rest.`,
    ]);
  }

  res.type("text/csv").attachment(csvFilename("inspections", new Date()));
  res.send(
    csvDocument(
      [
        "Report ID",
        "Inspected at",
        "Make",
        "Model",
        "Serial number",
        "IMEI",
        "IMEI 2",
        "Capture source",
        "Outcome",
        "Routing",
        "Technician",
        "Profile",
        "Tests run",
        "Tests passed",
        "Tests flagged",
      ],
      rows,
    ),
  );
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

  if (routing !== undefined && routing !== null) {
    if (typeof routing !== "string" || !ROUTING_DECISIONS.has(routing)) {
      return res.status(400).json({
        error: `routing must be one of: ${[...ROUTING_DECISIONS].join(", ")}`,
      });
    }
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

  let report;
  try {
    report = await prisma.report.create({
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
        // Minted server-side, at creation, so a consumer link exists for
        // every report without a later backfill step that could be
        // skipped. Never derived from reportId or anything else a caller
        // can see: this token IS the authorisation for the public
        // tracker, so guessing one must be as hard as guessing a key.
        consumerToken: mintConsumerToken(),
      },
    });
  } catch (e) {
    // P2003 = foreign key violation. Reachable without any adversary:
    // a technician session token stays cryptographically valid for its
    // full TTL, so an admin removing that technician from the roster
    // (or deleting the profile) between login and submission lands here.
    // Treated as a revoked session rather than a server fault — the
    // token references a row that no longer exists, and the technician
    // needs to re-authenticate.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
      return res.status(401).json({
        error: "Session is no longer valid — the technician or profile no longer exists. Log in again.",
      });
    }
    // P2002 on consumerToken. With 256 bits of CSPRNG output this should
    // never happen, and that is exactly why it is worth handling rather
    // than trusting: if it ever does fire, the cause is a broken entropy
    // source, and losing a completed inspection to an unexplained 500
    // would be the worst way to find out. One retry, then surface it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      report = await prisma.report.create({
        data: {
          ...tenantFilter,
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
          consumerToken: mintConsumerToken(),
        },
      });
    } else {
      throw e;
    }
  }

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
  //
  // Wrapped separately from the create above: the report is already
  // durably persisted at this point, so a failure here must not stop the
  // technician getting their 201. Losing completed inspection work to a
  // billing-bookkeeping error is strictly the worse outcome; an
  // under-counted credit is recoverable from the report rows themselves.
  try {
    await prisma.license.updateMany({
      where: {
        ...tenantFilter,
        status: "active",
        type: { in: ["per_inspection", "tiered_subscription"] },
      },
      data: { usageThisPeriod: { increment: 1 } },
    });
  } catch (e) {
    console.error(`License usage increment failed for report ${report.reportId}:`, e);
  }

  // Fire-and-forget, deliberately not awaited: a tenant's webhook
  // receiver being slow or down must never add latency to — or, worse,
  // ever be able to fail — a technician's report submission. See
  // lib/webhooks.ts for why this has no retry and how failures are
  // still made visible (WebhookDelivery rows, not a swallowed error).
  void dispatchWebhook(tenantFilter.tenantId, "report.created", {
    reportId: report.reportId,
    deviceMake: report.deviceMake,
    deviceModel: report.deviceModel,
    overallStatus: report.overallStatus,
  }).catch((e) => console.error(`Webhook dispatch failed for report ${report.reportId}:`, e));

  res.status(201).json(report);
});

export default router;
