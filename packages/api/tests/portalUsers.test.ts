// tests/portalUsers.test.ts
//
// Covers the two defects this feature exists to fix — a provisioned
// tenant nobody could sign into, and portal access that could not be
// revoked — plus the escalation and lockout paths that user management
// introduces if it is built carelessly.

import request from "supertest";
import type { Express } from "express";
import bcrypt from "bcrypt";
import { createApp } from "../src/app";
import { Fixtures, PASSWORD, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";

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

describe("a provisioned tenant can actually be signed into", () => {
  it("creates a first admin alongside the tenant and returns a working password", async () => {
    const master = await portalLogin(app, fx.masterEmail);

    const created = await request(app)
      .post("/tenants")
      .set(auth(master))
      .send({ companyName: "Newly Provisioned Co", primaryContactEmail: "owner@newco.test" });

    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toEqual(expect.any(String));

    // The whole point: that password must actually get someone in.
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "owner@newco.test", password: created.body.temporaryPassword });

    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe("tenant_admin");
    expect(login.body.user.tenantId).toBe(created.body.tenantId);
    // And they are told to replace it, since an admin has seen it.
    expect(login.body.user.mustChangePassword).toBe(true);
  });

  it("creates no tenant at all if its admin cannot be created", async () => {
    const master = await portalLogin(app, fx.masterEmail);
    const before = await prisma.tenant.count();

    const res = await request(app)
      .post("/tenants")
      .set(auth(master))
      .send({ companyName: "Doomed Co", primaryContactEmail: fx.alpha.adminEmail }); // address taken

    expect(res.status).toBe(409);
    // A tenant with no way in is worse than no tenant.
    expect(await prisma.tenant.count()).toBe(before);
  });
});

describe("revocation actually revokes", () => {
  it("stops an already-issued portal token the moment the account is deactivated", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const staff = await prisma.portalUser.create({
      data: {
        email: "staff@alpha.test",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "tenant_staff",
        tenantId: fx.alpha.tenantId,
      },
    });

    const staffToken = await portalLogin(app, "staff@alpha.test");
    expect((await request(app).get("/reports").set(auth(staffToken))).status).toBe(200);

    await request(app).patch(`/users/${staff.userId}`).set(auth(admin)).send({ active: false });

    // Same token, not expired, now refused.
    expect((await request(app).get("/reports").set(auth(staffToken))).status).toBe(401);
  });

  it("gives a deactivated account the same login error as a wrong password", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const staff = await prisma.portalUser.create({
      data: {
        email: "gone@alpha.test",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "tenant_staff",
        tenantId: fx.alpha.tenantId,
      },
    });
    await request(app).patch(`/users/${staff.userId}`).set(auth(admin)).send({ active: false });

    const deactivated = await request(app).post("/auth/login").send({ email: "gone@alpha.test", password: PASSWORD });
    const wrongPassword = await request(app)
      .post("/auth/login")
      .send({ email: "gone@alpha.test", password: "not-the-password" });

    // Identical, so the form cannot be used to confirm an address exists.
    expect(deactivated.status).toBe(401);
    expect(deactivated.body).toEqual(wrongPassword.body);
  });

  it("applies a demotion immediately rather than at token expiry", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const second = await prisma.portalUser.create({
      data: {
        email: "second-admin@alpha.test",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "tenant_admin",
        tenantId: fx.alpha.tenantId,
      },
    });
    const secondToken = await portalLogin(app, "second-admin@alpha.test");

    // Admin-only action works before the demotion.
    expect(
      (await request(app).post("/users").set(auth(secondToken)).send({ email: "x@alpha.test", role: "tenant_staff" }))
        .status,
    ).toBe(201);

    await request(app).patch(`/users/${second.userId}`).set(auth(admin)).send({ role: "tenant_staff" });

    // The role is re-read per request, so the old token no longer carries
    // admin powers.
    const after = await request(app)
      .post("/users")
      .set(auth(secondToken))
      .send({ email: "y@alpha.test", role: "tenant_staff" });
    expect(after.status).toBe(403);
  });
});

describe("user management stays inside its tenant", () => {
  it("lists only this tenant's users", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/users").set(auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const user of res.body) expect(user.tenantId).toBe(fx.alpha.tenantId);
  });

  it("never returns a password hash", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app).get("/users").set(auth(admin));
    expect(JSON.stringify(res.body)).not.toContain("$2b$");
    for (const user of res.body) expect(user.passwordHash).toBeUndefined();
  });

  it("cannot touch another tenant's user", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const betaUser = await prisma.portalUser.findFirst({ where: { tenantId: fx.beta.tenantId } });

    expect((await request(app).patch(`/users/${betaUser!.userId}`).set(auth(admin)).send({ active: false })).status)
      .toBe(404);
    expect((await request(app).delete(`/users/${betaUser!.userId}`).set(auth(admin))).status).toBe(404);

    const stillThere = await prisma.portalUser.findUnique({ where: { userId: betaUser!.userId } });
    expect(stillThere!.active).toBe(true);
  });

  it("refuses to create a master_admin from inside a tenant", async () => {
    // The most valuable thing a compromised tenant admin could do.
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/users")
      .set(auth(admin))
      .send({ email: "escalated@alpha.test", role: "master_admin" });

    expect(res.status).toBe(400);
    expect(await prisma.portalUser.count({ where: { role: "master_admin" } })).toBe(1);
  });

  it("refuses user management to tenant_staff", async () => {
    await prisma.portalUser.create({
      data: {
        email: "limited@alpha.test",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "tenant_staff",
        tenantId: fx.alpha.tenantId,
      },
    });
    const staffToken = await portalLogin(app, "limited@alpha.test");

    expect((await request(app).post("/users").set(auth(staffToken)).send({ email: "n@a.test", role: "tenant_staff" })).status)
      .toBe(403);
  });
});

