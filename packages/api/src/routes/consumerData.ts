// src/routes/consumerData.ts
//
// Right-to-deletion path — the manual admin action CLAUDE.md's "Data
// retention policy" section flags as still needed before this system
// handles real consumer data in a GDPR/CCPA jurisdiction. "Keep forever"
// as a default doesn't remove the obligation to honour a specific
// deletion request; this is that path.
//
// What this deletes:
//  - Report.consumerEmail and Report.consumerPhone (the PII fields on
//    the report itself)
//  - Any Dispute.customerNote written by a matching consumer (the note
//    is free text and can contain the customer's own name/details;
//    replaced with a redaction placeholder, not physically deleted, so
//    the fact of the dispute remains auditable)
//
// What this deliberately does NOT delete:
//  - The report itself (device tests, serial, timestamps, audit result).
//    These are business records with a legal retention obligation of
//    their own — a device audit isn't consumer PII, it's an inspection
//    record. Erasure requests apply to identifiable personal data, not
//    to business documents that happen to involve a person.
//  - The consumerToken. The public tracker returns a report view whose
//    PII has already been scrubbed; rotating the token would break the
//    QR code on any printed report or resale listing tied to this
//    inspection, which is a business impact disproportionate to the
//    privacy benefit (the tracker itself now shows nothing personal).
//  - The notification-attempt entries in the activity log. Those entries
//    already store masked contacts (`bu••••@example.test`) — see
//    lib/notificationDelivery.ts's maskContact — so they are not PII in
//    the first place. The tenant needs the audit of "did this send" for
//    unrelated compliance reasons; the masked form preserves it without
//    reintroducing what we just erased.
//
// Not a bulk sweep by tenant — this is per-consumer. A caller specifies
// exactly which email and/or phone identifies the requesting individual,
// and the endpoint operates on rows matching those specific values in
// this tenant only.

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireTenantScope, tenantWhere } from "../middleware/tenantScope";
import { buildActivityLogData } from "../lib/activityLog";
import { prisma } from "../lib/prisma";

const router = Router();

const REDACTED_NOTE = "[erased per privacy request]";

interface Selector {
  email?: string;
  phone?: string;
}

function parseSelector(body: unknown): { ok: true; value: Selector } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "email or phone is required" };
  const { email, phone } = body as Record<string, unknown>;

  const hasEmail = typeof email === "string" && email.trim().length > 0;
  const hasPhone = typeof phone === "string" && phone.trim().length > 0;
  if (!hasEmail && !hasPhone) return { ok: false, error: "email or phone is required" };

  const value: Selector = {};
  if (hasEmail) value.email = (email as string).trim();
  if (hasPhone) value.phone = (phone as string).trim();
  return { ok: true, value };
}

// Match ANY of the provided fields, case-insensitively for email.
// The two matches are OR'd rather than AND'd — a customer who once gave
// an email and later gave a different phone against the same account
// should have BOTH erased on a single request, not neither because the
// row doesn't have both values simultaneously.
function reportMatch(tenantId: string, selector: Selector) {
  const or: Array<Record<string, unknown>> = [];
  if (selector.email) or.push({ consumerEmail: { equals: selector.email, mode: "insensitive" as const } });
  if (selector.phone) or.push({ consumerPhone: selector.phone });
  return { tenantId, OR: or };
}

/**
 * Preview — how many rows would be affected by an erasure request, and
 * a sample of them (report IDs, device model, date) so the admin can
 * confirm they're erasing the right person before pulling the trigger.
 * No writes, no audit log entry.
 */
