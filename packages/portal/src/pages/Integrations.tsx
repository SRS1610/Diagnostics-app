// src/pages/Integrations.tsx
//
// Management for the two things a B2B integration needs: API keys (a
// partner's server calling in, read-only by construction — see
// routes/publicApi.ts) and webhook endpoints (this platform calling out
// to a partner's server on report/dispute events). Admin-only, same
// tenant_staff restriction as Billing and Disputes.
//
// Both credentials — the full API key and a webhook's signing secret —
// are shown ON SCREEN exactly once, at creation, the same pattern as a
// newly-issued user password in Users.tsx: never stored in readable
// form, never retrievable again, so the one-time display is the only
// honest way to hand it over with no email provider integrated.

import { Fragment, useState } from "react";
import {
  api,
  type ApiKeyCreated,
  type ApiKeySummary,
  type WebhookDeliveryRecord,
  type WebhookEndpointCreated,
  type WebhookEndpointSummary,
} from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

// Event types are fetched from GET /webhooks/event-types at runtime so
// this list stays authoritative. Adding a new event on the API (see
// integrations.ts's WEBHOOK_EVENT_TYPES) surfaces here on the next load,
// without a portal build. A short static fallback keeps the UI usable if
// the fetch itself fails.
const FALLBACK_EVENT_TYPES = ["report.created", "dispute.received", "dispute.resolved"] as const;

export function IntegrationsPage() {
  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <p className="page-sub">API keys for partners reading this tenant's data, and webhooks for pushing events out</p>

      <ApiKeysSection />
      <WebhooksSection />
    </>
  );
}

// ============================================================
// API keys
// ============================================================

