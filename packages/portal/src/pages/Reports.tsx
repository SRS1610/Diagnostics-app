// src/pages/Reports.tsx — admin_portal_detail.html
//
// Reports list and detail. The detail view groups results by the same
// physical-component taxonomy the PDF uses, and shows provenance per
// result: CLAUDE.md requires a human-entered value never to be presented
// identically to a machine-read one, and that rule applies to the portal
// as much as to the PDF.

import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, type DiagnosticResult, type Dispute, type Report, type ReportRevision, type WipeCertificate } from "../api/client";
import { AsyncBoundary, Pager, StatusBadge, formatDate, useApi, useDebounced } from "../components/common";
import { DownloadButton } from "./Compliance";
import { useSession } from "../auth/SessionContext";

// Where the consumer app is deployed. Deliberately a SEPARATE origin
// from this portal: a consumer page and a staff session must never share
// a bundle or a storage area.
const CONSUMER_BASE_URL = import.meta.env.VITE_CONSUMER_BASE_URL ?? "http://localhost:5174";

const SOURCE_LABEL: Record<string, string> = {
  api: "Measured",
  manual: "Entered by technician",
  ocr: "Read from photo",
};

const STATUS_FILTERS = [
  { label: "All", value: "" },
  { label: "Passed", value: "pass" },
  { label: "With warnings", value: "pass_with_warnings" },
  { label: "Failed", value: "fail" },
];

const PAGE_SIZE = 25;

export function ReportsPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);

  // Debounced so typing a serial does not fire a request per keystroke.
  const search = useDebounced(query.trim());

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (search) params.set("q", search);
  if (status) params.set("status", status);

  const { data, loading, error } = useApi(() => api.getPage<Report>(`/reports?${params}`), [search, status, offset]);
  const reports = data?.items ?? [];

  // Changing what is being searched has to send you back to the first
  // page: staying on offset 100 of a filter with three matches shows an
  // empty table that looks like "no results".
  const changeFilter = (next: () => void) => {
    setOffset(0);
    next();
  };

  return (
    <>
      <div className="row-between">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Every inspection for this tenant</p>
        </div>
        {/* Exports what is currently on screen, filters and all — an
            export that ignores the filters is a different question's
            answer. */}
        <DownloadButton
          path={`/reports/export.csv?${new URLSearchParams({
            ...(search ? { q: search } : {}),
            ...(status ? { status } : {}),
          })}`}
          filename="inspections.csv"
          label="Export CSV"
        />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field" style={{ marginBottom: 10 }}>
          <label htmlFor="rsearch">Search</label>
          <input
            id="rsearch"
            className="input"
            placeholder="Serial number, IMEI, make or model"
            value={query}
            onChange={(e) => changeFilter(() => setQuery(e.target.value))}
          />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              className={`btn btn-sm ${status === f.value ? "" : "btn-secondary"}`}
              onClick={() => changeFilter(() => setStatus(f.value))}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={loading}
          error={error}
          isEmpty={reports.length === 0}
          emptyMessage={
            search || status
              ? "No inspections match that search."
              : "No reports yet."
          }
        >
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

      {data && !error && (
        <Pager total={data.total} limit={data.limit} offset={data.offset} onOffset={setOffset} loading={loading} />
      )}
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

      <WipeCertificateCard reportId={report.reportId} />
      <RevisionsCard reportId={report.reportId} />
      <FileDisputeCard reportId={report.reportId} results={results} />

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
 * Read-only view of the certified wipe attestation. Recording one is a
 * TECHNICIAN action (POST comes from the mobile app during inspection),
 * so this card offers no create/edit affordance — only surfaces what
 * exists, with the outcome stated honestly (`passed: false` is a
 * legitimate certificate that gets its own visual treatment, not hidden).
 */
function WipeCertificateCard({ reportId }: { reportId: string }) {
  const { data, loading, error } = useApi(
    () => api.get<WipeCertificate>(`/reports/${reportId}/wipe-certificate`).catch((e) => {
      // 404 is the "no certificate yet" case — a legitimate state, not
      // an error worth showing in the AsyncBoundary. Anything else does
      // belong on screen.
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }),
    [reportId],
  );
  if (loading) return null;
  if (error) return <div className="card" style={{ marginBottom: 22 }}><div className="error-box">{error.message}</div></div>;
  if (!data) {
    return (
      <div className="card" style={{ marginBottom: 22 }}>
        <div className="stat-label" style={{ marginBottom: 6 }}>Certified data erasure</div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          No wipe certificate on file for this report. Recorded by the technician during inspection.
        </p>
      </div>
    );
  }
  const standardLabel = data.standard === "nist_800_88_purge" ? "NIST 800-88 Purge" : "NIST 800-88 Clear";
  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="row-between">
        <div>
          <div className="stat-label">Certified data erasure</div>
          <div style={{ marginTop: 6, fontSize: 14 }}>
            <strong>{standardLabel}</strong> · {formatDate(data.wipedAt)}
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            Certificate ID: <code>{data.certificateId}</code>
          </div>
        </div>
        <StatusBadge status={data.passed ? "pass" : "fail"} />
      </div>
      {!data.passed && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10, margin: 0 }}>
          A failed wipe is recorded on purpose — an unrecorded failed erasure is exactly the situation this attestation exists to avoid.
        </p>
      )}
    </div>
  );
}

