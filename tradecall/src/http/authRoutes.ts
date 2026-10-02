// Signup (creates a tenant + its OWNER), login, and accepting a team invite.

import { createHash, randomBytes } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { issueToken, type Session } from "../lib/auth";
import { db } from "../lib/db";
import { DEFAULT_AFTER_HOURS_TEXT, DEFAULT_MISSED_TEXT } from "../lib/text";
import { DEFAULT_HOURS, validTimeZone } from "../lib/time";
import { audit } from "../core/audit";
import type { Deps } from "../core/deps";
import { HttpError, email, password, personName, phone } from "./common";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newInviteToken = () => randomBytes(32).toString("base64url");

const asActor = (u: { id: string; name: string; role: Session["role"]; businessId: string | null }): Session => ({
  userId: u.id, name: u.name, role: u.role, businessId: u.businessId, viewAs: false, suspended: false,
});

export function authRoutes(deps: Deps): Router {
  const r = Router();
  const limit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  r.post("/signup", limit, async (req, res) => {
    const body = z
      .object({
        businessName: z.string().trim().min(2).max(80),
        ownerName: personName,
        email,
        password,
        ownerPhone: phone,
        timezone: z.string().refine(validTimeZone, "Unknown timezone").default("America/New_York"),
      })
      .parse(req.body);
    if (await db.user.findUnique({ where: { email: body.email } })) throw new HttpError(409, "That email already has an account");
    const user = await db.$transaction(async (tx) => {
      const b = await tx.business.create({
        data: {
          name: body.businessName, ownerName: body.ownerName, email: body.email, ownerPhone: body.ownerPhone, timezone: body.timezone,
          hours: DEFAULT_HOURS, missedText: DEFAULT_MISSED_TEXT, afterHoursText: DEFAULT_AFTER_HOURS_TEXT,
        },
      });
      return tx.user.create({
        data: {
          businessId: b.id, email: body.email, passwordHash: await bcrypt.hash(body.password, 10), name: body.ownerName,
          role: "OWNER", phone: body.ownerPhone, getsAlerts: true, lastLoginAt: deps.now(),
        },
      });
    });
    await audit(asActor(user), user.businessId, "tenant_created", body.businessName);
    res.status(201).json({ token: issueToken(user) });
  });

  r.post("/login", limit, async (req, res) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const user = await db.user.findUnique({ where: { email: body.email } });
    // Same answer for "no such user", "wrong password" and "deactivated".
    if (!user || !user.active || !(await bcrypt.compare(body.password, user.passwordHash))) throw new HttpError(401, "Wrong email or password");
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: deps.now() } });
    await audit(asActor(user), user.businessId, "login");
    res.json({ token: issueToken(user), role: user.role });
  });

  async function openInvite(token: string) {
    const invite = await db.invite.findUnique({ where: { tokenHash: hashToken(token) }, include: { business: { select: { name: true } } } });
    if (!invite || invite.acceptedAt || invite.revokedAt) throw new HttpError(404, "This invite link isn't valid any more — ask for a new one");
    if (invite.expiresAt <= deps.now()) throw new HttpError(410, "This invite has expired — ask for a new one");
    return invite;
  }

  r.get("/invite/:token", limit, async (req, res) => {
    const invite = await openInvite(req.params.token);
    res.json({ businessName: invite.business.name, email: invite.email, role: invite.role });
  });

  r.post("/invite/:token/accept", limit, async (req, res) => {
    const invite = await openInvite(req.params.token);
    const body = z.object({ name: personName, password, phone: phone.optional() }).parse(req.body);
    if (await db.user.findUnique({ where: { email: invite.email } })) throw new HttpError(409, "That email already has an account — sign in instead");
    const user = await db.$transaction(async (tx) => {
      // Claim the invite atomically so a double-submit can't create two users.
      const claimed = await tx.invite.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: deps.now() } });
      if (!claimed.count) throw new HttpError(409, "This invite was already used");
      return tx.user.create({
        data: {
          businessId: invite.businessId, email: invite.email, passwordHash: await bcrypt.hash(body.password, 10), name: body.name,
          role: invite.role, phone: body.phone ?? null, getsAlerts: Boolean(body.phone), lastLoginAt: deps.now(),
        },
      });
    });
    await audit(asActor(user), user.businessId, "invite_accepted", user.email, { role: user.role });
    res.status(201).json({ token: issueToken(user) });
  });

  return r;
}
