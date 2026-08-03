// src/api/client.ts
//
// Thin fetch wrappers around the Sprint 3-relevant packages/api routes.
// No auth token handling here — these three endpoints are deliberately
// unauthenticated (see their route-file headers in packages/api/src/
// routes/technicians.ts, profiles.ts, licenses.ts): there is no portal
// session at this point in the mobile flow.

import { API_BASE_URL } from '../config';

export interface Technician {
  technicianId: string;
  tenantId: string;
  displayName: string;
}

export interface CustomerProfile {
  profileId: string;
  tenantId: string;
  customerName: string;
  pin: string;
  enabledTestIds: string[];
}

export interface LicenseCheckResult {
  allowed: boolean;
  reason?: string;
  remainingQuota?: number;
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function loginTechnician(tenantId: string, badgeCode: string): Promise<Technician> {
  const response = await fetch(`${API_BASE_URL}/technicians/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, badgeCode }),
  });
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<Technician>;
}

export async function resolveProfileByPin(tenantId: string, pin: string): Promise<CustomerProfile> {
  const response = await fetch(
    `${API_BASE_URL}/profiles/tenants/${encodeURIComponent(tenantId)}/profiles/by-pin/${encodeURIComponent(pin)}`,
  );
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<CustomerProfile>;
}

export async function checkTenantLicense(tenantId: string): Promise<LicenseCheckResult> {
  const response = await fetch(`${API_BASE_URL}/licenses/tenants/${encodeURIComponent(tenantId)}/check`);
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<LicenseCheckResult>;
}

export { ApiError };
