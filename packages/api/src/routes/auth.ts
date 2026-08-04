// src/routes/auth.ts
//
// Implements the login() flow from portalAuth.ts as a real HTTP endpoint.
// See CLAUDE.md "Multi-tenant architecture" — tenant_admin/tenant_staff
// land directly in their own tenant; master_admin lands with
// viewingTenantId: null until they call /auth/enter-tenant-view.

import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import { requireAuth, requireMasterAdmin } from "../middleware/auth";
import { buildActivityLogData } from "../lib/activityLog";
import { generateBackupCodes, generateResetToken, validatePassword } from "../lib/passwords";
import { generateTotpSecret, totpEnrollmentUri, verifyTotpCode } from "../lib/totp";
import { buildAuthorizationUrl, exchangeCodeForTokens, verifyIdToken } from "../lib/oidc";
import { prisma } from "../lib/prisma";
import { randomBytes } from "node:crypto";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000";
const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL ?? "http://localhost:5173";

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await prisma.portalUser.findUnique({ where: { email: String(email).trim().toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  // A deactivated account gets the SAME message as a wrong password.
  // "Your account is disabled" confirms the address is real, which is
  // the one fact an unauthenticated caller should not be able to harvest
  // from a login form.
  if (!user.active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // SSO enforcement. Refused for tenant_staff, same hard-gate pattern as
  // everything else in this app — but NOT for tenant_admin. A
  // misconfigured or temporarily-down IdP with enforcement on and no
  // exception would lock every admin at that tenant out with no way
  // back in short of a database edit; a tenant_admin keeps a password
  // break-glass path deliberately. master_admin is unaffected (no
  // tenantId, not subject to any tenant's connection).
  if (user.tenantId && user.role === "tenant_staff") {
    const connection = await prisma.ssoConnection.findFirst({ where: { tenantId: user.tenantId, enforced: true } });
    if (connection) {
      return res.status(403).json({ error: "This organization requires signing in with SSO. Use the SSO link on the login page." });
    }
  }

  const viewingTenantId = user.tenantId; // tenant users land in their own tenant;
                                          // master_admin lands with null (Master Console)

  // MFA gate. Password verified above is only the FIRST factor once
  // mfaEnabled is set — the real portal session token is not issued
  // until /auth/mfa/verify confirms the second one. What's returned here
  // instead is a short-lived, narrowly-scoped token that requireAuth
  // rejects outright (kind !== "portal"), so it cannot be used to reach
  // any tenant-scoped route by mistake or on purpose.
  if (user.mfaEnabled) {
    const mfaToken = jwt.sign({ kind: "portal_mfa_pending", userId: user.userId }, JWT_SECRET, {
      expiresIn: "5m",
    });
    return res.json({ mfaRequired: true, mfaToken });
  }

  const token = jwt.sign(
    { kind: "portal", userId: user.userId, role: user.role, tenantId: user.tenantId, viewingTenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_login",
      targetType: "session",
      targetId: user.userId,
      details: `${user.email} logged in`,
    }),
  });

  await prisma.portalUser.update({
    where: { userId: user.userId },
    data: { lastLoginAt: new Date() },
  });

  res.json({
    token,
    user: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      // The portal uses this to force the password screen before
      // anything else. The token IS issued: they have proved who they
      // are, they just cannot keep using a password an admin has seen.
      mustChangePassword: user.mustChangePassword,
    },
  });
});

// ============================================================
// MFA (TOTP, RFC 6238)
// ============================================================

// Brute-forcing a 6-digit TOTP code is 1,000,000 guesses; a tight limit
// is the only thing standing between that and this endpoint, since the
// pending token alone is not a secret worth much (it identifies a user
// who has already proven their password).
const mfaVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.MFA_VERIFY_RATE_LIMIT ?? 8),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

/** Completes login for an MFA-enabled account: the pending token from
 *  /login plus a 6-digit code (or a backup code) issues the real
 *  session token. */
