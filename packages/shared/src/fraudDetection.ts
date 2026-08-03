// fraudDetection.ts
//
// Extends the cosmetic CV pipeline and device-identity capture to flag
// two common trade-in fraud patterns. See CLAUDE.md "Fraud & authenticity
// checks" — both of these are detection/flagging aids for a technician
// to review, not automatic rejections.
//
// ============================================================================
// IMPORTANT — checkComponentAuthenticity() HAS NO PUBLIC TRAINING DATA
// ============================================================================
// Unlike cosmetic damage detection (cracks/scratches/dents), there is no
// public dataset of "genuine vs. aftermarket phone screen/battery" images
// — this was searched for specifically and nothing usable turned up.
// It's a narrower, more specialized problem than general damage detection,
// and not one the open CV-dataset community has published training data
// for at any real scale.
//
// Realistic paths to get this working, roughly in order of practicality:
//   1. Build your own labeled set from repair inventory — if your
//      operation (or a repair partner) stocks both genuine and known-
//      aftermarket parts, photograph them under controlled conditions.
//      This is real, original data — the only kind that will actually
//      work here, and nobody else can hand it to you.
//   2. iFixit teardown photos and repair-part supplier catalogs (iFixit,
//      Mobile Sentrix, Injured Gadgets, etc.) can serve as REFERENCE
//      images for a technician doing visual comparison — but scraping
//      these at scale for a training set raises real copyright/ToS
//      concerns, and they're not annotated for genuine-vs-aftermarket
//      classification anyway.
//   3. Until you have real training data, ship this as a manual
//      technician checklist (color temperature match, bezel gap,
//      screw-head wear indicating prior disassembly) rather than a CV
//      model — a documented human process beats a model trained on
//      nothing.
// ============================================================================

export type ComponentType = "screen" | "battery" | "back_housing";

export interface ComponentAuthenticityCheck {
  component: ComponentType;
  genuineDetected: boolean;
  confidence: number; // 0-1
  notes?: string;
}

/**
 * Non-genuine replacement parts (especially screens and batteries) are
 * a common pre-trade-in fraud pattern: a device gets a cheap aftermarket
 * screen swapped in to pass a visual check, but the part fails or
 * degrades quickly post-sale. Detection piggybacks on the same
 * hosted CV model used for cosmetic grading — genuine vs. aftermarket
 * parts often have detectable visual differences (panel color
 * temperature, bezel gap, adhesive residue) that a properly trained
 * model can flag, though this needs its own labeled training examples
 * distinct from the damage-detection dataset.
 */
export async function checkComponentAuthenticity(
  imageUri: string,
  component: ComponentType
): Promise<ComponentAuthenticityCheck> {
  const response = await fetch(`${process.env.AUTHENTICITY_CHECK_ENDPOINT}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUri, component }),
  });
  return response.json() as Promise<ComponentAuthenticityCheck>;
}

/**
 * Compares the barcode/OCR-scanned serial against what the device's own
 * software reports (available via standard device-info APIs on both
 * platforms — this part IS queryable, unlike IMEI). A mismatch usually
 * means a swapped logic board or a mislabeled unit — either way, worth
 * a technician's attention before the device proceeds.
 */
export function detectSerialMismatch(
  scannedSerial: string,
  softwareReportedSerial: string
): boolean {
  return scannedSerial.trim().toUpperCase() !== softwareReportedSerial.trim().toUpperCase();
}
