/**
 * @format
 */

import { parseProfileQrPayload, parseTechnicianBadgePayload } from '../src/lib/qrPayloads';

describe('parseTechnicianBadgePayload', () => {
  it('extracts tenantId and badgeCode from a valid badge payload', () => {
    expect(parseTechnicianBadgePayload('DIAGTECH:ten_abc123:TEC-1042')).toEqual({
      tenantId: 'ten_abc123',
      badgeCode: 'TEC-1042',
    });
  });

  it('returns null for a profile QR (wrong prefix)', () => {
    expect(parseTechnicianBadgePayload('DIAGPROFILE:ten_abc123:4726')).toBeNull();
  });

  it('returns null for an unprefixed code, e.g. a device barcode scanned by mistake', () => {
    expect(parseTechnicianBadgePayload('356938035643809')).toBeNull();
  });

  it('returns null when the tenantId or badgeCode half is missing', () => {
    expect(parseTechnicianBadgePayload('DIAGTECH:ten_abc123')).toBeNull();
    expect(parseTechnicianBadgePayload('DIAGTECH:ten_abc123:')).toBeNull();
    expect(parseTechnicianBadgePayload('DIAGTECH::TEC-1042')).toBeNull();
  });
});

describe('parseProfileQrPayload', () => {
  it('extracts tenantId and pin from a valid profile payload', () => {
    expect(parseProfileQrPayload('DIAGPROFILE:ten_abc123:4726')).toEqual({
      tenantId: 'ten_abc123',
      pin: '4726',
    });
  });

  it('returns null for a technician badge (wrong prefix)', () => {
    expect(parseProfileQrPayload('DIAGTECH:ten_abc123:TEC-1042')).toBeNull();
  });

  it('returns null when malformed', () => {
    expect(parseProfileQrPayload('DIAGPROFILE:')).toBeNull();
    expect(parseProfileQrPayload('DIAGPROFILE:ten_abc123')).toBeNull();
  });
});
