// tests/orgSettings.test.ts
//
// The point of this file: settings that a form saves and nothing reads
// are worse than no settings page — CLAUDE.md's own description of the
// stub this replaces. So beyond CRUD, these prove the two settings are
// ENFORCED at the places that matter: minPinLength at profile PIN
// validation, requirePurgeWipe at wipe-certificate recording.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin, technicianLogin } from "./helpers";

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

describe("reading and writing org settings", () => {
  it("returns the tenant's current settings with sane defaults", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/settings").set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.minPinLength).toBe(4);
    expect(res.body.requirePurgeWipe).toBe(false);
    expect(res.body.companyName).toBe(fx.alpha.companyName);
  });

  it("persists a change and returns it on the next read", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);

    const patched = await request(app)
      .patch("/settings")
      .set(auth(token))
      .send({ minPinLength: 6, requirePurgeWipe: true });
    expect(patched.status).toBe(200);
    expect(patched.body.minPinLength).toBe(6);
    expect(patched.body.requirePurgeWipe).toBe(true);

    // Not just returned by the write — actually stored.
    const reread = await request(app).get("/settings").set(auth(token));
    expect(reread.body.minPinLength).toBe(6);
    expect(reread.body.requirePurgeWipe).toBe(true);
  });

  it("logs the change to the activity trail", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(token)).send({ requirePurgeWipe: true });

    const log = await request(app).get("/activity-log?actions=settings_updated").set(auth(token));
    expect(log.body.length).toBeGreaterThan(0);
    expect(log.body[0].details).toMatch(/Purge/i);
  });

  it("rejects a minPinLength outside 4-6", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    for (const bad of [3, 7, 0, -1]) {
      const res = await request(app).patch("/settings").set(auth(token)).send({ minPinLength: bad });
      expect(res.status).toBe(400);
    }
  });

  it("refuses tenant_staff from changing settings", async () => {
    // Created via the users API rather than the fixture, so it comes
    // through with a real generated password rather than the shared
    // fixture one.
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const created = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "staffer@alpha.test", role: "tenant_staff" });
    expect(created.status).toBe(201);

    const login = await request(app)
      .post("/auth/login")
      .send({ email: "staffer@alpha.test", password: created.body.temporaryPassword });
    expect(login.status).toBe(200);

    const res = await request(app).patch("/settings").set(auth(login.body.token)).send({ minPinLength: 6 });
    expect(res.status).toBe(403);
  });

  it("never reads or writes another tenant's settings", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(alphaToken)).send({ minPinLength: 6 });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const betaSettings = await request(app).get("/settings").set(auth(betaToken));
    expect(betaSettings.body.minPinLength).toBe(4); // untouched
  });
});

describe("minPinLength is enforced, not cosmetic", () => {
  it("refuses a new profile whose PIN is shorter than the tenant's floor", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(token)).send({ minPinLength: 6 });

    const res = await request(app)
      .post("/profiles")
      .set(auth(token))
      .send({ customerName: "Short PIN Program", pin: "1234" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 6/);
  });

  it("accepts a profile meeting the raised floor", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(token)).send({ minPinLength: 6 });

    const res = await request(app)
      .post("/profiles")
      .set(auth(token))
      .send({ customerName: "Long PIN Program", pin: "123456" });
    expect(res.status).toBe(201);
  });

  it("does not retroactively invalidate a profile created before the floor was raised", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    // fx.alpha.profilePin is 4 digits, created under the default floor.
    await request(app).patch("/settings").set(auth(token)).send({ minPinLength: 6 });

    const stillThere = await prisma.customerProfile.findUnique({ where: { profileId: fx.alpha.profileId } });
    expect(stillThere!.pin).toBe(fx.alpha.profilePin);
  });

  it("blocks EDITING an existing profile down to a too-short PIN under the new floor", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(token)).send({ minPinLength: 6 });

    const res = await request(app)
      .patch(`/profiles/${fx.alpha.profileId}`)
      .set(auth(token))
      .send({ pin: "1234" });
    expect(res.status).toBe(400);
  });

  it("only enforces THIS tenant's floor, not another tenant's", async () => {
    const alphaToken = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(alphaToken)).send({ minPinLength: 6 });

    const betaToken = await portalLogin(app, fx.beta.adminEmail);
    const res = await request(app)
      .post("/profiles")
      .set(auth(betaToken))
      .send({ customerName: "Beta Short Program", pin: "1234" });
    expect(res.status).toBe(201); // beta's floor is still 4
  });
});

describe("requirePurgeWipe is enforced, not cosmetic", () => {
  it("refuses a Clear certificate once the tenant requires Purge", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(admin)).send({ requirePurgeWipe: true });

    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set(auth(techToken))
      .send({ standard: "nist_800_88_clear", passed: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Purge/);
    expect(await prisma.dataWipeCertificate.count({ where: { reportId: fx.alpha.reportId } })).toBe(0);
  });

  it("still accepts a Purge certificate when Purge is required", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(admin)).send({ requirePurgeWipe: true });

    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set(auth(techToken))
      .send({ standard: "nist_800_88_purge", passed: true });

    expect(res.status).toBe(201);
  });

  it("allows Clear when the tenant does not require Purge", async () => {
    const techToken = await technicianLogin(app, fx.alpha.tenantId, fx.alpha.badgeCode);
    const res = await request(app)
      .post(`/reports/${fx.alpha.reportId}/wipe-certificate`)
      .set(auth(techToken))
      .send({ standard: "nist_800_88_clear", passed: true });

    expect(res.status).toBe(201);
  });

  it("only enforces THIS tenant's requirement, not another tenant's", async () => {
    const alphaAdmin = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).patch("/settings").set(auth(alphaAdmin)).send({ requirePurgeWipe: true });

    const betaTech = await technicianLogin(app, fx.beta.tenantId, fx.beta.badgeCode);
    const res = await request(app)
      .post(`/reports/${fx.beta.reportId}/wipe-certificate`)
      .set(auth(betaTech))
      .send({ standard: "nist_800_88_clear", passed: true });

    expect(res.status).toBe(201); // beta never required Purge
  });
});
