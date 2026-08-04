// src/auth/SessionContext.tsx
//
// Holds the portal session and, critically, which tenant the user is
// currently looking at.
//
// The distinction that matters: a tenant_admin/tenant_staff is bound to
// exactly one tenant and can never change it. A master_admin has no
// tenant until they explicitly enter one, and every tenant-scoped page
// is unreachable until they do — the API enforces this
// (requireTenantScope returns 400 with no tenant context), so the UI
// mirrors it rather than inventing its own rule.
//
// Entering and leaving a tenant view mints a NEW token server-side.
// Storing the returned token rather than tracking a tenant id locally is
// what makes the UI incapable of disagreeing with the API about which
// tenant is in scope.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setAuthToken, setUnauthorizedHandler, type LoginResponse, type PortalRole } from "../api/client";

const STORAGE_KEY = "diagnostics.portal.session";

interface StoredSession {
  token: string;
  email: string;
  role: PortalRole;
  /** The tenant whose data is currently in scope. Null for a
   *  master_admin who has not entered a tenant view. */
  viewingTenantId: string | null;
  viewingTenantName: string | null;
  /** True until the user replaces a password an admin issued. Routing
   *  keeps them on the password screen while it is set. */
  mustChangePassword: boolean;
}

interface SessionContextValue extends Partial<StoredSession> {
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<PortalRole>;
  logout: () => void;
  enterTenantView: (tenantId: string, companyName: string) => Promise<void>;
  exitTenantView: () => Promise<void>;
  clearMustChangePassword: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function load(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? (JSON.parse(raw) as StoredSession) : null;
    // Prime the api client SYNCHRONOUSLY, here, rather than leaving it
    // to the effect below. Child effects flush before the parent's, so
    // on a hard page load a page's first fetch fires before this
    // provider's effect has run — it would go out with no Authorization
    // header, take a 401, and bounce a perfectly valid session back to
    // the login screen. Restoring a session and arming the client that
    // uses it have to happen in the same breath.
    setAuthToken(stored?.token ?? null);
    return stored;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<StoredSession | null>(() => load());

  // Keeps the token in sync for every SUBSEQUENT change (login, tenant
  // switch, logout); the initial restore is handled in load() above.
  useEffect(() => {
    setAuthToken(session?.token ?? null);
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  }, [session]);

  const logout = useCallback(() => setSession(null), []);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<LoginResponse>("/auth/login", { email, password });
    setSession({
      token: res.token,
      email: res.user.email,
      role: res.user.role,
      // Tenant users land in their own tenant; a master_admin lands
      // with no tenant in scope and must enter one explicitly.
      viewingTenantId: res.user.tenantId,
      viewingTenantName: null,
      mustChangePassword: Boolean(res.user.mustChangePassword),
    });
    return res.user.role;
  }, []);

  const enterTenantView = useCallback(async (tenantId: string, companyName: string) => {
    const res = await api.post<{ token: string; viewingTenantId: string }>("/auth/enter-tenant-view", { tenantId });
    setSession((prev) =>
      prev ? { ...prev, token: res.token, viewingTenantId: res.viewingTenantId, viewingTenantName: companyName } : prev,
    );
  }, []);

  const clearMustChangePassword = useCallback(() => {
    setSession((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
  }, []);

  const exitTenantView = useCallback(async () => {
    const res = await api.post<{ token: string }>("/auth/exit-tenant-view");
    setSession((prev) => (prev ? { ...prev, token: res.token, viewingTenantId: null, viewingTenantName: null } : prev));
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({
      ...session,
      isAuthenticated: Boolean(session?.token),
      login,
      logout,
      enterTenantView,
      exitTenantView,
      clearMustChangePassword,
      mustChangePassword: Boolean(session?.mustChangePassword),
    }),
    [session, login, logout, enterTenantView, exitTenantView, clearMustChangePassword],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
