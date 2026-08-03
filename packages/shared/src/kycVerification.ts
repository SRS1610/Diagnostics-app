// kycVerification.ts
//
// ============================================================================
// IMPORTANT — NEEDS A REAL IDENTITY VERIFICATION PROVIDER
// ============================================================================
// Actually verifying someone's identity requires a real KYC/AML provider
// (Persona, Jumio, Onfido, or similar — this is a regulated space, don't
// attempt to build identity verification in-house). What's here is the
// threshold logic for WHEN verification is required before a payout
// proceeds — not a working identity check.
// ============================================================================

import { PayoutRecord } from "./tradeInQuote";

// Illustrative threshold — actual dollar amount and applicable
// jurisdictions depend on real legal/compliance advice, not a default
// picked here. Get that from counsel before shipping this to production.
const KYC_REQUIRED_THRESHOLD_USD = 600;

export type KycStatus = "not_required" | "pending" | "verified" | "failed";

export interface KycCheck {
  payoutId: string;
  required: boolean;
  status: KycStatus;
  provider?: string;
  checkedAt?: string;
}

export function requiresKyc(payout: PayoutRecord): boolean {
  return payout.amount >= KYC_REQUIRED_THRESHOLD_USD;
}

/**
 * Gate this in front of payout processing — same hard-gate pattern as
 * device eligibility and licensing: a payout above threshold with no
 * verified KYC check should never proceed to "processing," regardless
 * of how ready everything else is.
 */
export function canProcessPayout(payout: PayoutRecord, kyc: KycCheck | null): { allowed: boolean; reason?: string } {
  if (!requiresKyc(payout)) return { allowed: true };
  if (!kyc || kyc.status !== "verified") {
    return { allowed: false, reason: "Identity verification required for payouts of this amount before processing can continue." };
  }
  return { allowed: true };
}
