// e2e/smoke.mjs — does the portal actually work, end to end?
//
// Covers the paths a person takes on their first five minutes in the
// portal, plus the two access rules that are not obvious from the UI:
// a master_admin must pick a tenant before any tenant-scoped page will
// work, and every tenant-scoped page must say which tenant is in scope.
//
// Each page is reached by a FULL PAGE LOAD rather than by clicking
// through, on purpose. Client-side navigation keeps the session in
// memory and hides an entire class of bug — the portal once dropped a
// valid session on every refresh, and clicking around never showed it.

import { enterTenant, launch, login, MASTER, requireServers, TENANT_NAME, PORTAL_URL, TENANT_ADMIN } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal smoke test\n");

await check("login page renders", async () => {
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input#email");
});

await check("master_admin lands on the Master Console, not a tenant page", async () => {
  await login(page, MASTER);
  await page.waitForURL("**/master");
  await page.waitForSelector(`text=${TENANT_NAME}`);
});

await check("the Master Console is unmistakably a platform-wide context", async () => {
  // A superuser view that looks like a tenant view is how someone acts
  // in the wrong context without noticing.
  const body = await page.textContent("body");
  if (!/ALL TENANTS/i.test(body)) throw new Error("no platform-wide banner on the Master Console");
  if (await page.$(".tenant-badge")) throw new Error("a tenant badge is showing on a cross-tenant page");
});

await check("a master_admin with no tenant chosen is sent to pick one", async () => {
  // Every tenant-scoped API call would 400 without a tenant in scope,
  // so the portal must not render a page that can only fail.
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/master");
});

await check("entering a tenant reaches the dashboard", async () => {
  await enterTenant(page);
});

const TENANT_PAGES = [
  ["dashboard", /Dashboard/i],
  ["reports", /Reports/i],
  ["devices", /Devices/i],
  ["batches", /Batch intake/i],
  ["trade-in", /Trade-in/i],
  ["warranty", /Warranty claims/i],
  ["invoices", /Invoices/i],
  ["compliance", /Compliance/i],
  ["profiles", /Test Profiles/i],
  ["disputes", /Disputes/i],
  ["billing", /Billing/i],
  ["team", /Team/i],
  ["activity", /Activity Log/i],
  ["settings", /Settings/i],
];

for (const [path, heading] of TENANT_PAGES) {
  await check(`/${path} loads, names its tenant, and shows no error`, async () => {
    await page.goto(`${PORTAL_URL}/${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".page-title");

    const title = await page.textContent(".page-title");
    if (!heading.test(title)) throw new Error(`expected a "${heading}" heading, got "${title}"`);

    // The tenant indicator has to be on every tenant-scoped page —
    // that is the whole point of putting it in the shell.
    const badge = await page.textContent(".tenant-badge");
    if (!badge.includes(TENANT_NAME)) throw new Error(`tenant badge reads "${badge}"`);

    const error = await page.$(".error-box");
    if (error) throw new Error(`error on screen: ${(await error.textContent()).trim()}`);
  });
}

await check("a report opens from the list", async () => {
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody a");
  await page.click("tbody a");
  await page.waitForURL(/\/reports\/.+/);
  await page.waitForSelector("text=/Device identity/i");
});

await check("the customer tracker link stays hidden until asked for", async () => {
  // It is a capability — anyone holding it can act on the customer's
  // offer — so it must not be sitting on screen on a shared terminal.
  const body = await page.textContent("body");
  if (/\/track\//.test(body)) throw new Error("the tracker link is visible without being requested");
  await page.click("text=Show link");
  await page.waitForSelector("text=/\\/track\\//");
});

await check("device history opens and shows its inspections", async () => {
  await page.goto(`${PORTAL_URL}/devices`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody a");
  await page.click("tbody a");
  await page.waitForURL(/\/devices\/.+/);
  await page.waitForSelector("text=/inspection/i");
});

await check("leaving the tenant returns to the Master Console", async () => {
  await page.goto(`${PORTAL_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.click("text=/Exit tenant/i");
  await page.waitForURL("**/master");
});

await check("a signed-in session survives a full page reload", async () => {
  // The regression this exists for: the auth token was installed in an
  // effect that ran AFTER child pages had already fired their fetches,
  // so the first request went out unauthenticated, took a 401, and
  // bounced a perfectly valid session back to the login screen. It
  // type-checked and built cleanly.
  await login(page, TENANT_ADMIN);
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tenant-badge");
  if (page.url().includes("/login")) throw new Error("reloading logged the user out");
});

await finish();
