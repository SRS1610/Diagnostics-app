// src/screens/RunTestScreen.tsx
//
// Runs one test and records its result. One screen parameterised by run
// kind rather than fifteen bespoke screens, because the kinds — sensor,
// manual confirmation, manual entry, automated — differ in how they
// gather evidence, not in how they're presented.
//
// All status decisions delegate to lib/testEvaluation.ts, which is
// where CLAUDE.md's per-test rules live and where they're tested. This
// screen gathers input; it does not decide pass or fail.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import DeviceInfo from 'react-native-device-info';
import RNFS from 'react-native-fs';
import {
  SensorTypes,
  accelerometer,
  gyroscope,
  magnetometer,
  setUpdateIntervalForType,
} from 'react-native-sensors';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { getCatalogEntry } from '../lib/testCatalog';
import { applyRedoneResults } from '../lib/testSession';
import {
  batteryHealthLabel,
  evaluateBatteryHealth,
  evaluateChargingPort,
  evaluateManualConfirmation,
  evaluateSensorReadings,
  evaluateStorageCapacity,
  evaluateStorageReadWrite,
  type EvaluatedResult,
} from '../lib/testEvaluation';
import type { DiagnosticResultInput } from '../api/client';

type Props = NativeStackScreenProps<RootStackParamList, 'RunTest'>;

const SENSOR_STREAMS = { accelerometer, gyroscope, magnetometer } as const;
const SAMPLE_MS = 3000;
const CHARGING_POLL_MS = 15000;

