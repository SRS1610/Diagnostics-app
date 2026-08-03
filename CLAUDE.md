# Device Diagnostics App

## Overview
Cross-platform (iOS + Android) mobile app for diagnosing internal phone
components. Core flow: capture device identity → run diagnostic tests →
generate a signed audit-trail PDF report.

## Stack
- React Native (TypeScript)
- Native modules (Swift for iOS, Kotlin for Android) for diagnostics APIs
  not exposed to JS
- Camera: `react-native-vision-camera`
- Barcode: ML Kit barcode module (on-device, no network)
- OCR: ML Kit Text Recognition (on-device, no network)
- PDF generation: HTML template rendered via `react-native-html-to-pdf`

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
`deviceVerification.ts` (project root) runs immediately after identity
capture and confirmation, BEFORE any diagnostic test starts. This ordering
matters: there's no point running a 5-minute test suite on a device that
turns out to be blacklisted or activation-locked.

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
`customerProfile.ts` (project root) lets an admin (via the backend portal)
define named profiles, each with its own subset of required tests, and
lets a technician load one in the mobile app by entering its PIN before
a session starts.

- **PIN identifies a config, not a person.** A 4–6 digit PIN shared
  across a warehouse is a weak secret — don't treat it as authentication
  for the technician's identity or as an access-control boundary. The
  technician's own login (if the app has one) is what should establish
  who's running the session; the PIN only selects which test set applies.
- **Two open decisions to make before shipping:**
  1. What happens on an unrecognized PIN — block the session with an
     error, or fall back to a default full-suite profile? Silent
     fallback risks running the wrong (larger or smaller) test set
     without the technician noticing.
  2. Whether PINs must be globally unique, or unique only within an
     org/location — affects how `resolveProfileByPin` should be scoped.
- **`TEST_CATALOG` must stay in sync with `COMPONENT_MAP`** in
  `reportRenderer.ts` — same testIds, same component grouping — since a
  profile's enabled tests need to map cleanly onto both the diagnostic
  flow and the report layout.
- Backend portal gets a new "Test Profiles" section (list + create/edit)
  for managing these — see the admin portal mockups for the intended
  layout: a profile list (name, PIN, test count, last updated) plus a
  creation panel with tests grouped and checkboxed by component.

## Redo / retest capability
`testSession.ts` (project root) manages redoing tests — both single-test
redo and the bulk "Redo Flagged Tests" action, available both before and
after the report is generated:

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
  `renderAuditReportPdf` with the updated `results` array. Keep the
  original `reportId` if this is a revision of the same session, or mint
  a new one if your backend needs to distinguish "corrected" reports —
  decide this before shipping, since it affects how re-submissions
  reconcile against `testPlanRegistry.remote.ts` on the backend.

## Cosmetic grading (AI-assisted)
`cosmeticInspection.ts` (project root) implements guided multi-angle photo
capture + computer-vision damage detection for the `Cosmetics` and
`Grading` test plan keys. Read this before touching it — the constraints
here are different from the rest of the app:

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
  a proper model.
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
`reportRenderer.ts` (project root) is the canonical render path — takes a
real `AuditReport` object (plus optional `routing` and `wipeCertificate`)
and produces the two-part PDF:
1. Page 1: condensed summary (device identity, pass/flagged stat blocks,
   a routing-decision badge next to the overall status badge, a
   **Certified Data Erasure** card when a wipe certificate is passed in,
   a per-component result-dot matrix, and a "Flagged Items" table listing
   only fail/warning results)
2. Following pages: full per-test detail appendix, grouped by physical
   device component (Display, Buttons, Camera, Audio, Ports, Sensors,
   Battery & Charging, Wireless Radios, Cellular & SIM, Stylus, Housing &
   Cosmetics, System & Software)

**QR code (RESOLVED)**: passing `publicReportBaseUrl` adds a QR code to
the header linking to a public report summary. Public view shows device
identity + grade + pass/flag counts ONLY — never technician notes, redo
history, or raw cosmetic photos. Uses the `qrcode` npm package
(`QRCode.toDataURL`) embedded as a PNG data URI — no native QR rendering
dependency needed since this is already an HTML→PDF pipeline.

