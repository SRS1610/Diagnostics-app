// src/screens/TechnicianLoginScreen.tsx
//
// Mobile Step 1 — "Start your shift" (ui_journey_premium.html). Badge QR
// scan is the primary path (see CLAUDE.md "Profile QR scanning" for the
// scan-first pattern this mirrors); manual tenantId + badge code entry
// is the fallback for a missing/damaged badge.
//
// Manual entry currently asks for a raw tenantId, not a friendly
// company picker/search — CLAUDE.md flags this exact gap ("manual PIN
// entry... needs a tenant picker step first, since typed digits alone
// are ambiguous across tenants") without resolving it, and there's no
// tenant-search API endpoint yet (tenant listing is master_admin-only —
// see routes/tenants.ts). Flagging here rather than silently guessing a
// full tenant-picker UI; a real fix needs either a public tenant-lookup
// endpoint (by company name/slug) or a QR-only policy for this fallback.

import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { QrScannerView } from '../components/QrScannerView';
import { parseTechnicianBadgePayload } from '../lib/qrPayloads';
import { ApiError, loginTechnician } from '../api/client';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'TechnicianLogin'>;

export function TechnicianLoginScreen({ navigation }: Props) {
  const { setTechnician } = useSession();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [manualTenantId, setManualTenantId] = useState('');
  const [manualBadgeCode, setManualBadgeCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attemptLogin = async (tenantId: string, badgeCode: string) => {
    setLoading(true);
    setError(null);
    try {
      const technician = await loginTechnician(tenantId, badgeCode);
      setTechnician(technician);
      navigation.replace('ScanProfile');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Login failed — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleScanned = (value: string) => {
    const parsed = parseTechnicianBadgePayload(value);
    if (!parsed) {
      setError('That QR code isn’t a technician badge. Try again or enter your code manually.');
      return;
    }
    void attemptLogin(parsed.tenantId, parsed.badgeCode);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Start your shift</Text>
      <Text style={styles.subtitle}>
        Scan your badge or enter your code — this attributes your work for QA and dispute records.
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
            <Text style={styles.linkText}>Can&apos;t scan? Enter code manually</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Organization ID (tenantId)"
            value={manualTenantId}
            onChangeText={setManualTenantId}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            placeholder="Badge code"
            value={manualBadgeCode}
            onChangeText={setManualBadgeCode}
            autoCapitalize="characters"
          />
          {error && <Text style={styles.errorText}>{error}</Text>}
          {loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <TouchableOpacity
              style={styles.button}
              onPress={() => void attemptLogin(manualTenantId.trim(), manualBadgeCode.trim())}
              disabled={!manualTenantId.trim() || !manualBadgeCode.trim()}
            >
              <Text style={styles.buttonText}>Log In</Text>
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
