// src/routes/quotes.ts
//
// Trade-in valuation and payout (tradeInQuote.ts), plus the per-tenant
// market price table those quotes are computed from.
//
// ============================================================
// PRICING DATA IS NOT REAL YET
// ============================================================
// CLAUDE.md is unambiguous: marketPriceData.ts's seed table is "rough/
// illustrative", produced from web sources that disagreed by 2x+ on the
// same model and condition, and it "needs a real pricing API/feed before
// use". A quote computed from it is a plausible-looking number, not an
// offer anyone should be shown.
//
// So every quote records the provenance of the price table behind it
// (priceSource) and the API refuses to mark a quote accepted while that
// provenance is seed data. Accepting a quote is the step that creates a
// financial obligation to a customer; a wrong number there is real money,
// not a bad data point. The block is deliberate and is lifted by
// uploading real prices, not by a flag.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { computeTradeInQuote, type CosmeticGrade, type DiagnosticResult, type MarketPriceEntry } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const GRADES = new Set(["A", "B", "C", "D"]);
const PAYOUT_METHODS = new Set(["store_credit", "ach", "paypal", "gift_card"]);
const PAYOUT_STATUSES = new Set(["pending", "processing", "completed", "failed"]);

/** Marks a quote whose price table came from the illustrative seed. */
const SEED_SOURCE = "unverified_seed_data";
const REAL_SOURCE = "tenant_uploaded";

// ============================================================
// Market prices
// ============================================================

router.get("/prices", requireAuth, requireTenantScope, async (req, res) => {
  const prices = await prisma.marketPriceEntry.findMany({
    where: tenantWhere(req),
    orderBy: [{ model: "asc" }, { storageGb: "asc" }],
  });
  res.json(prices);
});

/**
 * Upsert, because this is the endpoint an admin's price-list upload
 * drives (CLAUDE.md's marketPriceUpload.ts) and re-uploading a corrected
 * list must update rows rather than fail on every one that already
 * exists.
 */
router.put("/prices", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot change pricing" });
  }

  const { prices } = req.body ?? {};
  if (!Array.isArray(prices) || prices.length === 0) {
    return res.status(400).json({ error: "prices must be a non-empty array" });
  }

  for (const [i, entry] of prices.entries()) {
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== "string" || !e.model) {
      return res.status(400).json({ error: `prices[${i}].model is required` });
    }
    if (typeof e.storageGb !== "number" || !Number.isInteger(e.storageGb) || e.storageGb <= 0) {
      return res.status(400).json({ error: `prices[${i}].storageGb must be a positive integer` });
    }
    const grades = e.gradeBasePrices as Record<string, unknown> | undefined;
    if (!grades || typeof grades !== "object") {
      return res.status(400).json({ error: `prices[${i}].gradeBasePrices is required` });
    }
    // Every grade must be priced. A missing one would surface later as
    // an undefined base price and a quote of NaN or 0, which looks like
    // a real offer of nothing.
    for (const grade of GRADES) {
      const value = grades[grade];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: `prices[${i}].gradeBasePrices.${grade} must be a non-negative number` });
      }
    }
  }

  const tenantFilter = tenantWhere(req);
  await prisma.$transaction(
    prices.map((entry) => {
      const e = entry as { model: string; storageGb: number; gradeBasePrices: object; currency?: string };
      return prisma.marketPriceEntry.upsert({
        where: {
          tenantId_model_storageGb: {
            tenantId: tenantFilter.tenantId,
            model: e.model,
            storageGb: e.storageGb,
          },
        },
        create: {
          ...tenantFilter,
          model: e.model,
          storageGb: e.storageGb,
          gradeBasePrices: e.gradeBasePrices as Prisma.InputJsonValue,
          currency: e.currency ?? "USD",
        },
        update: {
          gradeBasePrices: e.gradeBasePrices as Prisma.InputJsonValue,
          currency: e.currency ?? "USD",
        },
      });
    }),
  );

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "pricing_uploaded",
      targetType: "pricing",
      targetId: tenantFilter.tenantId,
      details: `Uploaded ${prices.length} market price row(s)`,
    }),
  });

  res.json({ updated: prices.length });
});

