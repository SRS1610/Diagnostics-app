// src/navigation/types.ts
//
// The 17-screen flow, in order, per ui_journey_premium.html's actual
// screen headings ("Start your shift" → "Scan the profile QR code" →
// "Verifying license" → ... → "All checks complete"). Steps 1-3
// (TechnicianLogin, ScanProfile, LicenseCheck) are Sprint 3 scope, built
// for real. Steps 4-17 are placeholders until Sprint 4-5.

export type RootStackParamList = {
  TechnicianLogin: undefined;
  ScanProfile: undefined;
  LicenseCheck: undefined;
  DeviceCheck: undefined;
  Welcome: undefined;
  FindYourId: undefined;
  Confirm: undefined;
  Checklist: undefined;
  MotionTest: undefined;
  SoundCheck: undefined;
  BatteryHealth: undefined;
  CountryOfOrigin: undefined;
  CosmeticScan: undefined;
  ReviewDamage: undefined;
  Results: undefined;
  YourOffer: undefined;
  Complete: undefined;
};

export const SCREEN_ORDER: (keyof RootStackParamList)[] = [
  'TechnicianLogin',
  'ScanProfile',
  'LicenseCheck',
  'DeviceCheck',
  'Welcome',
  'FindYourId',
  'Confirm',
  'Checklist',
  'MotionTest',
  'SoundCheck',
  'BatteryHealth',
  'CountryOfOrigin',
  'CosmeticScan',
  'ReviewDamage',
  'Results',
  'YourOffer',
  'Complete',
];
