// src/pages/Dashboard.tsx — admin_portal.html

import { Link } from "react-router-dom";
import { api, type Dispute, type Report } from "../api/client";
import { AsyncBoundary, StatCard, StatusBadge, formatDate, useApi } from "../components/common";

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

      {/* Each tile carries its own fetch's state. When a request fails
          these read "—", not "0" — see StatCard. */}
      <div className="stat-grid">
        <StatCard value={rows.length} label="Reports (latest 50)" loading={reports.loading} error={reports.error} />
        <StatCard
          value={rows.length - flagged}
          label="Clean"
          loading={reports.loading}
          error={reports.error}
          color="var(--success)"
        />
        <StatCard value={flagged} label="Flagged" loading={reports.loading} error={reports.error} color="var(--warn)" />
        {/* An open dispute holds the device and its payout, so it is a
            queue that needs action, not a passive statistic — which is
            exactly why a failed fetch must not render here as zero. */}
        <StatCard
          value={openDisputes.length}
          label="Disputes awaiting review"
          loading={disputes.loading}
          error={disputes.error}
          color={openDisputes.length ? "var(--fail)" : undefined}
        />
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
