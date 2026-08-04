// e2e/write-flows.mjs — the actions that CHANGE something.
//
// The other two suites navigate and observe. Everything they touch is a
// GET. That left every mutating action in the portal — creating a
// profile, provisioning a licence, resolving a dispute, deactivating a
// technician, creating and suspending a tenant — checked by nothing.
//
// Write flows fail differently from read flows, and worse: a button that
// silently does nothing, a form that reports success while the API
// rejected it, a destructive action with no confirmation, an error the
// user cannot act on. None of those show up in a page that merely loads.
//
// Everything mutating happens inside a dedicated sandbox tenant so a run
// cannot disturb real data — provisioning a licence supersedes whatever
// was active, which is not something to do to a tenant you care about.

import {
  API_URL,
  enterTenant,
  launch,
  login,
  MASTER,
  PORTAL_URL,
  requireServers,
} from "./harness.mjs";

const SANDBOX = "E2E Sandbox";
const stamp = Date.now().toString().slice(-6);

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal write-flow test\n");

await login(page, MASTER);

// ============================================================
// Tenant lifecycle (master_admin)
// ============================================================

await check("creating a tenant adds it to the platform list", async () => {
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");

  const existing = await page.$(`tr:has-text("${SANDBOX}")`);
  if (existing) return; // Idempotent: reuse the sandbox across runs.

  await page.click("text=New Tenant");
  await page.fill("input#company", SANDBOX);
  await page.fill("input#contact", "sandbox@example.test");
  await page.click('button:has-text("Create tenant")');
  await page.waitForSelector(`tr:has-text("${SANDBOX}")`);
});

await check("suspending and reactivating a tenant both take effect", async () => {
  const row = `tr:has-text("${SANDBOX}")`;
  await page.click(`${row} >> text=Suspend`);
  await page.waitForSelector(`${row} >> text=suspended`);

  await page.click(`${row} >> text=Activate`);
  await page.waitForSelector(`${row} >> text=active`);
});

await check("entering the sandbox tenant scopes the portal to it", async () => {
  await enterTenant(page, SANDBOX);
  const badge = await page.textContent(".tenant-badge");
  if (!badge.includes(SANDBOX)) throw new Error(`badge reads "${badge}" after entering ${SANDBOX}`);
});

// ============================================================
// Profiles
// ============================================================

const PIN = `9${stamp.slice(-3)}`;
const PROFILE = `E2E Profile ${stamp}`;

await check("creating a profile succeeds and lists it", async () => {
  await page.goto(`${PORTAL_URL}/profiles`, { waitUntil: "domcontentloaded" });
  await page.click("text=New Profile");
  await page.fill("input#pname", PROFILE);
  await page.fill("input#ppin", PIN);
  await page.click('button:has-text("Create profile")');
  await page.waitForSelector(`tr:has-text("${PROFILE}")`);
});

await check("a duplicate PIN is refused with a message the admin can act on", async () => {
  await page.click("text=New Profile");
  await page.fill("input#pname", `${PROFILE} duplicate`);
  await page.fill("input#ppin", PIN);
  await page.click('button:has-text("Create profile")');

  await page.waitForSelector(".error-box");
  const message = (await page.textContent(".error-box")).toLowerCase();
  // It must name the actual problem. "Request failed (409)" is not
  // something an admin can do anything with.
  if (!/pin/.test(message)) throw new Error(`error does not mention the PIN: "${message}"`);
  await page.click("text=Cancel");
});

await check("the profile QR payload carries the tenant, not just the PIN", async () => {
  // Two tenants can both use PIN 4726; the QR is what tells them apart.
  await page.click(`tr:has-text("${PROFILE}") >> text=QR`);
  await page.waitForSelector("code");
  const payload = await page.textContent("code");
  if (!payload.startsWith("DIAGPROFILE:")) throw new Error(`unexpected payload: ${payload}`);
  if (payload.split(":").length < 3) throw new Error(`payload has no tenant segment: ${payload}`);
  if (!payload.endsWith(`:${PIN}`)) throw new Error(`payload does not end with the PIN: ${payload}`);
  await page.click("text=Close");
});

