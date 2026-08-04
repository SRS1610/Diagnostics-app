// e2e/mfa.mjs — two-factor authentication, end to end.
//
// Proves the thing a type-checker cannot: that enrolling in MFA in the
// browser actually gates the NEXT login behind a code, that a backup
// code works exactly once, and that disabling it actually turns the
// gate back off. Computes real TOTP codes here (mirroring
// src/lib/totp.ts's algorithm) rather than reading a code off screen —
// there is nowhere to read one from, the same as a real authenticator
// app.
//
// Runs against a throwaway tenant_admin created inside the shared
// "E2E Sandbox" tenant, not against MASTER or the shared tenant admin —
// other suites in this run call login(page, MASTER) with no MFA
// handling, and leaving MFA enabled on a shared account would break
// every suite that runs after this one.

import { createHmac } from "node:crypto";
import { API_URL, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

const stamp = Date.now().toString().slice(-6);
const NEW_USER = `e2e-mfa-${stamp}@example.test`;
const CHOSEN_PASSWORD = `mfa-chosen-passphrase-${stamp}`;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(encoded) {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secretBytes, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secretBytes).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** 6).padStart(6, "0");
}

function totpCode(secret, atMs = Date.now()) {
  const counter = Math.floor(Math.floor(atMs / 1000) / 30);
  return hotp(base32Decode(secret), counter);
}

await requireServers();
const { page, check, finish } = await launch();

console.log("\nPortal two-factor authentication test\n");

await login(page, MASTER);

await check("enter the shared sandbox tenant", async () => {
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const sandbox = await page.$('tr:has-text("E2E Sandbox")');
  const row = sandbox ? 'tr:has-text("E2E Sandbox")' : "tbody tr:first-child";
  await page.click(`${row} >> text=Enter tenant`);
  await page.waitForURL("**/dashboard");
});

let temporaryPassword = "";

await check("create a throwaway admin for this suite", async () => {
  await page.goto(`${PORTAL_URL}/team`, { waitUntil: "domcontentloaded" });
  await page.click("text=Add user");
  await page.fill("input#uemail", NEW_USER);
  await page.selectOption("select#urole", "tenant_admin");
  await page.click('button:has-text("Create user")');
  await page.waitForSelector("text=/Temporary password for/i");
  temporaryPassword = (await page.textContent("code")).trim();
});

await check("sign in as it and set a real password", async () => {
  await login(page, { email: NEW_USER, password: temporaryPassword });
  await page.waitForURL("**/change-password");
  await page.fill("input#current", temporaryPassword);
  await page.fill("input#next", CHOSEN_PASSWORD);
  await page.fill("input#confirm", CHOSEN_PASSWORD);
  await page.click('button:has-text("Set password")');
  await page.waitForSelector("text=/Password changed/i");
});

let secret = "";

await check("Settings shows two-factor authentication as not enabled", async () => {
  await page.goto(`${PORTAL_URL}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Two-factor authentication");
  await page.waitForSelector("text=/Not enabled/i");
});

await check("enrolling shows a setup key and otpauth URI", async () => {
  await page.click('button:has-text("Enable")');
  await page.waitForSelector("text=Setup key");
  const codes = await page.locator("code").allTextContents();
  const candidate = codes.find((c) => /^[A-Z2-7]{16,}$/.test(c.trim()));
  if (!candidate) throw new Error(`no base32 setup key found among: ${JSON.stringify(codes)}`);
  secret = candidate.trim();
});

let backupCodes = [];

await check("confirming with the real TOTP code enables it and shows backup codes", async () => {
  await page.fill("#mfaconfirm", totpCode(secret));
  await page.click('button:has-text("Confirm and enable")');
  await page.waitForSelector("text=/is enabled/i");
  const block = await page.textContent("code");
  backupCodes = block.trim().split("\n").map((c) => c.trim()).filter(Boolean);
  if (backupCodes.length < 5) throw new Error(`too few backup codes shown: ${backupCodes.length}`);
  await page.click('button:has-text("Done")');
});

await check("Settings now shows it enabled", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Two-factor authentication");
  await page.waitForSelector("text=/A code from your authenticator app is required/i");
});

await check("the next login is gated behind a code, not the dashboard", async () => {
  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.fill("input#email", NEW_USER);
  await page.fill("input#password", CHOSEN_PASSWORD);
  await page.click("form.login-card button");
  await page.waitForSelector("text=Two-factor verification");
  if (page.url().includes("dashboard")) throw new Error("landed on the dashboard without a second factor");
});

await check("the real TOTP code completes the login", async () => {
  await page.fill("#mfacode", totpCode(secret));
  await page.click('button:has-text("Verify")');
  await page.waitForURL("**/dashboard");
});

await check("a backup code also completes a login, and only once", async () => {
  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.fill("input#email", NEW_USER);
  await page.fill("input#password", CHOSEN_PASSWORD);
  await page.click("form.login-card button");
  await page.waitForSelector("text=Two-factor verification");

  const code = backupCodes[0];
  await page.fill("#mfacode", code);
  await page.click('button:has-text("Verify")');
  await page.waitForURL("**/dashboard");

  // Same code again, from scratch — must be refused now that it's used.
  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.fill("input#email", NEW_USER);
  await page.fill("input#password", CHOSEN_PASSWORD);
  await page.click("form.login-card button");
  await page.waitForSelector("text=Two-factor verification");
  await page.fill("#mfacode", code);
  await page.click('button:has-text("Verify")');
  await page.waitForSelector(".error-box");
});

await check("disabling requires the password and a code, then turns the gate off", async () => {
  // Finish the still-pending login from the previous check with a fresh
  // real code, so there is a live session to drive the Settings page from.
  await page.fill("#mfacode", totpCode(secret));
  await page.click('button:has-text("Verify")');
  await page.waitForURL("**/dashboard");

  await page.goto(`${PORTAL_URL}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button:has-text("Disable")');
  await page.click('button:has-text("Disable")');
  await page.fill("#mfadispw", CHOSEN_PASSWORD);
  await page.fill("#mfadiscode", totpCode(secret));
  await page.click('button:has-text("Disable two-factor authentication")');
  await page.waitForSelector("text=/Not enabled/i");

  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.fill("input#email", NEW_USER);
  await page.fill("input#password", CHOSEN_PASSWORD);
  await page.click("form.login-card button");
  await page.waitForURL("**/dashboard");
});

await finish({ allowBrowserErrors: ["400 (Bad Request)", "401 (Unauthorized)"] });
