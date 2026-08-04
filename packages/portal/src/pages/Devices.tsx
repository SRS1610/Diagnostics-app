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
// grouped endpoint exists. That is still a real limit, but a smaller one
// than it was: the page now pulls the API's maximum window (200) and
// exposes the same search the Reports page uses, so looking up a
// specific device by serial works regardless of how far back it sits.
// A tenant with more than 200 inspections still cannot see every device
// at once, and the page says so rather than quietly implying it can.

import { Link, useParams } from "react-router-dom";
import { api, type Report } from "../api/client";
import { useState } from "react";
import { AsyncBoundary, Pager, StatCard, StatusBadge, formatDate, useApi, useDebounced } from "../components/common";

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

const WINDOW = 200; // the API's maximum page

export function DevicesPage() {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams({ limit: String(WINDOW) });
  if (search) params.set("q", search);

  const { data, loading, error } = useApi(() => api.getPage<Report>(`/reports?${params}`), [search]);
  const allGroups = groupByDevice(data?.items ?? []);
  const repeats = allGroups.filter((g) => g.reports.length > 1);

  // Grouping collapses many reports into fewer devices, so the device
  // list is paged client-side over the groups rather than reusing the
  // API's report-level offsets, which would not line up.
  const groups = allGroups.slice(offset, offset + 25);
  const truncated = (data?.total ?? 0) > WINDOW;

  return (
    <>
      <h1 className="page-title">Devices</h1>
      <p className="page-sub">Inspections grouped by physical device</p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="dsearch">Find a device</label>
          <input
            id="dsearch"
            className="input"
            placeholder="Serial number, IMEI, make or model"
            value={query}
            onChange={(e) => {
              setOffset(0);
              setQuery(e.target.value);
            }}
          />
        </div>
      </div>

      <div className="stat-grid">
        <StatCard value={allGroups.length} label="Distinct devices" loading={loading} error={error} />
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

      <Pager total={allGroups.length} limit={25} offset={offset} onOffset={setOffset} loading={loading} />

      {truncated && (
        <p className="page-sub" style={{ marginTop: 16 }}>
          Grouping is computed from the {WINDOW} most recent inspections, and this tenant has {data?.total}. A device
          whose earlier inspections fall outside that window will show a shorter history than it actually has — search
          by serial or IMEI to find it reliably. Fixing this properly needs a grouped endpoint on the API.
        </p>
      )}
    </>
  );
}

export function DeviceHistoryPage() {
  const { deviceKey: key } = useParams<{ deviceKey: string }>();
  // The same wide window as the list, and narrowed by the device's own
  // identifier so its history is found even in a busy tenant — a plain
  // most-recent-50 fetch would show an empty history for any device not
  // inspected recently.
  const { data, loading, error } = useApi(
    () => api.getPage<Report>(`/reports?limit=200&q=${encodeURIComponent(key ?? "")}`),
    [key],
  );

  const group = groupByDevice(data?.items ?? []).find((g) => g.key === key);

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
