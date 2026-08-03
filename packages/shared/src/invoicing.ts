// invoicing.ts
//
// ============================================================================
// IMPORTANT — THIS DOES NOT ACTUALLY CHARGE ANYONE
// ============================================================================
// This generates invoice RECORDS from license/usage data. Actually collecting
// money requires a real payment processor (Stripe, Stripe Billing specifically
// fits this metered/subscription pattern well, or a similar provider) —
// there is no way around integrating one for real. What's here is the
// business logic for WHAT to charge; a payment processor handles HOW.
// ============================================================================

import { License } from "./licensing";

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Invoice {
  invoiceId: string;
  tenantId: string;
  licenseId: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  total: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
}

/**
 * Generates the line items for a billing period based on license type.
 * For tiered_subscription, this is where overage actually gets computed
 * and billed (referenced but not implemented back when licensing.ts was
 * first built — this is that implementation).
 */
export function generateInvoiceLineItems(license: License): InvoiceLineItem[] {
  const items: InvoiceLineItem[] = [];

  if (license.type === "tiered_subscription") {
    items.push({ description: "Base subscription", quantity: 1, unitPrice: 0, total: 0 }); // fill in real plan price
    const used = license.usageThisPeriod ?? 0;
    const included = license.includedQuota ?? 0;
    const overage = Math.max(0, used - included);
    if (overage > 0 && license.overageRatePerInspection) {
      items.push({
        description: `Overage (${overage} inspections beyond ${included} included)`,
        quantity: overage,
        unitPrice: license.overageRatePerInspection,
        total: overage * license.overageRatePerInspection,
      });
    }
  }

  if (license.type === "per_inspection") {
    const used = license.usageThisPeriod ?? 0;
    items.push({
      description: `Inspection credits used`,
      quantity: used,
      unitPrice: license.overageRatePerInspection ?? 0,
      total: used * (license.overageRatePerInspection ?? 0),
    });
  }

  if (license.type === "seat_subscription" || license.type === "enterprise_unlimited") {
    items.push({ description: "Flat subscription fee", quantity: 1, unitPrice: 0, total: 0 }); // fill in real plan price
  }

  return items;
}

export function generateInvoice(license: License): Invoice {
  const lineItems = generateInvoiceLineItems(license);
  const subtotal = lineItems.reduce((sum, i) => sum + i.total, 0);
  const issuedAt = new Date();
  const dueAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000); // net-30 default

  return {
    invoiceId: `INV-${license.licenseId}-${license.billingPeriodEnd.slice(0, 7)}`,
    tenantId: license.tenantId,
    licenseId: license.licenseId,
    billingPeriodStart: license.billingPeriodStart,
    billingPeriodEnd: license.billingPeriodEnd,
    lineItems,
    subtotal,
    total: subtotal, // extend here if you add tax handling
    status: "draft",
    issuedAt: issuedAt.toISOString(),
    dueAt: dueAt.toISOString(),
  };
}
