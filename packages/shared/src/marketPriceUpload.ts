// marketPriceUpload.ts
//
// Reads a market pricing Excel file (.xlsx) uploaded by a tenant admin
// and converts it into MarketPriceEntry[] for the trade-in quote engine.
//
// This replaces the hardcoded seed tables in marketPriceData.ts with a
// real, admin-uploadable feed — the pricing data lives in an Excel file
// the admin maintains and re-uploads whenever prices change, rather than
// requiring a code change or a licensed API feed.
//
// Expected Excel format (see the generated template):
//   Column A: Model (e.g. "iPhone 14")
//   Column B: Storage (GB) (e.g. 128)
//   Column C: Grade A Price (USD)
//   Column D: Grade B Price (USD)
//   Column E: Grade C Price (USD)
//   Column F: Grade D Price (USD)
//   Row 1: Header row (skipped)
//   Rows 2+: One row per model/storage combo

import { MarketPriceEntry } from "./tradeInQuote";
import { logActivity } from "./adminActivityLog";

export interface PriceUploadResult {
  success: boolean;
  entries: MarketPriceEntry[];
  errors: string[];
  rowsProcessed: number;
}

/**
 * Parses rows from an uploaded Excel file into MarketPriceEntry[].
 * Each row is [model, storageGb, gradeA, gradeB, gradeC, gradeD].
 * Validates that all numeric fields are positive numbers and that no
 * required field is missing — returns per-row errors rather than
 * silently skipping bad data, so the admin can fix and re-upload.
 */
export function parseUploadedPriceRows(
  rows: (string | number | null)[][]
): PriceUploadResult {
  const entries: MarketPriceEntry[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +2 because row 1 is the header, data starts at row 2
    const [model, storage, a, b, c, d] = rows[i];

    if (!model || typeof model !== "string" || model.trim() === "") {
      errors.push(`Row ${rowNum}: missing or empty model name`);
      continue;
    }
    const storageGb = typeof storage === "number" ? storage : parseInt(String(storage), 10);
    if (isNaN(storageGb) || storageGb <= 0) {
      errors.push(`Row ${rowNum}: invalid storage value "${storage}"`);
      continue;
    }

    const grades = { a, b, c, d };
    const prices: Record<string, number> = {};
    let hasError = false;
    for (const [grade, val] of Object.entries(grades)) {
      const num = typeof val === "number" ? val : parseFloat(String(val));
      if (isNaN(num) || num < 0) {
        errors.push(`Row ${rowNum}: invalid Grade ${grade.toUpperCase()} price "${val}"`);
        hasError = true;
      }
      prices[grade] = num;
    }
    if (hasError) continue;

    entries.push({
      model: model.trim(),
      storageGb,
      gradeBasePrices: {
        A: prices.a,
        B: prices.b,
        C: prices.c,
        D: prices.d,
      },
    });
  }

  return {
    success: errors.length === 0,
    entries,
    errors,
    rowsProcessed: rows.length,
  };
}

/**
 * Call after parseUploadedPriceRows succeeds — logs the upload as an
 * admin activity. Separate from the parse itself because logging needs
 * tenantId/actorUserId context that the pure parser doesn't have.
 */
export function logPricingUpload(params: {
  tenantId: string;
  actorUserId: string;
  actorRole: "master_admin" | "tenant_admin";
  result: PriceUploadResult;
  market: string; // e.g. "US", "India", "Australia"
}): void {
  logActivity({
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    action: "pricing_uploaded",
    targetType: "pricing",
    targetId: params.market,
    details: `Uploaded ${params.result.rowsProcessed} pricing rows for ${params.market} market (${params.result.errors.length} errors)`,
    metadata: { rowsProcessed: params.result.rowsProcessed, errorCount: params.result.errors.length },
  });
}
