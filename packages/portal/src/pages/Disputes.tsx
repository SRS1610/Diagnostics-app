// src/pages/Disputes.tsx — admin_portal_disputes.html
//
// CLAUDE.md listed the Uphold/Adjust actions as "HTML mockup buttons,
// not wired functions". They are wired now — and resolution requires
// written reasoning, because CLAUDE.md wants resolved disputes to "show
// the outcome and reasoning for audit purposes", and because an
// admin-corrected grade is the training signal datasetCollection.ts is
// meant to learn from. A resolution with no stated reason is useless for
// both purposes.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Dispute } from "../api/client";
import { useSession } from "../auth/SessionContext";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

export function DisputesPage() {
  // The API refuses resolution from tenant_staff (403). Mirroring that
  // here means a staff user sees the queue read-only rather than being
  // offered a button that always fails.
  const { role } = useSession();
  const canResolve = role !== "tenant_staff";
  // Fetched as two lists rather than one split client-side. A single
  // fetch meant the open queue and the resolved history shared one page
  // and one ordering — so on a busy tenant a dispute resolved today fell
  // off the end of a list ordered oldest-first, and looked as though it
  // had never been resolved.
  const openQuery = useApi(() => api.getPage<Dispute>("/disputes?status=awaiting_review&limit=50"));
  const resolvedQuery = useApi(() => api.getPage<Dispute>("/disputes?order=newest&limit=25"));

  const open = openQuery.data?.items ?? [];
  // The resolved endpoint returns every status, so the open ones are
  // filtered out here rather than fetched twice.
  const resolved = (resolvedQuery.data?.items ?? []).filter((d) => d.status !== "awaiting_review");

  const loading = openQuery.loading;
  const error = openQuery.error;
  const reload = () => {
    void openQuery.reload();
    void resolvedQuery.reload();
  };

  return (
    <>
      <h1 className="page-title">Disputes</h1>
      <p className="page-sub">
        While a dispute is open the device and its offer stay on hold — quoting, listing and payout are all blocked
        until it is resolved.
      </p>

      <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Needs action ({open.length})</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 26 }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={open.length === 0} emptyMessage="Nothing awaiting review.">
          <table>
            <tbody>
              {open.map((d) => (
                <OpenDisputeRow key={d.disputeId} dispute={d} canResolve={canResolve} onResolved={reload} />
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Resolved</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {resolvedQuery.error ? (
          <div className="error-box">{resolvedQuery.error}</div>
        ) : resolved.length === 0 ? (
          <div className="empty">{resolvedQuery.loading ? "Loading…" : "No resolved disputes."}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Report</th>
                <th>Disputed</th>
                <th>Outcome</th>
                <th>Reasoning</th>
                <th>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((d) => (
                <tr key={d.disputeId}>
                  <td>
                    <Link to={`/reports/${d.reportId}`} style={{ color: "var(--accent)" }}>{d.reportId.slice(0, 10)}…</Link>
                  </td>
                  <td>{d.disputingItem}</td>
                  <td><StatusBadge status={d.status} /></td>
                  <td className="muted">{d.resolutionNotes ?? "—"}</td>
                  <td className="muted">{d.resolvedAt ? formatDate(d.resolvedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function OpenDisputeRow({
  dispute,
  canResolve,
  onResolved,
}: {
  dispute: Dispute;
  canResolve: boolean;
  onResolved: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (outcome: "uphold" | "adjust") => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/disputes/${dispute.disputeId}/resolve`, { outcome, resolutionNotes: notes.trim() });
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve dispute");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td colSpan={5} style={{ padding: 18 }}>
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div>
            <strong>{dispute.disputingItem}</strong>
            <span className="muted" style={{ marginLeft: 10, fontSize: 12 }}>
              filed {formatDate(dispute.submittedAt)}
            </span>
          </div>
          <Link to={`/reports/${dispute.reportId}`} className="btn btn-secondary btn-sm">View report</Link>
        </div>

        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>“{dispute.customerNote}”</p>

        {error && <div className="error-box">{error}</div>}

        {canResolve ? (
          <>
            <textarea
              className="input"
              rows={2}
              placeholder="Reasoning for this decision (required — recorded for audit)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              {/* Both actions require reasoning; neither is available until
                  it's written, rather than failing at the API and bouncing
                  the admin back. */}
              <button className="btn btn-sm" disabled={busy || !notes.trim()} onClick={() => void resolve("uphold")}>
                Uphold grade
              </button>
              <button className="btn btn-sm btn-danger" disabled={busy || !notes.trim()} onClick={() => void resolve("adjust")}>
                Adjust grade
              </button>
            </div>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Resolving a dispute requires tenant admin permissions.
          </p>
        )}
      </td>
    </tr>
  );
}
