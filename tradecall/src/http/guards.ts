// Who may do what. Mounted after requireUser.

import type { NextFunction, Request, Response } from "express";
import type { UserRole } from "@prisma/client";
import { session } from "../lib/auth";

const deny = (res: Response, status: number, error: string) => res.status(status).json({ error });

/** Routes inside one business. Platform admins only get in through a view-as token. */
export function requireTenant(_req: Request, res: Response, next: NextFunction) {
  if (!session(res).businessId) return deny(res, 403, "Open a business from the platform console first");
  next();
}

/**
 * Support view is read-only, and a suspended business can look but not
 * change anything. GET/HEAD always pass.
 */
export function blockWritesWhenReadOnly(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const s = session(res);
  if (s.viewAs) return deny(res, 403, "Support view is read-only");
  if (s.suspended) return deny(res, 403, "This account is suspended — contact support");
  next();
}

/** Allow only these tenant roles. A support view counts as OWNER for reading. */
export function allow(...roles: UserRole[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const s = session(res);
    const effective = s.viewAs ? "OWNER" : s.role;
    if (!roles.includes(effective)) return deny(res, 403, "You don't have permission to do that");
    next();
  };
}

export function requirePlatformAdmin(_req: Request, res: Response, next: NextFunction) {
  const s = session(res);
  if (s.role !== "PLATFORM_ADMIN" || s.viewAs) return deny(res, 403, "Platform admins only");
  next();
}
