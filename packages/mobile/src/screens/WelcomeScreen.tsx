// src/screens/WelcomeScreen.tsx
//
// Mobile Step 5 — "Welcome" (ui_journey_premium.html). A short customer-
// facing intro card between the eligibility gate and the identity
// capture. Shows the technician + tenant for orientation, previews the
// steps ahead, and hands off to FindYourId.
//
// Deliberately minimal: no side effects, no data reads, no auto-advance.
// A technician who scanned a badge into the wrong tenant catches it here
// before locking a report against it.

import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

const STEPS = [
  { n: 1, label: 'Find the device serial number and IMEI' },
  { n: 2, label: 'Run the checks configured for this customer' },
  { n: 3, label: 'Photograph and grade any cosmetic damage' },
  { n: 4, label: 'Review and submit the audit report' },
];

export function WelcomeScreen({ navigation }: Props) {
  const { technician, profile } = useSession();

  if (!technician) {
    navigation.replace('TechnicianLogin');
    return null;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Ready when you are</Text>
      <Text style={styles.subtitle}>
        Signed in as <Text style={styles.strong}>{technician.displayName}</Text> at{' '}
        <Text style={styles.strong}>{technician.companyName}</Text>
        {profile ? <> for the <Text style={styles.strong}>{profile.customerName}</Text> program</> : null}.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What happens next</Text>
        {STEPS.map((s) => (
          <View key={s.n} style={styles.stepRow}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{s.n}</Text>
            </View>
            <Text style={styles.stepLabel}>{s.label}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity style={styles.button} onPress={() => navigation.navigate('FindYourId')}>
        <Text style={styles.buttonText}>Start inspection</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.replace('ScanProfile')}>
        <Text style={styles.link}>Wrong program — re-scan the profile</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#475569', marginBottom: 20, lineHeight: 20 },
  strong: { color: '#0f172a', fontWeight: '600' },
  card: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 18, marginBottom: 20 },
  cardTitle: { fontSize: 13, color: '#64748b', fontWeight: '600', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  stepNum: {
    width: 24, height: 24, borderRadius: 12, backgroundColor: '#2563eb',
    alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  stepNumText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  stepLabel: { flex: 1, fontSize: 14, color: '#0f172a' },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
});
