// src/routes/listings.ts
//
// Resale listings generated from a report plus its trade-in quote
// (marketplaceListing.ts). Pure templating over data already captured —
// no external service involved.
//
// ============================================================
// THE PRICE HERE IS NOT A PRICING STRATEGY
// ============================================================
// generateListing applies a flat 1.35x markup over the trade-in offer,
// and its own source comments call that "rough resale markup — replace
// with real pricing strategy". That markup sits on top of a trade-in
// offer which may itself derive from illustrative seed data (see
// routes/quotes.ts), so the number can be wrong twice over. Listings are
// therefore generated as internal drafts and the response says so;
// nothing here publishes anywhere, which matches CLAUDE.md listing
// auto-publishing to eBay/Swappa as explicitly out of scope for MVP.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import {
  generateListing,
  type AuditReport,
  type CosmeticGrade,
  type DiagnosticResult,
  type TradeInQuote,
} from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { prisma } from "../lib/prisma";

const router = Router();

const GRADES = new Set(["A", "B", "C", "D"]);

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const listings = await prisma.marketplaceListing.findMany({
    where: { report: tenantWhere(req) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(listings);
});

router.get("/:listingId", requireAuth, requireTenantScope, async (req, res) => {
  const listing = await prisma.marketplaceListing.findFirst({
    where: { listingId: req.params.listingId, report: tenantWhere(req) },
  });
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  res.json(listing);
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { reportId, grade } = req.body ?? {};

  if (typeof reportId !== "string" || !reportId) {
    return res.status(400).json({ error: "reportId is required" });
  }
  if (typeof grade !== "string" || !GRADES.has(grade)) {
    return res.status(400).json({ error: "grade must be one of: A, B, C, D" });
  }

  const tenantFilter = tenantWhere(req);
  const report = await prisma.report.findFirst({
    where: { ...tenantFilter, reportId },
    include: { quote: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  // CLAUDE.md's dispute hold applies here too, and was missing (caught in
  // review): listing a device for resale at a grade the customer is
  // actively contesting is exactly what the hold exists to prevent.
  // quotes.ts already enforces this at quote, accept and payout.
  const openDispute = await prisma.dispute.findFirst({
    where: { ...tenantFilter, reportId: report.reportId, status: "awaiting_review" },
    select: { disputeId: true },
  });
  if (openDispute) {
    return res.status(409).json({ error: "This device has an open dispute and cannot be listed until it is resolved" });
  }

  if (!report.quote) {
    return res.status(422).json({ error: "This report has no trade-in quote, so no listing price can be derived" });
  }

  // CLAUDE.md: listings only trigger for devices routed to resale.
  // Listing a device bound for parts harvest or recycling would put an
  // unsellable handset on a marketplace.
  if (report.routing && report.routing !== "resale") {
    return res.status(409).json({
      error: `This device is routed to "${report.routing}", not resale, and should not be listed`,
    });
  }

  const auditReport: AuditReport = {
    reportId: report.reportId,
    generatedAt: report.generatedAt.toISOString(),
    technicianId: report.technicianId ?? undefined,
    device: {
      make: report.deviceMake,
      model: report.deviceModel,
      serialNumber: report.serialNumber,
      imei: report.imei,
      imei2: report.imei2 ?? undefined,
      captureSource: report.captureSource as AuditReport["device"]["captureSource"],
    },
    results: report.results as unknown as DiagnosticResult[],
    overallStatus: report.overallStatus as AuditReport["overallStatus"],
  };

  const quote: TradeInQuote = {
    quoteId: report.quote.quoteId,
    reportId: report.quote.reportId,
    deviceModel: report.quote.deviceModel,
    grade: report.quote.grade as CosmeticGrade,
    basePrice: report.quote.basePrice,
    deductions: report.quote.deductions as unknown as TradeInQuote["deductions"],
    finalOffer: report.quote.finalOffer,
    currency: report.quote.currency,
    quotedAt: report.quote.quotedAt.toISOString(),
    expiresAt: report.quote.expiresAt.toISOString(),
  };

  const generated = generateListing(auditReport, quote, grade as CosmeticGrade);

  let listing;
  try {
    listing = await prisma.marketplaceListing.create({
      data: {
        reportId: report.reportId,
        title: generated.title,
        description: generated.description,
        askingPrice: generated.price,
        currency: report.quote.currency,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "This report already has a listing" });
    }
    throw e;
  }

  res.status(201).json({
    ...listing,
    // Both caveats travel with the response rather than living only in a
    // source comment, since the number is the part a human will act on.
    priceIsPlaceholder: true,
    priceNote:
      "Asking price is a flat 1.35x markup over the trade-in offer, not a pricing strategy" +
      (report.quote.priceSource === "unverified_seed_data"
        ? ", and the underlying quote used illustrative seed pricing rather than real market data."
        : "."),
  });
});

export default router;
