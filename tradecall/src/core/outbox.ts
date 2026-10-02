// The one path every text to a customer goes through. Opt-outs are
// enforced HERE, so no feature can accidentally text someone who said STOP.

import type { Business, Lead, Message, MessageKind } from "@prisma/client";
import { config } from "../lib/config";
import { db } from "../lib/db";
import { prettyPhone } from "../lib/phone";
import { fill } from "../lib/text";
import type { Deps } from "./deps";
import { alertPhones } from "./team";

export class OptedOutError extends Error {
  constructor() {
    super("This customer replied STOP, so they can't be texted.");
  }
}
export class SuspendedError extends Error {
  constructor() {
    super("This account is suspended, so texts can't be sent.");
  }
}
export class NoNumberError extends Error {
  constructor() {
    super("No business number is connected yet — set one up in Settings.");
  }
}

export async function optedOut(businessId: string, phone: string): Promise<boolean> {
  return (await db.optOut.findUnique({ where: { businessId_phone: { businessId, phone } } })) !== null;
}

export function vars(b: Business, extra: Record<string, string> = {}): Record<string, string> {
  return { business: b.name, owner: b.ownerName, number: b.phoneNumber ? prettyPhone(b.phoneNumber) : "", ...extra };
}

export function leadUrl(lead: Lead): string {
  return `${config.publicUrl}/#/leads/${lead.id}`;
}

/**
 * Saves the message (queued) before sending so the conversation shows what
 * was attempted even if the provider call fails; failures are recorded on
 * the row and re-thrown.
 */
export async function textLead(
  deps: Deps,
  b: Business,
  lead: Lead,
  body: string,
  kind: MessageKind,
  opts: { template?: boolean; extra?: Record<string, string>; sentBy?: string } = { template: true },
): Promise<Message> {
  if (b.status === "SUSPENDED") throw new SuspendedError();
  if (!b.phoneNumber) throw new NoNumberError();
  if (await optedOut(b.id, lead.phone)) throw new OptedOutError();
  const text = opts.template === false ? body : fill(body, vars(b, opts.extra));
  const now = deps.now();
  const msg = await db.message.create({
    data: { businessId: b.id, leadId: lead.id, direction: "OUT", kind, body: text, status: "queued", sentBy: opts.sentBy ?? null, createdAt: now },
  });
  await db.lead.update({ where: { id: lead.id }, data: { lastOutboundAt: now } });
  try {
    const sent = await deps.provider.sendSms({ from: b.phoneNumber, to: lead.phone, text, messagingProfileId: b.messagingProfileId });
    return await db.message.update({ where: { id: msg.id }, data: { providerId: sent.providerId, status: sent.status === "queued" ? "queued" : "sent" } });
  } catch (err) {
    await db.message.update({ where: { id: msg.id }, data: { status: "failed", error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
}

/**
 * Alert the team: every active member with alerts on (or the ring phone if
 * nobody has). Best-effort — an alert failing must never break the
 * customer-facing flow. Passing `about` makes that lead the target of a
 * bare SMS reply from any team member.
 */
export async function textTeam(deps: Deps, b: Business, text: string, about?: Lead): Promise<void> {
  if (!b.phoneNumber || b.status === "SUSPENDED") return;
  if (about) await db.business.update({ where: { id: b.id }, data: { lastAlertLeadId: about.id } });
  await sendToPhones(deps, b, await alertPhones(b), text);
}

/** A reply to one team member (e.g. the answer to their LEADS command). */
export async function textMember(deps: Deps, b: Business, phone: string, text: string): Promise<void> {
  if (!b.phoneNumber || b.status === "SUSPENDED") return;
  await sendToPhones(deps, b, [phone], text);
}

async function sendToPhones(deps: Deps, b: Business, phones: string[], text: string) {
  for (const to of phones) {
    try {
      await deps.provider.sendSms({ from: b.phoneNumber!, to, text, messagingProfileId: b.messagingProfileId });
    } catch (err) {
      console.error(`[team-alert] business=${b.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
