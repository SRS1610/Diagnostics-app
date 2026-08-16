# Device Diagnostics App

## Overview
Multi-tenant SaaS platform for phone diagnostics, trade-in, and resale
operations. Core loop: a technician runs a mobile app to capture device
identity → run diagnostics → generate a signed audit-trail PDF; a backend
API stores that report; each paying company (tenant) sees their own data
through a portal; the consumer whose device was inspected sees a public
tracker at `/track/:token`; a Master Admin manages the platform across
tenants.

## Repository layout (monorepo)
npm workspaces at the root. `packages/mobile` is intentionally NOT a
workspace (it has its own package-lock and React Native native toolchain).

```
Diagnostics-app/
├── package.json                # workspace root; dev:api/dev:portal/dev:consumer, db:*
├── netlify.toml                # portal deploy (Netlify)
├── render.yaml                 # API + Postgres deploy (Render)
├── DEPLOY.md                   # deploy playbook, env vars, seed users
├── README.md                   # quick pointers (defers to this file)
├── docs/                       # roadmap, dataset plan, pricing template
├── mockups/                    # 18 static HTML mockups (see below)
└── packages/
    ├── shared/     @diagnostics/shared — all business-domain modules + types
    ├── api/        @diagnostics/api    — Express + Prisma + Postgres
    ├── portal/     @diagnostics/portal — React 19 + Vite (tenant + master console)
    ├── consumer/   @diagnostics/consumer — React 19 + Vite (public /track/:token)
    └── mobile/     React Native 0.86 (Android + iOS; not a workspace)
```

Every business module CLAUDE.md talks about (`tenant.ts`, `licensing.ts`,
`testSession.ts`, `customerProfile.ts`, `deviceRouting.ts`,
`deviceVerification.ts`, `cosmeticInspection.ts`, `dataWipe.ts`,
`tradeInQuote.ts`, `fraudDetection.ts`, `batchSession.ts`,
`offlineSync.ts`, `notifications.ts`, `invoicing.ts`,
`marketplaceListing.ts`, `warrantyTracking.ts`, `adminActivityLog.ts`,
`marketPriceData.ts`, `marketPriceUpload.ts`, `shippingLogistics.ts`,
`kycVerification.ts`, `portalAuth.ts`, `technicianAuth.ts`,
`reportRenderer.ts`, `testPlanRegistry.remote.ts`, `datasetCollection.ts`)
lives in `packages/shared/src/`. Older sections of this doc that say
"(project root)" mean `packages/shared/src/`. The API, portal, consumer
and mobile packages all import from `@diagnostics/shared`.

## Stack
- **Backend**: Node 22, Express 4, Prisma + Postgres, `jose`/`jsonwebtoken`
  for JWT, `bcrypt`, `zod` for validation, `express-rate-limit`, `stripe`,
  `twilio`, `@sendgrid/mail`, `exceljs` for spreadsheet export.
- **Portal / Consumer**: React 19, Vite 8, `react-router-dom` 7, plain
  React Context for session state (no Redux/Zustand). Lint: `oxlint`.
- **Mobile**: React Native 0.86 (TypeScript), `@react-navigation/native`,
  `react-native-vision-camera`, `@react-native-ml-kit/barcode-scanning`,
  `@react-native-ml-kit/text-recognition`, `react-native-html-to-pdf`,
  `react-native-device-info`, `react-native-sensors`, `react-native-fs`,
  `qrcode`.
- **Tests**: Jest + supertest for API; Playwright (driven from raw `.mjs`
  harness scripts, no `@playwright/test` runner) for portal and consumer
  e2e; Jest with the RN preset for mobile.

## Development commands
Nothing at the root aggregates test/lint/typecheck — run per workspace.

```bash
# Setup
npm ci
npm run build:shared               # shared must be built before others typecheck

# Dev servers
npm run dev:api                    # Express on :4000
npm run dev:portal                 # Vite on :5173
npm run dev:consumer               # Vite on :5174

# Database (proxies to packages/api)
npm run db:generate
npm run db:migrate
npm run db:studio
npx --workspace=packages/api prisma db seed   # creates Acme Wireless tenant, seed users

# API — jest + supertest against a real Postgres
npm run test:setup --workspace=packages/api   # applies migrations to TEST_DATABASE_URL
npm test --workspace=packages/api

# Portal — typecheck + build + e2e (needs API + Postgres up)
npm run lint --workspace=packages/portal
npm run build --workspace=packages/portal
npm run e2e:install --workspace=packages/portal   # or set CHROMIUM_PATH
npm run test:e2e --workspace=packages/portal

# Consumer
npm run build --workspace=packages/consumer
npm run test:e2e --workspace=packages/consumer

# Mobile (not a workspace — cd in)
cd packages/mobile && npm install
npm test          # jest
npm run lint      # eslint
npm run test:e2e  # node script against a running API
npm run android   # or npm run ios
```

There is no CI. Deploys happen straight from `main`: Render for the API
(via `render.yaml`), Netlify for the portal (via `netlify.toml`). Neither
runs tests before deploying — regressions must be caught locally.

## Seed users (from `packages/api/prisma/seed.ts`)
- Tenant: **Acme Wireless**, profile PIN `4726`, technician badge `TEC-1042`
- Master admin: `master@platform.com` / `changeme123`
- Tenant admin: `admin@acmewireless.com` / `changeme123`

---

# Backend API — `packages/api`

Express app assembled in `src/app.ts`, launched by `src/index.ts`.
Business logic lives in `packages/shared`; this package is the transport
+ persistence layer.

## Routes (`src/routes/*.ts`)
Every tenant-scoped route uses `requireAuth` → `requireTenantScope`. Some
are Master-only, one is API-key-auth, one is public-token-auth.

- `auth.ts` — portal login/logout, password reset, MFA enroll/verify
- `sso.ts` — OIDC connection config + callback (`sso_login` activity)
- `tenants.ts` — Master Console CRUD; `enterTenantView` / `exitTenantView`
- `users.ts` — portal user invite / role / deactivate (tenant-scoped)
- `technicians.ts` — technician roster, badge codes, shift status
- `profiles.ts` — customer profiles + PIN + QR generation
- `licenses.ts` — license provisioning, plan supersession
- `reports.ts` — the reference implementation for tenant scoping
- `reportArtifacts.ts` — revisions + data-wipe certificates for a report
- `disputes.ts` — dispute queue, resolve (uphold / adjust grade)
- `warrantyClaims.ts` — post-sale claims tied back to `reportId`
- `quotes.ts` — trade-in quotes
- `invoices.ts` — invoice read + CSV
- `batches.ts` — batch intake sessions
- `listings.ts` — marketplace listings
- `compliance.ts` — resale/repair/recycle aggregates + CSV
- `orgSettings.ts` — Settings page persistence
- `integrations.ts` — API keys + webhook endpoints
- `qaMetrics.ts` — `GET /qa-metrics/technicians` (redo rate, dispute rate)
- `billing.ts` — Stripe checkout + webhook (needs the raw-body branch in `app.ts`)
- `activityLog.ts` — audit-log read API
- `publicApi.ts` — mounted at `/v1`, API-key bearer auth, read-only
- `publicTracker.ts` — mounted at `/public/track`, consumer-token auth (no session)
- `consumerData.ts` — consumer contact updates via the same token

