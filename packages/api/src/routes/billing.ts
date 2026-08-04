// src/routes/billing.ts
//
// Self-serve Stripe billing: a tenant admin buys or changes a plan
// through Stripe Checkout instead of an admin manually provisioning a
// license (routes/licenses.ts's POST / — still the primary path for a
// sales-assisted deal, and untouched by any of this).
//
// Three routes, three different trust models:
//   - POST /checkout-session, POST /portal-session — normal portal
//     session auth, admin-only, same as billing/disputes elsewhere
//   - POST /webhook — Stripe calls this directly. No portal session
//     exists on that request; a valid Stripe signature over the exact
//     raw body IS the authentication. See app.ts for why the raw bytes
//     are captured onto req.rawBody before JSON-parsing.
//
// DUNNING: a failed renewal charge marks the license "past_due" rather
// than immediately expiring it — Stripe itself retries a failed card a
// few times over about two weeks before giving up, and cutting a tenant
// off on the FIRST failure would be harsher than Stripe's own default
// behavior for a problem that often resolves itself (an expired card
// auto-updated, a temporary decline). "past_due" is a status
// checkLicense() (licensing.ts) does not currently special-case — until
// it does, a past_due license behaves like any non-"active" one for
// checkLicense()'s gate, which is the conservative direction to fail in.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { getStripeClient, priceIdForType } from "../lib/stripe";
import { VALID_LICENSE_TYPES } from "./licenses";
import { prisma } from "../lib/prisma";
import type { LicenseType } from "@diagnostics/shared";
import type { Request } from "express";
import type Stripe from "stripe";

// Stripe moved an invoice's subscription link to
// invoice.parent.subscription_details.subscription in newer API
// versions — invoice.subscription (the old top-level field) no longer
// exists on the type at all.
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const subscription = invoice.parent?.subscription_details?.subscription;
  return typeof subscription === "string" ? subscription : subscription?.id;
}

const router = Router();
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";

const requireAdmin = (req: Parameters<typeof requireAuth>[0]) => req.portalSession!.role !== "tenant_staff";

const NOT_CONFIGURED = {
  error: "Stripe billing is not configured for this deployment yet. Set STRIPE_SECRET_KEY (and a price ID for this plan) to enable self-serve checkout.",
};

router.post("/checkout-session", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage billing" });

  const { type } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof type !== "string" || !VALID_LICENSE_TYPES.includes(type as LicenseType)) {
    return res.status(400).json({ error: `type must be one of: ${VALID_LICENSE_TYPES.join(", ")}` });
  }

  const stripe = getStripeClient();
  const priceId = priceIdForType(type as LicenseType);
  if (!stripe || !priceId) return res.status(501).json(NOT_CONFIGURED);

  const tenantId = req.portalSession!.viewingTenantId!;
  const tenant = await prisma.tenant.findUnique({ where: { tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // Reuse the existing Stripe Customer if this tenant has checked out
  // before — a second Customer per tenant would split its billing
  // history across two records in the Stripe dashboard for no reason.
  let stripeCustomerId = tenant.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: tenant.primaryContactEmail,
      name: tenant.companyName,
      metadata: { tenantId },
    });
    stripeCustomerId = customer.id;
    await prisma.tenant.update({ where: { tenantId }, data: { stripeCustomerId } });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: stripeCustomerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${PORTAL_BASE_URL}/billing?checkout=success`,
    cancel_url: `${PORTAL_BASE_URL}/billing?checkout=canceled`,
    metadata: { tenantId, type },
    subscription_data: { metadata: { tenantId, type } },
  });

  res.json({ checkoutUrl: session.url });
});

router.post("/portal-session", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage billing" });

  const stripe = getStripeClient();
  if (!stripe) return res.status(501).json(NOT_CONFIGURED);

  const tenant = await prisma.tenant.findUnique({ where: { tenantId: req.portalSession!.viewingTenantId! } });
  if (!tenant?.stripeCustomerId) {
    return res.status(404).json({ error: "No Stripe billing history for this organization yet — check out a plan first." });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${PORTAL_BASE_URL}/billing`,
  });

  res.json({ url: session.url });
});

