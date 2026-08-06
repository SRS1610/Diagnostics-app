// src/routes/qaMetrics.ts
//
// Per-technician QA metrics for the Team page: redo rate and dispute
// rate. CLAUDE.md's Team section flagged these as "still NOT built" —
// the mockup shows them, but until this route existed the page said so
// plainly rather than displaying invented figures on a screen used to
// judge people's work. This wires the real numbers.
//
// Definitions used here (both stated on the response so the UI can
// caption them without having to look this file up):
//   redoRate = distinct reports by this technician that had at least
//              one ReportRevision, divided by their total reports
//   disputeRate = distinct reports by this technician that received at
//                 least one Dispute, divided by their total reports
//
// A single report can be revised multiple times or disputed multiple
// times, but that's not the property the Team page cares about — the
// question is "how often does this person's work need a second look",
// not "how many revisions in total did this person's work generate".
// Counting distinct reports keeps a repeatedly-disputed outlier from
// distorting the whole technician's rate.
//
// Zero-report technicians appear with reports=0 and rate=null (not 0),
// because 0/0 is not "did great work with no complaints" — it's "no
// signal yet". The UI shows "—" for null and a percentage otherwise,
// so a brand-new hire isn't rendered as a top performer by accident.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { prisma } from "../lib/prisma";

const router = Router();

interface TechnicianQaRow {
  technicianId: string;
  displayName: string;
  active: boolean;
  reports: number;
  reportsWithRevisions: number;
  reportsWithDisputes: number;
  /** null when reports === 0 — no signal yet, don't render as 0%. */
  redoRate: number | null;
  disputeRate: number | null;
}

router.get("/qa-metrics/technicians", requireAuth, requireTenantScope, async (req, res) => {
  const where = tenantWhere(req);

  // Three parallel reads, then aggregate in memory. A tenant's
  // technician roster is bounded (dozens, not millions), and both the
  // revision and dispute tables are 1–2 orders of magnitude smaller
  // than reports, so this stays well inside the ~single-second budget a
  // portal page can spend. Doing it in-memory keeps the response shape
  // portable across databases and avoids a raw-SQL aggregate that would
  // otherwise duplicate the tenant filter in three places.
  const [technicians, reports, revisions, disputes] = await Promise.all([
    prisma.technician.findMany({ where, orderBy: { createdAt: "desc" } }),
    prisma.report.findMany({
      where: { ...where, technicianId: { not: null } },
      select: { reportId: true, technicianId: true },
    }),
    // ReportRevision has NO tenantId column — a revision inherits its
    // tenant scope from its parent Report. Filter via the relation so a
    // future cross-tenant revision (if the schema ever permitted one)
    // couldn't slip through.
    prisma.reportRevision.findMany({
      where: { report: { tenantId: where.tenantId } },
      select: { reportId: true },
    }),
    prisma.dispute.findMany({
      where,
      select: { reportId: true },
    }),
  ]);

  // reportId -> technicianId; only reports with an attributed technician
  // count toward per-technician rates. An unattributed report is a real
  // data point (batch imports, historical rows) but not one anyone can
  // be judged on.
  const reportToTech = new Map<string, string>();
  const reportsByTech = new Map<string, number>();
  for (const r of reports) {
    if (r.technicianId) {
      reportToTech.set(r.reportId, r.technicianId);
      reportsByTech.set(r.technicianId, (reportsByTech.get(r.technicianId) ?? 0) + 1);
    }
  }

  // Distinct reports (not distinct revisions) per technician — a report
  // revised twice by the same tech is one "needed a second look", not
  // two, so it doesn't distort their rate. Same shape for disputes.
  const revisedReportsByTech = new Map<string, Set<string>>();
  for (const rev of revisions) {
    const techId = reportToTech.get(rev.reportId);
    if (!techId) continue;
    if (!revisedReportsByTech.has(techId)) revisedReportsByTech.set(techId, new Set());
    revisedReportsByTech.get(techId)!.add(rev.reportId);
  }

  const disputedReportsByTech = new Map<string, Set<string>>();
  for (const d of disputes) {
    const techId = reportToTech.get(d.reportId);
    if (!techId) continue;
    if (!disputedReportsByTech.has(techId)) disputedReportsByTech.set(techId, new Set());
    disputedReportsByTech.get(techId)!.add(d.reportId);
  }

  const rows: TechnicianQaRow[] = technicians.map((t) => {
    const reportCount = reportsByTech.get(t.technicianId) ?? 0;
    const revised = revisedReportsByTech.get(t.technicianId)?.size ?? 0;
    const disputed = disputedReportsByTech.get(t.technicianId)?.size ?? 0;
    return {
      technicianId: t.technicianId,
      displayName: t.displayName,
      active: t.active,
      reports: reportCount,
      reportsWithRevisions: revised,
      reportsWithDisputes: disputed,
      redoRate: reportCount === 0 ? null : revised / reportCount,
      disputeRate: reportCount === 0 ? null : disputed / reportCount,
    };
  });

  res.json({
    technicians: rows,
    definitions: {
      redoRate: "Share of this technician's reports that had at least one revision.",
      disputeRate: "Share of this technician's reports that received at least one consumer dispute.",
      nullMeaning: "A rate of null means the technician has zero reports so far — not zero rate.",
    },
  });
});

export default router;
