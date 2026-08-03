// src/context/SessionContext.tsx
//
// Session-level state carried across the mobile flow's steps — plain
// React Context, no new state-management dependency needed for three
// screens' worth of shared state.

import React, { createContext, useContext, useMemo, useState } from 'react';
import type { CustomerProfile, LicenseCheckResult, Technician } from '../api/client';
import type { CapturedIdentity } from '../lib/deviceIdentity';

interface SessionState {
  technician: Technician | null;
  profile: CustomerProfile | null;
  licenseCheck: LicenseCheckResult | null;
  /** Set on the Find Your ID screen, confirmed/edited on Confirm, then
   *  locked for the rest of the session. */
  device: Partial<CapturedIdentity> | null;
}

interface SessionContextValue extends SessionState {
  setTechnician: (technician: Technician) => void;
  setProfile: (profile: CustomerProfile) => void;
  setLicenseCheck: (result: LicenseCheckResult) => void;
  setDevice: (device: Partial<CapturedIdentity>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [technician, setTechnician] = useState<Technician | null>(null);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [licenseCheck, setLicenseCheck] = useState<LicenseCheckResult | null>(null);
  const [device, setDevice] = useState<Partial<CapturedIdentity> | null>(null);

  const value = useMemo(
    () => ({
      technician,
      profile,
      licenseCheck,
      device,
      setTechnician,
      setProfile,
      setLicenseCheck,
      setDevice,
    }),
    [technician, profile, licenseCheck, device],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
