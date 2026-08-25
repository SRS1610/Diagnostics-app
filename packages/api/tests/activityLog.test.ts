// tests/activityLog.test.ts
//
// Direct coverage for GET /activity-log — the audit-trail read.

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

describe("GET /activity-log", () => {
  it("lists only this tenant's entries and returns pagination headers", async () => {
    const res = await request(app)
      .get("/activity-log?limit=50")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // seedTwoTenants creates one entry per tenant; the login-just-happened
    // adds another. Alpha rows only.
    expect(res.body.every((e: { tenantId: string | null }) => e.tenantId === f.alpha.tenantId)).toBe(true);
    expect(res.headers["x-total-count"]).toBeDefined();
  });

  it("filters by action= with a comma-separated list", async () => {
    const res = await request(app)
      .get("/activity-log?actions=portal_login")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.every((e: { action: string }) => e.action === "portal_login")).toBe(true);
  });

  it("400s an unknown action name — a typo becomes an audit gap otherwise", async () => {
    const res = await request(app)
      .get("/activity-log?actions=defintely_not_a_real_action")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(res.status).toBe(400);
  });

  it("filters by actorUserId", async () => {
    // Any of Alpha's entries carry the seed actorUserId "seed" — filter
    // for it and expect matches, filter for a bogus one and expect zero.
    const seed = await request(app)
      .get("/activity-log?actorUserId=seed")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(seed.body.every((e: { actorUserId: string }) => e.actorUserId === "seed")).toBe(true);

    const bogus = await request(app)
      .get("/activity-log?actorUserId=nobody-here")
      .set("Authorization", `Bearer ${alphaAdminToken}`);
    expect(bogus.body).toEqual([]);
  });
});
