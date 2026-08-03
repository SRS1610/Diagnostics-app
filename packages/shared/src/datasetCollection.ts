// datasetCollection.ts
//
// Persists model prediction + technician-corrected label together for
// every cosmetic inspection, so real inspection volume becomes a growing
// training set over time. See cosmetic_grading_dataset_plan.md for the
// full strategy this supports.

import { CaptureAngle, DamageDetection, CosmeticInspectionResult } from "./cosmeticInspection";

export interface LabeledTrainingExample {
  imageId: string;
  reportId: string;
  angle: CaptureAngle;
  imageUri: string;
  capturedAt: string;
  modelPrediction: {
    detections: DamageDetection[];
  };
  technicianLabel: {
    detections: DamageDetection[]; // technician's corrected/confirmed detections
    confirmedByTechnicianId: string;
    wasModelCorrect: boolean; // true if technician made no changes
  };
}

/**
 * Call this right after a technician confirms or overrides a cosmetic
 * inspection result — NOT just when they override. A confirmed-correct
 * prediction is still a valid, valuable training example (it tells the
 * model "you were right here"), so don't only log the corrections.
 */
export function buildTrainingExample(params: {
  reportId: string;
  inspection: CosmeticInspectionResult;
  technicianDetections: DamageDetection[];
  technicianId: string;
}): LabeledTrainingExample {
  const wasModelCorrect =
    JSON.stringify(params.inspection.detections) === JSON.stringify(params.technicianDetections);

  return {
    imageId: `${params.reportId}-${params.inspection.angle}`,
    reportId: params.reportId,
    angle: params.inspection.angle,
    imageUri: params.inspection.imageUri,
    capturedAt: new Date().toISOString(),
    modelPrediction: { detections: params.inspection.detections },
    technicianLabel: {
      detections: params.technicianDetections,
      confirmedByTechnicianId: params.technicianId,
      wasModelCorrect,
    },
  };
}

/**
 * Rough coverage check against the collection targets in the dataset
 * plan (200-300 examples per damage type per angle). Use this to see
 * which angle/damage-type combinations still need more real examples
 * before a retraining pass is worthwhile.
 */
export function computeCoverageGaps(
  examples: LabeledTrainingExample[],
  targetPerCell: number = 200
): { angle: CaptureAngle; damageType: string; count: number; needsMore: boolean }[] {
  const counts = new Map<string, number>();
  for (const ex of examples) {
    for (const d of ex.technicianLabel.detections) {
      const key = `${ex.angle}|${d.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries()).map(([key, count]) => {
    const [angle, damageType] = key.split("|");
    return { angle: angle as CaptureAngle, damageType, count, needsMore: count < targetPerCell };
  });
}
