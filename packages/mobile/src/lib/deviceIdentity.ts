// src/lib/deviceIdentity.ts
//
// Parsing and validation for captured device identity. Pure logic, no
// native calls — the camera/OCR plumbing lives in the screens, so this
// can be unit tested, which matters because OCR output is messy and the
// failure modes are subtle.
//
// CLAUDE.md, "CRITICAL platform constraint": IMEI and serial CANNOT be
// read programmatically on either platform. Everything here operates on
// what a technician scanned, photographed, or typed.

/** CLAUDE.md: "IMEI is always 15 digits — validate format after capture." */
export function isValidImeiFormat(value: string): boolean {
  return /^\d{15}$/.test(value);
}

/**
 * The IMEI's last digit is a Luhn check digit, so a typo or OCR misread
 * usually fails this. Deliberately advisory, NOT a hard gate: the API
 * accepts any 15 digits, and the designed remedy for a misread is the
 * technician confirmation step. A real device with a worn label, or a
 * nonstandard/refurbished unit, shouldn't strand a session — but the
 * technician should be told the digits look wrong before locking them
 * into an audit record.
 */
export function passesImeiChecksum(value: string): boolean {
  if (!isValidImeiFormat(value)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let digit = Number(value[i]);
    // Double every second digit from the left (positions 1,3,5...),
    // which for a 15-digit IMEI leaves the final check digit undoubled.
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * OCR reliably confuses letters with visually identical digits.
 * CLAUDE.md names 0/O and 1/I specifically. Applied ONLY to fields known
 * to be all-digits (IMEI) — never to serial numbers, which legitimately
 * contain both letters and digits, so "correcting" them would corrupt
 * valid input.
 */
export function normalizeOcrDigits(raw: string): string {
  return raw.replace(/[OoQD]/g, "0").replace(/[IilL|]/g, "1").replace(/[Ss]/g, "5").replace(/[Bb]/g, "8");
}

/**
 * Pulls an IMEI out of OCR text. Handles the three layouts that actually
 * appear: a labelled line ("IMEI: 356938035643809"), the grouped form
 * printed on many SIM trays ("35 693803 564380 9"), and a bare run of
 * digits. Returns null rather than guessing when nothing matches — a
 * failed scan should fall back to manual entry, not to a wrong number.
 */
export function extractImeiFromText(text: string): string | null {
  // Prefer an explicitly labelled IMEI: a device label often shows
  // several long numbers (IMEI, MEID, serial), and the label is the only
  // reliable way to tell which is which.
  const labelled = text.match(/IMEI[^0-9A-Za-z]{0,4}((?:[0-9OoQDIilL|Ss Bb-]){15,25})/i);
  const candidates: string[] = [];
  if (labelled?.[1]) candidates.push(labelled[1]);

  // Fall back to any run of digits/separators long enough to hold 15.
  for (const m of text.matchAll(/(?:[0-9][0-9 -]{13,25}[0-9])/g)) candidates.push(m[0]);

  for (const candidate of candidates) {
    const digits = normalizeOcrDigits(candidate).replace(/[^0-9]/g, "");
    if (digits.length === 15 && isValidImeiFormat(digits)) return digits;
    // A 16-17 char run is usually an IMEISV or a 15-digit IMEI with a
    // stray adjacent digit; take the leading 15 only when the checksum
    // agrees, so we don't silently truncate the wrong number.
    if (digits.length > 15 && passesImeiChecksum(digits.slice(0, 15))) return digits.slice(0, 15);
  }
  return null;
}

/**
 * Serial numbers have no fixed format across manufacturers, so this only
 * trusts an explicit label ("Serial", "S/N", "SN"). Guessing at an
 * unlabelled alphanumeric token would produce confident-looking garbage
 * on a label crowded with model and regulatory codes — worse than
 * returning null and letting the technician type it.
 */
export function extractSerialFromText(text: string): string | null {
  const m = text.match(/(?:serial(?:\s*(?:no|number|#))?|s\s*\/\s*n|\bsn)\b[^A-Za-z0-9]{0,4}([A-Z0-9-]{6,20})/i);
  return m?.[1]?.toUpperCase() ?? null;
}

/**
 * A scanned barcode from a device label may be a bare IMEI, or prefixed
 * text. Normalizes to a bare 15-digit IMEI when one is present.
 */
export function extractImeiFromBarcode(raw: string): string | null {
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  if (digitsOnly.length === 15) return digitsOnly;
  return extractImeiFromText(raw);
}

export interface CapturedIdentity {
  make: string;
  model: string;
  serialNumber: string;
  imei: string;
  imei2?: string;
  captureSource: "barcode" | "ocr" | "manual";
}

export interface IdentityValidation {
  /** Blocks confirmation — the API would reject these anyway. */
  errors: string[];
  /** Surfaced to the technician but does not block. */
  warnings: string[];
}

export function validateIdentity(identity: Partial<CapturedIdentity>): IdentityValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!identity.make?.trim()) errors.push("Make is required.");
  if (!identity.model?.trim()) errors.push("Model is required.");
  // The backend Devices tab groups inspections by serial number, so a
  // blank one silently merges unrelated devices into one history.
  if (!identity.serialNumber?.trim()) errors.push("Serial number is required.");

  if (!identity.imei?.trim()) {
    errors.push("IMEI is required.");
  } else if (!isValidImeiFormat(identity.imei)) {
    errors.push("IMEI must be exactly 15 digits.");
  } else if (!passesImeiChecksum(identity.imei)) {
    warnings.push("IMEI checksum doesn't match — check for a misread digit (0/O, 1/I) before continuing.");
  }

  if (identity.imei2?.trim()) {
    if (!isValidImeiFormat(identity.imei2)) {
      errors.push("Second IMEI must be exactly 15 digits.");
    } else if (!passesImeiChecksum(identity.imei2)) {
      warnings.push("Second IMEI checksum doesn't match — check for a misread digit.");
    }
    if (identity.imei2 === identity.imei) {
      errors.push("The two IMEIs are identical — a dual-SIM device has two different numbers.");
    }
  }

  return { errors, warnings };
}
