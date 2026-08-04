// tests/pagination.test.ts
//
// Paging and search on the three lists that grow without bound.
//
// The isolation angle matters as much as the mechanics: a filter is a
// new way to phrase a query, and a search term that reached across
// tenants would be a leak with a friendly text box in front of it.

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

/** Enough rows to page through, with predictable identifiers. */
async function seedReports(tenantId: string, count: number, prefix: string) {
  for (let i = 0; i < count; i += 1) {
    await prisma.report.create({
      data: {
        tenantId,
        deviceMake: i % 2 === 0 ? "Apple" : "Samsung",
        deviceModel: i % 2 === 0 ? "iPhone 13" : "Galaxy S22",
        serialNumber: `${prefix}-SERIAL-${String(i).padStart(3, "0")}`,
        imei: `35693803564${String(3000 + i).padStart(4, "0")}`,
        captureSource: "barcode",
        results: [],
        overallStatus: i % 3 === 0 ? "fail" : "pass",
        consumerToken: mintConsumerToken(),
        generatedAt: new Date(Date.now() - i * 60_000),
      },
    });
  }
}

describe("paging the reports list", () => {
  it("reports the total matching count, not the page size", async () => {
    await seedReports(fx.alpha.tenantId, 60, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports?limit=10").set(auth(token));

    expect(res.body).toHaveLength(10);
    // 60 seeded + the 1 from the fixture.
    expect(res.headers["x-total-count"]).toBe("61");
    expect(res.headers["x-has-more"]).toBe("true");
  });

  it("walks the whole list without repeating or skipping a row", async () => {
    await seedReports(fx.alpha.tenantId, 25, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const seen = new Set<string>();
    for (let offset = 0; offset < 26; offset += 10) {
      const res = await request(app).get(`/reports?limit=10&offset=${offset}`).set(auth(token));
      for (const report of res.body) seen.add(report.reportId);
    }

    expect(seen.size).toBe(26); // 25 + the fixture's own
  });

  it("says when there is nothing more to fetch", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports?limit=50").set(auth(token));
    expect(res.headers["x-has-more"]).toBe("false");
  });

  it("clamps an absurd limit rather than refusing the request", async () => {
    await seedReports(fx.alpha.tenantId, 5, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports?limit=100000").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-limit"]).toBe("200");
  });

  it("ignores junk paging values instead of erroring", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/reports?limit=abc&offset=-99").set(auth(token));
    expect(res.status).toBe(200);
    expect(res.headers["x-limit"]).toBe("50");
    expect(res.headers["x-offset"]).toBe("0");
  });
});

describe("searching and filtering reports", () => {
  it("finds a device by part of its serial number", async () => {
    await seedReports(fx.alpha.tenantId, 20, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports?q=SERIAL-007").set(auth(token));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].serialNumber).toBe("ALPHA-SERIAL-007");
  });

  it("matches case-insensitively, since a serial is usually retyped", async () => {
    await seedReports(fx.alpha.tenantId, 3, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/reports?q=alpha-serial-001").set(auth(token));
    expect(res.body).toHaveLength(1);
  });

  it("searches IMEI and model as well as serial", async () => {
    await seedReports(fx.alpha.tenantId, 4, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    expect((await request(app).get("/reports?q=Galaxy").set(auth(token))).body.length).toBeGreaterThan(0);
    expect((await request(app).get("/reports?q=356938035643001").set(auth(token))).body).toHaveLength(1);
  });

  it("NEVER reaches another tenant's device, however specific the term", async () => {
    await seedReports(fx.beta.tenantId, 10, "BETA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    // An exact serial belonging to the other tenant.
    const res = await request(app).get("/reports?q=BETA-SERIAL-003").set(auth(token));
    expect(res.body).toHaveLength(0);
    expect(res.headers["x-total-count"]).toBe("0");
  });

  it("filters by outcome, and rejects an unknown status rather than matching nothing", async () => {
    await seedReports(fx.alpha.tenantId, 12, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const failed = await request(app).get("/reports?status=fail").set(auth(token));
    expect(failed.body.length).toBeGreaterThan(0);
    for (const report of failed.body) expect(report.overallStatus).toBe("fail");

    // "failed" is not a status. Matching nothing would read as "no
    // failed inspections", which is a different and false claim.
    const typo = await request(app).get("/reports?status=failed").set(auth(token));
    expect(typo.status).toBe(400);
  });

  it("filters by date range", async () => {
    await seedReports(fx.alpha.tenantId, 30, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const recent = await request(app).get(`/reports?from=${cutoff}`).set(auth(token));

    expect(recent.body.length).toBeGreaterThan(0);
    for (const report of recent.body) {
      expect(new Date(report.generatedAt).getTime()).toBeGreaterThanOrEqual(new Date(cutoff).getTime());
    }
  });

  it("counts the filtered set, not the whole table", async () => {
    await seedReports(fx.alpha.tenantId, 30, "ALPHA");
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const filtered = await request(app).get("/reports?status=fail&limit=5").set(auth(token));
    const all = await request(app).get("/reports?limit=5").set(auth(token));

    // Otherwise a UI shows "1–5 of 31" on a filter that has 10 matches.
    expect(Number(filtered.headers["x-total-count"])).toBeLessThan(Number(all.headers["x-total-count"]));
  });
});

describe("paging the audit trail and the dispute queue", () => {
  it("pages the activity log and counts the filtered set", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    for (let i = 0; i < 15; i += 1) {
      await prisma.activityLogEntry.create({
        data: {
          tenantId: fx.alpha.tenantId,
          actorUserId: "seed",
          actorRole: "tenant_admin",
          action: "profile_updated",
          targetType: "profile",
          targetId: `p-${i}`,
          details: `entry ${i}`,
        },
      });
    }

    const res = await request(app).get("/activity-log?limit=5&actions=profile_updated").set(auth(token));
    expect(res.body).toHaveLength(5);
    expect(res.headers["x-total-count"]).toBe("15");
    expect(res.headers["x-has-more"]).toBe("true");
  });

  it("pages the dispute queue oldest-first, so the longest wait stays on page one", async () => {
    for (let i = 0; i < 8; i += 1) {
      await prisma.dispute.create({
        data: {
          tenantId: fx.alpha.tenantId,
          reportId: fx.alpha.reportId,
          disputingItem: "The overall grade",
          customerNote: `complaint ${i}`,
          submittedAt: new Date(Date.now() - (8 - i) * 3_600_000),
        },
      });
    }
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const res = await request(app).get("/disputes?limit=3").set(auth(token));
    expect(res.body).toHaveLength(3);
    expect(res.headers["x-total-count"]).toBe("8");
    expect(res.body[0].customerNote).toBe("complaint 0");
  });
});
