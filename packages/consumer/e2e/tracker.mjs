// e2e/tracker.mjs — the tracker page loads and shows real state.
//
// Covers the properties that matter most for an unauthenticated,
// token-only app: a valid link shows the right device and progress, an
// invalid one fails honestly instead of a blank/broken page, and there
// is no way to reach anyone else's device from here.

import { CONSUMER_URL, launch, requireServers } from "./harness.mjs";
import { seedReport, trackUrl } from "./seed.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nConsumer tracker test\n");

await check("no-token landing page explains there's no sign-in", async () => {
  await page.goto(CONSUMER_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=You'll need your tracking link");
  await page.waitForSelector("text=/There's no sign-in/i");
});

await check("an invalid token fails honestly, not with a blank page", async () => {
  await page.goto(`${CONSUMER_URL}/track/not-a-real-token`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=We couldn't open this link");
});

let report;

await check("a valid token shows the right device and inspection counts", async () => {
  ({ report } = await seedReport());
  await page.goto(trackUrl(CONSUMER_URL, report.consumerToken), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Your trade-in");
  await page.waitForSelector("text=Apple iPhone 13");

  const body = await page.textContent("body");
  if (!/Tests run/.test(body)) throw new Error("inspection summary not shown");
  // Seeded with 2 results: 1 pass, 1 warning (flagged) — see seed.mjs.
  const flaggedRow = await page.locator(".field-row", { hasText: "Flagged" }).locator(".v").textContent();
  if (flaggedRow.trim() !== "1") throw new Error(`expected 1 flagged test, saw "${flaggedRow}"`);
});

await check("the serial and IMEI shown are masked, never the full value", async () => {
  const body = await page.textContent("body");
  if (body.includes(report.serialNumber ?? "")) throw new Error("full serial number leaked to the public tracker");
  if (!/••••/.test(body)) throw new Error("no masked identifier found on the page");
});

await check("a device with no quote yet says the offer is still coming", async () => {
  await page.waitForSelector("text=We'll show your offer here as soon as it's ready.");
});

await check("someone else's report is not reachable from this one's page", async () => {
  // The only navigation this app exposes is the URL itself — there is
  // no list, no search, nothing to click toward another report. This
  // asserts the negative directly: guessing at a neighbouring id 404s
  // rather than resolving to another tenant's device.
  const guessed = report.reportId.slice(0, -4) + "0000";
  await page.goto(`${CONSUMER_URL}/track/${guessed}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=We couldn't open this link");
});

await finish({ allowBrowserErrors: ["404 (Not Found)"] });
