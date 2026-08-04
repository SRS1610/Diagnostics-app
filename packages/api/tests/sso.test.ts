// tests/sso.test.ts
//
// SSO (OIDC): a real in-process IdP (fakeIdp.ts), a real HTTP round trip
// for the token exchange and JWKS fetch, and real RS256 signature
// verification — not mocks of jose or of fetch. The properties that
// matter most for an authentication path: a token from the wrong key,
// the wrong issuer, or a mismatched nonce must all be rejected, a second
// login by the same person must not create a second account, and one
// tenant's domain can never let another tenant's users sign in.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";
import { FakeIdp, signWithWrongKey, startFakeIdp } from "./fakeIdp";

let app: Express;
let fx: Fixtures;
let idp: FakeIdp;

beforeAll(async () => {
  app = createApp();
  idp = await startFakeIdp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
});

afterAll(async () => {
  await idp.close();
  await resetDatabase();
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const CONNECTION_BODY = (domainSuffix: string) => ({
  domain: `sso-${domainSuffix}.test`,
  issuer: idp.issuer,
  clientId: `client-${domainSuffix}`,
  clientSecret: `secret-${domainSuffix}`,
  authorizationEndpoint: `${idp.issuer}/authorize`,
  tokenEndpoint: idp.tokenEndpoint,
  jwksUri: idp.jwksUri,
});

async function configureAndEnable(token: string, domainSuffix: string) {
  const created = await request(app).post("/sso").set(auth(token)).send(CONNECTION_BODY(domainSuffix));
  expect(created.status).toBe(201);
  const enabled = await request(app).patch("/sso").set(auth(token)).send({ enabled: true });
  expect(enabled.status).toBe(200);
  return created.body;
}

/** Runs a full start -> callback -> exchange login and returns the
 *  resulting session (or the callback's redirect Location, on failure,
 *  for tests that want to inspect the error). */
async function loginViaSso(email: string, claimOverrides: Partial<{ sub: string; audience: string; nonce: string }> = {}) {
  const start = await request(app).post("/auth/sso/start").send({ email });
  if (start.status !== 200) return { start };

  const url = new URL(start.body.authorizationUrl);
  const state = url.searchParams.get("state")!;
  const nonce = claimOverrides.nonce ?? url.searchParams.get("nonce")!;
  const clientId = url.searchParams.get("client_id")!;

  const code = `code-${Math.random().toString(36).slice(2)}`;
  await idp.registerToken(code, {
    sub: claimOverrides.sub ?? email,
    email,
    nonce,
    audience: claimOverrides.audience ?? clientId,
  });

  const callback = await request(app).get(`/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`);
  return { start, callback };
}

async function exchangeHandoff(location: string) {
  const handoff = new URL(location, "http://portal.test").searchParams.get("handoff")!;
  return request(app).post("/auth/sso/exchange").send({ handoff });
}

describe("configuring a connection", () => {
  it("admin-only, and clientSecret is never returned", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const created = await configureAndEnable(token, "alpha1");
    expect(JSON.stringify(created)).not.toContain("secret-alpha1");

    const fetched = await request(app).get("/sso").set(auth(token));
    expect(fetched.status).toBe(200);
    expect(fetched.body.hasClientSecret).toBe(true);
    expect(JSON.stringify(fetched.body)).not.toContain("secret-alpha1");
  });

  it("refuses tenant_staff", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const staffCreated = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "sso-staff@alpha.test", role: "tenant_staff" });
    const staffLogin = await request(app)
      .post("/auth/login")
      .send({ email: "sso-staff@alpha.test", password: staffCreated.body.temporaryPassword });

    const res = await request(app).post("/sso").set(auth(staffLogin.body.token)).send(CONNECTION_BODY("staffcheck"));
    expect(res.status).toBe(403);
  });

  it("a domain already used by another tenant is refused", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(alphaToken, "shared");

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).post("/sso").set(auth(betaToken)).send(CONNECTION_BODY("shared"));
    expect(res.status).toBe(409);
  });

  it("cannot enforce SSO before it is enabled", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).post("/sso").set(auth(token)).send(CONNECTION_BODY("noenable"));
    const res = await request(app).patch("/sso").set(auth(token)).send({ enforced: true });
    expect(res.status).toBe(400);
  });
});

