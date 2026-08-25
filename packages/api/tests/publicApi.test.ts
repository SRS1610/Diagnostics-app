// tests/publicApi.test.ts
//
// Direct coverage for /v1 (the API-key-authenticated read surface for
// partner integrations). The auth model differs from portal/technician
// sessions — a static key is presented — so the checks here are: (a)
// no key = 401, (b) valid key returns only the key's tenant's data,
// (c) a report id from another tenant 404s.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { prisma, seedTwoTenants, type Fixtures } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let f: Fixtures;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  f = await seedTwoTenants();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function issueApiKey(tenantAdminToken: string): Promise<string> {
  const res = await request(app)
    .post("/api-keys")
    .set("Authorization", `Bearer ${tenantAdminToken}`)
    .send({ name: "e2e" });
  // apiKeys.test.ts asserts this path works — if the shape changes there,
  // this will show up as a fixture failure rather than a mysterious 401.
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`api-key issue failed: ${res.status} ${res.text}`);
  }
  return res.body.apiKey;
}

describe("GET /v1/reports", () => {
  it("401s without an API key", async () => {
    const res = await request(app).get("/v1/reports");
    expect(res.status).toBe(401);
  });

  it("returns only the key's tenant's reports — never cross-tenant", async () => {
    const alphaAdmin = await portalLogin(app, f.alpha.adminEmail);
    const alphaKey = await issueApiKey(alphaAdmin);
    const res = await request(app).get("/v1/reports").set("Authorization", `Bearer ${alphaKey}`);
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    expect(Array.isArray(items)).toBe(true);
    // /v1/reports whitelists columns and DOESN'T return tenantId —
    // asserting the reportIds are Alpha's is the equivalent boundary
    // check (a Beta report wouldn't be here to be listed).
    const alphaReportIds = new Set([f.alpha.reportId]);
    expect(items.every((r: { reportId: string }) => alphaReportIds.has(r.reportId))).toBe(true);
  });
});

describe("GET /v1/reports/:reportId", () => {
  it("returns the report when it belongs to the key's tenant", async () => {
    const alphaAdmin = await portalLogin(app, f.alpha.adminEmail);
    const alphaKey = await issueApiKey(alphaAdmin);
    const res = await request(app)
      .get(`/v1/reports/${f.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaKey}`);
    expect(res.status).toBe(200);
    expect(res.body.reportId).toBe(f.alpha.reportId);
  });

  it("404s a report from a different tenant — API keys never cross the boundary", async () => {
    const alphaAdmin = await portalLogin(app, f.alpha.adminEmail);
    const alphaKey = await issueApiKey(alphaAdmin);
    const res = await request(app)
      .get(`/v1/reports/${f.beta.reportId}`)
      .set("Authorization", `Bearer ${alphaKey}`);
    expect(res.status).toBe(404);
  });
});