router.post("/mfa/verify", mfaVerifyRateLimit, async (req, res) => {
  const { mfaToken, code } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof mfaToken !== "string" || typeof code !== "string") {
    return res.status(400).json({ error: "mfaToken and code are required" });
  }

  let decoded: { userId?: string; kind?: string };
  try {
    decoded = jwt.verify(mfaToken, JWT_SECRET) as typeof decoded;
  } catch {
    return res.status(401).json({ error: "This login attempt has expired. Sign in again." });
  }
  if (decoded.kind !== "portal_mfa_pending" || !decoded.userId) {
    return res.status(401).json({ error: "Invalid login attempt" });
  }

  const user = await prisma.portalUser.findUnique({ where: { userId: decoded.userId } });
  // Deactivated or MFA disabled between /login and here — a narrow
  // window, but a real one, and re-checked rather than assumed.
  if (!user || !user.active || !user.mfaEnabled || !user.mfaSecret) {
    return res.status(401).json({ error: "Invalid login attempt" });
  }

  const totpOk = verifyTotpCode(user.mfaSecret, code);
  const backupOk = totpOk ? false : await tryConsumeBackupCode(user.userId, code);
  if (!totpOk && !backupOk) {
    return res.status(401).json({ error: "Incorrect code" });
  }

  const token = jwt.sign(
    { kind: "portal", userId: user.userId, role: user.role, tenantId: user.tenantId, viewingTenantId: user.tenantId },
    JWT_SECRET,
    { expiresIn: "12h" },
  );

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_login",
      targetType: "session",
      targetId: user.userId,
      details: `${user.email} logged in${backupOk ? " (via MFA backup code)" : " (via MFA)"}`,
    }),
  });
  await prisma.portalUser.update({ where: { userId: user.userId }, data: { lastLoginAt: new Date() } });

  res.json({
    token,
    user: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    },
    // Surfaced so the portal can nudge "you're down to N backup codes" —
    // silently running out is how someone locks themselves out for real.
    ...(backupOk ? { backupCodesRemaining: await countRemainingBackupCodes(user.userId) } : {}),
  });
});

/** Starts enrollment: generates a secret and returns it (plus the
 *  otpauth:// URI to render as a QR code) but does NOT enable MFA yet —
 *  see the schema comment on mfaEnabled for why an unconfirmed secret
 *  must not protect the account. */
router.post("/mfa/enroll", requireAuth, async (req, res) => {
  const user = await prisma.portalUser.findUnique({ where: { userId: req.portalSession!.userId } });
  if (!user) return res.status(401).json({ error: "Session is no longer valid" });
  if (user.mfaEnabled) return res.status(409).json({ error: "MFA is already enabled on this account" });

  const secret = generateTotpSecret();
  await prisma.portalUser.update({ where: { userId: user.userId }, data: { mfaSecret: secret } });

  res.json({ secret, otpauthUri: totpEnrollmentUri(secret, user.email) });
});

/** Confirms enrollment with a code from the app, which is what actually
 *  flips mfaEnabled — proves the secret was successfully scanned/entered
 *  before it becomes the thing guarding the account. */
router.post("/mfa/confirm", requireAuth, async (req, res) => {
  const { code } = (req.body ?? {}) as Record<string, unknown>;
  const user = await prisma.portalUser.findUnique({ where: { userId: req.portalSession!.userId } });
  if (!user) return res.status(401).json({ error: "Session is no longer valid" });
  if (user.mfaEnabled) return res.status(409).json({ error: "MFA is already enabled on this account" });
  if (!user.mfaSecret) return res.status(409).json({ error: "Start enrollment first with /auth/mfa/enroll" });
  if (typeof code !== "string" || !verifyTotpCode(user.mfaSecret, code)) {
    return res.status(400).json({ error: "Incorrect code" });
  }

  const backupCodes = generateBackupCodes();
  await prisma.$transaction([
    prisma.portalUser.update({
      where: { userId: user.userId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    }),
    prisma.mfaBackupCode.createMany({
      data: await Promise.all(
        backupCodes.map(async (c) => ({ userId: user.userId, codeHash: await bcrypt.hash(c, 10) })),
      ),
    }),
  ]);

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_mfa_enabled",
      targetType: "portal_user",
      targetId: user.userId,
      details: `${user.email} enabled MFA`,
    }),
  });

  res.json({
    backupCodes,
    note: "Store these somewhere safe — this is the only time they are shown. Each works once, in place of a code from your app.",
  });
});

/** Turning MFA off requires the current password AND a valid code —
 *  the same "an unattended session shouldn't be enough" reasoning as
 *  change-password, doubled: this is the control being removed. */
