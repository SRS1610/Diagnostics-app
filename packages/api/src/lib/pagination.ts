// src/lib/pagination.ts
//
// Pagination for the list endpoints that grow without bound.
//
// WHY HEADERS RATHER THAN AN ENVELOPE. The obvious design is to wrap
// results as `{ items, total, hasMore }`. This returns the array as-is
// and puts the counts in response headers instead, because the body is
// already a contract: the mobile app and the portal both consume these
// endpoints as arrays, and changing that shape to add a feature neither
// of them asked for breaks working clients to no benefit. Headers carry
// exactly the same information — total, limit, offset, has-more — and
// leave every existing caller working unchanged. GitHub's API does the
// same thing for the same reason.
//
// WHICH ENDPOINTS. Only the three that grow with usage: reports,
// disputes and the activity log. Profiles, technicians, licences and
// users are bounded by how many people and programs a company has —
// tens, not thousands — and paginating them would add controls to
// pages that will never need them.

import { Request, Response } from "express";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface ListWindow {
  limit: number;
  offset: number;
}

/**
 * Reads ?limit and ?offset, clamped. A caller asking for 10,000 rows
 * gets MAX_LIMIT rather than an error: the request is reasonable, the
 * number is not, and failing it would be less useful than serving what
 * can be served and saying so in the headers.
 */
export function parseListWindow(req: Request): ListWindow {
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  return { limit, offset };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Total is the count of rows matching the FILTER, not the page — that
 * is the number a UI needs to say "showing 1–50 of 312" and to decide
 * whether a next-page control does anything.
 */
export function setPaginationHeaders(
  res: Response,
  { total, limit, offset }: { total: number; limit: number; offset: number },
): void {
  res.set({
    "X-Total-Count": String(total),
    "X-Limit": String(limit),
    "X-Offset": String(offset),
    "X-Has-More": String(offset + limit < total),
  });
}

/** Trimmed, length-capped free-text search term, or undefined. Capped
 *  because it reaches a LIKE query: an unbounded string is a cheap way
 *  to make the database do expensive work. */
export function parseSearch(raw: unknown, maxLength = 100): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

/** A date filter that ignores an unparseable value rather than throwing
 *  or, worse, silently filtering everything out with an Invalid Date. */
export function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
