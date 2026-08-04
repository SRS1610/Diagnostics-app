// src/middleware/auth.ts
//
// Verifies the JWT issued at login (see routes/auth.ts) and attaches the
// decoded session to req.portalSession, consumed by tenantScope.ts and
// every protected route.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";


const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required — see .env.example");
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET as string) as {
      userId?: string;
      role?: "master_admin" | "tenant_admin" | "tenant_staff";
      tenantId?: string | null;
      viewingTenantId?: string | null;
      kind?: string;
    };

    // Portal and technician tokens share one signing secret, so a
    // technician token verifies perfectly well here. Without this check
    // it would populate a portalSession with an undefined role and
    // viewingTenantId — which happened to fail closed downstream, but
    // only by luck: requireTenantScope rejected it for "no tenant
    // context" rather than "wrong kind of token", and any future portal
    // route using requireAuth WITHOUT requireTenantScope would have
    // received a session with no identity at all. This mirrors the
    // check already in requireTechnicianAuth; the guard needs to exist
    // in both directions, not one.
    if (decoded.kind !== "portal" || !decoded.userId || !decoded.role) {
      return res.status(401).json({ error: "Not a portal session token" });
    }

    // REVOCATION. Everything above proves the token was validly signed
    // and has not expired — nothing more. Without this lookup, a portal
    // session survived deactivation and deletion for its full 12 hours,
    // and since there was no user management at all there was no way to
    // cut anyone off. Deactivating an account has to mean something on
    // the next request, not at some point within half a day.
    //
    // The ROLE is re-read too, rather than trusted from the token: a
    // demotion from tenant_admin to tenant_staff must take effect
    // immediately, or the demoted user keeps admin powers until their
    // token expires.
    const user = await prisma.portalUser.findUnique({
      where: { userId: decoded.userId },
      select: { userId: true, role: true, tenantId: true, active: true },
    });
    if (!user || !user.active) {
      return res.status(401).json({ error: "This session is no longer valid. Sign in again." });
    }

    // A tenant user's scope comes from their OWN record, never from the
    // token, so it cannot be widened by a stale or tampered claim. Only
    // a master_admin has a viewingTenantId that legitimately differs
    // from their own tenantId, because entering a tenant view is what
    // that role does.
    const viewingTenantId =
      user.role === "master_admin" ? (decoded.viewingTenantId ?? null) : user.tenantId;

    req.portalSession = {
      userId: user.userId,
      role: user.role as "master_admin" | "tenant_admin" | "tenant_staff",
      viewingTenantId,
      // Carried separately so requireTenantScope can cross-check the
      // scope against where this user actually belongs, rather than
      // against itself.
      ownTenantId: user.tenantId,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Restricts a route to master_admin only. Used for the transition routes
 * themselves (enter/exit tenant view), where checking role alone is
 * correct — those routes exist precisely to change viewingTenantId.
 * For genuinely cross-tenant resources (tenant CRUD, platform analytics),
 * use requireMasterConsole below instead, which additionally confirms
 * the session isn't currently "inside" a tenant's view.
 */
export function requireMasterAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.portalSession?.role !== "master_admin") {
    return res.status(403).json({ error: "Master admin access required" });
  }
  next();
}

/**
 * Restricts a route to genuine Master Console context: master_admin AND
 * viewingTenantId === null. A master_admin who has called
 * /auth/enter-tenant-view is deliberately "inside" one tenant's view for
 * support purposes — CLAUDE.md requires that context never be blurred
 * with the cross-tenant Master Console, so master-console-only routes
 * (tenant CRUD, platform-wide analytics) must reject a session that's
 * currently scoped into a tenant, even though its role is still
 * master_admin. Call /auth/exit-tenant-view first to clear it.
 */
export function requireMasterConsole(req: Request, res: Response, next: NextFunction) {
  if (req.portalSession?.role !== "master_admin") {
    return res.status(403).json({ error: "Master admin access required" });
  }
  if (req.portalSession.viewingTenantId !== null) {
    return res.status(400).json({
      error: "This action requires Master Console context. Call /auth/exit-tenant-view first.",
    });
  }
  next();
}
