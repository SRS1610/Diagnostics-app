// deviceRouting.ts
//
// Post-grading workflow decision: where does this device go next.
// See CLAUDE.md "Post-grading routing" for how this ties into the
// Devices tab in the backend portal.

import { CosmeticGrade } from "./cosmeticInspection";
import { DiagnosticResult } from "./types";
import { EligibilityResult } from "./deviceVerification";

export type RoutingDecision = "resale" | "repair" | "parts_harvest" | "recycle" | "hold_ineligible";

export function determineRouting(params: {
  grade: CosmeticGrade;
  eligibility: EligibilityResult;
  results: DiagnosticResult[];
}): RoutingDecision {
  // Never auto-route a blacklisted/locked device anywhere else — it
  // needs a human decision, not an automated resale/repair path.
  if (!params.eligibility.eligible) return "hold_ineligible";

  const failures = params.results.filter((r) => r.status === "fail");
  if (params.grade === "D" && failures.length > 2) return "parts_harvest";
  if (failures.length > 0) return "repair";
  return "resale";
}

export const ROUTING_LABELS: Record<RoutingDecision, string> = {
  resale: "Ready for Resale",
  repair: "Send to Repair",
  parts_harvest: "Parts Harvest",
  recycle: "Recycle",
  hold_ineligible: "On Hold — Ineligible",
};
