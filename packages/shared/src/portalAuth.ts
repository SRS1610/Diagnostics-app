// portalAuth.ts
//
// Backend portal authentication — separate from technicianAuth.ts (which
// is about attributing MOBILE APP inspection work) and from
// customerProfile.ts's PIN (which selects a test config). This is about
// who can log into the web admin portal at all, and what they can see
// once they're in.

import { logActivity } from "./adminActivityLog";

export type PortalRole = "master_admin" | "tenant_admin" | "tenant_staff";

export interface PortalUser {
  userId: string;
  email: string;
  role: PortalRole;
  // null ONLY for master_admin — every tenant_admin/tenant_staff user
  // belongs to exactly one tenant and can never see another tenant's data.
  tenantId: string | null;
}

export interface PortalSession {
  user: PortalUser;
  viewingTenantId: string | null;
}

export async function login(email: string, password: string): Promise<PortalSession | null> {
  const response = await fetch(`${process.env.PORTAL_AUTH_API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  const user = (await response.json()) as PortalUser;

  logActivity({
    tenantId: user.tenantId,
    actorUserId: user.userId,
    actorRole: user.role,
    action: "portal_login",
    targetType: "session",
    targetId: user.userId,
    details: `${user.email} logged in`,
  });

  return {
    user,
    viewingTenantId: user.tenantId,
  };
}

export function enterTenantView(session: PortalSession, tenantId: string): PortalSession {
  if (session.user.role !== "master_admin") {
    throw new Error("Only master_admin can switch tenant view");
  }

  logActivity({
    tenantId: tenantId,
    actorUserId: session.user.userId,
    actorRole: session.user.role,
    action: "entered_tenant_view",
    targetType: "tenant",
    targetId: tenantId,
    details: `Master admin entered tenant view for ${tenantId}`,
  });

  return { ...session, viewingTenantId: tenantId };
}

export function exitTenantView(session: PortalSession): PortalSession {
  logActivity({
    tenantId: session.viewingTenantId,
    actorUserId: session.user.userId,
    actorRole: session.user.role,
    action: "exited_tenant_view",
    targetType: "tenant",
    targetId: session.viewingTenantId ?? "platform",
    details: `Master admin exited tenant view`,
  });

  return { ...session, viewingTenantId: null };
}
