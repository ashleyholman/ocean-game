import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import { PHYSICS_STEP } from '../src/vessel/BuoyantBody';
import { SailingControls } from '../src/vessel/schooner/SailingControls';
import {
  validateSailingCrewEvidence,
  type SailingCrewEvidence,
} from '../src/vessel/schooner/SailingCrewEvidence';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  createSchoonerResistanceResult,
  evaluateSchoonerResistance,
  type SchoonerResistanceResult,
} from '../src/vessel/schooner/SchoonerResistance';
import {
  createSailAeroResult,
  evaluateSailAero,
  frozenSailStates,
  FULL_SAIL,
} from '../src/vessel/schooner/sailAero';
import {
  CompassInstrument,
  signedAngleDifferenceDeg,
} from '../src/vessel/schooner/crew/CompassInstrument';
import {
  CrewOrderBook,
  StationOrderPipeline,
} from '../src/vessel/schooner/crew/CrewOrders';
import {
  RUDDER_HINGE_ARM_M,
  SailingCrewSensors,
  tillerHandForceN,
  type HelmObservation,
} from '../src/vessel/schooner/crew/CrewObservations';
import {
  COMPETENT_HUMAN_OPERATOR_PROFILE,
  createHumanRandomStream,
  sampleShiftedLognormalSeconds,
} from '../src/vessel/schooner/crew/HumanOperator';
import { SailingCrew } from '../src/vessel/schooner/crew/SailingCrew';

const DEG_TO_RAD = Math.PI / 180;

function runCompassStep(
  fromDeg: number,
  toDeg: number,
  durationSeconds = 18,
): Array<{ time: number; indication: number; rate: number }> {
  const compass = new CompassInstrument();
  compass.reset(fromDeg);
  const samples: Array<{ time: number; indication: number; rate: number }> = [];
  const steps = Math.round(durationSeconds / PHYSICS_STEP);
  for (let i = 0; i < steps; i++) {
    const readout = compass.advance(PHYSICS_STEP, {
      trueHeadingDeg: toDeg,
      rollRateRadPerSecond: 0,
    });
    if ((i + 1) % 24 === 0) {
      samples.push({
        time: (i + 1) * PHYSICS_STEP,
        indication: readout.indicatedHeadingDeg,
        rate: readout.cardRateDegPerSecond,
      });
    }
  }
  return samples;
}

function evaluateCaptive(options: {
  forwardSpeedMps: number;
  rudderAngleDeg: number;
}): SchoonerResistanceResult {
  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  body.snapToSurface(waves, 0, 0, 0);
  body.update(
    0,
    waves,
    0,
    0,
    0,
    PHYSICS_STEP,
    0,
    options.forwardSpeedMps,
  );
  return evaluateSchoonerResistance(
    {
      contacts: body.contacts,
      modelYawRad: 0,
      rudderAngleRad: options.rudderAngleDeg * DEG_TO_RAD,
    },
    createSchoonerResistanceResult(),
  );
}

function mutableObservation(readingDeg: number): HelmObservation {
  return {
    elapsedSeconds: 0,
    focus: 'checking-compass',
    compass: {
      readingDeg,
      ageSeconds: 0,
      confidence: 'focused',
      trend: 'steady',
    },
    shipHead: { swing: 'steady', strength: 'none' },
    windAndSails: {
      side: 'unclear',
      strength: 'working',
      cloth: 'drawing',
      angleOffBowDeg: null,
      angleAgeSeconds: Infinity,
    },
    bodyMotion: { swing: 'steady', heelWeight: 'level' },
    tillerLoad: {
      signedHandForceN: 0,
      direction: 'neutral',
      weight: 'light',
      trend: 'steady',
    },
  };
}

function advanceCrew(
  crew: SailingCrew,
  controls: SailingControls,
  observation: HelmObservation,
  seconds: number,
): void {
  const steps = Math.round(seconds / PHYSICS_STEP);
  for (let i = 0; i < steps; i++) {
    (observation as { elapsedSeconds: number }).elapsedSeconds += PHYSICS_STEP;
    (observation as { focus: HelmObservation['focus'] }).focus = crew.focus;
    crew.advanceSubstep(PHYSICS_STEP, observation);
    controls.advanceSubstep(PHYSICS_STEP);
  }
}

