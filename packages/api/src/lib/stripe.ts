// src/lib/stripe.ts
//
// Same shape as every other paid-provider integration in this project
// (deviceVerification.ts, notifications.ts, kycVerification.ts): real
// logic for WHEN and WHAT, genuinely non-functional without a real key.
// getStripeClient() returns null rather than throwing when unconfigured
// — callers decide what "billing isn't set up yet" means for their
// route (usually a 501 with an explanation, never a crash).
//
// Price IDs are NOT hardcoded. A Stripe Price ID is specific to one
// Stripe account's catalog — there is no sensible default to ship, the
// same reason marketPriceData.ts's seed table is explicitly rough/
// illustrative rather than pretending to be real pricing.

import Stripe from "stripe";
import type { LicenseType } from "@diagnostics/shared";

export function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

const PLAN_PRICE_ENV: Record<LicenseType, string> = {
  per_inspection: "STRIPE_PRICE_PER_INSPECTION",
  seat_subscription: "STRIPE_PRICE_SEAT_SUBSCRIPTION",
  tiered_subscription: "STRIPE_PRICE_TIERED_SUBSCRIPTION",
  enterprise_unlimited: "STRIPE_PRICE_ENTERPRISE_UNLIMITED",
};

/** The Stripe Price ID configured for a plan type, or undefined if this
 *  deployment hasn't set one up yet for that plan. */
export function priceIdForType(type: LicenseType): string | undefined {
  return process.env[PLAN_PRICE_ENV[type]];
}
