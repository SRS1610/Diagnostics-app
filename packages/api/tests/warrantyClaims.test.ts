// tests/warrantyClaims.test.ts
//
// Direct coverage for /warranty-claims. Post-sale claim tied back to
// the originating report — cross-tenant boundaries and required fields
// are the two things worth pinning at the route level; deeper logic
// (claimRateByTechnician aggregation) lives on the QA metrics side and
// is covered separately.

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

async function fileClaim(token: string, reportId: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/warranty-claims")
    .set("Authorization", `Bearer ${token}`)
    .send({
      reportId,
      claimedIssue: "Battery swelled after 30 days",
      ...body,
    });
}

describe("POST /warranty-claims", () => {
  it("files a claim against a report in the caller's tenant", async () => {
    const res = await fileClaim(alphaAdminToken, f.alpha.reportId);
    expect(res.status).toBe(201);
    // WarrantyClaim inherits tenancy from its report (no tenantId
    // column) — see the route file header. Check reportId instead.
    expect(res.body.reportId).toBe(f.alpha.reportId);
  });

  it("400s when required fields are missing", async () => {
    const res = await request(app)
      .post("/warranty-claims")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ reportId: f.alpha.reportId });
    expect(res.status).toBe(400);
  });

  it("404s a report belonging to another tenant — never files a claim across the boundary", async () => {
    const res = await fileClaim(alphaAdminToken, f.beta.reportId);
    expect(res.status).toBe(404);
  });
});

describe("GET /warranty-claims", () => {
  it("lists only claims whose parent report is in the caller's tenant", async () => {
    const filed = await fileClaim(alphaAdminToken, f.alpha.reportId);
    expect(filed.status).toBe(201);
    const list = await request(app)
      .get("/warranty-claims")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(list.status).toBe(200);
    // Every listed claim's parent report must be Alpha's — we can't
    // check tenantId here (not on the row), so we check reportId.
    const alphaReportIds = new Set([f.alpha.reportId]);
    expect(list.body.every((c: { reportId: string }) => alphaReportIds.has(c.reportId))).toBe(true);
  });
});

describe("PATCH /warranty-claims/:claimId", () => {
  it("updates the status of a claim within the caller's tenant", async () => {
    const filed = await fileClaim(alphaAdminToken, f.alpha.reportId);
    const res = await request(app)
      .patch(`/warranty-claims/${filed.body.claimId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ status: "approved", resolutionNotes: "Replaced under warranty" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });
});
