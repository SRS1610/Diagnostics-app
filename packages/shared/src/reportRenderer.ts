// reportRenderer.ts
// Renders an AuditReport into a two-part PDF: condensed one-page summary
// followed by a full per-test detail appendix. Uses react-native-html-to-pdf.
//
// See CLAUDE.md "PDF report rendering" section for how this fits into the
// overall app.

import RNHTMLtoPDF from "react-native-html-to-pdf";
import QRCode from "qrcode";
import { AuditReport, DiagnosticResult } from "./types";
import { DataWipeCertificate } from "./dataWipe";
import { RoutingDecision, ROUTING_LABELS } from "./deviceRouting";

const ROUTING_BADGE_CLASS: Record<RoutingDecision, string> = {
  resale: "badge-pass",
  repair: "badge-warn",
  parts_harvest: "badge-warn",
  recycle: "badge-warn",
  hold_ineligible: "badge-fail",
};

const DOT_CLASS: Record<DiagnosticResult["status"], string> = {
  pass: "dot-pass",
  fail: "dot-fail",
  warning: "dot-warn",
  skipped: "dot-skip",
};

// Maps each testId to the physical-component category it belongs to, for
// grouping in the report. Extend this alongside REMOTE_TEST_PLAN_REGISTRY
// and any new diagnostic tests as they're added — this is the single
// source of truth for report layout grouping (separate from the backend
// key registry, which is about submission keys, not report structure).
const COMPONENT_MAP: Record<string, string> = {
  lcd: "Display & Touchscreen",
  digitizer: "Display & Touchscreen",
  multitouch: "Display & Touchscreen",
  brightness: "Display & Touchscreen",
  home_button: "Buttons & Physical Controls",
  power_button: "Buttons & Physical Controls",
  volume_up: "Buttons & Physical Controls",
  volume_down: "Buttons & Physical Controls",
  camera_front: "Camera System",
  camera_back: "Camera System",
  flashlight: "Camera System",
  loud_speaker: "Audio — Speakers & Microphones",
  microphone: "Audio — Speakers & Microphones",
  earpiece: "Audio — Speakers & Microphones",
  speaker: "Audio — Speakers & Microphones",
  headset_port: "Ports & Connectors",
  sd_card: "Ports & Connectors",
  light_sensor: "Sensors",
  proximity_sensor: "Sensors",
  accelerometer: "Sensors",
  gyroscope: "Sensors",
  fingerprint_sensor: "Sensors",
  battery_health: "Battery & Charging",
  battery_charge_level: "Battery & Charging",
  wireless_charging: "Battery & Charging",
  charging_port: "Battery & Charging",
  wifi: "Wireless Radios",
  bluetooth: "Wireless Radios",
  gps: "Wireless Radios",
  nfc: "Wireless Radios",
  sim_reader: "Cellular & SIM",
  network_connectivity: "Cellular & SIM",
  country_of_origin: "Housing & Cosmetics",
  device_color: "Housing & Cosmetics",
  cosmetics: "Housing & Cosmetics",
  liquid_damage: "Housing & Cosmetics",
  glass_condition: "Housing & Cosmetics",
  cosmetic_grading: "Housing & Cosmetics",
  // ... extend as new testIds are added
};

function groupByComponent(results: DiagnosticResult[]): Map<string, DiagnosticResult[]> {
  const groups = new Map<string, DiagnosticResult[]>();
  for (const r of results) {
    const component = COMPONENT_MAP[r.testId] ?? "Uncategorized";
    if (!groups.has(component)) groups.set(component, []);
    groups.get(component)!.push(r);
  }
  return groups;
}

function renderDotGrid(results: DiagnosticResult[]): string {
  return results
    .map((r) => `<span class="mini-dot ${DOT_CLASS[r.status]}" title="${r.label}"></span>`)
    .join("");
}

function renderDetailRows(results: DiagnosticResult[]): string {
  return results
    .map(
      (r) => `<tr>
      <td>${r.label}</td>
      <td><span class="status-dot ${DOT_CLASS[r.status]}"></span>${r.status}</td>
      <td>${r.value ?? ""}</td>
      <td><span class="source-tag">${r.source}</span></td>
      <td>${r.notes ?? ""}</td>
    </tr>`
    )
    .join("\n");
}

