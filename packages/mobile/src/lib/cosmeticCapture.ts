// src/lib/cosmeticCapture.ts
//
// Thin layer over packages/shared's cosmeticInspection for the capture
// flow. Sprint 5 scope per the roadmap is "6-angle guided photo capture
// + manual grade entry (CV inference deferred to S7)", so the photos are
// taken and the technician assigns the grade; no model runs yet.
//
// THE TRAP THIS FILE EXISTS TO AVOID: computeSuggestedGrade() derives a
// grade from detected damage, so with an empty detections array — which
// is exactly what "no model ran" produces — it returns "A", the best
// possible grade. Surfacing that as a suggestion on an uninspected
// device would anchor a technician toward "flawless" on a phone that may
// be visibly cracked, and CLAUDE.md is explicit that cosmetic grade
// drives resale value. A suggestion is only meaningful when a model
// actually looked at the photos.

import {
  CAPTURE_ANGLES,
  computeSuggestedGrade,
  finalizeCosmeticGrading,
} from '@diagnostics/shared';
import type {
  CaptureAngle,
  CosmeticGrade,
  CosmeticGradingResult,
  CosmeticInspectionResult,
} from '@diagnostics/shared';

export { CAPTURE_ANGLES };
export type { CaptureAngle, CosmeticGrade, CosmeticInspectionResult };

export const GRADES: CosmeticGrade[] = ['A', 'B', 'C', 'D'];

export const GRADE_DESCRIPTIONS: Record<CosmeticGrade, string> = {
  A: 'Like new — no visible marks',
  B: 'Light wear — minor scratches only',
  C: 'Moderate wear — visible scratches or dents',
  D: 'Heavy damage — cracks, or severe damage',
};

/**
 * Whether damage detection can run at all. The endpoint is the hosted
 * model from CLAUDE.md's "Cosmetic grading (AI-assisted)" section, which
 * does not exist yet — training it is Sprint 7 work.
 */
export function isDamageDetectionAvailable(): boolean {
  return Boolean(process.env.COSMETIC_INFERENCE_ENDPOINT);
}

/**
 * Returns a suggested grade ONLY when a model actually analysed the
 * photos. Returns null otherwise, so the UI shows no suggestion rather
 * than a falsely optimistic one. See the file header.
 */
export function suggestedGradeOrNull(
  perAngle: CosmeticInspectionResult[],
  detectionRan: boolean,
): CosmeticGrade | null {
  if (!detectionRan) return null;
  return computeSuggestedGrade(perAngle);
}

export interface CapturedAngle {
  angle: CaptureAngle;
  imageUri: string;
}

/** Angles still outstanding, in the order CLAUDE.md defines them. */
export function remainingAngles(captured: CapturedAngle[]): CaptureAngle[] {
  const done = new Set(captured.map((c) => c.angle));
  return CAPTURE_ANGLES.map((a) => a.angle).filter((angle) => !done.has(angle));
}

export function isCaptureComplete(captured: CapturedAngle[]): boolean {
  return remainingAngles(captured).length === 0;
}

/**
 * Builds the recorded grading result. technicianGrade is always what
 * gets locked in — CLAUDE.md: "Never auto-finalize a grade from model
 * output alone." With no model, technicianOverrode is meaningless, so
 * finalize is only delegated to shared when a suggestion existed.
 */
export function buildGradingResult(
  captured: CapturedAngle[],
  technicianGrade: CosmeticGrade,
  detectionRan: boolean,
): CosmeticGradingResult {
  const perAngle: CosmeticInspectionResult[] = captured.map((c) => ({
    angle: c.angle,
    imageUri: c.imageUri,
    detections: [],
  }));

  if (detectionRan) return finalizeCosmeticGrading(perAngle, technicianGrade);

  return {
    perAngle,
    // Mirrors the technician's own grade rather than claiming a computed
    // suggestion that never happened.
    suggestedGrade: technicianGrade,
    technicianGrade,
    technicianOverrode: false,
    timestamp: new Date().toISOString(),
  };
}

/** Note recorded alongside the grade, so the report states how the grade
 *  was reached rather than implying AI assistance that didn't occur. */
export function gradingProvenanceNote(captured: CapturedAngle[], detectionRan: boolean): string {
  const photoNote = `${captured.length} of ${CAPTURE_ANGLES.length} angles photographed.`;
  return detectionRan
    ? `${photoNote} Grade confirmed by technician after reviewing detected damage.`
    : `${photoNote} Graded visually by the technician; automated damage detection was not available.`;
}
