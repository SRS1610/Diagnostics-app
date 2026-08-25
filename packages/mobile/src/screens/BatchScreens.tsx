// src/screens/BatchScreens.tsx
//
// Bulk intake — mobile_batch_intake.html's three screens. CLAUDE.md:
// a batch ties multiple devices to one source (a carrier buyback lot)
// under a single customer profile, rather than re-entering a PIN per
// device. Re-scanning the same serial within a batch is a no-op, not
// a duplicate entry (see the /batches/:id/devices route header).
//
// Not the per-device inspection flow — this is a separate branch off
// TechnicianLogin / Welcome. It ends by closing the batch and going
// back to Welcome; there is no report generated per device here
// (that would be the individual flow). A batch records that these
// serials arrived under one intake and links them to one profile.

import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSession } from '../context/SessionContext';
import { QrScannerView } from '../components/QrScannerView';
import {
  ApiError,
  addDeviceToBatch,
  closeBatch,
  createBatch,
  resolveProfileByPin,
} from '../api/client';

// ============================================================
// BatchStart — name the lot and (optionally) attach a profile
// ============================================================

export function BatchStartScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'BatchStart'>) {
  const { technician } = useSession();
  const [sourceName, setSourceName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!technician) {
    navigation.replace('TechnicianLogin');
    return null;
  }

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      let profileId: string | undefined;
      if (pin.trim()) {
        // A PIN entered here selects which customer's test set applies
        // to every device in the lot. Resolved and validated up front
        // rather than on batch creation so a bad PIN doesn't create a
        // half-configured batch the technician then has to abandon.
        const profile = await resolveProfileByPin(technician.tenantId, pin.trim());
        profileId = profile.profileId;
      }
      const batch = await createBatch(technician.token, {
        sourceName: sourceName.trim(),
        profileId,
      });
      navigation.replace('BatchScan', { batchId: batch.batchId });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start this batch. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Start a batch</Text>
      <Text style={styles.subtitle}>
        Tie multiple devices from the same source (a carrier buyback, a corporate refresh) under one intake.
      </Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <Text style={styles.label}>Source name</Text>
      <TextInput
        style={styles.input}
        value={sourceName}
        onChangeText={setSourceName}
        placeholder="e.g. Verizon buyback lot 2026-Q3"
        autoCorrect={false}
      />

      <Text style={styles.label}>Customer profile PIN (optional)</Text>
      <TextInput
        style={styles.input}
        value={pin}
        onChangeText={setPin}
        placeholder="e.g. 4726"
        keyboardType="number-pad"
        maxLength={8}
      />
      <Text style={styles.hint}>
        Leaving this empty creates a batch without a profile — a single-device inspection later can attach one.
      </Text>

      <TouchableOpacity
        style={[styles.button, (!sourceName.trim() || busy) && styles.buttonDisabled]}
        onPress={() => void start()}
        disabled={!sourceName.trim() || busy}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Start batch</Text>}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.link}>Cancel</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ============================================================
// BatchScan — scan device serials into the open batch
// ============================================================