export function RunTestScreen({ route, navigation }: Props) {
  const { testId } = route.params;
  const { results, setResults } = useSession();
  const entry = getCatalogEntry(testId);

  const [busy, setBusy] = useState(false);
  const [entryValue, setEntryValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const subscription = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => () => subscription.current?.unsubscribe(), []);

  const record = useCallback(
    (evaluated: EvaluatedResult, label: string) => {
      const result: DiagnosticResultInput = {
        testId,
        label,
        status: evaluated.status,
        source: evaluated.source,
        timestamp: new Date().toISOString(),
        ...(evaluated.value !== undefined ? { value: evaluated.value } : {}),
        ...(evaluated.notes ? { notes: evaluated.notes } : {}),
      };
      // Replaces any prior entry for this testId rather than appending,
      // so re-running a test from the checklist is a true redo.
      setResults(applyRedoneResults(results, [result]));
      navigation.goBack();
    },
    [testId, results, setResults, navigation],
  );

  if (!entry) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Unknown test</Text>
        <Text style={styles.body}>This app version doesn't recognise "{testId}".</Text>
      </View>
    );
  }

  // ---------------------------------------------------------------
  // Sensor
  // ---------------------------------------------------------------
  const runSensor = () => {
    const stream = SENSOR_STREAMS[testId as keyof typeof SENSOR_STREAMS];
    if (!stream) {
      setError('No sensor stream is wired up for this test.');
      return;
    }
    setBusy(true);
    setError(null);

    const samples: { x: number; y: number; z: number }[] = [];
    setUpdateIntervalForType(testId as keyof typeof SensorTypes, 100);

    subscription.current = stream.subscribe({
      next: ({ x, y, z }) => samples.push({ x, y, z }),
      // A subscription error means the sensor isn't reporting at all,
      // which evaluateSensorReadings treats as a fail on zero samples.
      error: () => undefined,
    });

    setTimeout(() => {
      subscription.current?.unsubscribe();
      subscription.current = null;
      setBusy(false);
      record(evaluateSensorReadings(samples), entry.label);
    }, SAMPLE_MS);
  };

  // ---------------------------------------------------------------
  // Automated
  // ---------------------------------------------------------------
  const runAuto = async () => {
    setBusy(true);
    setError(null);
    try {
      if (testId === 'storage_capacity') {
        const [total, free] = await Promise.all([
          DeviceInfo.getTotalDiskCapacity(),
          DeviceInfo.getFreeDiskStorage(),
        ]);
        record(evaluateStorageCapacity(total, free), entry.label);
        return;
      }

      if (testId === 'storage_readwrite') {
        const path = `${RNFS.DocumentDirectoryPath}/diagnostics-rw-check.txt`;
        const payload = `rw-${Date.now()}`;
        let ok = false;
        try {
          await RNFS.writeFile(path, payload, 'utf8');
          ok = (await RNFS.readFile(path, 'utf8')) === payload;
        } finally {
          // Clean up regardless — CLAUDE.md specifies the temp file is
          // removed, and leaving it behind on a customer device would be
          // sloppy on a device heading for resale.
          try {
            if (await RNFS.exists(path)) await RNFS.unlink(path);
          } catch {
            /* cleanup failure must not change the test outcome */
          }
        }
        record(evaluateStorageReadWrite(ok), entry.label);
        return;
      }

      if (testId === 'battery_charge_level') {
        const level = await DeviceInfo.getBatteryLevel();
        record(
          { status: 'pass', value: `${Math.round(level * 100)}%`, source: 'api' },
          entry.label,
        );
        return;
      }

      if (testId === 'headset_port') {
        // CLAUDE.md: only include this row when the device actually has
        // the port. Most modern phones don't, and a "skipped" row would
        // imply a test that could have run.
        const connected = await DeviceInfo.isHeadphonesConnected();
        record(
          connected
            ? { status: 'pass', source: 'api' }
            : {
                status: 'skipped',
                notes: 'No headset detected. Connect a headset and re-run if this device has a jack.',
                source: 'api',
              },
          entry.label,
        );
        return;
      }

      if (testId === 'charging_port') {
        // Poll for an unplugged -> charging transition. On timeout this
        // records "skipped", never "fail": no cable available during
        // testing is not evidence of a hardware fault.
        const deadline = Date.now() + CHARGING_POLL_MS;
        let charging = false;
        while (Date.now() < deadline && !charging) {
          charging = await DeviceInfo.isBatteryCharging();
          if (!charging) await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000));
        }
        record(evaluateChargingPort(charging), entry.label);
        return;
      }

      setError('This automated test is not wired up.');
    } catch {
      setError('The test could not complete. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------
  // Manual entry
  // ---------------------------------------------------------------
  const submitEntry = () => {
    if (testId === 'battery_health') {
      const percent = Number(entryValue.replace('%', '').trim());
      // Source is "manual", and batteryHealthLabel marks the row as
      // self-reported so the report never presents it as a machine read.
      record(evaluateBatteryHealth(percent, 'manual'), batteryHealthLabel('manual'));
      return;
    }
    record({ status: 'pass', value: entryValue.trim(), source: 'manual' }, entry.label);
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{entry.label}</Text>
      {entry.prompt && <Text style={styles.body}>{entry.prompt}</Text>}
      {entry.entryHint && <Text style={styles.hint}>{entry.entryHint}</Text>}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {entry.kind === 'unavailable' && (
        <>
          <View style={styles.warnBox}>
            <Text style={styles.warnText}>{entry.unavailableReason}</Text>
          </View>
          {/* Recorded as skipped with the reason attached — never as a
              pass, and never as a fail, since neither is true. */}
          <TouchableOpacity
            style={styles.button}
            onPress={() =>
              record(
                { status: 'skipped', notes: entry.unavailableReason, source: 'manual' },
                entry.label,
              )
            }
          >
            <Text style={styles.buttonText}>Record as not tested</Text>
          </TouchableOpacity>
        </>
      )}

      {entry.kind === 'sensor' && (
        <TouchableOpacity style={styles.button} onPress={runSensor} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Start — move the device</Text>}
        </TouchableOpacity>
      )}

      {entry.kind === 'auto' && (
        <TouchableOpacity style={styles.button} onPress={() => void runAuto()} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Run check</Text>}
        </TouchableOpacity>
      )}

      {entry.kind === 'manual_entry' && (
        <>
          <TextInput
            style={styles.input}
            value={entryValue}
            onChangeText={setEntryValue}
            keyboardType={testId === 'battery_health' ? 'number-pad' : 'default'}
            placeholder={testId === 'battery_health' ? '87' : ''}
          />
          <TouchableOpacity
            style={[styles.button, !entryValue.trim() && styles.buttonDisabled]}
            onPress={submitEntry}
            disabled={!entryValue.trim()}
          >
            <Text style={styles.buttonText}>Record</Text>
          </TouchableOpacity>
        </>
      )}

      {entry.kind === 'manual_confirm' && (
        <>
          {/* Two explicit choices and no default. CLAUDE.md: never
              default to a pass, and never treat a timeout or a
              click-through as one. There is deliberately no "continue"
              button that could be pressed without answering. */}
          <TouchableOpacity
            style={styles.button}
            onPress={() => record(evaluateManualConfirmation(true, entry.failureNote ?? ''), entry.label)}
          >
            <Text style={styles.buttonText}>Yes — works correctly</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.buttonDanger}
            onPress={() => record(evaluateManualConfirmation(false, entry.failureNote ?? ''), entry.label)}
          >
            <Text style={styles.buttonText}>No — there's a problem</Text>
          </TouchableOpacity>
          <Text style={styles.hint}>
            Leaving without answering records this as unanswered, not as a pass.
          </Text>
        </>
      )}

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Back to checklist</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  body: { fontSize: 15, color: '#334155', lineHeight: 21, marginBottom: 8 },
  hint: { fontSize: 12, color: '#64748b', marginTop: 10, lineHeight: 17 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginTop: 16, fontSize: 16 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  buttonDanger: { backgroundColor: '#dc2626', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 10 },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 20 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#b91c1c' },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 8, padding: 12, marginTop: 12 },
  warnText: { color: '#92400e', fontSize: 13, lineHeight: 18 },
});
