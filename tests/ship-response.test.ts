import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHIP_RESPONSE_BASELINE_CONFIG,
  SHIP_RESPONSE_BASELINE_SEAS,
  SHIP_RESPONSE_ENCOUNTER_CONFIG,
  SHIP_RESPONSE_FORMAT_VERSION,
  SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES,
  measureShipFreeDecay,
  presentationHeadingToModelYawRadians,
  responseHeadings,
  runShipResponseCase,
} from '../src/vessel/schooner/SchoonerResponse';
import type { ShipResponseMatrix } from '../src/vessel/schooner/SchoonerResponse';
import {
  ENCOUNTER_EVIDENCE_FORMAT_VERSION,
  buildSingleWaveEncounterEvidence,
  prescribedThroughWaterVelocity,
  presentationHeadingDirection,
} from '../src/vessel/schooner/EncounterMotion';
import type { SingleWaveEncounterEvidence } from '../src/vessel/schooner/EncounterMotion';

const DEG = Math.PI / 180;

describe('ship response evidence', () => {
  it('maps presentation heading onto the local wave frame', () => {
    expect(presentationHeadingDirection(0).x).toBeCloseTo(0, 12);
    expect(presentationHeadingDirection(0).z).toBeCloseTo(-1, 12);
    expect(presentationHeadingDirection(90).x).toBeCloseTo(1, 12);
    expect(presentationHeadingDirection(90).z).toBeCloseTo(0, 12);
    expect(prescribedThroughWaterVelocity(180, 4).x).toBeCloseTo(0, 12);
    expect(prescribedThroughWaterVelocity(180, 4).z).toBeCloseTo(4, 12);
    expect(() => prescribedThroughWaterVelocity(0, -1)).toThrow(/non-negative/);
  });

  it('maps presentation headings onto the model yaw without ambiguity', () => {
    expect(responseHeadings(15)).toEqual(Array.from({ length: 24 }, (_, i) => i * 15));
    expect(presentationHeadingToModelYawRadians(180)).toBeCloseTo(0, 12);
    expect(presentationHeadingToModelYawRadians(90)).toBeCloseTo(90 * DEG, 12);
    expect(presentationHeadingToModelYawRadians(0)).toBeCloseTo(180 * DEG, 12);
  });

  it('matches deep-water encounter frequency in head, following, beam and quartering seas', () => {
    const evidence = buildSingleWaveEncounterEvidence();
    const byAspect = new Map(evidence.cases.map((result) => [result.aspect, result]));
    const head = byAspect.get('head');
    const quarter = byAspect.get('quartering-head');
    const beam = byAspect.get('beam');
    const following = byAspect.get('following');

    expect(head).toBeDefined();
    expect(quarter).toBeDefined();
    expect(beam).toBeDefined();
    expect(following).toBeDefined();
    expect(Math.max(...evidence.cases.map((result) => result.relativeFrequencyError))).toBeLessThan(
      0.002,
    );
    expect(head!.measuredAngularFrequencyRadPerSecond).toBeGreaterThan(
      quarter!.measuredAngularFrequencyRadPerSecond,
    );
    expect(quarter!.measuredAngularFrequencyRadPerSecond).toBeGreaterThan(
      beam!.measuredAngularFrequencyRadPerSecond,
    );
    expect(beam!.measuredAngularFrequencyRadPerSecond).toBeGreaterThan(
      following!.measuredAngularFrequencyRadPerSecond,
    );
    expect(beam!.measuredPeriodSeconds).toBeCloseTo(
      evidence.configuration.resolvedIntrinsicPeriodSeconds,
      3,
    );
  });

  it('validates pitch free decay as a measured, damped oscillator', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const decay = measureShipFreeDecay(5, 20);

    expect(decay.roll.measuredPeriodSeconds).toBeGreaterThan(5.5);
    expect(decay.roll.measuredPeriodSeconds).toBeLessThan(6.2);
    expect(decay.pitch.zeroCrossingsSeconds.length).toBeGreaterThan(8);
    expect(decay.pitch.peaks.length).toBeGreaterThan(5);
    expect(decay.pitch.effectiveDampingRatio).toBeGreaterThan(0.3);
    expect(decay.pitch.effectiveDampingRatio).toBeLessThan(0.5);
    expect(decay.pitch.measuredPeriodSeconds).toBeGreaterThan(2.7);
    expect(decay.pitch.measuredPeriodSeconds).toBeLessThan(3.6);

    // This is deliberately broad. The present 3.25 s measurement is materially
    // slower than SHIP_SPEC's old ~2.2 s estimate; the committed baseline makes
    // that discrepancy evidence to investigate, not a value to tune away here.
    expect(decay.pitch.measuredToClosedFormRatio).toBeGreaterThan(1);
    expect(decay.pitch.measuredToClosedFormRatio).toBeLessThan(1.25);
  });

  it('records finite motion, contact and limiter margin for a coarse case', () => {
    const result = runShipResponseCase({
      seaStateName: 'CURRENT_MODERATE',
      presentationHeadingDeg: 180,
      warmupSeconds: 5,
      measurementSeconds: 10,
      callerHz: 60,
    });

    expect(result.sampleFrames).toBe(600);
    expect(result.modelYawDeg).toBe(0);
    expect(result.speedThroughWaterMps).toBe(0);
    expect(result.finite).toBe(true);
    expect(result.motion.heaveDisplacementMetres.mean).toBe(0);
    expect(result.motion.heaveDisplacementMetres.rms).toBeGreaterThan(0);
    expect(result.motion.rollDeg.peakAbsolute).toBeGreaterThan(1);
    expect(result.contact.wetStationFraction.min).toBeGreaterThan(0.5);
    expect(result.contact.wetStationFraction.max).toBeLessThanOrEqual(1);
    expect(result.contact.submergedVolumeRatio.mean).toBeGreaterThan(0.5);
    expect(result.contact.submergedVolumeRatio.mean).toBeLessThan(1.5);
    expect(result.limits.rollMarginDeg).toBeGreaterThan(0);
    expect(result.limits.pitchMarginDeg).toBeGreaterThan(0);
    expect(result.limits.touchedAttitudeLimit).toBe(false);
    expect(result.limits.touchedAngularRateLimit).toBe(false);
    expect(result.limits.touchedVerticalSpeedLimit).toBe(false);
    expect(result.maxWaveInverseSolveResidualMetres).toBeLessThan(1e-6);
  }, 120_000);

  it('requires moving cases to stay aligned with the fixed physics clock', () => {
    expect(() =>
      runShipResponseCase({
        seaStateName: 'CURRENT_MODERATE',
        presentationHeadingDeg: 180,
        speedThroughWaterMps: 4,
        warmupSeconds: 0,
        measurementSeconds: 1,
        callerHz: 50,
      }),
    ).toThrow(/must divide/);
  });

  it('tows the hull through wave coordinates without a caller-rate staircase', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const run = (speedThroughWaterMps: number, callerHz: number) =>
      runShipResponseCase({
        seaStateName: 'CURRENT_MODERATE',
        presentationHeadingDeg: 234,
        speedThroughWaterMps,
        warmupSeconds: 5,
        measurementSeconds: 10,
        callerHz,
      });
    const stationary = run(0, 60);
    const moving60 = run(4, 60);
    const moving30 = run(4, 30);
    const relativeDifference = (a: number, b: number) =>
      Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);

    // Translation must change the excitation, not merely a recorded speed.
    expect(
      Math.abs(moving60.motion.rollDeg.rms - stationary.motion.rollDeg.rms),
    ).toBeGreaterThan(1);
    // Both caller rates feed the same 240 Hz path and wave times.
    expect(
      relativeDifference(moving60.motion.rollDeg.rms, moving30.motion.rollDeg.rms),
    ).toBeLessThan(0.02);
    expect(
      relativeDifference(moving60.motion.pitchDeg.rms, moving30.motion.pitchDeg.rms),
    ).toBeLessThan(0.02);
    expect(
      relativeDifference(
        moving60.motion.heaveDisplacementMetres.rms,
        moving30.motion.heaveDisplacementMetres.rms,
      ),
    ).toBeLessThan(0.02);
  });

  it('keeps opposite stationary headings symmetric within a documented tolerance', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const run = (heading: number) =>
      runShipResponseCase({
        seaStateName: 'CURRENT_MODERATE',
        presentationHeadingDeg: heading,
        warmupSeconds: 5,
        measurementSeconds: 20,
        callerHz: 60,
      });
    const north = run(0);
    const south = run(180);

    const relativeDifference = (a: number, b: number) =>
      Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);

    // The bow and stern are not geometrically identical, so exact equality is
    // neither expected nor desirable. At zero speed the excitation should
    // nevertheless be reciprocal to within a few percent.
    expect(
      relativeDifference(north.motion.rollDeg.rms, south.motion.rollDeg.rms),
    ).toBeLessThan(0.03);
    expect(
      relativeDifference(north.motion.pitchDeg.rms, south.motion.pitchDeg.rms),
    ).toBeLessThan(0.03);
    expect(
      relativeDifference(
        north.motion.rollDeg.peakAbsolute,
        south.motion.rollDeg.peakAbsolute,
      ),
    ).toBeLessThan(0.05);
  });

  it('keeps the committed full baseline complete, reciprocal and self-consistent', () => {
    const matrix = JSON.parse(
      readFileSync('evidence/ship-response/zero-speed-baseline.json', 'utf8'),
    ) as ShipResponseMatrix;

    expect(matrix.formatVersion).toBe(SHIP_RESPONSE_FORMAT_VERSION);
    expect(matrix.configuration.seaStates).toEqual([...SHIP_RESPONSE_BASELINE_SEAS]);
    expect(matrix.configuration.headingsDeg).toEqual(responseHeadings());
    expect(matrix.configuration.warmupSeconds).toBe(
      SHIP_RESPONSE_BASELINE_CONFIG.warmupSeconds,
    );
    expect(matrix.configuration.measurementSeconds).toBe(
      SHIP_RESPONSE_BASELINE_CONFIG.measurementSeconds,
    );
    expect(matrix.configuration.callerHz).toBe(SHIP_RESPONSE_BASELINE_CONFIG.callerHz);
    expect(matrix.cases).toHaveLength(
      matrix.configuration.seaStates.length * matrix.configuration.headingsDeg.length,
    );
    expect(matrix.summary.caseCount).toBe(matrix.cases.length);
    expect(matrix.cases.every((result) => result.finite)).toBe(true);
    expect(
      Math.max(...matrix.cases.map((result) => result.maxWaveInverseSolveResidualMetres)),
    ).toBeLessThanOrEqual(1e-6);

    const byCase = new Map(
      matrix.cases.map((result) => [
        `${result.seaState}:${result.presentationHeadingDeg}`,
        result,
      ]),
    );
    const worst = { rollRms: 0, pitchRms: 0, rollPeak: 0, pitchPeak: 0 };
    const relativeDifference = (a: number, b: number) =>
      Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);

    for (const result of matrix.cases) {
      if (result.presentationHeadingDeg >= 180) continue;
      const opposite = byCase.get(
        `${result.seaState}:${result.presentationHeadingDeg + 180}`,
      );
      expect(opposite).toBeDefined();
      if (!opposite) continue;
      worst.rollRms = Math.max(
        worst.rollRms,
        relativeDifference(result.motion.rollDeg.rms, opposite.motion.rollDeg.rms),
      );
      worst.pitchRms = Math.max(
        worst.pitchRms,
        relativeDifference(result.motion.pitchDeg.rms, opposite.motion.pitchDeg.rms),
      );
      worst.rollPeak = Math.max(
        worst.rollPeak,
        relativeDifference(
          result.motion.rollDeg.peakAbsolute,
          opposite.motion.rollDeg.peakAbsolute,
        ),
      );
      worst.pitchPeak = Math.max(
        worst.pitchPeak,
        relativeDifference(
          result.motion.pitchDeg.peakAbsolute,
          opposite.motion.pitchDeg.peakAbsolute,
        ),
      );
    }

    expect(worst.rollRms).toBeLessThan(
      SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES.rmsRelativeDifference,
    );
    expect(worst.pitchRms).toBeLessThan(
      SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES.rmsRelativeDifference,
    );
    expect(worst.rollPeak).toBeLessThan(
      SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES.peakRelativeDifference,
    );
    expect(worst.pitchPeak).toBeLessThan(
      SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES.peakRelativeDifference,
    );
  });

  it('keeps the committed prescribed-motion evidence complete and self-consistent', () => {
    const frequency = JSON.parse(
      readFileSync('evidence/ship-response/encounter-frequency.json', 'utf8'),
    ) as SingleWaveEncounterEvidence;
    const matrix = JSON.parse(
      readFileSync('evidence/ship-response/prescribed-speed-baseline.json', 'utf8'),
    ) as ShipResponseMatrix;

    expect(frequency.formatVersion).toBe(ENCOUNTER_EVIDENCE_FORMAT_VERSION);
    expect(frequency.cases.map((result) => result.aspect)).toEqual([
      'head',
      'quartering-head',
      'beam',
      'following',
    ]);
    expect(
      Math.max(...frequency.cases.map((result) => result.relativeFrequencyError)),
    ).toBeLessThan(0.002);

    expect(matrix.formatVersion).toBe(SHIP_RESPONSE_FORMAT_VERSION);
    expect(matrix.configuration.seaStates).toEqual([
      ...SHIP_RESPONSE_ENCOUNTER_CONFIG.seaStateNames,
    ]);
    expect(matrix.configuration.headingsDeg).toEqual([
      ...SHIP_RESPONSE_ENCOUNTER_CONFIG.headingsDeg,
    ]);
    expect(matrix.configuration.referenceWaveHeadingDeg).toBe(
      SHIP_RESPONSE_ENCOUNTER_CONFIG.referenceWaveHeadingDeg,
    );
    expect(matrix.configuration.speedThroughWaterMps).toBe(
      SHIP_RESPONSE_ENCOUNTER_CONFIG.speedThroughWaterMps,
    );
    expect(matrix.cases).toHaveLength(
      SHIP_RESPONSE_ENCOUNTER_CONFIG.seaStateNames.length *
        SHIP_RESPONSE_ENCOUNTER_CONFIG.headingsDeg.length,
    );
    expect(matrix.cases.every((result) => result.finite)).toBe(true);
    expect(
      matrix.cases.every(
        (result) =>
          result.speedThroughWaterMps ===
          SHIP_RESPONSE_ENCOUNTER_CONFIG.speedThroughWaterMps,
      ),
    ).toBe(true);
    expect(matrix.summary.limiterContactCaseCount).toBe(0);
    expect(
      Math.max(...matrix.cases.map((result) => result.maxWaveInverseSolveResidualMetres)),
    ).toBeLessThanOrEqual(1e-6);
  });
});
