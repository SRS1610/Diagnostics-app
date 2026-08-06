// packages/mobile/e2e/apiClient.mjs
//
// Exercises every endpoint in packages/mobile/src/api/client.ts against
// a real API server, in the order the mobile app actually uses them:
//
//   Step 1 (Technician Login)  -> loginTechnician
//   Step 2 (Scan Profile)      -> resolveProfileByPin
//   Step 3 (License Check)     -> checkTenantLicense
//   Later (Session end)        -> createReport
//
// Plus one negative case per stage — the payload-shape and tenant-
// scoping properties that unit tests cover per-route, verified here
// end-to-end against a running server so a mobile-visible break can't
// hide behind a green unit-test suite.

import { API_URL, BADGE_CODE, PROFILE_PIN, assertEqual, expectShape, makeRunner, requireApi, resolveSeededTenantId } from "./harness.mjs";

await requireApi();
const tenantId = await resolveSeededTenantId();

const { check, finish } = makeRunner("mobile api client");
console.log(`\nmobile api client checks — against ${API_URL}`);

// ------------------------------------------------------------------
// Step 1 — Technician Login (badge scan)
// ------------------------------------------------------------------

let techToken;
let techTenantId;

await check("loginTechnician returns Technician shape with a token", async () => {
  const res = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode: BADGE_CODE }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  expectShape(body, {
    technicianId: "string",
    tenantId: "string",
    displayName: "string",
    companyName: "string",
    token: "string",
  });
  assertEqual(body.tenantId, tenantId, "response tenantId");
  techToken = body.token;
  techTenantId = body.tenantId;
});

await check("loginTechnician with wrong badge returns 404 with a generic error", async () => {
  const res = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode: "TEC-NONEXISTENT-XYZ" }),
  });
  assertEqual(res.status, 404, "status");
  const body = await res.json();
  // Same message for "not found" vs "deactivated" — see the technicians
  // route header: distinguishing them would turn this unauthenticated
  // endpoint into a badge-code enumeration oracle.
  if (typeof body.error !== "string" || !body.error) {
    throw new Error(`missing error message in body: ${JSON.stringify(body)}`);
  }
});

// ------------------------------------------------------------------
// Step 2 — Scan Profile QR (or manual PIN entry fallback)
// ------------------------------------------------------------------

let profileId;

await check("resolveProfileByPin returns CustomerProfile scoped to this tenant", async () => {
  const res = await fetch(
    `${API_URL}/profiles/tenants/${encodeURIComponent(techTenantId)}/profiles/by-pin/${encodeURIComponent(PROFILE_PIN)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  expectShape(body, {
    profileId: "string",
    tenantId: "string",
    customerName: "string",
    pin: "string",
    enabledTestIds: ["arrayOf"],
  });
  assertEqual(body.tenantId, techTenantId, "profile tenantId matches technician's tenant");
  profileId = body.profileId;
});

await check("resolveProfileByPin under a bogus tenant returns 404 (never leaks another tenant's PIN)", async () => {
  const res = await fetch(
    `${API_URL}/profiles/tenants/bogus-tenant-id-that-does-not-exist/profiles/by-pin/${encodeURIComponent(PROFILE_PIN)}`,
  );
  // Must not be 200 — the whole point of `tenantId:pin` encoding on the
  // profile QR is that the same PIN under a different tenant is a
  // different record. A 200 here would mean the route walked the wrong
  // side of the join and matched by PIN alone.
  if (res.status === 200) throw new Error("expected 4xx for wrong-tenant PIN, got 200 — cross-tenant leak");
});

// ------------------------------------------------------------------
// Step 3 — License Check (gate before diagnostics start)
// ------------------------------------------------------------------

await check("checkTenantLicense returns LicenseCheckResult with a boolean allowed", async () => {
  const res = await fetch(`${API_URL}/licenses/tenants/${encodeURIComponent(techTenantId)}/check`);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  // allowed is required; reason + remainingQuota are conditional.
  if (typeof body.allowed !== "boolean") {
    throw new Error(`expected .allowed to be boolean, got ${typeof body.allowed}`);
  }
  if (!body.allowed && typeof body.reason !== "string") {
    throw new Error("blocked license responses must include a reason string");
  }
});

// ------------------------------------------------------------------
// Session end — createReport (only authenticated write the app makes)
// ------------------------------------------------------------------

await check("createReport writes into the technician's tenant (not the request body's)", async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${techToken}` },
    body: JSON.stringify({
      // Deliberately send a bogus tenantId in the body — the API must
      // ignore it and take the tenant from the session token. This is
      // the single most important scoping invariant the mobile app
      // depends on, so it belongs in the e2e alongside the shape check.
      tenantId: "some-other-tenant",
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: `E2E-MOBILE-${stamp}`,
        imei: "356938035643809",
        captureSource: "manual",
      },
      profileId,
      results: [
        {
          testId: "battery_health",
          label: "Battery Health",
          status: "pass",
          source: "api",
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  expectShape(body, { reportId: "string", tenantId: "string", overallStatus: "string" });
  assertEqual(body.tenantId, techTenantId, "report landed in the technician's tenant");
  if (!["pass", "fail", "pass_with_warnings"].includes(body.overallStatus)) {
    throw new Error(`unexpected overallStatus: ${body.overallStatus}`);
  }
});

await check("createReport without a token returns 401", async () => {
  const res = await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: "SHOULD-NOT-PERSIST",
        imei: "356938035643809",
        captureSource: "manual",
      },
      results: [],
    }),
  });
  assertEqual(res.status, 401, "status");
});

finish();