Uses `react-native-html-to-pdf`. Grouping is driven by `COMPONENT_MAP`
inside `reportRenderer.ts` (keyed by `testId`) — extend this map whenever
a new diagnostic test is added, alongside `REMOTE_TEST_PLAN_REGISTRY`.
These two mappings serve different purposes: the registry is about
backend submission keys, `COMPONENT_MAP` is purely about report layout.

## Test plan / return key registry
`testPlanRegistry.remote.ts` (project root) contains the full Remote-mode
`TestPlanKey` → `ReturnKey` mapping used for backend/report submission —
this is the authoritative source for these keys, sourced from
`test_plan_return_keys.md`. Use its exported `REMOTE_TEST_PLAN_REGISTRY`
array and the `getTestPlanEntry` / `resolveTestPlanKeyFromReturnKey`
helpers rather than redefining or guessing these keys elsewhere.

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
`dataWipe.ts` extends the existing `factory_reset` test with an actual
erasure certificate (`DataWipeCertificate`), not just a pass/fail flag —
the trade-in industry needs an attestation for liability/compliance
reasons if personal data on a resold device ever becomes a dispute.
- **Clear** (single-pass, standard factory reset) is adequate for most
  consumer resale.
- **Purge** (NIST 800-88 multi-pass/cryptographic erase) is what
  compliance-driven corporate customers often require — this is a good
  candidate for a per-profile setting in `customerProfile.ts` (require
  Purge for specific customer profiles).
- Certificate should be a distinct artifact/section in the report, not
  buried as a single test row — same visual weight as the audit summary.

## Trade-in valuation & payout
`tradeInQuote.ts` computes an offer from device model + cosmetic grade +
functional test results, once you have a `MarketPriceEntry` price table
(external dependency — not something this app produces, needs a market-
price feed).
- Deducts from grade base price for specific failed/warning functional
  tests (battery, camera, speaker, mic, charging port) — a cosmetically
  "A" device with a failed battery shouldn't get full A-grade money.
- **Quotes expire** (7-day default) — prices move; don't let a quote sit
  open-ended.
- `PayoutRecord` tracks disbursement (store credit/ACH/PayPal/gift card)
  as a separate lifecycle from the quote itself — a quote can be
  accepted without payout being complete yet.

## Fraud & authenticity checks
`fraudDetection.ts` — two detection aids, both flags for technician
review, NOT automatic rejections:
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
`deviceRouting.ts`'s `determineRouting()` decides resale / repair /
parts_harvest / recycle / hold_ineligible after grading completes.
Ineligible devices (see verification gate above) always route to
`hold_ineligible` regardless of grade — this overrides everything else.
Surface routing decision in both the report and the Devices tab (backend
portal) so operations can act on it without re-deriving it from raw
results.

## Bulk batch intake
`batchSession.ts` — a batch ties multiple devices to one source (e.g. a
carrier buyback lot) and typically one customer profile/PIN applied to
every device in the lot, rather than re-entering a PIN per device.
Re-scanning the same serial within a batch is a no-op, not a duplicate
entry (`addDeviceToBatch` dedupes).

## Offline mode
`offlineSync.ts` — only two things in this app actually need network:
cosmetic CV inference and the device-verification blacklist/activation-
lock check. Everything else (capture, OCR, sensor tests, camera/audio
tests) works fully offline already. The queue pattern here lets a
technician keep working through a session in poor connectivity — those
two specific results get marked "pending sync" rather than blocking the
whole workflow. Stop retrying after 5 attempts and surface the stuck
operation rather than retrying silently forever.

## QR-linked audit certificate
Add a QR code to the PDF report (page 1, near the header) linking to a
public, buyer-safe version of the report — this is the "Certified Pre-
Owned" trust signal the industry expects. The public version should
show device identity + grade + pass summary, NOT the full technician
notes, redo history, or raw cosmetic photos — decide what's actually
safe to expose before building the public endpoint.

