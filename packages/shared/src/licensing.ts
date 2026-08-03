// licensing.ts
//
// License enforcement for the mobile app, tied to the TENANT (the paying
// company) rather than an individual CustomerProfile or technician.
//
// CORRECTED under multi-tenancy: this originally tied License.profileId
// to a CustomerProfile. That was wrong — a tenant can have multiple
// profiles (different programs/locations under one company), all
// covered by ONE license. Billing happens once per tenant, not once per
// profile. See CLAUDE.md "Multi-tenant architecture".

import { Tenant } from "./tenant";
import { logActivity } from "./adminActivityLog";

export type LicenseType =
  | "per_inspection"      // metered — one credit consumed per completed session
  | "seat_subscription"   // N technician seats, unlimited inspections per seat
  | "tiered_subscription" // monthly/annual, included quota + overage billing
  | "enterprise_unlimited"; // flat fee, no per-use limit

export type LicenseStatus = "active" | "expired" | "suspended" | "quota_exceeded";

export interface License {
  licenseId: string;
  tenantId: string; // CHANGED from profileId — see header note above
  type: LicenseType;
  status: LicenseStatus;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  // Only meaningful for per_inspection / tiered_subscription:
  includedQuota?: number;
  usageThisPeriod?: number;
  overageRatePerInspection?: number; // charged per unit past includedQuota
  // Only meaningful for seat_subscription:
  seatLimit?: number;
  activeSeats?: number;
}

export interface LicenseCheckResult {
  allowed: boolean;
  reason?: string; // populated when allowed is false — shown to the technician
  remainingQuota?: number;
}

/**
 * Checked at session start, right after the profile QR is scanned and
 * BEFORE the device eligibility check — no point running a blacklist
 * lookup on a session that isn't licensed to happen at all. This is a
 * hard gate, same pattern as device eligibility and the PIN-not-found
 * case: never silently let an unlicensed/expired/over-quota session
 * proceed.
 */
export function checkLicense(license: License): LicenseCheckResult {
  if (license.status === "suspended") {
    return { allowed: false, reason: "This organization's license is suspended. Contact your account administrator." };
  }
  if (license.status === "expired") {
    return { allowed: false, reason: "This organization's license has expired. Renewal required to continue." };
  }

  if (license.type === "per_inspection" || license.type === "tiered_subscription") {
    const used = license.usageThisPeriod ?? 0;
    const quota = license.includedQuota ?? 0;
    const remaining = quota - used;
    if (remaining <= 0 && license.type === "per_inspection") {
      // Pure metered plans block at zero remaining credits — no overage.
      return { allowed: false, reason: "No inspection credits remaining this billing period.", remainingQuota: 0 };
    }
    // Tiered subscriptions allow overage (billed separately) rather than blocking.
    return { allowed: true, remainingQuota: Math.max(0, remaining) };
  }

  if (license.type === "seat_subscription") {
    if ((license.activeSeats ?? 0) >= (license.seatLimit ?? 0)) {
      return { allowed: false, reason: "All technician seats are in use. Add a seat or wait for one to free up." };
    }
    return { allowed: true };
  }

  // enterprise_unlimited
  return { allowed: true };
}

/**
 * Call once per COMPLETED session (report generated), not per test —
 * a session that's abandoned partway through shouldn't consume a
 * credit. Only meaningful for metered plan types.
 */
export function recordUsage(license: License): License {
  if (license.type !== "per_inspection" && license.type !== "tiered_subscription") return license;
  return {
    ...license,
    usageThisPeriod: (license.usageThisPeriod ?? 0) + 1,
  };
}

/**
 * Called for seat_subscription licenses at shift start — consumes one
 * seat. Call alongside startShift() in technicianAuth.ts, not
 * separately, so a logged-in technician always corresponds to exactly
 * one consumed seat (see CLAUDE.md "Licensing model" for why these two
 * modules previously existed without being connected — this fixes that).
 */
export function consumeSeat(license: License): License {
  if (license.type !== "seat_subscription") return license;
  return { ...license, activeSeats: (license.activeSeats ?? 0) + 1 };
}

/**
 * Called at shift end (technician logs out / app is closed for the day)
 * — frees the seat. Without this, seats would only ever fill up and
 * never free, making "Seats Full" permanent regardless of actual usage.
 */
export function releaseSeat(license: License): License {
  if (license.type !== "seat_subscription") return license;
  return { ...license, activeSeats: Math.max(0, (license.activeSeats ?? 0) - 1) };
}

export function getLicenseForTenant(tenant: Tenant): Promise<License> {
  return fetch(`${process.env.LICENSE_API_BASE}/licenses/by-tenant/${tenant.tenantId}`).then((r) => r.json() as Promise<License>);
}

/**
 * Creates a new license for a tenant — what the Master Admin console's
 * "New License" / "New Tenant" flow actually calls.
 */
export function provisionLicense(params: {
  tenantId: string;
  type: LicenseType;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  includedQuota?: number;
  overageRatePerInspection?: number;
  seatLimit?: number;
  actorUserId: string;
  actorRole: "master_admin" | "tenant_admin";
}): License {
  const license: License = {
    licenseId: `LIC-${Date.now()}`,
    tenantId: params.tenantId,
    type: params.type,
    status: "active",
    billingPeriodStart: params.billingPeriodStart,
    billingPeriodEnd: params.billingPeriodEnd,
    includedQuota: params.includedQuota,
    usageThisPeriod: 0,
    overageRatePerInspection: params.overageRatePerInspection,
    seatLimit: params.seatLimit,
    activeSeats: 0,
  };

  logActivity({
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: "license_provisioned",
    targetType: "license",
    targetId: license.licenseId,
    details: `Provisioned ${params.type} license for tenant ${params.tenantId}`,
    metadata: { type: params.type, quota: params.includedQuota, seats: params.seatLimit },
  });

  return license;
}
