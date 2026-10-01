// What happens the moment a call is missed: find or open a lead, text the
// caller back, start the intake questions, and queue a follow-up nudge.

import type { Business, Call } from "@prisma/client";
import type { Deps } from "../lib/deps";
import { prisma } from "../lib/prisma";
import { isWithinBusinessHours, type BusinessHours } from "../lib/time";
import { isOptedOut, sendToLead } from "./messaging";
import { findOrCreateOpenLead } from "./leads";
import { scheduleFollowUp } from "./scheduler";

export type TextBackResult =
  | { textedBack: true; leadId: string }
  | { textedBack: false; leadId: string | null; reason: "owner" | "opted_out" | "duplicate" | "no_number" | "send_failed" };

export async function handleMissedCall(deps: Deps, business: Business, call: Call): Promise<TextBackResult> {
  // Twilio retries webhooks; a call is only ever handled once.
  if (call.outcome !== "RINGING") return { textedBack: false, leadId: call.leadId, reason: "duplicate" };

  const now = deps.now();
  const afterHours = !isWithinBusinessHours(now, business.timezone, business.businessHours as BusinessHours);

  // The owner testing their own line isn't a lead.
  if (call.fromNumber === business.ownerPhone) {
    await prisma.call.update({ where: { id: call.id }, data: { outcome: "MISSED", afterHours } });
    return { textedBack: false, leadId: null, reason: "owner" };
  }

  const { lead } = await findOrCreateOpenLead(business.id, call.fromNumber, now);
  await prisma.call.update({ where: { id: call.id }, data: { outcome: "MISSED", afterHours, leadId: lead.id } });

  if (!business.twilioNumber) return { textedBack: false, leadId: lead.id, reason: "no_number" };
  if (await isOptedOut(business.id, lead.phone)) return { textedBack: false, leadId: lead.id, reason: "opted_out" };

  // Someone redialing three times in five minutes gets one text, not three.
  const windowStart = new Date(now.getTime() - business.dedupeWindowMin * 60 * 1000);
  const recent = await prisma.message.findFirst({
    where: { leadId: lead.id, direction: "OUTBOUND", createdAt: { gte: windowStart }, status: { not: "failed" } },
  });
  if (recent) return { textedBack: false, leadId: lead.id, reason: "duplicate" };

  // Only start the intake questions for a fresh lead. A caller already
  // mid-conversation or booked just gets the "sorry we missed you" text.
  const startIntake = business.qualifyEnabled && lead.status === "NEW" && !lead.jobDescription;
  if (startIntake && lead.qualifyStep !== 1) {
    await prisma.lead.update({ where: { id: lead.id }, data: { qualifyStep: 1 } });
  }

  try {
    await sendToLead(
      deps,
      business,
      lead,
      afterHours ? business.afterHoursMessage : business.textBackMessage,
      "TEXT_BACK",
    );
  } catch (err) {
    console.error(`[missedCall] text-back failed business=${business.id} lead=${lead.id}:`, err instanceof Error ? err.message : err);
    return { textedBack: false, leadId: lead.id, reason: "send_failed" };
  }

  if (lead.status === "NEW") await scheduleFollowUp(deps, business, lead);
  return { textedBack: true, leadId: lead.id };
}
