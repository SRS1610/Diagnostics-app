// src/screens/ChecklistScreen.tsx
//
// Mobile Step 8 — "N of M checks complete" (ui_journey_premium.html).
// The hub for the diagnostic run: lists exactly the tests the customer's
// profile enables, tracks which are done, and lets the technician tap
// any one to run or re-run it (the single-test redo path from CLAUDE.md).

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { resolveEnabledTests } from '../lib/testCatalog';

type Props = NativeStackScreenProps<RootStackParamList, 'Checklist'>;

const STATUS_COLOR: Record<string, string> = {
  pass: '#16a34a',
  fail: '#dc2626',
  warning: '#d97706',
  skipped: '#94a3b8',
};

export function ChecklistScreen({ navigation }: Props) {
  const { profile, results } = useSession();

  const { runnable, unknown } = useMemo(
    () => resolveEnabledTests(profile?.enabledTestIds ?? []),
    [profile],
  );

  const resultByTestId = useMemo(
    () => new Map(results.map((r) => [r.testId, r])),
    [results],
  );

  const completed = runnable.filter((entry) => resultByTestId.has(entry.testId)).length;
  const allDone = completed === runnable.length && runnable.length > 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        {completed} of {runnable.length} checks complete
      </Text>
      <Text style={styles.subtitle}>
        {profile?.customerName ?? 'This profile'} · tap any check to run it
      </Text>

      {runnable.length === 0 && (
        <Text style={styles.empty}>This profile has no tests configured.</Text>
      )}

      {runnable.map((entry) => {
        const result = resultByTestId.get(entry.testId);
        return (
          <TouchableOpacity
            key={entry.testId}
            style={styles.row}
            onPress={() =>
              entry.kind === 'cosmetic'
                ? navigation.navigate('CosmeticScan')
                : navigation.navigate('RunTest', { testId: entry.testId })
            }
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: result ? STATUS_COLOR[result.status] ?? '#94a3b8' : '#e2e8f0' },
              ]}
            />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel}>{entry.label}</Text>
              <Text style={styles.rowComponent}>{entry.component}</Text>
            </View>
            <Text style={styles.rowAction}>{result ? 'Redo' : 'Run'}</Text>
          </TouchableOpacity>
        );
      })}

      {/* A profile configured with a test this build can't run must be
          visible. Hiding it would produce a report that looks complete
          while silently omitting something the customer asked for. */}
      {unknown.length > 0 && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            This profile requests {unknown.length} test{unknown.length > 1 ? 's' : ''} this app version doesn't
            recognise: {unknown.join(', ')}. They will not appear in the report.
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, !allDone && styles.buttonSecondary]}
        onPress={() => navigation.navigate('Results')}
        disabled={results.length === 0}
      >
        <Text style={[styles.buttonText, !allDone && styles.buttonSecondaryText]}>
          {allDone ? 'See results' : `Skip ahead to results (${completed} run)`}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16 },
  empty: { color: '#94a3b8', textAlign: 'center', paddingVertical: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, color: '#0f172a' },
  rowComponent: { fontSize: 11, color: '#94a3b8', marginTop: 1 },
  rowAction: { color: '#2563eb', fontWeight: '600', fontSize: 13 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 24 },
  buttonSecondary: { backgroundColor: '#f1f5f9' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  buttonSecondaryText: { color: '#475569' },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 12, marginTop: 16 },
  warnText: { color: '#92400e', fontSize: 12, lineHeight: 17 },
});
