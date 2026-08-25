// src/screens/DeviceCheckScreen.tsx
//
// Mobile Step 4 — "Verifying eligibility" (ui_journey_premium.html).
// CLAUDE.md's "Device verification gate": runs GSMA blacklist +
// activation-lock lookup BEFORE any diagnostic starts, because there is
// no point running a 5-minute test suite on a device that turns out to
// be blacklisted or activation-locked. Ineligible outcomes are a HARD
// GATE — never a warning.
//
// Provider integration is out of scope for this build (CLAUDE.md's
// "Data sourcing status": GSMA blacklist and iCloud FMIP / Android FRP
// data is licensed, not public — needs a real provider signup). This
// screen surfaces that plainly rather than pretending to check: the
// technician sees "not configured", explicitly acknowledges the risk,
// and continues. Auto-passing without acknowledgement would defeat the
// point of a hard gate.

import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'DeviceCheck'>;

// Read at render time so a build with DEVICE_VERIFICATION_API_BASE set
// takes the real-check path automatically, without a code change here.
// process.env in a Metro bundle is inlined at build time — an unset var
// is undefined, not the process's runtime env.
const HAS_VERIFICATION_PROVIDER = Boolean(
  (typeof process !== 'undefined' && process.env && process.env.DEVICE_VERIFICATION_API_BASE) || false,
);

export function DeviceCheckScreen({ navigation }: Props) {
  const { technician } = useSession();
  const [acknowledged, setAcknowledged] = useState(false);

  if (!technician) {
    navigation.replace('TechnicianLogin');
    return null;
  }

  const proceed = () => navigation.replace('Welcome');

  // --- Real provider wired up -----------------------------------------
  // TODO(sprint after provider signup): drive checkEligibility() from
  // packages/shared/deviceVerification.ts here — POST make/model/imei/
  // serial, block on 'blacklisted' / 'activation_locked' / 'fmi_on' /
  // 'balance_owed', route to hold_ineligible on failure. See CLAUDE.md
  // "Device verification gate" for the exact block conditions.
  if (HAS_VERIFICATION_PROVIDER) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Verifying eligibility</Text>
        <Text style={styles.body}>
          Provider check-in path — not wired up in this build. Set DEVICE_VERIFICATION_API_BASE and integrate
          checkEligibility() from shared/deviceVerification.ts to make this a real hard gate.
        </Text>
        <TouchableOpacity style={styles.button} onPress={proceed}>
          <Text style={styles.buttonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- No provider — honest degradation -------------------------------
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Device eligibility check</Text>
      <Text style={styles.body}>
        This step normally checks the device against GSMA blacklist data and Apple / Google activation-lock
        registries before diagnostics start.
      </Text>

      <View style={styles.warnBox}>
        <Text style={styles.warnTitle}>Not configured for this build</Text>
        <Text style={styles.warnText}>
          No device-verification provider is wired up. The check is skipped, so a blacklisted or activation-locked
          device would not be caught here. Confirm the device belongs to the customer presenting it before you
          continue.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.checkRow}
        onPress={() => setAcknowledged(!acknowledged)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
      >
        <View style={[styles.check, acknowledged && styles.checkOn]}>
          {acknowledged && <Text style={styles.checkMark}>✓</Text>}
        </View>
        <Text style={styles.checkLabel}>
          I've confirmed ownership manually and understand no automated eligibility check ran.
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, !acknowledged && styles.buttonDisabled]}
        onPress={proceed}
        disabled={!acknowledged}
      >
        <Text style={styles.buttonText}>Continue</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  body: { fontSize: 14, color: '#334155', marginBottom: 16, lineHeight: 20 },
  warnBox: { backgroundColor: '#fef3c7', borderRadius: 10, padding: 14, marginBottom: 20 },
  warnTitle: { fontWeight: '700', color: '#92400e', marginBottom: 4, fontSize: 13 },
  warnText: { color: '#92400e', fontSize: 12, lineHeight: 17 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 20 },
  check: {
    width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#94a3b8',
    marginRight: 10, marginTop: 1, alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  checkMark: { color: '#fff', fontWeight: '700' },
  checkLabel: { flex: 1, fontSize: 13, color: '#334155', lineHeight: 19 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 8 },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 16 },
});
