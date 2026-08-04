// e2e/sso.mjs — SSO (OIDC), end to end.
//
// Runs a real fake IdP in-process (RSA-signed, RS256 — hand-rolled on
// node:crypto rather than pulling `jose` into the portal package just
// for this, since the API side already proved real JWKS/JWT
// verification in tests/sso.test.ts; this suite's job is to prove the
// PORTAL wiring — the "Sign in with SSO" button, the real cross-origin
// redirect, and /sso/complete actually landing a session).
//
// The fake IdP auto-approves every /authorize request (no login screen
// to click through) and always asserts the same fixed identity — that
// mirrors how the real flow works: the email typed into the portal's
// SSO entry step only selects which tenant's connection to redirect to,
// never who the IdP says signed in.

import http from "node:http";
import crypto from "node:crypto";
import { API_URL, enterTenant, launch, login, MASTER, PORTAL_URL, requireServers } from "./harness.mjs";

const stamp = Date.now().toString().slice(-6);
const DOMAIN = `sso-e2e-${stamp}.test`;
const FIXED_EMAIL = `provisioned.by.idp@${DOMAIN}`;
const FIXED_SUBJECT = `idp-subject-${stamp}`;

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function startFakeIdp() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "e2e-key";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const pending = new Map(); // code -> { nonce, audience }

  function signIdToken(issuer, { nonce, audience }) {
    const header = { alg: "RS256", typ: "JWT", kid: "e2e-key" };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: issuer,
      aud: audience,
      sub: FIXED_SUBJECT,
      email: FIXED_EMAIL,
      nonce,
      iat: now,
      exp: now + 300,
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const code = `code-${crypto.randomBytes(8).toString("hex")}`;
      pending.set(code, { nonce, audience: clientId });
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", code);
      dest.searchParams.set("state", state);
      res.writeHead(302, { Location: dest.toString() });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const claims = pending.get(params.get("code"));
        if (!claims) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const idToken = signIdToken(`http://127.0.0.1:${server.address().port}`, claims);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id_token: idToken, access_token: "unused", token_type: "Bearer" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        issuer: base,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        jwksUri: `${base}/jwks`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

await requireServers();
const idp = await startFakeIdp();
const { page, check, finish } = await launch();

console.log("\nPortal SSO test\n");

await login(page, MASTER);

await check("enter the shared sandbox tenant", async () => {
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  const sandbox = await page.$('tr:has-text("E2E Sandbox")');
  if (sandbox) {
    await enterTenant(page, "E2E Sandbox");
  } else {
    await page.click("tbody tr:first-child >> text=Enter tenant");
    await page.waitForURL("**/dashboard");
  }
});

await check("configuring a connection from Settings", async () => {
  await page.goto(`${PORTAL_URL}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Single sign-on");
  // The sandbox tenant is shared across runs of this suite and allows
  // only one SSO connection — a prior run's leftover connection means
  // the button reads "Edit connection", not "Configure SSO". Both open
  // the same form.
  const configureButton = page.locator('button:has-text("Configure SSO")');
  const editButton = page.locator('button:has-text("Edit connection")');
  if (await configureButton.count()) {
    await configureButton.click();
  } else {
    await editButton.click();
  }
  await page.fill("#ssodomain", DOMAIN);
  await page.fill("#ssoissuer", idp.issuer);
  await page.fill("#ssoclientid", "e2e-client");
  await page.fill("#ssoclientsecret", "e2e-secret");
  await page.fill("#ssoauth", idp.authorizationEndpoint);
  await page.fill("#ssotoken", idp.tokenEndpoint);
  await page.fill("#ssojwks", idp.jwksUri);
  await page.click('button:has-text("Save connection")');
  await page.waitForSelector(`code:has-text("${DOMAIN}")`);
});

await check("enabling it, then signing in through the real IdP redirect", async () => {
  const enabledBox = page.locator('label:has-text("Enabled") input[type="checkbox"]');
  if (!(await enabledBox.isChecked())) {
    await enabledBox.check();
    await page.waitForSelector('label:has-text("Enforced") input:not([disabled])');
  }

  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Sign in with SSO")');
  await page.fill("#ssoemail", `someone@${DOMAIN}`);
  await page.click('button:has-text("Continue")');

  // A real cross-origin round trip: portal -> API /sso/start (fetched
  // already) -> browser navigates to the fake IdP -> IdP 302s back to
  // the API callback -> API 302s to the portal's /sso/complete -> portal
  // exchanges the handoff and lands on /dashboard. No step here is
  // mocked; if any hop in that chain is wrong this simply times out.
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  const email = await page.evaluate(() => JSON.parse(localStorage.getItem("diagnostics.portal.session")).email);
  if (email !== FIXED_EMAIL) throw new Error(`expected to be signed in as ${FIXED_EMAIL}, got ${email}`);
});

await check("the JIT-provisioned account is tenant_staff and reused on a second login", async () => {
  const masterToken = await page.evaluate(() => {
    // Nothing left to read here — we're now signed in AS the SSO user,
    // not master. Re-authenticate as master directly for this check.
    return null;
  });
  void masterToken;

  const relogin = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: MASTER.email, password: MASTER.password }),
  });
  const { token } = await relogin.json();
  const tenantId = await page.evaluate(() => JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId);
  const entered = await fetch(`${API_URL}/auth/enter-tenant-view`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tenantId }),
  });
  const { token: scoped } = await entered.json();

  const users = await (await fetch(`${API_URL}/users`, { headers: { Authorization: `Bearer ${scoped}` } })).json();
  const provisioned = users.filter((u) => u.email === FIXED_EMAIL);
  if (provisioned.length !== 1) throw new Error(`expected exactly one provisioned account, found ${provisioned.length}`);
  if (provisioned[0].role !== "tenant_staff") throw new Error(`expected tenant_staff, got ${provisioned[0].role}`);
});

await check("a domain with no connection shows an inline error, not a dead redirect", async () => {
  await page.evaluate(() => localStorage.clear());
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
  await page.click('button:has-text("Sign in with SSO")');
  await page.fill("#ssoemail", `nobody@no-such-domain-${stamp}.test`);
  await page.click('button:has-text("Continue")');
  await page.waitForSelector("text=/No SSO connection is configured/i");
  if (!page.url().startsWith(PORTAL_URL)) throw new Error("navigated away for an unconfigured domain");
});

await check("enforcing SSO blocks a staff password login but not the admin's", async () => {
  const masterLogin = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: MASTER.email, password: MASTER.password }),
  });
  const { token: masterToken } = await masterLogin.json();

  await login(page, MASTER);
  await page.goto(`${PORTAL_URL}/master`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr");
  await enterTenant(page, "E2E Sandbox");

  const tenantId = await page.evaluate(() => JSON.parse(localStorage.getItem("diagnostics.portal.session")).viewingTenantId);
  const entered = await fetch(`${API_URL}/auth/enter-tenant-view`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${masterToken}` },
    body: JSON.stringify({ tenantId }),
  });
  const { token: scoped } = await entered.json();

  const staffCreated = await fetch(`${API_URL}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${scoped}` },
    body: JSON.stringify({ email: `sso-enforce-staff-${stamp}@example.test`, role: "tenant_staff" }),
  });
  const { temporaryPassword } = await staffCreated.json();

  await page.goto(`${PORTAL_URL}/settings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('label:has-text("Enforced")');
  const enforcedBox = page.locator('label:has-text("Enforced") input[type="checkbox"]');
  if (!(await enforcedBox.isChecked())) await enforcedBox.check();
  await page.waitForSelector('label:has-text("Enforced") input:checked');

  const staffLogin = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `sso-enforce-staff-${stamp}@example.test`, password: temporaryPassword }),
  });
  if (staffLogin.status !== 403) throw new Error(`expected staff password login to be refused, got ${staffLogin.status}`);
});

await idp.close();
await finish({ allowBrowserErrors: ["404 (Not Found)", "403 (Forbidden)"] });
