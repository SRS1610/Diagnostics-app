// src/middleware/technicianAuth.ts
//
// Authenticates the MOBILE app, as opposed to middleware/auth.ts +
// tenantScope.ts which authenticate the web portal. Two different
// clients, two different session types, deliberately not shared.
//
// WHY THIS EXISTS: every mobile endpoint before this one was an
// unauthenticated READ gated by knowing a low-entropy identifier
// (profile PIN, technician badge code) — acceptable because the worst
// case is reading data the caller already had to half-know, and each is
// rate-limited. Report creation is different in kind: it is a WRITE into
// a specific tenant's data. If tenantId came from the request body on an
// unauthenticated route, anyone on the network could inject fabricated
// inspection reports into any tenant — poisoning the audit trail that
// this entire product exists to produce, and burning that tenant's
// metered license credits.
//
// So badge login now issues a short-lived session token, and write
// routes derive tenantId from the TOKEN rather than the request. A
// technician can only ever write into the tenant their badge belongs to.
//
// This does NOT contradict CLAUDE.md's "badge login is about attribution,
// not security" — that describes what a badge code proves about WHO is
// running a session (weak, shared-tablet-level identity, fine for
// attribution). It doesn't follow that the API should accept anonymous
// writes over a network from anything claiming to be that tablet. The
// badge still isn't a strong personal credential; the token just binds
// the resulting session to one tenant.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required — see .env.example");
}

// Shorter than the portal's 12h: a shift-length window, after which the
// technician re-scans their badge.
export const TECHNICIAN_TOKEN_TTL = "12h";

export interface TechnicianSession {
  technicianId: string;
  tenantId: string;
}

declare module "express-serve-static-core" {
  interface Request {
    technicianSession?: TechnicianSession;
  }
}

export function issueTechnicianToken(session: TechnicianSession): string {
  return jwt.sign({ ...session, kind: "technician" }, JWT_SECRET as string, {
    expiresIn: TECHNICIAN_TOKEN_TTL,
  });
}

export async function requireTechnicianAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  let decoded: { technicianId?: string; tenantId?: string; kind?: string };
  try {
    decoded = jwt.verify(authHeader.slice("Bearer ".length), JWT_SECRET as string) as typeof decoded;
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // Reject a portal token presented here. Both token families are
  // signed with the same secret, so without this check a portal JWT
  // would verify fine and fall through with an undefined tenantId.
  if (decoded.kind !== "technician" || !decoded.technicianId || !decoded.tenantId) {
    return res.status(401).json({ error: "Not a technician session token" });
  }

  // REVOCATION. A JWT stays cryptographically valid for its whole TTL,
  // so without this lookup, removing a technician from the roster — the
  // one action an admin has for cutting off access, and the thing they
  // would do after a badge is lost or someone leaves — did nothing for
  // up to 12 hours. The token kept writing reports into the tenant.
  //
  // The same applies to a suspended tenant: suspension is a billing and
  // account-status decision, and a suspended account that keeps
  // accepting inspections is not suspended.
  //
  // This costs one indexed lookup per authenticated mobile request. That
  // is the price of being able to revoke at all; a token-only check is
  // only cheaper because it doesn't do the job.
  const technician = await prisma.technician.findFirst({
    // tenantId from the token is included in the filter rather than
    // trusted from it — if a technician were ever moved between tenants,
    // the old token must stop working rather than keep its old scope.
    where: { technicianId: decoded.technicianId, tenantId: decoded.tenantId },
    select: { technicianId: true, tenant: { select: { status: true } } },
  });

  if (!technician) {
    return res.status(401).json({ error: "This session is no longer valid. Log in again." });
  }
  if (technician.tenant.status === "suspended") {
    return res.status(403).json({ error: "This account is suspended. Contact your administrator." });
  }

  req.technicianSession = { technicianId: decoded.technicianId, tenantId: decoded.tenantId };
  next();
}

/**
 * The mobile-side counterpart to tenantScope.ts's tenantWhere(). Same
 * contract, same reason for existing: one place that decides how a
 * tenant filter is built, so no route hand-rolls it. Throws rather than
 * returning an unscoped filter if the middleware was forgotten — an
 * exception is a far better failure than a query that silently spans
 * every tenant.
 */
export function technicianTenantWhere(req: Request) {
  if (!req.technicianSession?.tenantId) {
    throw new Error(
      "technicianTenantWhere() called without a technician session — did you forget requireTechnicianAuth middleware?",
    );
  }
  return { tenantId: req.technicianSession.tenantId };
}
