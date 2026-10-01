import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { requireJwtSecret } from "./config";

const TOKEN_TTL = "7d";

export function signToken(businessId: string): string {
  return jwt.sign({ sub: businessId }, requireJwtSecret(), { expiresIn: TOKEN_TTL });
}

/** Sets res.locals.businessId — the ONLY tenant id portal routes may use. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const payload = jwt.verify(token, requireJwtSecret());
    if (typeof payload === "string" || !payload.sub) throw new Error("bad payload");
    res.locals.businessId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Session expired — sign in again" });
  }
}

export function businessIdOf(res: Response): string {
  return res.locals.businessId as string;
}
