// Dashboard numbers. Windows are rolling (last N days vs the N before);
// the daily series is bucketed by the business's local calendar date.

import type { Business, LeadStage, MissReason } from "@prisma/client";
import { db } from "../lib/db";
import { local } from "../lib/time";

const DAY = 86_400_000;

export interface Period {
  calls: number;
  answered: number;
  missed: number;
  missedCallers: number;
  afterHours: number;
  missReasons: Record<MissReason, number>;
  textBacks: number;
  replied: number;
  replyRate: number | null;
  voicemails: number;
  newLeads: number;
  stages: Record<LeadStage, number>;
  urgent: number;
  won: number;
  wonCents: number;
  atRiskCents: number;
  savedCents: number;
  daily: { date: string; missed: number; replied: number }[];
}

export async function period(b: Business, start: Date, end: Date): Promise<Period> {
  const range = { gte: start, lt: end };
  const [calls, textBacks, leads, won, voicemails] = await Promise.all([
    db.call.findMany({ where: { businessId: b.id, startedAt: range, state: { not: "SELF_TEST" } }, select: { outcome: true, missReason: true, afterHours: true, fromNumber: true, leadId: true, startedAt: true } }),
    db.message.count({ where: { businessId: b.id, kind: "AUTO_REPLY", createdAt: range, status: { not: "failed" } } }),
    db.lead.findMany({ where: { businessId: b.id, createdAt: range }, select: { stage: true, urgent: true } }),
    db.lead.findMany({ where: { businessId: b.id, stage: "WON", wonAt: range }, select: { valueCents: true } }),
    db.voicemail.count({ where: { businessId: b.id, createdAt: range } }),
  ]);

  const missed = calls.filter((c) => c.outcome === "MISSED");
  const firstMiss = new Map<string, Date>();
  for (const c of missed) {
    if (c.leadId && (!firstMiss.has(c.leadId) || c.startedAt < firstMiss.get(c.leadId)!)) firstMiss.set(c.leadId, c.startedAt);
  }
  // A reply any time after the miss counts — a Sunday caller who answers
  // Monday morning was still saved by Sunday's text.
  const replies = firstMiss.size
    ? await db.message.findMany({ where: { leadId: { in: [...firstMiss.keys()] }, direction: "IN" }, select: { leadId: true, createdAt: true } })
    : [];
  const repliedMissAt = new Map<string, Date>();
  for (const m of replies) if (m.createdAt >= firstMiss.get(m.leadId)!) repliedMissAt.set(m.leadId, firstMiss.get(m.leadId)!);

  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY));
  const daily = new Map<string, { missed: number; replied: number }>();
  for (let i = days - 1; i >= 0; i--) daily.set(local(new Date(end.getTime() - 1 - i * DAY), b.timezone).ymd, { missed: 0, replied: 0 });
  for (const c of missed) {
    const d = daily.get(local(c.startedAt, b.timezone).ymd);
    if (d) d.missed++;
  }
  for (const at of repliedMissAt.values()) {
    const d = daily.get(local(at, b.timezone).ymd);
    if (d) d.replied++;
  }

  const missReasons: Record<MissReason, number> = { NO_ANSWER: 0, NOT_ACCEPTED: 0, CALLER_HUNG_UP: 0, FORWARDED: 0 };
  for (const c of missed) if (c.missReason) missReasons[c.missReason]++;
  const stages: Record<LeadStage, number> = { NEW: 0, ENGAGED: 0, QUALIFIED: 0, SCHEDULED: 0, WON: 0, LOST: 0 };
  for (const l of leads) stages[l.stage]++;
  const missedCallers = new Set(missed.map((c) => c.fromNumber)).size;

  return {
    calls: calls.length,
    answered: calls.filter((c) => c.outcome === "ANSWERED").length,
    missed: missed.length,
    missedCallers,
    afterHours: missed.filter((c) => c.afterHours).length,
    missReasons,
    textBacks,
    replied: repliedMissAt.size,
    replyRate: firstMiss.size ? repliedMissAt.size / firstMiss.size : null,
    voicemails,
    newLeads: leads.length,
    stages,
    urgent: leads.filter((l) => l.urgent).length,
    won: won.length,
    wonCents: won.reduce((s, l) => s + (l.valueCents ?? 0), 0),
    atRiskCents: missedCallers * b.avgJobCents,
    savedCents: repliedMissAt.size * b.avgJobCents,
    daily: [...daily].map(([date, v]) => ({ date, ...v })),
  };
}

export async function compare(b: Business, now: Date, days: number) {
  const end = new Date(now.getTime() + 1); // include events stamped exactly "now"
  const start = new Date(end.getTime() - days * DAY);
  const [current, previous] = await Promise.all([period(b, start, end), period(b, new Date(start.getTime() - days * DAY), start)]);
  return { days, current, previous };
}
