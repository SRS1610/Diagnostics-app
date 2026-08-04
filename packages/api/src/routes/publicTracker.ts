// src/routes/publicTracker.ts
//
// THE ONLY UNAUTHENTICATED ROUTES IN THIS API THAT READ TENANT DATA.
// Everything else in packages/api/src/routes carries either a portal
// session (requireAuth + requireTenantScope) or a technician session.
// This file has neither, so the rules it follows are different and worth
// stating rather than inferring:
//
//  1. AUTHORISATION IS THE TOKEN. Every route resolves exactly one
//     report by its consumerToken (unique index, exact match). If the
//     token doesn't resolve, the answer is 404 — never a list, never a
//     search, never a partial match.
//
//  2. THE TENANT COMES FROM THE REPORT, NEVER THE CALLER. No route here
//     reads a tenantId, profileId or reportId from the request. This is
//     the same rule as tenantWhere() elsewhere, arrived at from the
//     other direction: instead of filtering by the session's tenant, we
//     derive the tenant from the one row the token unlocks, and scope
//     every subsequent query to it. A caller cannot name a row.
//
//  3. THE RESPONSE IS A WHITELIST, NOT THE ROW. buildTrackerView() names
//     each field it emits. Returning the Prisma object and deleting the
//     private fields would be a leak waiting on the next schema change —
//     a new column would become public by default. Here a new column is
//     private by default.
//
// WHAT IS DELIBERATELY NOT SHOWN, per CLAUDE.md's "public version should
// show device identity + grade + pass summary, NOT the full technician
// notes, redo history, or raw cosmetic photos": per-test notes,
// technician identity, revision/redo history, cosmetic photo URLs,
// internal routing decisions, and the tenant's own ids.
//
// ONE DELIBERATE DEVIATION, flagged rather than made silently: serial
// and IMEI are shown MASKED (last four digits) rather than in full.
// CLAUDE.md says the public view shows "device identity", and this still
// answers the only question a holder of the link needs answered — "is
// this my device?" — but a full IMEI on an unauthenticated URL is not
// the same risk as one on a logged-in page. The link travels on a
// printed PDF and in a QR code that stays with the device through
// resale; a full IMEI is exactly the identifier used for blacklist and
// activation-lock lookups, and CLAUDE.md itself says to treat IMEI and
// serial as sensitive. If the business needs the full value exposed
// publicly, that should be a decision someone makes on purpose.

import { Router } from "express";
import { Prisma, PrismaClient } from "@prisma/client";
import rateLimit from "express-rate-limit";
import { looksLikeConsumerToken } from "../lib/consumerToken";

const router = Router();
const prisma = new PrismaClient();

// Unauthenticated and internet-facing. The token is 256 bits so
// enumeration isn't the threat this addresses — it's the cost of an
// unauthenticated database lookup per request, and of scripted abuse of
// the write routes (dispute spam in particular).
const publicReadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PUBLIC_TRACKER_RATE_LIMIT ?? 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

// Writes get a much tighter budget than reads: each one creates or
// changes a record a tenant then has to deal with.
const publicWriteRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PUBLIC_TRACKER_WRITE_RATE_LIMIT ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

const PAYOUT_METHODS = new Set(["store_credit", "ach", "paypal", "gift_card"]);
const SEED_SOURCE = "unverified_seed_data";
const OPEN_DISPUTE = "awaiting_review";

/** Shows enough to confirm ownership, not enough to be useful to anyone
 *  else. An empty or short value is emitted as null rather than as a
 *  misleading "••••". */
function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 4) return null;
  return `••••${trimmed.slice(-4)}`;
}

interface ResultRow {
  status?: string;
}

/** deductions is stored as Json. Re-projected field by field rather than
 *  passed through, for the same reason as everything else here: whatever
 *  ends up in that column must not become public by default.
 *
 *  `reason` is publishable because of where it comes from, not because
 *  of anything checked here: computeTradeInQuote() builds it from a
 *  test's LABEL, and POST /quotes never accepts deductions from a
 *  request body. If either changes, this projection is the place that
 *  would start publishing whatever replaced it. */
