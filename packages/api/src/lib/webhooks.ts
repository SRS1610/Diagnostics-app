// src/lib/webhooks.ts
//
// Outbound event delivery to a tenant's registered endpoints, plus the
// HMAC signing that lets a receiver trust a payload actually came from
// here.
//
// FIRE-AND-FORGET, NOT A QUEUE. dispatchWebhook is called from inside a
// request handler and does not block the response on delivery — a
// customer's slow or dead server must never make report creation
// itself slow or fail. This means delivery has no retry beyond what's
// coded here, which is deliberately none: a real queue with backoff is
// infrastructure this project doesn't have yet (no background worker,
// no Redis), and pretending otherwise with an in-process setTimeout
// retry would silently drop deliveries on every deploy or restart
// without ever admitting it. Every attempt — success or failure — is
// recorded in WebhookDelivery, so "is this actually working" is
// answerable from the portal rather than only from the receiving end.
//
// EVERY EVENT TYPE MUST BE NAMED HERE. WEBHOOK_EVENT_TYPES is the single
// list an endpoint's eventTypes can draw from, checked at creation and
// at dispatch — an endpoint cannot subscribe to a typo'd event name and
// then wonder why nothing arrives.

import { createHmac, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const WEBHOOK_EVENT_TYPES = [
  "report.created",
  "dispute.received",
  "dispute.resolved",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Sends one event to every active endpoint subscribed to it, for one
 * tenant. Never throws — a webhook failure is a fact recorded in
 * WebhookDelivery, not an error that should propagate back into
 * whatever business action triggered the event (creating a report must
 * still succeed even if every webhook receiver is down).
 */
export async function dispatchWebhook(
  tenantId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { tenantId, active: true, eventTypes: { has: eventType } },
  });
  if (endpoints.length === 0) return;

  const payload = {
    eventType,
    tenantId,
    occurredAt: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);

  await Promise.all(
    endpoints.map(async (endpoint) => {
      const signature = signPayload(endpoint.secret, body);
      let statusCode: number | undefined;
      let succeeded = false;
      let error: string | undefined;

      try {
        // A hard timeout, not an unbounded fetch — a slow receiver must
        // not hold this open indefinitely just because it wasn't a hard
        // failure.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": `sha256=${signature}`,
            "X-Webhook-Event": eventType,
          },
          body,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        statusCode = response.status;
        succeeded = response.ok;
        if (!succeeded) error = `Receiver returned HTTP ${response.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : "Delivery failed";
      }

      await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.endpointId,
          eventType,
          payload: payload as unknown as Prisma.InputJsonValue,
          statusCode,
          succeeded,
          error,
        },
      });
    }),
  );
}
