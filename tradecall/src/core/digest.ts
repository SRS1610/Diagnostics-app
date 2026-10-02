// Monday 8am (owner's timezone): the "here's what this saved you" summary.

import type { Business } from "@prisma/client";
import { config } from "../lib/config";
import { db } from "../lib/db";
import { local } from "../lib/time";
import type { Deps } from "./deps";
import { textTeam } from "./outbox";
import { compare, type Period } from "./stats";

export const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export function digestLines(b: Business, p: Period): string[] {
  const rate = p.replyRate === null ? "–" : `${Math.round(p.replyRate * 100)}%`;
  return [
    `Missed calls: ${p.missed}${p.missReasons.CALLER_HUNG_UP ? ` (${p.missReasons.CALLER_HUNG_UP} hung up while ringing)` : ""}`,
    `Texted back: ${p.textBacks} · Replied: ${p.replied} (${rate})`,
    `New leads: ${p.newLeads} · Booked: ${p.stages.SCHEDULED} · Won: ${p.won}`,
    ...(p.wonCents ? [`Revenue won: ${dollars(p.wonCents)}`] : []),
    `Est. jobs saved: ${dollars(p.savedCents)}`,
  ];
}

export function digestDue(b: Business, now: Date): boolean {
  if (!b.digestEnabled) return false;
  const l = local(now, b.timezone);
  if (l.day !== "mon" || l.hour < 8) return false;
  return !b.digestSentAt || now.getTime() - b.digestSentAt.getTime() > 6 * 86_400_000;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendDigests(deps: Deps): Promise<number> {
  const now = deps.now();
  let sent = 0;
  for (const b of await db.business.findMany({ where: { digestEnabled: true, status: "ACTIVE" } })) {
    if (!digestDue(b, now)) continue;
    // Claim first so a crash mid-send can't double-send next tick.
    const claimed = await db.business.updateMany({ where: { id: b.id, digestSentAt: b.digestSentAt }, data: { digestSentAt: now } });
    if (!claimed.count) continue;
    const { current } = await compare(b, now, 7);
    const lines = digestLines(b, current);
    await textTeam(deps, b, [`${b.name} — your last 7 days`, ...lines, `${config.publicUrl}/#/dashboard`].join("\n"));
    const owners = await db.user.findMany({ where: { businessId: b.id, role: "OWNER", active: true }, select: { email: true } });
    for (const { email } of deps.mailer ? owners : []) {
      try {
        await deps.mailer!.send({
          to: email,
          subject: `Your week: ${current.missed} missed calls, ${current.replied} customers saved`,
          text: lines.join("\n"),
          html: `<h2 style="font-family:sans-serif">${esc(b.name)} — your week</h2><ul style="font-family:sans-serif;font-size:15px">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p><a href="${config.publicUrl}/#/dashboard">Open your dashboard</a></p>`,
        });
      } catch (err) {
        console.error(`[digest] email failed business=${b.id}:`, err instanceof Error ? err.message : err);
      }
    }
    sent++;
  }
  return sent;
}
