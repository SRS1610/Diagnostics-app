import type { Lead } from "@prisma/client";
import { db } from "../lib/db";

/** The caller's current open lead. WON/LOST leads are closed history. */
export function findOpenLead(businessId: string, phone: string): Promise<Lead | null> {
  return db.lead.findFirst({
    where: { businessId, phone, stage: { notIn: ["WON", "LOST"] } },
    orderBy: { createdAt: "desc" },
  });
}

/** New leads get the next short per-business number (#1, #2, …) for SMS replies. */
export async function openLeadFor(businessId: string, phone: string, now: Date): Promise<{ lead: Lead; isNew: boolean }> {
  const existing = await findOpenLead(businessId, phone);
  if (existing) return { lead: existing, isNew: false };
  const { leadSeq } = await db.business.update({ where: { id: businessId }, data: { leadSeq: { increment: 1 } }, select: { leadSeq: true } });
  const lead = await db.lead.create({ data: { businessId, phone, code: leadSeq, createdAt: now } });
  return { lead, isNew: true };
}