router.post("/mfa/disable", requireAuth, async (req, res) => {
  const { currentPassword, code } = (req.body ?? {}) as Record<string, unknown>;
  const user = await prisma.portalUser.findUnique({ where: { userId: req.portalSession!.userId } });
  if (!user) return res.status(401).json({ error: "Session is no longer valid" });
  if (!user.mfaEnabled) return res.status(409).json({ error: "MFA is not enabled on this account" });

  if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  const totpOk = typeof code === "string" && user.mfaSecret && verifyTotpCode(user.mfaSecret, code);
  const backupOk = totpOk ? false : typeof code === "string" && (await tryConsumeBackupCode(user.userId, code));
  if (!totpOk && !backupOk) {
    return res.status(400).json({ error: "Incorrect code" });
  }

  await prisma.$transaction([
    prisma.portalUser.update({
      where: { userId: user.userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null },
    }),
    // Unused backup codes for a disabled MFA setup are dead weight and,
    // if MFA is re-enabled later, must not still work against the NEW
    // secret's setup — a clean slate each time.
    prisma.mfaBackupCode.deleteMany({ where: { userId: user.userId } }),
  ]);

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_mfa_disabled",
      targetType: "portal_user",
      targetId: user.userId,
      details: `${user.email} disabled MFA`,
    }),
  });

  res.status(204).send();
});

async function tryConsumeBackupCode(userId: string, code: string): Promise<boolean> {
  const candidates = await prisma.mfaBackupCode.findMany({ where: { userId, usedAt: null } });
  for (const candidate of candidates) {
    if (await bcrypt.compare(code, candidate.codeHash)) {
      // Conditional update: a code can be raced (two tabs submitting the
      // same recovery code) and must not be usable twice.
      const consumed = await prisma.mfaBackupCode.updateMany({
        where: { codeId: candidate.codeId, usedAt: null },
        data: { usedAt: new Date() },
      });
      return consumed.count > 0;
    }
  }
  return false;
}

async function countRemainingBackupCodes(userId: string): Promise<number> {
  return prisma.mfaBackupCode.count({ where: { userId, usedAt: null } });
}

// ============================================================
// Passwords
// ============================================================

// Unauthenticated and guessable-by-design (an email address), so the
// only thing standing between it and a mailbox-enumeration sweep or a
// token-generation flood is this limit.
const passwordResetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PASSWORD_RESET_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Changing your own password. Requires the current one — an unattended
 *  logged-in session should not be enough to lock out its owner. */
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;

  const check = validatePassword(newPassword);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const user = await prisma.portalUser.findUnique({ where: { userId: req.portalSession!.userId } });
  if (!user) return res.status(401).json({ error: "Session is no longer valid" });

  if (typeof currentPassword !== "string" || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  if (await bcrypt.compare(newPassword as string, user.passwordHash)) {
    return res.status(400).json({ error: "The new password must be different from the current one" });
  }

  await prisma.portalUser.update({
    where: { userId: user.userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword as string, 10),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  // Any outstanding reset links are void once the password changes.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "portal_password_changed",
      targetType: "portal_user",
      targetId: user.userId,
      details: `${user.email} changed their password`,
    }),
  });

  res.status(204).send();
});

/**
 * Self-service reset request.
 *
 * ALWAYS returns 204, whether or not the address exists — a different
 * response for a known address turns this into a "does this person have
 * an account here?" oracle, and on a multi-tenant platform that leaks
 * customer lists.
 *
 * With no email provider integrated, the token has nowhere to go. It is
 * created and recorded, and the response says plainly that delivery is
 * not wired up, so nobody is left waiting for a message that will never
 * arrive. In development, DEV_RETURN_RESET_TOKEN=1 returns it directly.
 */
router.post("/forgot-password", passwordResetRateLimit, async (req, res) => {
  const { email } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email is required" });
  }

  const user = await prisma.portalUser.findUnique({ where: { email: email.trim().toLowerCase() } });

  let devToken: string | undefined;
  if (user && user.active) {
    const token = generateResetToken();
    await prisma.passwordResetToken.create({
      data: {
        userId: user.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // one hour
      },
    });
    if (process.env.DEV_RETURN_RESET_TOKEN === "1") devToken = token;
  }

  res.status(200).json({
    // Deliberately identical for a real and an unknown address.
    message: "If that address has an account, a reset has been prepared.",
    deliveryNote:
      "No email provider is integrated, so nothing was sent. An administrator can reset the password directly from the Team page.",
    ...(devToken ? { devResetToken: devToken } : {}),
  });
});

