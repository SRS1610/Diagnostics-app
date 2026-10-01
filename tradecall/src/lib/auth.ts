import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret } from "./config";

export function issueToken(businessId: string): string {
  return jwt.sign({ sub: businessId }, jwtSecret(), { expiresIn: "14d" });
}

/** Puts the signed-in business on res.locals.businessId — the ONLY tenant id API handlers use. */
export function requireOwner(req: Request, res: Response, next: NextFunction) {
  const h = req.header("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Please sign in" });
  try {
    const p = jwt.verify(h.slice(7), jwtSecret());
    if (typeof p === "string" || !p.sub) throw new Error();
    res.locals.businessId = p.sub;
    next();
  } catch {
    res.status(401).json({ error: "Your session expired — please sign in again" });
  }
}

export const tenant = (res: Response): string => res.locals.businessId as string;
