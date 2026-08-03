// src/screens/PlaceholderScreen.tsx
//
// Stub for the 14 screens (Steps 4-17) not yet built — Sprint 4-5 scope
// per packages/mobile/README.md's build order. Exists so the navigation
// stack wires up end-to-end for the full 17-screen flow now, rather than
// dead-ending after License Check. Includes a "Next" button purely to
// demonstrate the stack advances correctly; it does none of the real
// step's work (device eligibility check, barcode capture, etc.).

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { SCREEN_ORDER } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, keyof RootStackParamList>;

export function PlaceholderScreen({ route, navigation }: Props) {
  const currentIndex = SCREEN_ORDER.indexOf(route.name);
  const nextScreen = SCREEN_ORDER[currentIndex + 1];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{route.name}</Text>
      <Text style={styles.subtitle}>Not yet implemented — Sprint 4-5 scope.</Text>
      {nextScreen && (
        <TouchableOpacity style={styles.button} onPress={() => navigation.navigate(nextScreen as never)}>
          <Text style={styles.buttonText}>Next: {nextScreen}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 24,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