describe('S5 physical compass', () => {
  it('responds finitely, permits a small overshoot, and settles without bias', () => {
    const samples = runCompassStep(20, 50);
    const atHalfSecond = samples.find((sample) => sample.time >= 0.5)!;
    expect(atHalfSecond.indication).toBeGreaterThan(20);
    expect(atHalfSecond.indication).toBeLessThan(50);
    const errors = samples.map((sample) =>
      signedAngleDifferenceDeg(sample.indication, 50),
    );
    expect(Math.max(...errors)).toBeGreaterThan(0.05);
    expect(Math.max(...errors)).toBeLessThan(3);
    expect(Math.abs(errors[errors.length - 1])).toBeLessThan(0.03);
    expect(Math.abs(samples[samples.length - 1].rate)).toBeLessThan(0.03);
  });

  it('takes the short path through north in both directions', () => {
    const clockwise = runCompassStep(350, 10, 2);
    const anticlockwise = runCompassStep(10, 350, 2);
    expect(clockwise[1].rate).toBeGreaterThan(0);
    expect(anticlockwise[1].rate).toBeLessThan(0);
    expect(
      Math.abs(signedAngleDifferenceDeg(clockwise[clockwise.length - 1].indication, 10)),
    ).toBeLessThan(10);
    expect(
      Math.abs(signedAngleDifferenceDeg(anticlockwise[anticlockwise.length - 1].indication, 350)),
    ).toBeLessThan(10);
  });

  it('turns roll motion into bounded correlated card agitation, not white noise', () => {
    const compass = new CompassInstrument();
    compass.reset(180);
    const values: number[] = [];
    for (let i = 0; i < 20 * 240; i++) {
      const time = i / 240;
      const readout = compass.advance(PHYSICS_STEP, {
        trueHeadingDeg: 180,
        rollRateRadPerSecond: 0.16 * Math.sin((2 * Math.PI * time) / 5.5),
      });
      values.push(signedAngleDifferenceDeg(readout.indicatedHeadingDeg, 180));
    }
    expect(Math.max(...values.map(Math.abs))).toBeLessThan(3);
    let maximumStep = 0;
    for (let i = 1; i < values.length; i++) {
      maximumStep = Math.max(maximumStep, Math.abs(values[i] - values[i - 1]));
    }
    expect(maximumStep).toBeLessThan(0.03);
  });
});

describe('S5 deterministic human timing and spoken orders', () => {
  it('isolates streams by station and purpose', () => {
    const helmA = createHumanRandomStream(41, 'helm', 'action');
    const helmB = createHumanRandomStream(41, 'helm', 'action');
    const main = createHumanRandomStream(41, 'mainsail', 'action');
    const first = Array.from({ length: 8 }, () => helmA.next());
    for (let i = 0; i < 30; i++) main.next();
    expect(Array.from({ length: 8 }, () => helmB.next())).toEqual(first);
    expect(main.next()).not.toBe(helmA.next());
  });

  it('samples positive bounded right-skewed response times once', () => {
    const random = createHumanRandomStream(12, 'helm', 'order-response');
    const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.response.processing;
    const samples = Array.from({ length: 1000 }, () =>
      sampleShiftedLognormalSeconds(random, profile),
    ).sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(samples[0]).toBeGreaterThanOrEqual(profile.minSeconds);
    expect(samples[samples.length - 1]).toBeLessThanOrEqual(profile.maxSeconds);
    expect(mean).toBeGreaterThan(median);
  });

  it('shares utterance duration but keeps station responses independent', () => {
    const orders = new CrewOrderBook(99);
    const order = orders.issue(
      'trim-to-draw',
      ['mainsail', 'foresail'],
      4,
      {},
      true,
    );
    const main = new StationOrderPipeline('mainsail', 99);
    const fore = new StationOrderPipeline('foresail', 99);
    const a = main.receive(order);
    const b = fore.receive(order);
    expect(a.timing.utteranceCompleteAtSeconds).toBe(
      b.timing.utteranceCompleteAtSeconds,
    );
    expect(a.timing.recognitionDelaySeconds).not.toBe(
      b.timing.recognitionDelaySeconds,
    );
    expect(a.timing.motorStartedAtSeconds).toBeGreaterThan(
      a.timing.processedAtSeconds,
    );
    main.advance(a.timing.motorStartedAtSeconds);
    expect(main.consumeReadyOrder()).toBe(order);
    expect(main.consumeReadyOrder()).toBeNull();
    main.advance(a.timing.motorStartedAtSeconds + 1);
    expect(main.consumeReadyOrder()).toBeNull();
  });
});

