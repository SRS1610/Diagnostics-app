// Sessions. The token only says WHO is signed in; role, tenant and whether
// the account is still active are re-read from the database on every
// request, so a role change or deactivation takes effect immediately.
//
// res.locals.session.businessId is the ONLY tenant id API handlers may use.

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { User, UserRole } from "@prisma/client";
import { jwtSecret } from "./config";
import { db } from "./db";

export interface Session {
  userId: string;
  name: string;
  role: UserRole;
  businessId: string | null;
  /** A platform admin looking at one tenant for support: read-only. */
  viewAs: boolean;
  suspended: boolean;
}

export function issueToken(user: Pick<User, "id">): string {
  return jwt.sign({ sub: user.id }, jwtSecret(), { expiresIn: "14d" });
}

/** Short-lived, read-only token for a platform admin to see one tenant. */
export function issueViewAsToken(admin: Pick<User, "id">, businessId: string): string {
  return jwt.sign({ sub: admin.id, va: businessId }, jwtSecret(), { expiresIn: "1h" });
}

class AuthError extends Error {}

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Please sign in" });
  try {
    const p = jwt.verify(h.slice(7), jwtSecret());
    if (typeof p === "string" || !p.sub) throw new AuthError();
    const user = await db.user.findUnique({ where: { id: p.sub }, include: { business: { select: { status: true } } } });
    if (!user || !user.active) throw new AuthError();

    let session: Session;
    if (typeof p.va === "string") {
      if (user.role !== "PLATFORM_ADMIN") throw new AuthError();
      const b = await db.business.findUnique({ where: { id: p.va }, select: { status: true } });
      if (!b) throw new AuthError();
      session = { userId: user.id, name: user.name, role: user.role, businessId: p.va, viewAs: true, suspended: b.status === "SUSPENDED" };
    } else {
      session = {
        userId: user.id, name: user.name, role: user.role, businessId: user.businessId, viewAs: false,
        suspended: user.business?.status === "SUSPENDED",
      };
    }
    res.locals.session = session;
    next();
  } catch {
    res.status(401).json({ error: "Your session expired — please sign in again" });
  }
}

export const session = (res: Response): Session => res.locals.session as Session;

/** Tenant id for the request. Throws if this session isn't inside a tenant. */
export function tenant(res: Response): string {
  const id = session(res).businessId;
  if (!id) throw new Error("tenant() used outside a tenant route");
  return id;
}
