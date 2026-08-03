// src/lib/consumerToken.ts
//
// The consumer tracker has no login. A customer who traded in a phone is
// not a portal user and never will be — creating an account per device
// would be worse for them and would put consumer PII in the tenant's
// user table. So access is a capability: one unguessable token per
// report, handed to that customer (and encoded in the QR on the PDF).
//
// Everything that makes this safe rests on the token being unguessable:
//
//  - 32 bytes from the CSPRNG, not Math.random, not a uuid, and above
//    all not derived from reportId. A derived token would mean anyone
//    holding one report's link could compute another's.
//  - base64url so it survives a URL and a QR code without escaping.
//  - Compared only by exact database lookup on a unique index; there is
//    no partial or prefix match anywhere.
//
// What the token does NOT grant is equally deliberate: it reaches
// exactly one report, it carries the tenant with it (so no public route
// ever accepts a tenantId from the caller), and the public projection
// strips everything CLAUDE.md says a buyer-safe view must not show.

import { randomBytes } from "node:crypto";

/** 256 bits. Long enough that enumeration is not a threat model, which
 *  is the point — there is no rate limit low enough to make a short
 *  token safe, and no reason to use one. */
export function mintConsumerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Rejects obviously malformed tokens before they reach the database.
 *  This is not a security boundary — the unique-index lookup is — it
 *  just avoids a query per junk request. */
export function looksLikeConsumerToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
