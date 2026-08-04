// tests/mfa.test.ts
//
// TOTP MFA (RFC 6238), hand-rolled in lib/totp.ts rather than a
// dependency — these tests exercise both the crypto in isolation and
// the full login flow it gates, because a correct HOTP/TOTP
// implementation that isn't actually wired into login to REFUSE
// password-only access would be worthless.

import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/app";
import { Fixtures, PASSWORD, prisma, resetDatabase, seedTwoTenants } from "./fixtures";
import { portalLogin } from "./helpers";
import { generateTotpSecret, totpCodeAt, verifyTotpCode } from "../src/lib/totp";

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

describe("lib/totp — the crypto itself", () => {
  it("produces a code that verifies against the same secret", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotpCode(secret, totpCodeAt(secret, Math.floor(now / 1000)), now)).toBe(true);
  });

  it("rejects a code from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const now = Date.now();
    const codeForB = totpCodeAt(secretB, Math.floor(now / 1000));
    expect(verifyTotpCode(secretA, codeForB, now)).toBe(false);
  });

  it("tolerates a small amount of clock drift", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    // One step (30s) either side is the documented tolerance.
    const early = totpCodeAt(secret, Math.floor(now / 1000) - 30);
    const late = totpCodeAt(secret, Math.floor(now / 1000) + 30);
    expect(verifyTotpCode(secret, early, now)).toBe(true);
    expect(verifyTotpCode(secret, late, now)).toBe(true);
  });

  it("rejects a code far outside the tolerance window", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const farFuture = totpCodeAt(secret, Math.floor(now / 1000) + 300);
    expect(verifyTotpCode(secret, farFuture, now)).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "")).toBe(false);
  });
});

describe("enrollment", () => {
  it("does not enable MFA until the code is confirmed", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const enroll = await request(app).post("/auth/mfa/enroll").set(auth(token));
    expect(enroll.status).toBe(200);
    expect(enroll.body.secret).toEqual(expect.any(String));
    expect(enroll.body.otpauthUri).toContain("otpauth://totp/");

    // The secret is stored, but login still doesn't ask for a code —
    // an abandoned enrollment must not silently start guarding the
    // account.
    const user = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    expect(user!.mfaSecret).toBe(enroll.body.secret);
    expect(user!.mfaEnabled).toBe(false);

    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBeUndefined();
  });

  it("rejects confirmation with the wrong code", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    await request(app).post("/auth/mfa/enroll").set(auth(token));

    const confirm = await request(app).post("/auth/mfa/confirm").set(auth(token)).send({ code: "000000" });
    expect(confirm.status).toBe(400);

    const user = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    expect(user!.mfaEnabled).toBe(false);
  });

  it("confirming with the right code enables MFA and issues ten backup codes", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const enroll = await request(app).post("/auth/mfa/enroll").set(auth(token));
    const code = totpCodeAt(enroll.body.secret, Math.floor(Date.now() / 1000));

    const confirm = await request(app).post("/auth/mfa/confirm").set(auth(token)).send({ code });
    expect(confirm.status).toBe(200);
    expect(confirm.body.backupCodes).toHaveLength(10);
    // All ten distinct.
    expect(new Set(confirm.body.backupCodes).size).toBe(10);

    const user = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    expect(user!.mfaEnabled).toBe(true);
    expect(await prisma.mfaBackupCode.count({ where: { userId: user!.userId } })).toBe(10);
  });

  it("never stores a backup code in plaintext", async () => {
    const token = await portalLogin(app, fx.alpha.adminEmail);
    const enroll = await request(app).post("/auth/mfa/enroll").set(auth(token));
    const code = totpCodeAt(enroll.body.secret, Math.floor(Date.now() / 1000));
    const confirm = await request(app).post("/auth/mfa/confirm").set(auth(token)).send({ code });

    const stored = await prisma.mfaBackupCode.findMany();
    for (const row of stored) {
      expect(confirm.body.backupCodes).not.toContain(row.codeHash);
    }
  });
});

/** Enrolls and confirms MFA for alpha's admin, returning the secret and
 *  the fresh portal session (used before enabling) plus a NEW login
 *  helper for exercising the post-MFA flow. */
async function enableMfa(app: Express, email: string) {
  const token = await portalLogin(app, email);
  const enroll = await request(app).post("/auth/mfa/enroll").set(auth(token));
  const code = totpCodeAt(enroll.body.secret, Math.floor(Date.now() / 1000));
  const confirm = await request(app).post("/auth/mfa/confirm").set(auth(token)).send({ code });
  return { secret: enroll.body.secret as string, backupCodes: confirm.body.backupCodes as string[] };
}

