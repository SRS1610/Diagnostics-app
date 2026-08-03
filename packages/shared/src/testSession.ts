// testSession.ts
//
// Manages the in-progress set of DiagnosticResults for a session, including
// redoing individual tests and bulk-redoing every failed/warning test at
// once. See CLAUDE.md "Redo / retest capability" for the UI-level rules
// this supports (e.g. never silently drop a redo into a duplicate entry).
//
// RESOLVED: redo after report generation keeps the SAME reportId — see
// ReportRevision below and CLAUDE.md "Redo / retest capability".

import { DiagnosticResult } from "./types";
import { logActivity } from "./adminActivityLog";

export interface TestSession {
  sessionId: string;
  results: DiagnosticResult[];
}

/**
 * A same-session correction is not a new inspection — the reportId stays
 * fixed, and each redo-after-generation gets a revision entry instead.
 * This keeps the Devices tab's "one report per real visit" timeline
 * correct: a device that comes back weeks later for a genuinely separate
 * inspection gets its own new reportId naturally (new session), while a
 * same-day correction to an already-generated report does not.
 */
export interface ReportRevision {
  revisionNumber: number; // 1, 2, 3... — R1, R2, R3 in the displayed reportId suffix
  revisedAt: string;
  revisedByTechnicianId: string;
  testIdsRedone: string[];
  reason?: string; // e.g. "OCR misread battery %, customer disputed"
}

export function nextRevisionNumber(existingRevisions: ReportRevision[]): number {
  return existingRevisions.length + 1;
}

export function createRevision(params: {
  baseReportId: string;
  existingRevisions: ReportRevision[];
  technicianId: string;
  testIdsRedone: string[];
  reason?: string;
  tenantId: string;
}): ReportRevision {
  const revision: ReportRevision = {
    revisionNumber: nextRevisionNumber(params.existingRevisions),
    revisedAt: new Date().toISOString(),
    revisedByTechnicianId: params.technicianId,
    testIdsRedone: params.testIdsRedone,
    reason: params.reason,
  };

  logActivity({
    tenantId: params.tenantId,
    actorUserId: params.technicianId,
    actorRole: "tenant_staff",
    action: "report_revision_created",
    targetType: "report",
    targetId: `${params.baseReportId}-R${revision.revisionNumber}`,
    details: `Revision R${revision.revisionNumber}: redid ${params.testIdsRedone.length} tests`,
    metadata: { testIdsRedone: params.testIdsRedone, reason: params.reason },
  });

  return revision;
}

export function displayReportId(baseReportId: string, revisions: ReportRevision[]): string {
  if (revisions.length === 0) return baseReportId;
  return `${baseReportId}-R${revisions.length}`;
}

/** Returns only the tests currently flagged (fail or warning) — the set a
 * "Redo Flagged Tests" bulk action would target. Skipped and pass are
 * left alone; skipped isn't a failure, it's "not applicable." */
export function getFlaggedTests(results: DiagnosticResult[]): DiagnosticResult[] {
  return results.filter((r) => r.status === "fail" || r.status === "warning");
}

export function countFlaggedTests(results: DiagnosticResult[]): number {
  return getFlaggedTests(results).length;
}

/**
 * Removes the given testIds from the results array so the test-runner can
 * re-execute them fresh. This does NOT re-run anything itself — it just
 * clears the slate for those testIds. Call the relevant test function(s)
 * afterward and append the new results.
 *
 * Removing (not just flagging) the old entries matters: a redo replaces
 * the prior result outright, so summary counts and the report never show
 * a stale duplicate alongside the new one.
 */
export function clearTestsForRedo(
  results: DiagnosticResult[],
  testIds: string[]
): DiagnosticResult[] {
  const idSet = new Set(testIds);
  return results.filter((r) => !idSet.has(r.testId));
}

/**
 * Bulk redo: clears every currently-flagged test and returns both the
 * cleared results array and the list of testIds the UI/test-runner needs
 * to re-execute, in order. Wire your actual per-test run functions
 * (testBatteryHealthAndroid, runSensorTest, etc.) to consume this list.
 */
export function prepareBulkRedo(results: DiagnosticResult[]): {
  clearedResults: DiagnosticResult[];
  testIdsToRerun: string[];
} {
  const flagged = getFlaggedTests(results);
  const testIdsToRerun = flagged.map((r) => r.testId);
  return {
    clearedResults: clearTestsForRedo(results, testIdsToRerun),
    testIdsToRerun,
  };
}

/**
 * Appends freshly-run results after a redo (bulk or single), replacing
 * whatever was previously recorded for those testIds. Use this rather
 * than a plain array push so a partial redo (e.g. user backs out after
 * redoing only 2 of 3 flagged tests) can't leave the session in a mixed
 * state where a testId has zero entries.
 */
export function applyRedoneResults(
  results: DiagnosticResult[],
  redoneResults: DiagnosticResult[]
): DiagnosticResult[] {
  const redoneIds = new Set(redoneResults.map((r) => r.testId));
  const kept = results.filter((r) => !redoneIds.has(r.testId));
  return [...kept, ...redoneResults];
}
