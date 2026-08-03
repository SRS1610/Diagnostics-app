# Cosmetic Grading Training Dataset

Two parts: real public datasets you can start from today, and a collection
framework for the original data you'll need to actually reach production
accuracy (public datasets alone won't get you there for this use case).

## Part 1 — Public starting datasets (verified to exist, as of Aug 2026)

These are real, currently-live datasets found via search — check each
one's current license before commercial use, since terms can change.

| Dataset | Source | Size | Classes | License notes |
|---|---|---|---|---|
| Mobile Damage Diagnosis | Roboflow Universe (`abhinavpoc/mobile-damage-diagnosis`) | 1,901 images | crack, scratch, dent, dead-pixel | Check current Roboflow Universe license on the project page — varies by uploader |
| Mobile Phone Dataset | Roboflow Universe (`yolo-dk013/mobile-phone-dataset-bb7zb`) | 100 images | good, cracked-screen, damaged | Check license |
| Mobile Phone Dataset (DataCluster Labs) | Roboflow Universe (`datacluster-labs-agryi/mobile-phone-dataset`) | 100 images (sample) | cracked-screen | **Commercial license required** — sample is free, full/larger set needs a paid license from Data Cluster Labs (contact via datacluster.ai) |
| Cracked Mobile Screen Dataset | Kaggle (`dataclusterlabs/cracked-screen-dataset`) | — | cracked screens | Same provider as above — check license |
| phone defect detection | Roboflow Universe (`college-rttvy/phone-defect-detection`) | 210 images | general phone defects | Check license |

**Reality check on these:** combined, this is roughly 2,000–2,300 images
across a handful of small/hobbyist datasets — enough to bootstrap a
proof-of-concept model and validate your pipeline (capture → inference →
technician review), but almost certainly NOT enough to hit production-
grade accuracy across all six of your capture angles (front/back/4 edges)
and damage types (crack/scratch/dent/chip/discoloration). Treat this as
a starting point for pipeline validation, not a finish line.

## Part 2 — Your own data collection (this is what actually gets you to production)

The realistic path, and the one already noted in CLAUDE.md: **every real
inspection your technicians run is a labeled training example**, once you
capture it correctly.

### What to capture per inspection (extends `CosmeticInspectionResult`)
- The 6 raw angle photos (already captured in your existing flow)
- The model's suggested detections (bounding box, type, severity, confidence)
- The technician's CONFIRMED or CORRECTED result — this is your ground truth label
- Whether the technician overrode the model (`technicianOverrode` — already
  in `cosmeticInspection.ts`), since overrides are your highest-value
  training examples: they're exactly the cases the current model gets wrong

### Minimum viable labeling schema (per image)
```json
{
  "imageId": "uuid",
  "reportId": "DDA-0217",
  "angle": "back",
  "capturedAt": "2026-08-02T14:12:00Z",
  "modelPrediction": {
    "detections": [
      { "type": "scratch", "severity": "minor", "confidence": 0.81,
        "boundingBox": { "x": 0.42, "y": 0.31, "width": 0.08, "height": 0.04 } }
    ]
  },
  "technicianLabel": {
    "detections": [
      { "type": "scratch", "severity": "minor",
        "boundingBox": { "x": 0.40, "y": 0.30, "width": 0.09, "height": 0.05 } }
    ],
    "confirmedByTechnicianId": "tech_jalvarez",
    "wasModelCorrect": true
  }
}
```

### Collection targets (rough starting guidance, not a hard rule)
- Aim for **at least 200-300 labeled examples per damage type per angle**
  before expecting reliable per-class accuracy — six angles x five damage
  types is 30 cells in that matrix, which is why this takes real inspection
  volume over time, not a one-time data-gathering sprint
- Prioritize collecting "clean" (no damage) examples too, in roughly equal
  volume to damaged ones — a model only ever shown damaged devices will
  over-flag healthy ones
- Deliberately vary lighting/background during real inspections if your
  warehouse setup allows it (different bays, times of day) — a model
  trained on one lighting condition won't generalize

### Practical pipeline
1. Ship the app now with the hosted-inference approach already in
   `cosmeticInspection.ts`, using a public dataset (Part 1) as the initial
   model
2. Log every inspection's photos + model prediction + technician
   correction using the schema above (this requires almost no new code —
   you already capture all of these fields, just need to persist them
   together rather than discard the model's raw prediction after the
   technician confirms/overrides)
3. Once you have a few thousand real, technician-corrected examples,
   retrain/fine-tune on your own data — this will outperform any public
   dataset for your specific use case, since it's labeled by the exact
   people making the real grading decisions on the exact devices you
   process
4. Repeat retraining periodically as volume grows — this is an ongoing
   process, not a one-time dataset delivery
