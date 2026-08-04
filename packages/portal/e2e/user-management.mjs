// e2e/user-management.mjs — provisioning, passwords and revocation.
//
// The end-to-end version of the two defects this feature fixed: a tenant
// nobody could sign into, and portal access that could not be revoked.
// Both are only really proven by driving a second identity through a
// real browser, which is what this does.

import { API_URL, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

const stamp = Date.now().toString().slice(-6);
const NEW_USER = `e2e-user-${stamp}@example.test`;
const CHOSEN_PASSWORD = `chosen-passphrase-${stamp}`;

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal user-management test\n");

await login(page, MASTER);

// Work inside the sandbox tenant the write-flow suite creates.
await check("enter a tenant to manage its users", async () => {
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const sandbox = await page.$('tr:has-text("E2E Sandbox")');
  const row = sandbox ? 'tr:has-text("E2E Sandbox")' : "tbody tr:first-child";
  await page.click(`${row} >> text=Enter tenant`);
  await page.waitForURL("**/dashboard");
});

let temporaryPassword = "";

await check("creating a user shows a one-time password", async () => {
  await page.goto(`${PORTAL_URL}/team`, { waitUntil: "domcontentloaded" });
  await page.click("text=Add user");
  await page.fill("input#uemail", NEW_USER);
  await page.selectOption("select#urole", "tenant_admin");
  await page.click('button:has-text("Create user")');

  await page.waitForSelector("text=/Temporary password for/i");
  temporaryPassword = (await page.textContent("code")).trim();
  if (temporaryPassword.length < 12) throw new Error(`implausible password: "${temporaryPassword}"`);

  const body = await page.textContent("body");
  if (!/will not be shown again/i.test(body)) throw new Error("no warning that the password is shown once");
});

await check("the new account can sign in with it", async () => {
  await login(page, { email: NEW_USER, password: temporaryPassword });
});

await check("and is forced to the password screen before anything else", async () => {
  await page.waitForURL("**/change-password");
  // Deep-linking elsewhere must not escape it.
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/change-password");
});

await check("choosing a password releases the portal", async () => {
  await page.fill("input#current", temporaryPassword);
  await page.fill("input#next", CHOSEN_PASSWORD);
  await page.fill("input#confirm", CHOSEN_PASSWORD);
  await page.click('button:has-text("Set password")');
  await page.waitForSelector("text=/Password changed/i");

  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".tenant-badge");
  if (page.url().includes("change-password")) throw new Error("still trapped on the password screen");
});

await check("the temporary password no longer works", async () => {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: NEW_USER, password: temporaryPassword }),
  });
  if (res.status !== 401) throw new Error(`expected 401 for the old password, got ${res.status}`);
});

await check("deactivating ends an open session on its next request", async () => {
  // Signed in as the new admin in this browser; deactivate them from a
  // separate master session, then keep using the browser's token.
  const masterRes = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: MASTER.email, password: MASTER.password }),
  });
  const { token: masterToken } = await masterRes.json();

  const tenantId = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId,
  );
  const entered = await fetch(`${API_URL}/auth/enter-tenant-view`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
    body: JSON.stringify({ tenantId }),
  });
  const { token: scoped } = await entered.json();

  // A tenant can never be left with no active admin, and this user is
  // currently the only one — so a second is created first. That guard
  // firing here was the test being unrealistic, not the API being wrong.
  const spare = await fetch(`${API_URL}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${scoped}` },
    body: JSON.stringify({ email: `e2e-spare-${stamp}@example.test`, role: "tenant_admin" }),
  });
  if (!spare.ok) throw new Error(`could not create a second admin: HTTP ${spare.status}`);

  const users = await (
    await fetch(`${API_URL}/users`, { headers: { Authorization: `Bearer ${scoped}` } })
  ).json();
  const target = users.find((u) => u.email === NEW_USER);
  if (!target) throw new Error("could not find the user just created");

  const patched = await fetch(`${API_URL}/users/${target.userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${scoped}` },
    body: JSON.stringify({ active: false }),
  });
  if (!patched.ok) throw new Error(`deactivation failed: HTTP ${patched.status}`);

  // The browser still holds a valid, unexpired token. It must stop working.
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login");
});

await finish({ allowBrowserErrors: ["401 (Unauthorized)", "Failed to load resource"] });