await check("deleting an unused profile works and takes it off the list", async () => {
  page.once("dialog", (d) => d.accept());
  await page.click(`tr:has-text("${PROFILE}") >> text=Delete`);
  await page.waitForSelector(`tr:has-text("${PROFILE}")`, { state: "detached" });
});

// ============================================================
// Licensing
// ============================================================

await check("provisioning a licence from the Billing page works", async () => {
  await page.goto(`${PORTAL_URL}/billing`, { waitUntil: "domcontentloaded" });
  await page.click("text=New Licence");
  await page.selectOption("select#ltype", "per_inspection");
  await page.fill("input#lstart", "2026-08-01");
  await page.fill("input#lend", "2026-08-31");
  await page.fill("input#lquota", "250");
  await page.click('button:has-text("Provision licence")');

  // The table must show it, and the headline tiles must agree. Captured
  // in one evaluation for the same reason as above — a re-fetch can
  // empty the page between a wait and a read.
  await page.waitForSelector('tbody tr:has-text("per inspection")');
  const tiles = await (
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll(".stat-grid .card")].map((c) =>
        c.textContent.replace(/\s+/g, " ").trim(),
      );
      return cards.length ? cards : null;
    })
  ).jsonValue();
  if (!tiles.some((t) => /250/.test(t))) {
    throw new Error(`the quota just provisioned is not reflected in the tiles: ${tiles.join(" | ")}`);
  }
});

await check("provisioning again leaves exactly one active licence", async () => {
  // A licence supersedes rather than accumulates; two "active" rows
  // would make the session gate ambiguous.
  await page.click("text=New Licence");
  await page.selectOption("select#ltype", "enterprise_unlimited");
  await page.fill("input#lstart", "2026-09-01");
  await page.fill("input#lend", "2026-09-30");
  await page.click('button:has-text("Provision licence")');
  await page.waitForSelector('tbody tr:has-text("enterprise unlimited")');

  // Capture the statuses in the SAME evaluation that waits for them.
  // Waiting and then reading is two separate looks at the DOM, and
  // provisioning triggers a re-fetch that briefly replaces the table
  // with a loading state — so the wait can succeed and the read that
  // follows it still find an empty table. Reading the status BADGES
  // rather than row text also matters: cell text concatenates without
  // separators ("enterprise unlimited" + "active" reads as
  // "unlimitedactive"), which defeats any word-boundary match.
  const statuses = await (
    await page.waitForFunction(() => {
      const badges = [...document.querySelectorAll("tbody tr .badge")].map((b) => b.textContent.trim());
      return badges.length >= 2 ? badges : null;
    })
  ).jsonValue();
  const active = statuses.filter((s) => s === "active").length;
  if (active !== 1) {
    throw new Error(`expected exactly 1 active licence, found ${active} (statuses: ${statuses.join(", ")})`);
  }
});

// ============================================================
// Team
// ============================================================

await check("a technician can be added, then deactivated and reactivated", async () => {
  // Added through the API because the Team page has no create form yet —
  // worth stating rather than pretending the flow is covered.
  const token = await portalTokenFor(page);
  const created = await fetch(`${API_URL}/technicians`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ displayName: `E2E Tech ${stamp}`, badgeCode: `E2E-${stamp}` }),
  });
  if (!created.ok) throw new Error(`could not seed a technician: HTTP ${created.status}`);

  await page.goto(`${PORTAL_URL}/team`, { waitUntil: "domcontentloaded" });
  const row = `tr:has-text("E2E Tech ${stamp}")`;
  await page.waitForSelector(row);

  await page.click(`${row} >> text=Deactivate`);
  await page.waitForSelector(`${row} >> text=deactivated`);

  await page.click(`${row} >> text=Reactivate`);
  await page.waitForSelector(`${row} >> text=active`);
});

// ============================================================
// Disputes — the one write flow with a real consequence
// ============================================================

const REASONING = `Reviewed the original photos; the grade stands. [${stamp}]`;

