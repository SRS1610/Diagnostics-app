// Inbound texts to a business number. Two very different senders:
//   • a TEAM MEMBER — replying to an alert, which relays to the customer
//   • a CUSTOMER — opt-out keywords, the intake questions, team alerts

import type { Business, Lead } from "@prisma/client";
import { db } from "../lib/db";
import { prettyPhone, toE164 } from "../lib/phone";
import { ASK_ADDRESS, ASK_EMERGENCY, INTAKE_DONE, INTAKE_DONE_URGENT } from "../lib/text";
import type { ProviderEvent } from "../providers/types";
import type { Deps } from "./deps";
import { cancelJobs } from "./jobs";
import { openLeadFor } from "./leads";
import { NoNumberError, OptedOutError, leadUrl, optedOut, textLead, textMember, textTeam } from "./outbox";
import { teamMemberByPhone } from "./team";

// CTIA keywords. Carriers/the provider send the STOP confirmation
// themselves, so we only record state and never reply to these.
const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START = new Set(["START", "UNSTOP", "YES", "OPTIN"]);
const HELP = new Set(["HELP", "INFO"]);

const URGENT = /\b(emergenc\w*|urgent|asap|flood\w*|burst|gas leak|smell gas|no heat|no ac|no a\/c|no power|sparks?|sparking|smoke|sewage)\b/i;
export const soundsUrgent = (t: string) => URGENT.test(t);

type Sms = Extract<ProviderEvent, { type: "sms.received" }>;

export async function handleInboundSms(deps: Deps, ev: Sms): Promise<string> {
  const to = toE164(ev.to);
  const from = toE164(ev.from);
  const b = to ? await db.business.findUnique({ where: { phoneNumber: to } }) : null;
  if (!b || !from) return "ignored";
  const member = await teamMemberByPhone(b, from);
  if (b.status === "SUSPENDED") {
    // Service is off, but an opt-out must still be honoured whenever the
    // business comes back.
    if (!member && STOP.has(ev.text.trim().toUpperCase().replace(/[^A-Z]/g, ""))) {
      await db.optOut.upsert({ where: { businessId_phone: { businessId: b.id, phone: from } }, create: { businessId: b.id, phone: from }, update: {} });
      return "opted_out";
    }
    return "suspended";
  }
  if (member) return teamRelay(deps, b, from, member.name, ev.text.trim());
  return customerText(deps, b, from, ev);
}

// ---------------- team member → customer relay ----------------

const RELAY_HELP = "TradeCall: reply to an alert to text that customer, or send #<lead number> <message> (e.g. #12 On my way). Send LEADS to list open leads.";

