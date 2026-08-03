# Mobile (Sprint 3+)

Not scaffolded here — React Native's CLI needs to run in an empty
directory, same constraint as the portal package.

## Setup

```bash
cd packages/mobile
npx react-native@latest init DiagnosticsApp --directory .
```

## Required native dependencies (per CLAUDE.md)

```bash
npm install react-native-vision-camera        # camera
npm install @react-native-ml-kit/barcode-scanning   # barcode (device ID + profile QR)
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

1. Technician Login (badge/code) → `technicianAuth.ts`
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