describe('S5 felt wind side and the dogvane (signs set by test, not reasoning)', () => {
  /**
   * `ship-sailing-aero.test.ts` pins the forces on this exact fixture: wind
   * blowing toward +x at yaw 0 is a wind over the STARBOARD rail. Everything
   * a trimmer decides depends on which cheek that is, so the reduction from
   * the published apparent wind down to a felt side is pinned here too.
   */
  function beamReachSensors(windTowardX: number) {
    const waves = new WaveField(findSeaState('FLAT'));
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    const aero = createSailAeroResult();
    evaluateSailAero(
      {
        trueWindWorldX: windTowardX,
        trueWindWorldZ: 0,
        velocityWorldX: 0,
        velocityWorldY: 0,
        velocityWorldZ: 0,
        yawRad: 0,
        pitchRad: 0,
        rollRad: 0,
        yawRateRadPerSecond: 0,
        pitchRateRadPerSecond: 0,
        rollRateRadPerSecond: 0,
        comX: body.comX,
        comY: body.comY,
        comZ: body.comZ,
        sails: frozenSailStates(FULL_SAIL, windTowardX > 0 ? 'starboard' : 'port'),
      },
      aero,
    );
    const sensors = new SailingCrewSensors({
      seed: 7,
      headingDegForModelYaw: () => 0,
      rudderTargetDeg: () => 0,
      sailAero: () => aero,
      focus: () => 'checking-sails-wind',
    });
    const resistance = evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: 0 });
    for (let i = 0; i < 480; i++) {
      sensors.observeSubstep(PHYSICS_STEP, body, 0, 0, 0, 3, resistance);
    }
    return sensors;
  }

  it('calls a wind blowing toward port a wind from starboard', () => {
    const cue = beamReachSensors(8).helmObservation.windAndSails;
    expect(cue.side).toBe('starboard');
    // Beam wind at yaw 0, read off a coarse vane: square abeam, ±one notch.
    expect(cue.angleOffBowDeg).not.toBeNull();
    expect(Math.abs(cue.angleOffBowDeg! - 90)).toBeLessThanOrEqual(10);
  });

  it('mirrors on the other tack', () => {
    const cue = beamReachSensors(-8).helmObservation.windAndSails;
    expect(cue.side).toBe('port');
    expect(Math.abs(cue.angleOffBowDeg! - 90)).toBeLessThanOrEqual(10);
  });

  it('reads the vane coarsely — never the exact apparent angle', () => {
    const sensors = beamReachSensors(8);
    const reading = sensors.helmObservation.windAndSails.angleOffBowDeg!;
    const resolution =
      COMPETENT_HUMAN_OPERATOR_PROFILE.perception.windVaneFocusedResolutionDeg;
    expect(reading % resolution).toBe(0);
  });
});

