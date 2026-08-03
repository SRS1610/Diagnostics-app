// warrantyTracking.ts
//
// Links a post-sale failure claim back to the original inspection —
// buildable now since it's pure data linkage, not a new external
// dependency. See CLAUDE.md "Warranty & returns tracking".

export type WarrantyClaimStatus = "open" | "investigating" | "approved" | "denied" | "resolved";

import { logActivity } from "./adminActivityLog";

export interface WarrantyClaim {
  claimId: string;
  reportId: string; // links back to the ORIGINAL AuditReport
  deviceSerial: string;
  claimedIssue: string;
  submittedAt: string;
  warrantyExpiresAt: string; // e.g. 30/60/90 days from sale, per your policy
  status: WarrantyClaimStatus;
  resolutionNotes?: string;
}

const DEFAULT_WARRANTY_DAYS = 90;

export function isWithinWarranty(saleDate: string, warrantyDays: number = DEFAULT_WARRANTY_DAYS): boolean {
  const expiry = new Date(saleDate);
  expiry.setDate(expiry.getDate() + warrantyDays);
  return new Date() <= expiry;
}

export function fileWarrantyClaim(params: {
  reportId: string;
  deviceSerial: string;
  claimedIssue: string;
  saleDate: string;
  warrantyDays?: number;
  tenantId: string;
  actorUserId: string;
}): WarrantyClaim {
  const days = params.warrantyDays ?? DEFAULT_WARRANTY_DAYS;
  const warrantyExpiresAt = new Date(params.saleDate);
  warrantyExpiresAt.setDate(warrantyExpiresAt.getDate() + days);

  const claim: WarrantyClaim = {
    claimId: `WC-${Date.now()}`,
    reportId: params.reportId,
    deviceSerial: params.deviceSerial,
    claimedIssue: params.claimedIssue,
    submittedAt: new Date().toISOString(),
    warrantyExpiresAt: warrantyExpiresAt.toISOString(),
    status: "open",
  };

  logActivity({
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    actorRole: "tenant_staff",
    action: "warranty_claim_filed",
    targetType: "warranty_claim",
    targetId: claim.claimId,
    details: `Warranty claim for ${params.deviceSerial}: "${params.claimedIssue}"`,
    metadata: { reportId: params.reportId },
  });

  return claim;
}

/**
 * Useful for the Team/QA view: repeated warranty claims tracing back to
 * one technician's inspections is a real signal worth surfacing,
 * similar to how a worsening grade trend is surfaced in the Devices tab.
 */
export function claimRateByTechnician(
  claims: WarrantyClaim[],
  reportTechnicianMap: Map<string, string> // reportId -> technicianId
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    const techId = reportTechnicianMap.get(claim.reportId);
    if (!techId) continue;
    counts.set(techId, (counts.get(techId) ?? 0) + 1);
  }
  return counts;
}
