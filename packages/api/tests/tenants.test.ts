// tests/tenants.test.ts
//
// Direct coverage for /tenants (master-console-only). Every route on
// this file is requireMasterAdmin — a tenant admin must be refused.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { prisma, seedTwoTenants, type Fixtures } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let f: Fixtures;
let masterToken: string;
let alphaAdminToken: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  f = await seedTwoTenants();
  masterToken = await portalLogin(app, f.masterEmail);
  alphaAdminToken = await portalLogin(app, f.alpha.adminEmail);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /tenants", () => {
  it("returns every tenant to a master_admin", async () => {
    const res = await request(app).get("/tenants").set("Authorization", `Bearer ${masterToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((t: { tenantId: string }) => t.tenantId).sort()).toEqual(
      [f.alpha.tenantId, f.beta.tenantId].sort(),
    );
  });

  it("403s a tenant_admin — cross-tenant reads belong to master", async () => {
    const res = await request(app).get("/tenants").set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /tenants", () => {
  it("provisions a new tenant AND its first admin atomically", async () => {
    const res = await request(app)
      .post("/tenants")
      .set("Authorization", `Bearer ${masterToken}`)
      .send({ companyName: "Gamma Corp", primaryContactEmail: "admin@gamma.test" });
    expect(res.status).toBe(201);
    expect(res.body.tenantId).toEqual(expect.any(String));
    expect(res.body.temporaryPassword).toEqual(expect.any(String));
    // The admin exists and is flagged mustChangePassword — the whole
    // point of the atomic provisioning is that a customer can reach
    // their portal without a support ticket for account creation.
    const admin = await prisma.portalUser.findUnique({ where: { email: "admin@gamma.test" } });
    expect(admin?.mustChangePassword).toBe(true);
    expect(admin?.tenantId).toBe(res.body.tenantId);
  });

  it("409s when the primary contact email is already used elsewhere — no half-provisioned tenant left behind", async () => {
    // Reuse the alpha admin's email.
    const before = await prisma.tenant.count();
    const res = await request(app)
      .post("/tenants")
      .set("Authorization", `Bearer ${masterToken}`)
      .send({ companyName: "Would-be Duplicate", primaryContactEmail: f.alpha.adminEmail });
    expect(res.status).toBe(409);
    // No tenant row from the failed transaction.
    const after = await prisma.tenant.count();
    expect(after).toBe(before);
  });
});

describe("suspend / activate", () => {
  it("suspends a tenant and logs the action", async () => {
    const suspend = await request(app)
      .patch(`/tenants/${f.alpha.tenantId}/suspend`)
      .set("Authorization", `Bearer ${masterToken}`);
    expect(suspend.status).toBe(200);
    expect(suspend.body.status).toBe("suspended");
    const log = await prisma.activityLogEntry.findFirst({
      where: { action: "tenant_suspended", targetId: f.alpha.tenantId },
    });
    expect(log).not.toBeNull();
  });

  it("activates a suspended tenant and logs the action", async () => {
    await request(app)
      .patch(`/tenants/${f.alpha.tenantId}/suspend`)
      .set("Authorization", `Bearer ${masterToken}`);
    const activate = await request(app)
      .patch(`/tenants/${f.alpha.tenantId}/activate`)
      .set("Authorization", `Bearer ${masterToken}`);
    expect(activate.status).toBe(200);
    expect(activate.body.status).toBe("active");
  });
});
