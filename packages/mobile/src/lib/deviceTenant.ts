// src/lib/deviceTenant.ts
//
// Binds this device to one tenant, persisted across app restarts.
//
// WHY THIS EXISTS: CLAUDE.md's multi-tenant model makes badgeCode unique
// only WITHIN a tenant, so technician login needs a tenantId alongside
// it. The badge QR carries both — but the manual fallback (damaged or
// missing badge) previously had nowhere to get a tenantId from, and
// asking a technician to type a raw cuid is not a real workflow.
//
// The resolution follows from how this hardware is actually deployed:
// CLAUDE.md describes "a shared warehouse tablet, not a personal device
// ... already access-controlled at the facility level." A facility
// tablet serves ONE tenant. So the tenant is a property of the DEVICE,
// established once, not a credential the technician re-supplies every
// shift. First successful badge scan binds it; from then on the manual
// fallback only needs the badge code.
//
// This deliberately avoids the two obvious alternatives:
//   - A public tenant search/list endpoint would hand anyone the
//     platform's customer list — a real disclosure for a multi-tenant
//     SaaS, and unnecessary here.
//   - Typing a tenant slug/code still means typing a tenant identifier
//     per shift, and would need a schema change to add one.
//
// Storage uses react-native-fs (already on README's pre-approved native
// dependency list) rather than @react-native-async-storage/async-storage,
// which is the more idiomatic choice for key-value state but is NOT
// pre-approved — and CLAUDE.md is explicit that new native dependencies
// get asked about first. A single small JSON file is well within what
// react-native-fs handles. Worth revisiting if more device-level
// settings accumulate.
//
// NOT a secret: tenantId is printed on the profile QR poster at the
// intake station. This selects which tenant's badge codes to check
// against; the API still validates the (tenantId, badgeCode) pair.

import RNFS from 'react-native-fs';

const BINDING_PATH = `${RNFS.DocumentDirectoryPath}/device-tenant.json`;

export interface DeviceTenantBinding {
  tenantId: string;
  companyName: string;
  boundAt: string;
}

export async function loadDeviceTenant(): Promise<DeviceTenantBinding | null> {
  try {
    if (!(await RNFS.exists(BINDING_PATH))) return null;
    const raw = await RNFS.readFile(BINDING_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DeviceTenantBinding>;
    if (!parsed.tenantId || !parsed.companyName) return null;
    return {
      tenantId: parsed.tenantId,
      companyName: parsed.companyName,
      boundAt: parsed.boundAt ?? '',
    };
  } catch {
    // Corrupt/unreadable binding is equivalent to no binding — the
    // technician re-scans a badge QR to re-establish it. Never throw
    // here; that would hard-block login on a bad file.
    return null;
  }
}

export async function saveDeviceTenant(tenantId: string, companyName: string): Promise<void> {
  const binding: DeviceTenantBinding = {
    tenantId,
    companyName,
    boundAt: new Date().toISOString(),
  };
  await RNFS.writeFile(BINDING_PATH, JSON.stringify(binding), 'utf8');
}

/**
 * Clears the binding — for a tablet redeployed to another facility.
 * Without this a device could only ever serve its first tenant.
 */
export async function clearDeviceTenant(): Promise<void> {
  try {
    if (await RNFS.exists(BINDING_PATH)) await RNFS.unlink(BINDING_PATH);
  } catch {
    // Best-effort; a failed unlink shouldn't surface as an error to the
    // technician, and the next successful scan overwrites the file.
  }
}
