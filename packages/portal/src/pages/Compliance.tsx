// src/pages/Compliance.tsx — admin_portal_compliance.html
//
// The R2v3/e-Stewards-style summary CLAUDE.md asks for: what happened to
// the devices this tenant processed, in a shape someone can hand to a
// corporate client's compliance team.
//
// The page is opinionated about one thing. Devices with no routing
// decision are shown as their own line, in the same table, rather than
// being filtered out of a tidier-looking chart. A summary claiming "100%
// resold" for a period where a third of devices were never routed is
// exactly the kind of number that gets forwarded, filed, and relied on.

import { useState } from "react";
import { api } from "../api/client";
import { AsyncBoundary, StatCard, useApi } from "../components/common";

interface ComplianceSummary {
  period: { from: string | null; to: string | null; generatedAt: string };
  totalInspections: number;
  routing: Array<{ decision: string; label: string; count: number; percentage: number }>;
  unrouted: { count: number; note: string };
  outcomes: { passed: number; failed: number; passedWithWarnings: number };
  dataErasure: { certificatesIssued: number; purgeStandard: number; clearStandard: number; note: string };
}

const ROUTE_COLOUR: Record<string, string> = {
  resale: "var(--success)",
  repair: "var(--accent)",
  parts_harvest: "var(--warn)",
  recycle: "var(--accent)",
  hold_ineligible: "var(--fail)",
};

export function CompliancePage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = new URLSearchParams();
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  const query = params.toString();

  const { data, loading, error } = useApi(
    () => api.get<ComplianceSummary>(`/compliance/summary${query ? `?${query}` : ""}`),
    [query],
  );

  return (
    <>
      <h1 className="page-title">Compliance</h1>
      <p className="page-sub">
        What happened to the devices this tenant processed — the reporting corporate trade-in clients ask for
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="cfrom">From</label>
            <input id="cfrom" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="cto">To</label>
            <input id="cto" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(from || to) && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </button>
          )}
          <div style={{ flex: 1 }} />
          <DownloadButton
            path={`/compliance/summary.csv${query ? `?${query}` : ""}`}
            filename="compliance-summary.csv"
            label="Export summary (CSV)"
          />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          {/* An export headed only "Compliance Summary" invites someone
              to file it as covering the year when it covers a fortnight. */}
          With no dates set this covers all inspections ever recorded. The exported file always states the period it
          was computed over.
        </p>
      </div>

      <AsyncBoundary loading={loading} error={error}>
        {data && (
          <>
            <div className="stat-grid">
              <StatCard value={data.totalInspections} label="Inspections in period" />
              <StatCard value={data.outcomes.passed} label="Passed" color="var(--success)" />
              <StatCard value={data.outcomes.failed} label="Failed" color="var(--fail)" />
              <StatCard
                value={data.dataErasure.certificatesIssued}
                label="Erasure certificates"
              />
            </div>

            <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Device routing</h2>
            <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 20 }}>
              <table>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Devices</th>
                    <th>Share</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.routing.map((row) => (
                    <tr key={row.decision}>
                      <td style={{ fontWeight: 600 }}>{row.label}</td>
                      <td>{row.count}</td>
                      <td className="muted">{row.percentage}%</td>
                      <td style={{ width: "40%" }}>
                        {/* A bar rather than a chart library: one
                            dependency fewer, and this is a proportion,
                            not a trend. */}
                        <div style={{ background: "var(--panel-soft)", borderRadius: 4, height: 8 }}>
                          <div
                            style={{
                              width: `${row.percentage}%`,
                              background: ROUTE_COLOUR[row.decision] ?? "var(--accent)",
                              height: 8,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="muted">No routing decision recorded</td>
                    <td className="muted">{data.unrouted.count}</td>
                    <td className="muted">—</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>

            <p className="page-sub">{data.unrouted.note}</p>

            <h2 style={{ fontSize: 15, margin: "20px 0 10px" }}>Certified data erasure</h2>
            <div className="card">
              <div className="field-row" style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                <span className="muted">NIST 800-88 Purge</span>
                <strong>{data.dataErasure.purgeStandard}</strong>
              </div>
              <div className="field-row" style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                <span className="muted">NIST 800-88 Clear</span>
                <strong>{data.dataErasure.clearStandard}</strong>
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
                {data.dataErasure.note}
              </p>
            </div>
          </>
        )}
      </AsyncBoundary>
    </>
  );
}

/**
 * Downloads an authenticated file.
 *
 * A plain <a href> cannot carry the Authorization header, so the file is
 * fetched through the normal API client and handed to the browser as a
 * blob. The alternative — putting the session token in a query string —
 * would write a live credential into browser history and every proxy log
 * between here and the API.
 */
export function DownloadButton({
  path,
  filename,
  label,
}: {
  path: string;
  filename: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const blob = await api.getBlob(path);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      // Released on the next tick — revoking synchronously can cancel
      // the download in some browsers before it has started.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void download()}>
        {busy ? "Preparing…" : label}
      </button>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
