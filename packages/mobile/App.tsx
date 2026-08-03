/**
 * Device Diagnostics App — mobile technician flow.
 *
 * @format
 */

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { SessionProvider } from './src/context/SessionContext';

function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AppNavigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

export default App;
