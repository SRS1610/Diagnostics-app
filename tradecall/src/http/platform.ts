// /api/platform — for PLATFORM_ADMIN users only (the people running
// TradeCall, not any one business). Cross-tenant by design, so every
// action that changes a tenant, or opens one for support, is audit-logged
// against that tenant.

import { Router } from "express";
import { z } from "zod";
import { issueViewAsToken, session } from "../lib/auth";
import { db } from "../lib/db";
import { PLANS } from "../lib/plans";
import { audit } from "../core/audit";
import type { Deps } from "../core/deps";
import { monthStart } from "../core/team";
import { requirePlatformAdmin } from "./guards";
import { Prisma } from "@prisma/client";
import { HttpError, phone } from "./common";

const DAY = 86_400_000;

export function platformRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requirePlatformAdmin);

  async function tenantStats(ids: string[]) {
    const now = deps.now();
    const since30 = new Date(now.getTime() - 30 * DAY);
    const [users, texts, missed, leads, lastCall] = await Promise.all([
      db.user.groupBy({ by: ["businessId"], where: { businessId: { in: ids }, active: true }, _count: true }),
      db.message.groupBy({ by: ["businessId"], where: { businessId: { in: ids }, direction: "OUT", status: { not: "failed" }, createdAt: { gte: monthStart(now) } }, _count: true }),
      db.call.groupBy({ by: ["businessId"], where: { businessId: { in: ids }, outcome: "MISSED", startedAt: { gte: since30 } }, _count: true }),
      db.lead.groupBy({ by: ["businessId"], where: { businessId: { in: ids }, createdAt: { gte: since30 } }, _count: true }),
      db.call.groupBy({ by: ["businessId"], where: { businessId: { in: ids } }, _max: { startedAt: true } }),
    ]);
    const pick = <T extends { businessId: string | null }>(rows: T[], id: string) => rows.find((x) => x.businessId === id);
    return (id: string) => ({
      activeUsers: pick(users, id)?._count ?? 0,
      textsThisMonth: pick(texts, id)?._count ?? 0,
      missedCalls30d: pick(missed, id)?._count ?? 0,
      leads30d: pick(leads, id)?._count ?? 0,
      lastCallAt: pick(lastCall, id)?._max.startedAt ?? null,
    });
  }

  r.get("/overview", async (_req, res) => {
    const now = deps.now();
    const [byStatus, byPlan, texts, missed] = await Promise.all([
      db.business.groupBy({ by: ["status"], _count: true }),
      db.business.groupBy({ by: ["plan"], where: { status: "ACTIVE" }, _count: true }),
      db.message.count({ where: { direction: "OUT", status: { not: "failed" }, createdAt: { gte: monthStart(now) } } }),
      db.call.count({ where: { outcome: "MISSED", startedAt: { gte: new Date(now.getTime() - 30 * DAY) } } }),
    ]);
    res.json({
      tenants: Object.fromEntries(byStatus.map((x) => [x.status, x._count])),
      activeByPlan: Object.fromEntries(byPlan.map((x) => [x.plan, x._count])),
      textsThisMonth: texts,
      missedCalls30d: missed,
    });
  });

  r.get("/tenants", async (req, res) => {
    const q = z.object({ q: z.string().trim().max(80).optional(), status: z.enum(["ACTIVE", "SUSPENDED"]).optional() }).parse(req.query);
    const tenants = await db.business.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }, { phoneNumber: { contains: q.q.replace(/\D/g, "") || q.q } }] } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: { id: true, name: true, email: true, phoneNumber: true, plan: true, status: true, suspendedReason: true, messagingProfileId: true, createdAt: true },
    });
    const stats = await tenantStats(tenants.map((t) => t.id));
    res.json({
      tenants: tenants.map((t) => {
        const s = stats(t.id);
        return { ...t, ...s, includedTexts: PLANS[t.plan].includedTexts, seats: PLANS[t.plan].seats };
      }),
    });
  });

  async function findTenant(id: string) {
    const b = await db.business.findUnique({ where: { id } });
    if (!b) throw new HttpError(404, "Tenant not found");
    return b;
  }

  r.get("/tenants/:id", async (req, res) => {
    const b = await findTenant(req.params.id);
    const [users, activity, stats] = await Promise.all([
      db.user.findMany({ where: { businessId: b.id }, select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true }, orderBy: { createdAt: "asc" } }),
      db.auditLog.findMany({ where: { businessId: b.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      tenantStats([b.id]),
    ]);
    res.json({ tenant: { ...b, ...stats(b.id), includedTexts: PLANS[b.plan].includedTexts, seats: PLANS[b.plan].seats }, users, activity });
  });

  r.post("/tenants/:id/suspend", async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3, "Give a reason — it's shown to the business").max(300) }).parse(req.body);
    const b = await findTenant(req.params.id);
    if (b.status === "SUSPENDED") throw new HttpError(409, "Already suspended");
    await db.business.update({ where: { id: b.id }, data: { status: "SUSPENDED", suspendedReason: reason } });
    await audit(session(res), b.id, "tenant_suspended", b.name, { reason });
    res.json({ ok: true });
  });

  r.post("/tenants/:id/reactivate", async (req, res) => {
    const b = await findTenant(req.params.id);
    if (b.status === "ACTIVE") throw new HttpError(409, "Already active");
    await db.business.update({ where: { id: b.id }, data: { status: "ACTIVE", suspendedReason: null } });
    await audit(session(res), b.id, "tenant_reactivated", b.name);
    res.json({ ok: true });
  });

  r.patch("/tenants/:id", async (req, res) => {
    const body = z
      .object({
        plan: z.enum(["STARTER", "PRO", "TEAM"]),
        // Telnyx messaging profile for this tenant's registered 10DLC campaign.
        messagingProfileId: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, "Paste the messaging profile id from Telnyx").nullable(),
        // A number already in the platform's Telnyx account (e.g. ported in).
        phoneNumber: phone.nullable(),
      })
      .partial()
      .strict()
      .parse(req.body);
    const b = await findTenant(req.params.id);
    let updated;
    try {
      updated = await db.business.update({ where: { id: b.id }, data: body });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new HttpError(409, "That number belongs to another business");
      throw err;
    }
    await audit(session(res), b.id, "tenant_updated", b.name, { before: { plan: b.plan, messagingProfileId: b.messagingProfileId, phoneNumber: b.phoneNumber }, after: body });
    res.json({ tenant: updated });
  });

  // Support: a short-lived, read-only token scoped to this one tenant.
  // Explicit and logged — the business can see it in their activity log.
  r.post("/tenants/:id/view-as", async (req, res) => {
    const b = await findTenant(req.params.id);
    const s = session(res);
    await audit(s, b.id, "support_view_opened", b.name);
    res.json({ token: issueViewAsToken({ id: s.userId }, b.id), expiresInSeconds: 3600 });
  });

  r.get("/activity", async (req, res) => {
    const before = z.coerce.date().optional().parse(req.query.before);
    const entries = await db.auditLog.findMany({
      where: before ? { createdAt: { lt: before } } : {},
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { business: { select: { name: true } } },
    });
    res.json({ entries: entries.map(({ business, ...e }) => ({ ...e, businessName: business?.name ?? null })) });
  });

  return r;
}
