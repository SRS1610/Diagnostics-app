// src/screens/LicenseCheckScreen.tsx
//
// Mobile Step 3 — "Verifying license" (ui_journey_premium.html). Per
// CLAUDE.md "Licensing model": checked right after the profile QR scan,
// before the device eligibility check — no point running a paid
// verification API call on a session that isn't licensed at all. This
// is a hard gate: allowed:false blocks forward progress outright, with
// no way to silently continue, matching every other gate in this app
// (device eligibility, PIN-not-found).

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { ApiError, checkTenantLicense, LicenseCheckResult } from '../api/client';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'LicenseCheck'>;

export function LicenseCheckScreen({ navigation }: Props) {
  const { technician, setLicenseCheck } = useSession();
  const [result, setResult] = useState<LicenseCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    if (!technician) return;
    setLoading(true);
    setError(null);
    try {
      const checkResult = await checkTenantLicense(technician.tenantId);
      setResult(checkResult);
      setLicenseCheck(checkResult);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not verify license — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [technician, setLicenseCheck]);

  useEffect(() => {
    if (!technician) {
      navigation.replace('TechnicianLogin');
      return;
    }
    void runCheck();
  }, [technician, navigation, runCheck]);

  if (!technician) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Verifying license</Text>
      <Text style={styles.subtitle}>Confirming this organization is licensed to run this inspection.</Text>

      {loading && <ActivityIndicator size="large" style={styles.spinner} />}

      {!loading && error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.button} onPress={() => void runCheck()}>
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && result && !result.allowed && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{result.reason ?? 'This organization is not licensed to run inspections.'}</Text>
          <TouchableOpacity style={styles.button} onPress={() => void runCheck()}>
            <Text style={styles.buttonText}>Check Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && result && result.allowed && (
        <View style={styles.successBox}>
          <Text style={styles.successText}>License verified.</Text>
          {result.remainingQuota !== undefined && (
            <Text style={styles.successSubtext}>{result.remainingQuota} inspection credits remaining this period.</Text>
          )}
          <TouchableOpacity style={styles.button} onPress={() => navigation.replace('DeviceCheck')}>
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#666',
    marginBottom: 20,
  },
  spinner: {
    marginTop: 40,
  },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  errorBox: {
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    padding: 16,
    marginTop: 24,
  },
  errorText: {
    color: '#b91c1c',
    textAlign: 'center',
  },
  successBox: {
    backgroundColor: '#dcfce7',
    borderRadius: 8,
    padding: 16,
    marginTop: 24,
  },
  successText: {
    color: '#15803d',
    fontWeight: '600',
    textAlign: 'center',
    fontSize: 16,
  },
  successSubtext: {
    color: '#166534',
    textAlign: 'center',
    marginTop: 4,
  },
});
