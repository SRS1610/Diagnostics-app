// e2e/offer.mjs — the offer panel, including the one rule CLAUDE.md is
// most emphatic about: "NEVER SHOW A NUMBER THE BUSINESS CANNOT
// HONOUR." A quote computed from the illustrative seed price table
// must render as "Pending", not as a number with nothing behind it —
// and once a real quote exists, the number shown must match the
// breakdown underneath it.

import { CONSUMER_URL, launch, requireServers } from "./harness.mjs";
import { seedPendingQuote, seedReport, seedRealQuote, trackUrl } from "./seed.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nConsumer offer test\n");

await check("a quote computed from illustrative pricing shows Pending, not a number", async () => {
  const { report } = await seedReport();
  await seedPendingQuote(report);

  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".offer-amount");
  const amountText = await page.locator(".offer-amount").first().textContent();
  if (amountText.trim() !== "Pending") throw new Error(`expected "Pending", got "${amountText}"`);
  await page.waitForSelector("text=/awaiting confirmed pricing/i");

  // The button exists (so the layout doesn't jump once a real offer
  // lands) but must not be clickable against a number that cannot be
  // honoured.
  const acceptBtn = page.locator('button:has-text("Accept offer")');
  if (await acceptBtn.isEnabled()) throw new Error("Accept is enabled against an unshowable offer");
});

await check("a real, priced offer shows the amount and its breakdown", async () => {
  // No flagged results here (unlike the default seed) — a clean device
  // has no deductions, so base price and final offer are the same
  // number and the assertion isn't coupled to computeTradeInQuote's
  // deduction table.
  const { report, adminToken } = await seedReport({ results: [] });
  await seedRealQuote(report, adminToken, "A");

  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".offer-amount");
  const amountText = await page.locator(".offer-amount").first().textContent();
  if (!amountText.includes("500")) throw new Error(`expected $500 with no deductions, got "${amountText}"`);

  await page.waitForSelector("text=Base price (Grade A)");
  await page.waitForSelector("text=Total offer");
});

await check("declining the offer updates the status and removes the accept/decline row", async () => {
  const { report, adminToken } = await seedReport({ results: [] });
  await seedRealQuote(report, adminToken, "A");
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });

  await page.click('button:has-text("Decline")');
  await page.waitForSelector("text=You declined this offer");
  // Settled — the whole accept/decline row is removed, not disabled.
  if (await page.locator('button:has-text("Accept offer")').count()) {
    throw new Error("Accept/Decline row still present after declining");
  }
});

await check("accepting an offer moves the tracker to the Accepted stage", async () => {
  const { report, adminToken } = await seedReport();
  const quote = await seedRealQuote(report, adminToken, "B");
  void quote;

  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Accept offer")');
  await page.waitForSelector("text=Offer accepted. Choose how you'd like to be paid.");
  await page.waitForSelector('button:has-text("Choose how to get paid")');

  // Re-clicking is not possible — the accept/decline row disappears
  // once the offer is settled, not merely disabled.
  const acceptBtn = page.locator('button:has-text("Accept offer")');
  if (await acceptBtn.count()) throw new Error("Accept/Decline row still present after acceptance");
});

await finish();
