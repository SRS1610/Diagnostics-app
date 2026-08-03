// src/navigation/AppNavigator.tsx

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { SCREEN_ORDER } from './types';
import { TechnicianLoginScreen } from '../screens/TechnicianLoginScreen';
import { ScanProfileScreen } from '../screens/ScanProfileScreen';
import { LicenseCheckScreen } from '../screens/LicenseCheckScreen';
import { FindYourIdScreen } from '../screens/FindYourIdScreen';
import { ConfirmScreen } from '../screens/ConfirmScreen';
import { ResultsScreen } from '../screens/ResultsScreen';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

const BUILT_SCREENS: Partial<Record<keyof RootStackParamList, React.ComponentType<any>>> = {
  TechnicianLogin: TechnicianLoginScreen,
  ScanProfile: ScanProfileScreen,
  LicenseCheck: LicenseCheckScreen,
  FindYourId: FindYourIdScreen,
  Confirm: ConfirmScreen,
  Results: ResultsScreen,
};

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="TechnicianLogin" screenOptions={{ headerShown: false }}>
        {SCREEN_ORDER.map((name) => (
          <Stack.Screen key={name} name={name} component={BUILT_SCREENS[name] ?? PlaceholderScreen} />
        ))}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
