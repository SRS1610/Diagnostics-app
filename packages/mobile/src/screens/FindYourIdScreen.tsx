// src/screens/FindYourIdScreen.tsx
//
// Mobile Step 6 — "Scan the barcode" (ui_journey_premium.html). Captures
// device identity via the three-tier flow CLAUDE.md specifies:
//   1. Barcode scan (SIM tray, back label, or the *#06# screen) — primary
//   2. On-device OCR for printed digits with no barcode — fallback
//   3. Manual entry — always available, final fallback
// Whichever path is used, the technician confirms on the next screen
// before anything is locked in.
//
// Make and model are the exception: those ARE readable programmatically
// (Build.MODEL/MANUFACTURER, UIDevice.model) so they're pre-filled from
// react-native-device-info. IMEI and serial are NOT — see CLAUDE.md's
// "CRITICAL platform constraint" — and no attempt is made to read them.
//
// IMPORTANT: this identifies the device the app is RUNNING ON only if
// the technician is inspecting that same handset. For a warehouse tablet
// inspecting a separate device, the auto-filled make/model are the
// tablet's and must be corrected on the Confirm screen. Surfaced in the
// UI rather than left as a silent trap.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import DeviceInfo from 'react-native-device-info';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import type { RootStackParamList } from '../navigation/types';
import { DEVICE_LABEL_CODES, QrScannerView } from '../components/QrScannerView';
import { extractImeiFromBarcode, extractImeiFromText, extractSerialFromText } from '../lib/deviceIdentity';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'FindYourId'>;
type Mode = 'scan' | 'ocr' | 'manual';

export function FindYourIdScreen({ navigation }: Props) {
  const { setDevice } = useSession();
  const [mode, setMode] = useState<Mode>('scan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [imei, setImei] = useState('');
  const [serialNumber, setSerialNumber] = useState('');

  const camera = React.useRef<Camera>(null);
  const ocrDevice = useCameraDevice('back');

  // Make/model are freely available; IMEI/serial are not. Pre-filling
  // only what the OS actually exposes.
  useEffect(() => {
    setMake(DeviceInfo.getBrand());
    setModel(DeviceInfo.getModel());
  }, []);

  const handoff = useCallback(
    (captureSource: 'barcode' | 'ocr' | 'manual', values: { imei?: string; serialNumber?: string }) => {
      setDevice({
        make,
        model,
        imei: values.imei ?? imei,
        serialNumber: values.serialNumber ?? serialNumber,
        captureSource,
      });
      navigation.navigate('Confirm');
    },
    [make, model, imei, serialNumber, navigation, setDevice],
  );

  const handleBarcode = useCallback(
    (raw: string) => {
      const scanned = extractImeiFromBarcode(raw);
      if (!scanned) {
        setError("That code doesn't contain a 15-digit IMEI. Try again, use the photo option, or type it in.");
        return;
      }
      handoff('barcode', { imei: scanned });
    },
    [handoff],
  );

  // OCR path: take a still, run ML Kit locally over it. On-device, so it
  // works with no connectivity — see CLAUDE.md's offline notes.
  const handleOcrCapture = useCallback(async () => {
    if (!camera.current) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await camera.current.takePhoto();
      const result = await TextRecognition.recognize(`file://${photo.path}`);
      const foundImei = extractImeiFromText(result.text);
      const foundSerial = extractSerialFromText(result.text);

      if (!foundImei && !foundSerial) {
        setError('Could not read an IMEI or serial from that photo. Try again with better light, or type it in.');
        return;
      }
      handoff('ocr', { imei: foundImei ?? undefined, serialNumber: foundSerial ?? undefined });
    } catch {
      setError('Could not process that photo. Try again, or type the number in.');
    } finally {
      setBusy(false);
    }
  }, [handoff]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Find the device ID</Text>
      <Text style={styles.subtitle}>
        Check the box, the SIM tray, or dial <Text style={styles.mono}>*#06#</Text> on the device being inspected.
      </Text>

      <View style={styles.tabs}>
        {(['scan', 'ocr', 'manual'] as Mode[]).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.tab, mode === m && styles.tabActive]}
            onPress={() => {
              setError(null);
              setMode(m);
            }}
          >
            <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>
              {m === 'scan' ? 'Scan' : m === 'ocr' ? 'Photo' : 'Type it'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Text style={styles.linkText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {mode === 'scan' && (
        <QrScannerView onScanned={handleBarcode} active={!error && !busy} codeTypes={DEVICE_LABEL_CODES} />
      )}

      {mode === 'ocr' && (
        <View>
          {ocrDevice ? (
            <View style={styles.cameraWrap}>
              <Camera ref={camera} style={StyleSheet.absoluteFill} device={ocrDevice} isActive={!busy} photo />
            </View>
          ) : (
            <View style={styles.cameraWrap}>
              <Text style={styles.cameraFallback}>No camera available.</Text>
            </View>
          )}
          <TouchableOpacity style={styles.button} onPress={() => void handleOcrCapture()} disabled={busy || !ocrDevice}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Read the label</Text>}
          </TouchableOpacity>
          <Text style={styles.hint}>
            Point at the printed IMEI or serial. Reading happens on the device — no network needed.
          </Text>
        </View>
      )}

      {mode === 'manual' && (
        <View>
          <Text style={styles.label}>IMEI (15 digits)</Text>
          <TextInput
            style={styles.input}
            value={imei}
            onChangeText={setImei}
            keyboardType="number-pad"
            placeholder="356938035643809"
            maxLength={15}
          />
          <Text style={styles.label}>Serial number</Text>
          <TextInput
            style={styles.input}
            value={serialNumber}
            onChangeText={setSerialNumber}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.button, !imei.trim() && !serialNumber.trim() && styles.buttonDisabled]}
            onPress={() => handoff('manual', {})}
            disabled={!imei.trim() && !serialNumber.trim()}
          >
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.note}>
        Make and model are filled in automatically from the device running this app. If you're inspecting a different
        handset, correct them on the next screen.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16 },
  mono: { fontWeight: '700', color: '#111' },
  tabs: { flexDirection: 'row', backgroundColor: '#f1f5f9', borderRadius: 8, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
  tabActive: { backgroundColor: '#fff' },
  tabText: { color: '#64748b', fontWeight: '500' },
  tabTextActive: { color: '#111', fontWeight: '700' },
  cameraWrap: {
    width: '100%',
    height: 280,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFallback: { color: '#fff' },
  label: { fontSize: 12, color: '#475569', marginBottom: 4, marginTop: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  linkText: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingTop: 8 },
  hint: { color: '#64748b', fontSize: 12, textAlign: 'center', paddingTop: 10 },
  note: { color: '#94a3b8', fontSize: 11, marginTop: 24, lineHeight: 16 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginBottom: 12 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
});
