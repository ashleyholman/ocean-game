import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { whitecapCoverage } from '../src/ocean/spectrum';
import {
  HullSprayEventDetector,
  type HullSprayEventInput,
} from '../src/scene/hullSprayEvents';
import {
  SPRAY_ARM_DRIVE_CALM,
  SPRAY_ARM_DRIVE_ROUGH,
  SPRAY_ENTRY_POWER_REFERENCE_W,
  SPRAY_MINIMUM_INTERVAL_SECONDS,
  SPRAY_RELEASE_FRACTION,
  SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX,
  SPRAY_TEAR_MAX_SECONDS,
  SPRAY_WAY_ONSET_MPS,
  WAKE_POLICY_HULL_SPEED_MPS,
  createWakeSprayBurstSizing,
  createWakeSprayPolicyResult,
  resolveWakeSprayPolicy,
  sizeWakeSprayBurst,
} from '../src/scene/wakePolicy';
import {
  createHullWaterContact,
  type HullWaterContact,
} from '../src/vessel/HullWaterContact';
import { WakeSources } from '../src/vessel/WakeSources';
import { runWakeContactCase } from '../src/vessel/schooner/WakeSourcesEvidence';

/**
 * A rate function's edges cannot be checked by reading it.
 *
 * Thirty-one `toContain` assertions on `Ocean.ts` passed the whole time an
 * earlier round in this thread was cutting the bow crest at its steepest point,
 * because a source-text assertion cannot see an inequality. So the gates below
 * either mirror the arithmetic in JS and assert the bound, or run the real
 * contact model and count what actually came out.
 */

const DT = 1 / 60;

/** Two bow stations, whose volume and entry speed the caller drives directly. */
function bowSources(): {
  sources: WakeSources;
  set(volumeM3: number, entrySpeedMps: number): void;
} {
  const contacts: HullWaterContact[] = [0, 1].map((index) => {
    const contact = createHullWaterContact({
      stationIndex: 30 + index,
      stationX: 0,
      stationZ: 5 + index,
      longitudinalRegion: 'bow',
      transverseRegion: 'centre',
    });
    contact.isWet = true;
    // A resolved two-sided cut, so the detector has somewhere to put the sheet.
    contact.portWaterline.active = true;
    contact.portWaterline.worldPoint.x = 0.8;
    contact.portWaterline.worldPoint.z = 6;
    contact.starboardWaterline.active = true;
    contact.starboardWaterline.worldPoint.x = -0.8;
    contact.starboardWaterline.worldPoint.z = 6;
    // Meeting the water head-on: flow toward -z, surface level.
    contact.relativeWaterVelocityWorldMps.z = -3;
    contact.surfaceNormalWorld.x = 0;
    contact.surfaceNormalWorld.y = 1;
    contact.surfaceNormalWorld.z = 0;
    return contact;
  });
  const sources = new WakeSources(contacts, []);
  return {
    sources,
    set(volumeM3, entrySpeedMps) {
      for (const contact of contacts) {
        contact.immersedVolumeM3 = volumeM3 / contacts.length;
        contact.normalEntrySpeedMps = entrySpeedMps;
      }
      sources.update();
    },
  };
}

function input(
  overrides: Partial<HullSprayEventInput> = {},
): HullSprayEventInput {
  return {
    dtSeconds: DT,
    speedThroughWaterMps: 4,
    ambientWhitecapCoverage: 0,
    densityScale: 1,
    enabled: true,
    ...overrides,
  };
}

/**
 * Immersed volume that produces a given entry power at a given entry speed.
 *
 * The mirror of `resolveWakeSprayPolicy`'s arithmetic, so a test can ask for a
 * drive rather than guessing at one — and so a change to the power law breaks
 * this rather than silently retuning every threshold below.
 */
