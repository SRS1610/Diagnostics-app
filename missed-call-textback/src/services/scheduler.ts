// Follow-ups and appointment reminders. Jobs live in Postgres, not memory,
// so a restart or deploy never drops a reminder. A job is claimed with a
// conditional PENDING→RUNNING update, so running two server instances
// can't send the same reminder twice.

import type { Business, JobType, Lead } from "@prisma/client";
import type { Deps } from "../lib/deps";
import { prisma } from "../lib/prisma";
import { APPOINTMENT_REMINDER, FOLLOW_UP } from "../lib/templates";
import { formatLocal, isQuietHours, shiftOutOfQuietHours } from "../lib/time";
import { OptedOutError, sendToLead } from "./messaging";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const STALE_RUNNING_MS = 10 * 60 * 1000;
export const REMINDER_OFFSETS_MS = [24 * 60 * 60 * 1000, 2 * 60 * 60 * 1000];

export async function cancelJobs(leadId: string, types: JobType[]): Promise<void> {
  await prisma.scheduledJob.updateMany({
    where: { leadId, type: { in: types }, status: "PENDING" },
    data: { status: "CANCELED" },
  });
}

export async function scheduleFollowUp(deps: Deps, business: Business, lead: Lead): Promise<void> {
  await cancelJobs(lead.id, ["FOLLOW_UP"]);
  if (!business.followUpEnabled) return;
  const due = new Date(deps.now().getTime() + business.followUpDelayMin * 60 * 1000);
  await prisma.scheduledJob.create({
    data: {
      businessId: business.id,
      leadId: lead.id,
      type: "FOLLOW_UP",
      runAt: shiftOutOfQuietHours(due, business.timezone, "later"),
    },
  });
}

export async function scheduleAppointmentReminders(
  deps: Deps,
  business: Business,
  lead: Lead,
  appointmentAt: Date,
): Promise<void> {
  await cancelJobs(lead.id, ["APPOINTMENT_REMINDER"]);
  const now = deps.now().getTime();
  const runAts = new Set<number>();
  for (const offset of REMINDER_OFFSETS_MS) {
    const t = shiftOutOfQuietHours(new Date(appointmentAt.getTime() - offset), business.timezone, "earlier");
    // Two offsets can collapse onto the same evening slot (e.g. a 7am
    // appointment); one reminder is enough.
    if (t.getTime() > now) runAts.add(t.getTime());
  }
  for (const t of runAts) {
    await prisma.scheduledJob.create({
      data: { businessId: business.id, leadId: lead.id, type: "APPOINTMENT_REMINDER", runAt: new Date(t) },
    });
  }
}

type Outcome = "sent" | "skipped" | "deferred";

async function executeJob(deps: Deps, jobId: string): Promise<Outcome> {
  const job = await prisma.scheduledJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { business: true, lead: true },
  });
  const { business, lead } = job;
  if (!lead) return "skipped";

  if (job.type === "FOLLOW_UP") {
    // Only nudge people who haven't replied and whom nobody has handled.
    if (lead.status !== "NEW" || lead.lastInboundAt) return "skipped";
    if (isQuietHours(deps.now(), business.timezone)) {
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { status: "PENDING", runAt: shiftOutOfQuietHours(deps.now(), business.timezone, "later") },
      });
      return "deferred";
    }
    await sendToLead(deps, business, lead, FOLLOW_UP, "FOLLOW_UP");
    return "sent";
  }

  // APPOINTMENT_REMINDER
  if (lead.status !== "BOOKED" || !lead.appointmentAt || lead.appointmentAt <= deps.now()) return "skipped";
  await sendToLead(deps, business, lead, APPOINTMENT_REMINDER, "REMINDER", {
    when: formatLocal(lead.appointmentAt, business.timezone),
  });
  return "sent";
}

export async function runDueJobs(deps: Deps): Promise<{ sent: number; skipped: number; failed: number }> {
  const now = deps.now();
  // Recover jobs whose worker died mid-run.
  await prisma.scheduledJob.updateMany({
    where: { status: "RUNNING", runAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
    data: { status: "PENDING" },
  });

  const due = await prisma.scheduledJob.findMany({
    where: { status: "PENDING", runAt: { lte: now } },
    orderBy: { runAt: "asc" },
    take: 100,
  });
  const tally = { sent: 0, skipped: 0, failed: 0 };

  for (const job of due) {
    const claimed = await prisma.scheduledJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "RUNNING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // another worker got it

    try {
      const outcome = await executeJob(deps, job.id);
      if (outcome !== "deferred") {
        await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: "DONE" } });
      }
      if (outcome === "sent") tally.sent++;
      else tally.skipped++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      const permanent = err instanceof OptedOutError || attempts >= MAX_ATTEMPTS;
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: permanent
          ? { status: err instanceof OptedOutError ? "CANCELED" : "FAILED", lastError: message }
          : { status: "PENDING", lastError: message, runAt: new Date(now.getTime() + RETRY_DELAY_MS) },
      });
      if (permanent && !(err instanceof OptedOutError)) {
        console.error(`[scheduler] job ${job.id} failed permanently after ${attempts} attempts: ${message}`);
      }
      tally.failed++;
    }
  }
  return tally;
}
