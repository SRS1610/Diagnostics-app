// tests/disputes.test.ts
//
// Direct coverage for the /disputes routes — filing, resolving, holds.
// Cross-tenant isolation is exercised elsewhere; this file focuses on
// the per-route contract: role gates (tenant_staff cannot resolve),
// resolutionNotes required, one-resolve rule, and the hold endpoint's
// shape.

import request from "supertest";
import type { Express } from "express";
import bcrypt from "bcrypt";
import { createApp } from "../src/app";
import { prisma, seedTwoTenants, PASSWORD, type Fixtures } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let f: Fixtures;
let alphaAdminToken: string;
let alphaStaffToken: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  f = await seedTwoTenants();
  alphaAdminToken = await portalLogin(app, f.alpha.adminEmail);
  // Seed a tenant_staff user in Alpha so the role-gate assertions have
  // a real actor to try, rather than relying on a hand-forged token.
  const staffEmail = `staff@${f.alpha.companyName.toLowerCase()}.test`;
  await prisma.portalUser.create({
    data: {
      email: staffEmail,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "tenant_staff",
      tenantId: f.alpha.tenantId,
    },
  });
  alphaStaffToken = await portalLogin(app, staffEmail);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function file(token: string, reportId: string, item = "overall_grade", note = "Customer emailed") {
  return request(app)
    .post("/disputes")
    .set("Authorization", `Bearer ${token}`)
    .send({ reportId, disputingItem: item, customerNote: note });
}

describe("POST /disputes", () => {
  it("files a dispute against a report in the caller's tenant", async () => {
    const res = await file(alphaAdminToken, f.alpha.reportId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("awaiting_review");
    expect(res.body.reportId).toBe(f.alpha.reportId);
    expect(res.body.tenantId).toBe(f.alpha.tenantId);
  });

  it("400s when disputingItem or customerNote is missing", async () => {
    const missingItem = await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ reportId: f.alpha.reportId, customerNote: "x" });
    expect(missingItem.status).toBe(400);

    const missingNote = await request(app)
      .post("/disputes")
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ reportId: f.alpha.reportId, disputingItem: "battery" });
    expect(missingNote.status).toBe(400);
  });

  it("404s when the reportId is from another tenant — never puts THEIR report on hold", async () => {
    const res = await file(alphaAdminToken, f.beta.reportId);
    expect(res.status).toBe(404);
  });
});

describe("GET /disputes/holds/:reportId", () => {
  it("returns onHold=false when nothing is open for the report", async () => {
    const res = await request(app)
      .get(`/disputes/holds/${f.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.onHold).toBe(false);
    expect(res.body.openDispute).toBeUndefined();
  });

  it("flips onHold=true and returns the open dispute once one is filed", async () => {
    const filed = await file(alphaAdminToken, f.alpha.reportId, "battery", "Bad battery grade");
    expect(filed.status).toBe(201);
    const res = await request(app)
      .get(`/disputes/holds/${f.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.body.onHold).toBe(true);
    expect(res.body.openDispute.disputeId).toBe(filed.body.disputeId);
    expect(res.body.openDispute.disputingItem).toBe("battery");
  });
});

describe("POST /disputes/:disputeId/resolve", () => {
  async function fileOne() {
    const filed = await file(alphaAdminToken, f.alpha.reportId, "screen", "Cracks were pre-existing");
    return filed.body.disputeId as string;
  }

  it("tenant_admin can uphold with resolutionNotes and the dispute stops being on hold", async () => {
    const disputeId = await fileOne();
    const res = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ outcome: "uphold", resolutionNotes: "Original grading confirmed." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved_upheld");
    expect(res.body.resolutionNotes).toBe("Original grading confirmed.");

    const hold = await request(app)
      .get(`/disputes/holds/${f.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(hold.body.onHold).toBe(false);
  });

  it("400s when outcome is missing or resolutionNotes is empty — an unauditable resolution is refused, not accepted", async () => {
    const disputeId = await fileOne();

    const noOutcome = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ resolutionNotes: "x" });
    expect(noOutcome.status).toBe(400);

    const noNotes = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ outcome: "adjust", resolutionNotes: "   " });
    expect(noNotes.status).toBe(400);
  });

  it("403s tenant_staff — resolving affects payout, so it's tenant_admin/master only", async () => {
    const disputeId = await fileOne();
    const res = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaStaffToken}`)
      .send({ outcome: "uphold", resolutionNotes: "N/A" });
    expect(res.status).toBe(403);
  });

  it("409s a second resolve — the first decision and its reasoning must not be overwritten", async () => {
    const disputeId = await fileOne();
    const first = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ outcome: "uphold", resolutionNotes: "First decision" });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${alphaAdminToken}`)
      .send({ outcome: "adjust", resolutionNotes: "Trying again" });
    expect(second.status).toBe(409);
  });
});