## Middleware (`src/middleware/`)
- `auth.ts` — `requireAuth`; verifies JWT and populates `portalSession`
- `tenantScope.ts` — `requireTenantScope`; asserts `viewingTenantId` is
  set and provides a `tenantWhere` helper. **The single highest-risk
  file in this repo — see "Multi-tenant architecture" below.**
- `technicianAuth.ts` — badge/PIN auth for mobile endpoints
- `apiKeyAuth.ts` — bearer API-key auth for the `/v1` surface

## Helpers (`src/lib/`)
`prisma.ts` (client singleton), `passwords.ts` (bcrypt), `totp.ts` (MFA),
`oidc.ts` (SSO), `stripe.ts`, `webhooks.ts` (outbound delivery),
`notificationDelivery.ts` (SendGrid + Twilio), `activityLog.ts` (audit
writer), `pagination.ts` (`X-Total-Count`), `csv.ts`, `consumerToken.ts`.

## Persistence (`prisma/schema.prisma`, 24 models)
Tenant, CustomerProfile, License, Invoice, PortalUser, SsoConnection,
MfaBackupCode, PasswordResetToken, Technician, Report, ReportRevision,
DataWipeCertificate, WarrantyClaim, ActivityLogEntry, Dispute,
MarketPriceEntry, TradeInQuote, PayoutRecord, MarketplaceListing,
BatchSession, ApiKey, WebhookEndpoint, WebhookDelivery. 13 migrations
under `prisma/migrations/`.

## Tests (`tests/`)
Jest with `maxWorkers: 1`, `testTimeout: 20000`, one Postgres schema
reset per file. Suites: `apiKeys`, `authAndResilience`,
`batchesAndListings`, `billing`, `consumerData`, `exportAndCompliance`,
`licenseSupersession`, `mfa`, `notifications`, `orgSettings`,
`pagination`, `portalUsers`, `publicTracker`, `qaMetrics`, `quotes`,
`reportArtifacts`, `sso`, `tenantIsolation`, `webhooks`. The
`tenantIsolation` suite is the load-bearing regression test for cross-
tenant leakage — do not weaken it.

---

# Portal — `packages/portal`

React 19 + Vite 8 + react-router-dom 7. State via `SessionContext`
(React Context). One fetch wrapper in `src/api/client.ts`; base URL from
`VITE_API_BASE_URL` (defaults `http://localhost:4000`). Every call
carries the session token.

## Structure
- `App.tsx` — all routes; defines `TenantRoute` (wraps every
  tenant-scoped page) and `MasterRoute`
- `components/Shell.tsx` — exports **`TenantShell`** and `MasterShell`.
  `TenantShell` renders the sidebar + the tenant-indicator badge for
  every tenant-scoped page (structural, not per-page)
- `auth/SessionContext.tsx` — holds the API-minted token;
  `enterTenantView`/`exitTenantView` swap tokens via the API

## Pages (`src/pages/`)
- `Login.tsx`, `SsoComplete.tsx`, `ChangePassword.tsx`
- `MasterConsole.tsx` — cross-tenant view, deliberately styled with a
  different dark theme so a superuser context is not visually
  confusable with a tenant view
- `Dashboard.tsx`
- `Reports.tsx` — `ReportsPage` + `ReportDetailPage`
- `Devices.tsx` — `DevicesPage` + `DeviceHistoryPage`
- `Profiles.tsx`, `Disputes.tsx`, `TradeIn.tsx`, `Compliance.tsx`,
  `Integrations.tsx`
- `Operations.tsx` — `BatchesPage`, `InvoicesPage`, `WarrantyPage`
- `Users.tsx` — exports `UsersSection` (consumed by TeamPage)
- `Misc.tsx` — `ActivityLogPage`, `BillingPage`, `SettingsPage`,
  `TeamPage` (which renders `<UsersSection />`)

## E2E (`e2e/`)
Playwright driven from Node scripts (no `@playwright/test`). Suites:
`smoke`, `failure-modes`, `write-flows`, `user-management`,
`search-and-paging`, `export-and-compliance`, `operations-pages`,
`settings`, `mfa`, `integrations`, `sso`, `billing`. Chromium via
`npm run e2e:install` or `CHROMIUM_PATH`.

---

# Consumer app — `packages/consumer`

Deliberately narrow: a single tracker URL per report, one component
(`Tracker.tsx`), no login and no landing page.

- Routes: `/track/:token` → `<Tracker/>`, `/` → `<NoToken/>` only
- The URL token IS the credential; nothing is written to `localStorage`;
  page carries `no-referrer` + `noindex`
- Folds all three consumer mockups (`consumer_tracker.html`,
  `consumer_dispute.html`, `consumer_payout.html`) into `Tracker.tsx`
- `src/api.ts` hits `/public/track/*` on the API
- Two invariants stated in the file header, both must hold:
  1. Never show a number the business cannot honour
  2. State, not assumption — no optimistic updates

E2E scripts: `tracker`, `offer`, `payout`, `dispute`, `contact`.

---

# Mobile — `packages/mobile`

React Native 0.86 (native CLI, not Expo). Entry `index.js` →
`App.tsx` → `SafeAreaProvider` → `SessionProvider` → `AppNavigator`.
Native stack, headerless, `initialRouteName=TechnicianLogin`.

## Structure
- `api/client.ts` — API client
- `context/SessionContext.tsx`
- `components/QrScannerView.tsx`
- `navigation/AppNavigator.tsx` — screen registration
- `navigation/types.ts` — `RootStackParamList` + `SCREEN_ORDER` (the
  canonical ordering of the technician journey)
- `lib/`: `cosmeticCapture.ts`, `deviceIdentity.ts`, `deviceTenant.ts`,
  `qrPayloads.ts`, `reportPdf.ts`, `testCatalog.ts`,
  `testEvaluation.ts`, `testSession.ts` (device-side wrapper — not the
  business module of the same name in `packages/shared`)

## Screens (`src/screens/`)
`TechnicianLoginScreen` → `ScanProfileScreen` → `LicenseCheckScreen` →
`FindYourIdScreen` → `ConfirmScreen` → `ChecklistScreen` →
`RunTestScreen` → `CosmeticScanScreen` → `ResultsScreen` →
`CompleteScreen`. Any screen name in `SCREEN_ORDER` without a built
component falls back to `PlaceholderScreen`.

