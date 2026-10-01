// Inbound texts: opt-out keywords, the three-question intake, and alerting
// the owner. Replies to the customer go out through the REST API (via
// sendToLead), not TwiML, so every message lands in the same log.

import type { Business, Lead } from "@prisma/client";
import { config } from "../lib/config";
import type { Deps } from "../lib/deps";
import { formatPhone } from "../lib/phone";
import { prisma } from "../lib/prisma";
import {
  QUALIFY_ASK_ADDRESS,
  QUALIFY_ASK_URGENT,
  QUALIFY_DONE,
  QUALIFY_DONE_URGENT,
} from "../lib/templates";
import { alertOwner, isOptedOut, sendToLead } from "./messaging";
import { findOrCreateOpenLead } from "./leads";
import { cancelJobs } from "./scheduler";

// Carrier/CTIA standard keywords. Twilio's default opt-out handling sends
// the confirmation reply itself, so we only record state here.
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES", "OPTIN"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

const URGENT_PATTERN = /\b(emergenc\w*|urgent|asap|flood\w*|burst|gas leak|smell gas|no heat|no ac|no a\/c|no power|sparking|smoke)\b/i;

export function looksUrgent(text: string): boolean {
  return URGENT_PATTERN.test(text);
}

function leadLink(lead: Lead): string {
  return `${config.publicBaseUrl}/#/leads/${lead.id}`;
}

function leadSummary(business: Business, lead: Lead): string {
  const lines = [
    `${lead.urgent ? "🚨 URGENT lead" : "New lead"} for ${business.name}: ${formatPhone(lead.phone)}`,
    lead.jobDescription ? `Need: ${lead.jobDescription}` : null,
    lead.address ? `Where: ${lead.address}` : null,
    leadLink(lead),
  ];
  return lines.filter(Boolean).join("\n");
}

export async function handleInboundSms(
  deps: Deps,
  business: Business,
  sms: { from: string; body: string; sid: string },
): Promise<{ leadId: string | null; action: string }> {
  const now = deps.now();
  const body = sms.body.trim();
  const keyword = body.toUpperCase().replace(/[^A-Z]/g, "");

  // Twilio retries webhooks it thinks failed; don't record the same text twice.
  const dup = await prisma.message.findUnique({ where: { twilioSid: sms.sid } });
  if (dup) return { leadId: dup.leadId, action: "duplicate" };

  const optedOut = await isOptedOut(business.id, sms.from);
  const { lead, created } = await findOrCreateOpenLead(business.id, sms.from, now);

  await prisma.message.create({
    data: {
      businessId: business.id,
      leadId: lead.id,
      direction: "INBOUND",
      kind: "INBOUND",
      body,
      twilioSid: sms.sid,
      status: "received",
      createdAt: now,
    },
  });

  if (STOP_WORDS.has(keyword)) {
    await prisma.optOut.upsert({
      where: { businessId_phone: { businessId: business.id, phone: sms.from } },
      create: { businessId: business.id, phone: sms.from, createdAt: now },
      update: {},
    });
    const leads = await prisma.lead.findMany({ where: { businessId: business.id, phone: sms.from }, select: { id: true } });
    for (const l of leads) await cancelJobs(l.id, ["FOLLOW_UP", "APPOINTMENT_REMINDER"]);
    await prisma.lead.update({ where: { id: lead.id }, data: { lastInboundAt: now, qualifyStep: 0 } });
    return { leadId: lead.id, action: "opted_out" };
  }

  if (optedOut && START_WORDS.has(keyword)) {
    await prisma.optOut.delete({ where: { businessId_phone: { businessId: business.id, phone: sms.from } } });
    await prisma.lead.update({ where: { id: lead.id }, data: { lastInboundAt: now } });
    await alertOwner(deps, business, `${formatPhone(sms.from)} opted back in to texts.\n${leadLink(lead)}`);
    return { leadId: lead.id, action: "opted_in" };
  }

  if (HELP_WORDS.has(keyword)) {
    await prisma.lead.update({ where: { id: lead.id }, data: { lastInboundAt: now } });
    return { leadId: lead.id, action: "help" };
  }

  // Any real reply ends the follow-up nudge.
  await cancelJobs(lead.id, ["FOLLOW_UP"]);

  // Someone texting the business number directly (no missed call first)
  // is a lead too — run them through the same intake.
  let step = lead.qualifyStep;
  if (created && business.qualifyEnabled && !optedOut) step = 1;

  const status = lead.status === "NEW" ? "CONTACTED" : lead.status;
  let updated = await prisma.lead.update({
    where: { id: lead.id },
    data: { lastInboundAt: now, status, qualifyStep: step },
  });

  if (optedOut || step === 0) {
    await alertOwner(deps, business, `Text from ${formatPhone(sms.from)}: "${body}"\n${leadLink(updated)}`);
    return { leadId: lead.id, action: "forwarded" };
  }

  if (step === 1) {
    updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { jobDescription: body, urgent: looksUrgent(body), qualifyStep: 2 },
    });
    await sendToLead(deps, business, updated, QUALIFY_ASK_ADDRESS, "QUALIFY");
    return { leadId: lead.id, action: "asked_address" };
  }

  if (step === 2) {
    updated = await prisma.lead.update({ where: { id: lead.id }, data: { address: body, qualifyStep: 3 } });
    await sendToLead(deps, business, updated, QUALIFY_ASK_URGENT, "QUALIFY");
    return { leadId: lead.id, action: "asked_urgent" };
  }

  // step 3: emergency yes/no — anything that isn't a clear yes is a no,
  // but an urgent-sounding job description stays urgent.
  const saidYes = /^\s*(y|yes|yeah|yep|yup)\b/i.test(body) || looksUrgent(body);
  updated = await prisma.lead.update({
    where: { id: lead.id },
    data: {
      urgent: updated.urgent || saidYes,
      qualifyStep: 0,
      status: updated.status === "CONTACTED" ? "QUALIFIED" : updated.status,
    },
  });
  await sendToLead(deps, business, updated, updated.urgent ? QUALIFY_DONE_URGENT : QUALIFY_DONE, "QUALIFY");
  await alertOwner(deps, business, leadSummary(business, updated));
  return { leadId: lead.id, action: "qualified" };
}