/**
 * Revisions timeline. Read-only for the same reason as the wipe cert:
 * a revision is authored by the mobile app during a redo-then-generate
 * flow (CLAUDE.md's resolved decision #1), never from the portal.
 */
function RevisionsCard({ reportId }: { reportId: string }) {
  const { data, loading, error } = useApi(
    () => api.get<ReportRevision[]>(`/reports/${reportId}/revisions`),
    [reportId],
  );
  if (loading) return null;
  if (error) return <div className="card" style={{ marginBottom: 22 }}><div className="error-box">{error.message}</div></div>;
  if (!data || data.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="stat-label" style={{ marginBottom: 10 }}>Revisions</div>
      <table>
        <thead>
          <tr>
            <th>Revision</th>
            <th>Recorded</th>
            <th>Tests re-run</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.revisionId}>
              <td><strong>{reportId}-R{r.revisionNumber}</strong></td>
              <td className="muted">{formatDate(r.createdAt)}</td>
              <td className="muted">{r.testIdsRedone.length} — {r.testIdsRedone.join(", ")}</td>
              <td className="muted">{r.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * File a dispute against this report on the customer's behalf — CLAUDE.md's
 * dispute intake includes "staff can record a dispute a customer raised by
 * phone or email" (see disputes.ts POST route header). Filing puts the
 * report on hold; the Disputes page owns resolution.
 */
function FileDisputeCard({ reportId, results }: { reportId: string; results: DiagnosticResult[] }) {
  const { role } = useSession();
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState<string>("overall_grade");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  if (role === "tenant_staff") {
    // Filing a dispute is allowed for staff — no role check on the API
    // side — but keep the card visible only when there's actually
    // something to do; nothing hidden here. Show it.
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const dispute = await api.post<Dispute>("/disputes", {
        reportId,
        disputingItem: item,
        customerNote: note.trim(),
      });
      setMsg({ kind: "ok", text: `Dispute ${dispute.disputeId} filed. This report is on hold until resolved.` });
      setNote("");
      setOpen(false);
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof ApiError ? err.message : "Could not file the dispute." });
    } finally {
      setBusy(false);
    }
  };

  const testOptions = results
    .filter((r) => r.status === "fail" || r.status === "warning" || r.status === "pass")
    .map((r) => ({ id: r.testId, label: r.label }));

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="row-between">
        <div>
          <div className="stat-label">Dispute</div>
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0", maxWidth: 560 }}>
            Record a dispute a customer has raised outside the tracker (by phone or email). Filing puts the report on hold until an admin resolves it.
          </p>
        </div>
        {!open && !msg?.text.startsWith("Dispute") && (
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>File dispute</button>
        )}
      </div>

      {msg && (
        <div className={msg.kind === "ok" ? "info-box" : "error-box"} style={{ marginTop: 10 }}>
          {msg.text}
        </div>
      )}

      {open && (
        <form onSubmit={submit} style={{ marginTop: 12, display: "grid", gap: 10 }}>
          <div className="field">
            <label htmlFor="dspitem">What is being disputed?</label>
            <select id="dspitem" className="input" value={item} onChange={(e) => setItem(e.target.value)}>
              <option value="overall_grade">Overall grade</option>
              {testOptions.map((t) => (
                <option key={t.id} value={t.id}>Test result: {t.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dspnote">Customer's explanation</label>
            <textarea
              id="dspnote"
              className="input"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-sm" disabled={busy || !note.trim()}>
              {busy ? "Filing…" : "File dispute"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
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