## Native
Stock scaffolding, **no custom native modules yet**:
- `android/app/src/main/java/com/diagnosticsapp/MainApplication.kt` +
  `MainActivity.kt`
- `ios/DiagnosticsApp/AppDelegate.swift`, `Info.plist`,
  `PrivacyInfo.xcprivacy`, `Podfile`, `Gemfile`

All battery-health / sensor / port hardware access still runs through
JS libraries (`react-native-device-info`, `react-native-sensors`,
`react-native-fs`) — writing a native module is on-request work and is
the highest-risk change in this app.

## Tests
`__tests__/App.test.tsx` plus focused unit tests for each `lib/` module.
E2E under `e2e/`: `harness.mjs`, `apiClient.mjs`, `README.md`.

---

# Mockups (`mockups/`)
18 static HTML files representing the intended UI. Portal and consumer
implementations now cover them:

Admin portal: `admin_portal.html`, `admin_portal_detail.html`,
`admin_portal_devices.html`, `admin_portal_device_history.html`,
`admin_portal_profiles.html`, `admin_portal_disputes.html`,
`admin_portal_compliance.html`, `admin_portal_billing.html`,
`admin_portal_team.html`, `admin_portal_settings.html`,
`admin_portal_activity_log.html`, `master_console.html`,
`portal_login.html`.

Consumer: `consumer_tracker.html`, `consumer_dispute.html`,
`consumer_payout.html`.

Mobile: `mobile_batch_intake.html`, `ui_journey_premium.html`.

---

# Deployment

- **API + Postgres**: Render (`render.yaml`). Free Postgres
  `diagnostics-db` + `diagnostics-api` web service (node, plan free,
  branch `main`). Build: `npm ci` + build shared + `prisma generate` +
  build api. Pre-deploy: `prisma migrate deploy`. Healthcheck `/health`.
  Env: `NODE_VERSION=22`, `DATABASE_URL` (from DB), `JWT_SECRET`
  (generated); manual: `CORS_ORIGINS`, `PORTAL_BASE_URL`,
  `CONSUMER_BASE_URL`, `API_BASE_URL`.
- **Portal**: Netlify (`netlify.toml`). Publishes
  `packages/portal/dist`, SPA redirect `/* → /index.html 200`.
  `VITE_API_BASE_URL` is baked in at build time — see DEPLOY.md.
- **Consumer**: deployed as a second Netlify site with the same shape.
- **Mobile**: out of deploy scope (app-store distribution).

Stripe / Twilio / SendGrid / cosmetic CV / device-verification all
degrade gracefully when their creds are absent — the app runs without
them, they just no-op or return sentinel values.

---
---

The rest of this file is the domain playbook. It documents WHY the code
looks the way it does and WHAT NOT to do — most of these constraints are
not enforceable by tests. Read the section relevant to whatever you're
about to touch.

## CRITICAL platform constraint — device identity capture
Neither iOS nor Android allows normal third-party apps to programmatically
read IMEI or hardware serial number:
- **Android**: `TelephonyManager.getImei()` / `Build.getSerial()` require
  `READ_PRIVILEGED_PHONE_STATE`, which non-device-owner apps cannot hold
  (throws `SecurityException` on Android 10+)
- **iOS**: no public API for IMEI or serial number exists; no MDM
  workaround available to third-party apps

**Do not attempt to call these APIs directly — they will fail.** Instead,
device identity is captured via:
1. Barcode scan (SIM tray label, back-of-device label, or the `*#06#`
   IMEI screen) — primary path
2. On-device OCR fallback for printed digits with no barcode
3. Manual entry — always available, final fallback
4. Technician confirms/edits the scanned value before it's locked into
   the report (OCR misreads like 0/O, 1/I are common)

Make/model ARE freely available via `Build.MODEL`/`Build.MANUFACTURER`
(Android) and `UIDevice.model` (iOS) — no restriction there.

IMEI is always 15 digits — validate format after capture. Dual-SIM
devices may have two IMEIs (confirm whether both are needed).

## Device verification gate (activation lock / IMEI blacklist)
`packages/shared/src/deviceVerification.ts` runs immediately after
identity capture and confirmation, BEFORE any diagnostic test starts.
This ordering matters: there's no point running a 5-minute test suite on
a device that turns out to be blacklisted or activation-locked.

- **Not buildable in-house.** GSMA blacklist data and Apple iCloud
  Activation Lock (FMIP) / Android Factory Reset Protection status aren't
  independently queryable — this requires a third-party device-
  verification API (`DEVICE_VERIFICATION_API_BASE`). Evaluate providers
  for coverage, latency, and per-lookup cost.
- **`checkEligibility()` is a hard gate, not a warning.** A blacklisted
  or activation-locked device, or one with an outstanding carrier
  balance, should stop the session — never let it continue into cosmetic
  grading or a trade-in quote. Building a quote or resale listing on top
  of an ineligible device is a real financial/legal liability, not just
  a bad data point.
- **UI**: new mobile screen right after PIN entry / before Welcome —
  shows blacklist + activation-lock status, blocks forward progress with
  the specific blocking reason(s) if ineligible.
- Feeds `deviceRouting.ts`'s `determineRouting()` — an ineligible device
  routes to `hold_ineligible`, never auto-routed to resale/repair/recycle.

## Core requirements
- Capture: make, model, serial number, IMEI (via flow above)
- Run diagnostics: battery, sensors, storage, camera, mic, speaker, ports
- Generate a PDF audit report: device details + all test results,
  timestamped, consistent formatting, with provenance shown per result

## Battery health handling (platform-specific)
iOS does not expose battery health via any public API — this is an
Apple policy decision (privacy/fingerprinting concerns + post-"batterygate"
liability caution), not a permissions gap. No entitlement or MDM
exception unlocks it. Do not attempt to query it programmatically on iOS.

- **Android**: read battery health via native `BatteryManager` module.
  Threshold: below 80% = fail.
- **iOS**: captured via human-in-the-loop, same pattern as IMEI/serial:
  1. Manual entry — technician reads "Maximum Capacity" from
     Settings > Battery > Battery Health & Charging, types it in
  2. OCR fallback — reuse the existing ML Kit Text Recognition
     pipeline; extract percentage via `/Maximum Capacity\s*(\d{1,3})%/i`
     from a screenshot/photo of the Battery Health screen
  3. Technician confirms/edits before locking the value, same as
     IMEI/serial capture
  - Apply the same <80% = fail threshold once captured
  - Label this result distinctly in the report: "Battery Health
    (self-reported from device Settings)" — NOT presented identically
    to programmatically-read results, since provenance differs

## Sensor tests
Test pattern: prompt technician for a physical action, capture readings
during the window, check for variance — a dead sensor often still
reports as "present" with a stuck value, so presence alone isn't enough.

- Accelerometer, gyroscope, magnetometer: `react-native-sensors`
  (cross-platform)
