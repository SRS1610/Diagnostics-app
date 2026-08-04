// e2e/harness.mjs
//
// The smallest thing that can drive a real browser against a real API —
// same reasoning as packages/portal/e2e/harness.mjs: this app has no
// server-rendering and no login to type-check its way past a real
// rendering bug, so a browser is what actually proves a page works.
//
// Run against the BUILT bundle (npm run preview), not the dev server:
// that is what ships.

import { chromium } from "playwright-core";

export const CONSUMER_URL = process.env.CONSUMER_URL ?? "http://localhost:4174";
export const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** Finds a Chromium to drive. Same resolution order as the portal's
 *  harness — see that file's comment for why this is worth doing
 *  explicitly rather than letting playwright-core fail with a generic
 *  "browser not found" the first time someone runs this cold. */
async function resolveChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` : null,
    "/opt/pw-browsers/chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

export async function launch() {
  const results = { passed: 0, failed: 0 };
  const browserErrors = [];

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: await resolveChromium(),
      args: ["--no-sandbox"],
    });
  } catch (e) {
    if (/Executable doesn't exist|Failed to launch/i.test(e.message)) {
      console.error(
        `\nNo Chromium available to run these checks.\n\n` +
          `  npm run e2e:install --workspace=packages/consumer\n\n` +
          `installs one (~120 MB, once). If you already have a Chromium or Chrome,\n` +
          `point at it instead:\n\n` +
          `  CHROMIUM_PATH=/path/to/chrome npm run test:e2e --workspace=packages/consumer\n`,
      );
      process.exit(1);
    }
    throw e;
  }
  const page = await browser.newPage();
  page.setDefaultTimeout(Number(process.env.E2E_TIMEOUT ?? 8000));

  // A page error or a console error is a failure in its own right — see
  // the portal harness for why: a React crash caught by an error
  // boundary can leave a plausible-looking screen behind it.
  page.on("pageerror", (e) => browserErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") browserErrors.push(`console: ${m.text()}`);
  });

  const check = async (name, fn) => {
    try {
      await fn(page);
      results.passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      results.failed += 1;
      const detail = e.message.split("\n").slice(0, 4).join("\n        ");
      console.log(`  FAIL  ${name}\n        ${detail}`);
      const file = `/tmp/e2e-fail-consumer-${name.replace(/\W+/g, "-").slice(0, 60)}.png`;
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

export async function requireServers() {
  const targets = [
    ["API", `${API_URL}/health`],
    ["consumer app", CONSUMER_URL],
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
          `  npm run build --workspace=packages/consumer && npm run preview --workspace=packages/consumer -- --port 4174\n`,
      );
      process.exit(1);
    }
  }
}
