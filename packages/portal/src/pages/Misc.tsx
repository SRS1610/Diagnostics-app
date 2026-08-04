// src/pages/Misc.tsx — Billing, Team, Activity Log, Settings
//
// Grouped because each is a single view over one endpoint. The larger
// pages live in their own files.

import { useState } from "react";
import {
  api,
  ApiError,
  type ActivityLogEntry,
  type License,
  type MfaConfirmResponse,
  type MfaEnrollResponse,
  type OrgSettings,
  type PortalUser,
  type SsoConnectionSummary,
  type Technician,
} from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, Pager, StatCard, StatusBadge, formatDate, useApi } from "../components/common";
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
  // past_due is included here alongside active — a license with a
  // failed-but-retrying renewal payment is still THE current one for
  // display purposes; it just also gets the warning banner below.
  const active = licenses.find((l) => l.status === "active" || l.status === "past_due");

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

      {active?.status === "past_due" && (
        <div className="error-box" style={{ marginBottom: 16 }}>
          The most recent renewal payment failed. Stripe will retry automatically — update the payment method via
          "Manage billing" below if it keeps failing.
        </div>
      )}

      {canProvision && <SelfServeBilling />}
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

/** Self-serve checkout via Stripe, alongside (not replacing) the manual
 *  "New Licence" form below — a sales-assisted deal still goes through
 *  an admin provisioning it directly. If Stripe isn't configured for
 *  this deployment, the API refuses with 501 and this section says so
 *  plainly rather than showing a button that can only fail. */