// ============================================================
// Quotes
// ============================================================

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const quotes = await prisma.tradeInQuote.findMany({
    where: tenantWhere(req),
    orderBy: { quotedAt: "desc" },
    take: 200,
    include: { payout: true },
  });
  res.json(quotes);
});

router.get("/:quoteId", requireAuth, requireTenantScope, async (req, res) => {
  const quote = await prisma.tradeInQuote.findFirst({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId },
    include: { payout: true },
  });
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  res.json({ ...quote, expired: quote.expiresAt.getTime() < Date.now() });
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { reportId, grade, storageGb } = req.body ?? {};

  if (typeof reportId !== "string" || !reportId) {
    return res.status(400).json({ error: "reportId is required" });
  }
  if (typeof grade !== "string" || !GRADES.has(grade)) {
    return res.status(400).json({ error: "grade must be one of: A, B, C, D" });
  }
  if (typeof storageGb !== "number" || !Number.isInteger(storageGb) || storageGb <= 0) {
    return res.status(400).json({ error: "storageGb must be a positive integer" });
  }

  const tenantFilter = tenantWhere(req);
  const report = await prisma.report.findFirst({
    where: { ...tenantFilter, reportId },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  // CLAUDE.md: a device with an open dispute is on hold, and payout
  // must not proceed. Quoting one would put a number in front of a
  // customer whose grade is actively contested.
  const openDispute = await prisma.dispute.findFirst({
    where: { ...tenantFilter, reportId: report.reportId, status: "awaiting_review" },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "This device has an open dispute and cannot be quoted until it is resolved" });
  }

  const priceRows = await prisma.marketPriceEntry.findMany({ where: tenantFilter });
  const priceTable: MarketPriceEntry[] = priceRows.map((row) => ({
    model: row.model,
    storageGb: row.storageGb,
    gradeBasePrices: row.gradeBasePrices as unknown as Record<CosmeticGrade, number>,
  }));

  const computed = computeTradeInQuote({
    reportId: report.reportId,
    model: report.deviceModel,
    storageGb,
    grade: grade as CosmeticGrade,
    results: report.results as unknown as DiagnosticResult[],
    priceTable,
  });

  // computeTradeInQuote returns null when the model/storage isn't
  // priced. Surfaced as a 422 with the reason rather than a zero offer:
  // "we have no price for this device" and "this device is worth
  // nothing" are very different statements to put in front of a customer.
  if (!computed) {
    return res.status(422).json({
      error: `No price on file for ${report.deviceModel} (${storageGb}GB). Upload pricing for this model before quoting.`,
    });
  }

  // Always REAL_SOURCE here, and that is not a tautology worth deleting:
  // a quote can only be computed from this tenant's uploaded price rows
  // (computeTradeInQuote returned non-null, so a row matched). The
  // SEED_SOURCE state exists for quotes minted OUTSIDE this route — the
  // schema defaults priceSource to unverified_seed_data, so a row
  // inserted by a script or migration cannot be accepted until someone
  // affirms its pricing provenance. The accept-time guard is that
  // backstop, not a check this route can trigger. (Review finding: an
  // earlier version conditionally set SEED_SOURCE here, which was dead
  // code implying a live check that never fired.)
  const priceSource = REAL_SOURCE;

  let quote;
  try {
    quote = await prisma.tradeInQuote.create({
      data: {
        ...tenantFilter,
        reportId: report.reportId,
        deviceModel: computed.deviceModel,
        grade: computed.grade,
        basePrice: computed.basePrice,
        deductions: computed.deductions as unknown as Prisma.InputJsonValue,
        finalOffer: computed.finalOffer,
        currency: computed.currency,
        expiresAt: new Date(computed.expiresAt),
        priceSource,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "This report already has a quote" });
    }
    throw e;
  }

  res.status(201).json(quote);
});

/**
 * Accepting is the step that creates a financial obligation, so it is
 * gated on the quote still being valid AND on the pricing behind it
 * being real. See the file header.
 */
