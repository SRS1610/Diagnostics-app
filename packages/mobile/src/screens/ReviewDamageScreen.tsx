// src/screens/ReviewDamageScreen.tsx
//
// Mobile Step 15 — "We spotted something" (ui_journey_premium.html).
// Read-back of the cosmetic scan: the six-angle photos and the grade the
// technician assigned, so nothing is submitted before it can be
// double-checked.
//
// Under the CV-model story (CLAUDE.md, "Cosmetic grading (AI-assisted)"),
// this is also where annotated bounding boxes would render over each
// photo. That model isn't wired up in this build (Sprint 7), so the
// screen says so — showing "AI-annotated" chrome we don't actually have
// would misrepresent what the report is based on.
//
// Nothing here mutates results. The grade was locked in from
// CosmeticScanScreen; changing it here would be a redo, which the
// checklist / RunTest flow already handles. This screen's only jobs
// are: show the evidence, and hand off to the offer / results.

import React from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { GRADE_DESCRIPTIONS, isDamageDetectionAvailable, type CosmeticGrade } from '../lib/cosmeticCapture';

type Props = NativeStackScreenProps<RootStackParamList, 'ReviewDamage'>;

export function ReviewDamageScreen({ navigation }: Props) {
  const { results } = useSession();
  const cosmetic = results.find((r) => r.testId === 'cosmetic_grading');
  const grade = cosmetic?.value as CosmeticGrade | undefined;
  const detectionRan = isDamageDetectionAvailable();

  // Photo URIs live in the notes field's provenance string
  // (gradingProvenanceNote joins them), so we don't have direct access
  // here — the CosmeticGradingResult isn't stored in session state past
  // the DiagnosticResult write. Rather than reach back into a filesystem
  // scan, this screen references the count from the note text.

  if (!cosmetic) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Nothing to review yet</Text>
        <Text style={styles.body}>
          No cosmetic grading has been recorded for this device. Run the cosmetic scan first.
        </Text>
        <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('CosmeticScan')}>
          <Text style={styles.buttonText}>Go to cosmetic scan</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.replace('Results')}>
          <Text style={styles.link}>Skip and go to results</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Review the cosmetic grade</Text>
      <Text style={styles.subtitle}>
        Confirm the grade before it's locked into the report and the offer is calculated.
      </Text>

      <View style={styles.gradeCard}>
        <Text style={styles.gradeLetter}>{grade ?? '?'}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.gradeTitle}>Grade {grade}</Text>
          <Text style={styles.gradeDesc}>{grade ? GRADE_DESCRIPTIONS[grade] : 'Unknown grade'}</Text>
        </View>
      </View>

      {!detectionRan && (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            No automated damage detection ran on these photos — the grade above was assigned by the technician on
            direct inspection. If a CV model is wired up later (COSMETIC_INFERENCE_ENDPOINT), this screen will show
            annotated bounding boxes over each photo alongside the confirmation prompt.
          </Text>
        </View>
      )}

      {cosmetic.notes && (
        <View style={styles.notesBox}>
          <Text style={styles.notesLabel}>Provenance</Text>
          <Text style={styles.notesText}>{cosmetic.notes}</Text>
        </View>
      )}

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('YourOffer')}>
        <Text style={styles.buttonText}>Confirm — see the offer</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate('CosmeticScan')}>
        <Text style={styles.link}>Re-do the cosmetic scan</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 18, lineHeight: 18 },
  body: { fontSize: 14, color: '#334155', marginBottom: 16, lineHeight: 20 },
  gradeCard: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    backgroundColor: '#f0f9ff', borderRadius: 12, padding: 20, marginBottom: 16,
  },
  gradeLetter: { fontSize: 48, fontWeight: '800', color: '#2563eb', width: 60, textAlign: 'center' },
  gradeTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  gradeDesc: { fontSize: 13, color: '#475569', marginTop: 2, lineHeight: 18 },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 12, marginBottom: 16 },
  warnText: { color: '#92400e', fontSize: 12, lineHeight: 17 },
  notesBox: { backgroundColor: '#f8fafc', borderRadius: 8, padding: 12, marginBottom: 16 },
  notesLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  notesText: { fontSize: 12, color: '#475569', lineHeight: 17 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
});
