// tradeInQuote.ts
//
// Computes a trade-in offer from device model + cosmetic grade + test
// results, and tracks payout once accepted. See CLAUDE.md "Trade-in
// valuation & payout" for the market-price-feed dependency this needs.

import { CosmeticGrade } from "./cosmeticInspection";
import { DiagnosticResult } from "./types";

export interface MarketPriceEntry {
  model: string;
  storageGb: number;
  gradeBasePrices: Record<CosmeticGrade, number>; // USD, before deductions
}

export interface QuoteDeduction {
  reason: string;
  amount: number;
}

export interface TradeInQuote {
  quoteId: string;
  reportId: string;
  deviceModel: string;
  grade: CosmeticGrade;
  basePrice: number;
  deductions: QuoteDeduction[];
  finalOffer: number;
  currency: string;
  quotedAt: string;
  expiresAt: string; // quotes should not be open-ended — prices move
}

/**
 * Deducts for specific failed/warning functional tests on top of the
 * cosmetic-grade base price — a device graded "A" cosmetically but with
 * a failed battery or camera shouldn't get full A-grade money.
 */
const FUNCTIONAL_DEDUCTIONS: Record<string, number> = {
  battery_health: 15,
  camera_back: 20,
  camera_front: 10,
  loud_speaker: 10,
  microphone: 10,
  charging_port: 15,
};

export function computeTradeInQuote(params: {
  reportId: string;
  model: string;
  storageGb: number;
  grade: CosmeticGrade;
  results: DiagnosticResult[];
  priceTable: MarketPriceEntry[];
  currency?: string;
}): TradeInQuote | null {
  const entry = params.priceTable.find(
    (p) => p.model === params.model && p.storageGb === params.storageGb
  );
  if (!entry) return null; // no price data for this model/storage — needs manual pricing

  const basePrice = entry.gradeBasePrices[params.grade];
  const deductions: QuoteDeduction[] = params.results
    .filter((r) => (r.status === "fail" || r.status === "warning") && FUNCTIONAL_DEDUCTIONS[r.testId])
    .map((r) => ({ reason: r.label, amount: FUNCTIONAL_DEDUCTIONS[r.testId] }));

  const finalOffer = Math.max(
    0,
    basePrice - deductions.reduce((sum, d) => sum + d.amount, 0)
  );

  const quotedAt = new Date();
  const expiresAt = new Date(quotedAt.getTime() + 7 * 24 * 60 * 60 * 1000); // 7-day quote validity

  return {
    quoteId: `Q-${params.reportId}`,
    reportId: params.reportId,
    deviceModel: params.model,
    grade: params.grade,
    basePrice,
    deductions,
    finalOffer,
    currency: params.currency ?? "USD",
    quotedAt: quotedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export type PayoutMethod = "store_credit" | "ach" | "paypal" | "gift_card";
export type PayoutStatus = "pending" | "processing" | "completed" | "failed";

export interface PayoutRecord {
  payoutId: string;
  quoteId: string;
  reportId: string;
  amount: number;
  method: PayoutMethod;
  status: PayoutStatus;
  processedAt?: string;
}
