// src/lib/testEvaluation.ts
//
// Status rules for each diagnostic test, kept as pure functions so they
// can be tested without hardware. These encode CLAUDE.md's per-test
// requirements, several of which exist specifically to stop a test
// reporting a pass it hasn't earned — getting one wrong produces an
// audit report that says a broken device is fine, which is the most
// damaging failure this app can have.

export type TestStatus = "pass" | "fail" | "warning" | "skipped";
export type TestSource = "api" | "manual" | "ocr";

export interface EvaluatedResult {
  status: TestStatus;
  value?: string | number;
  notes?: string;
  source: TestSource;
}

// ============================================================
// Sensors
// ============================================================

/**
 * CLAUDE.md: "a dead sensor often still reports as 'present' with a
 * stuck value, so presence alone isn't enough." Hence: no readings =
 * fail; readings but no variance during the technician's action =
 * warning; variance = pass.
 */
export function evaluateSensorReadings(
  readings: { x: number; y: number; z: number }[],
  varianceThreshold = 0.15,
): EvaluatedResult {
  if (readings.length === 0) {
    return { status: "fail", notes: "No readings received from sensor.", source: "api" };
  }

  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const maxSpread = Math.max(
    spread(readings.map((r) => r.x)),
    spread(readings.map((r) => r.y)),
    spread(readings.map((r) => r.z)),
  );

  if (maxSpread < varianceThreshold) {
    return {
      status: "warning",
      value: Number(maxSpread.toFixed(3)),
      notes: "Sensor responded but readings did not change during the movement — possible stuck value.",
      source: "api",
    };
  }

  return { status: "pass", value: Number(maxSpread.toFixed(3)), source: "api" };
}

/**
 * CLAUDE.md: "Not every device has every sensor (e.g. many tablets lack
 * proximity) — mark genuinely absent sensors 'skipped' with a note, not
 * 'fail'." A missing sensor is not a fault.
 */
export function evaluateAbsentSensor(sensorLabel: string): EvaluatedResult {
  return {
    status: "skipped",
    notes: `This device does not report a ${sensorLabel}.`,
    source: "api",
  };
}

// ============================================================
// Microphone
// ============================================================

/**
 * CLAUDE.md: "Do NOT use a fixed absolute noise-floor threshold —
 * ambient noise varies too much (loud room = false pass, quiet room =
 * false fail). Capture a baseline sample in silence first, then the
 * 'speak now' sample; compare amplitude delta between the two."
 */
export function evaluateMicrophone(baselineAmplitude: number, spokenAmplitude: number, minDelta = 0.08): EvaluatedResult {
  const delta = spokenAmplitude - baselineAmplitude;

  if (delta <= 0) {
    return {
      status: "fail",
      value: Number(delta.toFixed(3)),
      notes: "Speaking produced no increase in level over the silent baseline.",
      source: "api",
    };
  }
  if (delta < minDelta) {
    return {
      status: "warning",
      value: Number(delta.toFixed(3)),
      notes: "Level rose only slightly when speaking — microphone may be obstructed or weak.",
      source: "api",
    };
  }
  return { status: "pass", value: Number(delta.toFixed(3)), source: "api" };
}

// ============================================================
// Battery
// ============================================================

/** CLAUDE.md: "Threshold: below 80% = fail." Applies to both the Android
 *  programmatic read and the iOS human-entered value; only the source
 *  differs, and that difference is what the report surfaces. */
export function evaluateBatteryHealth(healthPercent: number, source: TestSource): EvaluatedResult {
  if (!Number.isFinite(healthPercent) || healthPercent <= 0 || healthPercent > 100) {
    return { status: "fail", notes: "Battery health reading was not a valid percentage.", source };
  }
  if (healthPercent < 80) {
    return { status: "fail", value: healthPercent, notes: "Below the 80% replacement threshold.", source };
  }
  return { status: "pass", value: healthPercent, source };
}

/**
 * CLAUDE.md: iOS battery health is human-entered or OCR'd, and must be
 * "labelled distinctly in the report ... NOT presented identically to
 * programmatically-read results, since provenance differs."
 */
export function batteryHealthLabel(source: TestSource): string {
  return source === "api" ? "Battery Health" : "Battery Health (self-reported from device Settings)";
}

// ============================================================
// Storage
// ============================================================

/** CLAUDE.md: capacity is "informational only, no fail condition on
 *  capacity alone." A nearly-full device is not a broken device. */
