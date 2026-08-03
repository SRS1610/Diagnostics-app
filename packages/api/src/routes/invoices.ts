// src/routes/invoices.ts
//
// Invoice records generated from licence usage (invoicing.ts). The
// Invoice model existed in schema.prisma with no endpoints.
//
// ============================================================
// THIS DOES NOT CHARGE ANYONE.
// ============================================================
// invoicing.ts opens with that warning in capitals and it survives the
// move into an HTTP route unchanged: this computes WHAT to bill and
// stores it. Collecting money needs a real processor (Stripe Billing
// suits this metered/subscription shape) and is Sprint 8. An invoice
// here is a draft record, and its "paid" status can only ever be set by
// a human until a processor is wired in — nothing in this file observes
// an actual payment.
//
// The generated line items also contain placeholder unit prices of 0 for
// base subscription fees, because no plan pricing exists anywhere in the
// system yet. Totals are therefore NOT invoiceable figures. Surfaced in
// the response rather than left for someone to discover after sending a
// customer a bill for nothing.

import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { generateInvoiceLineItems, type License, type LicenseType } from "@diagnostics/shared";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";

const router = Router();
const prisma = new PrismaClient();

const INVOICE_STATUSES = new Set(["draft", "sent", "paid", "overdue", "void"]);
const PAYMENT_TERMS_DAYS = 30;

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

/** True when any line item still carries the placeholder price, i.e. the
 *  total understates what should actually be billed. */
function hasPlaceholderPricing(lineItems: { unitPrice: number; quantity: number }[]): boolean {
  return lineItems.some((item) => item.unitPrice === 0 && item.quantity > 0);
}

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { license: tenantWhere(req) },
    orderBy: { issuedAt: "desc" },
    take: 200,
  });
  res.json(invoices);
});

router.get("/:invoiceId", requireAuth, requireTenantScope, async (req, res) => {
  const invoice = await prisma.invoice.findFirst({
    where: { invoiceId: req.params.invoiceId, license: tenantWhere(req) },
  });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  res.json(invoice);
});

router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot generate invoices" });
  }

  const { licenseId } = req.body ?? {};
  if (typeof licenseId !== "string" || !licenseId) {
    return res.status(400).json({ error: "licenseId is required" });
  }

  const license = await prisma.license.findFirst({
    where: { ...tenantWhere(req), licenseId },
  });
  if (!license) return res.status(404).json({ error: "License not found" });

  const lineItems = generateInvoiceLineItems(toSharedLicense(license));
  const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);

  const invoice = await prisma.invoice.create({
    data: {
      licenseId: license.licenseId,
      billingPeriodStart: license.billingPeriodStart,
      billingPeriodEnd: license.billingPeriodEnd,
      lineItems: lineItems as unknown as object[],
      subtotal,
      total: subtotal,
      status: "draft",
      dueAt: new Date(Date.now() + PAYMENT_TERMS_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  res.status(201).json({
    ...invoice,
    // Explicit, not a comment someone has to go find: without plan
    // pricing these totals are structurally incomplete, and sending one
    // to a customer would bill them incorrectly.
    pricingIncomplete: hasPlaceholderPricing(lineItems),
    ...(hasPlaceholderPricing(lineItems)
      ? {
          pricingWarning:
            "Line items use placeholder unit prices because no plan pricing is configured. This total is not invoiceable.",
        }
      : {}),
  });
});

router.patch("/:invoiceId", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot change invoice status" });
  }

  const { status } = req.body ?? {};
  if (typeof status !== "string" || !INVOICE_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...INVOICE_STATUSES].join(", ")}` });
  }

  const result = await prisma.invoice.updateMany({
    where: { invoiceId: req.params.invoiceId, license: tenantWhere(req) },
    data: { status },
  });
  if (result.count === 0) return res.status(404).json({ error: "Invoice not found" });

  const updated = await prisma.invoice.findFirst({
    where: { invoiceId: req.params.invoiceId, license: tenantWhere(req) },
  });
  res.json(updated);
});

export default router;