function volumeStepForDrive(
  drive: number,
  entrySpeedMps: number,
  wayGate: number,
): number {
  const powerW = (drive / wayGate) * SPRAY_ENTRY_POWER_REFERENCE_W;
  const rate = powerW / (0.5 * 1025 * entrySpeedMps * entrySpeedMps);
  return rate * DT;
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

describe('WK3 entry drive', () => {
  it('is exactly zero at rest however hard the bow is working', () => {
    // WK0-F1, and then some. At anchor in CURRENT_MODERATE the bow's own
    // entry POWER reaches 22 931 W — above the moderate reach's p95 of 20 206 —
    // so neither the closing speed nor the immersion rate can be the gate. Only
    // way through the water can be, and at rest it must annihilate the product
    // rather than merely shrink it.
    const policy = createWakeSprayPolicyResult();
    resolveWakeSprayPolicy(
      {
        speedThroughWaterMps: 0,
        ambientWhitecapCoverage: whitecapCoverage(6),
        bowImmersionRateM3PerSec: 17,
        bowPeakEntrySpeedMps: 1.635,
      },
      policy,
    );
    expect(policy.wayGate).toBe(0);
    expect(policy.entryPowerW).toBeGreaterThan(20000);
    expect(policy.entryDrive).toBe(0);
  });

  it('counts only the burying half of the cycle', () => {
    const policy = createWakeSprayPolicyResult();
    resolveWakeSprayPolicy(
      {
        speedThroughWaterMps: 4,
        ambientWhitecapCoverage: 0,
        bowImmersionRateM3PerSec: -40,
        bowPeakEntrySpeedMps: 3,
      },
      policy,
    );
    expect(policy.entryDrive).toBe(0);
  });

  it('is non-decreasing in every one of its three inputs', () => {
    const policy = createWakeSprayPolicyResult();
    const drive = (
      speed: number,
      rate: number,
      entry: number,
    ): number =>
      resolveWakeSprayPolicy(
        {
          speedThroughWaterMps: speed,
          ambientWhitecapCoverage: 0,
          bowImmersionRateM3PerSec: rate,
          bowPeakEntrySpeedMps: entry,
        },
        policy,
      ).entryDrive;

    let previous = -Infinity;
    for (let speed = 0; speed <= 6; speed += 0.25) {
      const value = drive(speed, 20, 2);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    previous = -Infinity;
    for (let rate = 0; rate <= 80; rate += 2) {
      const value = drive(4, rate, 2);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    previous = -Infinity;
    for (let entry = 0; entry <= 6; entry += 0.2) {
      const value = drive(4, 20, entry);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('raises the firing threshold with ambient sea energy, and only upward', () => {
    const policy = createWakeSprayPolicyResult();
    const armAt = (coverage: number): number =>
      resolveWakeSprayPolicy(
        {
          speedThroughWaterMps: 4,
          ambientWhitecapCoverage: coverage,
          bowImmersionRateM3PerSec: 0,
          bowPeakEntrySpeedMps: 0,
        },
        policy,
      ).armThreshold;

    let previous = -Infinity;
    for (let coverage = 0; coverage <= 0.12; coverage += 0.002) {
      const value = armAt(coverage);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    // The two ends are the measured states, not round numbers: moderate's
    // Monahan coverage sits below the ramp's foot and Southern's above its head.
    expect(armAt(whitecapCoverage(6))).toBeCloseTo(SPRAY_ARM_DRIVE_CALM, 9);
    expect(armAt(whitecapCoverage(18))).toBeCloseTo(SPRAY_ARM_DRIVE_ROUGH, 9);
    expect(SPRAY_ARM_DRIVE_ROUGH).toBeGreaterThan(SPRAY_ARM_DRIVE_CALM);
  });

  it('sizes the shed rate monotonically and never past the stated ceiling', () => {
    const sizing = createWakeSprayBurstSizing();
    let previous = -Infinity;
    for (let drive = 0; drive <= 60; drive += 0.25) {
      sizeWakeSprayBurst(
        {
          entryDrive: drive,
          armThreshold: SPRAY_ARM_DRIVE_CALM,
          entrySpeedMps: 3,
          relativeFlowMps: 4,
          seaMask: 0,
        },
        sizing,
      );
      expect(sizing.dropletsPerSecond).toBeGreaterThanOrEqual(previous);
      previous = sizing.dropletsPerSecond;
      expect(sizing.strength).toBeLessThanOrEqual(1);
    }
    // The published sustained bound has to be the arithmetic of the three
    // constants that produce it, not a number written beside them.
    expect(SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX).toBeCloseTo(
      (previous * SPRAY_TEAR_MAX_SECONDS) / SPRAY_MINIMUM_INTERVAL_SECONDS,
      9,
    );
  });
});

describe('WK3 tear detector', () => {
  it('opens nothing at all while she is stopped', () => {
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    for (let frame = 0; frame < 600; frame++) {
      // A bow plunging violently: the whole region flooding and draining twice
      // a second, at an entry speed above anything the reference states record.
      rig.set(20 + 18 * Math.sin(frame * 0.2), 5);
      detector.update(rig.sources, input({ speedThroughWaterMps: 0 }));
    }
    expect(detector.eventCount).toBe(0);
    expect(detector.burst.active).toBe(false);
  });

  it('opens nothing on the first frame it ever sees', () => {
    // A whole immersed bow differenced against nothing is not an entry. Without
    // the undefined guard the ship fires a tear the instant she is created.
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    rig.set(30, 4);
    expect(detector.update(rig.sources, input())).toBe(false);
    expect(detector.eventCount).toBe(0);
  });

  it('needs one excursion, not one crossing, to count as one event', () => {
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(4, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const step = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 1.4, 3, wayGate);

    let volume = 10;
    rig.set(volume, 3);
    detector.update(rig.sources, input());

    // Chatter across the threshold: up, barely down, up again. One entry.
    for (let cycle = 0; cycle < 6; cycle++) {
      volume += step;
      rig.set(volume, 3);
      detector.update(rig.sources, input());
      volume += step * 0.92;
      rig.set(volume, 3);
      detector.update(rig.sources, input());
    }
    expect(detector.eventCount).toBe(1);
  });

  it('cannot exceed its own ceiling even with the drive pinned wide open', () => {
    // The adversarial case the round's gate is really about. The drive is held
    // at forty times the arm threshold for a minute; the rate must land exactly
    // on the ceiling and the droplets exactly on the sustained bound.
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(5, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const step = volumeStepForDrive(SPRAY_ARM_DRIVE_ROUGH * 40, 5, wayGate);

    const seconds = 60;
    const frames = seconds / DT;
    let volume = 0;
    let droplets = 0;
    for (let frame = 0; frame < frames; frame++) {
      volume += step;
      rig.set(volume, 5);
      if (
        detector.update(
          rig.sources,
          input({
            speedThroughWaterMps: 5,
            ambientWhitecapCoverage: whitecapCoverage(18),
          }),
        )
      ) {
        droplets += detector.burst.dropletCount;
      }
    }

    const ceiling = 1 / SPRAY_MINIMUM_INTERVAL_SECONDS;
    expect(detector.policy.eventCeilingPerSecond).toBeCloseTo(ceiling, 12);
    expect(detector.eventCount / seconds).toBeLessThanOrEqual(ceiling);
    // And it really is reached, so the bound is the binding constraint rather
    // than an unreachable number that happens to be true.
    expect(detector.eventCount).toBeGreaterThan(seconds * ceiling * 0.9);
    expect(droplets / seconds).toBeLessThanOrEqual(
      SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX,
    );
  });

  it('closes a tear the sea has stopped feeding, without a schedule', () => {
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(4, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const open = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 3, 3, wayGate);
    const quiet = volumeStepForDrive(
      SPRAY_ARM_DRIVE_CALM * SPRAY_RELEASE_FRACTION * 0.5,
      3,
      wayGate,
    );

    let volume = 5;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    volume += open;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    expect(detector.tearIsOpen).toBe(true);

    // The drive falls away on its own. Two frames is enough — there is no fade
    // envelope to wait out.
    volume += quiet;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    expect(detector.tearIsOpen).toBe(false);
    expect(detector.burst.active).toBe(false);
  });

  it('caps how long one tear may hold open', () => {
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(4, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const step = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 6, 3, wayGate);

    let volume = 5;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    let openFrames = 0;
    for (let frame = 0; frame < 300; frame++) {
      volume += step;
      rig.set(volume, 3);
      detector.update(rig.sources, input());
      if (detector.tearIsOpen) openFrames++;
      else break;
    }
    expect(openFrames * DT).toBeLessThanOrEqual(SPRAY_TEAR_MAX_SECONDS + DT);
  });

  it('reads the throw off the contact data, including which side is which', () => {
    // Rule 5 of the round briefing: signs are set by test, not by reasoning.
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(4, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const step = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 3, 3, wayGate);

    let volume = 5;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    volume += step;
    rig.set(volume, 3);
    expect(detector.update(rig.sources, input())).toBe(true);

    const burst = detector.burst;
    // The fixture's flow runs toward -z, so her way through the water is +z and
    // the sheet is thrown ahead of the stem, never back down the flow.
    expect(burst.alongZ).toBeCloseTo(1, 12);
    expect(burst.alongX).toBeCloseTo(0, 12);
    expect(burst.alongY).toBe(0);
    // Lift is the outward surface normal, level water here.
    expect(burst.liftY).toBeCloseTo(1, 12);
    // Spread runs starboard (x = -0.8) toward port (x = +0.8), so +spread is
    // port and its half-width is the half-beam of the cut.
    expect(burst.spreadX).toBeCloseTo(0.8, 12);
    expect(burst.originX).toBeCloseTo(0, 12);
    expect(burst.originZ).toBeCloseTo(6, 12);
    expect(burst.dropletCount).toBeGreaterThan(0);
  });

  it('scales only shed density, leaving the physical event unchanged', () => {
    const shedAt = (densityScale: number): { count: number; events: number } => {
      const rig = bowSources();
      const detector = new HullSprayEventDetector();
      const wayGate = smoothstep(
        4,
        SPRAY_WAY_ONSET_MPS,
        WAKE_POLICY_HULL_SPEED_MPS,
      );
      const step = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 3, 3, wayGate);
      let volume = 5;
      rig.set(volume, 3);
      detector.update(rig.sources, input({ densityScale }));
      volume += step;
      rig.set(volume, 3);
      detector.update(rig.sources, input({ densityScale }));
      return { count: detector.burst.dropletCount, events: detector.eventCount };
    };

    const normal = shedAt(1);
    const obvious = shedAt(3);
    expect(normal.events).toBe(1);
    expect(obvious.events).toBe(normal.events);
    expect(obvious.count).toBeGreaterThan(normal.count * 2);
  });

  it('shuts down cleanly and reproducibly through its own switch', () => {
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    const wayGate = smoothstep(4, SPRAY_WAY_ONSET_MPS, WAKE_POLICY_HULL_SPEED_MPS);
    const step = volumeStepForDrive(SPRAY_ARM_DRIVE_CALM * 3, 3, wayGate);
    let volume = 5;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    volume += step;
    rig.set(volume, 3);
    detector.update(rig.sources, input());
    expect(detector.tearIsOpen).toBe(true);

    volume += step;
    rig.set(volume, 3);
    detector.update(rig.sources, input({ enabled: false }));
    expect(detector.tearIsOpen).toBe(false);
    expect(detector.burst.active).toBe(false);
    expect(detector.burst.dropletCount).toBe(0);
  });
});

describe('WK3 event rate against the real contact model', () => {
  const timing = { warmupSeconds: 12, measurementSeconds: 24 };

  /**
   * The gate WK0-F1 exists for.
   *
   * Not calm — `CURRENT_MODERATE`, the state WK0 proved can false-fire an
   * emitter keyed to entry speed. A run that produces one tear here is a
   * regression however good it looks on the water.
   */
  it('fires nothing at anchor in CURRENT_MODERATE', () => {
    const measured = runWakeContactCase(
      {
        name: 'ANCHOR',
        seaStateName: 'CURRENT_MODERATE',
        speedMps: 0,
        leewayDeg: 0,
      },
      timing,
    );
    expect(measured.sprayEvents.wayGate).toBe(0);
    expect(measured.sprayEvents.tears).toBe(0);
    expect(measured.sprayEvents.dropletsShed).toBe(0);
    // And the bow genuinely was working while nothing fired — otherwise this
    // test would pass on a becalmed sea and prove nothing.
    expect(measured.sprayEvents.peakBowImmersionRateM3PerSec).toBeGreaterThan(5);
    expect(measured.entrySpeeds.bow.p95Mps ?? 0).toBeGreaterThan(0.3);
  });

  it('fires nothing worth drawing on a glassy swell under way', () => {
    const sea = findSeaState('GLASSY_LONG_SWELL');
    // WX2 renamed this: the preset's own wind is the wind that GREW the sea.
    expect(sea.generatingWind.speedMps).toBeLessThan(2);
    const measured = runWakeContactCase(
      {
        name: 'GLASSY',
        seaStateName: 'GLASSY_LONG_SWELL',
        speedMps: 1.05,
        leewayDeg: 1,
      },
      timing,
    );
    expect(measured.sprayEvents.tears).toBe(0);
  });

  it('stays inside its ceiling in the storm at speed', () => {
    const measured = runWakeContactCase(
      {
        name: 'SOUTHERN',
        seaStateName: 'SOUTHERN_OCEAN_ROUGH',
        speedMps: 5.4,
        leewayDeg: 1.3,
      },
      timing,
    );
    expect(measured.sprayEvents.seaMask).toBeCloseTo(1, 6);
    expect(measured.sprayEvents.tearsPerSecond).toBeLessThanOrEqual(
      measured.sprayEvents.ceilingPerSecond,
    );
    expect(measured.sprayEvents.dropletsPerSecond).toBeLessThanOrEqual(
      SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX,
    );
    // Punctuation, not a fountain: the raised threshold has to leave the rate
    // in the same band as ordinary sailing rather than an order above it.
    expect(measured.sprayEvents.tearsPerSecond).toBeLessThan(0.5);
  });

  it('produces the same trace twice from the same seed and sea', () => {
    const config = {
      name: 'DETERMINISM',
      seaStateName: 'CURRENT_MODERATE',
      speedMps: 3.7,
      leewayDeg: 1.2,
    };
    const first = runWakeContactCase(config, timing);
    const second = runWakeContactCase(config, timing);
    expect(second.sprayEvents).toEqual(first.sprayEvents);
  });

  it('never writes to the contact graph it reads', () => {
    // The thread's standing constraint, asserted rather than assumed. The
    // detector holds `WakeSources`, which holds the live contact views; a
    // frame of it must leave every one of their numbers exactly as physics
    // left them.
    const rig = bowSources();
    const detector = new HullSprayEventDetector();
    rig.set(20, 3);
    const before = JSON.stringify(rig.sources.regions);
    const bowEntryBefore = JSON.stringify(rig.sources.bowEntry);
    for (let frame = 0; frame < 20; frame++) {
      detector.update(rig.sources, input());
    }
    expect(JSON.stringify(rig.sources.regions)).toBe(before);
    expect(JSON.stringify(rig.sources.bowEntry)).toBe(bowEntryBefore);
  });
});
