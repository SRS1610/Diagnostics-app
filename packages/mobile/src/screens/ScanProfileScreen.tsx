// src/screens/ScanProfileScreen.tsx
//
// Mobile Step 2 — "Scan the profile QR code" (ui_journey_premium.html).
// Unlike Technician Login's manual fallback, this one's tenant context
// is already resolved (from the Step 1 technician session) — the pin
// fallback only needs the PIN itself, not a tenant picker.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { QrScannerView } from '../components/QrScannerView';
import { parseProfileQrPayload } from '../lib/qrPayloads';
import { ApiError, resolveProfileByPin } from '../api/client';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'ScanProfile'>;

export function ScanProfileScreen({ navigation }: Props) {
  const { technician, setProfile } = useSession();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [manualPin, setManualPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Safety net: this screen assumes Step 1 already ran. If reached
    // directly (deep link, dev reload), send back rather than crash on
    // a null technician below.
    if (!technician) navigation.replace('TechnicianLogin');
  }, [technician, navigation]);

  if (!technician) return null;

  const attemptResolve = async (pin: string) => {
    setLoading(true);
    setError(null);
    try {
      const profile = await resolveProfileByPin(technician.tenantId, pin);
      setProfile(profile);
      navigation.replace('LicenseCheck');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Lookup failed — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleScanned = (value: string) => {
    const parsed = parseProfileQrPayload(value);
    if (!parsed) {
      setError('That QR code isn’t a customer profile. Try again or enter the PIN manually.');
      return;
    }
    if (parsed.tenantId !== technician.tenantId) {
      // Guards against a technician mistakenly scanning a different
      // customer/organization's poster — resolveProfileByPin would
      // otherwise happily look up whatever tenantId the QR encodes.
      setError('This profile belongs to a different organization than your login.');
      return;
    }
    void attemptResolve(parsed.pin);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Scan the profile QR code</Text>
      <Text style={styles.subtitle}>
        Find it posted at this customer's intake station — it loads the right test set automatically.
      </Text>

      {mode === 'scan' ? (
        <>
          <QrScannerView onScanned={handleScanned} active={!loading && !error} />
          {loading && <ActivityIndicator style={styles.spinner} />}
          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.linkButton} onPress={() => setError(null)}>
                <Text style={styles.linkText}>Try Again</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={styles.linkButton} onPress={() => setMode('manual')}>
            <Text style={styles.linkText}>Can&apos;t scan? Enter PIN manually</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Profile PIN"
            value={manualPin}
            onChangeText={setManualPin}
            keyboardType="number-pad"
          />
          {error && <Text style={styles.errorText}>{error}</Text>}
          {loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <TouchableOpacity
              style={styles.button}
              onPress={() => void attemptResolve(manualPin.trim())}
              disabled={!manualPin.trim()}
            >
              <Text style={styles.buttonText}>Continue</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.linkButton} onPress={() => setMode('scan')}>
            <Text style={styles.linkText}>Back to scan</Text>
          </TouchableOpacity>
        </>
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
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  linkButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  linkText: {
    color: '#2563eb',
    fontWeight: '500',
  },
  spinner: {
    marginVertical: 12,
  },
  errorBox: {
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  errorText: {
    color: '#b91c1c',
    textAlign: 'center',
  },
});
