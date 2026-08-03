// src/screens/ConfirmScreen.tsx
//
// Mobile Step 7 — "Does this look right?" (ui_journey_premium.html).
// CLAUDE.md requires this step for every capture path: "Technician
// confirms/edits the scanned value before it's locked into the report
// (OCR misreads like 0/O, 1/I are common)."
//
// Two deliberate behaviours:
//  - Errors block; warnings don't. A failed IMEI checksum is shown
//    prominently but is overridable, because a genuinely worn or
//    nonstandard label shouldn't strand an inspection. A wrong LENGTH is
//    a hard error, since the API rejects it anyway.
//  - Editing any field flips captureSource to "manual" for provenance.
//    The report distinguishes machine-read from human-entered values,
//    and a scanned-then-corrected number is no longer machine-read.

import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { validateIdentity } from '../lib/deviceIdentity';

type Props = NativeStackScreenProps<RootStackParamList, 'Confirm'>;

const SOURCE_LABEL: Record<string, string> = {
  barcode: 'Scanned from barcode',
  ocr: 'Read from photo',
  manual: 'Entered by hand',
};

export function ConfirmScreen({ navigation }: Props) {
  const { device, setDevice } = useSession();

  const [make, setMake] = useState(device?.make ?? '');
  const [model, setModel] = useState(device?.model ?? '');
  const [serialNumber, setSerialNumber] = useState(device?.serialNumber ?? '');
  const [imei, setImei] = useState(device?.imei ?? '');
  const [imei2, setImei2] = useState(device?.imei2 ?? '');
  const [edited, setEdited] = useState(false);
  const [showSecondImei, setShowSecondImei] = useState(Boolean(device?.imei2));

  const originalSource = device?.captureSource ?? 'manual';
  const effectiveSource = edited ? 'manual' : originalSource;

  const { errors, warnings } = useMemo(
    () => validateIdentity({ make, model, serialNumber, imei, imei2: imei2 || undefined }),
    [make, model, serialNumber, imei, imei2],
  );

  if (!device) {
    // Reached without capturing anything (deep link, dev reload).
    navigation.replace('FindYourId');
    return null;
  }

  const bind = (setter: (v: string) => void) => (v: string) => {
    setEdited(true);
    setter(v);
  };

  const handleConfirm = () => {
    if (errors.length > 0) return;
    setDevice({
      make: make.trim(),
      model: model.trim(),
      serialNumber: serialNumber.trim(),
      imei: imei.trim(),
      imei2: imei2.trim() || undefined,
      captureSource: effectiveSource,
    });
    navigation.navigate('Checklist');
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Does this look right?</Text>
      <Text style={styles.subtitle}>We read these automatically. Edit anything that needs a fix.</Text>

      <View style={styles.sourceBadge}>
        <Text style={styles.sourceText}>{SOURCE_LABEL[effectiveSource]}</Text>
      </View>

      <Text style={styles.label}>Make</Text>
      <TextInput style={styles.input} value={make} onChangeText={bind(setMake)} autoCorrect={false} />

      <Text style={styles.label}>Model</Text>
      <TextInput style={styles.input} value={model} onChangeText={bind(setModel)} autoCorrect={false} />

      <Text style={styles.label}>Serial number</Text>
      <TextInput
        style={styles.input}
        value={serialNumber}
        onChangeText={bind(setSerialNumber)}
        autoCapitalize="characters"
        autoCorrect={false}
      />

      <Text style={styles.label}>IMEI</Text>
      <TextInput
        style={styles.input}
        value={imei}
        onChangeText={bind(setImei)}
        keyboardType="number-pad"
        maxLength={15}
      />

      {showSecondImei ? (
        <>
          <Text style={styles.label}>Second IMEI (dual-SIM)</Text>
          <TextInput
            style={styles.input}
            value={imei2}
            onChangeText={bind(setImei2)}
            keyboardType="number-pad"
            maxLength={15}
          />
        </>
      ) : (
        <TouchableOpacity onPress={() => setShowSecondImei(true)}>
          <Text style={styles.link}>+ This is a dual-SIM device</Text>
        </TouchableOpacity>
      )}

      {errors.map((e) => (
        <View key={e} style={styles.errorBox}>
          <Text style={styles.errorText}>{e}</Text>
        </View>
      ))}

      {warnings.map((w) => (
        <View key={w} style={styles.warnBox}>
          <Text style={styles.warnText}>{w}</Text>
        </View>
      ))}

      <TouchableOpacity
        style={[styles.button, errors.length > 0 && styles.buttonDisabled]}
        onPress={handleConfirm}
        disabled={errors.length > 0}
      >
        <Text style={styles.buttonText}>
          {warnings.length > 0 && errors.length === 0 ? 'Confirm anyway' : 'Confirm and continue'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Re-scan instead</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 12 },
  sourceBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#e0e7ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  sourceText: { color: '#3730a3', fontSize: 11, fontWeight: '600' },
  label: { fontSize: 12, color: '#475569', marginBottom: 4, marginTop: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12 },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 20,
  },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 14 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#b91c1c' },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 12, marginTop: 12 },
  warnText: { color: '#92400e' },
});