export function BatchScanScreen({ route, navigation }: NativeStackScreenProps<RootStackParamList, 'BatchScan'>) {
  const { technician } = useSession();
  const { batchId } = route.params;
  const [scanned, setScanned] = useState<string[]>([]);
  const [lastMessage, setLastMessage] = useState<{ kind: 'ok' | 'dup' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualSerial, setManualSerial] = useState('');
  const [manualMode, setManualMode] = useState(false);

  if (!technician) {
    navigation.replace('TechnicianLogin');
    return null;
  }

  const submit = useCallback(
    async (rawSerial: string) => {
      const serial = rawSerial.trim();
      if (!serial) return;
      setBusy(true);
      setLastMessage(null);
      try {
        const result = await addDeviceToBatch(technician.token, batchId, serial);
        if (result.alreadyPresent) {
          // Deliberately not an error — see the batch route header. The
          // technician scanned a device already in the lot, likely from
          // stacking scans across a pallet. Show it as recognised.
          setLastMessage({ kind: 'dup', text: `Already in batch: ${serial}` });
        } else {
          setScanned((prev) => [...prev, serial]);
          setLastMessage({ kind: 'ok', text: `Added: ${serial}` });
        }
      } catch (e) {
        // 409 here means the batch was closed elsewhere — route to
        // progress rather than let the technician keep scanning into
        // a closed lot.
        if (e instanceof ApiError && e.status === 409) {
          navigation.replace('BatchProgress', { batchId });
          return;
        }
        setLastMessage({ kind: 'err', text: e instanceof ApiError ? e.message : 'Could not add that serial. Try again.' });
      } finally {
        setBusy(false);
        setManualSerial('');
      }
    },
    [batchId, technician, navigation],
  );

  const messageStyle =
    lastMessage?.kind === 'ok' ? styles.msgOk : lastMessage?.kind === 'dup' ? styles.msgDup : styles.msgErr;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Scan devices</Text>
      <Text style={styles.subtitle}>
        {scanned.length} scanned this session. Re-scanning a serial is a no-op, not an error.
      </Text>

      {manualMode ? (
        <>
          <TextInput
            style={styles.input}
            value={manualSerial}
            onChangeText={setManualSerial}
            placeholder="Serial number"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.button, (busy || !manualSerial.trim()) && styles.buttonDisabled]}
            onPress={() => void submit(manualSerial)}
            disabled={busy || !manualSerial.trim()}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Add</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setManualMode(false)}>
            <Text style={styles.link}>Back to scan</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <QrScannerView onScanned={(v) => void submit(v)} active={!busy} />
          <TouchableOpacity onPress={() => setManualMode(true)}>
            <Text style={styles.link}>Enter serial manually</Text>
          </TouchableOpacity>
        </>
      )}

      {lastMessage && (
        <View style={[styles.msgBox, messageStyle]}>
          <Text style={styles.msgText}>{lastMessage.text}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.buttonSecondary}
        onPress={() => navigation.replace('BatchProgress', { batchId })}
      >
        <Text style={styles.buttonSecondaryText}>Review and close</Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================================
// BatchProgress — review + close
// ============================================================

export function BatchProgressScreen({ route, navigation }: NativeStackScreenProps<RootStackParamList, 'BatchProgress'>) {
  const { technician } = useSession();
  const { batchId } = route.params;
  const [batch, setBatch] = useState<{ deviceSerials: string[]; sourceName: string; status: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!technician) {
    navigation.replace('TechnicianLogin');
    return null;
  }

  // GET /batches/:id is portal-authenticated (not technician-auth). Rather
  // than change that route's contract, this screen defers the read to
  // the /close call, which returns the authoritative deviceSerials
  // snapshot. Until close, the technician sees the count they scanned
  // this session (tracked in BatchScan and passed forward when we plumb
  // it, or 0 here — worst case they close first and see the total).
  const finalize = async () => {
    setClosing(true);
    setError(null);
    try {
      const closed = await closeBatch(technician.token, batchId);
      setBatch({ deviceSerials: closed.deviceSerials, sourceName: closed.sourceName, status: closed.status });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not close this batch. Try again.');
    } finally {
      setClosing(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Batch progress</Text>
      <Text style={styles.subtitle}>Batch {batchId.slice(0, 8)}… — {batch?.sourceName ?? ''}</Text>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {batch && (
        <>
          <View style={styles.statCard}>
            <Text style={styles.statNum}>{batch.deviceSerials.length}</Text>
            <Text style={styles.statLabel}>devices counted</Text>
          </View>

          <Text style={styles.label}>Serials in this batch</Text>
          <View style={styles.serialList}>
            {batch.deviceSerials.length === 0 ? (
              <Text style={styles.hint}>No serials — the batch is empty.</Text>
            ) : (
              batch.deviceSerials.map((s) => (
                <Text key={s} style={styles.serial}>{s}</Text>
              ))
            )}
          </View>

          {batch.status === 'closed' ? (
            <>
              <View style={styles.msgOk}>
                <Text style={styles.msgText}>Batch closed. Devices are now in intake.</Text>
              </View>
              <TouchableOpacity style={styles.button} onPress={() => navigation.replace('Welcome')}>
                <Text style={styles.buttonText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </>
      )}

      {batch?.status !== 'closed' && (
        <>
          <TouchableOpacity
            style={styles.buttonSecondary}
            onPress={() => navigation.replace('BatchScan', { batchId })}
          >
            <Text style={styles.buttonSecondaryText}>Scan more devices</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, closing && styles.buttonDisabled]}
            onPress={() => void finalize()}
            disabled={closing}
          >
            {closing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Close batch</Text>}
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 18 },
  label: { fontSize: 12, color: '#475569', marginBottom: 4, marginTop: 12 },
  hint: { fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 15 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 4 },
  button: { backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 8, alignItems: 'center', marginTop: 16 },
  buttonDisabled: { backgroundColor: '#93b4f5' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  buttonSecondary: {
    borderWidth: 1, borderColor: '#2563eb',
    paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginTop: 12,
  },
  buttonSecondaryText: { color: '#2563eb', fontWeight: '600', fontSize: 15 },
  link: { color: '#2563eb', fontWeight: '500', textAlign: 'center', paddingVertical: 12 },
  errorBox: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
  msgBox: { borderRadius: 8, padding: 10, marginTop: 10, alignItems: 'center' },
  msgOk: { backgroundColor: '#dcfce7', borderRadius: 8, padding: 10, marginTop: 10, alignItems: 'center' },
  msgDup: { backgroundColor: '#e0e7ff', borderRadius: 8, padding: 10, marginTop: 10, alignItems: 'center' },
  msgErr: { backgroundColor: '#fee2e2', borderRadius: 8, padding: 10, marginTop: 10, alignItems: 'center' },
  msgText: { fontSize: 12, color: '#334155' },
  statCard: { backgroundColor: '#f8fafc', borderRadius: 10, padding: 16, alignItems: 'center', marginBottom: 12 },
  statNum: { fontSize: 32, fontWeight: '800', color: '#2563eb' },
  statLabel: { fontSize: 12, color: '#64748b', marginTop: 2 },
  serialList: { backgroundColor: '#f8fafc', borderRadius: 8, padding: 10, marginBottom: 12 },
  serial: { fontFamily: 'monospace', fontSize: 12, color: '#0f172a', paddingVertical: 3 },
});