function toDeductions(value: unknown): Array<{ reason: string; amount: number }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((d): d is { reason: string; amount: number } =>
      Boolean(d) && typeof (d as { reason?: unknown }).reason === "string" && typeof (d as { amount?: unknown }).amount === "number",
    )
    .map((d) => ({ reason: d.reason, amount: d.amount }));
}

function countResults(results: unknown): { total: number; passed: number; flagged: number; skipped: number } {
  const rows: ResultRow[] = Array.isArray(results) ? (results as ResultRow[]) : [];
  let passed = 0;
  let flagged = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row?.status === "pass") passed += 1;
    else if (row?.status === "fail" || row?.status === "warning") flagged += 1;
    else if (row?.status === "skipped") skipped += 1;
  }
  return { total: rows.length, passed, flagged, skipped };
}

type LoadedReport = Prisma.ReportGetPayload<{
  include: {
    quote: { include: { payout: true } };
    wipeCertificate: true;
  };
}>;

/**
 * Resolves the token to exactly one report, or null. Every route starts
 * here; nothing else in this file touches the report table by id.
 */
async function loadByToken(token: unknown): Promise<LoadedReport | null> {
  if (!looksLikeConsumerToken(token)) return null;
  return prisma.report.findUnique({
    where: { consumerToken: token },
    include: { quote: { include: { payout: true } }, wipeCertificate: true },
  });
}

/**
 * The whitelist. Every field the public sees is named here.
 */
async function buildTrackerView(report: LoadedReport) {
  const counts = countResults(report.results);

  // Scoped by the report's OWN tenant and reportId — derived from the
  // token, never from anything the caller sent.
  const openDispute = await prisma.dispute.findFirst({
    where: { tenantId: report.tenantId, reportId: report.reportId, status: OPEN_DISPUTE },
    select: { disputeId: true, submittedAt: true, disputingItem: true },
  });

  const quote = report.quote;
  const deductions = quote ? toDeductions(quote.deductions) : [];
  const deductionTotal = deductions.reduce((sum, d) => sum + d.amount, 0);
  // A quote computed from the illustrative seed price table is not a
  // number anyone should be shown, let alone offered. The portal already
  // refuses to let one be accepted; showing it here would put a figure
  // in a customer's head that the business cannot honour.
  const offerIsShowable = Boolean(quote) && quote!.priceSource !== SEED_SOURCE;
  const expired = Boolean(quote) && quote!.expiresAt.getTime() < Date.now();

  return {
    device: {
      make: report.deviceMake,
      model: report.deviceModel,
      // Masked — see the file header for why this differs from the
      // logged-in view.
      serialNumberMasked: maskIdentifier(report.serialNumber),
      imeiMasked: maskIdentifier(report.imei),
    },
    inspection: {
      inspectedAt: report.generatedAt,
      overallStatus: report.overallStatus,
      testsRun: counts.total,
      testsPassed: counts.passed,
      testsFlagged: counts.flagged,
      testsSkipped: counts.skipped,
    },
    // Present only once a wipe has actually been certified AND passed.
    // A failed wipe is not an erasure attestation, and showing one as if
    // it were is the exact liability this certificate exists to avoid.
    // Absence is reported as absence, not as a pending state we have no
    // evidence for.
    dataErasure:
      report.wipeCertificate && report.wipeCertificate.passed
        ? {
            wipedAt: report.wipeCertificate.wipedAt,
            standard: report.wipeCertificate.standard,
            certificateId: report.wipeCertificate.certificateId,
          }
        : null,
    offer: quote
      ? {
          grade: quote.grade,
          // null rather than 0 when the price behind it isn't real —
          // a zero would read as "your phone is worth nothing".
          amount: offerIsShowable ? quote.finalOffer : null,
          // The breakdown behind the number. Withholding it while
          // showing the total is the shape that generates disputes:
          // a customer told "£412" with no reason has nothing to check.
          // Safe to publish — each deduction's `reason` is a test LABEL
          // ("Battery Health"), never a technician's free-text note.
          basePrice: offerIsShowable ? quote.basePrice : null,
          deductions: offerIsShowable ? deductions : [],
          // An offer is floored at zero (computeTradeInQuote does
          // Math.max(0, ...)), so on a heavily damaged device the
          // deductions can exceed the base price. Without saying so, the
          // breakdown shown to the customer does not add up — base 60,
          // deductions 100, total 0 — and a customer checking the
          // arithmetic at the moment they decide whether to accept money
          // finds it wrong. Flagged so the UI can show the floor as its
          // own line rather than silently swallowing the difference.
          deductionsCappedBy:
            offerIsShowable && deductionTotal > quote.basePrice
              ? Math.round((deductionTotal - quote.basePrice) * 100) / 100
              : 0,
          currency: quote.currency,
          expiresAt: quote.expiresAt,
          expired,
          accepted: quote.accepted,
          acceptedAt: quote.acceptedAt,
          declinedAt: report.offerDeclinedAt,
          unavailableReason: offerIsShowable
            ? null
            : "This offer is awaiting confirmed pricing and can't be shown or accepted yet.",
          payout: quote.payout
            ? {
                method: quote.payout.method,
                status: quote.payout.status,
                initiatedAt: quote.payout.initiatedAt,
                completedAt: quote.payout.completedAt,
                // Honest about what a payout record is at this stage.
                note: "Payment processing is not yet connected; this records your chosen method.",
              }
            : null,
        }
      : null,
    dispute: openDispute
      ? { status: OPEN_DISPUTE, submittedAt: openDispute.submittedAt, disputingItem: openDispute.disputingItem }
      : null,
    // The customer-facing consequence of an open dispute, stated where
    // they will see it rather than only enforced at the endpoints.
    onHold: Boolean(openDispute),
  };
}

