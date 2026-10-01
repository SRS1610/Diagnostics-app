// The single send path for every text to a customer. Opt-out is checked
// HERE, not at each call site, so no code path can text someone who
// replied STOP.

import type { Business, Lead, Message, MessageKind } from "@prisma/client";
import type { Deps } from "../lib/deps";
import { formatPhone } from "../lib/phone";
import { prisma } from "../lib/prisma";
import { render } from "../lib/templates";

export class OptedOutError extends Error {
  constructor() {
    super("This contact replied STOP and can't be texted.");
  }
}

export class NoNumberError extends Error {
  constructor() {
    super("This business has no Twilio number yet. Set one up in Settings.");
  }
}

export async function isOptedOut(businessId: string, phone: string): Promise<boolean> {
  const row = await prisma.optOut.findUnique({ where: { businessId_phone: { businessId, phone } } });
  return row !== null;
}

export function templateVars(business: Business): Record<string, string> {
  return {
    business: business.name,
    owner: business.ownerName,
    number: business.twilioNumber ? formatPhone(business.twilioNumber) : "",
  };
}

/**
 * Persists the message first (status "queued"), then sends. A Twilio
 * failure is recorded on the row (status "failed") and re-thrown, so the
 * conversation view always shows what was attempted.
 */
export async function sendToLead(
  deps: Deps,
  business: Business,
  lead: Lead,
  template: string,
  kind: MessageKind,
  extraVars: Record<string, string> = {},
  opts: { verbatim?: boolean } = {},
): Promise<Message> {
  if (!business.twilioNumber) throw new NoNumberError();
  if (await isOptedOut(business.id, lead.phone)) throw new OptedOutError();

  // Owner-typed replies are sent exactly as written, never templated.
  const body = opts.verbatim ? template : render(template, { ...templateVars(business), ...extraVars });
  const now = deps.now();
  const message = await prisma.message.create({
    data: {
      businessId: business.id,
      leadId: lead.id,
      direction: "OUTBOUND",
      kind,
      body,
      status: "queued",
      createdAt: now,
    },
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { lastOutboundAt: now } });

  try {
    const sent = await deps.telephony.sendSms({ from: business.twilioNumber, to: lead.phone, body });
    return prisma.message.update({ where: { id: message.id }, data: { twilioSid: sent.sid, status: sent.status } });
  } catch (err) {
    await prisma.message.update({
      where: { id: message.id },
      data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

/** Alerts to the owner's own cell. Best-effort: never blocks the customer flow. */
export async function alertOwner(deps: Deps, business: Business, body: string): Promise<void> {
  if (!business.twilioNumber) return;
  try {
    await deps.telephony.sendSms({ from: business.twilioNumber, to: business.ownerPhone, body });
  } catch (err) {
    console.error(`[alertOwner] business=${business.id} failed:`, err instanceof Error ? err.message : err);
  }
}