- Proximity, ambient light: not well covered by cross-platform libs —
  likely need small native modules (SensorManager on Android,
  CMMotionManager/proximity APIs on iOS)
- Not every device has every sensor (e.g. many tablets lack proximity)
  — mark genuinely absent sensors "skipped" with a note, not "fail"
- Status logic: no readings = fail; readings present but no variance
  during the technician's action = warning; variance detected = pass

## Storage tests
- Capacity (total/free): `react-native-device-info` —
  `getTotalDiskCapacity()` / `getFreeDiskStorage()`, informational only,
  no fail condition on capacity alone
- Read/write health check: `react-native-fs` — write a temp file, read
  it back, verify match, clean up. Catches gross failures (full disk,
  filesystem corruption) but NOT subtle flash degradation — no app-level
  access to SMART-style diagnostics on either platform. Don't let the
  report imply more storage-health certainty than this test provides.

## Camera, Mic, Speaker, Port tests

### Camera
- Test front and back separately (two rows in report, not combined)
- Automated check: capture frame, verify not null / not black
  (luminance threshold — calibrate against known-good devices, don't
  guess a number)
- ALSO require technician visual confirmation of the live preview
  (sharp/focused, no dead pixels) — a black-frame check alone won't
  catch a foggy lens or sensor damage
- source: "api" for the frame check, "manual" for the visual confirmation

### Microphone
- Do NOT use a fixed absolute noise-floor threshold — ambient noise
  varies too much (loud room = false pass, quiet room = false fail)
- Capture a baseline sample in silence first, then the "speak now"
  sample; compare amplitude delta between the two rather than an
  absolute value

### Speaker
- App cannot self-verify audio output — this is a manual-confirmation
  test by design
- UI MUST require an explicit "Yes, I heard it" / "No" choice —
  never default `technicianConfirmed` to true, never treat a timeout
  or click-through as a pass
- Play a specific, recognizable tone (not silence-adjacent) so a
  technician clicking through blind is less likely to accidentally pass

### Charging port
- Poll `getPowerState()` for a state change (unplugged → charging)
  after prompting technician to plug in a cable
- On timeout: mark `"skipped"`, NOT `"fail"` — no cable available
  during testing isn't evidence of a hardware fault, and a fail here
  would misrepresent the audit

### Headphone jack
- Auto-detect whether the device has one (increasingly rare on modern
  phones) — only include this row in the report when the device
  actually has the port; don't show `"skipped"` for devices that
  never had one

## Devices tab (cross-inspection history)
Backend portal groups reports by physical device (serial number, falling
back to IMEI if serial is ever missing) rather than showing every report
as a flat, unrelated list. This surfaces devices that have been
inspected more than once — worth flagging distinctly, since a repeat
inspection with a worsening grade (e.g. A → B → D) is a signal worth a
human's attention (new damage since a prior pass, inconsistent grading
between technicians, or possible mishandling in between inspections).

- Grouping key: `serialNumber` (primary) — same identity, same device,
  regardless of how many separate `AuditReport`s exist for it
- The Devices list surfaces inspection count and a "Repeat" flag for
  devices with 2+ inspections
- The device history view timelines every inspection newest-first, with
  a delta note between consecutive grades (improved/worsened) — don't
  just show the latest report in isolation once a device has history

## Customer profiles & PIN-based test sets
`packages/shared/src/customerProfile.ts` lets an admin (via the backend
portal) define named profiles, each with its own subset of required
tests, and lets a technician load one in the mobile app by entering its
PIN before a session starts.

- **PIN identifies a config, not a person.** A 4–6 digit PIN shared
  across a warehouse is a weak secret — don't treat it as authentication
  for the technician's identity or as an access-control boundary. The
  technician's own login (see "Technician identity" below) is what
  establishes who's running the session; the PIN only selects which
  test set applies.
- **`TEST_CATALOG` must stay in sync with `COMPONENT_MAP`** in
  `reportRenderer.ts` — same testIds, same component grouping — since a
  profile's enabled tests need to map cleanly onto both the diagnostic
  flow and the report layout.
- Backend portal Test Profiles page (`packages/portal/src/pages/Profiles.tsx`,
  API routes in `packages/api/src/routes/profiles.ts`) is the CRUD surface
  — the old "still open decision" for CRUD is built.

## Redo / retest capability
`packages/shared/src/testSession.ts` manages redoing tests — both
single-test redo and the bulk "Redo Flagged Tests" action, available
both before and after the report is generated:

- **Bulk redo (primary UI action)**: `prepareBulkRedo(results)` finds
  every currently fail/warning test, clears just those entries, and
  returns the testIds to re-run. Passing tests are left untouched — the
  UI shows this as "Redo Flagged (N)" with a live count, not a blanket
  "start over."
- **Single-test redo**: tapping an individual test (e.g. a dot in the
  summary grid) re-runs just that one testId via the same
  clear-then-rerun pattern (`clearTestsForRedo` /
  `applyRedoneResults`).
- **A redo replaces the prior result outright** — never append a second
  entry for the same testId. `applyRedoneResults` handles this by
  filtering out old entries for any testId being replaced before
  appending the fresh ones, so summary counts and the report always
  reflect the latest run, and a partial redo (user backs out partway)
  can't leave a testId with duplicate or zero entries.
- **Post-report redo**: regenerating the report after a redo re-runs
  `renderAuditReportPdf` with the updated `results` array. Same-session
  correction keeps the SAME `reportId`, tracked as a revision
  (`ReportRevision`, displayed `DDA-0217-R1`, `-R2`, etc.). A device
  that returns weeks later for a genuinely separate inspection gets its
  own new reportId naturally — that's a new session.

## Cosmetic grading (AI-assisted)
`packages/shared/src/cosmeticInspection.ts` implements guided
multi-angle photo capture + computer-vision damage detection for the
`Cosmetics` and `Grading` test plan keys. Read this before touching
it — the constraints here are different from the rest of the app:

- **No general-purpose on-device model does this.** Unlike barcode/OCR
  (ML Kit, local, free), crack/scratch/dent detection needs a model
  *trained specifically on labeled phone-damage images*. This is a
  standard, published approach (CNN/YOLO-style object detection) but it
  is a real ML undertaking, not a library install.
- **Current implementation calls a hosted inference endpoint**
  (`COSMETIC_INFERENCE_ENDPOINT` env var — e.g. Roboflow-hosted or a
  self-hosted trained model) rather than running on-device. This needs
  network connectivity during inspection. On-device (Core ML/TFLite)
  is a future option once a model is mature enough to ship, but
  converting and maintaining that is separate work from the app itself.
- **No training dataset exists yet.** The realistic path is: start with
  hosted inference, and use technician-confirmed/overridden grades from
  real inspections as labeled ground truth to improve or eventually train
  a proper model. `datasetCollection.ts` captures those corrections.