await check("resolving a dispute requires written reasoning", async () => {
  await seedDispute(page, stamp);

  await page.goto(`${PORTAL_URL}/disputes`, { waitUntil: "domcontentloaded" });

  // Scoped to the dispute THIS run seeded, by the marker in its note.
  // The queue is shared and may hold others — including one left open by
  // an earlier failed run — and a locator that assumes a single row
  // fails for reasons that have nothing to do with the behaviour under
  // test.
  const row = page.locator(`tr:has-text("${stamp}")`);
  await row.waitFor();

  // The action must be unavailable until a reason is written: CLAUDE.md
  // wants the outcome AND the reasoning recorded for audit, and an
  // adjusted grade with no stated reason is unauditable.
  const uphold = row.locator('button:has-text("Uphold grade")');
  if (!(await uphold.isDisabled())) throw new Error("a dispute can be upheld with no reasoning given");

  await row.locator("textarea").fill(REASONING);
  if (await uphold.isDisabled()) throw new Error("reasoning was written but the action stayed disabled");

  await uphold.click();
  // That specific dispute leaves the "needs action" queue.
  await page.waitForFunction(
    (marker) => {
      const open = document.querySelectorAll("textarea");
      return ![...open].some((t) => t.closest("tr")?.textContent.includes(marker));
    },
    stamp,
  );
});

await check("a resolved dispute keeps its reasoning on the record", async () => {
  // Waits rather than reading once: the open queue and the resolved
  // history are separate fetches now, so the row leaving the queue does
  // not mean the resolved list has come back yet.
  await page.waitForFunction((text) => document.body.textContent.includes(text), REASONING);
});

// The duplicate-PIN check deliberately provokes a 409, so the browser
// logging it is the test working rather than a finding. Narrow on
// purpose: any OTHER failed request still fails the run.
await finish({ allowBrowserErrors: ["409 (Conflict)"] });

// ============================================================
// Helpers
// ============================================================

/** Reads the live session token out of the running app, so seeding uses
 *  exactly the tenant the browser is scoped to. */
async function portalTokenFor(page) {
  const raw = await page.evaluate(() => localStorage.getItem("diagnostics.portal.session"));
  if (!raw) throw new Error("no portal session in storage");
  return JSON.parse(raw).token;
}

/** A dispute needs a report to hang off, and a report needs a technician
 *  session — so this walks the real chain rather than writing rows
 *  directly: badge login, submit a report, file a dispute as the
 *  customer through the public tracker. */
async function seedDispute(page, id) {
  const portalToken = await portalTokenFor(page);
  const authed = { "Content-Type": "application/json", Authorization: `Bearer ${portalToken}` };

  const tenantId = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId,
  );

  const badgeCode = `E2E-DISPUTE-${id}`;
  const techRes = await fetch(`${API_URL}/technicians`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ displayName: `E2E Dispute Tech ${id}`, badgeCode }),
  });
  if (!techRes.ok) throw new Error(`seed technician failed: HTTP ${techRes.status}`);

  const loginRes = await fetch(`${API_URL}/technicians/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode }),
  });
  if (!loginRes.ok) throw new Error(`badge login failed: HTTP ${loginRes.status}`);
  const { token: techToken } = await loginRes.json();

  const reportRes = await fetch(`${API_URL}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${techToken}` },
    body: JSON.stringify({
      device: {
        make: "Apple",
        model: "iPhone 13",
        serialNumber: `E2E-${id}`,
        imei: "356938035643809",
        captureSource: "barcode",
      },
      results: [],
    }),
  });
  if (!reportRes.ok) throw new Error(`seed report failed: HTTP ${reportRes.status}`);
  const report = await reportRes.json();

  const disputeRes = await fetch(`${API_URL}/public/track/${report.consumerToken}/dispute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      disputingItem: "The overall grade",
      customerNote: `The screen was undamaged when I sent it in. [${id}]`,
    }),
  });
  if (!disputeRes.ok) throw new Error(`seed dispute failed: HTTP ${disputeRes.status}`);
}