export async function renderAuditReportPdf(
  report: AuditReport,
  options: {
    routing?: RoutingDecision;
    wipeCertificate?: DataWipeCertificate;
    publicReportBaseUrl?: string; // e.g. "https://verify.yourcompany.com/r" — for the QR code
  } = {}
): Promise<string> {
  const groups = groupByComponent(report.results);
  const passed = report.results.filter((r) => r.status === "pass").length;
  const total = report.results.length;
  const flagged = report.results.filter((r) => r.status === "fail" || r.status === "warning");

  const matrixRows = Array.from(groups.entries())
    .map(([component, results]) => {
      const componentPassed = results.filter((r) => r.status === "pass").length;
      return `<tr>
      <td class="cat-name">${component}</td>
      <td class="dot-grid">${renderDotGrid(results)}</td>
      <td class="count">${componentPassed}/${results.length}</td>
    </tr>`;
    })
    .join("\n");

  const flaggedRows = flagged
    .map(
      (r) => `<tr>
      <td>${COMPONENT_MAP[r.testId] ?? "Uncategorized"}</td>
      <td>${r.label}</td>
      <td><span class="status-dot ${DOT_CLASS[r.status]}"></span>${r.status}</td>
      <td>${r.notes ?? ""}</td>
    </tr>`
    )
    .join("\n");

  const appendixSections = Array.from(groups.entries())
    .map(
      ([component, results]) => `
    <div class="section-title">${component}</div>
    <table>
      <tr><th>Test</th><th>Status</th><th>Value</th><th>Source</th><th>Notes</th></tr>
      ${renderDetailRows(results)}
    </table>`
    )
    .join("\n");

  // QR code linking to the public-safe report summary. See CLAUDE.md
  // "QR-linked audit certificate" for what the public endpoint may show —
  // resolved decision: device identity + grade + pass/flag summary ONLY,
  // never technician notes, redo history, or raw cosmetic photos.
  let qrCodeDataUri = "";
  if (options.publicReportBaseUrl) {
    qrCodeDataUri = await QRCode.toDataURL(`${options.publicReportBaseUrl}/${report.reportId}`, {
      width: 200,
      margin: 1,
    });
  }

  const html = buildHtmlTemplate({
    report,
    passed,
    total,
    flaggedCount: flagged.length,
    matrixRows,
    flaggedRows,
    appendixSections,
    routing: options.routing,
    wipeCertificate: options.wipeCertificate,
    qrCodeDataUri,
  });

  const { filePath } = await RNHTMLtoPDF.convert({
    html,
    fileName: `audit-report-${report.reportId}`,
    base64: false,
  });

  return filePath;
}

