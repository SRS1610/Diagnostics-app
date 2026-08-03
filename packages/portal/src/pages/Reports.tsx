// src/pages/Reports.tsx — admin_portal_detail.html
//
// Reports list and detail. The detail view groups results by the same
// physical-component taxonomy the PDF uses, and shows provenance per
// result: CLAUDE.md requires a human-entered value never to be presented
// identically to a machine-read one, and that rule applies to the portal
// as much as to the PDF.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type DiagnosticResult, type Report } from "../api/client";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

// Where the consumer app is deployed. Deliberately a SEPARATE origin
// from this portal: a consumer page and a staff session must never share
// a bundle or a storage area.
const CONSUMER_BASE_URL = import.meta.env.VITE_CONSUMER_BASE_URL ?? "http://localhost:5174";

const SOURCE_LABEL: Record<string, string> = {
  api: "Measured",
  manual: "Entered by technician",
  ocr: "Read from photo",
};

export function ReportsPage() {
  const { data, loading, error } = useApi(() => api.get<Report[]>("/reports"));
  const reports = data ?? [];

  return (
    <>
      <h1 className="page-title">Reports</h1>
      <p className="page-sub">Every inspection for this tenant</p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={reports.length === 0} emptyMessage="No reports yet.">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Serial</th>
                <th>IMEI</th>
                <th>Status</th>
                <th>Inspected</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.reportId}>
                  <td>
                    <Link to={`/reports/${r.reportId}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {r.deviceMake} {r.deviceModel}
                    </Link>
                  </td>
                  <td className="muted">{r.serialNumber}</td>
                  <td className="muted">{r.imei}</td>
                  <td><StatusBadge status={r.overallStatus} /></td>
                  <td className="muted">{formatDate(r.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
    </>
  );
}

export function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { data, loading, error } = useApi(() => api.get<Report>(`/reports/${reportId}`), [reportId]);

  return (
    <AsyncBoundary loading={loading} error={error}>
      {data && <ReportDetail report={data} />}
    </AsyncBoundary>
  );
}

function ReportDetail({ report }: { report: Report }) {
  const results: DiagnosticResult[] = report.results ?? [];
  const flagged = results.filter((r) => r.status === "fail" || r.status === "warning");

  return (
    <>
      <Link to="/reports" className="muted" style={{ fontSize: 13 }}>
        ← All reports
      </Link>
      <h1 className="page-title" style={{ marginTop: 10 }}>
        {report.deviceMake} {report.deviceModel}
      </h1>
      <p className="page-sub">
        {report.reportId} · inspected {formatDate(report.generatedAt)}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 22 }}>
        <div className="card">
          <div className="stat-label" style={{ marginBottom: 8 }}>Device identity</div>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>Serial <strong>{report.serialNumber}</strong></div>
            <div>IMEI <strong>{report.imei}</strong></div>
            {/* Provenance of the identity capture itself — barcode, OCR
                or typed — because an OCR'd IMEI carries different
                confidence than a scanned one. */}
            <div className="muted">Captured via {report.captureSource}</div>
          </div>
        </div>
        <div className="card">
          <div className="stat-label" style={{ marginBottom: 8 }}>Outcome</div>
          <StatusBadge status={report.overallStatus} />
          <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            {results.length} checks · {flagged.length} flagged
          </div>
        </div>
        <div className="card">
          <div className="stat-label" style={{ marginBottom: 8 }}>Routing</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{report.routing?.replace(/_/g, " ") ?? "Not routed"}</div>
        </div>
      </div>

      <ConsumerLink consumerToken={report.consumerToken} />

      {flagged.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Flagged items</h2>
          <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 22 }}>
            <table>
              <tbody>
                {flagged.map((r) => (
                  <tr key={r.testId}>
                    <td style={{ fontWeight: 600 }}>{r.label}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="muted">{r.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>All results</h2>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {results.length === 0 ? (
          <div className="empty">This report has no recorded results.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Value</th>
                <th>Source</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.testId}>
                  <td>{r.label}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="muted">{r.value ?? "—"}</td>
                  {/* Never render a manual value as though it were
                      measured — provenance is its own column. */}
                  <td className="muted">{SOURCE_LABEL[r.source] ?? r.source}</td>
                  <td className="muted">{r.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * The customer's tracker link.
 *
 * This is a capability: whoever holds it can see this device's summary
 * and act on its offer. So it is shown deliberately rather than printed
 * across the page — staff need to hand it to one customer, and a link
 * left open on a shared terminal is the way it gets handed to someone
 * else. Hidden by default, revealed on request, with the consequence
 * stated next to the button rather than left to be inferred.
 */
function ConsumerLink({ consumerToken }: { consumerToken?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!consumerToken) return null;
  const url = `${CONSUMER_BASE_URL}/track/${consumerToken}`;

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="row-between">
        <div>
          <div className="stat-label">Customer tracker link</div>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", maxWidth: 560 }}>
            Anyone with this link can see this device's summary and accept, decline or dispute its offer — no sign-in.
            Send it to the customer only.
          </p>
        </div>
        {!revealed && (
          <button className="btn btn-secondary btn-sm" onClick={() => setRevealed(true)}>Show link</button>
        )}
      </div>

      {revealed && (
        <>
          <code
            style={{
              display: "block",
              marginTop: 12,
              padding: 12,
              background: "var(--panel-soft)",
              borderRadius: 8,
              fontSize: 12.5,
              wordBreak: "break-all",
            }}
          >
            {url}
          </code>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(url).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setRevealed(false); setCopied(false); }}>
              Hide
            </button>
          </div>
        </>
      )}
    </div>
  );
}
