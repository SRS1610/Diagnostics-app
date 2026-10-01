import type { Lead } from "@prisma/client";
import { prisma } from "../lib/prisma";

const CLOSED: Lead["status"][] = ["WON", "LOST"];

/** The caller's current open lead, if any — WON/LOST leads are history. */
export async function findOpenLead(businessId: string, phone: string): Promise<Lead | null> {
  return prisma.lead.findFirst({
    where: { businessId, phone, status: { notIn: CLOSED } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findOrCreateOpenLead(
  businessId: string,
  phone: string,
  now: Date,
): Promise<{ lead: Lead; created: boolean }> {
  const existing = await findOpenLead(businessId, phone);
  if (existing) return { lead: existing, created: false };
  const lead = await prisma.lead.create({ data: { businessId, phone, createdAt: now } });
  return { lead, created: true };
}
