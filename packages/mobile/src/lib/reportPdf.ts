// src/lib/reportPdf.ts
//
// Generates the audit PDF by calling packages/shared's reportRenderer —
// the canonical render path per CLAUDE.md — rather than reimplementing
// its layout here. metro.config.js resolves the shared package for this
// reason; see the note there.
//
// This is the one place the mobile app deliberately does NOT mirror
// shared logic. Mirroring is defensible for the small, stable parsers
// (QR payloads, redo rules) where a hand-synced copy is a few lines and
// easy to eyeball. reportRenderer is ~450 lines of layout that both the
// PDF and the eventual portal view depend on agreeing about; two copies
// would drift, and the failure mode is an audit document that says
// something different from the record it claims to represent.

import { renderAuditReportPdf } from '@diagnostics/shared';
import type { AuditReport, DiagnosticResult } from '@diagnostics/shared';
import type { CapturedIdentity } from './deviceIdentity';
import type { DiagnosticResultInput } from '../api/client';

export interface BuildReportParams {
  reportId: string;
  generatedAt: string;
  technicianId?: string;
  device: CapturedIdentity;
  results: DiagnosticResultInput[];
  overallStatus: AuditReport['overallStatus'];
}

/**
 * Assembles the AuditReport shape reportRenderer expects. Kept separate
 * from rendering so the mapping is testable without invoking the native
 * PDF module.
 */
export function buildAuditReport(params: BuildReportParams): AuditReport {
  return {
    reportId: params.reportId,
    generatedAt: params.generatedAt,
    technicianId: params.technicianId,
    device: {
      make: params.device.make,
      model: params.device.model,
      serialNumber: params.device.serialNumber,
      imei: params.device.imei,
      imei2: params.device.imei2,
      captureSource: params.device.captureSource,
    },
    results: params.results as DiagnosticResult[],
    overallStatus: params.overallStatus,
  };
}

/**
 * Renders the report to a PDF on the device and returns its file path.
 *
 * publicReportBaseUrl is optional: passing it adds the QR code linking
 * to the buyer-facing summary (CLAUDE.md, "QR-linked audit
 * certificate"). It is deliberately not defaulted — the public endpoint
 * that URL would point at does not exist yet, and emitting a QR that
 * resolves to nothing is worse than omitting it, since the whole point
 * of the code is to be a trust signal.
 */
export async function generateReportPdf(
  params: BuildReportParams,
  options: { publicReportBaseUrl?: string } = {},
): Promise<string> {
  const report = buildAuditReport(params);
  return renderAuditReportPdf(report, {
    publicReportBaseUrl: options.publicReportBaseUrl,
  });
}
