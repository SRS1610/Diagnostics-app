// src/lib/testSession.ts
//
// Mirrors packages/shared/src/testSession.ts's redo rules. Not imported
// from @diagnostics/shared for the same Metro-bundler reason as
// src/lib/qrPayloads.ts — keep the two in sync by hand.
//
// The rule these functions exist to enforce (CLAUDE.md, "Redo / retest
// capability"): "A redo replaces the prior result outright — never
// append a second entry for the same testId", so summary counts and the
// report always reflect the latest run, and a partial redo can't leave a
// testId with duplicate or zero entries.

import type { DiagnosticResultInput } from '../api/client';

export function getFlaggedTests(results: DiagnosticResultInput[]): DiagnosticResultInput[] {
  // Deliberately fail + warning only. "skipped" is not a failure — it
  // means not applicable (no cable, no such sensor), so sweeping it into
  // a redo would ask the technician to re-run tests that cannot pass.
  return results.filter((r) => r.status === 'fail' || r.status === 'warning');
}

export function countFlaggedTests(results: DiagnosticResultInput[]): number {
  return getFlaggedTests(results).length;
}

export function clearTestsForRedo(results: DiagnosticResultInput[], testIds: string[]): DiagnosticResultInput[] {
  const idSet = new Set(testIds);
  return results.filter((r) => !idSet.has(r.testId));
}

export function prepareBulkRedo(results: DiagnosticResultInput[]): {
  clearedResults: DiagnosticResultInput[];
  testIdsToRerun: string[];
} {
  const testIdsToRerun = getFlaggedTests(results).map((r) => r.testId);
  return { clearedResults: clearTestsForRedo(results, testIdsToRerun), testIdsToRerun };
}

/**
 * Replaces prior entries for any testId being re-run, rather than
 * appending. Using a plain push here is the bug this function exists to
 * prevent: it would leave two rows for one test, and the report's
 * summary counts would stop matching its own detail table.
 */
export function applyRedoneResults(
  results: DiagnosticResultInput[],
  redoneResults: DiagnosticResultInput[],
): DiagnosticResultInput[] {
  const redoneIds = new Set(redoneResults.map((r) => r.testId));
  return [...results.filter((r) => !redoneIds.has(r.testId)), ...redoneResults];
}

/** Mirrors computeOverallStatus in packages/shared/src/types.ts. The API
 *  recomputes this server-side regardless; this drives the UI summary. */
export function computeOverallStatus(
  results: DiagnosticResultInput[],
): 'pass' | 'fail' | 'pass_with_warnings' {
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.some((r) => r.status === 'warning' || r.status === 'skipped')) return 'pass_with_warnings';
  return 'pass';
}
