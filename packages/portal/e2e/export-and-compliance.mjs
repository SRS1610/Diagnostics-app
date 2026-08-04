// e2e/export-and-compliance.mjs
//
// Downloads are the one thing a browser test can check that an API test
// cannot: whether the button actually produces a file. The download path
// is also unusual — an <a href> cannot carry an Authorization header, so
// the file is fetched through the API client and handed over as a blob,
// and that plumbing is worth exercising rather than assuming.

import { enterTenant, launch, login, MASTER, PORTAL_URL, requireServers, TENANT_NAME } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal export and compliance test\n");

await login(page, MASTER);
await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("tbody tr");
await enterTenant(page, TENANT_NAME);

await check("the compliance page loads with a routing breakdown", async () => {
  await page.goto(`${PORTAL_URL}/compliance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Device routing");
  const body = await page.textContent("body");
  for (const label of ["Resold", "Repaired", "Recycled", "Held — ineligible"]) {
    if (!body.includes(label)) throw new Error(`missing routing row: ${label}`);
  }
});

await check("unrouted devices are shown rather than hidden", async () => {
  // The number most likely to be quietly dropped to make a chart tidy.
  await page.waitForSelector("text=/No routing decision recorded/i");
});

await check("exporting the compliance summary downloads a CSV", async () => {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button:has-text("Export summary (CSV)")'),
  ]);
  const name = download.suggestedFilename();
  if (!name.endsWith(".csv")) throw new Error(`unexpected filename: ${name}`);

  const stream = await download.createReadStream();
  const text = await new Promise((resolve, reject) => {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  // The period has to be in the file, or someone files a fortnight's
  // figures as a year's.
  if (!/Period start/.test(text)) throw new Error("the export does not state its period");
  if (!/Routing decision/.test(text)) throw new Error("the export has no routing section");
});

await check("exporting inspections downloads a CSV with the right columns", async () => {
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button:has-text("Export CSV")'),
  ]);

  const stream = await download.createReadStream();
  const text = await new Promise((resolve, reject) => {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  if (!/Serial number/.test(text)) throw new Error("no header row in the export");
  // A spreadsheet is the most forwarded artefact this system makes.
  if (/consumerToken/i.test(text)) throw new Error("the export contains a consumer capability token");
});

await check("an export honours the filter that is on screen", async () => {
  await page.fill("input#rsearch", "SEEDED-042");
  await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click('button:has-text("Export CSV")'),
  ]);
  const stream = await download.createReadStream();
  const text = await new Promise((resolve, reject) => {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });

  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  // Header plus exactly the one matching row — an export that ignored
  // the filter would answer a different question than the one on screen.
  if (lines.length !== 2) throw new Error(`expected 1 data row, got ${lines.length - 1}`);
  if (!/SEEDED-042/.test(text)) throw new Error("the filtered device is missing from its own export");
});

await finish();
