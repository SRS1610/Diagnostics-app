// src/pages/Devices.tsx — admin_portal_devices.html / device_history.html
//
// CLAUDE.md's Devices tab: group reports by PHYSICAL DEVICE rather than
// listing every report flat, "since a repeat inspection with a worsening
// grade (e.g. A → B → D) is a signal worth a human's attention".
//
// Grouping key is serialNumber, falling back to IMEI when a serial is
// missing — per CLAUDE.md, and because grouping on a blank key would
// silently merge unrelated devices into one history.
//
// The grouping happens client-side over the reports list because no
// grouped endpoint exists. That is a real limit, not a design choice:
// the list is capped at the API's most recent 50, so a device whose
// earlier inspections fall outside that window will under-report its
// history. Called out on the page rather than left to be discovered.

import { Link, useParams } from "react-router-dom";
import { api, type Report } from "../api/client";
import { AsyncBoundary, StatCard, StatusBadge, formatDate, useApi } from "../components/common";

function deviceKey(report: Report): string {
  return report.serialNumber?.trim() || report.imei;
}

interface DeviceGroup {
  key: string;
  make: string;
  model: string;
  reports: Report[];
}

function groupByDevice(reports: Report[]): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>();
  for (const report of reports) {
    const key = deviceKey(report);
    if (!map.has(key)) {
      map.set(key, { key, make: report.deviceMake, model: report.deviceModel, reports: [] });
    }
    map.get(key)!.reports.push(report);
  }
  for (const group of map.values()) {
    // Newest first — the history view timelines inspections in that order.
    group.reports.sort((a, b) => +new Date(b.generatedAt) - +new Date(a.generatedAt));
  }
  return [...map.values()].sort((a, b) => b.reports.length - a.reports.length);
}

export function DevicesPage() {
  const { data, loading, error } = useApi(() => api.get<Report[]>("/reports"));
  const groups = groupByDevice(data ?? []);
  const repeats = groups.filter((g) => g.reports.length > 1);

  return (
    <>
      <h1 className="page-title">Devices</h1>
      <p className="page-sub">Inspections grouped by physical device</p>

      <div className="stat-grid">
        <StatCard value={groups.length} label="Distinct devices" loading={loading} error={error} />
        {/* A repeat inspection is the signal a human is meant to act on,
            so a failed fetch showing "0" here would suppress exactly the
            thing this page exists to surface. */}
        <StatCard
          value={repeats.length}
          label="Seen more than once"
          loading={loading}
          error={error}
          color={repeats.length ? "var(--warn)" : undefined}
        />
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <AsyncBoundary loading={loading} error={error} isEmpty={groups.length === 0} emptyMessage="No devices inspected yet.">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>Serial / IMEI</th>
                <th>Inspections</th>
                <th>Latest outcome</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.key}>
                  <td>
                    <Link to={`/devices/${encodeURIComponent(group.key)}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {group.make} {group.model}
                    </Link>
                  </td>
                  <td className="muted">{group.key}</td>
                  <td>
                    {group.reports.length}
                    {group.reports.length > 1 && (
                      <span className="badge badge-warn" style={{ marginLeft: 8 }}>Repeat</span>
                    )}
                  </td>
                  <td><StatusBadge status={group.reports[0].overallStatus} /></td>
                  <td className="muted">{formatDate(group.reports[0].generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AsyncBoundary>
      </div>

      <p className="page-sub" style={{ marginTop: 16 }}>
        Grouping is computed from the 50 most recent reports. A device whose earlier inspections fall outside that
        window will show a shorter history than it actually has — a grouped endpoint would be needed to fix that
        properly.
      </p>
    </>
  );
}

export function DeviceHistoryPage() {
  const { deviceKey: key } = useParams<{ deviceKey: string }>();
  const { data, loading, error } = useApi(() => api.get<Report[]>("/reports"));

  const group = groupByDevice(data ?? []).find((g) => g.key === key);

  return (
    <AsyncBoundary loading={loading} error={error}>
      {!group ? (
        <div className="empty">No inspections found for this device.</div>
      ) : (
        <>
          <Link to="/devices" className="muted" style={{ fontSize: 13 }}>← All devices</Link>
          <h1 className="page-title" style={{ marginTop: 10 }}>{group.make} {group.model}</h1>
          <p className="page-sub">{group.key} · {group.reports.length} inspection(s), newest first</p>

          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <table>
              <thead>
                <tr>
                  <th>Inspected</th>
                  <th>Outcome</th>
                  <th>Change</th>
                  <th>Routing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {group.reports.map((report, i) => {
                  // Delta against the PREVIOUS inspection (the next
                  // element, since this list is newest-first). CLAUDE.md
                  // wants a worsening trend visible rather than requiring
                  // a human to diff two reports by eye.
                  const previous = group.reports[i + 1];
                  const delta = previous ? describeChange(previous.overallStatus, report.overallStatus) : null;
                  return (
                    <tr key={report.reportId}>
                      <td>{formatDate(report.generatedAt)}</td>
                      <td><StatusBadge status={report.overallStatus} /></td>
                      <td>
                        {delta ? (
                          <span className={`badge ${delta.worse ? "badge-fail" : "badge-neutral"}`}>{delta.label}</span>
                        ) : (
                          <span className="muted">First inspection</span>
                        )}
                      </td>
                      <td className="muted">{report.routing?.replace(/_/g, " ") ?? "—"}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link to={`/reports/${report.reportId}`} className="btn btn-secondary btn-sm">View</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AsyncBoundary>
  );
}

const RANK: Record<string, number> = { pass: 2, pass_with_warnings: 1, fail: 0 };

function describeChange(previous: string, current: string): { label: string; worse: boolean } | null {
  const before = RANK[previous] ?? 1;
  const after = RANK[current] ?? 1;
  if (after === before) return { label: "Unchanged", worse: false };
  // A device that got worse between visits is the signal CLAUDE.md
  // wants surfaced: new damage, inconsistent grading, or mishandling.
  return after < before ? { label: "Worsened", worse: true } : { label: "Improved", worse: false };
}
