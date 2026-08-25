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
  companyName: string;
  /** Session token for authenticated writes (report creation). The
   *  tenant a report lands in is derived from THIS, not from anything
   *  the app sends in a request body — see the API's
   *  middleware/technicianAuth.ts. */
  token: string;
}

export interface DiagnosticResultInput {
  testId: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'skipped';
  value?: string | number;
  notes?: string;
  source: 'api' | 'manual' | 'ocr';
  timestamp: string;
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

export interface CreateReportInput {
  device: {
    make: string;
    model: string;
    serialNumber: string;
    imei: string;
    imei2?: string;
    captureSource: 'barcode' | 'ocr' | 'manual';
  };
  results: DiagnosticResultInput[];
  profileId?: string;
  routing?: string;
}

export interface CreatedReport {
  reportId: string;
  tenantId: string;
  overallStatus: 'pass' | 'fail' | 'pass_with_warnings';
}

/**
 * The only authenticated write the app makes. Note there is no tenantId
 * parameter by design — the server takes it from the session token, so
 * the app cannot write into the wrong tenant even if it wanted to.
 */
export async function createReport(token: string, input: CreateReportInput): Promise<CreatedReport> {
  const response = await fetch(`${API_BASE_URL}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<CreatedReport>;
}

// ============================================================
// Batch intake — CLAUDE.md "Bulk batch intake". Same authentication
// model as createReport (technician session, tenant taken from the
// token, never from the request body).
// ============================================================

export interface BatchSession {
  batchId: string;
  sourceName: string;
  profileId: string | null;
  status: 'open' | 'closed';
  deviceSerials: string[];
  deviceCount: number;
  createdAt: string;
  closedAt: string | null;
}

export interface BatchScanResult {
  batchId: string;
  serialNumber: string;
  alreadyPresent: boolean;
  deviceCount: number;
}

export async function createBatch(
  token: string,
  input: { sourceName: string; profileId?: string | null },
): Promise<BatchSession> {
  const response = await fetch(`${API_BASE_URL}/batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<BatchSession>;
}

export async function addDeviceToBatch(
  token: string,
  batchId: string,
  serialNumber: string,
): Promise<BatchScanResult> {
  const response = await fetch(`${API_BASE_URL}/batches/${encodeURIComponent(batchId)}/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ serialNumber }),
  });
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<BatchScanResult>;
}

export async function closeBatch(token: string, batchId: string): Promise<BatchSession> {
  const response = await fetch(`${API_BASE_URL}/batches/${encodeURIComponent(batchId)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
  return response.json() as Promise<BatchSession>;
}

export { ApiError };