function ApiKeysSection() {
  const { role } = useSession();
  const canManage = role !== "tenant_staff";
  const { data, loading, error, reload } = useApi(() => api.get<ApiKeySummary[]>("/api-keys"));
  const keys = data ?? [];

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Shown once, then discarded. Never written anywhere more durable.
  const [issued, setIssued] = useState<ApiKeyCreated | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const res = await api.post<ApiKeyCreated>("/api-keys", { name: name.trim() });
      setIssued(res);
      setName("");
      setCreating(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create this key");
    }
  };

  const revoke = async (key: ApiKeySummary) => {
    if (!confirm(`Revoke "${key.name}"? Any integration using it stops working immediately.`)) return;
    setActionError(null);
    try {
      await api.delete(`/api-keys/${key.keyId}`);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not revoke this key");
    }
  };

  return (
    <>
      <div className="row-between" style={{ marginTop: 8 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>API keys</h2>
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            Read-only access to this tenant's reports at /v1 — there is no write route a key can reach
          </p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New key"}
          </button>
        )}
      </div>

      {issued && (
        <div className="card" style={{ marginTop: 14, borderColor: "var(--accent)" }}>
          <div className="row-between">
            <strong>API key "{issued.name}"</strong>
            <button className="btn btn-secondary btn-sm" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
          <code
            style={{
              display: "block",
              marginTop: 10,
              padding: 12,
              background: "var(--panel-soft)",
              borderRadius: 8,
              fontSize: 13,
              wordBreak: "break-all",
            }}
          >
            {issued.apiKey}
          </code>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            {issued.note}
          </p>
        </div>
      )}

      {creating && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={create}>
          {formError && <div className="error-box">{formError}</div>}
          <div className="field">
            <label htmlFor="keyname">Name</label>
            <input
              id="keyname"
              className="input"
              placeholder="e.g. Warehouse sync"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <button className="btn" disabled={!name.trim()}>
            Create key
          </button>
        </form>
      )}

      {actionError && (
        <div className="error-box" style={{ marginTop: 14 }}>
          {actionError}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 14 }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={keys.length === 0} emptyMessage="No API keys yet.">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Status</th>
                <th>Last used</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.keyId}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td className="muted">
                    <code>{k.keyPrefix}…</code>
                  </td>
                  <td>
                    <StatusBadge status={k.revokedAt ? "suspended" : "active"} />
                  </td>
                  <td className="muted">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}</td>
                  {canManage && (
                    <td style={{ textAlign: "right" }}>
                      {!k.revokedAt && (
                        <button className="btn btn-secondary btn-sm" onClick={() => void revoke(k)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  )}
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
// Webhooks
// ============================================================

function WebhooksSection() {
  const { role } = useSession();
  const canManage = role !== "tenant_staff";
  const { data, loading, error, reload } = useApi(() => api.get<WebhookEndpointSummary[]>("/webhooks"));
  const endpoints = data ?? [];
  const eventTypesQuery = useApi(() => api.get<string[]>("/webhooks/event-types"));
  const eventTypes = eventTypesQuery.data ?? [...FALLBACK_EVENT_TYPES];

  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [issued, setIssued] = useState<WebhookEndpointCreated | null>(null);
  const [expandedDeliveries, setExpandedDeliveries] = useState<string | null>(null);

  const toggleEvent = (evt: string) => {
    setSelectedEvents((prev) => (prev.includes(evt) ? prev.filter((e) => e !== evt) : [...prev, evt]));
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      const res = await api.post<WebhookEndpointCreated>("/webhooks", { url: url.trim(), eventTypes: selectedEvents });
      setIssued(res);
      setUrl("");
      setSelectedEvents([]);
      setCreating(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not register this endpoint");
    }
  };

  const toggleActive = async (endpoint: WebhookEndpointSummary) => {
    setActionError(null);
    try {
      await api.patch(`/webhooks/${endpoint.endpointId}`, { active: !endpoint.active });
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not update this endpoint");
    }
  };

  const remove = async (endpoint: WebhookEndpointSummary) => {
    if (!confirm(`Delete this webhook endpoint (${endpoint.url})? Delivery history for it is deleted too.`)) return;
    setActionError(null);
    try {
      await api.delete(`/webhooks/${endpoint.endpointId}`);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete this endpoint");
    }
  };

  return (
    <>
      <div className="row-between" style={{ marginTop: 30 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Webhooks</h2>
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            Pushes signed events to your server. A slow or unreachable endpoint never blocks or fails the action that
            triggered it — every attempt is recorded below regardless.
          </p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "New endpoint"}
          </button>
        )}
      </div>

      {issued && (
        <div className="card" style={{ marginTop: 14, borderColor: "var(--accent)" }}>
          <div className="row-between">
            <strong>Webhook registered for {issued.url}</strong>
            <button className="btn btn-secondary btn-sm" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
          <code
            style={{
              display: "block",
              marginTop: 10,
              padding: 12,
              background: "var(--panel-soft)",
              borderRadius: 8,
              fontSize: 13,
              wordBreak: "break-all",
            }}
          >
            {issued.secret}
          </code>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            {issued.note}
          </p>
        </div>
      )}

      {creating && (
        <form className="card" style={{ marginTop: 14 }} onSubmit={create}>
          {formError && <div className="error-box">{formError}</div>}
          <div className="field">
            <label htmlFor="whurl">Endpoint URL</label>
            <input
              id="whurl"
              className="input"
              type="url"
              placeholder="https://your-server.example/webhooks/diagnostics"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Event types</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
              {eventTypes.map((evt) => (
                <label key={evt} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 400 }}>
                  <input type="checkbox" checked={selectedEvents.includes(evt)} onChange={() => toggleEvent(evt)} />
                  <code style={{ fontSize: 13 }}>{evt}</code>
                </label>
              ))}
            </div>
          </div>
          <button className="btn" style={{ marginTop: 14 }} disabled={!url.trim() || selectedEvents.length === 0}>
            Register endpoint
          </button>
        </form>
      )}

      {actionError && (
        <div className="error-box" style={{ marginTop: 14 }}>
          {actionError}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 14 }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={endpoints.length === 0} emptyMessage="No webhook endpoints yet.">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th>Registered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <Fragment key={endpoint.endpointId}>
                  <tr>
                    <td style={{ fontWeight: 600, wordBreak: "break-all" }}>{endpoint.url}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{endpoint.eventTypes.join(", ")}</td>
                    <td>
                      <StatusBadge status={endpoint.active ? "active" : "deactivated"} />
                    </td>
                    <td className="muted">{formatDate(endpoint.createdAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          setExpandedDeliveries((cur) => (cur === endpoint.endpointId ? null : endpoint.endpointId))
                        }
                      >
                        {expandedDeliveries === endpoint.endpointId ? "Hide deliveries" : "Deliveries"}
                      </button>{" "}
                      {canManage && (
                        <>
                          <button className="btn btn-secondary btn-sm" onClick={() => void toggleActive(endpoint)}>
                            {endpoint.active ? "Deactivate" : "Reactivate"}
                          </button>{" "}
                          <button className="btn btn-secondary btn-sm" onClick={() => void remove(endpoint)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {expandedDeliveries === endpoint.endpointId && (
                    <tr>
                      <td colSpan={5} style={{ background: "var(--panel-soft)", padding: 0 }}>
                        <DeliveryHistory endpointId={endpoint.endpointId} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
    </>
  );
}

function DeliveryHistory({ endpointId }: { endpointId: string }) {
  const { data, loading, error } = useApi(
    () => api.get<WebhookDeliveryRecord[]>(`/webhooks/${endpointId}/deliveries`),
    [endpointId],
  );
  const deliveries = data ?? [];

  return (
    <div style={{ padding: 16 }}>
      <AsyncBoundary loading={loading} error={error} isEmpty={deliveries.length === 0} emptyMessage="No deliveries yet.">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Result</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.deliveryId}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDate(d.attemptedAt)}</td>
                <td>
                  <code style={{ fontSize: 12 }}>{d.eventType}</code>
                </td>
                <td>
                  <StatusBadge status={d.succeeded ? "pass" : "fail"} />
                  {d.statusCode != null && <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>HTTP {d.statusCode}</span>}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{d.error ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </AsyncBoundary>
    </div>
  );
}
