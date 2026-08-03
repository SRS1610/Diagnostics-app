/**
 * @format
 *
 * These assertions are the CLAUDE.md per-test rules written down. Most
 * exist to stop a test reporting a pass it hasn't earned — an audit
 * report that calls a broken device fine is the worst output this app
 * can produce.
 */

import {
  batteryHealthLabel,
  evaluateAbsentSensor,
  evaluateBatteryHealth,
  evaluateCameraFrame,
  evaluateChargingPort,
  evaluateHeadphoneJack,
  evaluateManualConfirmation,
  evaluateMicrophone,
  evaluateSensorReadings,
  evaluateStorageCapacity,
  evaluateStorageReadWrite,
} from '../src/lib/testEvaluation';

describe('sensors', () => {
  it('fails when no readings arrive at all', () => {
    expect(evaluateSensorReadings([]).status).toBe('fail');
  });

  // The rule that matters: a dead sensor often still reports "present"
  // with a frozen value, so presence alone must not pass.
  it('warns rather than passes when readings never change', () => {
    const stuck = Array.from({ length: 10 }, () => ({ x: 1, y: 1, z: 9.8 }));
    const result = evaluateSensorReadings(stuck);
    expect(result.status).toBe('warning');
    expect(result.notes).toMatch(/stuck/i);
  });

  it('passes when readings vary during the movement', () => {
    const moving = [
      { x: 0, y: 0, z: 9.8 },
      { x: 2.5, y: -1.2, z: 8.1 },
      { x: -3.1, y: 4.4, z: 2.2 },
    ];
    expect(evaluateSensorReadings(moving).status).toBe('pass');
  });

  it('skips a sensor the device does not have, rather than failing it', () => {
    const result = evaluateAbsentSensor('proximity sensor');
    expect(result.status).toBe('skipped');
    expect(result.status).not.toBe('fail');
  });
});

describe('microphone', () => {
  // Absolute thresholds produce false passes in loud rooms and false
  // fails in quiet ones, so the comparison is baseline-relative.
  it('fails when speaking produces no rise over the baseline', () => {
    expect(evaluateMicrophone(0.4, 0.4).status).toBe('fail');
    expect(evaluateMicrophone(0.4, 0.2).status).toBe('fail');
  });

  it('warns on a marginal rise', () => {
    expect(evaluateMicrophone(0.1, 0.13).status).toBe('warning');
  });

  it('passes on a clear rise', () => {
    expect(evaluateMicrophone(0.1, 0.6).status).toBe('pass');
  });

  it('judges by delta, not absolute level — a loud room still passes', () => {
    // Both samples are loud; only the delta should matter.
    expect(evaluateMicrophone(0.7, 0.95).status).toBe('pass');
  });

  it('judges by delta, not absolute level — a quiet room still fails', () => {
    expect(evaluateMicrophone(0.02, 0.02).status).toBe('fail');
  });
});

describe('battery health', () => {
  it('fails below the 80% threshold', () => {
    expect(evaluateBatteryHealth(79, 'api').status).toBe('fail');
  });

  it('passes at exactly 80%', () => {
    expect(evaluateBatteryHealth(80, 'api').status).toBe('pass');
  });

  it('rejects nonsense percentages', () => {
    for (const bad of [0, -5, 101, NaN]) {
      expect(evaluateBatteryHealth(bad, 'api').status).toBe('fail');
    }
  });

  it('applies the same threshold regardless of how the value was captured', () => {
    expect(evaluateBatteryHealth(75, 'manual').status).toBe('fail');
    expect(evaluateBatteryHealth(90, 'manual').status).toBe('pass');
  });

  // Provenance differs between platforms, and the report must not
  // present a human-entered value as if it were machine-read.
  it('labels a self-reported value distinctly', () => {
    expect(batteryHealthLabel('api')).toBe('Battery Health');
    expect(batteryHealthLabel('manual')).toMatch(/self-reported/i);
    expect(batteryHealthLabel('ocr')).toMatch(/self-reported/i);
  });
});

describe('storage', () => {
  it('records capacity without ever failing on it', () => {
    const nearlyFull = evaluateStorageCapacity(128e9, 0.5e9);
    expect(nearlyFull.status).toBe('pass');
    expect(nearlyFull.value).toMatch(/GB/);
  });

  it('carries a note limiting what the read/write check proves', () => {
    const result = evaluateStorageReadWrite(true);
    expect(result.status).toBe('pass');
    expect(result.notes).toMatch(/flash wear|gross/i);
  });

  it('fails when the file cannot be written and read back', () => {
    expect(evaluateStorageReadWrite(false).status).toBe('fail');
  });
});

describe('manual confirmation (speaker, camera visual)', () => {
  // The single most important rule in this file: an unanswered manual
  // test must never become a pass.
  it('never treats an unanswered prompt as a pass', () => {
    const result = evaluateManualConfirmation(null, 'No tone heard.');
    expect(result.status).not.toBe('pass');
    expect(result.status).toBe('skipped');
  });

  it('distinguishes unanswered from an explicit no', () => {
    const unanswered = evaluateManualConfirmation(null, 'No tone heard.');
    const saidNo = evaluateManualConfirmation(false, 'No tone heard.');
    expect(unanswered.status).toBe('skipped');
    expect(saidNo.status).toBe('fail');
  });

  it('passes only on an explicit yes', () => {
    expect(evaluateManualConfirmation(true, 'No tone heard.').status).toBe('pass');
  });

  it('records manual provenance', () => {
    expect(evaluateManualConfirmation(true, 'x').source).toBe('manual');
  });
});

describe('ports', () => {
  // A missing cable is not evidence of a hardware fault.
  it('skips rather than fails the charging port on timeout', () => {
    const result = evaluateChargingPort(false);
    expect(result.status).toBe('skipped');
    expect(result.status).not.toBe('fail');
  });

  it('passes the charging port when a state change is seen', () => {
    expect(evaluateChargingPort(true).status).toBe('pass');
  });

  // Omitting the row differs from skipping it: modern phones mostly have
  // no jack, and a "skipped" row implies a test that could have run.
  it('omits the headphone jack row entirely when the device has no jack', () => {
    expect(evaluateHeadphoneJack(false, false)).toBeNull();
  });

  it('reports the jack when the device has one', () => {
    expect(evaluateHeadphoneJack(true, true)?.status).toBe('pass');
    expect(evaluateHeadphoneJack(true, false)?.status).toBe('fail');
  });
});

describe('camera frame check', () => {
  it('fails when no frame was captured', () => {
    expect(evaluateCameraFrame(null, 5).status).toBe('fail');
  });

  it('fails an effectively black frame', () => {
    expect(evaluateCameraFrame(2, 5).status).toBe('fail');
  });

  it('passes a normally lit frame', () => {
    expect(evaluateCameraFrame(120, 5).status).toBe('pass');
  });

  it('reports api provenance, since the visual check is a separate row', () => {
    expect(evaluateCameraFrame(120, 5).source).toBe('api');
  });
});
