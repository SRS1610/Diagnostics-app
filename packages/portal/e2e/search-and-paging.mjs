// e2e/search-and-paging.mjs
//
// The lists that grow without bound were capped at the 50 most recent
// with no way to reach anything older and no way to look anything up.
// These drive the controls that replaced that, against a tenant with
// enough inspections to need more than one page.

import { enterTenant, launch, login, MASTER, PORTAL_URL, requireServers, TENANT_NAME } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal search and paging test\n");

await login(page, MASTER);
await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("tbody tr");
await enterTenant(page, TENANT_NAME);

const rowCount = () => page.$$eval("tbody tr", (rs) => rs.length);
const firstSerial = () => page.$eval("tbody tr td:nth-child(2)", (td) => td.textContent.trim());

await check("the reports list shows a page, not everything", async () => {
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const rows = await rowCount();
  if (rows !== 25) throw new Error(`expected a 25-row page, got ${rows}`);
});

await check("it states the range and the true total", async () => {
  const text = await page.textContent(".pager");
  // "1–25 of 70" — the total is what tells someone there is more.
  if (!/1–25 of \d{2,}/.test(text)) throw new Error(`unexpected pager text: "${text}"`);
});

await check("Next moves to genuinely different rows", async () => {
  const before = await firstSerial();
  await page.click('button:has-text("Next")');
  await page.waitForFunction(
    (prev) => document.querySelector("tbody tr td:nth-child(2)")?.textContent.trim() !== prev,
    before,
  );
  const after = await firstSerial();
  if (after === before) throw new Error("Next did not change the page");
});

await check("Previous returns to where it started", async () => {
  await page.click('button:has-text("Previous")');
  await page.waitForFunction(() => /^1–/.test(document.querySelector(".pager")?.textContent ?? ""));
});

await check("searching a serial finds exactly that device", async () => {
  await page.fill("input#rsearch", "SEEDED-042");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
  const serial = await firstSerial();
  if (serial !== "SEEDED-042") throw new Error(`found "${serial}" instead`);
});

await check("a search with no matches says so rather than showing an empty table", async () => {
  await page.fill("input#rsearch", "NOTHING-MATCHES-THIS");
  await page.waitForSelector("text=/No inspections match/i");
});

await check("filtering by outcome returns only that outcome", async () => {
  await page.fill("input#rsearch", "");
  await page.click('button:has-text("Failed")');
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length > 0);
  const statuses = await page.$$eval("tbody tr .badge", (bs) => bs.map((b) => b.textContent.trim()));
  const wrong = statuses.filter((s) => s !== "fail");
  if (wrong.length) throw new Error(`non-failed rows under the Failed filter: ${wrong.join(", ")}`);
});

await check("changing a filter returns to the first page", async () => {
  // Otherwise an offset from the previous filter lands past the end of
  // the new one and reads as "no results".
  await page.click('button:has-text("All")');
  await page.waitForFunction(() => /^1–/.test(document.querySelector(".pager")?.textContent ?? ""));
});

await check("the devices page can find a device by serial", async () => {
  await page.goto(`${PORTAL_URL}/devices`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  await page.fill("input#dsearch", "SEEDED-051");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);
});

await check("the activity log pages too", async () => {
  await page.goto(`${PORTAL_URL}/activity`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const rows = await rowCount();
  if (rows > 50) throw new Error(`activity log returned ${rows} rows in one go`);
});

await finish();