function buildHtmlTemplate(params: {
  report: AuditReport;
  passed: number;
  total: number;
  flaggedCount: number;
  matrixRows: string;
  flaggedRows: string;
  appendixSections: string;
  routing?: RoutingDecision;
  wipeCertificate?: DataWipeCertificate;
  qrCodeDataUri: string;
}): string {
  const { report, passed, total, flaggedCount, matrixRows, flaggedRows, appendixSections, routing, wipeCertificate, qrCodeDataUri } = params;
  const overallClass =
    report.overallStatus === "fail" ? "badge-fail" : report.overallStatus === "pass" ? "badge-pass" : "badge-warn";
  const overallLabel = report.overallStatus.replace(/_/g, " ").toUpperCase();

  const routingBadge = routing
    ? `<span class="overall-badge ${ROUTING_BADGE_CLASS[routing]}" style="margin-left:6px;">${ROUTING_LABELS[routing]}</span>`
    : "";

  const wipeCertSection = wipeCertificate
    ? `
  <div class="section-title">Certified Data Erasure</div>
  <div class="device-block" style="margin-bottom:14px;">
    <div class="device-row"><span class="device-label">Certificate ID</span><span>${wipeCertificate.certificateId}</span></div>
    <div class="device-row"><span class="device-label">Standard</span><span>${wipeCertificate.standard === "nist_800_88_purge" ? "NIST 800-88 Purge" : "NIST 800-88 Clear"}</span></div>
    <div class="device-row"><span class="device-label">Result</span><span><span class="overall-badge ${wipeCertificate.passed ? "badge-pass" : "badge-fail"}">${wipeCertificate.passed ? "ERASURE VERIFIED" : "ERASURE FAILED"}</span></span></div>
    <div class="device-row"><span class="device-label">Wiped At</span><span>${wipeCertificate.wipedAt}</span></div>
    <div class="device-row"><span class="device-label">Verified By</span><span>${wipeCertificate.verifiedByTechnicianId}</span></div>
  </div>`
    : "";

  const qrSection = qrCodeDataUri
    ? `<img src="${qrCodeDataUri}" style="width:64px; height:64px; flex-shrink:0;" />`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  /* Design tokens match the app UI (see ui_journey_premium.html):
     neutral greys, single muted blue accent, pill-shaped badges,
     hairline borders, Inter/system-font family. */
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1d1d1f; margin: 0; font-size: 10px; -webkit-font-smoothing: antialiased; }
  .header { border-bottom: 1px solid #e5e5ea; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-start; }
  .header h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.01em; margin: 0 0 4px 0; }
  .header .meta { color: #6e6e73; font-size: 9.5px; font-weight: 500; }
  .overall-badge { display: inline-block; padding: 4px 12px; border-radius: 100px; font-weight: 600; font-size: 9.5px; margin-top: 8px; letter-spacing: 0.01em; }
  .badge-pass { background: #e8f9ec; color: #1c8a3a; }
  .badge-fail { background: #ffe9e8; color: #c8281f; }
  .badge-warn { background: #fff4e5; color: #b3690b; }
  .top-row { display: flex; gap: 12px; margin-bottom: 14px; }
  .device-block { background: #f5f5f7; border: 1px solid #e5e5ea; border-radius: 12px; padding: 10px 14px; flex: 1.3; }
  .device-row { display: flex; justify-content: space-between; padding: 2px 0; }
  .device-label { color: #6e6e73; font-weight: 500; }
  .provenance { font-size: 8px; color: #a1a1a6; font-weight: 500; }
  .stat-block { background: #f5f5f7; border: 1px solid #e5e5ea; border-radius: 12px; padding: 10px 14px; flex: 1; display: flex; flex-direction: column; justify-content: center; text-align: center; }
  .stat-num { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
  .stat-label { font-size: 8.5px; color: #6e6e73; font-weight: 500; }
  .section-title { font-size: 10.5px; font-weight: 700; letter-spacing: -0.005em; color: #1d1d1f; margin: 14px 0 6px 0; padding-bottom: 4px; border-bottom: 1px solid #e5e5ea; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8.5px; color: #a1a1a6; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid #e5e5ea; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f0f2; font-size: 9px; vertical-align: middle; font-weight: 400; }
  .cat-name { width: 26%; font-weight: 600; }
  .dot-grid { white-space: nowrap; }
  .count { width: 10%; text-align: right; color: #6e6e73; font-size: 8.5px; font-weight: 500; }
  .mini-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 2px; }
  .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
  .dot-pass { background: #34c759; }
  .dot-fail { background: #ff3b30; }
  .dot-warn { background: #ff9f0a; }
  .dot-skip { background: #c7c7cc; }
  .source-tag { font-size: 8px; color: #6e6e73; background: #f0f0f2; font-weight: 500; padding: 1px 6px; border-radius: 100px; }
  .footer { margin-top: 14px; padding-top: 8px; border-top: 1px solid #e5e5ea; font-size: 7.5px; color: #a1a1a6; line-height: 1.5; font-weight: 400; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Device Diagnostic Audit Report</h1>
      <div class="meta">Report ID: ${report.reportId} | Generated: ${report.generatedAt} | Technician: ${report.technicianId ?? "—"}</div>
      <span class="overall-badge ${overallClass}">${overallLabel}</span>${routingBadge}
    </div>
    ${qrSection}
  </div>

  <div class="top-row">
    <div class="device-block">
      <div class="device-row"><span class="device-label">Make / Model</span><span>${report.device.make} ${report.device.model}</span></div>
      <div class="device-row"><span class="device-label">Serial Number</span><span>${report.device.serialNumber} <span class="provenance">(${report.device.captureSource})</span></span></div>
      <div class="device-row"><span class="device-label">IMEI</span><span>${report.device.imei} <span class="provenance">(${report.device.captureSource})</span></span></div>
      ${report.device.imei2 ? `<div class="device-row"><span class="device-label">IMEI 2</span><span>${report.device.imei2}</span></div>` : ""}
    </div>
    <div class="stat-block"><div class="stat-num">${passed}/${total}</div><div class="stat-label">Tests passed</div></div>
    <div class="stat-block"><div class="stat-num">${flaggedCount}</div><div class="stat-label">Flagged for review</div></div>
  </div>
  ${wipeCertSection}

  <div class="section-title">Summary by Component</div>
  <table><tr><th>Component</th><th>Result grid</th><th>Pass</th></tr>${matrixRows}</table>

  <div class="section-title">Flagged Items — Requires Review</div>
  <table><tr><th>Component</th><th>Test</th><th>Status</th><th>Notes</th></tr>${flaggedRows}</table>

  <div style="page-break-before: always;"></div>
  <div style="font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 6px;">Appendix — Full Per-Test Detail</div>
  ${appendixSections}

  <div class="footer">
    Green = pass, red = fail, yellow = warning, grey = skipped/not applicable.<br>
    Storage read/write and camera frame checks verify basic function only. iOS battery health is self-reported, not independently verified. Serial/IMEI provenance shown above.
    ${qrCodeDataUri ? "<br>Scan the QR code above for a shareable public summary of this report (device identity, grade, and pass/flag counts only)." : ""}
  </div>
</body>
</html>`;
}
