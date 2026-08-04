// src/pages/Misc.tsx — Billing, Team, Activity Log, Settings
//
// Grouped because each is a single view over one endpoint. The larger
// pages live in their own files.

import { useState } from "react";
import { api, type ActivityLogEntry, type License, type Technician } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatCard, StatusBadge, formatDate, useApi } from "../components/common";
import { UsersSection } from "./Users";

// ============================================================
// Billing & Licenses — admin_portal_billing.html
// ============================================================

export function BillingPage() {
  const { role } = useSession();
  // Provisioning is refused for tenant_staff by the API (403); don't
  // offer a form that can only fail.
  const canProvision = role !== "tenant_staff";
  const { data, loading, error, reload } = useApi(() => api.get<License[]>("/licenses"));
  const licenses = data ?? [];
  const active = licenses.find((l) => l.status === "active");

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Billing & Licenses</h1>
          <p className="page-sub">Exactly one licence is active per tenant at a time</p>
        </div>
      </div>

      {/* Rendered whenever the fetch has resolved either way, so a
          failure shows as "—" rather than the whole block vanishing —
          a missing usage panel reads as "no licence", which is a
          different and alarming claim. */}
      {(active || error) && (
        <div className="stat-grid">
          <StatCard value={active ? active.type.replace(/_/g, " ") : "—"} label="Plan" loading={loading} error={error} />
          <StatCard
            value={active?.usageThisPeriod ?? "—"}
            label="Inspections this period"
            loading={loading}
            error={error}
          />
          <StatCard value={active?.includedQuota ?? "—"} label="Included quota" loading={loading} error={error} />
          <StatCard
            value={active?.seatLimit ? `${active.activeSeats}/${active.seatLimit}` : "—"}
            label="Seats in use"
            loading={loading}
            error={error}
          />
        </div>
      )}

      {canProvision && <NewLicenseForm onProvisioned={reload} />}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={licenses.length === 0} emptyMessage="No licences provisioned.">
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Status</th>
                <th>Period</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((l) => (
                <tr key={l.licenseId}>
                  <td>{l.type.replace(/_/g, " ")}</td>
                  <td><StatusBadge status={l.status} /></td>
                  <td className="muted">
                    {new Date(l.billingPeriodStart).toLocaleDateString()} – {new Date(l.billingPeriodEnd).toLocaleDateString()}
                  </td>
                  <td className="muted">
                    {l.usageThisPeriod}{l.includedQuota ? ` / ${l.includedQuota}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 16 }}>
        Invoices can be generated from usage, but nothing here charges anyone — that needs a payment processor, which
        is not integrated. Amounts on generated invoices use placeholder plan pricing and are not billable as-is.
      </p>
    </>
  );
}

const LICENSE_TYPES = [
  { value: "per_inspection", label: "Per-inspection (metered)", quota: true, seats: false },
  { value: "seat_subscription", label: "Seat subscription", quota: false, seats: true },
  { value: "tiered_subscription", label: "Tiered subscription", quota: true, seats: false },
  { value: "enterprise_unlimited", label: "Enterprise unlimited", quota: false, seats: false },
] as const;

/** CLAUDE.md records "New License" as a previously dead button; this is
 *  the form behind it. Provisioning SUPERSEDES the tenant's current
 *  active licence rather than adding alongside it — the API enforces
 *  one-active-per-tenant — so that consequence is stated here rather
 *  than discovered afterwards. */
function NewLicenseForm({ onProvisioned }: { onProvisioned: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>(LICENSE_TYPES[0].value);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [includedQuota, setQuota] = useState("");
  const [seatLimit, setSeats] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shape = LICENSE_TYPES.find((t) => t.value === type)!;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/licenses", {
        type,
        billingPeriodStart: new Date(start).toISOString(),
        billingPeriodEnd: new Date(end).toISOString(),
        includedQuota: shape.quota && includedQuota ? Number(includedQuota) : null,
        seatLimit: shape.seats && seatLimit ? Number(seatLimit) : null,
      });
      setOpen(false);
      setStart("");
      setEnd("");
      setQuota("");
      setSeats("");
      onProvisioned();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not provision licence");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <button className="btn" onClick={() => setOpen(true)}>New Licence</button>
      </div>
    );
  }

  return (
    <form className="card" style={{ marginBottom: 20 }} onSubmit={submit}>
      {error && <div className="error-box">{error}</div>}
      <div className="field">
        <label htmlFor="ltype">Plan type</label>
        <select id="ltype" className="input" value={type} onChange={(e) => setType(e.target.value)}>
          {LICENSE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="lstart">Billing period start</label>
        <input id="lstart" type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="lend">Billing period end</label>
        <input id="lend" type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </div>
      {shape.quota && (
        <div className="field">
          <label htmlFor="lquota">Included inspections</label>
          <input id="lquota" className="input" inputMode="numeric" value={includedQuota} onChange={(e) => setQuota(e.target.value)} />
        </div>
      )}
      {shape.seats && (
        <div className="field">
          <label htmlFor="lseats">Seat limit</label>
          <input id="lseats" className="input" inputMode="numeric" value={seatLimit} onChange={(e) => setSeats(e.target.value)} />
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        This replaces the tenant's current active licence — only one can be active at a time, and the previous one is
        marked expired.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn" disabled={busy || !start || !end}>Provision licence</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

// ============================================================
// Team — admin_portal_team.html
// ============================================================

export function TeamPage() {
  const { data, loading, error, reload } = useApi(() => api.get<Technician[]>("/technicians"));
  const technicians = data ?? [];
  const [actionError, setActionError] = useState<string | null>(null);

  // Deactivation, not deletion. A technician who has inspected anything
  // cannot be deleted — that would erase their attribution — so this is
  // the control that actually revokes access, and it takes effect on
  // their next request rather than when their session would expire.
  const setActive = async (technician: Technician, active: boolean) => {
    setActionError(null);
    try {
      await api.patch(`/technicians/${technician.technicianId}`, { active });
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not update this technician");
    }
  };

  return (
    <>
      <h1 className="page-title">Team</h1>
      <p className="page-sub">Technicians who can run inspections for this tenant</p>

      {actionError && <div className="error-box">{actionError}</div>}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={technicians.length === 0} emptyMessage="No technicians yet.">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Badge code</th>
                <th>Access</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {technicians.map((t) => (
                <tr key={t.technicianId}>
                  <td style={{ fontWeight: 600 }}>{t.displayName}</td>
                  <td className="muted">{t.badgeCode}</td>
                  <td>
                    <span className={`badge ${t.active ? "badge-pass" : "badge-neutral"}`}>
                      {t.active ? "active" : "deactivated"}
                    </span>
                  </td>
                  <td className="muted">{formatDate(t.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => void setActive(t, !t.active)}>
                      {t.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 16 }}>
        Deactivating ends a technician's access immediately — any session already open on a tablet stops working on its
        next request, and their badge no longer signs in. Their inspection history keeps their name on it, which is why
        this replaces deleting them.
      </p>

      {/* Portal users and technicians are deliberately separate
          identities — one signs into this portal, the other into the
          tablet — but both are "who works here", so they belong on one
          page rather than sending an admin hunting. */}
      <UsersSection />

      <p className="page-sub">
        QA metrics (redo rate, dispute rate per technician) are part of this page in the design but need aggregate
        endpoints that don't exist yet. Showing invented figures on a page used to judge people's work would be worse
        than showing none.
      </p>
    </>
  );
}

// ============================================================
// Activity Log — admin_portal_activity_log.html
// ============================================================

// Every value here must be a member of ActivityAction — the API rejects
// the whole request with a 400 if any one is unrecognised, so a typo in
// this list breaks the filter rather than quietly narrowing it.
const ACTION_FILTERS = [
  { label: "All", value: "" },
  { label: "Auth", value: "portal_login,portal_logout,entered_tenant_view,exited_tenant_view" },
  { label: "Tenants", value: "tenant_created,tenant_suspended,tenant_activated" },
  { label: "Profiles", value: "profile_created,profile_updated,profile_deleted" },
  {
    label: "Licences",
    value: "license_provisioned,license_suspended,license_expired,seat_consumed,seat_released",
  },
  { label: "Disputes", value: "dispute_received,dispute_upheld,dispute_grade_adjusted" },
  { label: "Reports", value: "report_revision_created,data_wipe_certified" },
  { label: "Warranty", value: "warranty_claim_filed,warranty_claim_resolved" },
  { label: "Pricing", value: "pricing_uploaded" },
  { label: "Settings", value: "settings_updated" },
];

export function ActivityLogPage() {
  const [actions, setActions] = useState("");
  const { data, loading, error } = useApi(
    () => api.get<ActivityLogEntry[]>(`/activity-log${actions ? `?actions=${actions}` : ""}`),
    [actions],
  );
  const entries = data ?? [];

  return (
    <>
      <h1 className="page-title">Activity Log</h1>
      <p className="page-sub">Every admin and system action for this tenant</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {ACTION_FILTERS.map((f) => (
          <button
            key={f.label}
            className={`btn btn-sm ${actions === f.value ? "" : "btn-secondary"}`}
            onClick={() => setActions(f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={entries.length === 0} emptyMessage="No activity recorded.">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.entryId}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDate(e.timestamp)}</td>
                  <td className="muted">
                    {/* actorRole distinguishes a portal user from a
                        technician — the ids live in different tables, so
                        conflating them would send an auditor to the
                        wrong one. */}
                    {e.actorRole.replace(/_/g, " ")}
                  </td>
                  <td><span className="badge badge-neutral">{e.action.replace(/_/g, " ")}</span></td>
                  <td className="muted">{e.details ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
    </>
  );
}

// ============================================================
// Settings — admin_portal_settings.html
// ============================================================

export function SettingsPage() {
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Organisation configuration</p>

      {/* Retention is a settled decision, not an open question, and this
          panel says so. It is stated rather than offered as a toggle
          because there is no expiry logic anywhere in the system to
          switch off — keeping data is what happens when nothing deletes
          it, and a control implying otherwise would be fiction. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Data retention</h2>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.7, margin: 0 }}>
          Inspection data is kept <strong>indefinitely, by policy</strong>. There is no automatic expiry, purge or
          archival job — this applies to IMEI and serial numbers, cosmetic photos, dispute records, technician
          attribution and redo history alike.
        </p>
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 0 }}>
          No self-service deletion exists, deliberately: an audit trail that can be erased from the portal is not an
          audit trail. If a customer covered by a right-to-deletion law (GDPR, CCPA/CPRA or similar) makes a specific
          request, honouring it is a manual, out-of-band task for whoever administers the database — the policy above
          sets the default, it does not answer the request.
        </p>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Notifications</h2>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Not configured. SMS and email templates exist, but no provider is connected, so nothing is sent. Showing
          toggles here would imply messages are going out when they are not.
        </p>
      </div>

      <p className="page-sub" style={{ marginTop: 16 }}>
        Settings are read-only for now: there is no persistence endpoint behind them, and a form that appears to save
        but doesn't is worse than a page that says so.
      </p>
    </>
  );
}
