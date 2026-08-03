/**
 * @format
 */

import { RUN_CATALOG, getCatalogEntry, resolveEnabledTests } from '../src/lib/testCatalog';

describe('catalog integrity', () => {
  it('has no duplicate testIds', () => {
    const ids = RUN_CATALOG.map((e) => e.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every entry a label and a component for report grouping', () => {
    for (const entry of RUN_CATALOG) {
      expect(entry.label).toBeTruthy();
      expect(entry.component).toBeTruthy();
    }
  });

  // A manual confirmation with no failureNote would record a "no" answer
  // with no explanation of what the technician actually rejected.
  it('gives every manual_confirm a prompt and a failure note', () => {
    for (const entry of RUN_CATALOG.filter((e) => e.kind === 'manual_confirm')) {
      expect(entry.prompt).toBeTruthy();
      expect(entry.failureNote).toBeTruthy();
    }
  });

  // An unavailable test that doesn't say why is indistinguishable from a
  // bug, and would invite someone to "fix" it by making it pass.
  it('makes every unavailable test explain itself', () => {
    for (const entry of RUN_CATALOG.filter((e) => e.kind === 'unavailable')) {
      expect(entry.unavailableReason).toBeTruthy();
    }
  });

  it('keeps the camera visual check separate from any frame check', () => {
    // CLAUDE.md requires front and back as separate rows, and the visual
    // confirmation is manual regardless of what an automated check does.
    const back = getCatalogEntry('camera_back');
    const front = getCatalogEntry('camera_front');
    expect(back?.kind).toBe('manual_confirm');
    expect(front?.kind).toBe('manual_confirm');
    expect(back?.testId).not.toBe(front?.testId);
  });

  // Charge level is not battery health; substituting one for the other
  // would report a fully-charged worn-out battery as healthy.
  it('keeps battery health and charge level as distinct tests', () => {
    expect(getCatalogEntry('battery_health')?.kind).toBe('manual_entry');
    expect(getCatalogEntry('battery_charge_level')?.kind).toBe('auto');
  });
});

describe('resolveEnabledTests', () => {
  it('resolves known ids in the order configured', () => {
    const { runnable, unknown } = resolveEnabledTests(['loud_speaker', 'accelerometer']);
    expect(runnable.map((e) => e.testId)).toEqual(['loud_speaker', 'accelerometer']);
    expect(unknown).toEqual([]);
  });

  // Silently dropping an unrecognised test would produce a report that
  // looks complete while omitting something the customer configured.
  it('reports unknown ids rather than dropping them', () => {
    const { runnable, unknown } = resolveEnabledTests(['loud_speaker', 'not_a_real_test']);
    expect(runnable.map((e) => e.testId)).toEqual(['loud_speaker']);
    expect(unknown).toEqual(['not_a_real_test']);
  });

  it('handles an empty profile', () => {
    expect(resolveEnabledTests([])).toEqual({ runnable: [], unknown: [] });
  });
});
