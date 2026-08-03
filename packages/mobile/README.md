# Diagnostics App — Mobile (Sprint 3+)

Scaffolded with `@react-native-community/cli` (React Native 0.86.2). See
CLAUDE.md at the repo root for the full architecture reference.

## Required native dependencies (per CLAUDE.md)

```bash
npm install react-native-vision-camera        # camera
npm install @react-native-ml-kit/barcode-scanning   # barcode (device ID + profile/badge QR)
npm install @react-native-ml-kit/text-recognition  # OCR fallback
npm install react-native-html-to-pdf          # PDF report generation
npm install react-native-device-info          # battery, storage, make/model
npm install react-native-sensors              # accelerometer/gyroscope/magnetometer
npm install react-native-fs                   # storage read/write test
npm install @react-navigation/native @react-navigation/native-stack  # the 17-screen flow
```

**Ask before adding any OTHER native dependency** — per CLAUDE.md's
"Notes for Claude Code," native modules are the highest-risk part of
this app to get wrong.

## Do NOT attempt

- `TelephonyManager.getImei()` / `Build.getSerial()` (Android) or any
  iOS API for IMEI/serial — neither exists for third-party apps. See
  CLAUDE.md "CRITICAL platform constraint — device identity capture."
- Programmatic iOS battery health — no public API exists. Manual entry
  + OCR fallback is the designed solution, already specified in
  CLAUDE.md "Battery health handling."

## Build order (mirrors `ui_journey_premium.html`'s 17 screens)

1. Technician Login (badge/QR scan) → `technicianAuth.ts`
2. Scan Profile (QR) → `customerProfile.ts`'s `parseProfileQrPayload`
3. License Check → `licensing.ts`'s `checkLicense`
4. Device Check (eligibility) → `deviceVerification.ts`
5. Welcome
6. Find Your ID (barcode/OCR/manual) → device identity capture
7. Confirm
8. Checklist
9. Motion Test, Sound Check, Battery Health, Country of Origin
10. Cosmetic Scan + Review Damage → `cosmeticInspection.ts`
11. Results (with Redo Flagged Tests) → `testSession.ts`
12. Your Offer → `tradeInQuote.ts`
13. Complete

`mobile_batch_intake.html` is a separate branch off step 1 for bulk lot
processing — see `batchSession.ts`.

Steps 1-3 (Technician Login, Scan Profile, License Check) are Sprint 3
scope, wired to the real API (`packages/api`) built in Sprint 1-2. Steps
4+ are Sprint 4-5 scope.

---

## React Native — Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

### Step 1: Start Metro

```sh
npm start
```

### Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of
this package, and use one of the following commands to build and run
your Android or iOS app:

#### Android

```sh
npm run android
```

#### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to
be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install
CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

```sh
npm run ios
```

If everything is set up correctly, you should see the app running in
the Android Emulator, iOS Simulator, or your connected device. A
physical device is required for camera-based capture and hardware
diagnostics (BatteryManager, sensors, camera, mic, speaker, ports) — see
CLAUDE.md "Testing."