describe("logging in via SSO", () => {
  it("a first login JIT-provisions a tenant_staff account", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(token, "jit");

    const email = `new.hire@sso-jit.test`;
    const { callback } = await loginViaSso(email, { sub: "idp-subject-1" });
    expect(callback!.status).toBe(302);
    expect(callback!.headers.location).toContain("/sso/complete?handoff=");

    const exchanged = await exchangeHandoff(callback!.headers.location);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.user.email).toBe(email);
    expect(exchanged.body.user.role).toBe("tenant_staff");
    expect(exchanged.body.user.tenantId).toBe(fx.alpha.tenantId);
  });

  it("a second login by the same subject reuses the same account", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(token, "reuse");
    const email = "repeat@sso-reuse.test";

    const first = await loginViaSso(email, { sub: "idp-subject-repeat" });
    const firstSession = await exchangeHandoff(first.callback!.headers.location);

    const second = await loginViaSso(email, { sub: "idp-subject-repeat" });
    const secondSession = await exchangeHandoff(second.callback!.headers.location);

    expect(secondSession.body.user.userId).toBe(firstSession.body.user.userId);

    const count = await prisma.portalUser.count({ where: { email } });
    expect(count).toBe(1);
  });

  it("links an existing password-based account by email on its first SSO login", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(admin, "link");
    const created = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "existing@sso-link.test", role: "tenant_staff" });
    const existingUserId = created.body.user.userId;

    const { callback } = await loginViaSso("existing@sso-link.test", { sub: "idp-subject-link" });
    const session = await exchangeHandoff(callback!.headers.location);
    expect(session.body.user.userId).toBe(existingUserId);

    const linked = await prisma.portalUser.findUnique({ where: { userId: existingUserId } });
    expect(linked!.ssoSubject).toBe("idp-subject-link");
  });

  it("rejects a token signed with the wrong key", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const connection = await configureAndEnable(token, "wrongkey");

    const start = await request(app).post("/auth/sso/start").send({ email: "x@sso-wrongkey.test" });
    const url = new URL(start.body.authorizationUrl);
    const state = url.searchParams.get("state")!;
    const nonce = url.searchParams.get("nonce")!;

    const badToken = await signWithWrongKey({
      sub: "x",
      email: "x@sso-wrongkey.test",
      nonce,
      issuer: connection.issuer,
      audience: connection.clientId,
    });
    // The IdP's own /token endpoint hands this back verbatim for this
    // code — every claim (issuer, audience, nonce) is otherwise exactly
    // right, so a pass here would mean signature verification isn't
    // actually checking anything.
    const code = "bad-key-code";
    idp.registerRawToken(code, badToken);

    const callback = await request(app).get(`/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("error=");

    const exchanged = await exchangeHandoff(callback.headers.location);
    expect(exchanged.status).toBe(400);
  });

  it("rejects a nonce that doesn't match the one issued at /sso/start", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(token, "noncecheck");

    const { callback } = await loginViaSso("x@sso-noncecheck.test", { sub: "x", nonce: "attacker-supplied-nonce" });
    expect(callback!.status).toBe(302);
    expect(callback!.headers.location).toContain("error=");

    const exchanged = await exchangeHandoff(callback!.headers.location);
    expect(exchanged.status).toBe(400); // no handoff param in an error redirect
  });

  it("rejects an audience that doesn't match this connection's clientId", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(token, "audcheck");

    const { callback } = await loginViaSso("x@sso-audcheck.test", { sub: "x", audience: "someone-elses-client-id" });
    expect(callback!.status).toBe(302);
    expect(callback!.headers.location).toContain("error=");
  });

  it("rejects a garbage or expired state parameter", async () => {
    const res = await request(app).get(`/auth/sso/callback?code=whatever&state=not-a-real-jwt`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=");
  });

  it("a deactivated account cannot complete SSO", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(admin, "deactivated");
    const created = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "gone@sso-deactivated.test", role: "tenant_staff" });
    await request(app).patch(`/users/${created.body.user.userId}`).set(auth(admin)).send({ active: false });

    const { callback } = await loginViaSso("gone@sso-deactivated.test", { sub: "idp-subject-deactivated" });
    expect(callback!.status).toBe(302);
    expect(callback!.headers.location).toContain("error=");
  });
});

describe("no SSO connection for a domain", () => {
  it("/sso/start 404s rather than silently doing nothing", async () => {
    const res = await request(app).post("/auth/sso/start").send({ email: "someone@no-such-domain.test" });
    expect(res.status).toBe(404);
  });
});

describe("enforcement", () => {
  it("blocks password login for tenant_staff, not tenant_admin, once enforced", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(admin, "enforce");
    await request(app).patch("/sso").set(auth(admin)).send({ enforced: true });

    const staffCreated = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "staffer@sso-enforce.test", role: "tenant_staff" });

    const staffLogin = await request(app)
      .post("/auth/login")
      .send({ email: "staffer@sso-enforce.test", password: staffCreated.body.temporaryPassword });
    expect(staffLogin.status).toBe(403);

    // tenant_admin keeps the password break-glass path.
    const adminAgain = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: "test-password-123" });
    expect(adminAgain.status).toBe(200);
  });

  it("does not affect a different tenant with no enforced connection", async () => {
    const alphaAdmin = await portalLogin(app, fx.alpha.adminEmail);
    await configureAndEnable(alphaAdmin, "isolated");
    await request(app).patch("/sso").set(auth(alphaAdmin)).send({ enforced: true });

    const betaLogin = await request(app).post("/auth/login").send({ email: fx.beta.adminEmail, password: "test-password-123" });
    expect(betaLogin.status).toBe(200);
  });
});
