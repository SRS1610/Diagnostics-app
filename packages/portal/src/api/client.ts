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

/** A page of results plus the counts the API returns in headers. */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
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

/** Same request path, but hands back the headers too. */
async function requestWithHeaders<T>(path: string, init: RequestInit = {}): Promise<{ body: T; headers: Headers }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) {
    onUnauthorized?.();
    throw new ApiError("Your session has expired. Sign in again.", 401);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, response.status);
  }

  return { body: (await response.json()) as T, headers: response.headers };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  /** A list request that also reads the pagination headers. Separate
   *  from get() because most endpoints are small enough not to page, and
   *  a caller that does not need counts should not have to unwrap them.
   *  Falls back to the row count when the headers are absent, so an
   *  un-paginated endpoint still works through this path. */
  getPage: async <T>(path: string): Promise<Page<T>> => {
    const { body, headers } = await requestWithHeaders<T[]>(path);
    const num = (name: string, fallback: number) => {
      const raw = headers.get(name);
      const parsed = raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
      items: body,
      total: num("X-Total-Count", body.length),
      limit: num("X-Limit", body.length),
      offset: num("X-Offset", 0),
      hasMore: headers.get("X-Has-More") === "true",
    };
  },
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /** For file downloads. An <a href> cannot carry the Authorization
   *  header, and putting the token in a query string would write a live
   *  credential into browser history and every proxy log on the way. */
  getBlob: async (path: string): Promise<Blob> => {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}) },
    });
    if (response.status === 401) {
      onUnauthorized?.();
      throw new ApiError("Your session has expired. Sign in again.", 401);
    }
    if (!response.ok) throw new ApiError(`Export failed (${response.status})`, response.status);
    return response.blob();
  },
};

// ============================================================
// Response shapes — mirrors of what the API actually returns.
// ============================================================

export type PortalRole = "master_admin" | "tenant_admin" | "tenant_staff";

export interface LoginResponse {
  token: string;
  user: {
    userId: string;
    email: string;
    role: PortalRole;
    tenantId: string | null;
    /** Set when an admin provisioned or reset this account. The portal
     *  routes straight to the password screen until it is cleared. */
    mustChangePassword?: boolean;
  };
  /** Only present when a backup code was used to complete an MFA login —
   *  the portal's cue to nudge "you're running low", not a routine field. */
  backupCodesRemaining?: number;
}

/** What /auth/login returns for an MFA-enabled account instead of a
 *  session: a short-lived token that only /auth/mfa/verify accepts. */
export interface MfaRequiredResponse {
  mfaRequired: true;
  mfaToken: string;
}

export interface MfaEnrollResponse {
  secret: string;
  /** otpauth:// URI — render as a QR code for an authenticator app. */
  otpauthUri: string;
}

export interface MfaConfirmResponse {
  /** Shown exactly once — the API never returns these again. */
  backupCodes: string[];
  note: string;
}

export interface ApiKeySummary {
  keyId: string;
  name: string;
  keyPrefix: string;
  createdByUserId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreated {
  keyId: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  /** The full key — shown exactly once, at creation. */
  apiKey: string;
  note: string;
}

export interface WebhookEndpointSummary {
  endpointId: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: string;
}

export interface WebhookEndpointCreated extends WebhookEndpointSummary {
  /** The HMAC signing secret — shown exactly once, at creation. */
  secret: string;
  note: string;
}

export interface WebhookDeliveryRecord {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  statusCode: number | null;
  succeeded: boolean;
  error: string | null;
  attemptedAt: string;
}

export interface PortalUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: PortalRole;
  tenantId: string | null;
  active: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Tenant {
  tenantId: string;
  companyName: string;
  status: string;
  primaryContactEmail: string;
  createdAt: string;
}

/** The tenant's own settings — distinct from Tenant above, which is the
 *  Master Console's cross-tenant view. minPinLength and requirePurgeWipe
 *  are enforced server-side (profile PIN validation, wipe-certificate
 *  recording), not just stored. */
export interface OrgSettings {
  tenantId: string;
  companyName: string;
  primaryContactEmail: string;
  minPinLength: number;
  requirePurgeWipe: boolean;
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
  /** The customer's tracker capability. Optional because the list
   *  endpoint may omit it; the detail endpoint returns it. */
  consumerToken?: string;
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
  /** False once revoked. Deactivation replaces deletion for anyone who
   *  has inspected a device, so that their attribution survives. */
  active: boolean;
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