## ESG / compliance reporting
Backend portal addition: aggregate resale vs. repair vs. recycle counts
(from `deviceRouting.ts` decisions) into a reportable summary — R2v3/
e-Stewards-style reporting is increasingly expected by corporate trade-
in clients specifically, separate from the operational Dashboard.

## Data sourcing status (read before deciding this is "done")
Three of the features above have real code but NOT real underlying data
yet — don't mistake the code existing for the capability being production-
ready:
- **Market pricing**: `marketPriceData.ts` has a seed table, explicitly
  marked as rough/illustrative — general web search on trade-in pricing
  produced wildly inconsistent numbers across sources (same model/
  condition varying by 2x+), which is a sign of low-quality SEO content,
  not real market data. Needs a real pricing API/feed before use.
- **Device verification**: `deviceVerification.ts` has header comments
  naming real providers active in this space (CellDe and others) — but
  GSMA blacklist and Apple/Google activation-lock data is licensed, not
  public. You must sign up with a real provider; there's no way around this.
- **Fraud/authenticity detection**: `fraudDetection.ts`'s
  `checkComponentAuthenticity` has NO usable public training data —
  searched for specifically, nothing found. This needs original data from
  your own repair inventory (photograph known-genuine vs. known-
  aftermarket parts) or should ship as a manual technician checklist
  instead of a CV model until that data exists.
- **Cosmetic grading dataset**: `cosmetic_grading_dataset_plan.md` lists
  real public datasets (~2,000-2,300 images combined, verify license per
  dataset) as a pipeline-validation starting point, plus
  `datasetCollection.ts` for capturing your own technician-corrected
  labels going forward — production accuracy will come from the latter,
  not the public datasets.

## Payout flow
Consumer side: `consumer_payout.html` — shown after offer acceptance,
method selection (Store Credit with a bonus incentive, ACH, PayPal, Gift
Card) against the existing `PayoutMethod`/`PayoutRecord` types in
`tradeInQuote.ts`. Admin side: report detail view now has a Payout card
(offer amount, status, method, quote expiry) alongside Device Identity
and Session.

## Offline sync indicator
Report detail view demonstrates the pattern: any field/result still
queued in `offlineSync.ts`'s queue shows a `.source-tag.sync-pending`
badge ("⟳ Pending Sync") instead of its normal source tag, until the
queued operation completes. Applies to the two network-dependent
operations only (cosmetic CV inference, device verification) — see
`offlineSync.ts` for why nothing else needs this treatment.

## Dispute / review flow
New end-to-end flow, not present before this addition:
- **Consumer side** (`consumer_dispute.html`): reached via "Request a
  review" on the consumer tracker. Lets the customer pick what they're
  disputing (specific test finding, or overall grade), explain in their
  own words, optionally attach a supporting photo.
- **Admin side** (`admin_portal_disputes.html`): a queue separate from
  Reports — open disputes need action (Review Original Photos / Uphold
  Grade / Adjust Grade), resolved ones show the outcome and reasoning
  for audit purposes.
- **While a dispute is open, the device and offer stay on hold** — don't
  let payout processing or report finalization proceed until resolved.
- Resolution should feed back into `datasetCollection.ts`'s training
  examples where relevant (an admin-corrected grade after a legitimate
  dispute is exactly the kind of technician-correction signal that
  improves the model over time).

## Profile QR scanning
Profile selection is now scan-first, matching the barcode-scan-first
pattern already used for device identity capture — manual PIN entry is
the fallback, not the default path.

- Backend portal (Test Profiles editor) generates an actual QR code per
  profile via `generateProfileQrPayload()` in `customerProfile.ts`,
  encoding `DIAGPROFILE:{pin}` (prefixed so the scanner can tell a
  profile QR apart from other codes, e.g. a device barcode scanned
  later in the same session) — download/print it and post at the
  customer's intake station
- Mobile app (Step 2) scans this with the same ML Kit barcode module
  used for device ID capture — `parseProfileQrPayload()` extracts the
  PIN, then flows into the existing `resolveProfileByPin()` unchanged
- A malformed/non-profile QR scan returns null from
  `parseProfileQrPayload` — treat as a failed scan, don't attempt to
  resolve garbage as a PIN
