// src/routes/disputes.ts
//
// The Dispute model has existed in schema.prisma since Sprint 1 with no
// endpoints at all — CLAUDE.md's activity-log section lists dispute
// resolution under "Not yet wired", noting the Uphold/Adjust actions on
// admin_portal_disputes.html "aren't connected to backend logic at all
// yet (they're HTML mockup buttons, not wired functions)". This wires
// them.
//
// Two rules from CLAUDE.md shape this file:
//  - "While a dispute is open, the device and offer stay on hold" — so
//    an open dispute is queryable as a hold, and resolving one is an
//    explicit, attributed action.
//  - Resolutions feed datasetCollection.ts's training examples, since an
//    admin-corrected grade is exactly the technician-correction signal
//    that improves the model. Not built here (no storage backend yet),
//    but the resolution records enough to reconstruct it later.

import { Router } from "express";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { parseListWindow, setPaginationHeaders } from "../lib/pagination";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const OPEN_STATUS = "awaiting_review";
const RESOLVED_STATUSES = { uphold: "resolved_upheld", adjust: "resolved_adjusted" } as const;

router.get("/", requireAuth, requireTenantScope, async (req, res) => {
  const { status } = req.query;
  const where: Prisma.DisputeWhereInput = { ...tenantWhere(req) };
  if (typeof status === "string" && status) where.status = status;

  const { limit, offset } = parseListWindow(req);

  // Oldest-first is right for the OPEN queue — the longest-waiting
  // customer should surface first — but wrong for resolved history,
  // where the interesting rows are the recent ones. With a single
  // ordering and a page limit, a dispute resolved today disappeared off
  // the end of the list as soon as a tenant had more than one page of
  // them.
  const newestFirst = req.query.order === "newest";
  const [total, disputes] = await Promise.all([
    prisma.dispute.count({ where }),
    prisma.dispute.findMany({
      where,
      orderBy: { submittedAt: newestFirst ? "desc" : "asc" },
      take: limit,
      skip: offset,
    }),
  ]);

  setPaginationHeaders(res, { total, limit, offset });
  res.json(disputes);
});

router.get("/:disputeId", requireAuth, requireTenantScope, async (req, res) => {
  const dispute = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), disputeId: req.params.disputeId },
  });
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });
  res.json(dispute);
});

/**
 * Whether a report is currently on hold. CLAUDE.md: payout processing
 * and report finalisation must not proceed while a dispute is open.
 * Exposed as its own endpoint so a caller checks the rule rather than
 * re-deriving it from a dispute list and getting it subtly wrong.
 */
router.get("/holds/:reportId", requireAuth, requireTenantScope, async (req, res) => {
  const open = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), reportId: req.params.reportId, status: OPEN_STATUS },
    select: { disputeId: true, submittedAt: true, disputingItem: true },
  });
  res.json({
    reportId: req.params.reportId,
    onHold: Boolean(open),
    ...(open ? { openDispute: open } : {}),
  });
});

/**
 * Filed from the consumer tracker (consumer_dispute.html), so this is
 * not behind portal auth in the real flow — but the consumer-facing
 * surface doesn't exist yet and inventing an auth model for it here
 * would be guessing. Portal-authenticated for now: staff can record a
 * dispute a customer raised by phone or email, which is a real intake
 * path regardless. The consumer endpoint is deliberately deferred
 * rather than stubbed with an unauthenticated write.
 */
router.post("/", requireAuth, requireTenantScope, async (req, res) => {
  const { reportId, disputingItem, customerNote } = req.body ?? {};

  if (typeof reportId !== "string" || !reportId) {
    return res.status(400).json({ error: "reportId is required" });
  }
  if (typeof disputingItem !== "string" || !disputingItem) {
    return res.status(400).json({ error: "disputingItem is required" });
  }
  if (typeof customerNote !== "string" || !customerNote) {
    return res.status(400).json({ error: "customerNote is required" });
  }

  // The report must belong to this tenant, or a dispute could be filed
  // against another tenant's report and put THEIR device on hold.
  const report = await prisma.report.findFirst({
    where: { ...tenantWhere(req), reportId },
    select: { reportId: true },
  });
  if (!report) return res.status(404).json({ error: "Report not found" });

  const dispute = await prisma.dispute.create({
    data: {
      ...tenantWhere(req),
      reportId: report.reportId,
      disputingItem,
      customerNote,
      status: OPEN_STATUS,
    },
  });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: "dispute_received",
      targetType: "dispute",
      targetId: dispute.disputeId,
      details: `Dispute filed against ${reportId}: ${disputingItem}`,
    }),
  });

  res.status(201).json(dispute);
});

/**
 * Resolve — the "Uphold Grade" / "Adjust Grade" actions from the mockup.
 * tenant_staff is excluded: overturning a grade changes what a customer
 * is paid, so it belongs to tenant_admin (or a master_admin in tenant
 * view), the same reasoning that keeps licence provisioning away from
 * tenant_staff.
 */
router.post("/:disputeId/resolve", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot resolve disputes" });
  }

  const { outcome, resolutionNotes } = (req.body ?? {}) as {
    outcome?: unknown;
    resolutionNotes?: unknown;
  };
  if (outcome !== "uphold" && outcome !== "adjust") {
    return res.status(400).json({ error: 'outcome must be "uphold" or "adjust"' });
  }
  // Required, not optional: CLAUDE.md wants resolved disputes to "show
  // the outcome and reasoning for audit purposes", and an adjusted grade
  // with no stated reason is unauditable — and useless as a future
  // training signal.
  if (typeof resolutionNotes !== "string" || !resolutionNotes.trim()) {
    return res.status(400).json({ error: "resolutionNotes is required, so the decision is auditable" });
  }

  const existing = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), disputeId: req.params.disputeId },
  });
  if (!existing) return res.status(404).json({ error: "Dispute not found" });
  if (existing.status !== OPEN_STATUS) {
    // Re-resolving would overwrite the original decision and its
    // reasoning, destroying the audit trail this exists to provide.
    return res.status(409).json({ error: "This dispute has already been resolved" });
  }

  const result = await prisma.dispute.updateMany({
    where: { ...tenantWhere(req), disputeId: req.params.disputeId, status: OPEN_STATUS },
    data: {
      status: RESOLVED_STATUSES[outcome],
      resolutionNotes: resolutionNotes.trim(),
      resolvedByUserId: req.portalSession!.userId,
      resolvedAt: new Date(),
    },
  });
  // Lost the race against a concurrent resolution.
  if (result.count === 0) return res.status(409).json({ error: "This dispute has already been resolved" });

  await prisma.activityLogEntry.create({
    data: buildActivityLogData({
      tenantId: req.portalSession!.viewingTenantId,
      actorUserId: req.portalSession!.userId,
      actorRole: req.portalSession!.role,
      action: outcome === "uphold" ? "dispute_upheld" : "dispute_grade_adjusted",
      targetType: "dispute",
      targetId: existing.disputeId,
      details: `Dispute ${outcome === "uphold" ? "upheld" : "grade adjusted"}: ${resolutionNotes.trim()}`,
      metadata: { reportId: existing.reportId, disputingItem: existing.disputingItem },
    }),
  });

  const updated = await prisma.dispute.findFirst({
    where: { ...tenantWhere(req), disputeId: req.params.disputeId },
  });
  res.json(updated);
});

export default router;
