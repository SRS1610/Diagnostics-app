// src/lib/passwords.ts
//
// Password rules and temporary-password generation, in one place so the
// login route, the self-service change and the admin reset cannot drift
// apart on what counts as acceptable.

import { randomBytes, randomInt } from "node:crypto";

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Length over composition rules. Mandatory symbol-and-digit patterns
 * push people towards `Password1!` — predictable, and shorter than a
 * passphrase that would actually be harder to guess. A minimum length
 * and a rejection of the handful of obvious strings is more honest about
 * what it achieves.
 */
const OBVIOUS = new Set([
  "password",
  "password123",
  "changeme",
  "changeme123",
  "letmein",
  "qwertyuiop",
  "123456789012",
]);

export function validatePassword(password: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof password !== "string") return { ok: false, error: "Password is required" };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  // Bcrypt silently truncates beyond 72 BYTES, so a longer password is
  // not more secure and, worse, two different long passwords can end up
  // equivalent. Rejected rather than quietly cut.
  if (Buffer.byteLength(password, "utf8") > 72) {
    return { ok: false, error: "Password must be 72 bytes or fewer" };
  }
  if (OBVIOUS.has(password.toLowerCase())) {
    return { ok: false, error: "That password is too easily guessed — choose another" };
  }
  return { ok: true };
}

// Deliberately excludes characters that get misread when a password is
// written down or read aloud, which is exactly how these are delivered
// while no email provider exists: no O/0, I/l/1, or ambiguous symbols.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A temporary password, long enough that its randomness — not its
 *  composition — is what makes it safe. */
export function generateTemporaryPassword(length = 16): string {
  // randomInt is rejection-sampled, so the distribution is uniform;
  // `randomBytes()[i] % alphabet.length` is not, and biases the result.
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** A self-service reset token. Only its hash is ever stored. */
export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}