- **Six guided capture angles**: front (screen), back, top, bottom,
  left, right — screen cracks and housing damage are visually distinct
  problems, so each angle is analyzed and graded contextually (see
  `computeSuggestedGrade` — a screen crack always suggests grade D
  regardless of housing condition).
- **The suggested grade is never final.** `CosmeticGradingResult.
  technicianGrade` is what's locked into the report — the technician
  reviews annotated photos (bounding boxes over detected damage) and
  confirms or overrides before anything is recorded. Never auto-finalize
  a grade from model output alone — this affects resale value, so it
  gets the same never-auto-pass treatment as the speaker/camera manual
  confirmations.

## Country of Origin capture
No public API on either platform returns manufacturing location:
- **Android**: `Build.MANUFACTURER`/`Build.BRAND` give company name (e.g.
  "Samsung"), not country of assembly. Undocumented OEM service-menu dial
  codes exist but vary by manufacturer, aren't part of the public API,
  and can't be triggered programmatically from app code — don't rely on them.
- **iOS**: Apple randomized its serial number format starting in 2021
  specifically to remove the ability to infer manufacturing location from
  it — so unlike pre-2021 devices, this indirect route is also closed.

This value only exists as printed text — on the retail box or a
regulatory label (often inside the SIM tray or on the back housing).
Same human-in-the-loop pattern as IMEI/serial/iOS battery health:
1. Manual entry — technician reads it off the box/regulatory label
2. OCR fallback — reuse the ML Kit Text Recognition pipeline; extract via
   a pattern like `/(Made|Assembled) in ([A-Za-z ]+)/i` from a photo of
   the label
3. Technician confirms/edits before locking the value

Groups under Housing & Cosmetics in the report, alongside Device Color
and Cosmetics — all human-observed fields, not OS-queryable ones.

## DiagnosticResult type (current)
Defined in `packages/shared/src/types.ts`.

```typescript
interface DiagnosticResult {
  testId: string;
  label: string;
  status: "pass" | "fail" | "warning" | "skipped";
  value?: string | number;
  notes?: string;
  source: "api" | "manual" | "ocr";
  timestamp: string;
}

interface AuditReport {
  reportId: string;
  generatedAt: string;
  technicianId?: string;
  device: {
    make: string;
    model: string;
    serialNumber: string;
    imei: string;
    imei2?: string;
    captureSource: "barcode" | "ocr" | "manual";
  };
  results: DiagnosticResult[];
  overallStatus: "pass" | "fail" | "pass_with_warnings";
}
```

## PDF report rendering
`packages/shared/src/reportRenderer.ts` is the canonical render path —
takes a real `AuditReport` object (plus optional `routing` and
`wipeCertificate`) and produces the two-part PDF:
1. Page 1: condensed summary (device identity, pass/flagged stat blocks,
   a routing-decision badge next to the overall status badge, a
   **Certified Data Erasure** card when a wipe certificate is passed in,
   a per-component result-dot matrix, and a "Flagged Items" table listing
   only fail/warning results)
2. Following pages: full per-test detail appendix, grouped by physical
   device component (Display, Buttons, Camera, Audio, Ports, Sensors,
   Battery & Charging, Wireless Radios, Cellular & SIM, Stylus, Housing &
   Cosmetics, System & Software)

**QR code**: passing `publicReportBaseUrl` adds a QR code to the header
linking to a public report summary. Public view shows device identity +
grade + pass/flag counts ONLY — never technician notes, redo history, or
raw cosmetic photos. Uses the `qrcode` npm package (`QRCode.toDataURL`)
embedded as a PNG data URI — no native QR rendering dependency needed
since this is already an HTML→PDF pipeline.

Uses `react-native-html-to-pdf`. Grouping is driven by `COMPONENT_MAP`
inside `reportRenderer.ts` (keyed by `testId`) — extend this map whenever
a new diagnostic test is added, alongside `REMOTE_TEST_PLAN_REGISTRY`.
These two mappings serve different purposes: the registry is about
backend submission keys, `COMPONENT_MAP` is purely about report layout.

## Test plan / return key registry
`packages/shared/src/testPlanRegistry.remote.ts` contains the full
Remote-mode `TestPlanKey` → `ReturnKey` mapping used for backend/report
submission — this is the authoritative source for these keys, sourced
from `test_plan_return_keys.md`. Use its exported
`REMOTE_TEST_PLAN_REGISTRY` array and the `getTestPlanEntry` /
`resolveTestPlanKeyFromReturnKey` helpers rather than redefining or
guessing these keys elsewhere.

Two entries use dynamic (non-exact-match) child keys, already handled by
`resolveTestPlanKeyFromReturnKey`:
- `Custom Tests` — children are prefixed `C-`
- `Cosmetics` — children use the `!@#$%|{shortKey}!@#$%|` delimiter pattern

Note this registry is broader than the diagnostics tests already
described above (battery/sensors/storage/camera/mic/speaker/ports) — it
also covers operational tests (WiFi, GPS, buttons, S-Pen, dual-SIM call
tests, cosmetics/grading, SD card, etc.) tied to the backend reporting
system, not all of which may be implemented as in-app test logic yet.

## Certified data wipe
`packages/shared/src/dataWipe.ts` extends the existing `factory_reset`
test with an actual erasure certificate (`DataWipeCertificate`), not
just a pass/fail flag — the trade-in industry needs an attestation for
liability/compliance reasons if personal data on a resold device ever
becomes a dispute.
- **Clear** (single-pass, standard factory reset) is adequate for most
  consumer resale.
- **Purge** (NIST 800-88 multi-pass/cryptographic erase) is what
  compliance-driven corporate customers often require — this is a good
  candidate for a per-profile setting in `customerProfile.ts` (require
  Purge for specific customer profiles).
- Certificate should be a distinct artifact/section in the report, not
  buried as a single test row — same visual weight as the audit summary.
- `generateWipeCertificate()` requires `tenantId` and logs
  `data_wipe_certified` to the activity log.

## Trade-in valuation & payout
`packages/shared/src/tradeInQuote.ts` computes an offer from device
model + cosmetic grade + functional test results, once you have a
`MarketPriceEntry` price table (external dependency — not something this
app produces, needs a market-price feed).
- Deducts from grade base price for specific failed/warning functional
  tests (battery, camera, speaker, mic, charging port) — a cosmetically
  "A" device with a failed battery shouldn't get full A-grade money.
- **Quotes expire** (7-day default) — prices move; don't let a quote sit
  open-ended.
- `PayoutRecord` tracks disbursement (store credit/ACH/PayPal/gift card)
  as a separate lifecycle from the quote itself — a quote can be
  accepted without payout being complete yet.

## Fraud & authenticity checks
`packages/shared/src/fraudDetection.ts` — two detection aids, both flags
for technician review, NOT automatic rejections:
- **Component authenticity** (`checkComponentAuthenticity`): flags likely
  non-genuine replacement screens/batteries via the same hosted CV
  pipeline as cosmetic grading — but needs its OWN labeled training
  examples (genuine vs. aftermarket parts), distinct from the damage-
  detection dataset. Don't assume the cosmetic-grading model handles
  this for free.