router.get("/consumer-data", requireAuth, requireTenantScope, async (req, res) => {
  const parsed = parseSelector({
    email: typeof req.query.email === "string" ? req.query.email : undefined,
    phone: typeof req.query.phone === "string" ? req.query.phone : undefined,
  });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const tenantId = req.portalSession!.viewingTenantId!;
  const where = reportMatch(tenantId, parsed.value);

  const [reportCount, reports] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      select: { reportId: true, deviceModel: true, deviceMake: true, generatedAt: true },
      orderBy: { generatedAt: "desc" },
      take: 25,
    }),
  ]);

  // Dispute has reportId but no declared Prisma relation to Report, so
  // count by reportId list rather than through a join filter. Preview
  // scans the full matching set (not just the 25-report sample above),
  // so the count reflects what an actual erasure would touch.
  const matchingIds = reportCount === reports.length
    ? reports.map((r) => r.reportId)
    : (await prisma.report.findMany({ where, select: { reportId: true } })).map((r) => r.reportId);
  const disputeCount = matchingIds.length
    ? await prisma.dispute.count({
        where: { tenantId, reportId: { in: matchingIds }, customerNote: { not: REDACTED_NOTE } },
      })
    : 0;

  res.json({
    selector: parsed.value,
    reports: { total: reportCount, sample: reports },
    disputes: { total: disputeCount },
  });
});

/**
 * Execute — actually scrub the PII. Admin-only: this is destructive and
 * bypasses the "data kept forever" default. tenant_staff has enough
 * reach to change a customer's payout method or resolve a routine
 * dispute, but not to erase records — same reasoning as licence
 * provisioning and dispute resolution.
 *
 * A reason is required and stored on the audit log. If a data subject
 * later asks "did you process my request", the answer needs to be
 * traceable to a specific action attributed to a specific admin at a
 * specific time, not "someone probably did this".
 */
router.post("/consumer-data/erase", requireAuth, requireTenantScope, async (req, res) => {
  if (req.portalSession!.role === "tenant_staff") {
    return res.status(403).json({ error: "tenant_staff cannot erase consumer data" });
  }

  const parsed = parseSelector(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  const reason = (req.body as { reason?: unknown } | null)?.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ error: "reason is required, so the erasure is auditable" });
  }

  const tenantId = req.portalSession!.viewingTenantId!;
  const where = reportMatch(tenantId, parsed.value);

  // One transaction so a partial erasure can't leave PII on some rows
  // while the audit log claims the whole request was processed.
  const outcome = await prisma.$transaction(async (tx) => {
    const affected = await tx.report.findMany({
      where,
      select: { reportId: true },
    });
    const reportIds = affected.map((r) => r.reportId);

    if (reportIds.length === 0) {
      return { erasedReports: 0, redactedDisputes: 0, reportIds };
    }

    const scrubbed = await tx.report.updateMany({
      where: { tenantId, reportId: { in: reportIds } },
      data: { consumerEmail: null, consumerPhone: null },
    });

    // Redact, don't delete — the fact of the dispute (its ID, its
    // outcome, its timestamps) is what a dispute audit needs; the note
    // is the personal-data part.
    const redacted = await tx.dispute.updateMany({
      where: { tenantId, reportId: { in: reportIds }, customerNote: { not: REDACTED_NOTE } },
      data: { customerNote: REDACTED_NOTE },
    });

    return { erasedReports: scrubbed.count, redactedDisputes: redacted.count, reportIds };
  });

  // One audit entry per erased report — the log's targetId is
  // per-record, so a bulk erasure produces a bulk of entries rather than
  // a single summary row. This matches how the other bulk actions in
  // this system audit (each licence provisioned, each user updated).
  if (outcome.reportIds.length > 0) {
    await prisma.activityLogEntry.createMany({
      data: outcome.reportIds.map((reportId) =>
        buildActivityLogData({
          tenantId,
          actorUserId: req.portalSession!.userId,
          actorRole: req.portalSession!.role,
          action: "consumer_data_erased",
          targetType: "report",
          targetId: reportId,
          details: reason.trim(),
          metadata: {
            selector: parsed.value,
            redactedDisputesForThisReport: undefined, // per-report breakdown not tracked; total is on the response
          },
        }),
      ),
    });
  }

  res.json({
    selector: parsed.value,
    reason: reason.trim(),
    erasedReports: outcome.erasedReports,
    redactedDisputes: outcome.redactedDisputes,
    reportIds: outcome.reportIds,
  });
});

export default router;
