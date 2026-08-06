// tests/qaMetrics.test.ts
//
// The two properties that matter here beyond "returns 200":
//   1. The rate arithmetic actually reflects distinct-reports semantics
//      (a report revised twice still counts as one "needed a second
//      look"), and null-on-zero-reports so a new hire isn't rendered
//      as a top performer.
//   2. Tenant scoping — a revision or dispute filed under Beta must
//      never touch Alpha's redo/dispute rate, even when both tenants
//      use identical badge codes and report IDs happen to look similar.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";
import { mintConsumerToken } from "../src/lib/consumerToken";

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

async function addReport(tenantId: string, technicianId: string | null, serial: string) {
  return prisma.report.create({
    data: {
      tenantId,
      technicianId,
      deviceMake: "Apple",
      deviceModel: "iPhone 13",
      serialNumber: serial,
      imei: "356938035643809",
      captureSource: "manual",
      results: [],
      overallStatus: "pass",
      consumerToken: mintConsumerToken(),
    },
  });
}

async function addRevision(reportId: string, technicianId: string, revisionNumber = 1) {
  return prisma.reportRevision.create({
    data: {
      reportId,
      revisionNumber,
      revisedByTechnicianId: technicianId,
      testIdsRedone: ["battery_health"],
    },
  });
}

async function addDispute(tenantId: string, reportId: string) {
  return prisma.dispute.create({
    data: {
      tenantId,
      reportId,
      disputingItem: "battery_health",
      customerNote: "n/a",
    },
  });
}

describe("GET /qa-metrics/technicians", () => {
  it("computes redo and dispute rates as distinct-reports over total reports", async () => {
    // Alpha's seeded tech already has 1 report (fx.alpha.reportId).
    // Give them two more so we get a rate that isn't 0 or 1 trivially.
    const r2 = await addReport(fx.alpha.tenantId, fx.alpha.technicianId, "SN-A-2");
    const r3 = await addReport(fx.alpha.tenantId, fx.alpha.technicianId, "SN-A-3");

    // r2 revised TWICE — this must still count as 1 report-that-needed-a-redo,
    // not 2. Same for a report disputed multiple times.
    await addRevision(r2.reportId, fx.alpha.technicianId, 1);
    await addRevision(r2.reportId, fx.alpha.technicianId, 2);
    await addDispute(fx.alpha.tenantId, r3.reportId);
    await addDispute(fx.alpha.tenantId, r3.reportId);

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/qa-metrics/technicians").set(auth(token));
    expect(res.status).toBe(200);

    const row = res.body.technicians.find((t: { technicianId: string }) => t.technicianId === fx.alpha.technicianId);
    expect(row).toBeDefined();
    expect(row.reports).toBe(3);
    expect(row.reportsWithRevisions).toBe(1); // r2 only — not 2, despite two revisions
    expect(row.reportsWithDisputes).toBe(1); // r3 only
    expect(row.redoRate).toBeCloseTo(1 / 3);
    expect(row.disputeRate).toBeCloseTo(1 / 3);
  });

  it("returns null rate for a technician with zero reports (not 0)", async () => {
    const newHire = await prisma.technician.create({
      data: { tenantId: fx.alpha.tenantId, displayName: "Fresh Hire", badgeCode: "TEC-NEW" },
    });
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/qa-metrics/technicians").set(auth(token));

    const row = res.body.technicians.find((t: { technicianId: string }) => t.technicianId === newHire.technicianId);
    expect(row.reports).toBe(0);
    expect(row.redoRate).toBeNull();
    expect(row.disputeRate).toBeNull();
  });

  it("does not count another tenant's revisions or disputes toward this tenant's rates", async () => {
    // Beta gets a revision + dispute on ITS own report. Alpha's rate
    // for its identically-named-tech must not budge.
    await addRevision(fx.beta.reportId, fx.beta.technicianId);
    await addDispute(fx.beta.tenantId, fx.beta.reportId);

    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/qa-metrics/technicians").set(auth(token));

    // Alpha's tech: 1 seeded report, no revisions/disputes in Alpha.
    const alphaRow = res.body.technicians.find((t: { technicianId: string }) => t.technicianId === fx.alpha.technicianId);
    expect(alphaRow.reports).toBe(1);
    expect(alphaRow.reportsWithRevisions).toBe(0);
    expect(alphaRow.reportsWithDisputes).toBe(0);
    expect(alphaRow.redoRate).toBe(0);
    expect(alphaRow.disputeRate).toBe(0);

    // And Alpha's response must not mention Beta's technician at all.
    expect(res.body.technicians.some((t: { technicianId: string }) => t.technicianId === fx.beta.technicianId)).toBe(false);
  });

  it("ignores reports with no technician attribution (they don't judge anyone)", async () => {
    await addReport(fx.alpha.tenantId, null, "SN-A-UNATTR");
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/qa-metrics/technicians").set(auth(token));

    const row = res.body.technicians.find((t: { technicianId: string }) => t.technicianId === fx.alpha.technicianId);
    expect(row.reports).toBe(1); // unchanged — only the seeded one
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/qa-metrics/technicians");
    expect(res.status).toBe(401);
  });
});