async function teamRelay(deps: Deps, b: Business, from: string, sender: string, text: string): Promise<string> {
  // Replies to commands go to whoever texted, not the whole team.
  const reply = (t: string) => textMember(deps, b, from, t);
  if (/^leads$/i.test(text)) {
    const open = await db.lead.findMany({
      where: { businessId: b.id, stage: { in: ["NEW", "ENGAGED", "QUALIFIED", "SCHEDULED"] } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    });
    const lines = open.map((l) => `#${l.code} ${prettyPhone(l.phone)}${l.urgent ? " 🚨" : ""}${l.job ? ` – ${l.job.slice(0, 40)}` : ""}`);
    await reply(lines.length ? `Open leads:\n${lines.join("\n")}` : "No open leads right now.");
    return "owner_list";
  }

  let lead: Lead | null = null;
  let body = text;
  const tagged = /^#(\d+)\s*([\s\S]*)$/.exec(text);
  if (tagged) {
    lead = await db.lead.findUnique({ where: { businessId_code: { businessId: b.id, code: Number(tagged[1]) } } });
    body = tagged[2].trim();
    if (!lead) {
      await reply(`TradeCall: there's no lead #${tagged[1]}.`);
      return "owner_unknown_lead";
    }
  } else if (b.lastAlertLeadId) {
    lead = await db.lead.findFirst({ where: { id: b.lastAlertLeadId, businessId: b.id } });
  }
  if (!lead || !body) {
    await reply(RELAY_HELP);
    return "owner_help";
  }

  try {
    await textLead(deps, b, lead, body, "OWNER", { template: false, sentBy: sender });
  } catch (err) {
    const why = err instanceof OptedOutError || err instanceof NoNumberError ? err.message : "the text didn't go through. Try again from the dashboard.";
    await reply(`TradeCall: couldn't text #${lead.code} — ${why}`);
    return "owner_failed";
  }
  // A human has taken over: stop the bot.
  await cancelJobs(lead.id, ["NUDGE"]);
  await db.lead.update({ where: { id: lead.id }, data: { intakeStep: 0, ...(lead.stage === "NEW" ? { stage: "ENGAGED" as const } : {}) } });
  return "owner_relayed";
}

// ---------------- customer texts ----------------

function summary(b: Business, lead: Lead): string {
  return [
    `${lead.urgent ? "🚨 URGENT lead" : "New lead"} #${lead.code} – ${prettyPhone(lead.phone)}`,
    lead.job && `Need: ${lead.job}`,
    lead.address && `Where: ${lead.address}`,
    `Reply to this text to answer them. ${leadUrl(lead)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function customerText(deps: Deps, b: Business, from: string, ev: Sms): Promise<string> {
  const now = deps.now();
  const text = ev.text.trim();
  const word = text.toUpperCase().replace(/[^A-Z]/g, "");

  const wasOptedOut = await optedOut(b.id, from);
  const { lead, isNew } = await openLeadFor(b.id, from, now);

  try {
    await db.message.create({
      data: { businessId: b.id, leadId: lead.id, direction: "IN", kind: "CUSTOMER", body: text, providerId: ev.providerId, status: "received", createdAt: now },
    });
  } catch {
    return "duplicate"; // same provider message id delivered twice
  }
  await db.lead.update({ where: { id: lead.id }, data: { lastInboundAt: now } });

  if (STOP.has(word)) {
    await db.optOut.upsert({ where: { businessId_phone: { businessId: b.id, phone: from } }, create: { businessId: b.id, phone: from, createdAt: now }, update: {} });
    const all = await db.lead.findMany({ where: { businessId: b.id, phone: from }, select: { id: true } });
    for (const l of all) await cancelJobs(l.id, ["NUDGE", "REMINDER"]);
    await db.lead.update({ where: { id: lead.id }, data: { intakeStep: 0 } });
    return "opted_out";
  }
  if (wasOptedOut && START.has(word)) {
    await db.optOut.delete({ where: { businessId_phone: { businessId: b.id, phone: from } } });
    await textTeam(deps, b, `#${lead.code} ${prettyPhone(from)} opted back in to texts.`, lead);
    return "opted_in";
  }
  if (HELP.has(word)) return "help";

  await cancelJobs(lead.id, ["NUDGE"]);

  // Someone texting the number cold (no call first) runs the same intake.
  let step = lead.intakeStep;
  if (isNew && b.intakeEnabled && !wasOptedOut) step = 1;
  let current = await db.lead.update({
    where: { id: lead.id },
    data: { intakeStep: step, ...(lead.stage === "NEW" ? { stage: "ENGAGED" as const } : {}) },
  });

  if (wasOptedOut || step === 0) {
    await textTeam(deps, b, `#${current.code} ${prettyPhone(from)}: "${text}"\nReply to this text to answer them.`, current);
    return "forwarded";
  }

  if (step === 1) {
    current = await db.lead.update({ where: { id: lead.id }, data: { job: text, urgent: soundsUrgent(text), intakeStep: 2 } });
    await textLead(deps, b, current, ASK_ADDRESS, "INTAKE");
    return "asked_address";
  }
  if (step === 2) {
    current = await db.lead.update({ where: { id: lead.id }, data: { address: text, intakeStep: 3 } });
    await textLead(deps, b, current, ASK_EMERGENCY, "INTAKE");
    return "asked_emergency";
  }

  // Step 3 — anything but a clear yes is a no, unless the job already sounded urgent.
  const yes = /^\s*(y|yes|yeah|yep|yup)\b/i.test(text) || soundsUrgent(text);
  current = await db.lead.update({
    where: { id: lead.id },
    data: { urgent: current.urgent || yes, intakeStep: 0, ...(current.stage === "ENGAGED" ? { stage: "QUALIFIED" as const } : {}) },
  });
  await textLead(deps, b, current, current.urgent ? INTAKE_DONE_URGENT : INTAKE_DONE, "INTAKE");
  await textTeam(deps, b, summary(b, current), current);
  return "qualified";
}
