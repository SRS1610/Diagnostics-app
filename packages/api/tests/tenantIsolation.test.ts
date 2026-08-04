// tests/tenantIsolation.test.ts
//
// The property this whole codebase is built around: one tenant can never
// reach another tenant's data. CLAUDE.md calls tenant isolation "the
// single highest-risk part of this codebase," and until now it was
// verified only by hand — ad-hoc curl runs and code review. Those catch
// what someone thought to check on the day; this catches regressions
// forever.
//
// Both fixture tenants deliberately share a PIN and badge code, since
// those are unique only within a tenant. A lookup that forgot its tenant
// filter would return the wrong tenant's row rather than nothing, which
// is exactly the failure that's easy to miss by eye.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import jwt from "jsonwebtoken";
import { enterTenantView, portalLogin, technicianLogin, validReportBody } from "./helpers";

let app: Express;
let fx: Fixtures;
let alphaToken: string;
let betaToken: string;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  alphaToken = await portalLogin(app, fx.alpha.adminEmail);
  betaToken = await portalLogin(app, fx.beta.adminEmail);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe("portal reads are scoped to the caller's tenant", () => {
  const collections: { path: string; idOf: (t: Fixtures["alpha"]) => string }[] = [
    { path: "/reports", idOf: (t) => t.reportId },
    { path: "/profiles", idOf: (t) => t.profileId },
    { path: "/licenses", idOf: (t) => t.licenseId },
    { path: "/technicians", idOf: (t) => t.technicianId },
  ];

  it.each(collections)("$path lists only Alpha's rows", async ({ path }) => {
    const res = await request(app).get(path).set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) expect(row.tenantId).toBe(fx.alpha.tenantId);
  });

  // The core assertion: a valid ID from another tenant must be
  // indistinguishable from one that doesn't exist.
  it.each(collections)("$path 404s on Beta's ID rather than returning it", async ({ path, idOf }) => {
    const res = await request(app).get(`${path}/${idOf(fx.beta)}`).set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(fx.beta.tenantId);
  });

  it("activity log shows only Alpha's entries", async () => {
    const res = await request(app).get("/activity-log").set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const entry of res.body) expect(entry.tenantId).toBe(fx.alpha.tenantId);
  });
});

