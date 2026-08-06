// packages/mobile/e2e/harness.mjs
//
// The mobile app is React Native — it does not run in a browser, and
// spinning up an iOS Simulator or Android Emulator in CI is an order of
// magnitude more painful than the actual thing worth catching here. So
// this harness is not a UI e2e; it is an INTEGRATION test of the mobile
// app's client-side API surface (packages/mobile/src/api/client.ts)
// against a real running API. The concrete failures it exists to catch:
//
//   - A backend route rename that quietly breaks the mobile app until
//     someone builds the .ipa and notices in QA.
//   - A payload-shape drift between what the API returns and what the
//     mobile Technician / CustomerProfile / LicenseCheckResult
//     interfaces claim.
//   - A tenant-scoping regression on the exact routes the mobile flow
//     is unauthenticated on (badge login, PIN lookup, license check) —
//     these three have the smallest "did I forget the tenant filter"
//     margin in the whole codebase and warrant an end-to-end guard.
//
// Same shape as packages/consumer/e2e/harness.mjs — a tiny check runner
// with pass/fail counts and a non-zero exit on failure. No Playwright:
// there is no browser to drive.
//
// Requires:
//   - The API running at API_URL (default http://localhost:4000)
//   - `npx prisma db seed` has been run, so Acme Wireless / TEC-1042 /
//     PIN 4726 exist. The seed matches packages/consumer/e2e/seed.mjs
//     — same tenant, same badge, so both suites can share one seeded
//     database.

export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const BADGE_CODE = process.env.MOBILE_E2E_BADGE ?? "TEC-1042";
export const PROFILE_PIN = process.env.MOBILE_E2E_PIN ?? "4726";

export async function requireApi() {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error(
      `Cannot reach the API at ${API_URL} (${e.message}).\n` +
        `Start it first:\n` +
        `  npm run dev --workspace=packages/api\n` +
        `and make sure it's been seeded:\n` +
        `  npx --workspace=packages/api prisma db seed\n`,
    );
    process.exit(1);
  }
}

/** Resolves the seeded tenant's ID by asking a route that lists
 *  tenants — the mobile app itself does not know a tenantId ahead of
 *  time (it discovers it by scanning the printed badge/profile QR),
 *  but the e2e harness needs one to hand into the four client calls.
 *  Uses the master admin login rather than embedding a hard-coded
 *  tenantId, so a re-seed with a fresh CUID does not break the suite. */
export async function resolveSeededTenantId() {
  const login = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "master@platform.com", password: "changeme123" }),
  });
  if (!login.ok) {
    throw new Error(
      `master login failed: HTTP ${login.status} — did you run 'npx prisma db seed'?`,
    );
  }
  const { token } = await login.json();
  const tenantsRes = await fetch(`${API_URL}/tenants`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!tenantsRes.ok) throw new Error(`GET /tenants failed: HTTP ${tenantsRes.status}`);
  const tenants = await tenantsRes.json();
  const acme = tenants.find((t) => t.companyName === "Acme Wireless");
  if (!acme) throw new Error("Acme Wireless tenant not found — run 'npx prisma db seed'");
  return acme.tenantId;
}

export function makeRunner(name) {
  const results = { passed: 0, failed: 0 };

  const check = async (label, fn) => {
    try {
      await fn();
      results.passed += 1;
      console.log(`  PASS  ${label}`);
    } catch (e) {
      results.failed += 1;
      const detail = String(e && e.message ? e.message : e).split("\n").slice(0, 4).join("\n        ");
      console.log(`  FAIL  ${label}\n        ${detail}`);
    }
  };

  const finish = () => {
    const ok = results.failed === 0;
    console.log(`\n${ok ? "PASS" : "FAIL"} — ${name}: ${results.passed} passed, ${results.failed} failed`);
    if (!ok) process.exitCode = 1;
    return ok;
  };

  return { check, finish };
}

/** Deep-key assertion the four client-file interfaces would rely on if
 *  they were runtime-checked — a payload-shape drift here (a renamed
 *  field, a null where a string was promised) is exactly the class of
 *  change that would compile cleanly in Node/TypeScript and only blow
 *  up when the actual mobile app tried to read the field. */
export function expectShape(actual, shape, path = "") {
  for (const [key, expected] of Object.entries(shape)) {
    const here = path ? `${path}.${key}` : key;
    const value = actual?.[key];
    if (expected === "string" && typeof value !== "string") {
      throw new Error(`expected ${here} to be a string, got ${typeof value}: ${JSON.stringify(value)}`);
    }
    if (expected === "boolean" && typeof value !== "boolean") {
      throw new Error(`expected ${here} to be a boolean, got ${typeof value}: ${JSON.stringify(value)}`);
    }
    if (expected === "number" && typeof value !== "number") {
      throw new Error(`expected ${here} to be a number, got ${typeof value}: ${JSON.stringify(value)}`);
    }
    if (expected === "string?" && value !== undefined && value !== null && typeof value !== "string") {
      throw new Error(`expected ${here} to be an optional string, got ${typeof value}`);
    }
    if (Array.isArray(expected) && expected[0] === "arrayOf" && !Array.isArray(value)) {
      throw new Error(`expected ${here} to be an array, got ${typeof value}`);
    }
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