describe("logging in with MFA enabled", () => {
  it("withholds the real session token until MFA is verified", async () => {
    await enableMfa(app, fx.alpha.adminEmail);

    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.token).toBeUndefined();
    expect(login.body.mfaToken).toEqual(expect.any(String));
  });

  it("the pending mfa token cannot be used as a real session token", async () => {
    await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });

    // requireAuth checks kind === "portal"; this token's kind is
    // "portal_mfa_pending" and must be refused everywhere else.
    const res = await request(app).get("/reports").set(auth(login.body.mfaToken));
    expect(res.status).toBe(401);
  });

  it("completes login with a valid TOTP code", async () => {
    const { secret } = await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });

    const code = totpCodeAt(secret, Math.floor(Date.now() / 1000));
    const verify = await request(app).post("/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code });
    expect(verify.status).toBe(200);
    expect(verify.body.token).toEqual(expect.any(String));

    const check = await request(app).get("/reports").set(auth(verify.body.token));
    expect(check.status).toBe(200);
  });

  it("refuses an incorrect code", async () => {
    await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });

    const verify = await request(app).post("/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code: "000000" });
    expect(verify.status).toBe(401);
  });

  it("consumes a backup code exactly once", async () => {
    const { backupCodes } = await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });

    const first = await request(app)
      .post("/auth/mfa/verify")
      .send({ mfaToken: login.body.mfaToken, code: backupCodes[0] });
    expect(first.status).toBe(200);
    expect(first.body.backupCodesRemaining).toBe(9);

    // Same backup code, a fresh login attempt: must not work twice.
    const secondLogin = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    const replay = await request(app)
      .post("/auth/mfa/verify")
      .send({ mfaToken: secondLogin.body.mfaToken, code: backupCodes[0] });
    expect(replay.status).toBe(401);
  });

  it("a deactivated account cannot complete MFA even with a correct code", async () => {
    const { secret } = await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });

    const admin = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    await prisma.portalUser.update({ where: { userId: admin!.userId }, data: { active: false } });

    const code = totpCodeAt(secret, Math.floor(Date.now() / 1000));
    const verify = await request(app).post("/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code });
    expect(verify.status).toBe(401);
  });
});

describe("disabling MFA", () => {
  it("requires the current password and a valid code", async () => {
    const { secret } = await enableMfa(app, fx.alpha.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    const code = totpCodeAt(secret, Math.floor(Date.now() / 1000));
    const verify = await request(app).post("/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code });
    const sessionToken = verify.body.token;

    const wrongPassword = await request(app)
      .post("/auth/mfa/disable")
      .set(auth(sessionToken))
      .send({ currentPassword: "nope", code: totpCodeAt(secret, Math.floor(Date.now() / 1000)) });
    expect(wrongPassword.status).toBe(401);

    const wrongCode = await request(app)
      .post("/auth/mfa/disable")
      .set(auth(sessionToken))
      .send({ currentPassword: PASSWORD, code: "000000" });
    expect(wrongCode.status).toBe(400);

    const ok = await request(app)
      .post("/auth/mfa/disable")
      .set(auth(sessionToken))
      .send({ currentPassword: PASSWORD, code: totpCodeAt(secret, Math.floor(Date.now() / 1000)) });
    expect(ok.status).toBe(204);

    const user = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    expect(user!.mfaEnabled).toBe(false);
    expect(user!.mfaSecret).toBeNull();
  });

  it("clears backup codes on disable, so re-enrolling starts clean", async () => {
    const { secret } = await enableMfa(app, fx.alpha.adminEmail);
    const admin = await prisma.portalUser.findFirst({ where: { email: fx.alpha.adminEmail } });
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    const verify = await request(app)
      .post("/auth/mfa/verify")
      .send({ mfaToken: login.body.mfaToken, code: totpCodeAt(secret, Math.floor(Date.now() / 1000)) });

    await request(app)
      .post("/auth/mfa/disable")
      .set(auth(verify.body.token))
      .send({ currentPassword: PASSWORD, code: totpCodeAt(secret, Math.floor(Date.now() / 1000)) });

    expect(await prisma.mfaBackupCode.count({ where: { userId: admin!.userId } })).toBe(0);

    // And login no longer requires a second factor.
    const after = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    expect(after.body.mfaRequired).toBeUndefined();
    expect(after.body.token).toEqual(expect.any(String));
  });
});

describe("isolation", () => {
  it("beta's MFA setup never affects alpha's login", async () => {
    await enableMfa(app, fx.beta.adminEmail);
    const login = await request(app).post("/auth/login").send({ email: fx.alpha.adminEmail, password: PASSWORD });
    expect(login.body.mfaRequired).toBeUndefined();
    expect(login.body.token).toEqual(expect.any(String));
  });
});
