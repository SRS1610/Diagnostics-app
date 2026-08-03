// src/lib/qrPayloads.ts
//
// Mirrors packages/shared/src/customerProfile.ts's
// generateProfileQrPayload/parseProfileQrPayload and
// packages/shared/src/technicianAuth.ts's
// generateTechnicianBadgePayload/parseTechnicianBadgePayload exactly.
//
// NOT imported from @diagnostics/shared directly: per
// packages/shared/package.json's own description, the mobile app is "a
// separate repo/package due to Metro bundler constraints" that "mirrors
// these types" rather than consuming the shared npm workspace package.
// Keep this file's prefixes/parsing logic in sync with the shared
// source by hand if either changes.

const PROFILE_QR_PREFIX = 'DIAGPROFILE:';
const TECHNICIAN_BADGE_PREFIX = 'DIAGTECH:';

export function parseProfileQrPayload(payload: string): { tenantId: string; pin: string } | null {
  if (!payload.startsWith(PROFILE_QR_PREFIX)) return null;
  const rest = payload.slice(PROFILE_QR_PREFIX.length);
  const [tenantId, pin] = rest.split(':');
  if (!tenantId || !pin) return null;
  return { tenantId, pin };
}

export function parseTechnicianBadgePayload(payload: string): { tenantId: string; badgeCode: string } | null {
  if (!payload.startsWith(TECHNICIAN_BADGE_PREFIX)) return null;
  const rest = payload.slice(TECHNICIAN_BADGE_PREFIX.length);
  const [tenantId, badgeCode] = rest.split(':');
  if (!tenantId || !badgeCode) return null;
  return { tenantId, badgeCode };
}