- **Serial mismatch** (`detectSerialMismatch`): compares the barcode/OCR-
  scanned serial against what the device's own software reports (this
  IS queryable via standard device-info APIs, unlike IMEI/serial
  themselves). A mismatch usually means a swapped logic board.

## Post-grading routing
`packages/shared/src/deviceRouting.ts`'s `determineRouting()` decides
resale / repair / parts_harvest / recycle / hold_ineligible after
grading completes. Ineligible devices (see verification gate above)
always route to `hold_ineligible` regardless of grade — this overrides
everything else. Surface routing decision in both the report and the
Devices tab (backend portal) so operations can act on it without
re-deriving it from raw results.

## Bulk batch intake
`packages/shared/src/batchSession.ts` — a batch ties multiple devices to
one source (e.g. a carrier buyback lot) and typically one customer
profile/PIN applied to every device in the lot, rather than re-entering
a PIN per device. Re-scanning the same serial within a batch is a no-op,
not a duplicate entry (`addDeviceToBatch` dedupes).

Mobile flow: `mobile_batch_intake.html` mockup — three screens (Start
Batch, Scan Devices, Batch Progress), a SEPARATE flow branching off
right after Technician Login rather than inserted into the main
per-device journey.

## Offline mode
`packages/shared/src/offlineSync.ts` — only two things in this app
actually need network: cosmetic CV inference and the device-verification
blacklist/activation-lock check. Everything else (capture, OCR, sensor
tests, camera/audio tests) works fully offline already. The queue
pattern here lets a technician keep working through a session in poor
connectivity — those two specific results get marked "pending sync"
rather than blocking the whole workflow. Stop retrying after 5 attempts
and surface the stuck operation rather than retrying silently forever.

## QR-linked audit certificate
The QR code on page 1 of the PDF (rendered by `reportRenderer.ts`) links
to a public, buyer-safe version of the report — the "Certified Pre-
Owned" trust signal the industry expects. Public view shows device
identity + grade + pass summary, NOT the full technician notes, redo
history, or raw cosmetic photos. Consumer-side rendering lives in
`packages/consumer/src/Tracker.tsx`; API surface is
`packages/api/src/routes/publicTracker.ts`.

## ESG / compliance reporting
Backend portal `packages/portal/src/pages/Compliance.tsx` +
`packages/api/src/routes/compliance.ts` aggregate resale vs. repair vs.
recycle counts (from `deviceRouting.ts` decisions) into a reportable
summary — R2v3/e-Stewards-style reporting is increasingly expected by
corporate trade-in clients specifically, separate from the operational
Dashboard. CSV export supported.

## Data sourcing status (read before deciding this is "done")
Three of the features above have real code but NOT real underlying data
yet — don't mistake the code existing for the capability being production-
ready:
- **Market pricing**: `marketPriceData.ts` has a seed table, explicitly
  marked as rough/illustrative. Needs a real pricing API/feed before use.
- **Device verification**: `deviceVerification.ts` has header comments
  naming real providers active in this space (CellDe and others) — but
  GSMA blacklist and Apple/Google activation-lock data is licensed, not
  public. You must sign up with a real provider; there's no way around this.
- **Fraud/authenticity detection**: `fraudDetection.ts`'s
  `checkComponentAuthenticity` has NO usable public training data. This
  needs original data from your own repair inventory (photograph
  known-genuine vs. known-aftermarket parts) or should ship as a manual
  technician checklist instead of a CV model until that data exists.
- **Cosmetic grading dataset**: `docs/cosmetic_grading_dataset_plan.md`
  lists real public datasets (~2,000-2,300 images combined, verify
  license per dataset) as a pipeline-validation starting point, plus
  `datasetCollection.ts` for capturing your own technician-corrected
  labels going forward — production accuracy will come from the latter,
  not the public datasets.

## Payout flow
Consumer side: `consumer_payout.html` mockup, implemented in
`packages/consumer/src/Tracker.tsx` — shown after offer acceptance,
method selection (Store Credit with a bonus incentive, ACH, PayPal, Gift
Card) against the existing `PayoutMethod`/`PayoutRecord` types in
`tradeInQuote.ts`. Admin side: report detail view
(`packages/portal/src/pages/Reports.tsx`) has a Payout card (offer
amount, status, method, quote expiry) alongside Device Identity and
Session.

## Offline sync indicator
Report detail view demonstrates the pattern: any field/result still
queued in `offlineSync.ts`'s queue shows a `.source-tag.sync-pending`
badge ("⟳ Pending Sync") instead of its normal source tag, until the
queued operation completes. Applies to the two network-dependent
operations only (cosmetic CV inference, device verification) — see
`offlineSync.ts` for why nothing else needs this treatment.

## Dispute / review flow
- **Consumer side** (`consumer_dispute.html` mockup, in
  `packages/consumer/src/Tracker.tsx`): reached via "Request a review"
  on the consumer tracker. Lets the customer pick what they're
  disputing (specific test finding, or overall grade), explain in their
  own words, optionally attach a supporting photo.
- **Admin side** (`admin_portal_disputes.html` mockup,
  `packages/portal/src/pages/Disputes.tsx`,
  `packages/api/src/routes/disputes.ts`): a queue separate from
  Reports — open disputes need action (Review Original Photos / Uphold
  Grade / Adjust Grade), resolved ones show the outcome and reasoning
  for audit purposes. Wired backend logic — resolution logs
  `dispute_upheld` / `dispute_grade_adjusted` to the activity log.
- **While a dispute is open, the device and offer stay on hold** — don't
  let payout processing or report finalization proceed until resolved.
- Resolution should feed back into `datasetCollection.ts`'s training
  examples where relevant (an admin-corrected grade after a legitimate
  dispute is exactly the kind of technician-correction signal that
  improves the model over time).

## Profile QR scanning
Profile selection is scan-first, matching the barcode-scan-first pattern
already used for device identity capture — manual PIN entry is the
fallback, not the default path.

- Backend portal (Test Profiles editor) generates an actual QR code per
  profile via `generateProfileQrPayload()` in `customerProfile.ts`,
  encoding `DIAGPROFILE:{tenantId}:{pin}` (prefixed so the scanner can
  tell a profile QR apart from other codes, e.g. a device barcode
  scanned later in the same session; tenant scoped since multi-tenancy)
  — download/print it and post at the customer's intake station
- Mobile app scans this with the same ML Kit barcode module used for
  device ID capture — `parseProfileQrPayload()` extracts tenant + PIN,
  then flows into the existing `resolveProfileByPin()` unchanged
- A malformed/non-profile QR scan returns null from
  `parseProfileQrPayload` — treat as a failed scan, don't attempt to
  resolve garbage as a PIN