function SelfServeBilling() {
  const [planType, setPlanType] = useState<string>(LICENSE_TYPES[0].value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"checkout" | "portal" | null>(null);

  const checkout = async () => {
    setError(null);
    setBusy("checkout");
    try {
      const res = await api.post<{ checkoutUrl: string }>("/billing/checkout-session", { type: planType });
      window.location.href = res.checkoutUrl;
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 501
          ? "Self-serve checkout isn't set up for this deployment yet — use the manual form below, or contact support."
          : err instanceof Error
            ? err.message
            : "Could not start checkout",
      );
      setBusy(null);
    }
  };

  const manageBilling = async () => {
    setError(null);
    setBusy("portal");
    try {
      const res = await api.post<{ url: string }>("/billing/portal-session");
      window.location.href = res.url;
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "No billing history yet — check out a plan first."
          : err instanceof ApiError && err.status === 501
            ? "Self-serve billing isn't set up for this deployment yet."
            : err instanceof Error
              ? err.message
              : "Could not open the billing portal",
      );
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Self-serve billing</h2>
      {error && <div className="error-box">{error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select className="input" style={{ width: "auto" }} value={planType} onChange={(e) => setPlanType(e.target.value)}>
          {LICENSE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button className="btn" disabled={busy !== null} onClick={() => void checkout()}>
          {busy === "checkout" ? "Redirecting…" : "Check out with Stripe"}
        </button>
        <button className="btn btn-secondary" disabled={busy !== null} onClick={() => void manageBilling()}>
          {busy === "portal" ? "Redirecting…" : "Manage billing"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
        Checkout replaces this organization's current active licence, same as provisioning one manually below. "Manage
        billing" opens Stripe's own portal for payment methods, invoices, and cancellation.
      </p>
    </div>
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
  { label: "Auth", value: "portal_login,portal_logout,entered_tenant_view,exited_tenant_view,sso_login,sso_connection_configured" },
  {
    label: "Billing",
    value: "billing_checkout_completed,billing_payment_failed,billing_payment_recovered,billing_subscription_canceled",
  },
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

const LOG_PAGE_SIZE = 50;

export function ActivityLogPage() {
  const [actions, setActions] = useState("");
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams({ limit: String(LOG_PAGE_SIZE), offset: String(offset) });
  if (actions) params.set("actions", actions);

  const { data, loading, error } = useApi(
    () => api.getPage<ActivityLogEntry>(`/activity-log?${params}`),
    [actions, offset],
  );
  const entries = data?.items ?? [];

  return (
    <>
      <h1 className="page-title">Activity Log</h1>
      <p className="page-sub">Every admin and system action for this tenant</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {ACTION_FILTERS.map((f) => (
          <button
            key={f.label}
            className={`btn btn-sm ${actions === f.value ? "" : "btn-secondary"}`}
            onClick={() => {
              // Back to the first page: an offset from the previous
              // filter usually lands past the end of the new one, which
              // looks like "no matching activity".
              setOffset(0);
              setActions(f.value);
            }}
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

      {data && !error && (
        <Pager total={data.total} limit={data.limit} offset={data.offset} onOffset={setOffset} loading={loading} />
      )}
    </>
  );
}

// ============================================================
// Security — MFA (TOTP) enrollment, shown on the Settings page.
//
// Per-account, not per-tenant — every portal user manages their own,
// regardless of role. There is no /users/me: GET /users already returns
// this account among the tenant's users (Users.tsx uses the same
// "match by email" pattern for the "you" badge), so this reuses that
// fetch instead of adding a new endpoint for one field.
// ============================================================

function SecuritySection() {
  const { email: myEmail } = useSession();
  const { data, loading, error, reload } = useApi(() => api.get<PortalUser[]>("/users"));
  const me = data?.find((u) => u.email === myEmail);

  const [stage, setStage] = useState<"idle" | "enrolling" | "confirming" | "showing-codes" | "disabling">("idle");
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startEnroll = async () => {
    setFormError(null);
    setBusy(true);
    try {
      const res = await api.post<MfaEnrollResponse>("/auth/mfa/enroll");
      setEnrollment(res);
      setStage("confirming");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not start enrollment");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const res = await api.post<MfaConfirmResponse>("/auth/mfa/confirm", { code: confirmCode.trim() });
      setBackupCodes(res.backupCodes);
      setStage("showing-codes");
      setConfirmCode("");
      setEnrollment(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Incorrect code");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post("/auth/mfa/disable", { currentPassword: disablePassword, code: disableCode.trim() });
      setStage("idle");
      setDisablePassword("");
      setDisableCode("");
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not disable two-factor authentication");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Two-factor authentication</h2>

      <AsyncBoundary loading={loading} error={error}>
        {stage === "showing-codes" && backupCodes ? (
          <div style={{ borderColor: "var(--accent)" }}>
            <p style={{ margin: "0 0 8px" }}>
              <strong>Two-factor authentication is enabled.</strong> Save these backup codes somewhere safe — each
              works once, in place of a code from your app, and this is the only time they are shown.
            </p>
            <code
              style={{
                display: "block",
                padding: 12,
                background: "var(--panel-soft)",
                borderRadius: 8,
                fontSize: 14,
                lineHeight: 1.8,
                whiteSpace: "pre-wrap",
              }}
            >
              {backupCodes.join("\n")}
            </code>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setStage("idle")}>
              Done
            </button>
          </div>
        ) : stage === "confirming" && enrollment ? (
          <form onSubmit={confirmEnroll}>
            {formError && <div className="error-box">{formError}</div>}
            <p className="muted" style={{ fontSize: 13 }}>
              Scan this into an authenticator app (Google Authenticator, 1Password, Authy…), or enter the secret
              manually, then confirm with the 6-digit code it generates.
            </p>
            <div className="field">
              <label>Setup key</label>
              <code
                style={{
                  display: "block",
                  padding: 10,
                  background: "var(--panel-soft)",
                  borderRadius: 8,
                  fontSize: 13,
                  wordBreak: "break-all",
                }}
              >
                {enrollment.secret}
              </code>
            </div>
            <div className="field">
              <label>otpauth:// URI</label>
              <code
                style={{
                  display: "block",
                  padding: 10,
                  background: "var(--panel-soft)",
                  borderRadius: 8,
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                {enrollment.otpauthUri}
              </code>
            </div>
            <div className="field">
              <label htmlFor="mfaconfirm">6-digit code</label>
              <input
                id="mfaconfirm"
                className="input"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" disabled={busy || !confirmCode.trim()}>
                {busy ? "Confirming…" : "Confirm and enable"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setStage("idle");
                  setEnrollment(null);
                  setFormError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : stage === "disabling" ? (
          <form onSubmit={disable}>
            {formError && <div className="error-box">{formError}</div>}
            <p className="muted" style={{ fontSize: 13 }}>
              Turning this off requires your current password and a valid code — the same "an unattended session
              isn't enough" rule as changing your password, doubled, since this removes a control rather than just
              changing one.
            </p>
            <div className="field">
              <label htmlFor="mfadispw">Current password</label>
              <input
                id="mfadispw"
                className="input"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="mfadiscode">Code (app or backup)</label>
              <input
                id="mfadiscode"
                className="input"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                required
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" disabled={busy || !disablePassword || !disableCode.trim()}>
                {busy ? "Disabling…" : "Disable two-factor authentication"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setStage("idle");
                  setFormError(null);
                  setDisablePassword("");
                  setDisableCode("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            {formError && <div className="error-box">{formError}</div>}
            <div className="row-between">
              <span>
                <StatusBadge status={me?.mfaEnabled ? "active" : "deactivated"} />{" "}
                <span className="muted" style={{ fontSize: 13 }}>
                  {me?.mfaEnabled
                    ? "A code from your authenticator app is required at sign-in, in addition to your password."
                    : "Not enabled. Add a second factor so a stolen password alone isn't enough to sign in."}
                </span>
              </span>
              {me?.mfaEnabled ? (
                <button className="btn btn-secondary" onClick={() => setStage("disabling")}>
                  Disable
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => void startEnroll()}>
                  {busy ? "Starting…" : "Enable"}
                </button>
              )}
            </div>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}

// ============================================================
// Single sign-on — one OIDC connection per tenant, shown on Settings.
// Admin-only, same as the rest of this page's editable fields.
// ============================================================

function SsoSection() {
  const { role } = useSession();
  const canEdit = role !== "tenant_staff";
  const { data, loading, error, reload } = useApi(() => api.get<SsoConnectionSummary | null>("/sso"));

  const [editing, setEditing] = useState(false);
  const [domain, setDomain] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState("");
  const [tokenEndpoint, setTokenEndpoint] = useState("");
  const [jwksUri, setJwksUri] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startEditing = () => {
    if (data) {
      setDomain(data.domain);
      setIssuer(data.issuer);
      setClientId(data.clientId);
      setClientSecret("");
      setAuthorizationEndpoint(data.authorizationEndpoint);
      setTokenEndpoint(data.tokenEndpoint);
      setJwksUri(data.jwksUri);
    } else {
      setDomain("");
      setIssuer("");
      setClientId("");
      setClientSecret("");
      setAuthorizationEndpoint("");
      setTokenEndpoint("");
      setJwksUri("");
    }
    setFormError(null);
    setEditing(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api.post("/sso", { domain, issuer, clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksUri });
      setEditing(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save this SSO connection");
    } finally {
      setBusy(false);
    }
  };

  // Overrides the fetched value the instant a checkbox is clicked,
  // rather than waiting on the PATCH + reload round trip to reflect it.
  // Without this, setActionError(null) below triggers a re-render before
  // either await resolves, and a controlled checkbox tied straight to
  // the still-stale fetched `data` snaps back to its old state for a
  // moment — a click that visibly does nothing reads as broken, even
  // though the request is in flight and will succeed a beat later.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [pendingEnforced, setPendingEnforced] = useState<boolean | null>(null);

  const toggle = async (field: "enabled" | "enforced", value: boolean) => {
    setActionError(null);
    const setPending = field === "enabled" ? setPendingEnabled : setPendingEnforced;
    setPending(value);
    try {
      await api.patch("/sso", { [field]: value });
      await reload();
      setPending(null); // trust the freshly-reloaded data from here on
    } catch (err) {
      setPending(null); // revert the optimistic value on failure
      setActionError(err instanceof Error ? err.message : "Could not update this setting");
    }
  };

  const remove = async () => {
    if (!confirm("Remove this SSO connection? Users at this organization will no longer be able to sign in with it.")) return;
    setActionError(null);
    try {
      await api.delete("/sso");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not remove this connection");
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Single sign-on</h2>

      <AsyncBoundary loading={loading} error={error}>
        {editing ? (
          <form onSubmit={save}>
            {formError && <div className="error-box">{formError}</div>}
            <div className="field">
              <label htmlFor="ssodomain">Email domain</label>
              <input id="ssodomain" className="input" placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ssoissuer">Issuer</label>
              <input id="ssoissuer" className="input" value={issuer} onChange={(e) => setIssuer(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ssoclientid">Client ID</label>
              <input id="ssoclientid" className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ssoclientsecret">Client secret{data ? " (leave blank to keep the current one)" : ""}</label>
              <input
                id="ssoclientsecret"
                className="input"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required={!data}
              />
            </div>
            <div className="field">
              <label htmlFor="ssoauth">Authorization endpoint</label>
              <input id="ssoauth" className="input" value={authorizationEndpoint} onChange={(e) => setAuthorizationEndpoint(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ssotoken">Token endpoint</label>
              <input id="ssotoken" className="input" value={tokenEndpoint} onChange={(e) => setTokenEndpoint(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="ssojwks">JWKS URI</label>
              <input id="ssojwks" className="input" value={jwksUri} onChange={(e) => setJwksUri(e.target.value)} required />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" disabled={busy}>{busy ? "Saving…" : "Save connection"}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : data ? (
          <>
            {actionError && <div className="error-box">{actionError}</div>}
            {(() => {
              const enabledChecked = pendingEnabled ?? data.enabled;
              const enforcedChecked = pendingEnforced ?? data.enforced;
              return (
                <>
                  <p style={{ margin: "0 0 10px" }}>
                    <StatusBadge status={enabledChecked ? "active" : "deactivated"} />{" "}
                    <span className="muted" style={{ fontSize: 13 }}>
                      Domain <code>{data.domain}</code> · issuer <code>{data.issuer}</code>
                    </span>
                  </p>
                  {canEdit && (
                    <>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                        <input type="checkbox" checked={enabledChecked} onChange={(e) => void toggle("enabled", e.target.checked)} />
                        Enabled — users at this domain can sign in with SSO
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <input
                          type="checkbox"
                          checked={enforcedChecked}
                          disabled={!enabledChecked && !enforcedChecked}
                          onChange={(e) => void toggle("enforced", e.target.checked)}
                        />
                        Enforced — staff accounts can no longer sign in with a password (admins keep a break-glass path)
                      </label>
                    </>
                  )}
                </>
              );
            })()}
            {canEdit ? (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-secondary" onClick={startEditing}>Edit connection</button>
                  <button className="btn btn-secondary" onClick={() => void remove()}>Remove</button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ fontSize: 12.5 }}>Configuring SSO requires tenant admin permissions.</p>
            )}
          </>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              Not configured. Add an OIDC connection so this organization's users can sign in through their own identity
              provider (Okta, Azure AD, Google Workspace, or any standard OIDC issuer) instead of a portal password.
            </p>
            {canEdit && (
              <button className="btn" onClick={startEditing}>Configure SSO</button>
            )}
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}

// ============================================================
// Settings — admin_portal_settings.html
// ============================================================

export function SettingsPage() {
  const { role } = useSession();
  const canEdit = role !== "tenant_staff";

  const { data, loading, error, reload } = useApi(() => api.get<OrgSettings>("/settings"));

  const [companyName, setCompanyName] = useState("");
  const [minPinLength, setMinPinLength] = useState(4);
  const [requirePurgeWipe, setRequirePurgeWipe] = useState(false);
  // Tracks whether the form has been touched, so the fields can be
  // initialised from the fetch WITHOUT a later refetch (e.g. after
  // saving) silently overwriting an in-progress edit.
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  if (data && !dirty) {
    // Runs during render rather than an effect: React explicitly
    // supports adjusting state while rendering when it's derived from a
    // prop/fetch change (https://react.dev/learn/you-might-not-need-an-effect),
    // and doing it here means the first paint already shows the real
    // values instead of the defaults for one frame.
    if (companyName !== data.companyName) setCompanyName(data.companyName);
    if (minPinLength !== data.minPinLength) setMinPinLength(data.minPinLength);
    if (requirePurgeWipe !== data.requirePurgeWipe) setRequirePurgeWipe(data.requirePurgeWipe);
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      await api.patch("/settings", { companyName: companyName.trim(), minPinLength, requirePurgeWipe });
      setDirty(false);
      setSaved(true);
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Organisation configuration</p>

      <SecuritySection />
      <SsoSection />

      <AsyncBoundary loading={loading} error={error}>
        {data && (
          <form className="card" style={{ marginBottom: 16 }} onSubmit={save}>
            <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>Organisation</h2>

            {saveError && <div className="error-box">{saveError}</div>}

            <div className="field">
              <label htmlFor="sname">Organisation name</label>
              <input
                id="sname"
                className="input"
                value={companyName}
                disabled={!canEdit}
                onChange={(e) => {
                  setDirty(true);
                  setSaved(false);
                  setCompanyName(e.target.value);
                }}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="spin">Minimum profile PIN length</label>
              <select
                id="spin"
                className="input"
                value={minPinLength}
                disabled={!canEdit}
                onChange={(e) => {
                  setDirty(true);
                  setSaved(false);
                  setMinPinLength(Number(e.target.value));
                }}
              >
                {[4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n} digits
                  </option>
                ))}
              </select>
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Applies to new and edited profiles only — existing profile PINs are not changed. A 4-digit PIN is only
                10,000 combinations; raise this as the number of active profiles grows.
              </p>
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={requirePurgeWipe}
                  disabled={!canEdit}
                  onChange={(e) => {
                    setDirty(true);
                    setSaved(false);
                    setRequirePurgeWipe(e.target.checked);
                  }}
                />
                Require NIST 800-88 Purge for all data erasure
              </label>
              <p className="muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                {/* Real enforcement, not a preference — stated as such so
                    turning it on isn't mistaken for a default that can be
                    overridden per inspection. */}
                When on, a technician's Clear-standard wipe certificate is refused outright rather than recorded.
                Compliance-driven corporate customers typically require this; consumer resale usually does not.
              </p>
            </div>

            {canEdit ? (
              <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
                <button className="btn" disabled={busy || !dirty}>
                  {busy ? "Saving…" : "Save changes"}
                </button>
                {saved && <span className="muted" style={{ fontSize: 13 }}>Saved.</span>}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14, marginBottom: 0 }}>
                Changing organisation settings requires tenant admin permissions.
              </p>
            )}
          </form>
        )}
      </AsyncBoundary>

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
    </>
  );
}
