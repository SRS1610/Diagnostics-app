// technicianAuth.ts
//
// Establishes WHO is running a session, separate from customerProfile.ts's
// PIN (which only selects WHICH tests run). See CLAUDE.md "Technician
// identity" for why these were kept separate rather than overloading one
// PIN for both purposes.
//
// RESOLVED — badge scoping under multi-tenancy: this module predated the
// multi-tenant migration and was missed when CustomerProfile got its
// tenantId + tenantId:pin QR payload (see customerProfile.ts). A
// badgeCode is only unique WITHIN a tenant (schema.prisma's
// @@unique([tenantId, badgeCode])), so a bare badgeCode lookup is
// ambiguous across tenants — the same problem customerProfile.ts already
// solved for PINs. Fixed the same way: Technician now carries tenantId,
// and badge cards are printed with a QR encoding tenantId:badgeCode
// together (generateTechnicianBadgePayload/parseTechnicianBadgePayload,
// mirroring generateProfileQrPayload/parseProfileQrPayload exactly).
// This keeps "Technician Login" as mobile Step 1 — before the profile QR
// scan — since the badge scan itself now carries tenant context, rather
// than needing to reorder the flow or wait for Step 2.

export interface Technician {
  technicianId: string;
  tenantId: string; // see the header note above — needed to disambiguate
                     // badgeCode, which is only unique WITHIN a tenant
  displayName: string;
  badgeCode: string; // short code/PIN scanned or entered at shift start
}

// Prefixed like PROFILE_QR_PREFIX so the scanner can tell a technician
// badge apart from a profile QR or a device barcode seen later in the
// same session.
const TECHNICIAN_BADGE_PREFIX = "DIAGTECH:";

export function generateTechnicianBadgePayload(technician: Technician): string {
  return `${TECHNICIAN_BADGE_PREFIX}${technician.tenantId}:${technician.badgeCode}`;
}

/**
 * Extracts {tenantId, badgeCode} from a scanned badge QR. Returns null if
 * the scanned code isn't a technician badge at all, or is malformed —
 * same failed-scan handling as parseProfileQrPayload.
 */
export function parseTechnicianBadgePayload(payload: string): { tenantId: string; badgeCode: string } | null {
  if (!payload.startsWith(TECHNICIAN_BADGE_PREFIX)) return null;
  const rest = payload.slice(TECHNICIAN_BADGE_PREFIX.length);
  const [tenantId, badgeCode] = rest.split(":");
  if (!tenantId || !badgeCode) return null;
  return { tenantId, badgeCode };
}

/**
 * Lightweight by design — this is a shared warehouse tablet, not a
 * personal device, so a full username/password would add friction for
 * no real security benefit (the tablet itself should already be
 * access-controlled at the facility level). A badge scan or short code
 * is enough to establish identity for attribution purposes: redo
 * history, dispute resolution notes, and QA/accuracy metrics.
 *
 * Takes tenantId + badgeCode, not badgeCode alone — see the header note.
 * The mobile app gets both together from a single badge QR scan via
 * parseTechnicianBadgePayload (primary path) or a tenant-picker +
 * manual badge code entry (fallback, same pattern as profile PIN entry).
 */
export async function loginTechnician(tenantId: string, badgeCode: string): Promise<Technician | null> {
  const response = await fetch(`${process.env.TECHNICIAN_AUTH_API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId, badgeCode }),
  });
  if (response.status === 404) return null;
  return response.json() as Promise<Technician>;
}

/**
 * Session-level, not per-inspection — a technician logs in once at the
 * start of a shift, not once per device. Persist this alongside
 * whatever holds the current BatchSession/session state.
 *
 * If the organization's license is seat_subscription type, call
 * licensing.ts's consumeSeat() alongside this — a logged-in technician
 * should always correspond to exactly one consumed seat. Call
 * releaseSeat() at endShift(). These were built as two separate modules
 * without this connection initially; wire them together at the call
 * site (wherever your session/shift management lives), not inside
 * either module, since not every license type needs seat tracking.
 */
export interface ShiftSession {
  technician: Technician;
  loggedInAt: string;
  location: string;
}

export function startShift(technician: Technician, location: string): ShiftSession {
  return {
    technician,
    loggedInAt: new Date().toISOString(),
    location,
  };
}

export function endShift(session: ShiftSession): { technician: Technician; loggedOutAt: string; durationMs: number } {
  const loggedOutAt = new Date().toISOString();
  return {
    technician: session.technician,
    loggedOutAt,
    durationMs: new Date(loggedOutAt).getTime() - new Date(session.loggedInAt).getTime(),
  };
}
