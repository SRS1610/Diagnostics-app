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
import { ChecklistScreen } from '../screens/ChecklistScreen';
import { RunTestScreen } from '../screens/RunTestScreen';
import { CosmeticScanScreen } from '../screens/CosmeticScanScreen';
import { ResultsScreen } from '../screens/ResultsScreen';
import { CompleteScreen } from '../screens/CompleteScreen';
import { PlaceholderScreen } from '../screens/PlaceholderScreen';
import { DeviceCheckScreen } from '../screens/DeviceCheckScreen';
import { WelcomeScreen } from '../screens/WelcomeScreen';
import { ReviewDamageScreen } from '../screens/ReviewDamageScreen';
import { YourOfferScreen } from '../screens/YourOfferScreen';
import {
  BatteryHealthScreen,
  CountryOfOriginScreen,
  MotionTestScreen,
  SoundCheckScreen,
} from '../screens/ChapterScreens';
import { BatchProgressScreen, BatchScanScreen, BatchStartScreen } from '../screens/BatchScreens';

const Stack = createNativeStackNavigator<RootStackParamList>();

const BUILT_SCREENS: Partial<Record<keyof RootStackParamList, React.ComponentType<any>>> = {
  TechnicianLogin: TechnicianLoginScreen,
  ScanProfile: ScanProfileScreen,
  LicenseCheck: LicenseCheckScreen,
  DeviceCheck: DeviceCheckScreen,
  Welcome: WelcomeScreen,
  FindYourId: FindYourIdScreen,
  Confirm: ConfirmScreen,
  Checklist: ChecklistScreen,
  RunTest: RunTestScreen,
  MotionTest: MotionTestScreen,
  SoundCheck: SoundCheckScreen,
  BatteryHealth: BatteryHealthScreen,
  CountryOfOrigin: CountryOfOriginScreen,
  CosmeticScan: CosmeticScanScreen,
  ReviewDamage: ReviewDamageScreen,
  Results: ResultsScreen,
  YourOffer: YourOfferScreen,
  Complete: CompleteScreen,
  BatchStart: BatchStartScreen,
  BatchScan: BatchScanScreen,
  BatchProgress: BatchProgressScreen,
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