/** Completes a reset with a token from /forgot-password. */
router.post("/reset-password", passwordResetRateLimit, async (req, res) => {
  const { token, newPassword } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || !token) return res.status(400).json({ error: "token is required" });

  const check = validatePassword(newPassword);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  // One message for every failure mode — expired, already used, never
  // existed. Distinguishing them tells an attacker which tokens were
  // real.
  const invalid = () => res.status(400).json({ error: "That reset link is invalid or has expired" });
  if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) return invalid();
  if (!record.user.active) return invalid();

  // Consume the token conditionally: two submissions of the same link
  // must not both succeed.
  const consumed = await prisma.passwordResetToken.updateMany({
    where: { tokenId: record.tokenId, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count === 0) return invalid();

  await prisma.portalUser.update({
    where: { userId: record.userId },
    data: {
      passwordHash: await bcrypt.hash(newPassword as string, 10),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
    },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: record.user.tenantId,
      actorUserId: record.userId,
      actorRole: record.user.role as any,
      action: "portal_password_changed",
      targetType: "portal_user",
      targetId: record.userId,
      details: `${record.user.email} reset their password`,
    }),
  });

  res.status(204).send();
});

// Master admin only — switches the session into a specific tenant's view
router.post("/enter-tenant-view", requireAuth, requireMasterAdmin, async (req, res) => {
  const { tenantId } = req.body;
  if (!tenantId) return res.status(400).json({ error: "tenantId is required" });

  const tenant = await prisma.tenant.findUnique({ where: { tenantId } });
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "entered_tenant_view",
      targetType: "tenant",
      targetId: tenantId,
      details: `Master admin entered tenant view for ${tenant.companyName}`,
    }),
  });

  // Issue a new token scoped to this tenant view
  const token = jwt.sign(
    { kind: "portal", userId: req.portalSession!.userId, role: "master_admin", tenantId: null, viewingTenantId: tenantId },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, viewingTenantId: tenantId });
});

// Master admin only — leaves tenant-support view, returning to Master
// Console context (viewingTenantId: null). Required before any
// requireMasterConsole-gated route (tenant CRUD, platform analytics)
// will accept the session again — see middleware/auth.ts.
router.post("/exit-tenant-view", requireAuth, requireMasterAdmin, async (req, res) => {
  const previousTenantId = req.portalSession!.viewingTenantId;

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: previousTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: "master_admin",
      action: "exited_tenant_view",
      targetType: "tenant",
      targetId: previousTenantId ?? "platform",
      details: "Master admin exited tenant view",
    }),
  });

  const token = jwt.sign(
    { kind: "portal", userId: req.portalSession!.userId, role: "master_admin", tenantId: null, viewingTenantId: null },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({ token, viewingTenantId: null });
});

// ============================================================
// SSO (OIDC). Unauthenticated by nature — nobody has a session yet.
//
// Three-step flow, split this way specifically so the real 12h session
// token never sits in a URL or browser history entry:
//   1. POST /sso/start   — domain -> authorizationUrl to redirect the
//      browser to
//   2. GET  /sso/callback — the IdP redirects here with a code; this
//      exchanges it, verifies the id_token, and redirects the browser to
//      the portal with a short-lived, single-purpose HANDOFF token
//   3. POST /sso/exchange — the portal immediately trades the handoff
//      for the real session token, server-to-server, off the URL
// ============================================================

const ssoStartRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.SSO_START_RATE_LIMIT ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

router.post("/sso/start", ssoStartRateLimit, async (req, res) => {
  const { email } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email address is required" });
  }
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return res.status(400).json({ error: "A valid email address is required" });

  const connection = await prisma.ssoConnection.findFirst({ where: { domain, enabled: true } });
  if (!connection) {
    return res.status(404).json({ error: "No SSO connection is configured for this email domain." });
  }

  const nonce = randomBytes(16).toString("hex");
  const state = jwt.sign(
    { kind: "sso_state", connectionId: connection.connectionId, nonce },
    JWT_SECRET,
    { expiresIn: "10m" },
  );

  const authorizationUrl = buildAuthorizationUrl(connection, {
    redirectUri: `${API_BASE_URL}/auth/sso/callback`,
    state,
    nonce,
  });

  res.json({ authorizationUrl });
});

/** The IdP redirects the browser here. Always ends in a redirect back to
 *  the portal — even on failure — since the caller is a browser
 *  mid-navigation, not an API client that can read a JSON error body. */