// ============================================================
// Read
// ============================================================

router.get("/:token", publicReadRateLimit, async (req, res) => {
  const report = await loadByToken(req.params.token);
  if (!report) return res.status(404).json({ error: "This link is not valid." });
  res.json(await buildTrackerView(report));
});

// ============================================================
// Offer: accept / decline
// ============================================================

router.post("/:token/offer/accept", publicWriteRateLimit, async (req, res) => {
  const report = await loadByToken(req.params.token);
  if (!report) return res.status(404).json({ error: "This link is not valid." });

  const quote = report.quote;
  if (!quote) return res.status(409).json({ error: "There is no offer on this device yet." });
  if (quote.accepted) return res.status(409).json({ error: "This offer has already been accepted." });
  if (report.offerDeclinedAt) {
    return res.status(409).json({ error: "This offer was declined. Contact the store to reopen it." });
  }
  if (quote.expiresAt.getTime() < Date.now()) {
    return res.status(409).json({ error: "This offer has expired. Contact the store for a new one." });
  }
  // Same three gates the portal-side accept enforces, re-checked here
  // because this is a second door into the same state change and a gate
  // on one door only is not a gate.
  if (quote.priceSource === SEED_SOURCE) {
    return res.status(409).json({ error: "This offer is awaiting confirmed pricing and can't be accepted yet." });
  }
  const openDispute = await prisma.dispute.findFirst({
    where: { tenantId: report.tenantId, reportId: report.reportId, status: OPEN_DISPUTE },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "Your review request is open; the offer is on hold until it's resolved." });
  }

  // Conditional update: two taps on a slow connection must not produce
  // two acceptances.
  const result = await prisma.tradeInQuote.updateMany({
    where: { quoteId: quote.quoteId, tenantId: report.tenantId, accepted: false },
    data: { accepted: true, acceptedAt: new Date() },
  });
  if (result.count === 0) return res.status(409).json({ error: "This offer has already been accepted." });

  const refreshed = await loadByToken(req.params.token);
  res.json(await buildTrackerView(refreshed!));
});

