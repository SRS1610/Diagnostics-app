// src/middleware/tenantScope.ts
//
// THE MOST IMPORTANT FILE IN THIS API. Every route that touches
// tenant-scoped data (reports, profiles, devices, disputes, etc.) MUST
// use this middleware. See CLAUDE.md "Multi-tenant architecture" —
// the tenant-indicator badge on every portal page is only the visual
// half of tenant scoping; this middleware is the other, equally
// necessary half: the actual query-level enforcement.
//
// Usage: router.get("/reports", requireTenantScope, (req, res) => {
//   // req.viewingTenantId is now guaranteed to be set and verified
//   const reports = await prisma.report.findMany({
//     where: { tenantId: req.viewingTenantId }  // NEVER omit this filter
//   });
// });

import { Request, Response, NextFunction } from "express";

// Extend Express's Request type with our session fields, populated by
// the auth middleware (not shown here — verifies the JWT and attaches
// the decoded PortalSession from portalAuth.ts).
declare module "express-serve-static-core" {
  interface Request {
    portalSession?: {
      userId: string;
      role: "master_admin" | "tenant_admin" | "tenant_staff";
      viewingTenantId: string | null;
      /** The tenant this user BELONGS to, read fresh from their own row
       *  by requireAuth. Kept separate from viewingTenantId so the check
       *  below has an independent value to compare against — the two
       *  differ legitimately only for a master_admin inside a tenant
       *  view. */
      ownTenantId: string | null;
    };
  }
}

export function requireTenantScope(req: Request, res: Response, next: NextFunction) {
  const session = req.portalSession;

  if (!session) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!session.viewingTenantId) {
    // master_admin with no tenant selected — this is valid for the
    // Master Console's cross-tenant aggregate views, but INVALID for
    // any normal tenant-scoped route (Reports, Devices, Profiles, etc.)
    return res.status(400).json({
      error: "No tenant context set. Master admin must call enterTenantView first for this endpoint.",
    });
  }

  // tenant_admin/tenant_staff can NEVER view a tenant other than their
  // own.
  //
  // This check previously compared session.viewingTenantId against
  // req.portalSession.viewingTenantId — the same value, since `session`
  // is an alias for it. It could not fire, so the file's most important
  // safety net was dead code that read like protection. Found in review.
  //
  // It now compares against ownTenantId, which requireAuth reads from
  // the user's own database row. That makes it a genuine independent
  // assertion: if any future change lets a tenant user's viewingTenantId
  // be set from a token claim or a request parameter, this catches the
  // mismatch instead of waving it through.
  if (session.role !== "master_admin" && session.viewingTenantId !== session.ownTenantId) {
    return res.status(403).json({ error: "Cannot access another tenant's data" });
  }

  next();
}

/**
 * Helper for building the where-clause every tenant-scoped Prisma query
 * needs. Use this rather than writing { tenantId: req.viewingTenantId }
 * inline everywhere — one place to change if the scoping strategy ever
 * needs to evolve (e.g. adding soft-delete filtering alongside it).
 */
export function tenantWhere(req: Request) {
  if (!req.portalSession?.viewingTenantId) {
    throw new Error("tenantWhere() called without a tenant in scope — did you forget requireTenantScope middleware?");
  }
  return { tenantId: req.portalSession.viewingTenantId };
}
