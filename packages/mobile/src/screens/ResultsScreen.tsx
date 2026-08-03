// src/screens/ResultsScreen.tsx
//
// Mobile Step 15 — "Here's how your phone did" (ui_journey_premium.html).
// Shows every result, offers the bulk "Redo Flagged (N)" action from
// CLAUDE.md, and submits the finished report to the API.
//
// Submission is the end of the technician flow and the point where a
// license credit is consumed, so it is deliberately explicit — there is
// no auto-submit on arrival.

import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { countFlaggedTests, computeOverallStatus, prepareBulkRedo } from '../lib/testSession';
import { ApiError, createReport } from '../api/client';
import type { CapturedIdentity } from '../lib/deviceIdentity';

type Props = NativeStackScreenProps<RootStackParamList, 'Results'>;

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  pass: { dot: '#16a34a', label: 'Pass' },
  fail: { dot: '#dc2626', label: 'Fail' },
  warning: { dot: '#d97706', label: 'Check' },
  skipped: { dot: '#94a3b8', label: 'Skipped' },
};

export function ResultsScreen({ navigation }: Props) {
  const { technician, profile, device, results, setResults } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flaggedCount = useMemo(() => countFlaggedTests(results), [results]);
  const passCount = useMemo(() => results.filter((r) => r.status === 'pass').length, [results]);
  const overall = useMemo(() => computeOverallStatus(results), [results]);

  const handleRedoFlagged = () => {
    const { clearedResults, testIdsToRerun } = prepareBulkRedo(results);
    if (testIdsToRerun.length === 0) return;
    // Clearing before re-running is what keeps a redo a replacement
    // rather than an append — see lib/testSession.ts.
    setResults(clearedResults);
    navigation.navigate('Checklist');
  };

  const handleSubmit = async () => {
    if (!technician || !device) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createReport(technician.token, {
        device: device as CapturedIdentity,
        results,
        profileId: profile?.profileId,
      });
      navigation.replace('Complete', { reportId: created.reportId });
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Could not submit the report — check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!technician || !device) {
    // Reached without a session (deep link, dev reload).
    navigation.replace('TechnicianLogin');
    return null;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Here's how it did</Text>
      <Text style={styles.subtitle}>
        {device.make} {device.model} · {results.length} checks
      </Text>

      <View style={styles.statRow}>
        <View style={styles.statCard}>
          <Text style={[styles.statNum, { color: '#16a34a' }]}>{passCount}</Text>
          <Text style={styles.statLabel}>All good</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statNum, { color: '#d97706' }]}>{flaggedCount}</Text>
          <Text style={styles.statLabel}>Worth a look</Text>
        </View>
      </View>

      {results.length === 0 ? (
        <Text style={styles.empty}>No checks have been run yet.</Text>
      ) : (
        results.map((result) => {
          const style = STATUS_STYLE[result.status] ?? STATUS_STYLE.skipped;
          return (
            <View key={result.testId} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: style.dot }]} />
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>{result.label}</Text>
                {result.notes ? <Text style={styles.rowNote}>{result.notes}</Text> : null}
              </View>
              <Text style={styles.rowStatus}>
                {result.value !== undefined ? `${result.value} · ` : ''}
                {style.label}
              </Text>
            </View>
          );
        })
      )}

      {flaggedCount > 0 && (
        // Live count, and only the flagged tests are re-run — passing
        // tests are left untouched, per CLAUDE.md. Not a "start over".
        <TouchableOpacity style={styles.secondaryButton} onPress={handleRedoFlagged}>
          <Text style={styles.secondaryButtonText}>Redo Flagged ({flaggedCount})</Text>
        </TouchableOpacity>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, (submitting || results.length === 0) && styles.buttonDisabled]}
        onPress={() => void handleSubmit()}
        disabled={submitting || results.length === 0}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Submit report ({overall.replace(/_/g, ' ')})</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 2 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16 },
  statRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: '#f8fafc', borderRadius: 10, padding: 14, alignItems: 'center' },
  statNum: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 11, color: '#64748b', marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 10 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 14, color: '#0f172a' },
  rowNote: { fontSize: 11, color: '#64748b', marginTop: 2 },
  rowStatus: { fontSize: 12, color: '#475569', marginLeft: 8 },
  empty: { color: '#94a3b8', textAlign: 'center', paddingVertical: 24 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 20 },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  secondaryButtonText: { color: '#2563eb', fontWeight: '600' },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 16 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
});
