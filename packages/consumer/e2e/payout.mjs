// e2e/payout.mjs — choosing how to get paid, and the honesty rule
// around it: CLAUDE.md is explicit that no payment provider moves money
// here yet, and the tracker must say so plainly rather than let a
// "pending" payout read as money already on its way.

import { CONSUMER_URL, launch, requireServers } from "./harness.mjs";
import { seedReport, seedRealQuote, trackUrl } from "./seed.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nConsumer payout test\n");

async function acceptedOffer() {
  const { report, adminToken } = await seedReport();
  await seedRealQuote(report, adminToken, "A");
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Accept offer")');
  await page.waitForSelector('button:has-text("Choose how to get paid")');
  return report;
}

await check("choosing a method records it and states plainly that nothing was charged", async () => {
  await acceptedOffer();
  await page.click('button:has-text("Choose how to get paid")');
  await page.waitForSelector("text=How would you like to be paid?");

  await page.click('button.method:has-text("Bank transfer")');
  await page.click('button:has-text("Confirm")');

  await page.waitForSelector("text=Payout method chosen. The store will confirm once it's processed.");
  const detailRow = await page.locator(".field-row", { hasText: "Payout method" }).locator(".v").textContent();
  if (!/ach/i.test(detailRow)) throw new Error(`expected "ach" recorded, got "${detailRow}"`);

  await page.waitForSelector("text=/Payment processing is not yet connected/i");
});

await check("a method can only be chosen once, even after a reload", async () => {
  await acceptedOffer();
  await page.click('button:has-text("Choose how to get paid")');
  await page.click('button.method:has-text("PayPal")');
  await page.click('button:has-text("Confirm")');
  await page.waitForSelector("text=Payout method chosen");

  // Reloading re-fetches from the server rather than trusting local
  // state — if the API itself allowed a second payout for this quote,
  // the "Choose how to get paid" button would reappear here.
  await page.reload({ waitUntil: "domcontentloaded" });
  if (await page.locator('button:has-text("Choose how to get paid")').count()) {
    throw new Error("payout selection is still offered after a method was already chosen");
  }
});

await check("Confirm is disabled until a method is selected", async () => {
  await acceptedOffer();
  await page.click('button:has-text("Choose how to get paid")');
  const confirmBtn = page.locator('button:has-text("Confirm")');
  if (await confirmBtn.isEnabled()) throw new Error("Confirm is enabled with no method chosen");
});

await finish();
