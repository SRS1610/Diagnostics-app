// deviceVerification.ts
//
// Activation lock (iCloud FMIP / Android FRP) and IMEI blacklist checking.
// This runs BEFORE diagnostics begin — see CLAUDE.md "Device verification
// gate" for why intake order matters here: no point running a full test
// suite on a device that turns out to be locked or blacklisted.
//
// ============================================================================
// IMPORTANT — THIS DATA CANNOT BE BUILT FROM PUBLIC WEB SEARCH
// ============================================================================
// GSMA's blacklist database and Apple/Google's activation-lock status
// systems are not public data sources — they're licensed/carrier-partnered
// systems. There is no legitimate way to scrape or reconstruct this from
// "data available online"; any implementation MUST go through a real
// verification provider's paid API.
//
// Vendor landscape as of mid-2026 (verify current pricing/terms directly —
// this is a starting point for vendor research, not an endorsement):
//
// TIER 1 — the authoritative source:
//   - GSMA Device Check (devicecheck.gsma.com / gsmaservices.com) — the
//     actual registry every reseller below checks against. GSMA markets
//     this directly to device traders/retailers, repair centers, and
//     recyclers — i.e. exactly this industry. Covers stolen/lost/fraud
//     flags AND ownership/financial claims (leases, in-transit inventory),
//     with 10+ years of device history per lookup. Going direct avoids
//     paying a reseller markup on someone else's GSMA subscription.
//     Does NOT include activation-lock (FMIP/FRP) status on its own.
//
// TIER 2 — aggregators bundling GSMA data + activation-lock status
// (useful since GSMA Device Check alone won't tell you iCloud/FRP status):
//   - CellDe — API-first, explicitly targets trade-in/refurbishment
//     businesses, claims GSMA integration + FMIP status in one call
//   - IMEI.info — paid "Premium" tier + a dedicated IMEI API product;
//     also does iCloud lock checks and carrier lookup
//   - IMEIPro.info, IMEI.org — consumer-facing IMEI lookup tools; confirm
//     they actually offer a bulk/business API tier before assuming so
//
// TIER 3 — industry diagnostics platforms (verification is one feature
// among many, closer to a competitor/comparable than a pure API vendor):
//   - PhoneCheck — established name in phone diagnostics/grading
//     specifically; worth studying for how an incumbent bundles this
//     into a broader workflow, even if you don't use their API directly
//
// Recommendation: start with GSMA Device Check directly for the
// blacklist/ownership-claim piece; add a Tier 2 vendor only if you want
// activation-lock bundled into the same call rather than a second
// integration. Get real per-lookup pricing at your expected volume from
// at least two options before committing — none of this was priced in
// available research.
//
// Sign up with a real provider, get real API credentials, and swap the
// fetch() below to match their actual request/response contract — the
// shape here is illustrative, not a real integration.
// ============================================================================

export type BlacklistStatus = "clean" | "blacklisted" | "unknown";
export type LockType = "icloud_fmip" | "google_frp" | "carrier" | "mdm" | "none";

export interface DeviceVerificationResult {
  imei: string;
  blacklistStatus: BlacklistStatus;
  activationLockEnabled: boolean;
  lockType: LockType;
  outstandingBalance: boolean;
  carrierLocked: boolean;
  checkedAt: string;
  source: string; // name of the third-party verification provider used
}

/**
 * Calls a third-party device-verification API (IMEI-based). This is NOT
 * something to build in-house — GSMA blacklist data and Apple/Google
 * activation-lock status aren't independently queryable; you need a
 * provider that aggregates this (several exist in this space — evaluate
 * for coverage, latency, and per-lookup cost before committing to one).
 */
export async function verifyDevice(imei: string): Promise<DeviceVerificationResult> {
  const response = await fetch(`${process.env.DEVICE_VERIFICATION_API_BASE}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imei }),
  });
  return response.json() as Promise<DeviceVerificationResult>;
}

export interface EligibilityResult {
  eligible: boolean;
  blockingReasons: string[];
}

/**
 * Determines whether a device can proceed into diagnostics at all.
 * A blacklisted or activation-locked device should stop the session
 * here — never let it silently continue into grading/valuation, since
 * an offer or resale listing built on top of an ineligible device is a
 * real financial and legal liability.
 */
export function checkEligibility(result: DeviceVerificationResult): EligibilityResult {
  const blockingReasons: string[] = [];
  if (result.blacklistStatus === "blacklisted") {
    blockingReasons.push("Device is blacklisted (reported lost or stolen)");
  }
  if (result.activationLockEnabled) {
    blockingReasons.push(
      result.lockType === "icloud_fmip"
        ? "iCloud Activation Lock is enabled — must be removed by the previous owner"
        : "Factory Reset Protection is enabled — must be removed by the previous owner"
    );
  }
  if (result.outstandingBalance) {
    blockingReasons.push("Device has an outstanding carrier balance or active lease");
  }
  return { eligible: blockingReasons.length === 0, blockingReasons };
}
