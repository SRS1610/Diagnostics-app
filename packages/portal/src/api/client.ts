// src/api/client.ts
//
// Every call to the API goes through here, and every call carries the
// session token. That is deliberate and load-bearing.
//
// CLAUDE.md is explicit that the tenant-indicator badge is "a VISUAL
// convention, not a real data guarantee ... each page's actual
// data-fetching logic still needs to filter by session.viewingTenantId
// server-side". The API does enforce that (middleware/tenantScope.ts),
// but only for requests that arrive authenticated. A single fetch that
// forgets the header is not a leak — it is a 401 — so the failure mode
// is loud rather than silent, and routing every request through one
// function is what keeps it that way.
//
// This is also why the portal is a client-rendered SPA rather than
// using server components: a server component fetching data outside the
// user's session is the one shape where a query could run without the
// caller's tenant context, and that is precisely the risk this codebase
// is built around avoiding.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let currentToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null) {
  currentToken = token;
}

/** Lets the session layer react to an expired token without every page
 *  handling 401 individually. */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) {
    // The token is gone or expired. Surface it once, centrally, rather
    // than leaving stale data on screen behind a silent failure.
    onUnauthorized?.();
    throw new ApiError("Your session has expired. Sign in again.", 401);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body; keep the status-based message */
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ============================================================
// Response shapes — mirrors of what the API actually returns.
// ============================================================

export type PortalRole = "master_admin" | "tenant_admin" | "tenant_staff";

export interface LoginResponse {
  token: string;
  user: { userId: string; email: string; role: PortalRole; tenantId: string | null };
}

export interface Tenant {
  tenantId: string;
  companyName: string;
  status: string;
  primaryContactEmail: string;
  createdAt: string;
}

export interface Report {
  reportId: string;
  tenantId: string;
  profileId: string | null;
  technicianId: string | null;
  generatedAt: string;
  deviceMake: string;
  deviceModel: string;
  serialNumber: string;
  imei: string;
  captureSource: string;
  results: DiagnosticResult[];
  overallStatus: "pass" | "fail" | "pass_with_warnings";
  routing: string | null;
}

export interface DiagnosticResult {
  testId: string;
  label: string;
  status: "pass" | "fail" | "warning" | "skipped";
  value?: string | number;
  notes?: string;
  source: "api" | "manual" | "ocr";
  timestamp: string;
}

export interface CustomerProfile {
  profileId: string;
  tenantId: string;
  customerName: string;
  pin: string;
  enabledTestIds: string[];
  updatedAt: string;
}

export interface Technician {
  technicianId: string;
  tenantId: string;
  displayName: string;
  badgeCode: string;
  createdAt: string;
}

export interface License {
  licenseId: string;
  tenantId: string;
  type: string;
  status: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  includedQuota: number | null;
  usageThisPeriod: number;
  seatLimit: number | null;
  activeSeats: number;
}

export interface ActivityLogEntry {
  entryId: string;
  tenantId: string | null;
  actorUserId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  details: string | null;
  timestamp: string;
}

export interface Dispute {
  disputeId: string;
  tenantId: string;
  reportId: string;
  disputingItem: string;
  customerNote: string;
  status: string;
  resolutionNotes: string | null;
  submittedAt: string;
  resolvedAt: string | null;
}
