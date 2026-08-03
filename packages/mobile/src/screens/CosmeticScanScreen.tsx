// src/screens/CosmeticScanScreen.tsx
//
// Mobile Steps 13-14 — "Photo N of 6" and "We spotted something"
// (ui_journey_premium.html). Guided six-angle capture followed by the
// technician assigning the cosmetic grade.
//
// Automated damage detection is NOT wired up: it needs the hosted model
// from CLAUDE.md's "Cosmetic grading (AI-assisted)" section, which is
// Sprint 7 work. The roadmap scopes this sprint to capture plus manual
// grading, and the screen says so plainly rather than implying the
// photos were analysed.
//
// No suggested grade is shown while detection is unavailable — see
// lib/cosmeticCapture.ts for why offering one would be actively
// misleading rather than merely useless.

import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { applyRedoneResults } from '../lib/testSession';
import {
  CAPTURE_ANGLES,
  GRADES,
  GRADE_DESCRIPTIONS,
  buildGradingResult,
  gradingProvenanceNote,
  isCaptureComplete,
  isDamageDetectionAvailable,
  remainingAngles,
  type CapturedAngle,
  type CosmeticGrade,
} from '../lib/cosmeticCapture';

type Props = NativeStackScreenProps<RootStackParamList, 'CosmeticScan'>;

export function CosmeticScanScreen({ navigation }: Props) {
  const { results, setResults } = useSession();
  const camera = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [captured, setCaptured] = useState<CapturedAngle[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grading, setGrading] = useState(false);

  const detectionRan = isDamageDetectionAvailable();
  const outstanding = useMemo(() => remainingAngles(captured), [captured]);
  const currentAngle = outstanding[0];
  const instruction = CAPTURE_ANGLES.find((a) => a.angle === currentAngle)?.instruction;

  const takeShot = async () => {
    if (!camera.current || !currentAngle) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await camera.current.takePhoto();
      setCaptured((prev) => [...prev, { angle: currentAngle, imageUri: `file://${photo.path}` }]);
    } catch {
      setError('Could not capture that photo. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const recordGrade = (grade: CosmeticGrade) => {
    const gradingResult = buildGradingResult(captured, grade, detectionRan);
    setResults(
      applyRedoneResults(results, [
        {
          testId: 'cosmetic_grading',
          label: 'Cosmetic Grading',
          // A cosmetic grade is an observation, not a pass/fail — a
          // grade D device is accurately graded, not a failed test.
          // Routing decides what happens to it (deviceRouting.ts).
          status: grade === 'D' ? 'warning' : 'pass',
          value: grade,
          notes: gradingProvenanceNote(captured, detectionRan),
          // Human-observed, so provenance is manual — the report must
          // not present this as a machine reading.
          source: 'manual',
          timestamp: gradingResult.timestamp,
        },
      ]),
    );
    navigation.goBack();
  };

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.body}>Camera access is needed to photograph the device.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Camera Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- Grading step -------------------------------------------------
  if (grading || isCaptureComplete(captured)) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Grade the condition</Text>
        <Text style={styles.body}>
          {captured.length} of {CAPTURE_ANGLES.length} angles photographed.
        </Text>

        {!detectionRan && (
          <View style={styles.warnBox}>
            <Text style={styles.warnText}>
              Automated damage detection isn't available in this build, so no grade is suggested. Assess the device
              yourself — the photos are stored with the report either way.
            </Text>
          </View>
        )}

        <View style={styles.thumbRow}>
          {captured.map((c) => (
            <View key={c.angle} style={styles.thumbWrap}>
              <Image source={{ uri: c.imageUri }} style={styles.thumb} />
              <Text style={styles.thumbLabel}>{c.angle}</Text>
            </View>
          ))}
        </View>

        {GRADES.map((grade) => (
          <TouchableOpacity key={grade} style={styles.gradeRow} onPress={() => recordGrade(grade)}>
            <Text style={styles.gradeLetter}>{grade}</Text>
            <Text style={styles.gradeDesc}>{GRADE_DESCRIPTIONS[grade]}</Text>
          </TouchableOpacity>
        ))}

        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.link}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // --- Capture step -------------------------------------------------
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        Photo {captured.length + 1} of {CAPTURE_ANGLES.length} — {currentAngle}
      </Text>
      <Text style={styles.body}>{instruction}</Text>

      <View style={styles.cameraWrap}>
        {device ? (
          <Camera ref={camera} style={StyleSheet.absoluteFill} device={device} isActive={!busy} photo />
        ) : (
          <Text style={styles.cameraFallback}>No camera available.</Text>
        )}
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <TouchableOpacity style={styles.button} onPress={() => void takeShot()} disabled={busy || !device}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Capture {currentAngle}</Text>}
      </TouchableOpacity>

      {captured.length > 0 && (
        // A partial capture is recorded honestly as a partial capture,
        // rather than being padded or blocked — a technician may not be
        // able to photograph every angle of a damaged device.
        <TouchableOpacity onPress={() => setGrading(true)}>
          <Text style={styles.link}>Skip remaining angles and grade now</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Back to checklist</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 6, textTransform: 'capitalize' },
  body: { fontSize: 14, color: '#334155', marginBottom: 12, lineHeight: 20 },
  cameraWrap: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFallback: { color: '#fff' },
  thumbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  thumbWrap: { alignItems: 'center' },
  thumb: { width: 64, height: 64, borderRadius: 6, backgroundColor: '#e2e8f0' },
  thumbLabel: { fontSize: 10, color: '#64748b', marginTop: 2, textTransform: 'capitalize' },
  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    marginTop: 10,
  },
  gradeLetter: { fontSize: 22, fontWeight: '700', color: '#2563eb', width: 36 },
  gradeDesc: { flex: 1, fontSize: 13, color: '#334155' },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 12, marginBottom: 12 },
  warnText: { color: '#92400e', fontSize: 12, lineHeight: 17 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
});
