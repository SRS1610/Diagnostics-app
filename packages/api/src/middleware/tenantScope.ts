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
  // own — this check catches a forged/tampered viewingTenantId even if
  // something upstream failed to enforce it.
  if (
    (session.role === "tenant_admin" || session.role === "tenant_staff") &&
    session.viewingTenantId !== req.portalSession?.viewingTenantId
  ) {
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
