/**
 * @format
 */

import {
  extractImeiFromBarcode,
  extractImeiFromText,
  extractSerialFromText,
  isValidImeiFormat,
  normalizeOcrDigits,
  passesImeiChecksum,
  validateIdentity,
} from '../src/lib/deviceIdentity';

// 356938035643809 is the canonical GSMA test IMEI and passes Luhn.
const VALID_IMEI = '356938035643809';

describe('isValidImeiFormat', () => {
  it('accepts exactly 15 digits', () => {
    expect(isValidImeiFormat(VALID_IMEI)).toBe(true);
  });

  it('rejects wrong lengths and non-digits', () => {
    expect(isValidImeiFormat('35693803564380')).toBe(false);
    expect(isValidImeiFormat('3569380356438099')).toBe(false);
    expect(isValidImeiFormat('35693803564380O')).toBe(false);
    expect(isValidImeiFormat('')).toBe(false);
  });
});

describe('passesImeiChecksum', () => {
  it('accepts a real IMEI', () => {
    expect(passesImeiChecksum(VALID_IMEI)).toBe(true);
  });

  it('rejects a single transposed digit', () => {
    expect(passesImeiChecksum('356938035643808')).toBe(false);
  });

  it('rejects anything not 15 digits outright', () => {
    expect(passesImeiChecksum('12345')).toBe(false);
  });
});

describe('normalizeOcrDigits', () => {
  it('maps the letters OCR confuses with digits', () => {
    expect(normalizeOcrDigits('OIlSB')).toBe('01158');
  });
});

describe('extractImeiFromText', () => {
  it('reads a labelled IMEI', () => {
    expect(extractImeiFromText(`IMEI: ${VALID_IMEI}`)).toBe(VALID_IMEI);
  });

  it('reads the grouped form printed on SIM trays', () => {
    expect(extractImeiFromText('IMEI 35 693803 564380 9')).toBe(VALID_IMEI);
  });

  it('recovers from OCR letter-for-digit misreads', () => {
    // 0 -> O and 1 is absent here; use the digits that actually appear.
    expect(extractImeiFromText('IMEI: 3569380356438O9')).toBe(VALID_IMEI);
  });

  it('prefers the labelled number when the label shows several long numbers', () => {
    const label = `MEID 99000012345678\nIMEI: ${VALID_IMEI}\nS/N ABC123XYZ`;
    expect(extractImeiFromText(label)).toBe(VALID_IMEI);
  });

  it('returns null rather than guessing when nothing looks like an IMEI', () => {
    expect(extractImeiFromText('Model A2482 / Made in China')).toBeNull();
    expect(extractImeiFromText('')).toBeNull();
  });
});

describe('extractSerialFromText', () => {
  it.each([
    ['Serial: ABC123XYZ', 'ABC123XYZ'],
    ['S/N ABC123XYZ', 'ABC123XYZ'],
    ['SN: ABC123XYZ', 'ABC123XYZ'],
    ['Serial Number ABC123XYZ', 'ABC123XYZ'],
  ])('reads %s', (input, expected) => {
    expect(extractSerialFromText(input)).toBe(expected);
  });

  // Guessing at an unlabelled token would produce confident garbage on a
  // label crowded with model and regulatory codes.
  it('returns null when no serial label is present', () => {
    expect(extractSerialFromText('Model A2482 FCC ID BCG-E3085A')).toBeNull();
  });
});

describe('extractImeiFromBarcode', () => {
  it('accepts a bare scanned IMEI', () => {
    expect(extractImeiFromBarcode(VALID_IMEI)).toBe(VALID_IMEI);
  });

  it('strips separators', () => {
    expect(extractImeiFromBarcode('35-693803-564380-9')).toBe(VALID_IMEI);
  });

  it('falls back to text extraction for a prefixed payload', () => {
    expect(extractImeiFromBarcode(`IMEI:${VALID_IMEI}`)).toBe(VALID_IMEI);
  });

  it('returns null for an unrelated code', () => {
    expect(extractImeiFromBarcode('DIAGPROFILE:ten_abc:4726')).toBeNull();
  });
});

describe('validateIdentity', () => {
  const complete = {
    make: 'Apple',
    model: 'iPhone 13',
    serialNumber: 'ABC123XYZ',
    imei: VALID_IMEI,
    captureSource: 'barcode' as const,
  };

  it('passes a complete, valid identity', () => {
    expect(validateIdentity(complete)).toEqual({ errors: [], warnings: [] });
  });

  it.each(['make', 'model', 'serialNumber', 'imei'])('requires %s', (field) => {
    const partial = { ...complete, [field]: '' };
    expect(validateIdentity(partial).errors.length).toBeGreaterThan(0);
  });

  it('errors on a malformed IMEI', () => {
    const { errors } = validateIdentity({ ...complete, imei: '123' });
    expect(errors).toContain('IMEI must be exactly 15 digits.');
  });

  // The checksum is advisory: a worn label shouldn't strand a session,
  // but the technician should be told before it's locked into a report.
  it('warns, but does not block, on a checksum mismatch', () => {
    const { errors, warnings } = validateIdentity({ ...complete, imei: '356938035643808' });
    expect(errors).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it('rejects two identical IMEIs on a dual-SIM device', () => {
    const { errors } = validateIdentity({ ...complete, imei2: VALID_IMEI });
    expect(errors.some((e) => e.includes('identical'))).toBe(true);
  });

  it('accepts a genuine second IMEI', () => {
    const { errors } = validateIdentity({ ...complete, imei2: '356938035643791' });
    expect(errors).toEqual([]);
  });
});
