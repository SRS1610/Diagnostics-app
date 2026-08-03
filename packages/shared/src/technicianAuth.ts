// technicianAuth.ts
//
// Establishes WHO is running a session, separate from customerProfile.ts's
// PIN (which only selects WHICH tests run). See CLAUDE.md "Technician
// identity" for why these were kept separate rather than overloading one
// PIN for both purposes.

export interface Technician {
  technicianId: string;
  displayName: string;
  badgeCode: string; // short code/PIN scanned or entered at shift start
}

/**
 * Lightweight by design — this is a shared warehouse tablet, not a
 * personal device, so a full username/password would add friction for
 * no real security benefit (the tablet itself should already be
 * access-controlled at the facility level). A badge scan or short code
 * is enough to establish identity for attribution purposes: redo
 * history, dispute resolution notes, and QA/accuracy metrics.
 */
export async function loginTechnician(badgeCode: string): Promise<Technician | null> {
  const response = await fetch(`${process.env.TECHNICIAN_AUTH_API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ badgeCode }),
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
