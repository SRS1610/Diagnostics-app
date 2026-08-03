// tests/licenseSupersession.test.ts
//
// Pins the "one active license per tenant" invariant.
//
// This exists because of a real bug, not a hypothetical: a tenant had
// accumulated three concurrently-active licenses with identical
// billingPeriodStart, and the session gate ordered by that date alone,
// so it picked arbitrarily among ties. An organisation out of metered
// credits could be evaluated against a different active license and let
// through to run work it hadn't paid for. It surfaced only when an
// end-to-end run returned a different answer than the same call had
// minutes earlier.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";

let app: Express;
let fx: Fixtures;
let alphaToken: string;

const newLicense = (type = "seat_subscription") => ({
  type,
  billingPeriodStart: "2026-08-01T00:00:00Z",
  billingPeriodEnd: "2026-08-31T00:00:00Z",
  seatLimit: 5,
});

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  fx = await seedTwoTenants();
  alphaToken = await portalLogin(app, fx.alpha.adminEmail);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe("provisioning supersedes rather than accumulates", () => {
  it("expires the previous active license", async () => {
    const res = await request(app)
      .post("/licenses")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send(newLicense());
    expect(res.status).toBe(201);

    const previous = await prisma.license.findUnique({ where: { licenseId: fx.alpha.licenseId } });
    expect(previous?.status).toBe("expired");
  });

  it("leaves exactly one active license, however many are provisioned", async () => {
    for (const type of ["seat_subscription", "tiered_subscription", "enterprise_unlimited"]) {
      const res = await request(app)
        .post("/licenses")
        .set("Authorization", `Bearer ${alphaToken}`)
        .send(newLicense(type));
      expect(res.status).toBe(201);
    }

    const active = await prisma.license.findMany({
      where: { tenantId: fx.alpha.tenantId, status: "active" },
    });
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("enterprise_unlimited");
  });

  it("does not disturb another tenant's license", async () => {
    await request(app).post("/licenses").set("Authorization", `Bearer ${alphaToken}`).send(newLicense());

    const betaLicense = await prisma.license.findUnique({ where: { licenseId: fx.beta.licenseId } });
    expect(betaLicense?.status).toBe("active");
  });

  it("records the supersession in the activity log", async () => {
    await request(app).post("/licenses").set("Authorization", `Bearer ${alphaToken}`).send(newLicense());

    const entries = await prisma.activityLogEntry.findMany({
      where: { tenantId: fx.alpha.tenantId, action: "license_expired" },
    });
    expect(entries).toHaveLength(1);
  });
});

describe("the database enforces the invariant independently of the API", () => {
  // Application-level enforcement alone would leave the ambiguity one
  // stray script or manual fix away from returning.
  it("rejects a second active license inserted directly", async () => {
    await expect(
      prisma.license.create({
        data: {
          tenantId: fx.alpha.tenantId,
          type: "per_inspection",
          status: "active",
          billingPeriodStart: new Date("2026-09-01"),
          billingPeriodEnd: new Date("2026-09-30"),
          includedQuota: 10,
        },
      }),
    ).rejects.toThrow();
  });

  it("still permits many non-active licenses, so history is preserved", async () => {
    await prisma.license.create({
      data: {
        tenantId: fx.alpha.tenantId,
        type: "per_inspection",
        status: "expired",
        billingPeriodStart: new Date("2026-06-01"),
        billingPeriodEnd: new Date("2026-06-30"),
      },
    });
    await prisma.license.create({
      data: {
        tenantId: fx.alpha.tenantId,
        type: "per_inspection",
        status: "expired",
        billingPeriodStart: new Date("2026-07-01"),
        billingPeriodEnd: new Date("2026-07-31"),
      },
    });

    expect(await prisma.license.count({ where: { tenantId: fx.alpha.tenantId } })).toBe(3);
  });
});

describe("the session gate is unambiguous", () => {
  it("evaluates against the one active license, not an expired one", async () => {
    // Alpha's seeded license is metered with quota remaining.
    const before = await request(app).get(`/licenses/tenants/${fx.alpha.tenantId}/check`);
    expect(before.body).toMatchObject({ allowed: true, remainingQuota: 100 });

    // Supersede it with an unlimited plan; the gate must follow.
    await request(app)
      .post("/licenses")
      .set("Authorization", `Bearer ${alphaToken}`)
      .send(newLicense("enterprise_unlimited"));

    const after = await request(app).get(`/licenses/tenants/${fx.alpha.tenantId}/check`);
    expect(after.body.allowed).toBe(true);
    expect(after.body.remainingQuota).toBeUndefined();
  });

  it("returns the same answer on repeated calls", async () => {
    const calls = await Promise.all(
      [1, 2, 3].map(() => request(app).get(`/licenses/tenants/${fx.alpha.tenantId}/check`)),
    );
    const bodies = calls.map((c) => JSON.stringify(c.body));
    expect(new Set(bodies).size).toBe(1);
  });

  it("blocks when the only active license is exhausted", async () => {
    await prisma.license.update({
      where: { licenseId: fx.alpha.licenseId },
      data: { usageThisPeriod: 100 }, // quota is 100
    });

    const res = await request(app).get(`/licenses/tenants/${fx.alpha.tenantId}/check`);
    expect(res.body.allowed).toBe(false);
  });
});