router.post("/:token/offer/decline", publicWriteRateLimit, async (req, res) => {
  const report = await loadByToken(req.params.token);
  if (!report) return res.status(404).json({ error: "This link is not valid." });
  if (!report.quote) return res.status(409).json({ error: "There is no offer on this device yet." });
  if (report.quote.accepted) {
    return res.status(409).json({ error: "This offer has already been accepted and can't be declined here." });
  }
  if (report.offerDeclinedAt) return res.status(409).json({ error: "This offer was already declined." });

  await prisma.report.updateMany({
    where: { reportId: report.reportId, tenantId: report.tenantId, offerDeclinedAt: null },
    data: { offerDeclinedAt: new Date() },
  });

  const refreshed = await loadByToken(req.params.token);
  res.json(await buildTrackerView(refreshed!));
});

// ============================================================
// Payout method selection (consumer_payout.html)
// ============================================================

router.post("/:token/payout", publicWriteRateLimit, async (req, res) => {
  const { method } = (req.body ?? {}) as { method?: unknown };
  if (typeof method !== "string" || !PAYOUT_METHODS.has(method)) {
    return res.status(400).json({ error: `method must be one of: ${[...PAYOUT_METHODS].join(", ")}` });
  }

  const report = await loadByToken(req.params.token);
  if (!report) return res.status(404).json({ error: "This link is not valid." });

  const quote = report.quote;
  if (!quote) return res.status(409).json({ error: "There is no offer on this device yet." });
  if (!quote.accepted) return res.status(409).json({ error: "Accept the offer before choosing how to get paid." });

  const openDispute = await prisma.dispute.findFirst({
    where: { tenantId: report.tenantId, reportId: report.reportId, status: OPEN_DISPUTE },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "Your review request is open; payout is on hold until it's resolved." });
  }

  try {
    await prisma.payoutRecord.create({
      data: { quoteId: quote.quoteId, method, amount: quote.finalOffer, status: "pending" },
    });
  } catch (e) {
    // Unique on quoteId: a method has already been chosen. Changing it
    // is a support action, not a self-service one, once a disbursement
    // may be in flight.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "A payout method has already been chosen. Contact the store to change it." });
    }
    throw e;
  }

  const refreshed = await loadByToken(req.params.token);
  res.json(await buildTrackerView(refreshed!));
});

// ============================================================
// Dispute submission (consumer_dispute.html)
// ============================================================

const MAX_NOTE = 2000;
const MAX_ITEM = 200;

router.post("/:token/dispute", publicWriteRateLimit, async (req, res) => {
  const { disputingItem, customerNote } = (req.body ?? {}) as {
    disputingItem?: unknown;
    customerNote?: unknown;
  };

  if (typeof disputingItem !== "string" || !disputingItem.trim()) {
    return res.status(400).json({ error: "Tell us what you're disputing." });
  }
  if (typeof customerNote !== "string" || !customerNote.trim()) {
    return res.status(400).json({ error: "Please explain the problem in your own words." });
  }
  // Bounded because these are unauthenticated writes that a human then
  // has to read.
  if (disputingItem.length > MAX_ITEM || customerNote.length > MAX_NOTE) {
    return res.status(400).json({ error: "That's longer than we can accept. Please shorten it." });
  }

  const report = await loadByToken(req.params.token);
  if (!report) return res.status(404).json({ error: "This link is not valid." });

  const existing = await prisma.dispute.findFirst({
    where: { tenantId: report.tenantId, reportId: report.reportId, status: OPEN_DISPUTE },
    select: { disputeId: true },
  });
  // One open dispute at a time. Without this, a frustrated customer
  // refreshing the form fills the tenant's review queue with duplicates
  // of the same complaint.
  if (existing) {
    return res.status(409).json({ error: "You already have a review request open on this device." });
  }

  await prisma.dispute.create({
    data: {
      // From the report the token unlocked — the only place these can
      // come from on an unauthenticated route.
      tenantId: report.tenantId,
      reportId: report.reportId,
      disputingItem: disputingItem.trim(),
      customerNote: customerNote.trim(),
      status: OPEN_DISPUTE,
    },
  });

  const refreshed = await loadByToken(req.params.token);
  res.status(201).json(await buildTrackerView(refreshed!));
});

export default router;
