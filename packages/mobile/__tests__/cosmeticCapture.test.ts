/**
 * @format
 */

import { computeSuggestedGrade } from '@diagnostics/shared';
import {
  CAPTURE_ANGLES,
  GRADES,
  buildGradingResult,
  gradingProvenanceNote,
  isCaptureComplete,
  remainingAngles,
  suggestedGradeOrNull,
  type CapturedAngle,
} from '../src/lib/cosmeticCapture';

const captured = (...angles: string[]): CapturedAngle[] =>
  angles.map((angle) => ({ angle: angle as CapturedAngle['angle'], imageUri: `file://${angle}.jpg` }));

describe('suggested grade safety', () => {
  // The reason this module exists. computeSuggestedGrade derives a grade
  // from detected damage, so an empty detections array — precisely what
  // "no model ran" yields — scores as flawless.
  it('confirms the underlying shared function grades no-detections as A', () => {
    expect(computeSuggestedGrade([])).toBe('A');
  });

  // ...so a suggestion must not be offered when nothing analysed the
  // photos, or a cracked phone gets anchored to the best grade.
  it('returns null instead of a falsely perfect grade when no model ran', () => {
    const perAngle = captured('front', 'back').map((c) => ({ ...c, detections: [] }));
    expect(suggestedGradeOrNull(perAngle, false)).toBeNull();
  });

  it('returns a real suggestion once detection has run', () => {
    const perAngle = [
      {
        angle: 'front' as const,
        imageUri: 'file://front.jpg',
        detections: [
          {
            type: 'crack' as const,
            severity: 'severe' as const,
            confidence: 0.9,
            boundingBox: { x: 0, y: 0, width: 1, height: 1 },
            angle: 'front' as const,
          },
        ],
      },
    ];
    // A screen crack is an automatic D per the shared grading rules.
    expect(suggestedGradeOrNull(perAngle, true)).toBe('D');
  });
});

describe('guided capture progress', () => {
  it('defines the six angles from CLAUDE.md', () => {
    expect(CAPTURE_ANGLES.map((a) => a.angle)).toEqual(['front', 'back', 'top', 'bottom', 'left', 'right']);
  });

  it('lists outstanding angles in the defined order', () => {
    expect(remainingAngles(captured('front', 'top'))).toEqual(['back', 'bottom', 'left', 'right']);
  });

  it('is incomplete until every angle is captured', () => {
    expect(isCaptureComplete(captured('front', 'back', 'top', 'bottom', 'left'))).toBe(false);
    expect(isCaptureComplete(captured('front', 'back', 'top', 'bottom', 'left', 'right'))).toBe(true);
  });

  it('treats an empty capture as incomplete', () => {
    expect(isCaptureComplete([])).toBe(false);
  });
});

describe('buildGradingResult', () => {
  const all = captured('front', 'back', 'top', 'bottom', 'left', 'right');

  // CLAUDE.md: "Never auto-finalize a grade from model output alone."
  it('locks in the technician grade', () => {
    for (const grade of GRADES) {
      expect(buildGradingResult(all, grade, false).technicianGrade).toBe(grade);
    }
  });

  // Claiming an override against a suggestion that was never computed
  // would put a fiction into the audit record.
  it('does not claim an override when no model ran', () => {
    const result = buildGradingResult(all, 'D', false);
    expect(result.technicianOverrode).toBe(false);
    expect(result.suggestedGrade).toBe('D');
  });

  it('keeps one entry per captured angle', () => {
    expect(buildGradingResult(all, 'B', false).perAngle).toHaveLength(6);
  });

  it('records a partial capture honestly rather than padding it', () => {
    expect(buildGradingResult(captured('front', 'back'), 'B', false).perAngle).toHaveLength(2);
  });
});

describe('provenance note', () => {
  // The report must not imply AI assistance that did not happen.
  it('states the grade was visual when detection was unavailable', () => {
    const note = gradingProvenanceNote(captured('front', 'back'), false);
    expect(note).toMatch(/2 of 6/);
    expect(note).toMatch(/not available/i);
    expect(note).not.toMatch(/detected damage/i);
  });

  it('states damage was reviewed when detection did run', () => {
    expect(gradingProvenanceNote(captured('front'), true)).toMatch(/detected damage/i);
  });
});