describe('S5 helm observation boundary', () => {
  it('exposes human cues and keeps exact physics types out of Helmsman', () => {
    let focus: HelmObservation['focus'] = 'looking-ahead';
    const aero = createSailAeroResult();
    const sensors = new SailingCrewSensors({
      seed: 1,
      headingDegForModelYaw: () => 180,
      rudderTargetDeg: () => 0,
      sailAero: () => aero,
      focus: () => focus,
    });
    const waves = new WaveField(findSeaState('FLAT'));
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    const resistance = evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: 8 });
    for (let i = 0; i < 240; i++) {
      sensors.observeSubstep(PHYSICS_STEP, body, 0, 0, 0, 3, resistance);
    }
    focus = 'checking-compass';
    for (let i = 0; i < 240; i++) {
      sensors.observeSubstep(PHYSICS_STEP, body, 0, 0, 0, 3, resistance);
    }
    const observation = sensors.helmObservation;
    expect(observation.compass.readingDeg).not.toBeNull();
    expect(Object.keys(observation)).toEqual([
      'elapsedSeconds',
      'focus',
      'compass',
      'shipHead',
      'windAndSails',
      'bodyMotion',
      'tillerLoad',
    ]);
    const source = readFileSync(
      'src/vessel/schooner/crew/Helmsman.ts',
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*SchoonerResistance/);
    expect(source).not.toMatch(/from ['"].*sailAero/);
    expect(source).not.toMatch(/from ['"].*VesselMotion/);
    sensors.reset();
    expect(sensors.helmObservation).toMatchObject({
      elapsedSeconds: 0,
      focus: 'looking-ahead',
      compass: { readingDeg: null, confidence: 'unacquired' },
      shipHead: { swing: 'steady', strength: 'none' },
      tillerLoad: { signedHandForceN: 0, direction: 'neutral' },
    });
    expect(sensors.readout().devTruth).toEqual({
      headingDeg: 0,
      rudderActualDeg: 0,
      rudderTargetDeg: 0,
      tillerHandForceN: 0,
    });
  });

  it('reports bow swing in compass sense rather than model-yaw sign', () => {
    const sensors = new SailingCrewSensors({
      seed: 2,
      headingDegForModelYaw: () => 180,
      rudderTargetDeg: () => 0,
      sailAero: () => createSailAeroResult(),
      focus: () => 'looking-ahead',
    });
    const waves = new WaveField(findSeaState('FLAT'));
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    const resistance = evaluateCaptive({
      forwardSpeedMps: 3,
      rudderAngleDeg: 0,
    });
    for (let i = 0; i < 240; i++) {
      sensors.observeSubstep(PHYSICS_STEP, body, 0, 0.02, 0, 3, resistance);
    }
    expect(sensors.helmObservation.shipHead.swing).toBe('port');
    for (let i = 0; i < 360; i++) {
      sensors.observeSubstep(PHYSICS_STEP, body, 0, -0.02, 0, 3, resistance);
    }
    expect(sensors.helmObservation.shipHead.swing).toBe('starboard');
  });

  it('derives tiller load from the canonical blade and reverses under sternway', () => {
    expect(RUDDER_HINGE_ARM_M).toBeGreaterThan(0.3);
    const aheadPort = tillerHandForceN(
      evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: 10 }),
    );
    const aheadStarboard = tillerHandForceN(
      evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: -10 }),
    );
    const asternPort = tillerHandForceN(
      evaluateCaptive({ forwardSpeedMps: -3, rudderAngleDeg: 10 }),
    );
    const asternStarboard = tillerHandForceN(
      evaluateCaptive({ forwardSpeedMps: -3, rudderAngleDeg: -10 }),
    );
    expect(aheadPort).toBeGreaterThan(0);
    expect(aheadStarboard).toBeLessThan(0);
    expect(asternPort).toBeLessThan(0);
    expect(asternStarboard).toBeGreaterThan(0);
    expect(Math.abs(aheadPort)).toBeCloseTo(Math.abs(aheadStarboard), 8);
  });
});