router.post("/:quoteId/accept", requireAuth, requireTenantScope, async (req, res) => {
  const quote = await prisma.tradeInQuote.findFirst({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId },
  });
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  if (quote.accepted) return res.status(409).json({ error: "This quote has already been accepted" });

  if (quote.expiresAt.getTime() < Date.now()) {
    // CLAUDE.md: quotes expire because prices move. Honouring a stale
    // one silently is how a tenant loses money on every old quote.
    return res.status(409).json({ error: "This quote has expired. Generate a new one." });
  }

  if (quote.priceSource === SEED_SOURCE) {
    return res.status(409).json({
      error:
        "This quote was computed from illustrative seed pricing, not real market data, and cannot be accepted. Upload this tenant's price list first.",
    });
  }

  // The dispute hold has three checkpoints — quote, ACCEPT, payout — and
  // this one was originally missing (caught in review): a dispute filed
  // between quoting and acceptance would not have held the offer, even
  // though acceptance is precisely the step that creates the obligation.
  const openDispute = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), reportId: quote.reportId, status: "awaiting_review" },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "This device has an open dispute; the offer is on hold until it is resolved" });
  }

  const result = await prisma.tradeInQuote.updateMany({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId, accepted: false },
    data: { accepted: true, acceptedAt: new Date() },
  });
  if (result.count === 0) return res.status(409).json({ error: "This quote has already been accepted" });

  const updated = await prisma.tradeInQuote.findFirst({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId },
  });
  res.json(updated);
});

// ============================================================
// Payout
// ============================================================

router.post("/:quoteId/payout", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot initiate payouts" });
  }

  const { method } = req.body ?? {};
  if (typeof method !== "string" || !PAYOUT_METHODS.has(method)) {
    return res.status(400).json({ error: `method must be one of: ${[...PAYOUT_METHODS].join(", ")}` });
  }

  const quote = await prisma.tradeInQuote.findFirst({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId },
  });
  if (!quote) return res.status(404).json({ error: "Quote not found" });
  if (!quote.accepted) {
    return res.status(409).json({ error: "Cannot pay out a quote that has not been accepted" });
  }

  // Re-checked here and not only at quote time: a dispute can be raised
  // between acceptance and payout, and CLAUDE.md requires the offer to
  // stay on hold while one is open.
  const openDispute = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), reportId: quote.reportId, status: "awaiting_review" },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "This device has an open dispute; payout is on hold until it is resolved" });
  }

  let payout;
  try {
    payout = await prisma.payoutRecord.create({
      data: { quoteId: quote.quoteId, method, amount: quote.finalOffer, status: "pending" },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "A payout already exists for this quote" });
    }
    throw e;
  }

  res.status(201).json({
    ...payout,
    // Nothing here moves money. Stated in the response so a caller
    // cannot mistake a "pending" record for a disbursement in flight —
    // a real processor is Sprint 8 work.
    note: "Payout recorded only. No funds are transferred by this API; a payment provider is not yet integrated.",
  });
});

router.patch("/:quoteId/payout", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot change payout status" });
  }

  const { status, reference, failureReason } = req.body ?? {};
  if (typeof status !== "string" || !PAYOUT_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...PAYOUT_STATUSES].join(", ")}` });
  }
  if (status === "failed" && (typeof failureReason !== "string" || !failureReason.trim())) {
    return res.status(400).json({ error: "failureReason is required when marking a payout failed" });
  }

  const quote = await prisma.tradeInQuote.findFirst({
    where: { ...tenantWhere(req), quoteId: req.params.quoteId },
    include: { payout: true },
  });
  if (!quote?.payout) return res.status(404).json({ error: "Payout not found" });

  // Tenant scope enforced in the WRITE, not just the read above.
  // PayoutRecord has no tenantId column, so the filter goes through the
  // quote relation — same house rule the profiles.ts fix established:
  // never trust a preceding findFirst as the only boundary on a write.
  const result = await prisma.payoutRecord.updateMany({
    where: { payoutId: quote.payout.payoutId, quote: { ...tenantWhere(req) } },
    data: {
      status,
      ...(reference !== undefined ? { reference: String(reference) } : {}),
      ...(failureReason !== undefined ? { failureReason: String(failureReason) } : {}),
      ...(status === "completed" ? { completedAt: new Date() } : {}),
    },
  });
  if (result.count === 0) return res.status(404).json({ error: "Payout not found" });

  const updated = await prisma.payoutRecord.findFirst({
    where: { payoutId: quote.payout.payoutId },
  });
  res.json(updated);
});

export default router;
