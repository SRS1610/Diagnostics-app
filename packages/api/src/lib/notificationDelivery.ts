// src/lib/notificationDelivery.ts
//
// The provider integration notifications.ts's own header says it needs:
// real SMS via Twilio, real email via SendGrid. That module still only
// defines WHEN to notify and WHAT to say (renderNotification) — this is
// what actually sends it.
//
// FIRE-AND-FORGET, same shape as lib/webhooks.ts's dispatchWebhook and
// for the same reason: a customer's stage-transition update must never
// be able to fail or slow down the business action that triggered it
// (accepting an offer, resolving a dispute). Every attempt — success or
// failure, per channel — is logged to ActivityLogEntry via
// notification_sent/notification_failed, so "did this actually go out"
// is answerable without a provider-side dashboard.
//
// Both channels are optional and independent. A report with only an
// email on file gets only an email; one with neither gets nothing, and
// dispatchNotification() no-ops immediately rather than logging a
// failure for a channel that was never going to be used.

import twilio from "twilio";
import sgMail from "@sendgrid/mail";
import { renderNotification, type NotificationTrigger } from "@diagnostics/shared";
import { buildActivityLogData } from "./activityLog";
import { prisma } from "./prisma";

const CONSUMER_BASE_URL = process.env.CONSUMER_BASE_URL ?? "http://localhost:5174";

// Emit each "not configured" warning exactly once per process instead of
// on every dispatch — a busy tenant would otherwise flood the server log
// with the same reminder, and the first line is the only one that
// carries information anyway.
const warned = { twilio: false, sendgrid: false };

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    if (!warned.twilio) {
      console.warn(
        "[notifications] Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER missing). SMS notifications will be skipped and recorded as notification_skipped in the activity log.",
      );
      warned.twilio = true;
    }
    return null;
  }
  return { client: twilio(sid, token), from };
}

function getSendGridFrom(): string | null {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !from) {
    if (!warned.sendgrid) {
      console.warn(
        "[notifications] SendGrid not configured (SENDGRID_API_KEY/SENDGRID_FROM_EMAIL missing). Email notifications will be skipped and recorded as notification_skipped in the activity log.",
      );
      warned.sendgrid = true;
    }
    return null;
  }
  sgMail.setApiKey(apiKey);
  return from;
}

interface NotifiableReport {
  reportId: string;
  tenantId: string;
  deviceMake: string;
  deviceModel: string;
  consumerEmail: string | null;
  consumerPhone: string | null;
  consumerToken: string;
}

async function logAttempt(
  report: NotifiableReport,
  trigger: NotificationTrigger,
  channel: "sms" | "email",
  outcome: "sent" | "failed" | "skipped",
  detail: string,
) {
  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: report.tenantId,
      actorUserId: "system",
      actorRole: "tenant_admin",
      action:
        outcome === "sent"
          ? "notification_sent"
          : outcome === "failed"
            ? "notification_failed"
            : "notification_skipped",
      targetType: "report",
      targetId: report.reportId,
      details: `${trigger} via ${channel}: ${detail}`,
    }),
  });
}

/**
 * Renders and sends the notification for one stage transition, to
 * whichever channel(s) the report has contact info for and this
 * deployment has a configured provider for. Never throws — see the file
 * header. `extraValues` fills template placeholders beyond the ones this
 * function derives itself (deviceName, trackingUrl); see
 * notifications.ts's templates for what each trigger expects
 * (offerAmount, payoutMethod, orderId).
 */
export async function dispatchNotification(
  reportId: string,
  trigger: NotificationTrigger,
  extraValues: Record<string, string> = {},
): Promise<void> {
  try {
    const report = await prisma.report.findUnique({
      where: { reportId },
      select: {
        reportId: true,
        tenantId: true,
        deviceMake: true,
        deviceModel: true,
        consumerEmail: true,
        consumerPhone: true,
        consumerToken: true,
      },
    });
    if (!report) return;
    if (!report.consumerEmail && !report.consumerPhone) return; // nothing to notify

    const rendered = renderNotification(trigger, {
      deviceName: `${report.deviceMake} ${report.deviceModel}`,
      trackingUrl: `${CONSUMER_BASE_URL}/track/${report.consumerToken}`,
      orderId: report.reportId,
      ...extraValues,
    });

    if (report.consumerPhone) {
      const twilioConfig = getTwilioClient();
      if (twilioConfig) {
        try {
          await twilioConfig.client.messages.create({
            to: report.consumerPhone,
            from: twilioConfig.from,
            body: rendered.sms,
          });
          await logAttempt(report, trigger, "sms", "sent", `sent to ${maskContact(report.consumerPhone)}`);
        } catch (e) {
          await logAttempt(report, trigger, "sms", "failed", e instanceof Error ? e.message : "unknown error");
        }
      } else {
        // Contact info existed but no provider is configured — a real
        // gap (we had someone to notify and didn't) belongs in the log
        // where an admin can see it, not swallowed silently.
        await logAttempt(report, trigger, "sms", "skipped", "Twilio not configured");
      }
    }

    if (report.consumerEmail) {
      const from = getSendGridFrom();
      if (from) {
        try {
          await sgMail.send({ to: report.consumerEmail, from, subject: rendered.emailSubject, text: rendered.emailBody });
          await logAttempt(report, trigger, "email", "sent", `sent to ${maskContact(report.consumerEmail)}`);
        } catch (e) {
          await logAttempt(report, trigger, "email", "failed", e instanceof Error ? e.message : "unknown error");
        }
      } else {
        await logAttempt(report, trigger, "email", "skipped", "SendGrid not configured");
      }
    }
  } catch (e) {
    // A failure BEFORE we even know who to notify (e.g. the DB lookup
    // itself) — nothing to attribute a log entry to, so this is the one
    // case that only reaches the server log, same as dispatchWebhook's
    // outermost boundary.
    console.error(`dispatchNotification failed for report ${reportId} (${trigger}):`, e);
  }
}

/** Never log a full email/phone number — activity log entries are
 *  visible to every admin at the tenant, and a customer's contact info
 *  is not something every admin needs to see just to confirm a send. */
function maskContact(value: string): string {
  if (value.includes("@")) {
    const [local, domain] = value.split("@");
    return `${local.slice(0, 2)}••••@${domain}`;
  }
  return `••••${value.slice(-4)}`;
}
