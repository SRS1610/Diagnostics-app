// e2e/dispute.mjs — filing a review request, and the hold it must put
// the offer under. CLAUDE.md: "While a dispute is open, the device and
// offer stay on hold" — this proves that's true on the actual screen a
// customer would use to (try to) act around it, not just at the API.

import { CONSUMER_URL, launch, requireServers } from "./harness.mjs";
import { seedReport, seedRealQuote, trackUrl } from "./seed.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nConsumer dispute test\n");

await check("filing a review request holds the offer and disables accept/decline", async () => {
  const { report, adminToken } = await seedReport();
  await seedRealQuote(report, adminToken, "A");
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });

  await page.click('button:has-text("Don\'t agree with the grade?")');
  await page.waitForSelector("text=Request a review");
  await page.selectOption("#subject", "The overall grade");
  await page.fill("#note", "The battery health test seems wrong — it's a new battery.");
  await page.click('button:has-text("Send review request")');

  await page.waitForSelector("text=Your review request is open");
  const acceptBtn = page.locator('button:has-text("Accept offer")');
  if (await acceptBtn.isEnabled()) throw new Error("Accept is still enabled while a review is open");
  const detailRow = await page.locator(".field-row", { hasText: "Review request" }).locator(".v").textContent();
  if (!/open/i.test(detailRow)) throw new Error(`expected the Details card to show the open review, got "${detailRow}"`);
});

await check("Send is disabled until a note is entered", async () => {
  const { report, adminToken } = await seedReport();
  await seedRealQuote(report, adminToken, "A");
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Don\'t agree with the grade?")');
  const sendBtn = page.locator('button:has-text("Send review request")');
  if (await sendBtn.isEnabled()) throw new Error("Send is enabled with no note entered");
});

await check("only one review request can be open at a time", async () => {
  const { report, adminToken } = await seedReport();
  await seedRealQuote(report, adminToken, "A");
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Don\'t agree with the grade?")');
  await page.fill("#note", "First review request.");
  await page.click('button:has-text("Send review request")');
  await page.waitForSelector("text=Your review request is open");

  // The "request a review" link itself disappears once one is open —
  // there is nowhere left in the UI to even attempt a second one.
  if (await page.locator('button:has-text("Don\'t agree with the grade?")').count()) {
    throw new Error("a second review request is still offered while one is already open");
  }
});

await finish();
