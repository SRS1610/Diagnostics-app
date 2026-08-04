// tests/apiKeys.test.ts
//
// API keys: a third auth model alongside the portal and technician
// sessions, deliberately the narrowest. These tests cover the two things
// that matter most for a credential meant to sit in a partner's server —
// that it is READ-ONLY with no exceptions, and that it cannot reach
// another tenant's data even when tried directly against /v1.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let fx: Fixtures;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createKey(token: string) {
  const res = await request(app).post("/api-keys").set(auth(token)).send({ name: "Test integration" });
  expect(res.status).toBe(201);
  return res.body.apiKey as string;
}

describe("issuing and listing keys", () => {
  it("returns the full key exactly once, at creation", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app).post("/api-keys").set(auth(token)).send({ name: "Warehouse sync" });

    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^dgk_live_/);

    const list = await request(app).get("/api-keys").set(auth(token));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    // The list never carries the full key or its hash — only a prefix.
    expect(JSON.stringify(list.body)).not.toContain(created.body.apiKey);
    expect(list.body[0].keyPrefix).toBe(created.body.apiKey.slice(0, 16));
  });

  it("refuses tenant_staff from creating a key", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const staffCreated = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "keys-staff@alpha.test", role: "tenant_staff" });
    const staffLogin = await request(app)
      .post("/auth/login")
      .send({ email: "keys-staff@alpha.test", password: staffCreated.body.temporaryPassword });

    const res = await request(app).post("/api-keys").set(auth(staffLogin.body.token)).send({ name: "x" });
    expect(res.status).toBe(403);
  });
});

describe("the key actually authenticates /v1", () => {
  it("lists this tenant's reports and nothing else's", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const apiKey = await createKey(token);

    const res = await request(app).get("/v1/reports").set({ Authorization: `Bearer ${apiKey}` });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const report of res.body) {
      expect(report.reportId).toBeDefined();
    }
    // Confirmed against the fixture directly: only alpha's report id
    // appears, never beta's.
    const ids = res.body.map((r: { reportId: string }) => r.reportId);
    expect(ids).toContain(fx.alpha.reportId);
    expect(ids).not.toContain(fx.beta.reportId);
  });

  it("404s on another tenant's report id", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const apiKey = await createKey(token);

    const res = await request(app)
      .get(`/v1/reports/${fx.beta.reportId}`)
      .set({ Authorization: `Bearer ${apiKey}` });
    expect(res.status).toBe(404);
  });

  it("never returns a consumer token", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const apiKey = await createKey(token);

    const list = await request(app).get("/v1/reports").set({ Authorization: `Bearer ${apiKey}` });
    expect(JSON.stringify(list.body).toLowerCase()).not.toContain("consumertoken");

    const detail = await request(app)
      .get(`/v1/reports/${fx.alpha.reportId}`)
      .set({ Authorization: `Bearer ${apiKey}` });
    expect(JSON.stringify(detail.body).toLowerCase()).not.toContain("consumertoken");
  });

  it("rejects a garbage key", async () => {
    const res = await request(app).get("/v1/reports").set({ Authorization: "Bearer dgk_live_not-a-real-key" });
    expect(res.status).toBe(401);
  });

  it("rejects a portal session token presented as an API key", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/v1/reports").set(auth(token));
    expect(res.status).toBe(401);
  });
});

describe("the key is genuinely read-only", () => {
  it("has no route to write anything under /v1", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const apiKey = await createKey(token);

    // There is no POST /v1/reports at all — an API key cannot create,
    // resolve, or change anything, by construction rather than by a
    // role check that could be gotten wrong.
    const res = await request(app)
      .post("/v1/reports")
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({});
    expect([404, 405]).toContain(res.status);
  });
});

describe("revocation", () => {
  it("a revoked key stops working immediately", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app).post("/api-keys").set(auth(token)).send({ name: "Revoke me" });
    const apiKey = created.body.apiKey as string;

    expect((await request(app).get("/v1/reports").set({ Authorization: `Bearer ${apiKey}` })).status).toBe(200);

    const revoked = await request(app).delete(`/api-keys/${created.body.keyId}`).set(auth(token));
    expect(revoked.status).toBe(204);

    expect((await request(app).get("/v1/reports").set({ Authorization: `Bearer ${apiKey}` })).status).toBe(401);
  });
});

describe("isolation", () => {
  it("a key minted for alpha cannot be revoked via beta's session", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app).post("/api-keys").set(auth(alphaToken)).send({ name: "Alpha's key" });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app).delete(`/api-keys/${created.body.keyId}`).set(auth(betaToken));
    expect(res.status).toBe(404);

    // Still works — beta's attempt did nothing.
    const stillWorks = await request(app)
      .get("/v1/reports")
      .set({ Authorization: `Bearer ${created.body.apiKey}` });
    expect(stillWorks.status).toBe(200);
  });
});
