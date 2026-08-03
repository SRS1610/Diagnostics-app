// src/pages/Dashboard.tsx — admin_portal.html

import { Link } from "react-router-dom";
import { api, type Dispute, type Report } from "../api/client";
import { AsyncBoundary, StatusBadge, formatDate, useApi } from "../components/common";

export function DashboardPage() {
  const reports = useApi(() => api.get<Report[]>("/reports"));
  const disputes = useApi(() => api.get<Dispute[]>("/disputes?status=awaiting_review"));

  const rows = reports.data ?? [];
  const openDisputes = disputes.data ?? [];
  const flagged = rows.filter((r) => r.overallStatus !== "pass").length;

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Recent inspection activity</p>

      <div className="stat-grid">
        <div className="card">
          <div className="stat-num">{rows.length}</div>
          <div className="stat-label">Reports (latest 50)</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: "var(--success)" }}>{rows.length - flagged}</div>
          <div className="stat-label">Clean</div>
        </div>
        <div className="card">
          <div className="stat-num" style={{ color: "var(--warn)" }}>{flagged}</div>
          <div className="stat-label">Flagged</div>
        </div>
        <div className="card">
          {/* An open dispute holds the device and its payout, so it is a
              queue that needs action, not a passive statistic. */}
          <div className="stat-num" style={{ color: openDisputes.length ? "var(--fail)" : undefined }}>
            {openDisputes.length}
          </div>
          <div className="stat-label">Disputes awaiting review</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary
          loading={reports.loading}
          error={reports.error}
          isEmpty={rows.length === 0}
          emptyMessage="No inspection reports yet."
        >
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Serial</th>
                <th>Status</th>
                <th>Routing</th>
                <th>Inspected</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 15).map((report) => (
                <tr key={report.reportId}>
                  <td>
                    <Link to={`/reports/${report.reportId}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {report.deviceMake} {report.deviceModel}
                    </Link>
                  </td>
                  <td className="muted">{report.serialNumber}</td>
                  <td><StatusBadge status={report.overallStatus} /></td>
                  <td className="muted">{report.routing?.replace(/_/g, " ") ?? "—"}</td>
                  <td className="muted">{formatDate(report.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>
    </>
  );
}
