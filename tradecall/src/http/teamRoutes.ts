// Team management inside one business. Rules:
//   • OWNER and ADMIN manage the team; MEMBER can only see it
//   • only an OWNER can create, change or remove an OWNER
//   • a business always keeps at least one active OWNER
//   • nobody changes their own role or deactivates themselves here
//   • seats (active users + pending invites) are capped by the plan

import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { session, tenant } from "../lib/auth";
import { config } from "../lib/config";
import { db } from "../lib/db";
import { PLANS } from "../lib/plans";
import { audit } from "../core/audit";
import type { Deps } from "../core/deps";
import { createInvite, SeatsFullError } from "../core/invites";
import { seatUsage } from "../core/team";
import { allow } from "./guards";
import { HttpError, email, password, personName, phone } from "./common";

const TEAM_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
const userFields = { id: true, name: true, email: true, role: true, phone: true, getsAlerts: true, active: true, lastLoginAt: true, createdAt: true } as const;

export function teamRoutes(deps: Deps): Router {
  const r = Router();

  r.get("/team", async (_req, res) => {
    const businessId = tenant(res);
    const s = session(res);
    const b = await db.business.findUniqueOrThrow({ where: { id: businessId } });
    const canManage = s.viewAs || s.role === "OWNER" || s.role === "ADMIN";
    const [users, invites, seats] = await Promise.all([
      db.user.findMany({ where: { businessId }, select: userFields, orderBy: [{ active: "desc" }, { createdAt: "asc" }] }),
      canManage
        ? db.invite.findMany({
            where: { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: deps.now() } },
            select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          })
        : [],
      seatUsage(businessId, deps.now()),
    ]);
    res.json({ users, invites, seats: { used: seats.used, limit: PLANS[b.plan].seats }, canManage });
  });

  r.post("/team/invites", allow("OWNER", "ADMIN"), async (req, res) => {
    const businessId = tenant(res);
    const s = session(res);
    const body = z.object({ email, role: z.enum(TEAM_ROLES) }).parse(req.body);
    if (body.role === "OWNER" && s.role !== "OWNER") throw new HttpError(403, "Only an owner can invite another owner");
    // Deliberately no "already has an account" check here: it would let any
    // admin probe which emails use TradeCall. Accepting the invite enforces it.

    const b = await db.business.findUniqueOrThrow({ where: { id: businessId } });
    try {
      const { invite, link, emailed } = await createInvite(deps, b, body.email, body.role, s);
      // The link goes back to the inviter too, so they can text it if email isn't set up.
      res.status(201).json({ invite, link, emailed });
    } catch (err) {
      if (err instanceof SeatsFullError) throw new HttpError(409, err.message);
      throw err;
    }
  });

  r.delete("/team/invites/:id", allow("OWNER", "ADMIN"), async (req, res) => {
    const businessId = tenant(res);
    const invite = await db.invite.findFirst({ where: { id: req.params.id, businessId, acceptedAt: null, revokedAt: null } });
    if (!invite) throw new HttpError(404, "Invite not found");
    if (invite.role === "OWNER" && session(res).role !== "OWNER") throw new HttpError(403, "Only an owner can cancel an owner invite");
    await db.invite.update({ where: { id: invite.id }, data: { revokedAt: deps.now() } });
    await audit(session(res), businessId, "invite_revoked", invite.email);
    res.json({ ok: true });
  });

  r.patch("/team/:userId", allow("OWNER", "ADMIN"), async (req, res) => {
    const businessId = tenant(res);
    const s = session(res);
    const body = z
      .object({ role: z.enum(TEAM_ROLES), active: z.boolean(), getsAlerts: z.boolean(), phone: phone.nullable() })
      .partial()
      .strict()
      .parse(req.body);
    const target = await db.user.findFirst({ where: { id: req.params.userId, businessId } });
    if (!target) throw new HttpError(404, "Team member not found");
    if (target.id === s.userId && (body.role !== undefined || body.active === false)) throw new HttpError(400, "You can't change your own role or remove yourself");
    if ((target.role === "OWNER" || body.role === "OWNER") && s.role !== "OWNER") throw new HttpError(403, "Only an owner can change an owner");

    const losingOwner = target.role === "OWNER" && target.active && ((body.role && body.role !== "OWNER") || body.active === false);
    if (losingOwner) {
      const owners = await db.user.count({ where: { businessId, role: "OWNER", active: true } });
      if (owners <= 1) throw new HttpError(400, "A business needs at least one owner — make someone else an owner first");
    }
    if (body.active === true && !target.active) {
      const b = await db.business.findUniqueOrThrow({ where: { id: businessId } });
      if ((await seatUsage(businessId, deps.now())).used >= PLANS[b.plan].seats) throw new HttpError(409, "No free seats on this plan");
    }
    const phoneValue = body.phone === undefined ? target.phone : body.phone;
    if (body.getsAlerts && !phoneValue) throw new HttpError(400, "Add a phone number to send alerts to");

    const user = await db.user.update({
      where: { id: target.id },
      data: { ...body, ...(body.phone === null ? { getsAlerts: false } : {}) },
      select: userFields,
    });
    await audit(s, businessId, "member_updated", target.email, body);
    res.json({ user });
  });

  // Your own profile: name, phone, alerts, password.
  r.patch("/me", async (req, res) => {
    const s = session(res);
    const body = z
      .object({ name: personName, phone: phone.nullable(), getsAlerts: z.boolean(), currentPassword: z.string(), newPassword: password })
      .partial()
      .strict()
      .parse(req.body);
    const me = await db.user.findUniqueOrThrow({ where: { id: s.userId } });
    const { currentPassword, newPassword, ...rest } = body;
    const data: Record<string, unknown> = { ...rest };
    if (newPassword) {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, me.passwordHash))) throw new HttpError(400, "Your current password is wrong");
      data.passwordHash = await bcrypt.hash(newPassword, 10);
    }
    const phoneValue = body.phone === undefined ? me.phone : body.phone;
    if ((body.getsAlerts ?? me.getsAlerts) && !phoneValue) data.getsAlerts = false;
    const user = await db.user.update({ where: { id: me.id }, data, select: userFields });
    if (newPassword) await audit(s, s.businessId, "password_changed", me.email);
    res.json({ user });
  });

  r.get("/activity", allow("OWNER", "ADMIN"), async (req, res) => {
    const before = z.coerce.date().optional().parse(req.query.before);
    const entries = await db.auditLog.findMany({
      where: { businessId: tenant(res), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, actorName: true, actorKind: true, action: true, target: true, details: true, createdAt: true },
    });
    res.json({ entries });
  });

  return r;
}