describe("nobody can lock a tenant out of its own portal", () => {
  it("refuses to deactivate the last active admin", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const me = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });

    const res = await request(app).patch(`/users/${me!.userId}`).set(auth(admin)).send({ active: false });
    expect(res.status).toBe(409);

    const stillActive = await prisma.portalUser.findUnique({ where: { userId: me!.userId } });
    expect(stillActive!.active).toBe(true);
  });

  it("refuses to delete the last admin", async () => {
    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const other = await prisma.portalUser.create({
      data: {
        email: "other@alpha.test",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        role: "tenant_admin",
        tenantId: fx.alpha.tenantId,
      },
    });
    const otherToken = await portalLogin(app, "other@alpha.test");
    const me = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });

    // Deleting one of two admins is fine.
    expect((await request(app).delete(`/users/${me!.userId}`).set(auth(otherToken))).status).toBe(204);
    // Deleting the last one is not — and you cannot delete yourself.
    expect((await request(app).delete(`/users/${other.userId}`).set(auth(otherToken))).status).toBe(409);
  });
});

describe("passwords", () => {
  it("lets a user change their own password and refuses the old one afterwards", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const NEW = "a-much-longer-passphrase";

    const changed = await request(app)
      .post("/auth/change-password")
      .set(auth(token))
      .send({ currentPassword: PASSWORD, newPassword: NEW });
    expect(changed.status).toBe(204);

    expect((await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD })).status)
      .toBe(401);
    expect((await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: NEW })).status)
      .toBe(200);
  });

  it("requires the current password, so an unattended session cannot lock out its owner", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const res = await request(app)
      .post("/auth/change-password")
      .set(auth(token))
      .send({ currentPassword: "wrong", newPassword: "a-much-longer-passphrase" });
    expect(res.status).toBe(401);
  });

  it("enforces a minimum length and rejects the obvious choices", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    for (const weak of ["short", "password123", "changeme123"]) {
      const res = await request(app)
        .post("/auth/change-password")
        .set(auth(token))
        .send({ currentPassword: PASSWORD, newPassword: weak });
      expect(res.status).toBe(400);
    }
  });

  it("answers forgot-password identically for a real and an unknown address", async () => {
    const known = await request(app).post("/auth/forgot-password").send({ email: fx.alpha.adminEmail });
    const unknown = await request(app).post("/auth/forgot-password").send({ email: "nobody@nowhere.test" });

    expect(known.status).toBe(unknown.status);
    expect(known.body.message).toBe(unknown.body.message);
    // ...while still having prepared a real reset for the real one.
    expect(await prisma.passwordResetToken.count()).toBe(1);
  });

  it("consumes a reset token exactly once", async () => {
    process.env.DEV_RETURN_RESET_TOKEN = "1";
    const requested = await request(app).post("/auth/forgot-password").send({ email: fx.alpha.adminEmail });
    const token = requested.body.devResetToken as string;
    delete process.env.DEV_RETURN_RESET_TOKEN;

    const first = await request(app)
      .post("/auth/reset-password")
      .send({ token, newPassword: "a-much-longer-passphrase" });
    expect(first.status).toBe(204);

    const replayed = await request(app)
      .post("/auth/reset-password")
      .send({ token, newPassword: "another-long-passphrase" });
    expect(replayed.status).toBe(400);
  });

  it("stores only the hash of a reset token", async () => {
    process.env.DEV_RETURN_RESET_TOKEN = "1";
    const requested = await request(app).post("/auth/forgot-password").send({ email: fx.alpha.adminEmail });
    const token = requested.body.devResetToken as string;
    delete process.env.DEV_RETURN_RESET_TOKEN;

    const stored = await prisma.passwordResetToken.findFirst();
    // A database dump must not hand over live reset links.
    expect(stored!.tokenHash).not.toBe(token);
  });

  it("voids outstanding reset links when an admin resets the password", async () => {
    process.env.DEV_RETURN_RESET_TOKEN = "1";
    const requested = await request(app).post("/auth/forgot-password").send({ email: fx.alpha.adminEmail });
    const staleToken = requested.body.devResetToken as string;
    delete process.env.DEV_RETURN_RESET_TOKEN;

    const admin = await portalLogin(app, fx.alpha.adminEmail);
    const me = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    const reset = await request(app).post(`/users/${me!.userId}/reset-password`).set(auth(admin));
    expect(reset.status).toBe(200);

    // The link minted before the reset must not still work.
    const res = await request(app)
      .post("/auth/reset-password")
      .send({ token: staleToken, newPassword: "a-much-longer-passphrase" });
    expect(res.status).toBe(400);

    // And the admin-issued password does work.
    const login = await request(app)
      .post("/auth/login")
      .send({ email: fx.alpha.adminEmail, password: reset.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.mustChangePassword).toBe(true);
  });
});
