// e2e/harness.mjs
//
// The smallest thing that can drive a real browser against a real API.
//
// Deliberately not a test framework. These checks exist because the
// portal's worst failures are ones that a type-checker and a unit test
// both pass cleanly: the session bug that logged users out on every
// refresh type-checked and built fine, and the dashboard that reported a
// failed fetch as "0 disputes awaiting review" was correct TypeScript
// rendering a wrong claim. Catching those needs a browser, a live API
// and an assertion about what a human would read on the screen.
//
// Run against the BUILT bundle (npm run preview), not the dev server:
// that is what ships, and it is where the session bug appeared.

import { chromium } from "playwright-core";

export const PORTAL_URL = process.env.PORTAL_URL ?? "http://localhost:4173";
export const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** Seeded logins (packages/api/prisma/seed.ts). Override for a database
 *  seeded differently. */
export const MASTER = {
  email: process.env.MASTER_EMAIL ?? "master@platform.com",
  password: process.env.PORTAL_PASSWORD ?? "changeme123",
};
export const TENANT_ADMIN = {
  email: process.env.TENANT_EMAIL ?? "admin@acmewireless.com",
  password: process.env.PORTAL_PASSWORD ?? "changeme123",
};
export const TENANT_NAME = process.env.TENANT_NAME ?? "Acme Wireless";

/**
 * Finds a Chromium to drive.
 *
 * playwright-core deliberately ships NO browsers — it is the library
 * without the downloader — so on a fresh checkout there may be nothing
 * to launch. Left alone it fails with a stack trace and a banner telling
 * you to run `npx playwright install`, which installs a different
 * package's browsers and is not the command this project wants. Hence
 * resolving explicitly and failing with something you can act on.
 *
 * Order: an explicit CHROMIUM_PATH, then the managed container's
 * pre-installed copy, then wherever a local `playwright install` put one.
 */
async function resolveChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` : null,
    "/opt/pw-browsers/chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  // Nothing explicit found. Returning undefined lets playwright-core try
  // its own default location, which is where `npm run e2e:install` puts
  // a browser — so this is the normal path on a developer machine, not a
  // failure.
  return undefined;
}

export async function launch() {
  const results = { passed: 0, failed: 0 };
  const browserErrors = [];

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: await resolveChromium(),
      // Required when running as root, which is the case in most
      // containers and in this project's managed environment.
      args: ["--no-sandbox"],
    });
  } catch (e) {
    if (/Executable doesn't exist|Failed to launch/i.test(e.message)) {
      console.error(
        `\nNo Chromium available to run these checks.\n\n` +
          `  npm run e2e:install --workspace=packages/portal\n\n` +
          `installs one (~120 MB, once). If you already have a Chromium or Chrome,\n` +
          `point at it instead:\n\n` +
          `  CHROMIUM_PATH=/path/to/chrome npm run test:e2e --workspace=packages/portal\n`,
      );
      process.exit(1);
    }
    throw e;
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT ?? 8000));

  // A page error or a console error is a failure in its own right, even
  // if every assertion passes — a React crash caught by an error
  // boundary can leave a plausible-looking screen behind.
  page.on("pageerror", (e) => browserErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") browserErrors.push(`console: ${m.text()}`);
  });

  /** Runs one named check. Never throws: a failure is recorded and the
   *  run continues, because one broken page should not hide the state
   *  of the other nine. */
  const check = async (name, fn) => {
    try {
      await fn(page);
      results.passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      results.failed += 1;
      // Several lines, not one: Playwright puts the failing selector on
      // the line AFTER "Timeout exceeded", so truncating to the first
      // line throws away the only part that says what went wrong.
      const detail = e.message.split("\n").slice(0, 4).join("\n        ");
      console.log(`  FAIL  ${name}\n        ${detail}`);
      const file = `/tmp/e2e-fail-${name.replace(/\W+/g, "-").slice(0, 60)}.png`;
      await page.screenshot({ path: file }).catch(() => {});
      console.log(`        screenshot: ${file}`);
    }
  };

  const finish = async ({ allowBrowserErrors = [] } = {}) => {
    const unexpected = browserErrors.filter((e) => !allowBrowserErrors.some((allowed) => e.includes(allowed)));
    if (unexpected.length) {
      console.log(`\n  Browser errors:\n${unexpected.map((e) => "        " + e).join("\n")}`);
    }
    await browser.close();
    const ok = results.failed === 0 && unexpected.length === 0;
    console.log(`\n${ok ? "PASS" : "FAIL"} — ${results.passed} passed, ${results.failed} failed`);
    if (!ok) process.exitCode = 1;
    return ok;
  };

  return { browser, page, check, finish };
}

async function fileExists(path) {
  try {
    const { access } = await import("node:fs/promises");
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Signs in and lands wherever that role belongs — the Master Console
 *  for a master_admin, the dashboard for a tenant user.
 *
 *  Signs out first. An already-authenticated browser is redirected
 *  straight past the login form, so without this a second login() in the
 *  same run silently keeps the FIRST user's session — and the check that
 *  follows reports a confusing missing-selector failure instead of
 *  "you are still signed in as someone else". */
export async function login(page, { email, password }) {
  await logout(page);
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input#email");
  await page.fill("input#email", email);
  await page.fill("input#password", password);
  await page.click("form.login-card button");
  await page.waitForURL(/\/(master|dashboard)$/);
}

/** Clears the stored session. Goes through the origin first because
 *  localStorage is per-origin and is not reachable before a navigation. */
export async function logout(page) {
  if (!page.url().startsWith(PORTAL_URL)) {
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  }
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/** Drops a master_admin into one tenant's portal. */
export async function enterTenant(page, companyName = TENANT_NAME) {
  await page.click(`tr:has-text("${companyName}") >> text=Enter tenant`);
  await page.waitForURL("**/dashboard");
}

/** Fails loudly if the servers this suite needs are not up, rather than
 *  reporting ten confusing assertion failures. */
export async function requireServers() {
  const targets = [
    ["API", `${API_URL}/health`],
    ["portal", PORTAL_URL],
  ];
  for (const [name, url] of targets) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.error(
        `Cannot reach the ${name} at ${url} (${e.message}).\n` +
          `Start both first:\n` +
          `  npm run dev --workspace=packages/api\n` +
          `  npm run build --workspace=packages/portal && npm run preview --workspace=packages/portal\n`,
      );
      process.exit(1);
    }
  }
}
