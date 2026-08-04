// e2e/billing.mjs — self-serve Stripe billing.
//
// This dev/test environment has no real Stripe account (no
// STRIPE_SECRET_KEY set for the API server that runs the e2e suite),
// which is the realistic default for anyone standing this project up
// without having wired billing yet — the same shape as notifications.ts
// and kycVerification.ts. What this proves is that the portal degrades
// honestly rather than offering a button that silently does nothing:
// clicking "Check out with Stripe" or "Manage billing" must surface a
// clear "not set up yet" message, not a dead click or a raw 501 dump.

import { enterTenant, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal self-serve billing test\n");

await login(page, MASTER);

await check("enter a tenant to reach its Billing page", async () => {
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

await check("the self-serve billing section is offered alongside manual provisioning", async () => {
  await page.goto(`${PORTAL_URL}/billing`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Self-serve billing");
  await page.waitForSelector('button:has-text("Check out with Stripe")');
  await page.waitForSelector('button:has-text("Manage billing")');
});

await check("checkout degrades honestly when Stripe isn't configured", async () => {
  await page.click('button:has-text("Check out with Stripe")');
  await page.waitForSelector("text=/isn't set up for this deployment/i");
});

await check("the billing portal button degrades the same way", async () => {
  await page.click('button:has-text("Manage billing")');
  await page.waitForSelector("text=/billing history yet|isn't set up for this deployment/i");
});

await finish({ allowBrowserErrors: ["501 (Not Implemented)", "404 (Not Found)"] });
