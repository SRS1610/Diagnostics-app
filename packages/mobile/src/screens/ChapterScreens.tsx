// src/screens/ChapterScreens.tsx
//
// Steps 9-12 in ui_journey_premium.html — Motion, Sound, Battery,
// Country. Chapter intros in the premium UX between the Checklist hub
// and the individual RunTest screen. They exist so the technician sees
// the flow as a sequence of themed segments rather than as a flat list
// of tests, matching the customer-facing mental model in the UX doc.
//
// Under the hood they don't reimplement the tests — RunTestScreen +
// testCatalog.ts already own that. Each chapter previews its tests,
// shows current status if a redo, and jumps into RunTest for the first
// unrun test in its group (or back to Checklist when everything in the
// chapter is done). Reusing RunTest is deliberate: sensor logic,
// evaluation rules, and the "never default to a pass" invariants live
// there and must not be duplicated.

import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { getCatalogEntry } from '../lib/testCatalog';

// A generic navigator ref: chapter navigation targets are named
// literally at runtime, so we bypass the per-route param inference the
// per-chapter Props would otherwise force.
type Nav = NativeStackNavigationProp<RootStackParamList>;

const STATUS_COLOR: Record<string, string> = {
  pass: '#16a34a',
  fail: '#dc2626',
  warning: '#d97706',
  skipped: '#94a3b8',
};

interface ChapterSpec {
  title: string;
  subtitle: string;
  testIds: string[];
  /** Where to go once every test in this chapter has a result. Deliberate
   *  rather than "next screen in stack" so the flow is visible in this
   *  file, not scattered across navigation config. */
  next: keyof RootStackParamList;
}

const CHAPTERS: Record<'MotionTest' | 'SoundCheck' | 'BatteryHealth' | 'CountryOfOrigin', ChapterSpec> = {
  MotionTest: {
    title: 'Motion sensors',
    subtitle: 'Three quick sensor checks — tilt and rotate the device on cue.',
    testIds: ['accelerometer', 'gyroscope', 'magnetometer'],
    next: 'SoundCheck',
  },
  SoundCheck: {
    title: 'Sound',
    subtitle: 'Speaker and earpiece confirmation — you tell the app whether the tones came through.',
    testIds: ['loud_speaker', 'earpiece', 'microphone'],
    next: 'BatteryHealth',
  },
  BatteryHealth: {
    title: 'Battery',
    subtitle: "Read the max capacity from the device's own Battery screen and enter it.",
    testIds: ['battery_health', 'battery_charge_level', 'charging_port'],
    next: 'CountryOfOrigin',
  },
  CountryOfOrigin: {
    title: 'Housing',
    subtitle: 'Cosmetic and printed-label fields — read from the box or the regulatory label.',
    testIds: ['country_of_origin', 'device_color'],
    next: 'CosmeticScan',
  },
};

/** One rendered chapter — reused by the four thin wrappers below. */
function ChapterView({
  chapterKey,
  navigation,
}: {
  chapterKey: keyof typeof CHAPTERS;
  navigation: Nav;
}) {
  const spec = CHAPTERS[chapterKey];
  const { profile, results } = useSession();

  const enabledIds = new Set(profile?.enabledTestIds ?? []);
  const chapterTests = useMemo(
    () =>
      spec.testIds
        .filter((id) => enabledIds.has(id))
        .map((id) => ({ entry: getCatalogEntry(id), result: results.find((r) => r.testId === id) }))
        .filter((row): row is { entry: NonNullable<ReturnType<typeof getCatalogEntry>>; result: typeof results[number] | undefined } => Boolean(row.entry)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chapterKey, results, profile],
  );

  const nextUnrun = chapterTests.find((row) => !row.result);
  const allDone = chapterTests.length > 0 && !nextUnrun;

  // A profile that enables none of the tests in this chapter — skip
  // straight to the next one rather than showing an empty page. The
  // technician wants forward progress, not a "no tests" screen.
  if (chapterTests.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{spec.title}</Text>
        <Text style={styles.body}>Nothing in this chapter is configured for this profile.</Text>
        <TouchableOpacity style={styles.button} onPress={() => (navigation.replace as (name: string) => void)(spec.next)}>
          <Text style={styles.buttonText}>Skip to {spec.next}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>{spec.title}</Text>
      <Text style={styles.subtitle}>{spec.subtitle}</Text>

      {chapterTests.map(({ entry, result }) => (
        <View key={entry.testId} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: result ? STATUS_COLOR[result.status] ?? '#94a3b8' : '#e2e8f0' }]} />
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>{entry.label}</Text>
            {result?.notes ? <Text style={styles.rowNote}>{result.notes}</Text> : null}
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('RunTest', { testId: entry.testId })}>
            <Text style={styles.rowAction}>{result ? 'Redo' : 'Run'}</Text>
          </TouchableOpacity>
        </View>
      ))}

      {nextUnrun ? (
        <TouchableOpacity
          style={styles.button}
          onPress={() => navigation.navigate('RunTest', { testId: nextUnrun.entry.testId })}
        >
          <Text style={styles.buttonText}>Start with {nextUnrun.entry.label}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={styles.button} onPress={() => (navigation.replace as (name: string) => void)(spec.next)}>
          <Text style={styles.buttonText}>Continue to {spec.next}</Text>
        </TouchableOpacity>
      )}

      {allDone ? null : (
        <TouchableOpacity onPress={() => navigation.navigate('Checklist')}>
          <Text style={styles.link}>Back to full checklist</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

export function MotionTestScreen(props: NativeStackScreenProps<RootStackParamList, 'MotionTest'>) {
  return <ChapterView chapterKey="MotionTest" navigation={props.navigation as unknown as Nav} />;
}

export function SoundCheckScreen(props: NativeStackScreenProps<RootStackParamList, 'SoundCheck'>) {
  return <ChapterView chapterKey="SoundCheck" navigation={props.navigation as unknown as Nav} />;
}

export function BatteryHealthScreen(props: NativeStackScreenProps<RootStackParamList, 'BatteryHealth'>) {
  return <ChapterView chapterKey="BatteryHealth" navigation={props.navigation as unknown as Nav} />;
}

export function CountryOfOriginScreen(props: NativeStackScreenProps<RootStackParamList, 'CountryOfOrigin'>) {
  return <ChapterView chapterKey="CountryOfOrigin" navigation={props.navigation as unknown as Nav} />;
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 18 },
  body: { fontSize: 14, color: '#334155', marginBottom: 16 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e8f0',
  },
  dot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, color: '#0f172a' },
  rowNote: { fontSize: 11, color: '#64748b', marginTop: 2, lineHeight: 15 },
  rowAction: { color: '#2563eb', fontWeight: '600', fontSize: 13, paddingHorizontal: 6 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 20 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
});
