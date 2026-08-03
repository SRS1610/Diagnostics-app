// notifications.ts
//
// ============================================================================
// IMPORTANT — NEEDS A REAL PROVIDER, THIS IS NOT FUNCTIONAL ON ITS OWN
// ============================================================================
// Sending an actual SMS/email/push requires a real provider: Twilio (SMS),
// SendGrid or Postmark (email), Firebase Cloud Messaging or OneSignal
// (push). This module defines WHEN to notify and WHAT to say; a provider
// integration is what actually delivers it. The Settings page already
// shows these as "not yet configured" toggles for exactly this reason.
// ============================================================================

export type NotificationTrigger =
  | "device_received"
  | "inspection_complete"
  | "offer_ready"
  | "offer_accepted"
  | "payout_processing"
  | "payout_complete"
  | "dispute_received"
  | "dispute_resolved";

export interface NotificationTemplate {
  trigger: NotificationTrigger;
  smsBody: string; // keep short — SMS has practical length limits
  emailSubject: string;
  emailBody: string;
}

// Ties directly to the consumer tracker's 5-stage progress bar — every
// stage transition should have a corresponding notification, or the
// tracker being "pull only" (per the gap this was built to close)
// doesn't actually get closed.
export const NOTIFICATION_TEMPLATES: Record<NotificationTrigger, NotificationTemplate> = {
  device_received: {
    trigger: "device_received",
    smsBody: "We've received your {deviceName}. Track your trade-in: {trackingUrl}",
    emailSubject: "We received your device",
    emailBody: "Your {deviceName} (order #{orderId}) has arrived and inspection will begin shortly.",
  },
  inspection_complete: {
    trigger: "inspection_complete",
    smsBody: "Inspection complete for your {deviceName}. View your offer: {trackingUrl}",
    emailSubject: "Your inspection is complete",
    emailBody: "We've finished inspecting your {deviceName}. Your offer is ready to review.",
  },
  offer_ready: {
    trigger: "offer_ready",
    smsBody: "Your offer for {deviceName} is ${offerAmount}. Accept here: {trackingUrl}",
    emailSubject: "Your trade-in offer is ready",
    emailBody: "We've made an offer of ${offerAmount} for your {deviceName}, based on the inspection results.",
  },
  offer_accepted: {
    trigger: "offer_accepted",
    smsBody: "Offer accepted! Choose your payout method: {trackingUrl}",
    emailSubject: "Offer accepted — choose your payout",
    emailBody: "Thanks for accepting your ${offerAmount} offer. Select how you'd like to be paid.",
  },
  payout_processing: {
    trigger: "payout_processing",
    smsBody: "Your ${offerAmount} payout via {payoutMethod} is processing.",
    emailSubject: "Your payout is processing",
    emailBody: "Your payout of ${offerAmount} via {payoutMethod} is being processed.",
  },
  payout_complete: {
    trigger: "payout_complete",
    smsBody: "Your ${offerAmount} payout is complete. Thanks for trading in with us!",
    emailSubject: "Payout complete",
    emailBody: "Your payout of ${offerAmount} has been sent via {payoutMethod}.",
  },
  dispute_received: {
    trigger: "dispute_received",
    smsBody: "We received your review request for {deviceName}. We'll respond within 1-2 business days.",
    emailSubject: "Your review request was received",
    emailBody: "We've received your request to review the inspection of your {deviceName}.",
  },
  dispute_resolved: {
    trigger: "dispute_resolved",
    smsBody: "Your review is resolved. See the update: {trackingUrl}",
    emailSubject: "Your review has been resolved",
    emailBody: "We've completed reviewing your request. See the details and any updated offer.",
  },
};

/**
 * Fills a template's placeholders. Actually sending it is left to your
 * provider integration — this function just prepares the content.
 */
export function renderNotification(
  trigger: NotificationTrigger,
  values: Record<string, string>
): { sms: string; emailSubject: string; emailBody: string } {
  const template = NOTIFICATION_TEMPLATES[trigger];
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
  return {
    sms: fill(template.smsBody),
    emailSubject: fill(template.emailSubject),
    emailBody: fill(template.emailBody),
  };
}