describe('S5 event-like compass-course helmsman', () => {
  it('waits through the spoken response and makes finite interventions', () => {
    const controls = new SailingControls();
    const crew = new SailingCrew(controls, 123);
    const observation = mutableObservation(170);
    const order = crew.orderCompassCourse(180);
    advanceCrew(crew, controls, observation, 0.8);
    expect(controls.rudderTargetDeg).toBe(0);
    expect(crew.readout().helmsman.orderPhase).toBe('ordered');
    advanceCrew(crew, controls, observation, 7);
    const readout = crew.readout().helmsman;
    expect(readout.interventionCount).toBeGreaterThan(0);
    expect(readout.interventionCount).toBeLessThan(5);
    expect(readout.latestIntervention!.orderSequenceId).toBe(order.sequenceId);
    expect(readout.latestIntervention!.decidedAtSeconds).toBeGreaterThan(
      readout.latestIntervention!.consideredAtSeconds,
    );
    expect(readout.latestIntervention!.executeAtSeconds).toBeGreaterThan(
      readout.latestIntervention!.decidedAtSeconds,
    );
    expect(controls.rudderTargetDeg).toBeLessThan(0);
  });

  it('is silent during direct takeover and reacquires after release', () => {
    const controls = new SailingControls();
    const crew = new SailingCrew(controls, 456);
    const observation = mutableObservation(166);
    crew.orderCompassCourse(180);
    advanceCrew(crew, controls, observation, 7);
    crew.setDirectHelmTakeover(true);
    controls.commandRudderDeg(7);
    const before = crew.readout().helmsman.interventionCount;
    advanceCrew(crew, controls, observation, 3);
    expect(controls.rudderTargetDeg).toBe(7);
    expect(crew.readout().helmsman.interventionCount).toBe(before);
    crew.setDirectHelmTakeover(false);
    advanceCrew(crew, controls, observation, 0.3);
    expect(controls.rudderTargetDeg).toBe(7);
    expect(crew.readout().helmsman.reacquiring).toBe(true);
    advanceCrew(crew, controls, observation, 4);
    expect(crew.readout().helmsman.interventionCount).toBeGreaterThan(before);
  });
});