/**
 * Provisions/renews a License from a Stripe subscription — the same
 * supersede-then-create shape as licenses.ts's POST /, just triggered
 * by Stripe rather than an admin's form.
 */
async function provisionFromSubscription(tenantId: string, type: LicenseType, stripeSubscriptionId: string, periodStart: Date, periodEnd: Date) {
  await prisma.$transaction([
    prisma.license.updateMany({ where: { tenantId, status: "active" }, data: { status: "expired" } }),
    prisma.license.create({
      data: {
        tenantId,
        type,
        status: "active",
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        stripeSubscriptionId,
      },
    }),
  ]);
  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId,
      actorUserId: "stripe",
      actorRole: "tenant_admin",
      action: "billing_checkout_completed",
      targetType: "license",
      targetId: stripeSubscriptionId,
      details: `Stripe checkout completed for a ${type} plan`,
    }),
  });
}

// No requireAuth/requireTenantScope — Stripe is the caller, and a valid
// signature over the exact raw body IS the authentication here. Always
// 200s once the signature checks out, even if a handler below finds
// nothing to do with a particular event type — anything else trains
// Stripe to retry an event this API deliberately doesn't act on.
router.post("/webhook", async (req, res) => {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) return res.status(501).json(NOT_CONFIGURED);

  const signature = req.headers["stripe-signature"];
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!signature || !rawBody) return res.status(400).json({ error: "Missing signature or body" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (e) {
    // The one case that must NOT be a 200 — an unverifiable request is
    // not a Stripe event this API should trust, signature failure or not.
    return res.status(400).json({ error: `Webhook signature verification failed: ${e instanceof Error ? e.message : e}` });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const tenantId = session.metadata?.tenantId;
      const type = session.metadata?.type as LicenseType | undefined;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (tenantId && type && subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const item = subscription.items.data[0];
        await provisionFromSubscription(
          tenantId,
          type,
          subscriptionId,
          new Date(item.current_period_start * 1000),
          new Date(item.current_period_end * 1000),
        );
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (subscriptionId) {
        const license = await prisma.license.findFirst({ where: { stripeSubscriptionId: subscriptionId } });
        if (license && license.status !== "past_due") {
          await prisma.license.update({ where: { licenseId: license.licenseId }, data: { status: "past_due" } });
          await prisma.activityLogEntry.create({
            data: buildActivityLogData({
              tenantId: license.tenantId,
              actorUserId: "stripe",
              actorRole: "tenant_admin",
              action: "billing_payment_failed",
              targetType: "license",
              targetId: license.licenseId,
              details: "A renewal payment failed — Stripe will retry automatically",
            }),
          });
        }
      }
      break;
    }
    case "invoice.payment_succeeded": {
      const invoice = event.data.object;
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (subscriptionId) {
        const license = await prisma.license.findFirst({ where: { stripeSubscriptionId: subscriptionId } });
        if (license && license.status === "past_due") {
          await prisma.license.update({ where: { licenseId: license.licenseId }, data: { status: "active" } });
          await prisma.activityLogEntry.create({
            data: buildActivityLogData({
              tenantId: license.tenantId,
              actorUserId: "stripe",
              actorRole: "tenant_admin",
              action: "billing_payment_recovered",
              targetType: "license",
              targetId: license.licenseId,
              details: "A previously-failed payment succeeded — license restored to active",
            }),
          });
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const license = await prisma.license.findFirst({ where: { stripeSubscriptionId: subscription.id } });
      if (license && license.status !== "expired") {
        await prisma.license.update({ where: { licenseId: license.licenseId }, data: { status: "expired" } });
        await prisma.activityLogEntry.create({
          data: buildActivityLogData({
            tenantId: license.tenantId,
            actorUserId: "stripe",
            actorRole: "tenant_admin",
            action: "billing_subscription_canceled",
            targetType: "license",
            targetId: license.licenseId,
            details: "Stripe subscription canceled",
          }),
        });
      }
      break;
    }
    default:
      break;
  }

  res.status(200).json({ received: true });
});

export default router;
