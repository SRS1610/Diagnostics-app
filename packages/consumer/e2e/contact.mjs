// e2e/contact.mjs — self-service contact capture ("Get updates"),
// wired to notificationDelivery.ts on the API side. Optional by design:
// this proves the form is offered, that submitting it actually
// persists (survives a reload), and that it steps out of the way once
// at least one channel is on file rather than nagging on every visit.

import { CONSUMER_URL, launch, requireServers } from "./harness.mjs";
import { seedReport, trackUrl } from "./seed.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nConsumer contact-capture test\n");

await check("the Get updates card is offered when no contact info is on file", async () => {
  const { report } = await seedReport();
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Get updates");
  await page.waitForSelector('button:has-text("Save")');
  const saveBtn = page.locator('button:has-text("Save")');
  if (await saveBtn.isEnabled()) throw new Error("Save is enabled with both fields empty");
});

await check("submitting an email replaces the form with a confirmation, and it survives a reload", async () => {
  const { report } = await seedReport();
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', "updates@example.test");
  await page.click('button:has-text("Save")');

  await page.waitForSelector("text=We'll send updates to your email");
  if (await page.locator('div.card-title:has-text("Get updates")').count()) {
    throw new Error("the Get updates form is still shown after contact info was saved");
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=We'll send updates to your email");
});

await check("submitting a malformed email shows an inline error, not a silent failure", async () => {
  const { report } = await seedReport();
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  // Has an "@" (so the browser's own native type="email" validation
  // lets it through) but no TLD dot, which the API's stricter EMAIL_RE
  // rejects — this is what actually reaches the app's own error
  // handling rather than being blocked by the browser first.
  await page.fill('input[type="email"]', "test@nodot");
  await page.click('button:has-text("Save")');
  await page.waitForSelector(".error-box");
  // Still on the form — nothing was silently accepted.
  await page.waitForSelector('button:has-text("Save")');
});

await check("providing only a phone number is accepted on its own", async () => {
  const { report } = await seedReport();
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.fill('input[type="tel"]', "+15551234567");
  await page.click('button:has-text("Save")');
  await page.waitForSelector("text=We'll send updates to your phone");
});

// The malformed-email check deliberately provokes a 400, which the
// browser logs as a failed resource load — not a finding.
await finish({ allowBrowserErrors: ["400 (Bad Request)"] });
