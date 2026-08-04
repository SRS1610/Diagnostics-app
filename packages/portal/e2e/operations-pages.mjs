// e2e/operations-pages.mjs
//
// The five APIs that worked and had no screen: quotes, payouts,
// marketplace listings, invoices, batch intake and warranty claims.
//
// Beyond "does the page render", these check the things the pages exist
// to say out loud — that a seed-priced quote cannot be accepted, and
// that a payout record is not a payment.

import { API_URL, enterTenant, launch, login, MASTER, PORTAL_URL, requireServers, TENANT_NAME } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal operations pages test\n");

await login(page, MASTER);
await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("tbody tr");
await enterTenant(page, TENANT_NAME);

const pages = [
  ["trade-in", /Trade-in/],
  ["invoices", /Invoices/],
  ["batches", /Batch intake/],
  ["warranty", /Warranty claims/],
];

for (const [path, heading] of pages) {
  await check(`/${path} loads, names its tenant, and shows no error`, async () => {
    await page.goto(`${PORTAL_URL}/${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".page-title");

    const title = await page.textContent(".page-title");
    if (!heading.test(title)) throw new Error(`expected ${heading}, got "${title}"`);

    const badge = await page.textContent(".tenant-badge");
    if (!badge.includes(TENANT_NAME)) throw new Error(`tenant badge reads "${badge}"`);

    const error = await page.$(".error-box");
    if (error) throw new Error(`error on screen: ${(await error.textContent()).trim()}`);
  });
}

await check("every new page is reachable from the sidebar", async () => {
  // A page with no route into it may as well not exist.
  const nav = await page.$$eval("nav a, .sidebar a", (as) => as.map((a) => a.getAttribute("href")));
  for (const path of ["/trade-in", "/invoices", "/batches", "/warranty", "/compliance"]) {
    if (!nav.some((href) => href?.endsWith(path))) throw new Error(`no sidebar link to ${path}`);
  }
});

await check("a seed-priced quote is labelled and cannot be accepted", async () => {
  await page.goto(`${PORTAL_URL}/trade-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");

  // CLAUDE.md: the seed price table is illustrative, and varied 2x+
  // between sources. A number that looks like an offer gets treated as
  // one by whoever reads it.
  await page.waitForSelector("text=/illustrative pricing/i");

  const row = page.locator('tr:has-text("illustrative pricing")');
  if ((await row.locator('button:has-text("Accept")').count()) > 0) {
    throw new Error("a seed-priced quote is offered for acceptance");
  }
});

await check("a real-priced quote can be accepted, and then asks for a payout method", async () => {
  // Seeds its own quote rather than relying on one being left over. The
  // first version of this check consumed the only acceptable quote in
  // the tenant, so it passed once and failed on every run after —
  // exactly the isolation trap that bit the dispute check earlier.
  await seedAcceptableQuote(page);
  await page.goto(`${PORTAL_URL}/trade-in`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");

  const acceptable = page.locator("tbody tr", { has: page.locator('button:has-text("Accept")') }).first();
  if ((await acceptable.count()) === 0) throw new Error("no acceptable quote after seeding one");

  await acceptable.locator('button:has-text("Accept")').click();
  await page.waitForSelector('button:has-text("Record payout")');
});

await check("the page says plainly that a payout is not a payment", async () => {
  const body = await page.textContent("body");
  if (!/no payment processor is integrated/i.test(body)) {
    throw new Error("the page does not say that nothing here moves money");
  }
});

await check("recording a payout stores the method", async () => {
  await page.click('button:has-text("Record payout")');
  await page.selectOption("tbody select", "ach");
  await page.waitForSelector("text=/\\bach\\b/i");
});

await check("an invoice can be generated from the active licence", async () => {
  await page.goto(`${PORTAL_URL}/invoices`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-title");
  const button = page.locator('button:has-text("Generate from current licence")');
  if ((await button.count()) === 0) throw new Error("no generate button — is there an active licence?");

  await button.click();
  await page.waitForSelector("tbody tr");
});

await check("invoices state that nothing here charges anyone", async () => {
  const body = await page.textContent("body");
  if (!/does not|not billable|charges a customer/i.test(body)) {
    throw new Error("the invoices page does not disclaim that it collects nothing");
  }
});

await check("a warranty claim can be moved through its statuses", async () => {
  await page.goto(`${PORTAL_URL}/warranty`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  await page.fill("tbody input", "Reproduced the fault; approving.");
  await page.selectOption("tbody select", "investigating");
  await page.waitForSelector("text=/investigating/i");
});

await finish();

/**
 * Creates a genuinely acceptable quote: a real price list entry (not the
 * illustrative seed table) against a report that has no quote yet.
 * Returns quietly if there is already one available to work with.
 */
async function seedAcceptableQuote(page) {
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem("diagnostics.portal.session")).token,
  );
  const authed = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const quotes = await (await fetch(`${API_URL}/quotes`, { headers: authed })).json();
  const usable = quotes.find(
    (q) => !q.accepted && q.priceSource !== "unverified_seed_data" && new Date(q.expiresAt) > new Date(),
  );
  if (usable) return;

  const reports = await (await fetch(`${API_URL}/reports?limit=100`, { headers: authed })).json();
  const quoted = new Set(quotes.map((q) => q.reportId));
  const target = reports.find((r) => !quoted.has(r.reportId));
  if (!target) throw new Error("every report already has a quote — cannot seed a fresh one");

  // A real price list for this model, so the resulting quote is not
  // seed-priced and is therefore acceptable.
  const priced = await fetch(`${API_URL}/quotes/prices`, {
    method: "PUT",
    headers: authed,
    body: JSON.stringify({
      prices: [
        {
          model: target.deviceModel,
          storageGb: 128,
          gradeBasePrices: { A: 500, B: 400, C: 280, D: 120 },
        },
      ],
    }),
  });
  if (!priced.ok) throw new Error(`could not upload a price list: HTTP ${priced.status}`);

  const created = await fetch(`${API_URL}/quotes`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ reportId: target.reportId, grade: "B", storageGb: 128 }),
  });
  if (!created.ok) {
    throw new Error(`could not create a quote: HTTP ${created.status} ${await created.text()}`);
  }
}
