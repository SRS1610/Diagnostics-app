// The moment a call is known to be missed — whatever the reason — find or
// open the lead, text the caller back, start intake, and queue a nudge.

import type { Business, Call, MissReason } from "@prisma/client";
import { db } from "../lib/db";
import { isOpen, type Hours } from "../lib/time";
import type { Deps } from "./deps";
import { scheduleNudge } from "./jobs";
import { openLeadFor } from "./leads";
import { optedOut, textLead } from "./outbox";

export type TextBack = { sent: true; leadId: string } | { sent: false; leadId: string | null; why: "opted_out" | "duplicate" | "no_number" | "failed" | "anonymous" };

export async function onMissedCall(deps: Deps, b: Business, call: Call, reason: MissReason): Promise<TextBack> {
  const now = deps.now();
  const afterHours = !isOpen(call.startedAt, b.timezone, b.hours as Hours);
  await db.call.update({ where: { id: call.id }, data: { outcome: "MISSED", missReason: reason, afterHours } });

  // Blocked/anonymous caller ID — nothing to text.
  if (!/^\+\d{8,15}$/.test(call.fromNumber)) return { sent: false, leadId: null, why: "anonymous" };

  const { lead } = await openLeadFor(b.id, call.fromNumber, now);
  await db.call.update({ where: { id: call.id }, data: { leadId: lead.id } });

  if (!b.phoneNumber) return { sent: false, leadId: lead.id, why: "no_number" };
  if (await optedOut(b.id, lead.phone)) return { sent: false, leadId: lead.id, why: "opted_out" };

  // Someone redialing three times in five minutes gets one text.
  const recent = await db.message.findFirst({
    where: { leadId: lead.id, direction: "OUT", status: { not: "failed" }, createdAt: { gte: new Date(now.getTime() - b.dedupeMin * 60_000) } },
  });
  if (recent) return { sent: false, leadId: lead.id, why: "duplicate" };

  // Only a brand-new lead starts the intake questions; someone mid-
  // conversation or already booked just gets the "sorry we missed you".
  if (b.intakeEnabled && lead.stage === "NEW" && !lead.job && lead.intakeStep !== 1) {
    await db.lead.update({ where: { id: lead.id }, data: { intakeStep: 1 } });
  }

  try {
    await textLead(deps, b, lead, afterHours ? b.afterHoursText : b.missedText, "AUTO_REPLY");
  } catch (err) {
    console.error(`[missed] text-back failed business=${b.id} lead=${lead.id}:`, err instanceof Error ? err.message : err);
    return { sent: false, leadId: lead.id, why: "failed" };
  }
  if (lead.stage === "NEW") await scheduleNudge(deps, b, lead);
  return { sent: true, leadId: lead.id };
}
