/**
 * @format
 */

import {
  applyRedoneResults,
  clearTestsForRedo,
  computeOverallStatus,
  countFlaggedTests,
  getFlaggedTests,
  prepareBulkRedo,
} from '../src/lib/testSession';
import type { DiagnosticResultInput } from '../src/api/client';

const r = (
  testId: string,
  status: DiagnosticResultInput['status'],
  extra: Partial<DiagnosticResultInput> = {},
): DiagnosticResultInput => ({
  testId,
  label: testId,
  status,
  source: 'api',
  timestamp: '2026-08-03T12:00:00Z',
  ...extra,
});

describe('flagged tests', () => {
  const results = [r('a', 'pass'), r('b', 'fail'), r('c', 'warning'), r('d', 'skipped')];

  it('counts fail and warning', () => {
    expect(countFlaggedTests(results)).toBe(2);
    expect(getFlaggedTests(results).map((x) => x.testId)).toEqual(['b', 'c']);
  });

  // "skipped" means not applicable — no cable, no such sensor. Redoing
  // it would ask the technician to re-run something that cannot pass.
  it('does not flag skipped tests', () => {
    expect(getFlaggedTests(results).some((x) => x.status === 'skipped')).toBe(false);
  });
});

describe('bulk redo', () => {
  const results = [r('a', 'pass'), r('b', 'fail'), r('c', 'warning')];

  it('clears only the flagged entries and leaves passes intact', () => {
    const { clearedResults, testIdsToRerun } = prepareBulkRedo(results);
    expect(testIdsToRerun).toEqual(['b', 'c']);
    expect(clearedResults.map((x) => x.testId)).toEqual(['a']);
  });

  it('is a no-op when nothing is flagged', () => {
    const clean = [r('a', 'pass')];
    const { clearedResults, testIdsToRerun } = prepareBulkRedo(clean);
    expect(testIdsToRerun).toEqual([]);
    expect(clearedResults).toEqual(clean);
  });
});

describe('applyRedoneResults', () => {
  // The core invariant: a redo REPLACES, never appends. Appending would
  // leave two rows for one test and desync the report's summary counts
  // from its own detail table.
  it('replaces the prior entry rather than adding a second one', () => {
    const before = [r('a', 'pass'), r('b', 'fail')];
    const after = applyRedoneResults(before, [r('b', 'pass')]);

    expect(after).toHaveLength(2);
    expect(after.filter((x) => x.testId === 'b')).toHaveLength(1);
    expect(after.find((x) => x.testId === 'b')?.status).toBe('pass');
  });

  it('leaves untouched tests alone', () => {
    const before = [r('a', 'pass'), r('b', 'fail')];
    const after = applyRedoneResults(before, [r('b', 'pass')]);
    expect(after.find((x) => x.testId === 'a')?.status).toBe('pass');
  });

  // A technician backing out halfway must not leave a test with zero
  // entries or two.
  it('keeps every testId exactly once after a partial redo', () => {
    const before = [r('a', 'fail'), r('b', 'fail'), r('c', 'fail')];
    const { clearedResults, testIdsToRerun } = prepareBulkRedo(before);
    expect(testIdsToRerun).toHaveLength(3);

    // Only two of the three get re-run before the technician stops.
    const after = applyRedoneResults(clearedResults, [r('a', 'pass'), r('b', 'pass')]);

    const ids = after.map((x) => x.testId).sort();
    expect(ids).toEqual(['a', 'b']);
    expect(new Set(ids).size).toBe(ids.length);
    // 'c' was cleared and not re-run — it must be absent, not duplicated
    // or stale, so the UI still shows it as outstanding.
    expect(after.some((x) => x.testId === 'c')).toBe(false);
  });

  it('handles redoing every test at once', () => {
    const before = [r('a', 'fail'), r('b', 'warning')];
    const after = applyRedoneResults(before, [r('a', 'pass'), r('b', 'pass')]);
    expect(after).toHaveLength(2);
    expect(after.every((x) => x.status === 'pass')).toBe(true);
  });
});

describe('clearTestsForRedo', () => {
  it('removes the named ids', () => {
    expect(clearTestsForRedo([r('a', 'pass'), r('b', 'fail')], ['b']).map((x) => x.testId)).toEqual(['a']);
  });
});

describe('computeOverallStatus', () => {
  it('fails if anything failed', () => {
    expect(computeOverallStatus([r('a', 'pass'), r('b', 'fail')])).toBe('fail');
  });

  it('is pass_with_warnings for warnings or skips', () => {
    expect(computeOverallStatus([r('a', 'pass'), r('b', 'warning')])).toBe('pass_with_warnings');
    expect(computeOverallStatus([r('a', 'pass'), r('b', 'skipped')])).toBe('pass_with_warnings');
  });

  it('passes only when everything passed', () => {
    expect(computeOverallStatus([r('a', 'pass'), r('b', 'pass')])).toBe('pass');
  });

  it('prefers fail over warning when both are present', () => {
    expect(computeOverallStatus([r('a', 'warning'), r('b', 'fail')])).toBe('fail');
  });
});
