// src/lib/testCatalog.ts
//
// Maps each testId to HOW it is run. TEST_CATALOG in
// packages/shared/src/customerProfile.ts defines the testIds, labels and
// report grouping; this adds the execution strategy, which is mobile-only
// and has no place in shared logic.
//
// Kept in sync with the shared catalog by hand (same Metro-bundler
// reason as lib/qrPayloads.ts). A profile's enabledTestIds are drawn
// from the shared catalog, so any testId here that isn't there — or
// vice versa — means a test that can be configured but never run, or
// run but never configured.

export type RunKind =
  /** Reads sensor output while the technician performs a movement, then
   *  checks for variance. */
  | "sensor"
  /** The app cannot self-verify; requires an explicit yes/no from the
   *  technician. Never auto-passes. */
  | "manual_confirm"
  /** A value the technician reads off the device and types in. */
  | "manual_entry"
  /** Fully automated — the app queries the OS and decides. */
  | "auto"
  /** Guided multi-angle photo capture with a technician-assigned grade
   *  (own screen — see CosmeticScanScreen). */
  | "cosmetic"
  /** Recognised, but not implementable without work called out in
   *  CLAUDE.md that hasn't happened yet. Surfaced honestly rather than
   *  silently passing or failing. */
  | "unavailable";

export interface CatalogEntry {
  testId: string;
  label: string;
  component: string;
  kind: RunKind;
  /** Shown to the technician when the test needs them to do something. */
  prompt?: string;
  /** For manual_confirm: what a "no" answer means in the report. */
  failureNote?: string;
  /** For manual_entry: where the value is found. */
  entryHint?: string;
  /** For unavailable: why, so the gap is legible rather than mysterious. */
  unavailableReason?: string;
}

