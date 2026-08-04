// e2e/integrations.mjs — API keys and webhooks, end to end.
//
// The API-level tests (apiKeys.test.ts, webhooks.test.ts) already prove
// the server-side contracts in isolation. This proves the PORTAL side:
// that a key created on screen actually authenticates a real request,
// that a webhook registered through the form actually gets a real HTTP
// delivery a locally-run receiver can observe, and that the Deliveries
// panel a technician-facing admin would check reflects that truthfully.
//
// Runs inside the shared "E2E Sandbox" tenant. Keys/endpoints created
// here are tenant-scoped and timestamped, so re-runs don't collide.

import http from "node:http";
import { API_URL, enterTenant, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

const stamp = Date.now().toString().slice(-6);

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/hook`, received, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal integrations (API keys, webhooks) test\n");

await login(page, MASTER);

await check("enter the shared sandbox tenant", async () => {
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const sandbox = await page.$('tr:has-text("E2E Sandbox")');
  if (sandbox) {
    await enterTenant(page, "E2E Sandbox");
  } else {
    await page.click("tbody tr:first-child >> text=Enter tenant");
    await page.waitForURL("**/dashboard");
  }
});

let apiKey = "";
let keyId = "";

await check("creating an API key shows the full key once", async () => {
  await page.goto(`${PORTAL_URL}/integrations`, { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("New key")');
  await page.fill("#keyname", `E2E Integration ${stamp}`);
  await page.click('button:has-text("Create key")');
  await page.waitForSelector("text=/^API key /");
  // Scoped to the issued-key banner specifically — the table below can
  // already contain other keys' <code> prefix cells by the time this
  // suite re-runs, and a bare "code" selector would grab whichever one
  // comes first in the DOM rather than the banner's.
  apiKey = (await page.locator('.card:has(strong:has-text("API key ")) code').textContent()).trim();
  if (!apiKey.startsWith("dgk_live_")) throw new Error(`unexpected key format: "${apiKey}"`);
  await page.click('button:has-text("Done")');

  await page.waitForSelector(`tr:has-text("E2E Integration ${stamp}")`);
});

await check("the key actually authenticates /v1", async () => {
  const res = await fetch(`${API_URL}/v1/reports`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`expected the key to work, got HTTP ${res.status}`);
});

await check("revoking it in the UI stops it working immediately", async () => {
  const row = page.locator(`tr:has-text("E2E Integration ${stamp}")`);
  page.once("dialog", (d) => d.accept());
  await row.locator('button:has-text("Revoke")').click();
  await page.waitForSelector(`tr:has-text("E2E Integration ${stamp}") >> text=suspended`);

  const res = await fetch(`${API_URL}/v1/reports`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status !== 401) throw new Error(`expected a revoked key to be refused (401), got ${res.status}`);
  void keyId;
});

const receiver = await startReceiver();

await check("registering a webhook shows the signing secret once", async () => {
  await page.click('button:has-text("New endpoint")');
  await page.fill("#whurl", receiver.url);
  await page.click('label:has-text("report.created") input[type="checkbox"]');
  await page.click('button:has-text("Register endpoint")');
  await page.waitForSelector("text=/Webhook registered for/");
  const secret = (
    await page.locator('.card:has(strong:has-text("Webhook registered for")) code').textContent()
  ).trim();
  if (!secret.startsWith("whsec_")) throw new Error(`unexpected secret format: "${secret}"`);
  await page.click('button:has-text("Done")');
  await page.waitForSelector(`tr:has-text("${receiver.url}")`);
});

await check("a matching event is actually delivered to the receiver", async () => {
  // Seed a technician + report the same way settings.mjs does — the
  // wipe-certificate/report-creation endpoints are mobile-only.
  const tenantId = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId,
  );
  const portalToken = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).token,
  );
  const badgeCode = `INTEG-E2E-${stamp}`;
  const tech = await fetch(`${API_URL}/technicians`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalToken}` },
    body: JSON.stringify({ displayName: "Integrations E2E Tech", badgeCode }),
  });
  if (!tech.ok) throw new Error(`could not seed a technician: HTTP ${tech.status}`);

  const techLoginRes = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode }),
  });
  const { token: techToken } = await techLoginRes.json();

  const report = await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${techToken}` },
    body: JSON.stringify({
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: `INTEG-E2E-${stamp}`,
        imei: "356938035643809",
        captureSource: "barcode",
      },
      results: [],
    }),
  });
  if (!report.ok) throw new Error(`could not seed a report: HTTP ${report.status}`);

  // Dispatch is fire-and-forget from the route's perspective.
  await new Promise((r) => setTimeout(r, 400));
  if (receiver.received.length === 0) throw new Error("the receiver never got a delivery");
  const payload = JSON.parse(receiver.received[0]);
  if (payload.eventType !== "report.created") throw new Error(`unexpected event type: ${payload.eventType}`);
});

await check("the Deliveries panel shows the successful attempt", async () => {
  const row = page.locator(`tr:has-text("${receiver.url}")`);
  await row.locator('button:has-text("Deliveries")').click();
  await page.waitForSelector("text=report.created");
  const body = await page.textContent("body");
  if (!/HTTP 200/.test(body)) throw new Error("delivery history does not show a successful HTTP 200 attempt");
});

await check("deactivating the endpoint stops further delivery", async () => {
  const row = page.locator(`tr:has-text("${receiver.url}")`);
  await row.locator('button:has-text("Deactivate")').click();
  await page.waitForSelector(`tr:has-text("${receiver.url}") >> text=deactivated`);

  const before = receiver.received.length;
  const badgeCode = `INTEG-E2E-2-${stamp}`;
  const portalToken = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).token,
  );
  const tenantId = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId,
  );
  await fetch(`${API_URL}/technicians`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${portalToken}` },
    body: JSON.stringify({ displayName: "Integrations E2E Tech 2", badgeCode }),
  });
  const techLoginRes = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode }),
  });
  const { token: techToken } = await techLoginRes.json();
  await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${techToken}` },
    body: JSON.stringify({
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: `INTEG-E2E-2-${stamp}`,
        imei: "356938035643809",
        captureSource: "barcode",
      },
      results: [],
    }),
  });
  await new Promise((r) => setTimeout(r, 400));
  if (receiver.received.length !== before) throw new Error("a deactivated endpoint still received a delivery");
});

await receiver.close();

await finish({ allowBrowserErrors: ["401 (Unauthorized)"] });
