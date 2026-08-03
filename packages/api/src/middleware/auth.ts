// src/middleware/auth.ts
//
// Verifies the JWT issued at login (see routes/auth.ts) and attaches the
// decoded session to req.portalSession, consumed by tenantScope.ts and
// every protected route.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET env var is required — see .env.example");
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, JWT_SECRET as string) as {
      userId: string;
      role: "master_admin" | "tenant_admin" | "tenant_staff";
      tenantId: string | null;
      viewingTenantId: string | null;
    };
    req.portalSession = {
      userId: decoded.userId,
      role: decoded.role,
      viewingTenantId: decoded.viewingTenantId,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Restricts a route to master_admin only — use for tenant CRUD,
 * cross-tenant analytics, and license provisioning at the platform level.
 */
export function requireMasterAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.portalSession?.role !== "master_admin") {
    return res.status(403).json({ error: "Master admin access required" });
  }
  next();
}
