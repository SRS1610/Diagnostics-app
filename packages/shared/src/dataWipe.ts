// dataWipe.ts
//
// Generates a certified erasure record for the existing `factory_reset`
// test — the trade-in industry needs an attestation, not just a
// pass/fail flag, since this is what protects both parties if personal
// data on a resold device ever becomes a dispute later.

import { logActivity } from "./adminActivityLog";

export type WipeStandard = "nist_800_88_clear" | "nist_800_88_purge";

export interface DataWipeCertificate {
  certificateId: string;
  reportId: string;
  deviceSerial: string;
  imei: string;
  standard: WipeStandard;
  wipedAt: string;
  verifiedByTechnicianId: string;
  passed: boolean;
}

/**
 * "Clear" (single overwrite, standard factory reset) is adequate for
 * most consumer resale. "Purge" (cryptographic erase / multi-pass) is
 * what corporate or compliance-driven trade-in clients often require —
 * decide per customer profile whether Purge should be mandatory (this
 * is a good candidate for a per-profile setting alongside required
 * tests in customerProfile.ts).
 */
export function generateWipeCertificate(params: {
  reportId: string;
  deviceSerial: string;
  imei: string;
  standard: WipeStandard;
  technicianId: string;
  wipeSucceeded: boolean;
  tenantId: string;
}): DataWipeCertificate {
  const cert: DataWipeCertificate = {
    certificateId: `WIPE-${params.reportId}`,
    reportId: params.reportId,
    deviceSerial: params.deviceSerial,
    imei: params.imei,
    standard: params.standard,
    wipedAt: new Date().toISOString(),
    verifiedByTechnicianId: params.technicianId,
    passed: params.wipeSucceeded,
  };

  logActivity({
    tenantId: params.tenantId,
    actorUserId: params.technicianId,
    actorRole: "tenant_staff",
    action: "data_wipe_certified",
    targetType: "report",
    targetId: params.reportId,
    details: `${params.standard} wipe ${params.wipeSucceeded ? "passed" : "FAILED"} for ${params.deviceSerial}`,
  });

  return cert;
}