- Manual PIN entry still exists as the fallback ("Can't scan? Enter PIN
  manually") for a missing/damaged QR code

## Multi-tenant architecture (MAJOR — read this before touching anything else)
**RESOLVED: this is a SaaS platform serving multiple separate companies
(tenants), each with fully isolated data, plus a Master Admin role that
manages the platform across all tenants.** Everything built before this
point assumed a single implicit organization — that assumption is now
wrong, and several things needed correcting as a result.

### What changed
- **`tenant.ts`** (new) — the actual top-level entity. One `Tenant` =
  one paying company (Acme Wireless, TechTrade Refurb, etc.).
- **`CustomerProfile` no longer IS a tenant — it lives WITHIN one.**
  Originally, each named profile ("Acme Wireless," "TechTrade Refurb")
  was treated as if it were a separate business client. Under real
  multi-tenancy, a single tenant can have multiple profiles (different
  programs or locations under one company), and `CustomerProfile` now
  carries a `tenantId`.
- **`License` moved from `profileId` to `tenantId`** — billing happens
  once per tenant (the paying entity), not once per profile. This was a
  real bug in the original design, not just a rename.
- **Profile QR payload now encodes `{tenantId}:{pin}` together**, not
  just the PIN. This also fixes the earlier "PINs are globally unique"
  decision, which doesn't hold under multi-tenancy: two tenants can now
  both use PIN `4726` with zero conflict, since the QR always identifies
  which tenant's `4726` it is. PINs only need to be unique WITHIN a
  tenant — manual PIN entry (the fallback path) now needs a tenant
  picker step first, since typed digits alone are ambiguous across tenants.
- **`portalAuth.ts`** (new) — the backend portal previously had NO login
  of its own (every mockup just showed "J. Alvarez" as if permanently
  signed in). Three roles: `tenant_admin`, `tenant_staff` (both scoped
  to exactly one tenant, never settable), and `master_admin` (not scoped
  to any single tenant). `PortalSession.viewingTenantId` is what every
  tenant-scoped page's queries must filter by.
- **`portal_login.html`** (new) — routes by role: tenant users land in
  their own portal, master_admin lands in the Master Console.
- **`master_console.html`** (new) — cross-tenant view: all tenants,
  platform-wide stats (total devices, MRR, past-due accounts), tenant
  provisioning ("New Tenant"). Deliberately styled with a DIFFERENT dark
  theme from the tenant-facing portal — a superuser context should never
  be visually confusable with a normal tenant view, to reduce the risk
  of an admin losing track of which context they're acting in.
- **`enterTenantView()`/`exitTenantView()`** in `portalAuth.ts` — how a
  master_admin drops into one tenant's portal for support purposes. Must
  be an explicit, logged action — never silent, never automatic.

### Tenant indicator — now applied everywhere
The tenant-indicator badge is now on every tenant-scoped portal page:
Dashboard, Report Detail, Devices, Device History, Test Profiles,
Compliance, Disputes, Billing & Licenses, Team, and Settings. This is
still a VISUAL convention, not a real data guarantee — each page's
actual data-fetching logic still needs to filter by
`session.viewingTenantId` server-side. The badge tells a human which
tenant they're looking at; it doesn't stop the underlying query from
accidentally pulling another tenant's rows if that filter isn't wired
in. Treat the badge as the UI half of this problem and the query-level
scoping as the other, equally necessary half.

Still not addressed: the admin activity log (who changed a profile,
resolved a dispute, provisioned a license) — flagged twice now, still
open.

## Technician identity
`technicianAuth.ts` — a lightweight login SEPARATE from the customer
profile PIN in `customerProfile.ts`. These solve two different problems
and were deliberately kept apart rather than overloaded into one PIN:
- Customer profile PIN → selects WHICH tests run (config, entered per
  device/session)
- Technician login → establishes WHO is running the session (identity,
  entered once per shift)
Badge scan or short code, not full username/password — the tablet is
already facility-access-controlled, so this is about attribution (redo
history, dispute resolution notes, QA/accuracy metrics), not security.
New mobile screen: Step 1, before PIN entry, session-level not per-device.

## Previously open decisions — now resolved
Four decisions were flagged throughout this build as needing real input
rather than a guessed default. Resolved as follows:

1. **Redo → reportId**: a same-session correction keeps the SAME
   reportId, tracked as a revision (`ReportRevision` in `testSession.ts`,
   displayed as `DDA-0217-R1`, `-R2`, etc.) rather than becoming a new
   report. A device that returns weeks later for a genuinely separate
   inspection gets its own new reportId naturally (that's a new
   session) — this only applies to same-session redo-after-generation.
2. **PIN fallback**: unrecognized PIN BLOCKS the session — never
   silent-falls-back to a default profile. Recovery path is an explicit
   manual profile pick, not an implicit default.
3. **PIN uniqueness**: GLOBAL across the business, not per-location.
   Simpler, no location-detection-before-PIN-entry problem. Move to
   5-6 digit PINs as active profile count grows — 4 digits is only
   10,000 combinations.
4. **Technician login**: yes, added — see "Technician identity" above.

## Data retention policy
**RESOLVED: data is kept forever — no automatic expiry or purge.**
Applies to all captured data: IMEI/serial, cosmetic photos, dispute
records, technician attribution, redo history. No TTL, no archival-then-
delete job, no "delete after N years" logic anywhere in this system.

One real gap this leaves open, worth a decision before this handles real
consumer data at volume: if any customer is in a jurisdiction with a
legal right-to-deletion (GDPR in the EU, CCPA/CPRA in California, similar
laws elsewhere), "keep forever" as a default doesn't remove the
obligation to honor a specific deletion request when one comes in — it
just means there's no automatic process for it. That needs at minimum a
manual deletion path (an admin action that actually removes one
customer's records on request), even if nothing runs automatically.
Not built here — flagging so it doesn't get missed if/when this goes
live somewhere those laws apply.

## Licensing model
`licensing.ts` — license lives at the CustomerProfile (organization)
level, not per-technician, since the org is the paying customer. Four
plan types:
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
org isn't licensed to run in the first place. Same hard-gate pattern as
everything else in this app: expired/suspended/quota-exceeded blocks
outright, never silently degrades or lets the session continue.

Backend portal gets a new **Billing & Licenses** page: one row per
customer profile showing plan type, usage against quota, status, and
renewal date.

## Seat-to-technician linkage (fixed)
`licensing.ts`'s `consumeSeat()`/`releaseSeat()` are now called alongside
`technicianAuth.ts`'s `startShift()`/`endShift()` at the call site (not
inside either module, since not every license type needs seat tracking).
Previously these existed as two disconnected systems — a technician
could log in without ever consuming a seat, making "Seats Full" on the
Billing page meaningless.

## License provisioning & invoicing
`licensing.ts`'s `provisionLicense()` is what the Billing page's "New
License" form actually calls now — previously a dead button.
`invoicing.ts` generates invoice records (line items, overage
calculation for tiered plans) from license usage data.
**`invoicing.ts` does NOT charge anyone** — it produces what to bill;
actually collecting payment needs a real processor (Stripe Billing fits
this metered/subscription pattern well). See the file header for the
same caveat pattern used for device verification/pricing earlier.

## Team & Settings pages
- **Team** (`admin_portal_team.html`): technician roster, badge codes,
  shift status, seat assignment, and QA metrics (redo rate, dispute
  rate per technician) in one view — this is also where the previously-
  missing QA/accuracy dashboard lives, rather than as a separate page.
- **Settings** (`admin_portal_settings.html`): org config, the data
  retention policy stated explicitly (forever, manual deletion only),
  defaults (wipe standard, PIN length), and notification toggles shown
  honestly as "not yet configured" since no SMS/email provider is wired
  up yet.

## Batch intake UI
`mobile_batch_intake.html` — three screens (Start Batch, Scan Devices,
Batch Progress), a SEPARATE flow branching off right after Technician
Login rather than inserted into the main per-device journey — a batch
lot uses one profile for every device in it, not a PIN scan per device.

## Marketplace listings & warranty tracking
Both buildable now, pure data/logic, no new external dependency:
- `marketplaceListing.ts` — generates title/description/price from
  existing `AuditReport` + `TradeInQuote` data for a device routed to
  resale. Price is a placeholder markup formula — replace with real
  pricing strategy.
- `warrantyTracking.ts` — links a post-sale claim back to the original
  `reportId`. `claimRateByTechnician()` surfaces a pattern worth
  watching, same idea as the Devices tab's worsening-grade-trend flag.

## Notifications, shipping, and KYC/AML — all need a real external service
Three modules with the same shape: real logic for WHEN/WHAT, but
genuinely non-functional without a paid third-party provider. Don't
mistake the code existing for these being production-ready:
- `notifications.ts` — SMS/email templates per consumer-tracker stage
  transition; needs Twilio/SendGrid-or-similar to actually send anything
- `shippingLogistics.ts` — inbound label + tracking data model; needs
  EasyPost/Shippo-or-similar to generate a real, valid label
- `kycVerification.ts` — payout threshold gate logic; needs
  Persona/Jumio/Onfido-or-similar for actual identity verification.
  **The $600 threshold is illustrative, not legal advice** — get the
  real number and applicable jurisdictions from counsel before shipping.

## Admin activity log (RESOLVED — no longer pending)
`adminActivityLog.ts` — the central audit trail for every admin and
system action, flagged as a gap three times before this build and now
fully wired into every module that changes state:

### Integration map (which module → which action → which call site)
- `portalAuth.ts` → `portal_login` (on successful login),
  `entered_tenant_view` / `exited_tenant_view` (when master_admin
  switches context)
- `tenant.ts` → `tenant_created`, `tenant_suspended`,
  `tenant_activated` (on each state change, now requires `actorUserId`
  parameter)
- `licensing.ts` → `license_provisioned` (provisionLicense now requires
  `actorUserId` + `actorRole` params)
- `testSession.ts` → `report_revision_created` (new `createRevision()`
  function wraps the revision + audit log together)
- `dataWipe.ts` → `data_wipe_certified` (generateWipeCertificate now
  requires `tenantId`)
- `warrantyTracking.ts` → `warranty_claim_filed`
  (fileWarrantyClaim now requires `tenantId` + `actorUserId`)
- `marketPriceUpload.ts` → `pricing_uploaded` (new
  `logPricingUpload()` called after a successful parse)

### Not yet wired (call sites exist but no logActivity call yet)
- Dispute resolution (uphold/adjust grade) — the UI actions exist on
  `admin_portal_disputes.html` but aren't connected to backend logic
  at all yet (they're HTML mockup buttons, not wired functions)
- Settings changes — `admin_portal_settings.html` is a static mockup;
  when real settings persistence is built, each save should call
  `logActivity()` with `action: "settings_updated"`
- Profile creation/update — `customerProfile.ts` doesn't have
  create/update functions beyond `resolveProfileByPin()`; when CRUD
  endpoints are built, wire them to `profile_created`/`profile_updated`

### Portal page
`admin_portal_activity_log.html` — filterable by action type (Auth,
Profiles, Licenses, Disputes, Reports, Pricing, Settings), showing
actor, action badge, target, details, and timestamp. Tenant-scoped
(shows the tenant indicator badge). Added to every portal page's
sidebar navigation.

## Testing
- Unit tests: (fill in — e.g. Jest)
- iOS Simulator + Android Emulator for UI/navigation flows
- Physical device required for camera-based capture flow and any
  hardware diagnostics (BatteryManager, sensors, camera, mic, speaker,
  ports)
- Command Claude Code should run before considering a change done: (fill in)

## Notes for Claude Code
- Ask before adding new native dependencies — native modules are the
  highest-risk part of this app to get wrong
- Don't attempt IMEI/serial via TelephonyManager or UIDevice — see
  constraint above
- Treat IMEI/serial handling as sensitive — don't log full values in
  debug output or commit them to fixtures
- For any manual-confirmation test (speaker, camera visual check),
  never default to a pass — require explicit technician action
