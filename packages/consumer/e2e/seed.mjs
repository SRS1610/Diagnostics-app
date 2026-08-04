// e2e/seed.mjs
//
// This app has no login of its own — every screen is reached by a
// consumerToken, minted by the API when a report is created. These
// helpers create real reports (and, where a test needs one, a real
// quote) through the actual API, the same way a technician's tablet or
// the portal would, rather than writing rows into the database directly.
//
// Uses the seeded Acme Wireless tenant (packages/api/prisma/seed.ts) —
// run `npx prisma db seed` first if this errors on login.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { API_URL } from "./harness.mjs";

const execFileAsync = promisify(execFile);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://diagnostics:diagnostics_dev@localhost:5432/diagnostics_dev";

const ADMIN = { email: "admin@acmewireless.com", password: "changeme123" };
const BADGE_CODE = "TEC-1042";

async function json(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Cached at module scope — every check in a suite that seeds a report
// otherwise re-authenticates as both the admin and the technician, and
// badge login is deliberately rate-limited (20/15min by default, since
// it's the thing a brute-forced PIN+badge guess would hit). A whole e2e
// run seeding a dozen reports must not itself be the thing that trips
// that limit.
let cachedAdminToken = null;
let cachedTechnician = null;

export async function adminLogin() {
  if (cachedAdminToken) return cachedAdminToken;
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  if (!res.ok) throw new Error(`admin login failed: HTTP ${res.status} — did you run \`npx prisma db seed\`?`);
  const body = await json(res);
  cachedAdminToken = body.token;
  return cachedAdminToken;
}

async function technicianLogin(adminToken) {
  if (cachedTechnician) return cachedTechnician;

  const tenant = await (
    await fetch(`${API_URL}/technicians`, { headers: { Authorization: `Bearer ${adminToken}` } })
  ).json();
  const tenantId = tenant[0]?.tenantId;
  if (!tenantId) throw new Error("no seeded technician found — run `npx prisma db seed`");

  const res = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode: BADGE_CODE }),
  });
  if (!res.ok) throw new Error(`technician login failed: HTTP ${res.status}`);
  const body = await json(res);
  cachedTechnician = { token: body.token, tenantId };
  return cachedTechnician;
}

/** Creates a report with a unique serial (so re-runs never collide) and
 *  returns it, including its consumerToken — the credential every
 *  consumer-app page under test needs. */
export async function seedReport(overrides = {}) {
  const adminToken = await adminLogin();
  const { token: techToken, tenantId } = await technicianLogin(adminToken);

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${techToken}` },
    body: JSON.stringify({
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: `E2E-CONSUMER-${stamp}`,
        imei: "356938035643809",
        captureSource: "manual",
      },
      results: [
        { testId: "battery_health", label: "Battery Health", status: "pass", source: "api", timestamp: new Date().toISOString() },
        { testId: "loud_speaker", label: "Speaker", status: "warning", source: "manual", timestamp: new Date().toISOString() },
      ],
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`report creation failed: HTTP ${res.status} — ${await res.text()}`);
  const report = await json(res);
  return { report, adminToken, tenantId };
}

/** Uploads a real price row and quotes the report — the state a "real,
 *  showable" offer needs. Without this, a quote is computed but the API
 *  refuses to let it be accepted (CLAUDE.md: seed pricing is
 *  illustrative, not something a customer should be offered money
 *  against), which is itself a state some tests want to exercise
 *  directly rather than avoid. */
export async function seedRealQuote(report, adminToken, grade = "A") {
  const priced = await fetch(`${API_URL}/quotes/prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      prices: [{ model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 500, B: 400, C: 300, D: 150 } }],
    }),
  });
  if (!priced.ok) throw new Error(`price upload failed: HTTP ${priced.status}`);

  const res = await fetch(`${API_URL}/quotes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ reportId: report.reportId, grade, storageGb: 128 }),
  });
  if (!res.ok) throw new Error(`quote creation failed: HTTP ${res.status} — ${await res.text()}`);
  return json(res);
}

/**
 * A quote priced from the illustrative seed table — CLAUDE.md's
 * "unverified_seed_data" state. The normal POST /quotes route can never
 * produce this (it 422s without a real uploaded price row, and always
 * writes REAL_SOURCE when one exists) — this state only ever arises
 * from a row written outside that route, which is exactly why the
 * accept-time guard exists as a backstop rather than a live check on
 * that route. Reproduced here the same way: a direct insert, via the
 * same `psql` this whole dev/e2e setup already depends on for the
 * Postgres database itself.
 */
export async function seedPendingQuote(report) {
  const sql = `
    INSERT INTO trade_in_quotes
      ("quoteId", "tenantId", "reportId", "deviceModel", grade, "basePrice", deductions, "finalOffer", currency, "expiresAt", "priceSource")
    VALUES
      ('e2eq_' || substr(md5(random()::text), 1, 20), '${report.tenantId}', '${report.reportId}', 'iPhone 13', 'A', 500, '[]'::jsonb, 500, 'USD', now() + interval '7 days', 'unverified_seed_data');
  `;
  await execFileAsync("psql", [DATABASE_URL, "-c", sql]);
}

export function trackUrl(consumerUrl, token) {
  return `${consumerUrl}/track/${token}`;
}
