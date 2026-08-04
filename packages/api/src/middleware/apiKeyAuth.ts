// src/middleware/apiKeyAuth.ts
//
// A third auth model, alongside the portal session (middleware/auth.ts)
// and the technician session (middleware/technicianAuth.ts). This one
// authenticates a SERVER, not a person — a B2B integration calling in
// programmatically — and is deliberately the narrowest of the three:
// read-only, no exceptions. requireApiKey never populates anything a
// write route could use, so a leaked key's worst case is "someone can
// read this tenant's data", not "someone can act as an admin".
//
// The key itself is checked by HASH, the same pattern as
// PasswordResetToken and MfaBackupCode: the full key exists in plaintext
// for exactly one moment (the response to POST /api-keys), and never
// again — a database dump does not hand over live credentials.

import { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";

export interface ApiKeySession {
  tenantId: string;
  keyId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    apiKeySession?: ApiKeySession;
  }
}

const KEY_PREFIX = "dgk_live_";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ") || !authHeader.slice(7).startsWith(KEY_PREFIX)) {
    return res.status(401).json({ error: "Missing or malformed API key" });
  }
  const key = authHeader.slice(7);

  const record = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) } });
  if (!record || record.revokedAt) {
    return res.status(401).json({ error: "Invalid or revoked API key" });
  }

  // Best-effort, not awaited on the request path: recording "last used"
  // is bookkeeping for the key-management UI, and a slow write to it
  // must not add latency to every authenticated API call.
  void prisma.apiKey.update({ where: { keyId: record.keyId }, data: { lastUsedAt: new Date() } }).catch(() => {});

  req.apiKeySession = { tenantId: record.tenantId, keyId: record.keyId };
  next();
}

/** The mobile/portal counterpart's tenantWhere(), for the third auth
 *  model. Throws rather than returning an unscoped filter if the
 *  middleware was forgotten, same contract as the other two. */
export function apiKeyTenantWhere(req: Request) {
  if (!req.apiKeySession?.tenantId) {
    throw new Error("apiKeyTenantWhere() called without an API key session — did you forget requireApiKey?");
  }
  return { tenantId: req.apiKeySession.tenantId };
}