describe("portal writes cannot cross a tenant boundary", () => {
  it("refuses to update Beta's profile", async () => {
    const res = await request(app)
      .patch(`/profiles/${fx.beta.profileId}`)
      .set("Authorization", `Bearer ${alphaToken}`)
      .send({ customerName: "OWNED BY ALPHA" });
    expect(res.status).toBe(404);

    const untouched = await prisma.customerProfile.findUnique({ where: { profileId: fx.beta.profileId } });
    expect(untouched?.customerName).toBe("Beta Program");
  });

  it("refuses to delete Beta's profile", async () => {
    const res = await request(app)
      .delete(`/profiles/${fx.beta.profileId}`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(404);
    expect(await prisma.customerProfile.findUnique({ where: { profileId: fx.beta.profileId } })).not.toBeNull();
  });

  it("refuses to delete Beta's technician", async () => {
    const res = await request(app)
      .delete(`/technicians/${fx.beta.technicianId}`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(404);
    expect(await prisma.technician.findUnique({ where: { technicianId: fx.beta.technicianId } })).not.toBeNull();
  });

  it("refuses to consume a seat on Beta's license", async () => {
    const res = await request(app)
      .post(`/licenses/${fx.beta.licenseId}/consume-seat`)
      .set("Authorization", `Bearer ${alphaToken}`);
    expect(res.status).toBe(404);
  });

  it("keeps a same-PIN profile per tenant distinct", async () => {
    // Both tenants use PIN 4726. Each must resolve to its own profile.
    const forAlpha = await request(app).get(`/profiles/tenants/${fx.alpha.tenantId}/profiles/by-pin/4726`);
    const forBeta = await request(app).get(`/profiles/tenants/${fx.beta.tenantId}/profiles/by-pin/4726`);
    expect(forAlpha.body.profileId).toBe(fx.alpha.profileId);
    expect(forBeta.body.profileId).toBe(fx.beta.profileId);
    expect(forAlpha.body.profileId).not.toBe(forBeta.body.profileId);
  });
});

describe("mobile writes are bound to the token's tenant", () => {
  let alphaTechToken: string;

  beforeEach(async () => {
    alphaTechToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
  });

  it("ignores a tenantId supplied in the request body", async () => {
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody({ tenantId: fx.beta.tenantId }));

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(fx.alpha.tenantId);
    expect(await prisma.report.count({ where: { tenantId: fx.beta.tenantId } })).toBe(1); // just the seeded one
  });

  it("refuses to attach another tenant's profile", async () => {
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody({ profileId: fx.beta.profileId }));
    expect(res.status).toBe(404);
  });

  it("attributes the report to the token's technician, not a body-supplied one", async () => {
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody({ technicianId: fx.beta.technicianId }));
    expect(res.status).toBe(201);
    expect(res.body.technicianId).toBe(fx.alpha.technicianId);
  });

  it("charges the write against the caller's own license, not another tenant's", async () => {
    await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody());

    const alphaLicense = await prisma.license.findUnique({ where: { licenseId: fx.alpha.licenseId } });
    const betaLicense = await prisma.license.findUnique({ where: { licenseId: fx.beta.licenseId } });
    expect(alphaLicense?.usageThisPeriod).toBe(1);
    expect(betaLicense?.usageThisPeriod).toBe(0);
  });

  it("makes the written report visible to its own tenant and invisible to the other", async () => {
    const created = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${alphaTechToken}`)
      .send(validReportBody({ device: { ...validReportBody().device, serialNumber: "ONLY-ALPHA" } }));
    expect(created.status).toBe(201);

    const mine = await request(app).get(`/reports/${created.body.reportId}`).set("Authorization", `Bearer ${alphaToken}`);
    expect(mine.status).toBe(200);

    const theirs = await request(app)
      .get(`/reports/${created.body.reportId}`)
      .set("Authorization", `Bearer ${betaToken}`);
    expect(theirs.status).toBe(404);
  });
});

describe("master_admin context rules", () => {
  it("cannot reach tenant-scoped routes without entering a tenant view", async () => {
    const masterToken = await portalLogin(app, fx.masterEmail);
    const res = await request(app).get("/reports").set("Authorization", `Bearer ${masterToken}`);
    expect(res.status).toBe(400);
  });

  it("sees only that tenant's data once inside a tenant view", async () => {
    const masterToken = await portalLogin(app, fx.masterEmail);
    const scoped = await enterTenantView(app, masterToken, fx.beta.tenantId);

    const res = await request(app).get("/reports").set("Authorization", `Bearer ${scoped}`);
    expect(res.status).toBe(200);
    for (const row of res.body) expect(row.tenantId).toBe(fx.beta.tenantId);
  });

  it("cannot use a tenant-view token for the cross-tenant tenant list", async () => {
    const masterToken = await portalLogin(app, fx.masterEmail);
    const scoped = await enterTenantView(app, masterToken, fx.beta.tenantId);

    expect((await request(app).get("/tenants").set("Authorization", `Bearer ${masterToken}`)).status).toBe(200);
    // Still master_admin by role, but no longer in Master Console context.
    expect((await request(app).get("/tenants").set("Authorization", `Bearer ${scoped}`)).status).toBe(400);
  });

  it("denies tenant CRUD to a tenant_admin outright", async () => {
    expect((await request(app).get("/tenants").set("Authorization", `Bearer ${alphaToken}`)).status).toBe(403);
    expect(
      (
        await request(app)
          .post("/tenants")
          .set("Authorization", `Bearer ${alphaToken}`)
          .send({ companyName: "Sneaky", primaryContactEmail: "x@y.test" })
      ).status,
    ).toBe(403);
  });
});

// Swept for after finding the same defect class on Report's optional
// relations. In both of these, NULL is not an absence — it is a claim:
// a null tenantId on an activity-log row means "platform-level action",
// and on a portal user it means "master_admin". Under Prisma's default
// SetNull, deleting a tenant would not orphan these rows, it would
// relabel them.
describe("a tenant cannot be deleted out from under its audit trail", () => {
  it("refuses to delete a tenant that has activity-log entries", async () => {
    // Everything else pointing at this tenant is cleared first, so the
    // audit trail is the ONLY thing left blocking the delete. Without
    // this the test passed vacuously — reports, licences and technicians
    // are required relations and already blocked it, so the assertion
    // held whatever the activity-log constraint said.
    await prisma.report.deleteMany({ where: { tenantId: fx.alpha.tenantId } });
    await prisma.license.deleteMany({ where: { tenantId: fx.alpha.tenantId } });
    await prisma.technician.deleteMany({ where: { tenantId: fx.alpha.tenantId } });
    await prisma.customerProfile.deleteMany({ where: { tenantId: fx.alpha.tenantId } });
    await prisma.portalUser.deleteMany({ where: { tenantId: fx.alpha.tenantId } });

    const before = await prisma.activityLogEntry.count({ where: { tenantId: fx.alpha.tenantId } });
    expect(before).toBeGreaterThan(0);

    await expect(prisma.tenant.delete({ where: { tenantId: fx.alpha.tenantId } })).rejects.toThrow();

    // No entry was relabelled as a platform-level action on the way.
    const after = await prisma.activityLogEntry.count({ where: { tenantId: fx.alpha.tenantId } });
    expect(after).toBe(before);
  });

  it("refuses to delete a tenant that still has portal users", async () => {
    // Clear everything else that references this tenant, so the only
    // thing left blocking the delete is the portal user itself.
    await prisma.activityLogEntry.deleteMany({ where: { tenantId: fx.beta.tenantId } });
    await prisma.report.deleteMany({ where: { tenantId: fx.beta.tenantId } });
    await prisma.license.deleteMany({ where: { tenantId: fx.beta.tenantId } });
    await prisma.technician.deleteMany({ where: { tenantId: fx.beta.tenantId } });
    await prisma.customerProfile.deleteMany({ where: { tenantId: fx.beta.tenantId } });

    await expect(prisma.tenant.delete({ where: { tenantId: fx.beta.tenantId } })).rejects.toThrow();

    const user = await prisma.portalUser.findFirst({ where: { tenantId: fx.beta.tenantId } });
    // Still scoped to its tenant, not silently promoted to the shape
    // that means master_admin.
    expect(user!.tenantId).toBe(fx.beta.tenantId);
    expect(user!.role).toBe("tenant_admin");
  });
});

// The check in requireTenantScope that a tenant user's scope matches
// their own tenant used to compare a value against itself, so it could
// never fire — the file's most important safety net was dead code that
// read like protection. Found in review. These prove the revived version
// is load-bearing.
describe("the tenant-scope guard is a real check, not a tautology", () => {
  it("ignores a tampered viewingTenantId claim and serves the user's own tenant", async () => {
    // A token minted by hand, pointing a tenant_admin at the OTHER
    // tenant. This is the outer defence: requireAuth re-derives the
    // scope from the user's own row before the guard is ever consulted,
    // so the request SUCCEEDS — with alpha's data, not beta's. The
    // status is not the assertion; whose rows come back is.
    const alphaUser = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    const forged = jwt.sign(
      {
        kind: "portal",
        userId: alphaUser!.userId,
        role: "tenant_admin",
        tenantId: fx.alpha.tenantId,
        viewingTenantId: fx.beta.tenantId,
      },
      process.env.JWT_SECRET as string,
      { expiresIn: "1h" },
    );

    const res = await request(app).get("/reports").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(200);
    for (const row of res.body) expect(row.tenantId).toBe(fx.alpha.tenantId);
    expect(JSON.stringify(res.body)).not.toContain(fx.beta.tenantId);
  });

  it("fires if a drifted session ever reaches it", async () => {
    // The inner defence, exercised directly. It cannot be reached
    // through HTTP while requireAuth is correct — which is the whole
    // point of a second layer — so it is called with the session a
    // regression in requireAuth would produce. Before this fix the same
    // call fell straight through, because the check compared a value
    // against itself.
    const { requireTenantScope } = await import("../src/middleware/tenantScope");

    const drifted = {
      portalSession: {
        userId: "u1",
        role: "tenant_admin" as const,
        viewingTenantId: fx.beta.tenantId,
        ownTenantId: fx.alpha.tenantId,
      },
    };

    let status = 0;
    let nextCalled = false;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };

    requireTenantScope(drifted as never, res as never, () => {
      nextCalled = true;
    });

    expect(status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it("still lets a master_admin legitimately view another tenant", async () => {
    // The one case where viewingTenantId and ownTenantId differ by
    // design — the check must not break support access.
    const master = await portalLogin(app, fx.masterEmail);
    const entered = await request(app)
      .post("/auth/enter-tenant-view")
      .set("Authorization", `Bearer ${master}`)
      .send({ tenantId: fx.alpha.tenantId });

    expect(entered.status).toBe(200);
    const scoped = await request(app).get("/reports").set("Authorization", `Bearer ${entered.body.token}`);
    expect(scoped.status).toBe(200);
  });
});
