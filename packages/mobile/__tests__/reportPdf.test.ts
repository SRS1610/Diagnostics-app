/**
 * @format
 *
 * Covers the AuditReport mapping only — not renderAuditReportPdf itself,
 * which calls a native module and cannot run here. The mapping is where
 * a mistake would be silent: a dropped field produces a PDF that omits
 * part of the record it claims to represent.
 */

import { buildAuditReport } from '../src/lib/reportPdf';
import type { DiagnosticResultInput } from '../src/api/client';

const device = {
  make: 'Apple',
  model: 'iPhone 13',
  serialNumber: 'ABC123XYZ',
  imei: '356938035643809',
  captureSource: 'barcode' as const,
};

const results: DiagnosticResultInput[] = [
  {
    testId: 'battery_health',
    label: 'Battery Health (self-reported from device Settings)',
    status: 'fail',
    value: 72,
    notes: 'Below the 80% replacement threshold.',
    source: 'manual',
    timestamp: '2026-08-03T12:00:00Z',
  },
];

describe('buildAuditReport', () => {
  it('maps identity and results onto the shared AuditReport shape', () => {
    const report = buildAuditReport({
      reportId: 'DDA-0217',
      generatedAt: '2026-08-03T12:30:00Z',
      technicianId: 'tech_1',
      device,
      results,
      overallStatus: 'fail',
    });

    expect(report.reportId).toBe('DDA-0217');
    expect(report.technicianId).toBe('tech_1');
    expect(report.device).toEqual({
      make: 'Apple',
      model: 'iPhone 13',
      serialNumber: 'ABC123XYZ',
      imei: '356938035643809',
      imei2: undefined,
      captureSource: 'barcode',
    });
    expect(report.overallStatus).toBe('fail');
  });

  // Provenance is the whole reason the report distinguishes sources; a
  // mapping that dropped it would present human-entered values as
  // machine reads.
  it('preserves per-result source and notes', () => {
    const report = buildAuditReport({
      reportId: 'DDA-0217',
      generatedAt: '2026-08-03T12:30:00Z',
      device,
      results,
      overallStatus: 'fail',
    });

    expect(report.results[0].source).toBe('manual');
    expect(report.results[0].label).toMatch(/self-reported/);
    expect(report.results[0].notes).toBeTruthy();
  });

  it('carries a dual-SIM second IMEI through', () => {
    const report = buildAuditReport({
      reportId: 'DDA-0217',
      generatedAt: '2026-08-03T12:30:00Z',
      device: { ...device, imei2: '356938035643791' },
      results,
      overallStatus: 'fail',
    });
    expect(report.device.imei2).toBe('356938035643791');
  });
});
