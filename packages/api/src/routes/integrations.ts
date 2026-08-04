// src/routes/integrations.ts
//
// Tenant-scoped management of the two things a B2B integration needs:
// API keys (for a partner's SERVER to call in) and webhook endpoints
// (for this platform to call OUT to a partner's server). Both are
// admin-only — tenant_staff gets the same read-only treatment as
// billing and disputes.

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { hashApiKey } from "../middleware/apiKeyAuth";
import { buildActivityLogData } from "../lib/activityLog";
import { generateWebhookSecret, WEBHOOK_EVENT_TYPES } from "../lib/webhooks";
import { prisma } from "../lib/prisma";

const router = Router();

const requireAdmin = (req: Parameters<typeof requireAuth>[0]) => req.portalSession!.role !== "tenant_staff";

// ============================================================
// API keys
// ============================================================

router.get("/api-keys", requireAuth, requireTenantScope, async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    // keyHash is never returned — the point of hashing it is defeated
    // if a compromised portal session can read it back out.
    select: {
      keyId: true,
      name: true,
      keyPrefix: true,
      createdByUserId: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
  });
  res.json(keys);
});

router.post("/api-keys", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage API keys" });

  const { name } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  const secret = randomBytes(24).toString("base64url");
  const fullKey = `dgk_live_${secret}`;

  const key = await prisma.apiKey.create({
    data: {
      ...tenantWhere(req),
      name: name.trim(),
      keyHash: hashApiKey(fullKey),
      keyPrefix: fullKey.slice(0, 16),
      createdByUserId: req.portalSession!.userId,
    },
    select: { keyId: true, name: true, keyPrefix: true, createdAt: true },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "api_key_created",
      targetType: "api_key",
      targetId: key.keyId,
      details: `Created API key "${key.name}"`,
    }),
  });

  res.status(201).json({
    ...key,
    apiKey: fullKey,
    note: "This key is shown once and cannot be retrieved again. It grants read-only access to this tenant's data.",
  });
});

router.delete("/api-keys/:keyId", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage API keys" });

  const existing = await prisma.apiKey.findFirst({
    where: { ...tenantWhere(req), keyId: req.params.keyId },
  });
  if (!existing) return res.status(404).json({ error: "API key not found" });

  // Revoked, not deleted — a key that was used still shows up in
  // lastUsedAt history and in whatever logs referenced it; hard-deleting
  // the row would make "was this key ever used, and by what"
  // unanswerable later.
  await prisma.apiKey.updateMany({
    where: { ...tenantWhere(req), keyId: req.params.keyId },
    data: { revokedAt: new Date() },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "api_key_revoked",
      targetType: "api_key",
      targetId: existing.keyId,
      details: `Revoked API key "${existing.name}"`,
    }),
  });

  res.status(204).send();
});

// ============================================================
// Webhooks
// ============================================================

router.get("/webhooks/event-types", requireAuth, requireTenantScope, (_req, res) => {
  res.json(WEBHOOK_EVENT_TYPES);
});

router.get("/webhooks", requireAuth, requireTenantScope, async (req, res) => {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: tenantWhere(req),
    orderBy: { createdAt: "desc" },
    select: { endpointId: true, url: true, eventTypes: true, active: true, createdAt: true },
  });
  res.json(endpoints);
});

router.post("/webhooks", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage webhooks" });

  const { url, eventTypes } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "url must be a valid http(s) URL" });
  }
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    return res.status(400).json({ error: "eventTypes must be a non-empty array" });
  }
  const invalid = eventTypes.filter((e) => !WEBHOOK_EVENT_TYPES.includes(e));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unknown event type(s): ${invalid.join(", ")}` });
  }

  const secret = generateWebhookSecret();
  const endpoint = await prisma.webhookEndpoint.create({
    data: { ...tenantWhere(req), url, eventTypes, secret },
    select: { endpointId: true, url: true, eventTypes: true, active: true, createdAt: true },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "webhook_created",
      targetType: "webhook_endpoint",
      targetId: endpoint.endpointId,
      details: `Registered webhook endpoint for ${url}`,
    }),
  });

  res.status(201).json({
    ...endpoint,
    secret,
    note: "This signing secret is shown once. Use it to verify the X-Webhook-Signature header on each delivery.",
  });
});

router.patch("/webhooks/:endpointId", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage webhooks" });

  const existing = await prisma.webhookEndpoint.findFirst({
    where: { ...tenantWhere(req), endpointId: req.params.endpointId },
  });
  if (!existing) return res.status(404).json({ error: "Webhook endpoint not found" });

  const { active } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be a boolean" });

  await prisma.webhookEndpoint.updateMany({
    where: { ...tenantWhere(req), endpointId: req.params.endpointId },
    data: { active },
  });

  res.status(204).send();
});

router.delete("/webhooks/:endpointId", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage webhooks" });

  const existing = await prisma.webhookEndpoint.findFirst({
    where: { ...tenantWhere(req), endpointId: req.params.endpointId },
  });
  if (!existing) return res.status(404).json({ error: "Webhook endpoint not found" });

  await prisma.webhookEndpoint.deleteMany({
    where: { ...tenantWhere(req), endpointId: req.params.endpointId },
  });

  res.status(204).send();
});

/** Delivery history for one endpoint — the answer to "is this actually
 *  working" without needing access to the receiving server's own logs. */
router.get("/webhooks/:endpointId/deliveries", requireAuth, requireTenantScope, async (req, res) => {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { ...tenantWhere(req), endpointId: req.params.endpointId },
  });
  if (!endpoint) return res.status(404).json({ error: "Webhook endpoint not found" });

  const deliveries = await prisma.webhookDelivery.findMany({
    where: { endpointId: endpoint.endpointId },
    orderBy: { attemptedAt: "desc" },
    take: 50,
  });
  res.json(deliveries);
});

export default router;
