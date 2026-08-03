// cosmeticInspection.ts
//
// AI-assisted cosmetic grading: guided multi-angle photo capture, damage
// detection via a hosted computer vision model, and grade computation.
// See CLAUDE.md "Cosmetic grading (AI-assisted)" for architecture notes
// and the build-vs-buy tradeoffs this depends on.

export type DamageType = "crack" | "scratch" | "dent" | "chip" | "discoloration";
export type Severity = "minor" | "moderate" | "severe";
export type CaptureAngle = "front" | "back" | "top" | "bottom" | "left" | "right";
export type CosmeticGrade = "A" | "B" | "C" | "D";

export interface DamageDetection {
  type: DamageType;
  severity: Severity;
  confidence: number; // 0-1, model's confidence
  boundingBox: { x: number; y: number; width: number; height: number }; // normalized 0-1
  angle: CaptureAngle;
}

export interface CosmeticInspectionResult {
  angle: CaptureAngle;
  imageUri: string;
  detections: DamageDetection[];
  annotatedImageUri?: string; // image with bounding boxes drawn, for technician review
}

export interface CosmeticGradingResult {
  perAngle: CosmeticInspectionResult[];
  suggestedGrade: CosmeticGrade;
  technicianGrade: CosmeticGrade; // what actually gets locked into the report
  technicianOverrode: boolean;
  timestamp: string;
}

export const CAPTURE_ANGLES: { angle: CaptureAngle; instruction: string }[] = [
  { angle: "front", instruction: "Lay the phone screen-up, fill the frame" },
  { angle: "back", instruction: "Flip it over — back panel, fill the frame" },
  { angle: "top", instruction: "Top edge, close-up" },
  { angle: "bottom", instruction: "Bottom edge, close-up" },
  { angle: "left", instruction: "Left side edge" },
  { angle: "right", instruction: "Right side edge" },
];

/**
 * Sends a captured photo to the hosted damage-detection model and returns
 * raw detections. This calls OUT to a hosted inference endpoint (e.g. a
 * Roboflow-hosted model or your own trained model behind an API) — there
 * is no general-purpose on-device model for this (unlike barcode/OCR,
 * which use ML Kit locally). Requires network connectivity.
 */
async function runDamageDetectionModel(
  imageUri: string,
  angle: CaptureAngle
): Promise<DamageDetection[]> {
  // Replace with your actual inference endpoint call.
  const response = await fetch(process.env.COSMETIC_INFERENCE_ENDPOINT!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUri, angle }),
  });
  const data = (await response.json()) as { detections: DamageDetection[] };
  return data.detections;
}

export async function captureAndInspect(
  angle: CaptureAngle,
  imageUri: string
): Promise<CosmeticInspectionResult> {
  const detections = await runDamageDetectionModel(imageUri, angle);
  return { angle, imageUri, detections };
}

/**
 * Computes a suggested grade from all six angles' detections. This is a
 * STARTING POINT for the technician, never the final value — see
 * CosmeticGradingResult.technicianGrade, which is what actually gets
 * locked into the audit report.
 */
export function computeSuggestedGrade(results: CosmeticInspectionResult[]): CosmeticGrade {
  const all = results.flatMap((r) =>
    r.detections.map((d) => ({ ...d, angle: r.angle }))
  );

  const hasSevere = all.some((d) => d.severity === "severe");
  const hasScreenCrack = all.some((d) => d.type === "crack" && d.angle === "front");
  const moderateCount = all.filter((d) => d.severity === "moderate").length;
  const hasMinor = all.some((d) => d.severity === "minor");

  // Screen cracks and any severe damage are treated as an automatic D —
  // these affect both usability and resale value most heavily.
  if (hasScreenCrack || hasSevere) return "D";
  if (moderateCount >= 2) return "C";
  if (moderateCount === 1 || hasMinor) return "B";
  return "A";
}

export function finalizeCosmeticGrading(
  perAngle: CosmeticInspectionResult[],
  technicianGrade: CosmeticGrade
): CosmeticGradingResult {
  const suggestedGrade = computeSuggestedGrade(perAngle);
  return {
    perAngle,
    suggestedGrade,
    technicianGrade,
    technicianOverrode: technicianGrade !== suggestedGrade,
    timestamp: new Date().toISOString(),
  };
}
