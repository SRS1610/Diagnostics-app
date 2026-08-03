// shippingLogistics.ts
//
// ============================================================================
// IMPORTANT — NEEDS A REAL SHIPPING PROVIDER
// ============================================================================
// Generating an actual, valid prepaid shipping label requires a real
// carrier/shipping API — EasyPost or Shippo are the common choice for
// this exact use case (they aggregate USPS/UPS/FedEx behind one API,
// rather than integrating each carrier separately). Tracking webhooks
// come from that same provider. What's here is the data model and where
// this plugs into the consumer tracker's "Received" stage — not a
// working label generator.
// ============================================================================

export type ShipmentStatus = "label_created" | "in_transit" | "out_for_delivery" | "delivered" | "exception";

export interface InboundShipment {
  shipmentId: string;
  orderId: string; // ties to the consumer tracker order (e.g. "TR-88214")
  carrier: string;
  trackingNumber: string;
  labelUrl: string;
  status: ShipmentStatus;
  createdAt: string;
  estimatedDelivery?: string;
  deliveredAt?: string;
}

/**
 * Call when a consumer accepts a mail-in trade-in flow (before the
 * device physically arrives) — creates the expectation so intake staff
 * know a device is coming, and the consumer tracker can show "Label
 * sent, waiting for drop-off" as a pre-"Received" state ahead of the
 * 5-stage progress bar already in consumer_tracker.html.
 */
export async function createInboundLabel(orderId: string): Promise<InboundShipment> {
  const response = await fetch(`${process.env.SHIPPING_PROVIDER_API_BASE}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  return response.json() as Promise<InboundShipment>;
}

/**
 * Webhook handler shape — your shipping provider calls this (or
 * similar) when tracking status changes. Wire this to trigger
 * notifications.ts's "device_received" template when status becomes
 * "delivered".
 */
export function handleTrackingWebhook(payload: { trackingNumber: string; status: ShipmentStatus; timestamp: string }): void {
  // Update the InboundShipment record matching trackingNumber, then:
  // if payload.status === "delivered", trigger the device_received notification.
}
