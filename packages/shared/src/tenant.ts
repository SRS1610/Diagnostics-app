// tenant.ts
//
// The top-level entity in the multi-tenant model: one Tenant = one paying
// company (a refurbisher, carrier, trade-in program) with fully isolated
// data. See CLAUDE.md "Multi-tenant architecture" for what this changes
// across the rest of the app.
//
// IMPORTANT — this reframes what CustomerProfile meant before: a
// CustomerProfile (named test config + PIN) now lives WITHIN a tenant,
// not AS a tenant. A tenant can have multiple profiles (e.g. different
// programs or locations under one company), all billed under one
// License. Previously License.profileId pointed at a CustomerProfile —
// that was wrong under real multi-tenancy; billing happens at the
// tenant level. See licensing.ts, now updated to tie to tenantId.

import { logActivity } from "./adminActivityLog";

export type TenantStatus = "active" | "suspended" | "trial";

export interface Tenant {
  tenantId: string;
  companyName: string;
  createdAt: string;
  status: TenantStatus;
  primaryContactEmail: string;
}

export function createTenant(companyName: string, primaryContactEmail: string, actorUserId: string): Tenant {
  const tenant: Tenant = {
    tenantId: `TEN-${Date.now()}`,
    companyName,
    createdAt: new Date().toISOString(),
    status: "trial",
    primaryContactEmail,
  };

  logActivity({
    tenantId: null,
    actorUserId,
    actorRole: "master_admin",
    action: "tenant_created",
    targetType: "tenant",
    targetId: tenant.tenantId,
    details: `Created tenant "${companyName}"`,
  });

  return tenant;
}

export function suspendTenant(tenant: Tenant, actorUserId: string): Tenant {
  logActivity({
    tenantId: tenant.tenantId,
    actorUserId,
    actorRole: "master_admin",
    action: "tenant_suspended",
    targetType: "tenant",
    targetId: tenant.tenantId,
    details: `Suspended tenant "${tenant.companyName}"`,
  });

  return { ...tenant, status: "suspended" };
}

export function activateTenant(tenant: Tenant, actorUserId: string): Tenant {
  logActivity({
    tenantId: tenant.tenantId,
    actorUserId,
    actorRole: "master_admin",
    action: "tenant_activated",
    targetType: "tenant",
    targetId: tenant.tenantId,
    details: `Activated tenant "${tenant.companyName}"`,
  });

  return { ...tenant, status: "active" };
}
