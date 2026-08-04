// src/routes/sso.ts
//
// Tenant-admin management of the tenant's ONE OIDC connection — separate
// from the actual login flow (POST /auth/sso/start, GET /auth/sso/
// callback, POST /auth/sso/exchange), which lives in auth.ts alongside
// the rest of the "signing in" family and is deliberately unauthenticated
// (nobody has a session yet at that point).
//
// Admin-only, same tenant_staff restriction as billing, disputes and
// integrations — configuring how the whole tenant signs in is not a
// day-to-day action.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const requireAdmin = (req: Parameters<typeof requireAuth>[0]) => req.portalSession!.role !== "tenant_staff";

const PUBLIC_FIELDS = {
  connectionId: true,
  domain: true,
  issuer: true,
  clientId: true,
  authorizationEndpoint: true,
  tokenEndpoint: true,
  jwksUri: true,
  enabled: true,
  enforced: true,
  createdAt: true,
  updatedAt: true,
} as const;

router.get("/sso", requireAuth, requireTenantScope, async (req, res) => {
  const connection = await prisma.ssoConnection.findFirst({
    where: tenantWhere(req),
    select: { ...PUBLIC_FIELDS, clientSecret: true },
  });
  if (!connection) return res.json(null);

  // clientSecret is never returned in readable form once saved — the
  // admin already knows what they typed in; the API doesn't need to
  // hand it back out. hasClientSecret tells the form whether "leave
  // blank to keep the current secret" is a real option.
  const { clientSecret, ...rest } = connection;
  res.json({ ...rest, hasClientSecret: Boolean(clientSecret) });
});

router.post("/sso", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage SSO" });

  const { domain, issuer, clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksUri } = (req.body ??
    {}) as Record<string, unknown>;

  const required = { domain, issuer, clientId, authorizationEndpoint, tokenEndpoint, jwksUri };
  for (const [key, value] of Object.entries(required)) {
    if (typeof value !== "string" || !value.trim()) {
      return res.status(400).json({ error: `${key} is required` });
    }
  }
  for (const [key, value] of [
    ["authorizationEndpoint", authorizationEndpoint],
    ["tokenEndpoint", tokenEndpoint],
    ["jwksUri", jwksUri],
    ["issuer", issuer],
  ] as const) {
    if (typeof value === "string" && !/^https?:\/\//.test(value)) {
      return res.status(400).json({ error: `${key} must be a valid http(s) URL` });
    }
  }

  const existing = await prisma.ssoConnection.findFirst({ where: tenantWhere(req) });
  // A blank clientSecret on an UPDATE means "keep the current one" — the
  // admin editing the domain or endpoints shouldn't have to re-paste a
  // secret the API never showed them back in the first place.
  if (typeof clientSecret !== "string" || !clientSecret.trim()) {
    if (!existing) return res.status(400).json({ error: "clientSecret is required" });
  }

  const domainNormalized = (domain as string).trim().toLowerCase();

  try {
    const connection = existing
      ? await prisma.ssoConnection.update({
          where: { connectionId: existing.connectionId },
          data: {
            domain: domainNormalized,
            issuer: (issuer as string).trim(),
            clientId: (clientId as string).trim(),
            ...(typeof clientSecret === "string" && clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
            authorizationEndpoint: (authorizationEndpoint as string).trim(),
            tokenEndpoint: (tokenEndpoint as string).trim(),
            jwksUri: (jwksUri as string).trim(),
          },
          select: PUBLIC_FIELDS,
        })
      : await prisma.ssoConnection.create({
          data: {
            ...tenantWhere(req),
            domain: domainNormalized,
            issuer: (issuer as string).trim(),
            clientId: (clientId as string).trim(),
            clientSecret: (clientSecret as string).trim(),
            authorizationEndpoint: (authorizationEndpoint as string).trim(),
            tokenEndpoint: (tokenEndpoint as string).trim(),
            jwksUri: (jwksUri as string).trim(),
          },
          select: PUBLIC_FIELDS,
        });

    await prisma.activityLogEntry.create({
      data: buildActivityLogData({
        tenantId: req.portalSession!.viewingTenantId,
        actorUserId: req.portalSession!.userId,
        actorRole: req.portalSession!.role,
        action: "sso_connection_configured",
        targetType: "sso_connection",
        targetId: connection.connectionId,
        details: `Configured SSO for domain ${connection.domain}`,
      }),
    });

    res.status(existing ? 200 : 201).json(connection);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // domain is unique PLATFORM-WIDE — see the schema comment. Said
      // plainly rather than a generic "conflict", since the fix (pick a
      // different domain, or confirm which tenant already owns it) is
      // not something the admin can guess from a bare 409.
      return res.status(409).json({ error: "That email domain is already registered to another organization's SSO connection" });
    }
    throw e;
  }
});

router.patch("/sso", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage SSO" });

  const existing = await prisma.ssoConnection.findFirst({ where: tenantWhere(req) });
  if (!existing) return res.status(404).json({ error: "No SSO connection configured for this organization" });

  const { enabled, enforced } = (req.body ?? {}) as Record<string, unknown>;
  const data: Prisma.SsoConnectionUpdateInput = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
    data.enabled = enabled;
  }
  if (enforced !== undefined) {
    if (typeof enforced !== "boolean") return res.status(400).json({ error: "enforced must be a boolean" });
    // Enforcing SSO with it not yet enabled would lock the tenant out of
    // password login while giving nobody a working way in at all — the
    // enabled flag exists precisely to prevent a half-configured
    // connection from doing anything, and this keeps that true here too.
    if (enforced && !(enabled ?? existing.enabled)) {
      return res.status(400).json({ error: "Cannot enforce SSO before it is enabled" });
    }
    data.enforced = enforced;
  }

  const updated = await prisma.ssoConnection.update({
    where: { connectionId: existing.connectionId },
    data,
    select: PUBLIC_FIELDS,
  });
  res.json(updated);
});

router.delete("/sso", requireAuth, requireTenantScope, async (req, res) => {
  if (!requireAdmin(req)) return res.status(403).json({ error: "tenant_staff cannot manage SSO" });

  const existing = await prisma.ssoConnection.findFirst({ where: tenantWhere(req) });
  if (!existing) return res.status(404).json({ error: "No SSO connection configured for this organization" });

  await prisma.ssoConnection.delete({ where: { connectionId: existing.connectionId } });
  res.status(204).send();
});

export default router;
