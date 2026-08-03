// src/pages/MasterConsole.tsx — master_console.html
//
// The only genuinely cross-tenant view in the portal. Everything else
// filters to one tenant.
//
// "Enter tenant view" is an explicit, logged action — CLAUDE.md:
// "Must be an explicit, logged action — never silent, never automatic."
// The API mints a new token scoped to that tenant and writes an
// entered_tenant_view entry to the activity log, so the transition is
// recorded rather than merely reflected in the UI.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Tenant } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

export function MasterConsolePage() {
  const { enterTenantView } = useSession();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => api.get<Tenant[]>("/tenants"));

  const [creating, setCreating] = useState(false);
  const [companyName, setCompanyName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const tenants = data ?? [];

  const enter = async (tenant: Tenant) => {
    await enterTenantView(tenant.tenantId, tenant.companyName);
    navigate("/dashboard");
  };

  const provision = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post("/tenants", { companyName: companyName.trim(), primaryContactEmail: contactEmail.trim() });
      setCompanyName("");
      setContactEmail("");
      setCreating(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create tenant");
    }
  };

  const setStatus = async (tenant: Tenant, action: "suspend" | "activate") => {
    await api.patch(`/tenants/${tenant.tenantId}/${action}`);
    await reload();
  };

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Tenants</h1>
          <p className="page-sub">Every company on the platform</p>
        </div>
        <button className="btn" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New Tenant"}
        </button>
      </div>

      <div className="stat-grid">
        <div className="card">
          <div className="stat-num">{tenants.length}</div>
          <div className="stat-label">Tenants</div>
        </div>
        <div className="card">
          <div className="stat-num">{tenants.filter((t) => t.status === "active").length}</div>
          <div className="stat-label">Active</div>
        </div>
        <div className="card">
          <div className="stat-num">{tenants.filter((t) => t.status === "trial").length}</div>
          <div className="stat-label">Trial</div>
        </div>
        <div className="card">
          <div className="stat-num">{tenants.filter((t) => t.status === "suspended").length}</div>
          <div className="stat-label">Suspended</div>
        </div>
      </div>

      {creating && (
        <form className="card" style={{ marginBottom: 20 }} onSubmit={provision}>
          {formError && <div className="error-box">{formError}</div>}
          <div className="field">
            <label htmlFor="company">Company name</label>
            <input id="company" className="input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="contact">Primary contact email</label>
            <input id="contact" className="input" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required />
          </div>
          <button className="btn" disabled={!companyName.trim() || !contactEmail.trim()}>
            Create tenant
          </button>
        </form>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={tenants.length === 0} emptyMessage="No tenants yet.">
          <table>
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Contact</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.tenantId}>
                  <td style={{ fontWeight: 600 }}>{tenant.companyName}</td>
                  <td><StatusBadge status={tenant.status} /></td>
                  <td className="muted">{tenant.primaryContactEmail}</td>
                  <td className="muted">{formatDate(tenant.createdAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn btn-sm" onClick={() => void enter(tenant)}>
                      Enter tenant
                    </button>{" "}
                    {tenant.status === "suspended" ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void setStatus(tenant, "activate")}>
                        Activate
                      </button>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => void setStatus(tenant, "suspend")}>
                        Suspend
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 18 }}>
        Platform-wide revenue and device totals are not shown here yet — they need aggregate endpoints that don't
        exist, and inventing plausible numbers on a console used for billing decisions would be worse than omitting
        them.
      </p>
    </>
  );
}
