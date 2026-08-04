// src/routes/compliance.ts
//
// The reporting CLAUDE.md asks for: "aggregate resale vs. repair vs.
// recycle counts (from deviceRouting.ts decisions) into a reportable
// summary — R2v3/e-Stewards-style reporting is increasingly expected by
// corporate trade-in clients specifically."
//
// Two things this is careful about, because a compliance number that is
// quietly wrong is worse than no number at all:
//
//  1. UNROUTED DEVICES ARE COUNTED AND NAMED. A report with no routing
//     decision is not a recycled device, not a resold one, and must not
//     be silently dropped from the denominator — that would inflate
//     every percentage. It gets its own line.
//
//  2. THE PERIOD IS ALWAYS STATED BACK. An export headed only
//     "Compliance Summary" invites someone to file it as covering the
//     year when it covers a fortnight. The response and the CSV both
//     carry the exact window they were computed over.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { csvDocument, csvFilename } from "../lib/csv";
import { parseDate } from "../lib/pagination";
import { prisma } from "../lib/prisma";

const router = Router();

/** The routing decisions deviceRouting.ts can produce, in the order a
 *  reader expects: best outcome first, then the hold. */
const ROUTES = ["resale", "repair", "parts_harvest", "recycle", "hold_ineligible"] as const;

const ROUTE_LABEL: Record<string, string> = {
  resale: "Resold",
  repair: "Repaired",
  parts_harvest: "Harvested for parts",
  recycle: "Recycled",
  hold_ineligible: "Held — ineligible",
};

interface Summary {
  period: { from: string | null; to: string | null; generatedAt: string };
  totalInspections: number;
  routing: Array<{ decision: string; label: string; count: number; percentage: number }>;
  unrouted: { count: number; note: string };
  outcomes: { passed: number; failed: number; passedWithWarnings: number };
  dataErasure: { certificatesIssued: number; purgeStandard: number; clearStandard: number; note: string };
}

async function buildSummary(req: Parameters<typeof tenantWhere>[0]): Promise<Summary> {
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);

  const where: Prisma.ReportWhereInput = { ...tenantWhere(req) };
  if (from || to) {
    where.generatedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [total, byRouting, byStatus, certificates] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.groupBy({ by: ["routing"], where, _count: { _all: true } }),
    prisma.report.groupBy({ by: ["overallStatus"], where, _count: { _all: true } }),
    prisma.dataWipeCertificate.findMany({
      // Certificates hang off reports, which is where the tenant lives —
      // there is no tenantId on the certificate itself, so the filter
      // goes through the relation rather than being omitted.
      where: { report: where, passed: true },
      select: { standard: true },
    }),
  ]);

  const countFor = (decision: string) =>
    byRouting.find((row) => row.routing === decision)?._count._all ?? 0;

  const unrouted = byRouting.find((row) => row.routing === null)?._count._all ?? 0;
  const statusCount = (status: string) =>
    byStatus.find((row) => row.overallStatus === status)?._count._all ?? 0;

  return {
    period: {
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      generatedAt: new Date().toISOString(),
    },
    totalInspections: total,
    routing: ROUTES.map((decision) => {
      const count = countFor(decision);
      return {
        decision,
        label: ROUTE_LABEL[decision],
        count,
        // Percentage of ALL inspections, including unrouted ones.
        // Dividing by the routed subset would report "62% resold" for a
        // period in which most devices were never routed at all.
        percentage: total === 0 ? 0 : Math.round((count / total) * 1000) / 10,
      };
    }),
    unrouted: {
      count: unrouted,
      note:
        "Inspected but no routing decision recorded. Counted here rather than dropped, because excluding them would " +
        "inflate every percentage above.",
    },
    outcomes: {
      passed: statusCount("pass"),
      failed: statusCount("fail"),
      passedWithWarnings: statusCount("pass_with_warnings"),
    },
    dataErasure: {
      certificatesIssued: certificates.length,
      purgeStandard: certificates.filter((c) => c.standard === "nist_800_88_purge").length,
      clearStandard: certificates.filter((c) => c.standard === "nist_800_88_clear").length,
      note: "Counts certificates recorded as PASSED only; a failed erasure is not an attestation.",
    },
  };
}

router.get("/summary", requireAuth, requireTenantScope, async (req, res) => {
  res.json(await buildSummary(req));
});

router.get("/summary.csv", requireAuth, requireTenantScope, async (req, res) => {
  const summary = await buildSummary(req);

  const rows: unknown[][] = [
    ["Period start", summary.period.from ?? "all time"],
    ["Period end", summary.period.to ?? "all time"],
    ["Generated at", summary.period.generatedAt],
    ["Total inspections", summary.totalInspections],
    [],
    ["Routing decision", "Count", "% of inspections"],
    ...summary.routing.map((r) => [r.label, r.count, `${r.percentage}%`]),
    ["No routing decision recorded", summary.unrouted.count, ""],
    [],
    ["Outcome", "Count"],
    ["Passed", summary.outcomes.passed],
    ["Passed with warnings", summary.outcomes.passedWithWarnings],
    ["Failed", summary.outcomes.failed],
    [],
    ["Certified data erasure", "Count"],
    ["Certificates issued (passed)", summary.dataErasure.certificatesIssued],
    ["NIST 800-88 Purge", summary.dataErasure.purgeStandard],
    ["NIST 800-88 Clear", summary.dataErasure.clearStandard],
  ];

  res.type("text/csv").attachment(csvFilename("compliance-summary", new Date()));
  res.send(csvDocument(["Metric", "Value", ""], rows));
});

export default router;
