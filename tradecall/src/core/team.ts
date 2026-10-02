// Who on a business's team gets alerts, and which phones may text the
// business number as "the business" (relaying to customers) rather than
// being treated as a customer.

import type { Business } from "@prisma/client";
import { db } from "../lib/db";
import { PLANS } from "../lib/plans";

/** Phones that receive lead alerts. Falls back to the ring phone so alerts are never dropped. */
export async function alertPhones(b: Business): Promise<string[]> {
  const users = await db.user.findMany({ where: { businessId: b.id, active: true, getsAlerts: true, phone: { not: null } }, select: { phone: true } });
  const phones = [...new Set(users.map((u) => u.phone!))];
  return phones.length ? phones : [b.ownerPhone];
}

/** The team member texting from this phone, if any (the ring phone counts as the owner's). */
export async function teamMemberByPhone(b: Business, phone: string): Promise<{ name: string; id: string | null } | null> {
  const user = await db.user.findFirst({ where: { businessId: b.id, active: true, phone }, select: { id: true, name: true } });
  if (user) return user;
  return phone === b.ownerPhone ? { id: null, name: b.ownerName } : null;
}

export async function seatUsage(businessId: string, now: Date) {
  const [users, invites] = await Promise.all([
    db.user.count({ where: { businessId, active: true } }),
    db.invite.count({ where: { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
  ]);
  return { users, invites, used: users + invites };
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Customer texts sent this calendar month (UTC) vs what the plan includes. */
export async function textUsage(b: Business, now: Date) {
  const sent = await db.message.count({
    where: { businessId: b.id, direction: "OUT", status: { not: "failed" }, createdAt: { gte: monthStart(now) } },
  });
  const included = PLANS[b.plan].includedTexts;
  return { sent, included, overage: Math.max(0, sent - included) };
}
