// src/components/QrScannerView.tsx
//
// Shared QR-scanning camera view used by Technician Login (badge QR) and
// Scan Profile (profile QR) — both need identical behavior: request
// camera permission, show a live preview, and report the first decoded
// QR value back to the caller (which is responsible for parsing it via
// parseTechnicianBadgePayload/parseProfileQrPayload and deciding whether
// it's valid).
//
// Uses react-native-vision-camera's built-in useCodeScanner (v4 API) —
// this decodes QR/barcodes on-device via the platform's own vision
// framework, with no network call and no separate frame-processor/
// worklets dependency needed. @react-native-ml-kit/barcode-scanning is
// also installed per README's pre-approved list but isn't used by this
// component; wiring ML Kit's own scanner in would need a frame
// processor plugin, which pulls in react-native-worklets-core — a new
// native dependency beyond what's pre-approved, so left out for now
// rather than added silently. Ask before adding it if ML Kit's decoder
// specifically (vs. vision-camera's built-in one) turns out to be
// needed.

import React, { useCallback, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';

interface QrScannerViewProps {
  onScanned: (value: string) => void;
  active: boolean;
}

export function QrScannerView({ onScanned, active }: QrScannerViewProps) {
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  // Guards against the scanner firing onScanned repeatedly for the same
  // held-up code across consecutive frames — the parent resets `active`
  // to re-arm scanning (e.g. after showing an error and letting the
  // technician try again).
  const hasScannedRef = useRef(false);

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (hasScannedRef.current || !active) return;
      const value = codes[0]?.value;
      if (!value) return;
      hasScannedRef.current = true;
      onScanned(value);
    },
  });

  const handleReset = useCallback(() => {
    hasScannedRef.current = false;
  }, []);

  React.useEffect(() => {
    if (active) handleReset();
  }, [active, handleReset]);

  if (!hasPermission) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Camera access is needed to scan the QR code.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Camera Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>No camera device found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={active}
        codeScanner={codeScanner}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  centered: {
    width: '100%',
    height: 320,
    borderRadius: 12,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  message: {
    color: '#fff',
    textAlign: 'center',
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