export const RUN_CATALOG: CatalogEntry[] = [
  // --- Sensors -----------------------------------------------------
  {
    testId: "accelerometer",
    label: "Accelerometer",
    component: "Sensors",
    kind: "sensor",
    prompt: "Tilt and rotate the device slowly for a few seconds.",
  },
  {
    testId: "gyroscope",
    label: "Gyroscope",
    component: "Sensors",
    kind: "sensor",
    prompt: "Rotate the device around each axis.",
  },
  {
    testId: "magnetometer",
    label: "Magnetometer",
    component: "Sensors",
    kind: "sensor",
    prompt: "Turn the device in a slow circle, away from metal objects.",
  },

  // --- Automated ---------------------------------------------------
  { testId: "storage_capacity", label: "Storage Capacity", component: "Storage", kind: "auto" },
  { testId: "storage_readwrite", label: "Storage Read/Write", component: "Storage", kind: "auto" },
  {
    testId: "charging_port",
    label: "Charging Port",
    component: "Battery & Charging",
    kind: "auto",
    prompt: "Plug in a charging cable now.",
  },
  { testId: "headset_port", label: "Headset Port", component: "Ports & Connectors", kind: "auto" },
  { testId: "battery_charge_level", label: "Charge Level", component: "Battery & Charging", kind: "auto" },

  // --- Manual confirmation -----------------------------------------
  // CLAUDE.md: the app cannot verify its own audio output, so this is a
  // manual test BY DESIGN — and must never default to a pass.
  {
    testId: "loud_speaker",
    label: "Loudspeaker",
    component: "Audio — Speakers & Microphones",
    kind: "manual_confirm",
    prompt: "A tone will play through the loudspeaker. Did you hear it clearly?",
    failureNote: "Technician did not hear the test tone through the loudspeaker.",
  },
  {
    testId: "earpiece",
    label: "Earpiece",
    component: "Audio — Speakers & Microphones",
    kind: "manual_confirm",
    prompt: "Hold the device to your ear. Did you hear the tone through the earpiece?",
    failureNote: "Technician did not hear the test tone through the earpiece.",
  },
  {
    testId: "lcd",
    label: "Display (LCD)",
    component: "Display & Touchscreen",
    kind: "manual_confirm",
    prompt: "Check the screen for cracks, dead pixels, or discolouration. Does it look correct?",
    failureNote: "Technician reported a display fault.",
  },
  {
    testId: "digitizer",
    label: "Touch Digitizer",
    component: "Display & Touchscreen",
    kind: "manual_confirm",
    prompt: "Swipe across every area of the screen. Did touch respond everywhere?",
    failureNote: "Technician reported unresponsive areas on the touchscreen.",
  },
  // CLAUDE.md requires the camera's visual check to be a SEPARATE row
  // from any automated frame check: "a black-frame check alone won't
  // catch a foggy lens or sensor damage."
  {
    testId: "camera_back",
    label: "Back Camera (visual check)",
    component: "Camera System",
    kind: "manual_confirm",
    prompt: "Open the back camera preview. Is the image sharp, correctly exposed, and free of spots?",
    failureNote: "Technician reported a fault in the back camera image.",
  },
  {
    testId: "camera_front",
    label: "Front Camera (visual check)",
    component: "Camera System",
    kind: "manual_confirm",
    prompt: "Open the front camera preview. Is the image sharp, correctly exposed, and free of spots?",
    failureNote: "Technician reported a fault in the front camera image.",
  },
  {
    testId: "power_button",
    label: "Power Button",
    component: "Buttons & Physical Controls",
    kind: "manual_confirm",
    prompt: "Press the power button. Did it respond?",
    failureNote: "Power button did not respond.",
  },
  {
    testId: "volume_up",
    label: "Volume Up",
    component: "Buttons & Physical Controls",
    kind: "manual_confirm",
    prompt: "Press volume up. Did it respond?",
    failureNote: "Volume up button did not respond.",
  },
  {
    testId: "volume_down",
    label: "Volume Down",
    component: "Buttons & Physical Controls",
    kind: "manual_confirm",
    prompt: "Press volume down. Did it respond?",
    failureNote: "Volume down button did not respond.",
  },

  // --- Manual entry ------------------------------------------------
  // CLAUDE.md: iOS exposes no battery-health API at all, and this is an
  // Apple policy decision with no entitlement or MDM workaround. On
  // Android the value needs a native BatteryManager module, which has
  // not been written — react-native-device-info reports charge LEVEL,
  // which is a different quantity and must not be substituted. So this
  // is human-entered on both platforms for now.
  {
    testId: "battery_health",
    label: "Battery Health",
    component: "Battery & Charging",
    kind: "manual_entry",
    entryHint: "Settings › Battery › Battery Health & Charging › Maximum Capacity",
    prompt: "Enter the maximum capacity percentage shown on the device.",
  },
  {
    testId: "country_of_origin",
    label: "Country of Origin",
    component: "Housing & Cosmetics",
    kind: "manual_entry",
    entryHint: "Printed on the retail box or the regulatory label inside the SIM tray.",
    prompt: 'Enter the country shown after "Made in" or "Assembled in".',
  },
  {
    testId: "device_color",
    label: "Device Color",
    component: "Housing & Cosmetics",
    kind: "manual_entry",
    prompt: "Enter the device colour as observed.",
  },

  // --- Cosmetic grading --------------------------------------------
  // Six-angle guided capture plus a technician-assigned grade. The
  // hosted damage-detection model (COSMETIC_INFERENCE_ENDPOINT) does not
  // exist yet — Sprint 7 — so no grade is suggested; see
  // lib/cosmeticCapture.ts for why a suggestion would be misleading
  // rather than merely absent.
  {
    testId: "cosmetic_grading",
    label: "Cosmetic Grading",
    component: "Housing & Cosmetics",
    kind: "cosmetic",
    prompt: "Photograph all six angles, then assign a condition grade.",
  },

  // --- Not yet implementable ---------------------------------------
  {
    testId: "microphone",
    label: "Microphone",
    component: "Audio — Speakers & Microphones",
    kind: "unavailable",
    unavailableReason:
      "Needs audio capture to compare a silent baseline against a spoken sample. No audio-recording dependency is installed, and adding one requires sign-off per CLAUDE.md.",
  },

];

const BY_ID = new Map(RUN_CATALOG.map((entry) => [entry.testId, entry]));

export function getCatalogEntry(testId: string): CatalogEntry | undefined {
  return BY_ID.get(testId);
}

/**
 * Resolves a profile's configured testIds to runnable entries.
 * Deliberately reports unknown ids rather than dropping them: a profile
 * configured with a test this build cannot run should be visible to the
 * technician, not silently shortened into a report that looks complete.
 */
export function resolveEnabledTests(enabledTestIds: string[]): {
  runnable: CatalogEntry[];
  unknown: string[];
} {
  const runnable: CatalogEntry[] = [];
  const unknown: string[] = [];
  for (const testId of enabledTestIds) {
    const entry = BY_ID.get(testId);
    if (entry) runnable.push(entry);
    else unknown.push(testId);
  }
  return { runnable, unknown };
}
