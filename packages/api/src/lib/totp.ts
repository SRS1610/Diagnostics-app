// src/lib/totp.ts
//
// TOTP (RFC 6238) over HOTP (RFC 4226), hand-rolled on Node's built-in
// crypto rather than a dependency. Every operation here is HMAC-SHA1 and
// base32, both of which are a few lines each — pulling in a package for
// this would be a dependency to audit and update forever in exchange for
// avoiding maybe 80 lines of code that don't change once written.
//
// RFC 6238 mandates SHA-1 for interoperability: every authenticator app
// (Google Authenticator, Authy, 1Password, Apple's built-in one) expects
// it, and deviating would mean this MFA only works with an app built
// specifically for it — defeating the point of using a standard.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
// How many 30-second steps of clock drift to tolerate on either side.
// Too tight and a phone whose clock is a few seconds off never works;
// too loose and a captured code stays valid for minutes.
const WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  // Any leftover bits (bits.length % 5 !== 0) are simply dropped, per
  // RFC 4648 — the encoder pads the OUTPUT, not incomplete input groups.
  return out;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** 160 bits, the RFC's recommended secret length for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secretBytes: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Node has no writeBigUInt64BE
  // issue here since counters this small fit in the low 32 bits; the
  // high 4 bytes stay zero for the lifetime of any real clock.
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", secretBytes).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** The code for a given instant — exposed mainly for tests, since
 *  verifyTotpCode is what production code should call. */
export function totpCodeAt(secret: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / PERIOD_SECONDS);
  return hotp(base32Decode(secret), counter);
}

/**
 * Checks a code against the current time step and WINDOW_STEPS on
 * either side, so a phone a few seconds fast or slow — or a human who
 * took a moment to type the code in — still works.
 *
 * Compares with a constant-time check: a code is a 6-digit secret this
 * function's whole job is to protect, and a timing side-channel that
 * narrowed the search space would undermine that regardless of how
 * unlikely it is to be practically exploitable here.
 */
export function verifyTotpCode(secret: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const codeBuffer = Buffer.from(code);
  const nowSeconds = Math.floor(at / 1000);

  for (let step = -WINDOW_STEPS; step <= WINDOW_STEPS; step += 1) {
    const candidate = totpCodeAt(secret, nowSeconds + step * PERIOD_SECONDS);
    const candidateBuffer = Buffer.from(candidate);
    if (candidateBuffer.length === codeBuffer.length && timingSafeEqual(candidateBuffer, codeBuffer)) {
      return true;
    }
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans (as a QR code) or
 *  accepts as manual entry. Standard format, understood by every major
 *  authenticator app without any platform-specific handling. */
export function totpEnrollmentUri(secret: string, accountEmail: string, issuer = "Device Diagnostics"): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
