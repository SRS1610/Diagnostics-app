// Nudges and appointment reminders, stored in Postgres so restarts and
// deploys never drop one. Each job is claimed with a conditional
// PENDING→RUNNING update, so two workers can't both send it.

import type { Business, JobType, Lead } from "@prisma/client";
import { db } from "../lib/db";
import { friendly, isQuiet, outOfQuiet } from "../lib/time";
import { NUDGE, REMINDER } from "../lib/text";
import type { Deps } from "./deps";
import { OptedOutError, textLead } from "./outbox";

const MAX_ATTEMPTS = 3;
const RETRY_MS = 5 * 60_000;
const STUCK_MS = 10 * 60_000;
const HOUR = 3_600_000;
export const REMINDER_LEADS_MS = [24 * HOUR, 2 * HOUR];

export async function cancelJobs(leadId: string, types: JobType[]) {
  await db.job.updateMany({ where: { leadId, type: { in: types }, status: "PENDING" }, data: { status: "CANCELED" } });
}

export async function scheduleNudge(deps: Deps, b: Business, lead: Lead) {
  await cancelJobs(lead.id, ["NUDGE"]);
  if (!b.nudgeEnabled) return;
  const due = new Date(deps.now().getTime() + b.nudgeAfterMin * 60_000);
  await db.job.create({ data: { businessId: b.id, leadId: lead.id, type: "NUDGE", runAt: outOfQuiet(due, b.timezone, "later") } });
}

export async function scheduleReminders(deps: Deps, b: Business, lead: Lead, at: Date) {
  await cancelJobs(lead.id, ["REMINDER"]);
  const now = deps.now().getTime();
  // A reminder that would land in quiet hours moves EARLIER — arriving
  // after the appointment would be useless. Two can collapse into one slot.
  const times = new Set(
    REMINDER_LEADS_MS.map((ms) => outOfQuiet(new Date(at.getTime() - ms), b.timezone, "earlier").getTime()).filter((t) => t > now),
  );
  for (const t of times) {
    await db.job.create({ data: { businessId: b.id, leadId: lead.id, type: "REMINDER", runAt: new Date(t) } });
  }
}

async function run(deps: Deps, jobId: string): Promise<"sent" | "skipped" | "deferred"> {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, include: { business: true, lead: true } });
  const { business: b, lead } = job;

  if (job.type === "NUDGE") {
    if (lead.stage !== "NEW" || lead.lastInboundAt) return "skipped";
    if (isQuiet(deps.now(), b.timezone)) {
      await db.job.update({ where: { id: job.id }, data: { status: "PENDING", runAt: outOfQuiet(deps.now(), b.timezone, "later") } });
      return "deferred";
    }
    await textLead(deps, b, lead, NUDGE, "NUDGE");
    return "sent";
  }

  if (lead.stage !== "SCHEDULED" || !lead.appointmentAt || lead.appointmentAt <= deps.now()) return "skipped";
  await textLead(deps, b, lead, REMINDER, "REMINDER", { extra: { when: friendly(lead.appointmentAt, b.timezone) } });
  return "sent";
}

export async function runDueJobs(deps: Deps) {
  const now = deps.now();
  await db.job.updateMany({ where: { status: "RUNNING", runAt: { lt: new Date(now.getTime() - STUCK_MS) } }, data: { status: "PENDING" } });
  const due = await db.job.findMany({ where: { status: "PENDING", runAt: { lte: now } }, orderBy: { runAt: "asc" }, take: 100 });
  const tally = { sent: 0, skipped: 0, failed: 0 };

  for (const job of due) {
    const claimed = await db.job.updateMany({ where: { id: job.id, status: "PENDING" }, data: { status: "RUNNING", attempts: { increment: 1 } } });
    if (!claimed.count) continue;
    try {
      const outcome = await run(deps, job.id);
      if (outcome !== "deferred") await db.job.update({ where: { id: job.id }, data: { status: "DONE" } });
      outcome === "sent" ? tally.sent++ : tally.skipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const optOut = err instanceof OptedOutError;
      const giveUp = optOut || job.attempts + 1 >= MAX_ATTEMPTS;
      await db.job.update({
        where: { id: job.id },
        data: giveUp
          ? { status: optOut ? "CANCELED" : "FAILED", lastError: msg }
          : { status: "PENDING", lastError: msg, runAt: new Date(now.getTime() + RETRY_MS) },
      });
      if (giveUp && !optOut) console.error(`[jobs] ${job.type} ${job.id} failed for good: ${msg}`);
      tally.failed++;
    }
  }
  return tally;
}