- Manual PIN entry still exists as the fallback ("Can't scan? Enter PIN
  manually") for a missing/damaged QR code, and needs a tenant picker
  step first since typed digits alone are ambiguous across tenants

## Multi-tenant architecture (MAJOR — read this before touching anything else)
**This is a SaaS platform serving multiple separate companies (tenants),
each with fully isolated data, plus a Master Admin role that manages
the platform across all tenants.** Everything not written with this in
mind will silently leak data across tenants — this is the single
highest-risk pattern in the codebase.

### The rule
Every tenant-scoped API route MUST:
1. Sit behind `requireAuth` → `requireTenantScope` (middleware in
   `packages/api/src/middleware/`)
2. Filter every Prisma query by `session.viewingTenantId`, using the
   `tenantWhere` helper — never a bare `where` without it
3. On CREATE, set `tenantId = session.viewingTenantId` — never trust the
   request body to name a tenant

`packages/api/src/routes/reports.ts` is the reference implementation.
The `tests/tenantIsolation.ts` suite is the load-bearing regression test
for cross-tenant leakage — new tenant-scoped resources should get a
matching leakage test.

There is a `.claude/agents/tenant-scope-reviewer.md` sub-agent
specifically for reviewing new or modified API routes against these
rules — use it on any new route file.

### Data model
- **`tenant.ts`** — the actual top-level entity. One `Tenant` = one
  paying company (Acme Wireless, TechTrade Refurb, etc.).
- **`CustomerProfile` lives WITHIN a tenant** and carries a `tenantId`.
  A single tenant can have multiple profiles (different programs or
  locations under one company).
- **`License` lives at the tenant level** — billing happens once per
  tenant, not once per profile.
- **Profile QR payload encodes `{tenantId}:{pin}` together**, not just
  the PIN — PINs are unique within a tenant, not globally.
- **`Technician` carries `tenantId`** — badge codes are unique within a
  tenant, so `generateTechnicianBadgePayload`/
  `parseTechnicianBadgePayload` mirror the profile QR pattern exactly.

### Portal
- **`portalAuth.ts`** — three roles: `tenant_admin`, `tenant_staff`
  (both scoped to exactly one tenant, never settable), and
  `master_admin` (not scoped to any single tenant).
  `PortalSession.viewingTenantId` is what every tenant-scoped page's
  queries must filter by.
- **`portal_login.html`** routes by role: tenant users land in their own
  portal, master_admin lands in the Master Console.
- **`master_console.html`** — cross-tenant view; deliberately styled
  with a DIFFERENT dark theme from the tenant-facing portal so a
  superuser context is never visually confusable with a normal tenant
  view.
- **`enterTenantView()`/`exitTenantView()`** in `portalAuth.ts` — how a
  master_admin drops into one tenant's portal for support purposes.
  Explicit, logged action — never silent, never automatic.

### Tenant indicator
Every tenant-scoped portal page shows a tenant-indicator badge (Dashboard,
Report Detail, Devices, Device History, Test Profiles, Compliance,
Disputes, Billing & Licenses, Team, Settings, Integrations, Batch Intake,
Warranty, Invoices, Activity Log). This is structural (`TenantShell` in
`packages/portal/src/components/Shell.tsx` wraps every `TenantRoute`),
not per-page.

The badge is a VISUAL convention, not a data guarantee — each page's
actual data-fetching logic still needs to filter by
`session.viewingTenantId` server-side. The badge tells a human which
tenant they're looking at; it doesn't stop the underlying query from
accidentally pulling another tenant's rows if that filter isn't wired
in. Treat the badge as the UI half of this problem and the query-level
scoping as the other, equally necessary half.

## Technician identity
`packages/shared/src/technicianAuth.ts` — a lightweight login SEPARATE
from the customer profile PIN in `customerProfile.ts`. These solve two
different problems and were deliberately kept apart rather than
overloaded into one PIN:
- Customer profile PIN → selects WHICH tests run (config, entered per
  device/session)
- Technician login → establishes WHO is running the session (identity,
  entered once per shift)

Badge scan or short code, not full username/password — the tablet is
already facility-access-controlled, so this is about attribution (redo
history, dispute resolution notes, QA/accuracy metrics), not security.
Mobile screen: Step 1, before PIN entry, session-level not per-device.

Technician badge cards are printed with a QR encoding
`{tenantId}:{badgeCode}` together
(`generateTechnicianBadgePayload`/`parseTechnicianBadgePayload`,
mirroring the profile QR pattern). Manual badge-code entry needs a
tenant picker first, same as manual PIN entry.

## Previously open decisions — now resolved
1. **Redo → reportId**: a same-session correction keeps the SAME
   reportId, tracked as a `ReportRevision` (`DDA-0217-R1`, `-R2`, etc.).
2. **PIN fallback**: unrecognized PIN BLOCKS the session — never
   silent-falls-back to a default profile.
3. **PIN uniqueness**: unique WITHIN a tenant (multi-tenancy resolved
   the earlier "global vs per-location" ambiguity). Move to 5-6 digit
   PINs as active profile count grows.
4. **Technician login**: added — see "Technician identity" above.

## Data retention policy
**Data is kept forever — no automatic expiry or purge.** Applies to all
captured data: IMEI/serial, cosmetic photos, dispute records, technician
attribution, redo history. No TTL, no archival-then-delete job, no
"delete after N years" logic anywhere in this system.

A manual right-to-deletion admin action exists for GDPR/CCPA compliance
(see commit `359fbbc`) — that removes one customer's records on request.
There is no automatic process; the obligation to honor a specific
deletion request still needs to be actioned manually.

## Licensing model
`packages/shared/src/licensing.ts` — license lives at the tenant level
(not per-technician). Four plan types:
- **Per-inspection**: metered, one credit consumed per COMPLETED session
  (not per test — an abandoned session shouldn't consume a credit).
  Blocks at zero remaining credits, no overage.
- **Seat subscription**: N technician seats, unlimited inspections per
  seat. Blocks when all seats are in use.
- **Tiered subscription**: included quota + billed overage — doesn't
  block past quota, bills the difference instead.
- **Enterprise unlimited**: flat fee, no per-use limit.

**Checked before device eligibility, not after** — new mobile Step 3,
right after the profile QR scan and before the blacklist/activation-lock
check. No point running a paid verification API call on a session the
tenant isn't licensed to run in the first place. Same hard-gate pattern
as everything else in this app: expired/suspended/quota-exceeded blocks
outright, never silently degrades or lets the session continue.

Backend portal **Billing & Licenses** page (`Misc.tsx`'s `BillingPage`,
`packages/api/src/routes/licenses.ts` + `billing.ts`): one row per
tenant showing plan type, usage against quota, status, and renewal date.

## Seat-to-technician linkage
`licensing.ts`'s `consumeSeat()`/`releaseSeat()` are called alongside
`technicianAuth.ts`'s `startShift()`/`endShift()` at the call site (not
inside either module, since not every license type needs seat tracking).

## License provisioning & invoicing
- `provisionLicense()` is what the Billing page's "New License" form
  calls (requires `actorUserId` + `actorRole`; logs
  `license_provisioned` to the activity log).
- `packages/shared/src/invoicing.ts` generates invoice records (line
  items, overage calculation for tiered plans) from license usage data.
  It does NOT charge anyone — it produces what to bill. Stripe Billing
  (wired via `packages/api/src/routes/billing.ts` +
  `packages/api/src/lib/stripe.ts`) is the collection layer.

## Team & Settings pages
- **Team** (`admin_portal_team.html`, `Misc.tsx`'s `TeamPage`):
  technician roster, badge codes, shift status, and seat assignment,
  plus portal user management (`UsersSection` from `Users.tsx`) on the
  same page — deliberately together, since both answer "who works
  here," just for the tablet vs. the portal. **QA metrics** (redo rate,
  dispute rate per technician) are wired via
  `GET /qa-metrics/technicians` (`packages/api/src/routes/qaMetrics.ts`),
  displayed as extra columns. Both rates use distinct-reports semantics
  (a report revised twice still counts as one "needed a second look"),
  and a technician with zero reports shows a dash rather than 0% so a
  new hire isn't rendered as a top performer by accident.
- **Settings** (`admin_portal_settings.html`, `Misc.tsx`'s
  `SettingsPage`, `packages/api/src/routes/orgSettings.ts`): real,
  enforced persistence — not a mockup. Tenant config: data retention
  policy (stated explicitly as forever, manual deletion only),
  defaults (wipe standard, PIN length), a Security section for the
  signed-in user's own MFA, a Single sign-on section for the tenant's
  OIDC connection, and notification toggles (SMS/email; Twilio +
  SendGrid delivery is wired in `packages/api/src/lib/notificationDelivery.ts`
  and degrades gracefully without creds).

## Marketplace listings & warranty tracking
Both buildable now, pure data/logic, no new external dependency:
- `packages/shared/src/marketplaceListing.ts` — generates
  title/description/price from existing `AuditReport` + `TradeInQuote`
  data for a device routed to resale. Price is a placeholder markup
  formula — replace with real pricing strategy. API:
  `packages/api/src/routes/listings.ts`.
- `packages/shared/src/warrantyTracking.ts` — links a post-sale claim
  back to the original `reportId`. `claimRateByTechnician()` surfaces a
  pattern worth watching, same idea as the Devices tab's
  worsening-grade-trend flag. `fileWarrantyClaim()` requires `tenantId`
  + `actorUserId` and logs `warranty_claim_filed` to the activity log.
  API: `packages/api/src/routes/warrantyClaims.ts`.

## Notifications, shipping, and KYC/AML — all need a real external service
Three modules with the same shape: real logic for WHEN/WHAT, wired
delivery for two of them. Don't assume the delivery is production-ready
without creds.
- `packages/shared/src/notifications.ts` — SMS/email templates per
  consumer-tracker stage transition; **delivery is wired** via
  `packages/api/src/lib/notificationDelivery.ts` (Twilio + SendGrid).
  No-ops when creds are absent.
- `packages/shared/src/shippingLogistics.ts` — inbound label + tracking
  data model; needs EasyPost/Shippo-or-similar to generate a real, valid
  label. Not wired.
- `packages/shared/src/kycVerification.ts` — payout threshold gate
  logic; needs Persona/Jumio/Onfido-or-similar for actual identity
  verification. **The $600 threshold is illustrative, not legal
  advice** — get the real number and applicable jurisdictions from
  counsel before shipping.

## Admin activity log
`packages/shared/src/adminActivityLog.ts` (+ the writer in
`packages/api/src/lib/activityLog.ts`) — the central audit trail for
every admin and system action. Portal page:
`admin_portal_activity_log.html` mockup, `Misc.tsx`'s `ActivityLogPage`,
API in `packages/api/src/routes/activityLog.ts`. Filterable by action
type (Auth, Billing, Tenants, Profiles, Licences, Disputes, Reports,
Warranty, Pricing, Settings). Tenant-scoped.

### Integration map (which module → which action → which call site)
- `portalAuth.ts` → `portal_login`, `entered_tenant_view` /
  `exited_tenant_view`
- `tenant.ts` → `tenant_created`, `tenant_suspended`, `tenant_activated`
- `licensing.ts` → `license_provisioned`
- `testSession.ts` → `report_revision_created`
- `dataWipe.ts` → `data_wipe_certified`
- `warrantyTracking.ts` → `warranty_claim_filed`
- `marketPriceUpload.ts` → `pricing_uploaded`
- `routes/disputes.ts` → `dispute_upheld` / `dispute_grade_adjusted`
- `routes/orgSettings.ts` → `settings_updated`
- `routes/profiles.ts` → `profile_created` / `profile_updated` /
  `profile_deleted`
- `routes/auth.ts` → `portal_mfa_enabled` / `portal_mfa_disabled`,
  `sso_login`, `portal_login`
- `routes/integrations.ts` → `api_key_created` / `api_key_revoked`,
  `webhook_created`
- `routes/sso.ts` → `sso_connection_configured`
- `routes/billing.ts` → `billing_checkout_completed`,
  `billing_payment_failed`, `billing_payment_recovered`,
  `billing_subscription_canceled` — all four logged with
  `actorUserId: "stripe"` since Stripe's webhook, not a portal session,
  is what triggers them

Any new admin action MUST write to the activity log — search for
`writeActivity` in the API layer for the pattern.

## Testing conventions
- API: real Postgres for every test; single-worker; each suite gets a
  fresh schema. Use fixtures in `tests/fixtures.ts` and helpers in
  `tests/helpers.ts`. Never mock Prisma.
- Portal / consumer: Playwright driven from raw `.mjs` (no
  `@playwright/test`). See `e2e/harness.mjs` for the pattern.
- Mobile: Jest unit tests for `lib/` modules; e2e is a Node script
  hitting the API. UI navigation is not currently in an automated harness
  — physical devices required for camera/hardware flows.

## Notes for Claude Code
- Ask before adding new native dependencies to the mobile app — native
  modules are the highest-risk part to get wrong, and there are none
  currently (all diagnostics run through JS libraries).
- Don't attempt IMEI/serial via `TelephonyManager` or `UIDevice` — see
  constraint above.
- Treat IMEI/serial handling as sensitive — don't log full values in
  debug output or commit them to fixtures.
- For any manual-confirmation test (speaker, camera visual check),
  never default to a pass — require explicit technician action.
- For any new tenant-scoped API route, run the
  `tenant-scope-reviewer` sub-agent before considering it done.
- There is no CI. Run the relevant workspace's tests before pushing —
  Render/Netlify will deploy on merge whether or not they pass locally.
