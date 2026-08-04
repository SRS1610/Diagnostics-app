// tests/authAndResilience.test.ts
//
// Auth boundaries between the two client families (portal and mobile),
// input validation on the one write path, and — most importantly — a
// regression test for the crash that shipped in POST /reports.

import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin, technicianLogin, validReportBody } from "./helpers";

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

describe("auth boundaries", () => {
  it("rejects an unauthenticated report write", async () => {
    const res = await request(app).post("/reports").send(validReportBody());
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated portal reads", async () => {
    for (const path of ["/reports", "/profiles", "/licenses", "/technicians", "/activity-log", "/tenants"]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  // Both token families are signed with the same JWT_SECRET, so a portal
  // token verifies fine on a technician route. Only the `kind` claim
  // stops it falling through with an undefined tenantId.
  it("rejects a portal token on the mobile write route", async () => {
    const portalToken = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${portalToken}`)
      .send(validReportBody());
    expect(res.status).toBe(401);
  });

  it("rejects a technician token on a portal route", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app).get("/reports").set("Authorization", `Bearer ${techToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { technicianId: fx.alpha.technicianId, tenantId: fx.alpha.tenantId, kind: "technician" },
      "not-the-real-secret",
    );
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${forged}`)
      .send(validReportBody());
    expect(res.status).toBe(401);
  });

  it("rejects an expired technician token", async () => {
    const expired = jwt.sign(
      { technicianId: fx.alpha.technicianId, tenantId: fx.alpha.tenantId, kind: "technician" },
      process.env.JWT_SECRET as string,
      { expiresIn: "-1s" },
    );
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${expired}`)
      .send(validReportBody());
    expect(res.status).toBe(401);
  });

  it("does not echo the badge code back after login", async () => {
    const res = await request(app)
      .post("/technicians/login")
      .send({ tenantId: fx.alpha.tenantId, badgeCode: fx.alpha.badgeCode });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("badgeCode");
  });

  it("gives the same 404 for a wrong badge and a wrong tenant, so neither can be probed", async () => {
    const wrongBadge = await request(app)
      .post("/technicians/login")
      .send({ tenantId: fx.alpha.tenantId, badgeCode: "NOPE" });
    const wrongTenant = await request(app)
      .post("/technicians/login")
      .send({ tenantId: "no-such-tenant", badgeCode: fx.alpha.badgeCode });

    expect(wrongBadge.status).toBe(404);
    expect(wrongTenant.status).toBe(404);
    expect(wrongBadge.body).toEqual(wrongTenant.body);
  });
});

describe("report validation", () => {
  let techToken: string;

  beforeEach(async () => {
    techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
  });

  const post = (body: unknown) =>
    request(app).post("/reports").set("Authorization", `Bearer ${techToken}`).send(body as object);

  it("requires a 15-digit IMEI", async () => {
    for (const imei of ["35693803564380", "3569380356438099", "35693803564380O", ""]) {
      const res = await post(validReportBody({ device: { ...validReportBody().device, imei } }));
      expect(res.status).toBe(400);
    }
  });

  it("requires a serial number, since the Devices tab groups on it", async () => {
    const device = { ...validReportBody().device } as Record<string, unknown>;
    delete device.serialNumber;
    expect((await post(validReportBody({ device }))).status).toBe(400);
  });

  it("rejects unknown enum values", async () => {
    expect(
      (await post(validReportBody({ device: { ...validReportBody().device, captureSource: "telepathy" } }))).status,
    ).toBe(400);
    expect((await post(validReportBody({ routing: "to_the_moon" }))).status).toBe(400);
    expect(
      (
        await post(
          validReportBody({
            results: [{ testId: "a", label: "A", status: "exploded", source: "api", timestamp: "t" }],
          }),
        )
      ).status,
    ).toBe(400);
  });

  // Duplicates would make a report's summary counts disagree with its own
  // detail table, and testSession.ts's redo logic assumes one entry per id.
  it("rejects duplicate testIds", async () => {
    const res = await post(
      validReportBody({
        results: [
          { testId: "a", label: "A", status: "pass", source: "api", timestamp: "t" },
          { testId: "a", label: "A again", status: "fail", source: "api", timestamp: "t" },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("stores only whitelisted result keys, since this row feeds the audit PDF", async () => {
    const res = await post(
      validReportBody({
        results: [
          {
            testId: "a",
            label: "A",
            status: "pass",
            source: "api",
            timestamp: "t",
            notes: "kept",
            evilExtraKey: "must not persist",
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.results[0]).sort()).toEqual(
      ["label", "notes", "source", "status", "testId", "timestamp"].sort(),
    );
  });

  it("rejects a non-scalar result value", async () => {
    const res = await post(
      validReportBody({
        results: [{ testId: "a", label: "A", status: "pass", source: "api", timestamp: "t", value: { nested: 1 } }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("computes overallStatus server-side rather than trusting the client", async () => {
    const res = await post(
      validReportBody({
        overallStatus: "pass", // client lies
        results: [{ testId: "a", label: "A", status: "fail", source: "api", timestamp: "t" }],
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.overallStatus).toBe("fail");
  });

  it("rejects a body over the size limit", async () => {
    const huge = validReportBody({
      results: Array.from({ length: 2000 }, (_, i) => ({
        testId: `t${i}`,
        label: "x".repeat(400),
        status: "pass",
        source: "api",
        timestamp: "t",
      })),
    });
    expect((await post(huge)).status).toBe(413);
  });

  it("returns 400, not 500, for malformed JSON", async () => {
    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "application/json")
      .send('{"device": {broken');
    expect(res.status).toBe(400);
  });
});

// REGRESSION. This exact sequence killed the API process: Express 4 does
// not catch async handler rejections, so the foreign-key violation from
// writing a report attributed to a deleted technician became an unhandled
// rejection and exited the server for every tenant. No adversary needed —
// a session token stays valid for its full TTL, so an admin removing a
// technician mid-shift was enough.
describe("regression: a revoked session must not take down the API", () => {
  it("returns 401 and keeps serving other tenants", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    await prisma.technician.delete({ where: { technicianId: fx.alpha.technicianId } });

    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${techToken}`)
      .send(validReportBody());
    expect(res.status).toBe(401);

    // The process surviving is the actual assertion — these would not
    // respond at all if the handler had crashed it.
    expect((await request(app).get("/health")).status).toBe(200);
    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    expect((await request(app).get("/reports").set("Authorization", `Bearer ${betaToken}`)).status).toBe(200);
  });

  it("survives a profile deleted between validation and write", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    // Simulates losing the FK target after the existence check passes.
    await prisma.report.deleteMany({ where: { profileId: fx.alpha.profileId } });
    await prisma.customerProfile.delete({ where: { profileId: fx.alpha.profileId } });

    const res = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${techToken}`)
      .send(validReportBody({ profileId: fx.alpha.profileId }));

    expect([401, 404]).toContain(res.status);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});

// A JWT is valid until it expires no matter what happens to the account
// behind it. These cover the two ways that mattered: removing a
// technician from the roster (the only lever an admin has when a badge
// is lost or someone leaves) and suspending a tenant.
describe("technician session revocation", () => {
  it("stops accepting writes once the technician is removed from the roster", async () => {
    const token = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    // Works before removal, so the test proves revocation and not just
    // that the request was broken to begin with.
    expect((await request(app).post("/reports").set("Authorization", `Bearer ${token}`).send(validReportBody())).status)
      .toBe(201);

    await prisma.report.deleteMany({ where: { technicianId: fx.alpha.technicianId } });
    await prisma.technician.delete({ where: { technicianId: fx.alpha.technicianId } });

    const after = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${token}`)
      .send(validReportBody());
    expect(after.status).toBe(401);
    // And nothing was written on the way to rejecting it.
    expect(await prisma.report.count({ where: { tenantId: fx.alpha.tenantId } })).toBe(0);
  });

  it("stops accepting writes while the tenant is suspended", async () => {
    const token = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    await prisma.tenant.update({ where: { tenantId: fx.alpha.tenantId }, data: { status: "suspended" } });

    const res = await request(app).post("/reports").set("Authorization", `Bearer ${token}`).send(validReportBody());
    expect(res.status).toBe(403);

    // Reinstating the tenant restores access — suspension is a hold, not
    // a permanent revocation, and the technician should not have to be
    // re-enrolled afterwards.
    await prisma.tenant.update({ where: { tenantId: fx.alpha.tenantId }, data: { status: "active" } });
    const restored = await request(app)
      .post("/reports")
      .set("Authorization", `Bearer ${token}`)
      .send(validReportBody());
    expect(restored.status).toBe(201);
  });
});

describe("consumer token exposure", () => {
  it("does not return consumer tokens in the reports list", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const report of res.body) {
      expect(report.consumerToken).toBeUndefined();
    }
    // The token must not survive anywhere in the payload under another
    // name either.
    const stored = await prisma.report.findUnique({ where: { reportId: fx.alpha.reportId } });
    expect(JSON.stringify(res.body)).not.toContain(stored!.consumerToken);
  });

  it("returns the token on the detail route, where staff need it to hand over", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get(`/reports/${fx.alpha.reportId}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.consumerToken).toBe("string");
  });
});
