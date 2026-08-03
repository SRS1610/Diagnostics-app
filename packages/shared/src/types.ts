// types.ts
//
// Core shared types used across nearly every module in this package.
// See CLAUDE.md "DiagnosticResult type" and "PDF report rendering" for
// the full history of how these evolved.

export interface DiagnosticResult {
  testId: string;
  label: string;
  status: "pass" | "fail" | "warning" | "skipped";
  value?: string | number;
  notes?: string;
  source: "api" | "manual" | "ocr"; // provenance — lets the report distinguish
                                     // programmatically-read values from
                                     // human-entered/confirmed ones
  timestamp: string;
}

export interface AuditReport {
  reportId: string;
  generatedAt: string;
  technicianId?: string;
  device: {
    make: string;
    model: string;
    serialNumber: string;
    imei: string;
    imei2?: string; // dual-SIM
    captureSource: "barcode" | "ocr" | "manual";
  };
  results: DiagnosticResult[];
  overallStatus: "pass" | "fail" | "pass_with_warnings";
}

export function computeOverallStatus(results: DiagnosticResult[]): AuditReport["overallStatus"] {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "warning" || r.status === "skipped")) return "pass_with_warnings";
  return "pass";
}
