// src/screens/CompleteScreen.tsx
//
// Mobile Step 17 — "All checks complete" (ui_journey_premium.html).
// The report is already persisted by the time this screen is reached;
// PDF generation happens here, on demand, because it is a local
// artefact rather than part of submission.
//
// Generation is explicitly triggered rather than automatic: it writes a
// file to the device, and CLAUDE.md treats IMEI/serial as sensitive, so
// producing a document containing them should be a deliberate act.

import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { computeOverallStatus, countFlaggedTests } from '../lib/testSession';
import { generateReportPdf } from '../lib/reportPdf';
import type { CapturedIdentity } from '../lib/deviceIdentity';

type Props = NativeStackScreenProps<RootStackParamList, 'Complete'>;

export function CompleteScreen({ route, navigation }: Props) {
  const reportId = route.params?.reportId;
  const { technician, device, results, reset } = useSession();

  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passCount = results.filter((r) => r.status === 'pass').length;
  const flaggedCount = countFlaggedTests(results);

  const handleGeneratePdf = async () => {
    if (!device || !reportId) return;
    setBusy(true);
    setError(null);
    try {
      const path = await generateReportPdf({
        reportId,
        generatedAt: new Date().toISOString(),
        technicianId: technician?.technicianId,
        device: device as CapturedIdentity,
        results,
        overallStatus: computeOverallStatus(results),
      });
      setPdfPath(path);
    } catch {
      // The report itself is already safely stored server-side, so a PDF
      // failure is an inconvenience rather than lost work — say so
      // instead of implying the inspection needs redoing.
      setError('Could not generate the PDF. The report is already saved and can be exported from the portal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.check}>
        <Text style={styles.checkMark}>✓</Text>
      </View>

      <Text style={styles.title}>All checks complete</Text>
      {reportId && <Text style={styles.reportId}>{reportId}</Text>}

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

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {pdfPath ? (
        <View style={styles.successBox}>
          <Text style={styles.successText}>PDF saved to the device.</Text>
          <Text style={styles.pathText} numberOfLines={2}>
            {pdfPath}
          </Text>
        </View>
      ) : (
        <TouchableOpacity style={styles.button} onPress={() => void handleGeneratePdf()} disabled={busy || !device}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Generate PDF report</Text>}
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.secondaryButton}
        onPress={() => {
          // Clear the session before the next device, so nothing from
          // this inspection can leak into the next one's report.
          reset();
          navigation.reset({ index: 0, routes: [{ name: 'ScanProfile' }] });
        }}
      >
        <Text style={styles.secondaryButtonText}>Start next device</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1, alignItems: 'center' },
  check: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#dcfce7',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
    marginBottom: 16,
  },
  checkMark: { color: '#16a34a', fontSize: 32, fontWeight: '700' },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  reportId: { fontSize: 12, color: '#64748b', marginBottom: 20 },
  statRow: { flexDirection: 'row', gap: 12, alignSelf: 'stretch', marginBottom: 8 },
  statCard: { flex: 1, backgroundColor: '#f8fafc', borderRadius: 10, padding: 14, alignItems: 'center' },
  statNum: { fontSize: 24, fontWeight: '700' },
  statLabel: { fontSize: 11, color: '#64748b', marginTop: 2 },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 16,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 12,
  },
  secondaryButtonText: { color: '#2563eb', fontWeight: '600' },
  successBox: { backgroundColor: '#dcfce7', borderRadius: 8, padding: 14, alignSelf: 'stretch', marginTop: 16 },
  successText: { color: '#15803d', fontWeight: '600', textAlign: 'center' },
  pathText: { color: '#166534', fontSize: 10, textAlign: 'center', marginTop: 6 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, alignSelf: 'stretch', marginTop: 16 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
});
