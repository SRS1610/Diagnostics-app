// tests/reports.test.ts
//
// Direct coverage for /reports beyond the tenant-isolation and
// report-artifacts sweeps: list-and-detail shape, PATCH behavior, the
// mobile POST /reports write path's happy case, and the public
// /public/track/:token/certificate endpoint added alongside this file.
// Isolation itself lives in tenantIsolation.test.ts — this file focuses
// on the endpoints' own contracts.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { prisma, seedTwoTenants, type Fixtures } from "./fixtures";
import { portalLogin, technicianLogin, validReportBody } from "./helpers";

let app: Express;
let f: Fixtures;
let alphaAdminToken: string;
let alphaTechToken: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  f = await seedTwoTenants();
  alphaAdminToken = await portalLogin(app, f.alpha.adminEmail);
  alphaTechToken = await technicianLogin(app, f.alpha.tenantId, f.alpha.badgeCode);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /reports", () => {
  it("lists this tenant's reports and returns pagination headers", async () => {
    const res = await request(app).get("/reports").set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Every returned row is Alpha's — Beta's report is a control that
    // must not leak. tenantIsolation.test.ts covers this cross-tenant
    // in depth; here we assert only that the listed rows carry the
    // expected tenantId.
    expect(res.body.every((r: { tenantId: string }) => r.tenantId === f.alpha.tenantId)).toBe(true);
    expect(res.headers["x-total-count"]).toBeDefined();
  });
});

describe("GET /reports/:reportId", () => {
  it("returns the full report including the consumerToken", async () => {
    const res = await request(app)
      .get(`/reports/${f.alpha.reportId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.reportId).toBe(f.alpha.reportId);
    expect(res.body.consumerToken).toBe(f.alpha.consumerToken);
    expect(res.body.tenantId).toBe(f.alpha.tenantId);
  });

  it("404s when the id belongs to another tenant", async () => {
    const res = await request(app)
      .get(`/reports/${f.beta.reportId}`)
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /reports (mobile write path)", () => {
  it("creates a report under the technician's tenant regardless of any tenantId in the body", async () => {
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody({
        tenantId: f.beta.tenantId, // deliberately wrong
        profileId: f.alpha.profileId,
      }));
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(f.alpha.tenantId);
    // Overall status is derived, not taken from the body.
    expect(["pass", "fail", "pass_with_warnings"]).toContain(res.body.overallStatus);
  });

  it("401s without a technician token", async () => {
    const res = await request(app).post("/reports").send(validReportBody());
    expect(res.status).toBe(401);
  });
});

describe("GET /public/track/:token/certificate", () => {
  it("returns identity + inspection summary + masked identifiers for the QR-linked buyer view", async () => {
    const res = await request(app).get(`/public/track/${f.alpha.consumerToken}/certificate`);
    expect(res.status).toBe(200);
    expect(res.body.device.make).toBe("Apple");
    expect(res.body.device.model).toBe("iPhone 13");
    // Serials are masked, never returned in full — the identifier ends
    // in the last-four pattern, never the raw string.
    expect(res.body.device.serialNumberMasked).toMatch(/^••••/);
    expect(res.body.device.serialNumberMasked).not.toContain(`SERIAL-${f.alpha.companyName}`);
    expect(res.body.inspection.overallStatus).toBe("pass");
    expect(typeof res.body.inspection.testsRun).toBe("number");
    // No wipe cert was seeded — dataErasure must be null, not undefined
    // and not an "in progress" placeholder.
    expect(res.body.dataErasure).toBeNull();
  });

  it("404s for an unknown token — the whole point of authorization-by-token", async () => {
    const res = await request(app).get(`/public/track/definitely-not-a-real-token/certificate`);
    expect(res.status).toBe(404);
  });

  it("does not leak technician notes, offer, dispute or contact-info toggles that the tracker view exposes", async () => {
    const res = await request(app).get(`/public/track/${f.alpha.consumerToken}/certificate`);
    expect(res.status).toBe(200);
    // Whitelist: exactly these keys, nothing else.
    expect(Object.keys(res.body).sort()).toEqual(["dataErasure", "device", "inspection"]);
    // And within device / inspection: no fields that would leak
    // technician notes or the full IMEI / serial.
    expect(res.body.device).not.toHaveProperty("serialNumber");
    expect(res.body.device).not.toHaveProperty("imei");
  });
});
