// src/api.ts
//
// The consumer app talks to exactly one part of the API: /public/track.
// It holds no session, no login and no token in storage — the token is
// in the URL, because the URL IS the credential. Everything follows from
// that:
//
//  - Nothing is written to localStorage or sessionStorage. A shared or
//    borrowed phone must not leave a trade-in link behind it, and there
//    is nothing to persist anyway.
//  - The token is never sent anywhere but this API's own origin.
//  - This is a SEPARATE app from packages/portal rather than extra
//    routes inside it, so a consumer page and a staff session can never
//    share an origin, a bundle, or a storage area.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Deduction {
  reason: string;
  amount: number;
}

export interface TrackerView {
  device: {
    make: string;
    model: string;
    serialNumberMasked: string | null;
    imeiMasked: string | null;
  };
  inspection: {
    inspectedAt: string;
    overallStatus: "pass" | "fail" | "pass_with_warnings";
    testsRun: number;
    testsPassed: number;
    testsFlagged: number;
    testsSkipped: number;
  };
  dataErasure: { wipedAt: string; standard: string; certificateId: string } | null;
  offer: {
    grade: string;
    amount: number | null;
    basePrice: number | null;
    deductions: Deduction[];
    /** How much of the deductions the zero floor absorbed. Non-zero
     *  means the deductions came to more than the base price. */
    deductionsCappedBy: number;
    currency: string;
    expiresAt: string;
    expired: boolean;
    accepted: boolean;
    acceptedAt: string | null;
    declinedAt: string | null;
    unavailableReason: string | null;
    payout: {
      method: string;
      status: string;
      initiatedAt: string;
      completedAt: string | null;
      note: string;
    } | null;
  } | null;
  dispute: { status: string; submittedAt: string; disputingItem: string } | null;
  onHold: boolean;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    // The API writes these messages for the customer to read directly
    // ("This offer has expired. Contact the store for a new one."), so
    // they are surfaced as-is rather than replaced with a generic one.
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : "Something went wrong. Please try again.";
    throw new ApiError(message, response.status);
  }

  return body as T;
}

const base = (token: string) => `/public/track/${encodeURIComponent(token)}`;

export const trackerApi = {
  get: (token: string) => call<TrackerView>(base(token)),
  acceptOffer: (token: string) => call<TrackerView>(`${base(token)}/offer/accept`, { method: "POST" }),
  declineOffer: (token: string) => call<TrackerView>(`${base(token)}/offer/decline`, { method: "POST" }),
  choosePayout: (token: string, method: string) =>
    call<TrackerView>(`${base(token)}/payout`, { method: "POST", body: JSON.stringify({ method }) }),
  fileDispute: (token: string, disputingItem: string, customerNote: string) =>
    call<TrackerView>(`${base(token)}/dispute`, {
      method: "POST",
      body: JSON.stringify({ disputingItem, customerNote }),
    }),
};

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // An unrecognised currency code must not blank out the amount.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