export function evaluateStorageCapacity(totalBytes: number, freeBytes: number): EvaluatedResult {
  const gb = (b: number) => Math.round(b / 1e9);
  return {
    status: "pass",
    value: `${gb(freeBytes)} GB free of ${gb(totalBytes)} GB`,
    notes: "Capacity is recorded for reference only and is not a pass/fail condition.",
    source: "api",
  };
}

/**
 * CLAUDE.md: the read/write check "Catches gross failures (full disk,
 * filesystem corruption) but NOT subtle flash degradation ... Don't let
 * the report imply more storage-health certainty than this test
 * provides." The note travels with the result so the report can't
 * overstate it.
 */
export function evaluateStorageReadWrite(wroteAndReadBack: boolean): EvaluatedResult {
  return wroteAndReadBack
    ? {
        status: "pass",
        notes: "Wrote and read back a test file successfully. This detects gross filesystem failure only, not gradual flash wear.",
        source: "api",
      }
    : {
        status: "fail",
        notes: "Could not write and read back a test file.",
        source: "api",
      };
}

// ============================================================
// Manual-confirmation tests
// ============================================================

/**
 * CLAUDE.md, speaker: "UI MUST require an explicit 'Yes, I heard it' /
 * 'No' choice — never default technicianConfirmed to true, never treat a
 * timeout or click-through as a pass."
 *
 * The signature takes `boolean | null` rather than `boolean` on purpose:
 * null means "not answered yet", and it CANNOT collapse into a pass. A
 * plain boolean defaulting to false would be safe here, but would make
 * "unanswered" and "explicitly said no" indistinguishable in the report.
 */
export function evaluateManualConfirmation(
  confirmed: boolean | null,
  failureNote: string,
): EvaluatedResult {
  if (confirmed === null) {
    return {
      status: "skipped",
      notes: "Technician did not answer — recorded as unanswered, not as a pass.",
      source: "manual",
    };
  }
  return confirmed
    ? { status: "pass", source: "manual" }
    : { status: "fail", notes: failureNote, source: "manual" };
}

// ============================================================
// Ports
// ============================================================

/**
 * CLAUDE.md: "On timeout: mark 'skipped', NOT 'fail' — no cable
 * available during testing isn't evidence of a hardware fault, and a
 * fail here would misrepresent the audit."
 */
export function evaluateChargingPort(detectedCharging: boolean): EvaluatedResult {
  return detectedCharging
    ? { status: "pass", notes: "Charging state detected after cable was connected.", source: "api" }
    : {
        status: "skipped",
        notes: "No charging state detected within the time limit. Not recorded as a fault — a cable may not have been available.",
        source: "api",
      };
}

/**
 * CLAUDE.md: "Auto-detect whether the device has one ... only include
 * this row in the report when the device actually has the port; don't
 * show 'skipped' for devices that never had one." Returning null means
 * omit the row entirely, which is different from skipping it.
 */
export function evaluateHeadphoneJack(devicePresent: boolean, detected: boolean): EvaluatedResult | null {
  if (!devicePresent) return null;
  return detected
    ? { status: "pass", source: "api" }
    : { status: "fail", notes: "Headphone jack present but no connection detected.", source: "api" };
}

// ============================================================
// Camera
// ============================================================

/**
 * CLAUDE.md requires camera to be TWO rows: an automated frame check
 * (source "api") and a separate technician visual confirmation (source
 * "manual"), because "a black-frame check alone won't catch a foggy lens
 * or sensor damage." This returns only the automated half; the visual
 * confirmation goes through evaluateManualConfirmation.
 *
 * The luminance threshold is deliberately a caller-supplied parameter:
 * CLAUDE.md says to "calibrate against known-good devices, don't guess a
 * number", and no such calibration has been done, so no default is
 * baked in here to be mistaken for a validated value.
 */
export function evaluateCameraFrame(meanLuminance: number | null, blackThreshold: number): EvaluatedResult {
  if (meanLuminance === null) {
    return { status: "fail", notes: "No frame was captured from the camera.", source: "api" };
  }
  if (meanLuminance <= blackThreshold) {
    return {
      status: "fail",
      value: Number(meanLuminance.toFixed(1)),
      notes: "Captured frame was effectively black.",
      source: "api",
    };
  }
  return { status: "pass", value: Number(meanLuminance.toFixed(1)), source: "api" };
}
