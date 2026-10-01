// Monday-morning summary to the owner: SMS always, email when SendGrid is
// configured. This is the "is this worth paying for" moment every week.

import type { Business } from "@prisma/client";
import { config } from "../lib/config";
import type { Deps } from "../lib/deps";
import { prisma } from "../lib/prisma";
import { localParts } from "../lib/time";
import { alertOwner } from "./messaging";
import { dashboardStats, type PeriodStats } from "./stats";

const DIGEST_HOUR = 8;
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function digestText(business: Business, s: PeriodStats): string {
  const rate = s.replyRate === null ? "–" : `${Math.round(s.replyRate * 100)}%`;
  return [
    `${business.name} — last 7 days`,
    `Missed calls: ${s.missedCalls} (${s.afterHoursMissed} after hours)`,
    `Texted back: ${s.textBacksSent} · Replied: ${s.repliedLeads} (${rate})`,
    `New leads: ${s.newLeads} · Booked: ${s.funnel.BOOKED} · Won: ${s.wonJobs}`,
    s.revenueWonCents ? `Revenue won: ${dollars(s.revenueWonCents)}` : null,
    `Est. pipeline saved: ${dollars(s.pipelineRecoveredCents)}`,
    `${config.publicBaseUrl}/#/dashboard`,
  ]
    .filter(Boolean)
    .join("\n");
}

function digestHtml(business: Business, s: PeriodStats): string {
  const rows = digestText(business, s)
    .split("\n")
    .slice(1, -1)
    .map((line) => `<tr><td style="padding:4px 0">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td></tr>`)
    .join("");
  return `<h2 style="font-family:sans-serif">${business.name.replace(/</g, "&lt;")} — your week</h2>
<table style="font-family:sans-serif;font-size:15px">${rows}</table>
<p style="font-family:sans-serif"><a href="${config.publicBaseUrl}/#/dashboard">Open dashboard</a></p>`;
}

export function digestIsDue(business: Business, now: Date): boolean {
  if (!business.weeklyDigestEnabled) return false;
  const p = localParts(now, business.timezone);
  if (p.weekday !== "mon" || p.hour < DIGEST_HOUR) return false;
  return !business.lastDigestSentAt || now.getTime() - business.lastDigestSentAt.getTime() > SIX_DAYS_MS;
}

export async function runWeeklyDigests(deps: Deps): Promise<number> {
  const now = deps.now();
  const businesses = await prisma.business.findMany({ where: { weeklyDigestEnabled: true } });
  let sent = 0;
  for (const business of businesses) {
    if (!digestIsDue(business, now)) continue;
    // Mark first so a crash mid-send can't produce a second digest next tick.
    await prisma.business.update({ where: { id: business.id }, data: { lastDigestSentAt: now } });
    const { current } = await dashboardStats(business, now, 7);
    await alertOwner(deps, business, digestText(business, current));
    if (deps.mailer) {
      try {
        await deps.mailer.send({
          to: business.ownerEmail,
          subject: `Your week: ${current.missedCalls} missed calls, ${current.repliedLeads} leads saved`,
          text: digestText(business, current),
          html: digestHtml(business, current),
        });
      } catch (err) {
        console.error(`[digest] email failed business=${business.id}:`, err instanceof Error ? err.message : err);
      }
    }
    sent++;
  }
  return sent;
}