router.get("/sso/callback", async (req, res) => {
  const failure = (message: string) =>
    res.redirect(`${PORTAL_BASE_URL}/sso/complete?error=${encodeURIComponent(message)}`);

  const { code, state } = req.query;
  if (typeof code !== "string" || typeof state !== "string") {
    return failure("Missing code or state from the identity provider.");
  }

  let decoded: { kind?: string; connectionId?: string; nonce?: string };
  try {
    decoded = jwt.verify(state, JWT_SECRET) as typeof decoded;
  } catch {
    return failure("This sign-in attempt has expired. Try again.");
  }
  if (decoded.kind !== "sso_state" || !decoded.connectionId || !decoded.nonce) {
    return failure("Invalid sign-in attempt.");
  }

  const connection = await prisma.ssoConnection.findFirst({
    where: { connectionId: decoded.connectionId, enabled: true },
  });
  if (!connection) return failure("This organization's SSO connection is no longer available.");

  let identity: { subject: string; email: string };
  try {
    const { idToken } = await exchangeCodeForTokens(connection, code, `${API_BASE_URL}/auth/sso/callback`);
    identity = await verifyIdToken(connection, idToken, decoded.nonce);
  } catch (e) {
    // Deliberately generic to the browser — the real cause (network
    // failure, bad signature, issuer mismatch) goes to the server log,
    // not into a URL that could end up in a support screenshot.
    console.error("SSO callback failed:", e instanceof Error ? e.message : e);
    return failure("Could not complete sign-in with your identity provider.");
  }

  // Find-or-link-or-provision, in that order: an existing SSO-linked
  // account first (the common case after the first login), then an
  // existing password-based account with a matching email (linked by
  // email exactly once, moving forward matched by subject only — see
  // the ssoSubject schema comment), then JIT-provision a new one.
  let user = await prisma.portalUser.findFirst({
    where: { tenantId: connection.tenantId, ssoSubject: identity.subject },
  });
  if (!user) {
    const byEmail = await prisma.portalUser.findFirst({
      where: { tenantId: connection.tenantId, email: identity.email, ssoSubject: null },
    });
    if (byEmail) {
      user = await prisma.portalUser.update({
        where: { userId: byEmail.userId },
        data: { ssoSubject: identity.subject },
      });
    }
  }
  if (!user) {
    user = await prisma.portalUser.create({
      data: {
        tenantId: connection.tenantId,
        email: identity.email,
        // Unusable on purpose — a JIT-provisioned account is SSO-only
        // until an admin explicitly issues it a password via the
        // existing reset-password path. A random hash (never returned,
        // never logged) is simpler than a nullable passwordHash column
        // and needs no schema or login-path special-casing elsewhere.
        passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
        role: "tenant_staff",
        ssoSubject: identity.subject,
        mustChangePassword: false,
      },
    });
  }

  if (!user.active) return failure("This account has been deactivated.");

  const handoffToken = jwt.sign({ kind: "sso_handoff", userId: user.userId }, JWT_SECRET, { expiresIn: "2m" });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: user.tenantId,
      actorUserId: user.userId,
      actorRole: user.role as any,
      action: "sso_login",
      targetType: "session",
      targetId: user.userId,
      details: `${user.email} signed in via SSO`,
    }),
  });

  res.redirect(`${PORTAL_BASE_URL}/sso/complete?handoff=${handoffToken}`);
});

/** The portal calls this immediately after landing on /sso/complete —
 *  server-to-server, off the URL — to trade the one-time handoff for the
 *  real 12h session token. */
router.post("/sso/exchange", async (req, res) => {
  const { handoff } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof handoff !== "string") return res.status(400).json({ error: "handoff is required" });

  let decoded: { kind?: string; userId?: string };
  try {
    decoded = jwt.verify(handoff, JWT_SECRET) as typeof decoded;
  } catch {
    return res.status(401).json({ error: "This sign-in attempt has expired. Try again." });
  }
  if (decoded.kind !== "sso_handoff" || !decoded.userId) {
    return res.status(401).json({ error: "Invalid sign-in attempt." });
  }

  // Re-read fresh rather than trusting the callback's snapshot — active/
  // role could have changed in the (short) window since, same reasoning
  // as mfa/verify re-checking the user server-side.
  const user = await prisma.portalUser.findUnique({ where: { userId: decoded.userId } });
  if (!user || !user.active) return res.status(401).json({ error: "This account is no longer available." });

  const token = jwt.sign(
    { kind: "portal", userId: user.userId, role: user.role, tenantId: user.tenantId, viewingTenantId: user.tenantId },
    JWT_SECRET,
    { expiresIn: "12h" },
  );

  await prisma.portalUser.update({ where: { userId: user.userId }, data: { lastLoginAt: new Date() } });

  res.json({
    token,
    user: {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      mustChangePassword: user.mustChangePassword,
    },
  });
});

export default router;
