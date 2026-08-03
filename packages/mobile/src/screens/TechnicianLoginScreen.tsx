// src/screens/TechnicianLoginScreen.tsx
//
// Mobile Step 1 — "Start your shift" (ui_journey_premium.html). Badge QR
// scan is the primary path (mirroring the scan-first pattern CLAUDE.md
// established for profile QRs); manual badge-code entry is the fallback
// for a damaged/missing badge.
//
// The manual fallback never asks for a tenantId. The device is bound to
// one tenant on its first successful badge scan and remembers it — see
// src/lib/deviceTenant.ts for why that's the right model for a
// facility-controlled shared tablet, and what the rejected alternatives
// were. Consequence: manual entry is only available once the device has
// been bound, so the very first login on a fresh tablet must use the
// badge QR. That's a deliberate trade — it's the documented primary
// path anyway, and it beats either exposing a public tenant directory or
// asking a technician to type a cuid.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { QrScannerView } from '../components/QrScannerView';
import { parseTechnicianBadgePayload } from '../lib/qrPayloads';
import { ApiError, loginTechnician } from '../api/client';
import { useSession } from '../context/SessionContext';
import { clearDeviceTenant, loadDeviceTenant, saveDeviceTenant } from '../lib/deviceTenant';
import type { DeviceTenantBinding } from '../lib/deviceTenant';

type Props = NativeStackScreenProps<RootStackParamList, 'TechnicianLogin'>;

export function TechnicianLoginScreen({ navigation }: Props) {
  const { setTechnician } = useSession();
  const [mode, setMode] = useState<'scan' | 'manual'>('scan');
  const [binding, setBinding] = useState<DeviceTenantBinding | null>(null);
  const [bindingLoaded, setBindingLoaded] = useState(false);
  const [manualBadgeCode, setManualBadgeCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadDeviceTenant().then((loaded) => {
      setBinding(loaded);
      setBindingLoaded(true);
    });
  }, []);

  const attemptLogin = useCallback(
    async (tenantId: string, badgeCode: string) => {
      setLoading(true);
      setError(null);
      try {
        const technician = await loginTechnician(tenantId, badgeCode);
        // Bind (or refresh) the device's tenant on every success, so a
        // company rename propagates and a re-scan after clearing the
        // binding re-establishes it.
        await saveDeviceTenant(technician.tenantId, technician.companyName);
        setTechnician(technician);
        navigation.replace('ScanProfile');
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Login failed — check your connection and try again.');
      } finally {
        setLoading(false);
      }
    },
    [navigation, setTechnician],
  );

  const handleScanned = useCallback(
    (value: string) => {
      const parsed = parseTechnicianBadgePayload(value);
      if (!parsed) {
        setError('That QR code isn’t a technician badge. Try again, or use your badge code.');
        return;
      }
      if (binding && parsed.tenantId !== binding.tenantId) {
        // A badge from a different organization than this tablet is set
        // up for is far more likely a mistake (wrong tablet, wrong
        // station) than an intentional re-provisioning, so surface it
        // instead of silently switching the device's tenant.
        setError(
          `That badge belongs to a different organization. This device is set up for ${binding.companyName}.`,
        );
        return;
      }
      void attemptLogin(parsed.tenantId, parsed.badgeCode);
    },
    [attemptLogin, binding],
  );

  const handleSwitchOrganization = useCallback(() => {
    void clearDeviceTenant().then(() => {
      setBinding(null);
      setMode('scan');
      setError(null);
    });
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Start your shift</Text>
      <Text style={styles.subtitle}>
        Scan your badge or enter your code — this attributes your work for QA and dispute records.
      </Text>

      {binding && (
        <View style={styles.bindingBanner}>
          <Text style={styles.bindingText}>This device is set up for {binding.companyName}.</Text>
          <TouchableOpacity onPress={handleSwitchOrganization}>
            <Text style={styles.bindingLink}>Change</Text>
          </TouchableOpacity>
        </View>
      )}

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
          {bindingLoaded &&
            (binding ? (
              <TouchableOpacity
                style={styles.linkButton}
                onPress={() => {
                  setError(null);
                  setMode('manual');
                }}
              >
                <Text style={styles.linkText}>Can&apos;t scan? Enter badge code</Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.hint}>
                First login on this device must use the badge QR code — it identifies your organization.
              </Text>
            ))}
        </>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Badge code"
            value={manualBadgeCode}
            onChangeText={setManualBadgeCode}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {error && <Text style={styles.errorText}>{error}</Text>}
          {loading ? (
            <ActivityIndicator style={styles.spinner} />
          ) : (
            <TouchableOpacity
              style={[styles.button, !manualBadgeCode.trim() && styles.buttonDisabled]}
              onPress={() => binding && void attemptLogin(binding.tenantId, manualBadgeCode.trim())}
              disabled={!manualBadgeCode.trim()}
            >
              <Text style={styles.buttonText}>Log In</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.linkButton}
            onPress={() => {
              setError(null);
              setMode('scan');
            }}
          >
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
    marginBottom: 16,
  },
  bindingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  bindingText: {
    color: '#334155',
    fontSize: 13,
    flexShrink: 1,
  },
  bindingLink: {
    color: '#2563eb',
    fontWeight: '600',
    fontSize: 13,
    marginLeft: 12,
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
  buttonDisabled: {
    backgroundColor: '#93b4f5',
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
  hint: {
    textAlign: 'center',
    color: '#64748b',
    fontSize: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
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
