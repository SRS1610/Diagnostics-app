// Dashboard numbers. Ranges are rolling (last N days vs the N days before)
// rather than calendar weeks, which avoids timezone-midnight math on the
// server; daily buckets are still keyed by the business's local date.

import type { Business, LeadStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { localParts } from "../lib/time";

export interface PeriodStats {
  start: string;
  end: string;
  totalCalls: number;
  answeredCalls: number;
  missedCalls: number;
  missedCallers: number;
  afterHoursMissed: number;
  textBacksSent: number;
  /** Missed-call leads who texted back at least once after their call. */
  repliedLeads: number;
  replyRate: number | null;
  newLeads: number;
  funnel: Record<LeadStatus, number>;
  urgentLeads: number;
  wonJobs: number;
  revenueWonCents: number;
  /** missedCallers × average job value — what was at risk of going to a competitor. */
  revenueAtRiskCents: number;
  /** repliedLeads × average job value — conversations this system kept alive. */
  pipelineRecoveredCents: number;
  daily: { date: string; missed: number; replied: number }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export async function periodStats(business: Business, start: Date, end: Date): Promise<PeriodStats> {
  const range = { gte: start, lt: end };
  const [calls, textBacks, newLeads, won] = await Promise.all([
    prisma.call.findMany({
      where: { businessId: business.id, createdAt: range },
      select: { outcome: true, fromNumber: true, afterHours: true, leadId: true, createdAt: true },
    }),
    prisma.message.count({
      where: { businessId: business.id, kind: "TEXT_BACK", createdAt: range, status: { not: "failed" } },
    }),
    prisma.lead.findMany({ where: { businessId: business.id, createdAt: range }, select: { status: true, urgent: true } }),
    prisma.lead.findMany({ where: { businessId: business.id, status: "WON", wonAt: range }, select: { jobValueCents: true } }),
  ]);

  const missed = calls.filter((c) => c.outcome === "MISSED");
  const missedCallers = new Set(missed.map((c) => c.fromNumber)).size;

  // Earliest missed call per lead in the window, then: did that lead
  // send any inbound text after it (up to now, not just within the window —
  // a Sunday-night caller who replies Monday still counts for Sunday)?
  const firstMissByLead = new Map<string, Date>();
  for (const c of missed) {
    if (!c.leadId) continue;
    const prev = firstMissByLead.get(c.leadId);
    if (!prev || c.createdAt < prev) firstMissByLead.set(c.leadId, c.createdAt);
  }
  const inbound = firstMissByLead.size
    ? await prisma.message.findMany({
        where: { leadId: { in: [...firstMissByLead.keys()] }, direction: "INBOUND" },
        select: { leadId: true, createdAt: true },
      })
    : [];
  const repliedAt = new Map<string, Date>();
  for (const m of inbound) {
    const missAt = firstMissByLead.get(m.leadId)!;
    if (m.createdAt >= missAt && !repliedAt.has(m.leadId)) repliedAt.set(m.leadId, missAt);
  }

  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS));
  const daily = new Map<string, { missed: number; replied: number }>();
  // The chart shows the last N local calendar days ending today. The
  // rolling window can start partway through an extra day; events on that
  // partial day count in the headline totals but have no bar of their own.
  for (let i = days - 1; i >= 0; i--) {
    daily.set(dateKey(new Date(end.getTime() - 1 - i * DAY_MS), business.timezone), { missed: 0, replied: 0 });
  }
  for (const c of missed) {
    const bucket = daily.get(dateKey(c.createdAt, business.timezone));
    if (bucket) bucket.missed++;
  }
  for (const missAt of repliedAt.values()) {
    const bucket = daily.get(dateKey(missAt, business.timezone));
    if (bucket) bucket.replied++;
  }

  const funnel: Record<LeadStatus, number> = { NEW: 0, CONTACTED: 0, QUALIFIED: 0, BOOKED: 0, WON: 0, LOST: 0 };
  for (const l of newLeads) funnel[l.status]++;

  const textedLeads = firstMissByLead.size;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    totalCalls: calls.length,
    answeredCalls: calls.filter((c) => c.outcome === "ANSWERED").length,
    missedCalls: missed.length,
    missedCallers,
    afterHoursMissed: missed.filter((c) => c.afterHours).length,
    textBacksSent: textBacks,
    repliedLeads: repliedAt.size,
    replyRate: textedLeads ? repliedAt.size / textedLeads : null,
    newLeads: newLeads.length,
    funnel,
    urgentLeads: newLeads.filter((l) => l.urgent).length,
    wonJobs: won.length,
    revenueWonCents: won.reduce((sum, l) => sum + (l.jobValueCents ?? 0), 0),
    revenueAtRiskCents: missedCallers * business.avgJobValueCents,
    pipelineRecoveredCents: repliedAt.size * business.avgJobValueCents,
    daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })),
  };
}

export async function dashboardStats(business: Business, now: Date, days: number) {
  // Ranges are half-open [start, end); include events stamped exactly "now".
  const end = new Date(now.getTime() + 1);
  const start = new Date(end.getTime() - days * DAY_MS);
  const prevStart = new Date(start.getTime() - days * DAY_MS);
  const [current, previous] = await Promise.all([
    periodStats(business, start, end),
    periodStats(business, prevStart, start),
  ]);
  return { days, current, previous };
}
