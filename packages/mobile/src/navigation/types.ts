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
  RunTest: { testId: string };
  MotionTest: undefined;
  SoundCheck: undefined;
  BatteryHealth: undefined;
  CountryOfOrigin: undefined;
  CosmeticScan: undefined;
  ReviewDamage: undefined;
  Results: undefined;
  YourOffer: undefined;
  Complete: { reportId: string } | undefined;
  // Batch-intake alt flow — reachable from Welcome (via "Run a batch
  // instead"). Independent of the per-device flow above; ends by
  // closing the batch and returning to Welcome so the technician can
  // start a new batch or a single-device inspection.
  BatchStart: undefined;
  BatchScan: { batchId: string };
  BatchProgress: { batchId: string };
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
  'RunTest',
  'MotionTest',
  'SoundCheck',
  'BatteryHealth',
  'CountryOfOrigin',
  'CosmeticScan',
  'ReviewDamage',
  'Results',
  'YourOffer',
  'Complete',
  'BatchStart',
  'BatchScan',
  'BatchProgress',
];
