// marketplaceListing.ts
//
// Generates a resale listing (title, description, price) from data
// already in the AuditReport + TradeInQuote — no external service
// needed for this one, it's pure templating from existing data. Only
// triggers for devices routed to "resale" (see deviceRouting.ts).

import { AuditReport } from "./types";
import { CosmeticGrade } from "./cosmeticInspection";
import { TradeInQuote } from "./tradeInQuote";

export interface MarketplaceListing {
  title: string;
  description: string;
  price: number;
  condition: CosmeticGrade;
  photos: string[]; // reuse the cosmetic inspection angle photos already captured
}

const GRADE_DESCRIPTIONS: Record<CosmeticGrade, string> = {
  A: "Excellent condition — no visible wear, fully functional.",
  B: "Good condition — light cosmetic wear, fully functional.",
  C: "Fair condition — noticeable cosmetic wear, fully functional.",
  D: "Working condition — significant cosmetic wear or a minor functional issue. See full report for details.",
};

export function generateListing(report: AuditReport, quote: TradeInQuote, grade: CosmeticGrade): MarketplaceListing {
  const flaggedNotes = report.results
    .filter((r) => r.status === "fail" || r.status === "warning")
    .map((r) => `- ${r.label}${r.notes ? `: ${r.notes}` : ""}`)
    .join("\n");

  const title = `${report.device.make} ${report.device.model} — Grade ${grade}, Fully Tested & Certified`;

  const description = `${GRADE_DESCRIPTIONS[grade]}

This device passed a ${report.results.length}-point diagnostic inspection, including display, camera, audio, sensors, and battery health. A certified data wipe was performed prior to listing.

${flaggedNotes ? `Notes:\n${flaggedNotes}\n\n` : ""}Full inspection report available on request — scan the QR code on the included certificate for the complete test breakdown.`;

  return {
    title,
    description,
    price: quote.finalOffer > 0 ? Math.round(quote.finalOffer * 1.35) : 0, // rough resale markup over trade-in offer — replace with real pricing strategy
    condition: grade,
    photos: [], // populate from CosmeticInspectionResult.imageUri for each angle
  };
}