describe('ship:crew — committed S5 checkpoint evidence', () => {
  const evidence = JSON.parse(
    readFileSync('evidence/ship-sailing/crew-baseline.json', 'utf8'),
  ) as SailingCrewEvidence;

  it('carries the physical compass and human helm gates', () => {
    expect(() => validateSailingCrewEvidence(evidence)).not.toThrow();
    expect(evidence.formatVersion).toBe(2);
    expect(evidence.gates.compassCallerRateInvariant).toBe(true);
    expect(evidence.gates.helmCallerRateInvariant).toBe(true);
    expect(evidence.gates.helmAccuracyInBand).toBe(true);
    expect(evidence.gates.helmHoldsCourseCentred).toBe(true);
    expect(evidence.gates.nonzeroHumanLatency).toBe(true);
    expect(evidence.gates.interventionCadenceInBand).toBe(true);
    expect(evidence.gates.settledCourseDoesNotChatter).toBe(true);
    expect(evidence.gates.meaningfulUnchangedTargets).toBe(true);
    expect(evidence.gates.correctWatchEaseEpisodes).toBe(true);
    expect(evidence.gates.directTakeoverSilent).toBe(true);
    expect(evidence.gates.directReleaseReacquires).toBe(true);
  });

  it('carries the standing trim-duty gates', () => {
    expect(evidence.gates.trimWaitsForItsOwnOrder).toBe(true);
    expect(evidence.gates.trimEpisodesLeaveObservationGaps).toBe(true);
    expect(evidence.gates.trimReachesUsefulFraction).toBe(true);
    expect(evidence.gates.trimDoesNotReproduceTheOracle).toBe(true);
    expect(evidence.gates.trimRecoversBadlySetRig).toBe(true);
    expect(evidence.gates.cannotDrawIsReportedFromSustainedEvidence).toBe(true);
  });

  it('gives every station its own order response and its own hands', () => {
    for (const trimCase of [
      evidence.trim.fromWorkingTrims,
      evidence.trim.fromBadlySetRig,
      evidence.trim.inStrongWind,
    ]) {
      expect(trimCase.stations.length).toBe(6);
      const readyTimes = new Set<number>();
      for (const station of trimCase.stations) {
        // Heard, understood, and only then a hand on the rope.
        expect(station.readyAtSeconds).toBeGreaterThan(0);
        readyTimes.add(station.readyAtSeconds);
        if (station.firstAdjustmentAtSeconds !== null) {
          expect(station.firstAdjustmentAtSeconds).toBeGreaterThanOrEqual(
            station.readyAtSeconds,
          );
        }
        // Finite episodes: whatever he did, he looked at it before doing more.
        if (station.minimumAdjustmentGapSeconds !== null) {
          expect(station.minimumAdjustmentGapSeconds).toBeGreaterThanOrEqual(1.5);
        }
      }
      // Independently sampled delays, so they do not all start together. This
      // is a property of the streams, not an anti-synchrony rule: stations are
      // never prevented from coinciding, they simply are not forced to.
      expect(readyTimes.size).toBeGreaterThan(1);
    }
  });

  it('works her by eye without arriving at the ideal schedule', () => {
    const working = evidence.trim.fromWorkingTrims;
    const bad = evidence.trim.fromBadlySetRig;
    // Useful — a crew that could not keep her going would be a failure.
    expect(working.polarFraction).toBeGreaterThanOrEqual(0.94);
    expect(bad.polarFraction).toBeGreaterThanOrEqual(0.94);
    // And genuinely recovered: a badly set rig nobody touches stays slow.
    //
    // The BOUND moved 0.90 → 0.92 in S6c, and the number that moved is the
    // denominator. Absolutely, the untouched bad rig got slower (3.11 →
    // 2.91 m/s); the ideal schedule it is measured against got slower
    // faster (3.65 → 3.22), so the fraction rose from 0.850 to 0.904. She
    // is still 9.6% slow with nobody on the sheets, which is what this
    // gate is for, and the trimmers still recover three quarters of it
    // (0.904 → 0.980 — better than the 0.850 → 0.961 they used to manage).
    expect(bad.untrimmedPolarFraction).toBeLessThan(0.92);
    expect(bad.polarFraction).toBeGreaterThan(bad.untrimmedPolarFraction + 0.05);
    // But not the oracle's answer. Every sheet station on the badly set rig
    // ends somewhere the schedule did not put it, which is what "they cannot
    // call it" has to look like from outside.
    const distances = bad.stations
      .filter((station) => station.station !== 'foreTopsail')
      .map((station) => station.trimDifferenceDeg);
    const mean =
      distances.reduce((sum, value) => sum + value, 0) / distances.length;
    expect(mean).toBeGreaterThanOrEqual(2);
  });

  it('eases when she is overpressed and says so when a sail will not draw', () => {
    // Strong wind: the hands feel her lying over and let sheets out. They can
    // only ease — shortening sail is S6 — so this is a bound, not a cure.
    expect(evidence.trim.inStrongWind.overpoweredEases).toBeGreaterThan(0);
    for (const station of evidence.trim.inStrongWind.stations) {
      if (station.station === 'foreTopsail') continue;
      expect(Math.abs(station.finalTrimDeg)).toBeGreaterThan(
        Math.abs(station.initialTrimDeg),
      );
    }
    // The square topsail will not draw close-hauled however the yard is
    // braced, and the hand reports it rather than fighting it forever.
    const topsail = evidence.trim.fromWorkingTrims.stations.find(
      (station) => station.station === 'foreTopsail',
    )!;
    expect(topsail.cannotDraw).toBe(true);
    expect(Math.abs(topsail.finalTrimDeg)).toBeGreaterThan(
      Math.abs(topsail.initialTrimDeg),
    );
  });

  it('records the internal observation-to-action chain, not accuracy alone', () => {
    for (const run of [evidence.helm.calm, evidence.helm.currentModerate]) {
      expect(run.trace.length).toBeGreaterThan(100);
      expect(run.interventions.length).toBeGreaterThan(0);
      expect(run.firstOrderLatencySeconds).toBeGreaterThan(0);
      expect(run.firstInterventionLatencySeconds).not.toBeNull();
      expect(run.maximumUnchangedTargetSeconds).toBeGreaterThan(1.5);
      expect(run.trace.some((sample) => sample.focus === 'checking-compass')).toBe(
        true,
      );
      expect(run.trace.some((sample) => sample.focus === 'watching-response')).toBe(
        true,
      );
      expect(
        run.trace.some((sample) => sample.perceivedCompassDeg !== null),
      ).toBe(true);
      expect(
        run.interventions.some(
          (event) => event.executeAtSeconds > event.decidedAtSeconds,
        ),
      ).toBe(true);
    }
  });
});
