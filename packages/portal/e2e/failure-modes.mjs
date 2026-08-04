// e2e/failure-modes.mjs — what does the portal say when things break?
//
// The smoke suite checks the portal works. This one checks it does not
// LIE when it doesn't, which turned out to be the harder property.
//
// The bug that motivated this file: with every request failing, the
// dashboard rendered "0 Disputes awaiting review" as a confident fact.
// An open dispute holds a device and its payout, so a spurious zero
// tells an admin there is nothing to action when there may be a queue.
// Nothing was broken in a way any other kind of test would notice — the
// page rendered perfectly, it was just wrong.
//
// The rule these encode: a number nobody can stand behind must not be
// displayed as a number, and "we could not load this" must never be
// rendered the same as "there is nothing here".

import { API_URL, enterTenant, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal failure-mode test\n");

await login(page, MASTER);
await enterTenant(page);

// Every matcher below is built against the API's ORIGIN, never a bare
// path glob. A pattern like "**/reports*" also matches the portal's own
// navigation to /reports, so it takes down the page load itself — which
// tests the browser's error page rather than the portal's behaviour when
// an API call fails. Cost me three confusing failures.
// Memoised, and that matters: page.unroute() identifies a handler by the
// IDENTITY of the matcher it was registered with, so returning a fresh
// closure per call means unroute silently removes nothing and the
// handlers pile up. That is what made a later check log itself out — a
// 401 stub from an earlier check was still live.
const matchers = new Map();
const apiRoute = (path) => {
  if (!matchers.has(path)) matchers.set(path, (url) => url.href.startsWith(`${API_URL}${path}`));
  return matchers.get(path);
};

/** Makes matching API requests fail the way a flaky network does. */
const breakRequests = async (...paths) => {
  for (const path of paths) await page.route(apiRoute(path), (route) => route.abort());
};
const healRequests = async (...paths) => {
  for (const path of paths) await page.unroute(apiRoute(path));
};

await check("the dashboard refuses to report a failed fetch as zero", async () => {
  await breakRequests("/reports", "/disputes");
  await page.goto(`${PORTAL_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stat-grid .card");
  await page.waitForTimeout(1200);

  const tiles = await page.$$eval(".stat-grid .card", (cards) =>
    cards.map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  );

  const zeroed = tiles.filter((t) => /^0\D/.test(t));
  if (zeroed.length) {
    throw new Error(`a failed request is being shown as a real count: ${zeroed.join(" | ")}`);
  }
  if (!tiles.every((t) => t.includes("—"))) {
    throw new Error(`expected every tile to read "—": ${tiles.join(" | ")}`);
  }
  await healRequests("/reports", "/disputes");
});

await check("a failed list shows an error, never an empty state", async () => {
  // "You have no reports" and "we could not load your reports" must not
  // look the same — in a multi-tenant system the first is a dangerous
  // thing to say by accident.
  await breakRequests("/reports");
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".error-box");

  const body = await page.textContent("body");
  if (/No reports yet/i.test(body)) throw new Error("a failed load is being presented as an empty tenant");
  await healRequests("/reports");
});

await check("the Devices repeat-inspection count is not invented when the fetch fails", async () => {
  // A repeat inspection with a worsening grade is the signal this page
  // exists to surface, so a fabricated "0" here suppresses exactly the
  // thing a human is meant to act on.
  await breakRequests("/reports");
  await page.goto(`${PORTAL_URL}/devices`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".stat-grid .card");
  await page.waitForTimeout(1200);

  const tiles = await page.$$eval(".stat-grid .card", (cards) =>
    cards.map((c) => c.textContent.replace(/\s+/g, " ").trim()),
  );
  if (tiles.some((t) => /^0\D/.test(t))) throw new Error(`fabricated count: ${tiles.join(" | ")}`);
  await healRequests("/reports");
});

await check("an expired session lands on the login page, not a blank screen", async () => {
  await page.route(apiRoute("/reports"), (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"expired"}' }),
  );
  await page.goto(`${PORTAL_URL}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/login");
  await page.unroute(apiRoute("/reports"));
});

await check("a 500 surfaces the failure rather than rendering a plausible empty page", async () => {
  await page.route(apiRoute("/disputes"), (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Internal server error"}' }),
  );
  await login(page, MASTER);
  await enterTenant(page);
  await page.goto(`${PORTAL_URL}/disputes`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".error-box");

  const body = await page.textContent("body");
  if (/Nothing awaiting review/i.test(body)) {
    throw new Error("a server error is being shown as an empty dispute queue");
  }
  await page.unroute(apiRoute("/disputes"));
});

// The 401 and 500 checks deliberately provoke failed requests, so the
// browser logging them is expected rather than a finding.
await finish({ allowBrowserErrors: ["Failed to load resource", "net::ERR_FAILED"] });
