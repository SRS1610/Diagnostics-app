// Telnyx signs every webhook with Ed25519 over `${timestamp}|${rawBody}`,
// sent as base64 in Telnyx-Signature-Ed25519 with Telnyx-Timestamp. The
// public key (32 raw bytes, base64) is in Mission Control → Keys & Credentials.
// Mirrors the official SDK's TelnyxWebhook.verify, using node:crypto.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

const TOLERANCE_SECONDS = 300;

export function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new Error(`TELNYX_PUBLIC_KEY must be 32 bytes (base64); got ${raw.length}`);
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function verifyTelnyxSignature(
  key: KeyObject,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const signature = header(headers, "telnyx-signature-ed25519");
  const timestamp = header(headers, "telnyx-timestamp");
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  // Reject replays of old (or far-future) deliveries.
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  try {
    return verify(null, Buffer.from(`${timestamp}|${rawBody}`), key, sig);
  } catch {
    return false;
  }
}
