// tests/profiles.test.ts
//
// Direct coverage for /profiles CRUD + /profiles/tenants/:tenantId/
// profiles/by-pin/:pin (the unauthenticated PIN lookup the mobile app
// uses at Step 2).

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { prisma, seedTwoTenants, type Fixtures } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let f: Fixtures;
let alphaAdminToken: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  f = await seedTwoTenants();
  alphaAdminToken = await portalLogin(app, f.alpha.adminEmail);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /profiles/tenants/:tenantId/profiles/by-pin/:pin", () => {
  it("resolves a PIN scoped to the tenant — no auth required (mobile Step 2)", async () => {
    const res = await request(app).get(
      `/profiles/tenants/${encodeURIComponent(f.alpha.tenantId)}/profiles/by-pin/${encodeURIComponent(f.alpha.profilePin)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.profileId).toBe(f.alpha.profileId);
    expect(res.body.tenantId).toBe(f.alpha.tenantId);
  });

  it("returns Alpha's profile only for Alpha's tenantId — the same PIN in Beta is a different profile", async () => {
    // seedTwoTenants deliberately uses PIN 4726 in BOTH tenants; if the
    // lookup didn't scope by tenantId, this would collide.
    const alphaRes = await request(app).get(
      `/profiles/tenants/${encodeURIComponent(f.alpha.tenantId)}/profiles/by-pin/${encodeURIComponent(f.alpha.profilePin)}`,
    );
    const betaRes = await request(app).get(
      `/profiles/tenants/${encodeURIComponent(f.beta.tenantId)}/profiles/by-pin/${encodeURIComponent(f.beta.profilePin)}`,
    );
    expect(alphaRes.body.profileId).toBe(f.alpha.profileId);
    expect(betaRes.body.profileId).toBe(f.beta.profileId);
    expect(alphaRes.body.profileId).not.toBe(betaRes.body.profileId);
  });

  it("404s an unknown-tenant lookup — never leaks another tenant's PIN by falling through", async () => {
    const res = await request(app).get(
      `/profiles/tenants/bogus-tenant/profiles/by-pin/${encodeURIComponent(f.alpha.profilePin)}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /profiles", () => {
  it("creates a profile in the caller's tenant", async () => {
    const res = await request(app)
      .post("/profiles")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ customerName: "New Program", pin: "9999", enabledTestIds: ["battery_health"] });
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(f.alpha.tenantId);
    expect(res.body.pin).toBe("9999");
  });

  it("409s a duplicate PIN within the same tenant", async () => {
    const res = await request(app)
      .post("/profiles")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ customerName: "Dupe", pin: f.alpha.profilePin, enabledTestIds: [] });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /profiles/:id", () => {
  it("updates enabledTestIds within the caller's tenant", async () => {
    const res = await request(app)
      .patch(`/profiles/${f.alpha.profileId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ enabledTestIds: ["battery_health", "loud_speaker", "accelerometer"] });
    expect(res.status).toBe(200);
    expect(res.body.enabledTestIds).toEqual(["battery_health", "loud_speaker", "accelerometer"]);
  });

  it("404s a profile in a different tenant — never crosses the boundary", async () => {
    const res = await request(app)
      .patch(`/profiles/${f.beta.profileId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ enabledTestIds: [] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /profiles/:id", () => {
  it("deletes a profile in the caller's tenant when nothing references it", async () => {
    const created = await request(app)
      .post("/profiles")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ customerName: "Ephemeral", pin: "8888", enabledTestIds: [] });
    const del = await request(app)
      .delete(`/profiles/${created.body.profileId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(del.status).toBe(204);
  });
});
