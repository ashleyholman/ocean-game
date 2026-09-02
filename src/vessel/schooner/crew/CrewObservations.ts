import type { BuoyantBody } from '../../BuoyantBody';
import { TILLER_LENGTH, TILLER_RISE, RUDDER_STOCK_Z } from '../deckFittings';
import {
  SCHOONER_RESISTANCE_GEOMETRY,
  type SchoonerResistanceResult,
} from '../SchoonerResistance';
import { windAngleOffBowDeg } from '../../../world/WorldWind';
import type { SailName } from '../rig';
import {
  SAIL_AERO_COEFFICIENTS,
  SAIL_AERO_GEOMETRY,
  type PerSailForce,
  type SailAeroResult,
} from '../sailAero';
import {
  CompassInstrument,
  signedAngleDifferenceDeg,
  wrap360,
  type CompassInstrumentReadout,
} from './CompassInstrument';
import {
  COMPETENT_HUMAN_OPERATOR_PROFILE,
  createHumanRandomStream,
  type HumanRandomStream,
} from './HumanOperator';

const RAD_TO_DEG = 180 / Math.PI;

/** Human visual attention, not an exclusive switch for bodily/tiller senses. */
export type HelmFocus =
  | 'looking-ahead'
  | 'checking-compass'
  | 'watching-response'
  | 'checking-sails-wind';

export type SwingDirection = 'port' | 'steady' | 'starboard';
export type SwingStrength = 'none' | 'hint' | 'clear' | 'fast';

export interface PerceivedCompassCue {
  /** A delayed, quantised reading of the card, never vessel truth. */
  readingDeg: number | null;
  ageSeconds: number;
  confidence: 'unacquired' | 'focused' | 'remembered' | 'uncertain';
  trend: SwingDirection;
}

export interface ShipHeadCue {
  /** Direction of bow motion against the horizon; no absolute heading. */
  swing: SwingDirection;
  strength: SwingStrength;
}

export interface WindAndSailCue {
  /**
   * The side the wind is felt **from** — the cheek it is on, not the side the
   * booms lie. Derived from the apparent wind itself rather than from the
   * sails' angle of attack: a hand knows which cheek is cold before he looks
   * up. Pinned in `ship-sailing-crew.test.ts` against the beam-reach fixture
   * that `ship-sailing-aero.test.ts` fixes the force signs on.
   */
  side: 'port' | 'starboard' | 'unclear';
  strength: 'calm' | 'light' | 'working' | 'strong';
  cloth: 'drawing' | 'trembling' | 'luffing';
  /**
   * The dogvane, read coarsely: how far off the bow the wind is felt to lie,
   * 0° dead ahead through 180° dead astern, unsigned — `side` carries which
   * cheek. Null until the vane has been looked at.
   *
   * This is an instrument reading with its own lag, quantisation and noise,
   * exactly as the compass card is. It is never the mathematical apparent-wind
   * angle: `CHECKING_SAILS_WIND` buys ~5° of resolution, and everything else
   * is a peripheral glance worth ~15°.
   */
  angleOffBowDeg: number | null;
  angleAgeSeconds: number;
}

export interface BodyMotionCue {
  swing: SwingDirection;
  heelWeight: 'level' | 'noticeable-port' | 'noticeable-starboard' | 'hard-port' | 'hard-starboard';
}

/**
 * What one hand at one sheet can tell about his own sail.
 *
 * Deliberately absent: the sail's angle of attack, its force, the physics
 * `luffing` boolean, the vessel's heel in degrees, and any notion of the ideal
 * trim for this wind. A trimmer sees his own cloth, feels his own sheet, and
 * feels the ship under him — nothing else.
 */
export interface SailTrimObservation {
  readonly elapsedSeconds: number;
  /** Whether this station's sail is even up. Furled cloth needs no trimmer. */
  readonly working: boolean;
  /**
   * What the cloth is doing, delayed and filtered — the shake he has actually
   * had time to see, not the instant the physics flag flipped.
   */
  readonly cloth: 'drawing' | 'soft' | 'trembling' | 'shaking';
  /**
   * How unsettled the cloth has been lately, in seconds of accumulated
   * misbehaviour — not a stopwatch that zeroes the instant it draws again.
   *
   * A luff that comes and goes is still a luff, and a hand watching one
   * remembers the last minute rather than the last frame. It builds while the
   * cloth misbehaves and fades more slowly than it builds, so intermittent
   * shivering accumulates instead of being erased by every good moment.
   */
  readonly unsettledSeconds: number;
  /**
   * Coarse fullness: is the sail standing well, stalled dead and lifeless
   * (sheeted too flat for this wind), or plainly starved of wind.
   */
  readonly fullness: 'stalled' | 'full' | 'soft' | 'empty';
  /** Coarse load in the sheet; the hand knows heavy from light, not newtons. */
  readonly sheetLoad: 'slack' | 'light' | 'working' | 'hard';
  /** Sustained bodily sense that she is carrying too much, not a heel number. */
  readonly overpressed: boolean;
  /** Which cheek the wind is on, as the helm feels it. */
  readonly windSide: 'port' | 'starboard' | 'unclear';
}

export interface TillerLoadCue {
  /** Coarsely perceived hand force; positive resists positive/port helm. */
  signedHandForceN: number;
  direction: 'port-helm' | 'starboard-helm' | 'neutral';
  weight: 'light' | 'working' | 'heavy';
  trend: 'loading' | 'easing' | 'steady';
}

/**
 * The complete public input to the helmsman. Deliberately absent: true vessel
 * heading, yaw/roll rates, mathematical apparent-wind angle, exact heel, sail
 * AoA and raw physics luff flags.
 */
export interface HelmObservation {
  readonly elapsedSeconds: number;
  readonly focus: HelmFocus;
  readonly compass: PerceivedCompassCue;
  readonly shipHead: ShipHeadCue;
  readonly windAndSails: WindAndSailCue;
  readonly bodyMotion: BodyMotionCue;
  readonly tillerLoad: TillerLoadCue;
}

export interface SailingCrewSensorOptions {
  seed: number;
  /** Exact truth conversion stays at this sensor boundary. */
  headingDegForModelYaw(modelYawRad: number): number;
  /** The operator knows the ordered tiller position; this is not vessel truth. */
  rudderTargetDeg(): number;
  /** Latest aero truth is reduced to coarse local sail/wind cues here. */
  sailAero(): Readonly<SailAeroResult>;
  /** Attention belongs to the operator; precision follows it here. */
  focus(): HelmFocus;
}

export interface SailingCrewSensorReadout {
  readonly elapsedSeconds: number;
  readonly compass: Readonly<CompassInstrumentReadout>;
  readonly helmObservation: Readonly<HelmObservation>;
  /** Developer presentation only. Never passed to `Helmsman`. */
  readonly devTruth: {
    headingDeg: number;
    rudderActualDeg: number;
    rudderTargetDeg: number;
    tillerHandForceN: number;
  };
}

/**
 * Area-weighted fore/aft centre of the one canonical rudder blade.
 *
 * The resistance geometry is itself derived from `backbone.ts`; measuring its
 * area centroid from the canonical stock gives the hinge arm without drawing
 * or guessing a second blade for feedback.
 */
function rudderHingeArmM(): number {
  let area = 0;
  let areaZ = 0;
  for (const station of SCHOONER_RESISTANCE_GEOMETRY.stations) {
    area += station.rudderLateralAreaM2;
    areaZ += station.rudderLateralAreaM2 * station.z;
  }
  return area > 0 ? areaZ / area - RUDDER_STOCK_Z : 0;
}

export const RUDDER_HINGE_ARM_M = rudderHingeArmM();

/**
 * Signed force at the hand needed to oppose the evaluated water load.
 * Sensory output only: this function never writes a force back to the vessel.
 */
export function tillerHandForceN(
  resistance: Readonly<SchoonerResistanceResult>,
): number {
  const lateralBladeForceN =
    resistance.rudderLateralForceN + resistance.rudderDeflectionForceXN;
  const waterTorqueAboutStockNm = RUDDER_HINGE_ARM_M * lateralBladeForceN;
  const effectiveTillerLengthM = Math.max(
    TILLER_LENGTH * Math.cos(TILLER_RISE),
    1e-6,
  );
  // The hand supplies the reaction opposing the water torque. With headway,
  // positive helm produces a positive resisting cue; sternway reverses it.
  return -waterTorqueAboutStockNm / effectiveTillerLengthM;
}

/**
 * Where a hand stops noticing that his sail has lost power.
 *
 * Derived from the aero's own stall curve rather than picked: past the lift
 * peak, `sailLiftCoefficient` falls along a half-cosine, and this is the angle
 * at which it has given up this fraction of CLmax. A sail that far over is
 * sheeted too flat for the wind she is on — the hand's answer is to ease.
 * Provisional in the same sense the operator profile is: a feel threshold,
 * placed on a real curve so it moves when the curve does.
 */
const STALL_NOTICE_CL_FRACTION = 0.85;
const STALL_NOTICE_AOA_DEG = (() => {
  const { aoaPeakDeg, stallFloor } = SAIL_AERO_COEFFICIENTS;
  const mid = (1 + stallFloor) / 2;
  const half = (1 - stallFloor) / 2;
  const past = Math.acos(
    clamp((STALL_NOTICE_CL_FRACTION - mid) / half, -1, 1),
  ) / Math.PI;
  return aoaPeakDeg + past * (90 - aoaPeakDeg);
})();

/**
 * Sustained heel that reads as "she is carrying too much".
 *
 * S2 gated steady heel under full sail at 12 m/s into the 15–25° band, so
 * ordinary working heel is inside it and the sense of being overpressed
 * belongs above it. Hysteresis because a man does not change his mind about
 * this every time a wave passes under her.
 */
const OVERPRESSED_ONSET_DEG = 22;
const OVERPRESSED_RELEASE_DEG = 17;
/** How long she must lie over before it counts as a settled state. */
const OVERPRESSED_SUSTAIN_SECONDS = 4;

/**
 * How fast the memory of a shivering luff fades once the cloth settles.
 *
 * Slower than it builds, deliberately: a sail that shakes for a second in
 * every four is a sail that wants hardening, and a stopwatch that zeroed on
 * the first good moment would never say so.
 */
const UNSETTLED_FADE_RATE = 0.4;
/** No hand carries more than this much grievance about one sail. */
const UNSETTLED_MEMORY_CAP_SECONDS = 8;

/** Sheet load bands, newtons per square metre of the hand's own cloth. */
const SHEET_LOAD_BANDS = Object.freeze({
  slack: 4,
  light: 18,
  working: 55,
});

/**
 * One sail's worth of perception, with its own filters, sampling cadence and
 * random stream. Adding a station cannot disturb another station's draws.
 */
class SailStationPerception {
  private readonly random: HumanRandomStream;
  private filteredLuff = 0;
  private filteredAoaDeg = 0;
  private filteredLoadNPerM2 = 0;
  private unsettledSeconds = 0;
  private nextSampleAt = 0;
  private perceivedLuff = 0;
  private perceivedAoaDeg = 0;
  private perceivedLoadNPerM2 = 0;

  readonly observation: MutableSailTrimObservation = {
    elapsedSeconds: 0,
    working: false,
    cloth: 'drawing',
    unsettledSeconds: 0,
    fullness: 'empty',
    sheetLoad: 'slack',
    overpressed: false,
    windSide: 'unclear',
  };

  constructor(
    readonly sail: SailName,
    seed: number,
  ) {
    this.random = createHumanRandomStream(seed, sail, 'perception');
  }

  advance(
    stepSeconds: number,
    elapsedSeconds: number,
    force: Readonly<PerSailForce>,
    overpressed: boolean,
    windSide: WindAndSailCue['side'],
  ): void {
    const observation = this.observation;
    observation.elapsedSeconds = elapsedSeconds;
    observation.overpressed = overpressed;
    observation.windSide = windSide;
    if (!force.active) {
      this.filteredLuff = 0;
      this.filteredAoaDeg = 0;
      this.filteredLoadNPerM2 = 0;
      this.unsettledSeconds = 0;
      observation.working = false;
      observation.cloth = 'drawing';
      observation.unsettledSeconds = 0;
      observation.fullness = 'empty';
      observation.sheetLoad = 'slack';
      return;
    }
    observation.working = true;

    // Cloth is watched, so it filters slowly: a shake has to persist before a
    // hand will swear to it. The eye is quicker than the compass and slower
    // than the physics flag it never sees.
    const clothBlend = 1 - Math.exp(-stepSeconds / 0.55);
    this.filteredLuff += ((force.luffing ? 1 : 0) - this.filteredLuff) * clothBlend;
    const shapeBlend = 1 - Math.exp(-stepSeconds / 0.8);
    this.filteredAoaDeg += (force.aoaDeg - this.filteredAoaDeg) * shapeBlend;
    const loadNPerM2 =
      force.areaM2 > 1e-6
        ? Math.hypot(force.forceModelXN, force.forceModelYN, force.forceModelZN) /
          force.areaM2
        : 0;
    const loadBlend = 1 - Math.exp(-stepSeconds / 0.4);
    this.filteredLoadNPerM2 += (loadNPerM2 - this.filteredLoadNPerM2) * loadBlend;

    if (elapsedSeconds >= this.nextSampleAt) {
      const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.perception;
      this.perceivedLuff = clamp(
        this.filteredLuff + this.random.normal() * profile.clothNoiseStd,
        0,
        1,
      );
      this.perceivedAoaDeg =
        this.filteredAoaDeg + this.random.normal() * profile.sailShapeNoiseStdDeg;
      this.perceivedLoadNPerM2 = Math.max(
        0,
        this.filteredLoadNPerM2 +
          this.random.normal() * profile.sheetLoadNoiseStdNPerM2,
      );
      this.nextSampleAt =
        elapsedSeconds + this.random.between(profile.sailSampleSeconds);
    }

    const cloth =
      this.perceivedLuff > 0.6
        ? 'shaking'
        : this.perceivedLuff > 0.28
          ? 'trembling'
          : this.perceivedLuff > 0.08
            ? 'soft'
            : 'drawing';
    observation.cloth = cloth;
    this.unsettledSeconds = clamp(
      this.unsettledSeconds +
        (cloth === 'drawing'
          ? -stepSeconds * UNSETTLED_FADE_RATE
          : stepSeconds),
      0,
      UNSETTLED_MEMORY_CAP_SECONDS,
    );
    observation.unsettledSeconds = this.unsettledSeconds;

    const { luffEndDeg, luffBandDeg } = SAIL_AERO_COEFFICIENTS;
    const aoa = this.perceivedAoaDeg;
    observation.fullness =
      aoa <= luffEndDeg - luffBandDeg
        ? 'empty'
        : aoa < luffEndDeg
          ? 'soft'
          : aoa >= STALL_NOTICE_AOA_DEG
            ? 'stalled'
            : 'full';
    const load = this.perceivedLoadNPerM2;
    observation.sheetLoad =
      load < SHEET_LOAD_BANDS.slack
        ? 'slack'
        : load < SHEET_LOAD_BANDS.light
          ? 'light'
          : load < SHEET_LOAD_BANDS.working
            ? 'working'
            : 'hard';
  }

  reset(): void {
    this.filteredLuff = 0;
    this.filteredAoaDeg = 0;
    this.filteredLoadNPerM2 = 0;
    this.unsettledSeconds = 0;
    this.nextSampleAt = 0;
    this.perceivedLuff = 0;
    this.perceivedAoaDeg = 0;
    this.perceivedLoadNPerM2 = 0;
    this.observation.elapsedSeconds = 0;
    this.observation.working = false;
    this.observation.cloth = 'drawing';
    this.observation.unsettledSeconds = 0;
    this.observation.fullness = 'empty';
    this.observation.sheetLoad = 'slack';
    this.observation.overpressed = false;
    this.observation.windSide = 'unclear';
    this.random.reset();
  }
}

/** Fixed-capacity history of the physical card's continuous angle. */
class CompassCardHistory {
  private readonly times: Float64Array;
  private readonly angles: Float64Array;
  private count = 0;
  private cursor = 0;

  constructor(capacity: number) {
    this.times = new Float64Array(capacity);
    this.angles = new Float64Array(capacity);
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
  }

  push(timeSeconds: number, unwrappedHeadingDeg: number): void {
    this.times[this.cursor] = timeSeconds;
    this.angles[this.cursor] = unwrappedHeadingDeg;
    this.cursor = (this.cursor + 1) % this.times.length;
    this.count = Math.min(this.count + 1, this.times.length);
  }

  sample(timeSeconds: number): number | null {
    if (this.count === 0) return null;
    let newerIndex = (this.cursor - 1 + this.times.length) % this.times.length;
    let newerTime = this.times[newerIndex];
    let newerAngle = this.angles[newerIndex];
    if (timeSeconds >= newerTime) return newerAngle;
    for (let age = 1; age < this.count; age++) {
      const olderIndex =
        (this.cursor - 1 - age + this.times.length * 2) % this.times.length;
      const olderTime = this.times[olderIndex];
      const olderAngle = this.angles[olderIndex];
      if (timeSeconds >= olderTime) {
        const span = newerTime - olderTime;
        const blend = span > 0 ? (timeSeconds - olderTime) / span : 0;
        return olderAngle + (newerAngle - olderAngle) * blend;
      }
      newerIndex = olderIndex;
      newerTime = olderTime;
      newerAngle = olderAngle;
    }
    return newerAngle;
  }
}

/**
 * Truth → physical instrument/bodily cue → perceived observation boundary.
 *
 * This class is the only S5 production object handed exact vessel and aero
 * telemetry. Its public operator surface is the stable `helmObservation`
 * object above. `Helmsman.ts` imports that type and nothing from physics.
 */
export class SailingCrewSensors {
  readonly compass = new CompassInstrument();
  private readonly random: HumanRandomStream;
  private readonly vaneRandom: HumanRandomStream;
  private readonly history = new CompassCardHistory(1024);
  private readonly stations = new Map<SailName, SailStationPerception>();
  private windVaneAcquiredAt = Infinity;
  private nextWindVaneSampleAt = 0;
  private windVaneDelaySeconds = 0.25;
  private readonly vaneHistory = new CompassCardHistory(512);
  private perceivedWindAngleDeg: number | null = null;
  private perceivedWindAngleAt = -Infinity;
  private perceivedWindSide: WindAndSailCue['side'] = 'unclear';
  private overpressedSeconds = 0;
  private overpressedValue = false;
  private elapsed = 0;
  private initialized = false;
  private lastFocus: HelmFocus = 'looking-ahead';
  private compassAcquiredAt = Infinity;
  private compassDelaySeconds = 0.25;
  private nextCompassSampleAt = Infinity;
  private nextHeadSampleAt = 0;
  private nextTillerSampleAt = 0;
  private perceivedCompassDeg: number | null = null;
  private perceivedCompassAt = -Infinity;
  private compassTrend: SwingDirection = 'steady';
  private filteredHeadRateDegPerS = 0;
  private perceivedHeadRateDegPerS = 0;
  private filteredTillerForceN = 0;
  private perceivedTillerForceN = 0;
  private previousTillerMagnitudeN = 0;
  private filteredLuffEvidence = 0;
  private filteredSailWindMps = 0;
  private devHeadingDeg = 0;
  private devRudderActualDeg = 0;
  private devTillerHandForceN = 0;

  private readonly observation: HelmObservation = {
    elapsedSeconds: 0,
    focus: 'looking-ahead',
    compass: {
      readingDeg: null,
      ageSeconds: Infinity,
      confidence: 'unacquired',
      trend: 'steady',
    },
    shipHead: { swing: 'steady', strength: 'none' },
    windAndSails: {
      side: 'unclear',
      strength: 'calm',
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

  constructor(private readonly options: SailingCrewSensorOptions) {
    this.random = createHumanRandomStream(
      options.seed,
      'helm',
      'perception',
    );
    // The vane gets a stream of its own rather than sharing the helm's.
    // Sharing it made every compass and tiller draw after the first glance
    // land differently, which moved the accepted S5 helm trace without
    // changing a line of helm code — the exact failure the handover's
    // stream-per-station rule exists to prevent, caught by the centring gate.
    this.vaneRandom = createHumanRandomStream(
      options.seed,
      'dogvane',
      'perception',
    );
    // Every sail gets its perception from the first substep, whether or not
    // anyone has asked for it yet: a station that began filtering the moment
    // someone first looked would make the trace depend on who looked when.
    for (const geometry of SAIL_AERO_GEOMETRY) {
      this.stations.set(
        geometry.name,
        new SailStationPerception(geometry.name, options.seed),
      );
    }
  }

  get helmObservation(): Readonly<HelmObservation> {
    return this.observation;
  }

  /**
   * One station's view of its own sail. Stable object, refreshed in place, so
   * a trimmer holds a reference rather than allocating every substep.
   */
  sailObservation(sail: SailName): Readonly<SailTrimObservation> {
    const station = this.stations.get(sail);
    if (!station) {
      throw new RangeError(`no sail station perception for ${sail}`);
    }
    return station.observation;
  }

  /**
   * Signature intentionally matches the dynamics' fixed-step truth-observer
   * seam structurally, without importing any human policy into that module.
   */
  observeSubstep(
    stepSeconds: number,
    body: BuoyantBody,
    modelYawRad: number,
    yawRateRadPerSecond: number,
    _velocityWorldX: number,
    _velocityWorldZ: number,
    resistance: Readonly<SchoonerResistanceResult>,
  ): void {
    assertPositiveFinite(stepSeconds, 'crew sensor step');
    const headingDeg = wrap360(
      this.options.headingDegForModelYaw(modelYawRad),
    );
    const focus = this.options.focus();
    if (!this.initialized) {
      this.compass.reset(headingDeg);
      this.history.clear();
      this.initialized = true;
      this.lastFocus = focus;
      this.enterFocus(focus);
    }

    this.compass.advance(stepSeconds, {
      trueHeadingDeg: headingDeg,
      rollRateRadPerSecond: body.rollRate,
    });
    this.elapsed += stepSeconds;
    this.history.push(
      this.elapsed,
      this.compass.indicatedUnwrappedHeadingDeg,
    );
    if (focus !== this.lastFocus) {
      this.lastFocus = focus;
      this.enterFocus(focus);
    }

    const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.perception;
    const headBlend = 1 - Math.exp(-stepSeconds / 0.24);
    // Model-positive yaw is bow-to-port; compass heading increases to
    // starboard. Store the perceptual rate in compass-heading sense so the
    // coarse visual cue and the remembered card trend share one sign.
    this.filteredHeadRateDegPerS +=
      (-yawRateRadPerSecond * RAD_TO_DEG - this.filteredHeadRateDegPerS) *
      headBlend;

    const aero = this.options.sailAero();
    let activeSails = 0;
    let rawLuffEvidence = 0;
    let apparentSum = 0;
    for (const sail of aero.perSail) {
      if (!sail.active) continue;
      activeSails++;
      rawLuffEvidence += sail.luffing ? 1 : 0;
      apparentSum += sail.apparentSpeedMps;
    }
    rawLuffEvidence = activeSails > 0 ? rawLuffEvidence / activeSails : 0;
    const rawApparentMps = activeSails > 0 ? apparentSum / activeSails : 0;
    const sailBlend = 1 - Math.exp(-stepSeconds / 0.65);
    this.filteredLuffEvidence +=
      (rawLuffEvidence - this.filteredLuffEvidence) * sailBlend;
    this.filteredSailWindMps +=
      (rawApparentMps - this.filteredSailWindMps) * sailBlend;

    const rawTillerForceN = tillerHandForceN(resistance);
    const tillerBlend = 1 - Math.exp(-stepSeconds / 0.22);
    this.filteredTillerForceN +=
      (rawTillerForceN - this.filteredTillerForceN) * tillerBlend;

    if (this.elapsed >= this.nextHeadSampleAt) {
      const focused =
        focus === 'looking-ahead' || focus === 'watching-response';
      const noiseStd = focused
        ? profile.headFocusedNoiseStdDegPerS
        : profile.headPeripheralNoiseStdDegPerS;
      this.perceivedHeadRateDegPerS =
        this.filteredHeadRateDegPerS + this.random.normal() * noiseStd;
      const range = focused
        ? profile.headFocusedSampleSeconds
        : profile.headPeripheralSampleSeconds;
      this.nextHeadSampleAt = this.elapsed + this.random.between(range);
    }

    if (
      focus === 'checking-compass' &&
      this.elapsed >= this.compassAcquiredAt &&
      this.elapsed >= this.nextCompassSampleAt
    ) {
      const delayed = this.history.sample(
        this.elapsed - this.compassDelaySeconds,
      );
      if (delayed !== null) {
        const resolution = profile.compassFocusedResolutionDeg;
        const perceived = wrap360(
          Math.round(
            (delayed +
              this.random.normal() * profile.compassFocusedNoiseStdDeg) /
              resolution,
          ) * resolution,
        );
        if (this.perceivedCompassDeg !== null) {
          const delta = signedAngleDifferenceDeg(
            perceived,
            this.perceivedCompassDeg,
          );
          this.compassTrend =
            delta > 0.18 ? 'starboard' : delta < -0.18 ? 'port' : 'steady';
        }
        this.perceivedCompassDeg = perceived;
        this.perceivedCompassAt = this.elapsed;
      }
      this.nextCompassSampleAt =
        this.elapsed + this.random.between(profile.compassFocusedSampleSeconds);
    }

    if (this.elapsed >= this.nextTillerSampleAt) {
      const noisy =
        this.filteredTillerForceN +
        this.random.normal() * profile.tillerNoiseStdN;
      this.perceivedTillerForceN = Math.round(noisy / 5) * 5;
      this.nextTillerSampleAt =
        this.elapsed + this.random.between(profile.tillerSampleSeconds);
    }

    // The dogvane. Its true bearing is pushed into a history and read back
    // late, so a glance sees where the wind was a moment ago — the same
    // treatment the compass card gets, for the same reason.
    const bearing = apparentWindBearing(aero);
    if (bearing) {
      this.vaneHistory.push(this.elapsed, Math.abs(bearing.signedDeg));
      this.sampleWindVane(focus, profile);
      this.perceivedWindSide = bearing.side;
    }

    const rollDeg = body.roll * RAD_TO_DEG;
    // Being overpressed is a settled state, not an instant: she has to lie
    // over and stay there before a hand will call her overpowered.
    const heeledHard =
      Math.abs(rollDeg) >=
      (this.overpressedValue ? OVERPRESSED_RELEASE_DEG : OVERPRESSED_ONSET_DEG);
    this.overpressedSeconds = heeledHard
      ? this.overpressedSeconds + stepSeconds
      : 0;
    if (this.overpressedSeconds >= OVERPRESSED_SUSTAIN_SECONDS) {
      this.overpressedValue = true;
    } else if (!heeledHard) {
      this.overpressedValue = false;
    }

    for (let i = 0; i < aero.perSail.length; i++) {
      const force = aero.perSail[i];
      const station = this.stations.get(force.name);
      if (!station) continue;
      station.advance(
        stepSeconds,
        this.elapsed,
        force,
        this.overpressedValue,
        this.perceivedWindSide,
      );
    }

    this.refreshObservation(focus, rollDeg);
    this.devHeadingDeg = headingDeg;
    this.devRudderActualDeg = resistance.rudderAngleRad * RAD_TO_DEG;
    this.devTillerHandForceN = rawTillerForceN;
  }

  reset(): void {
    this.elapsed = 0;
    this.initialized = false;
    this.compass.reset();
    this.history.clear();
    this.lastFocus = 'looking-ahead';
    this.compassAcquiredAt = Infinity;
    this.compassDelaySeconds = 0.25;
    this.nextCompassSampleAt = Infinity;
    this.nextHeadSampleAt = 0;
    this.nextTillerSampleAt = 0;
    this.perceivedCompassDeg = null;
    this.perceivedCompassAt = -Infinity;
    this.compassTrend = 'steady';
    this.filteredHeadRateDegPerS = 0;
    this.perceivedHeadRateDegPerS = 0;
    this.filteredTillerForceN = 0;
    this.perceivedTillerForceN = 0;
    this.previousTillerMagnitudeN = 0;
    this.filteredLuffEvidence = 0;
    this.filteredSailWindMps = 0;
    this.vaneHistory.clear();
    this.windVaneAcquiredAt = Infinity;
    this.nextWindVaneSampleAt = 0;
    this.windVaneDelaySeconds = 0.25;
    this.perceivedWindAngleDeg = null;
    this.perceivedWindAngleAt = -Infinity;
    this.perceivedWindSide = 'unclear';
    this.overpressedSeconds = 0;
    this.overpressedValue = false;
    this.vaneRandom.reset();
    for (const station of this.stations.values()) station.reset();
    this.devHeadingDeg = 0;
    this.devRudderActualDeg = 0;
    this.devTillerHandForceN = 0;
    (this.observation as MutableHelmObservation).elapsedSeconds = 0;
    (this.observation as MutableHelmObservation).focus = 'looking-ahead';
    this.observation.compass.readingDeg = null;
    this.observation.compass.ageSeconds = Infinity;
    this.observation.compass.confidence = 'unacquired';
    this.observation.compass.trend = 'steady';
    this.observation.shipHead.swing = 'steady';
    this.observation.shipHead.strength = 'none';
    this.observation.windAndSails.side = 'unclear';
    this.observation.windAndSails.strength = 'calm';
    this.observation.windAndSails.cloth = 'drawing';
    this.observation.windAndSails.angleOffBowDeg = null;
    this.observation.windAndSails.angleAgeSeconds = Infinity;
    this.observation.bodyMotion.swing = 'steady';
    this.observation.bodyMotion.heelWeight = 'level';
    this.observation.tillerLoad.signedHandForceN = 0;
    this.observation.tillerLoad.direction = 'neutral';
    this.observation.tillerLoad.weight = 'light';
    this.observation.tillerLoad.trend = 'steady';
    this.random.reset();
  }

  readout(): SailingCrewSensorReadout {
    return {
      elapsedSeconds: this.elapsed,
      compass: this.compass.readout,
      helmObservation: this.observation,
      devTruth: {
        headingDeg: this.devHeadingDeg,
        rudderActualDeg: this.devRudderActualDeg,
        rudderTargetDeg: this.options.rudderTargetDeg(),
        tillerHandForceN: this.devTillerHandForceN,
      },
    };
  }

  private enterFocus(focus: HelmFocus): void {
    const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.perception;
    if (focus === 'checking-compass') {
      this.compassAcquiredAt =
        this.elapsed + this.random.between(profile.compassAcquisitionSeconds);
      this.compassDelaySeconds = this.random.between(
        profile.compassDelaySeconds,
      );
      this.nextCompassSampleAt = this.compassAcquiredAt;
    } else {
      this.compassAcquiredAt = Infinity;
      this.nextCompassSampleAt = Infinity;
    }
    this.nextHeadSampleAt = this.elapsed;
  }

  /**
   * A glance at the vane, or the memory of the last one.
   *
   * Looking at the sails and wind buys resolution and a fresh reading; from
   * any other focus the vane is in the corner of the eye, read coarsely and
   * seldom. Either way it is quantised: nobody reads a degree off a stick.
   */
  private sampleWindVane(
    focus: HelmFocus,
    profile: typeof COMPETENT_HUMAN_OPERATOR_PROFILE.perception,
  ): void {
    const focused = focus === 'checking-sails-wind';
    if (focused && this.windVaneAcquiredAt === Infinity) {
      this.windVaneAcquiredAt =
        this.elapsed + this.vaneRandom.between(profile.windVaneAcquisitionSeconds);
      this.windVaneDelaySeconds = this.vaneRandom.between(
        profile.windVaneDelaySeconds,
      );
    } else if (!focused) {
      this.windVaneAcquiredAt = Infinity;
    }
    if (focused && this.elapsed < this.windVaneAcquiredAt) return;
    if (this.elapsed < this.nextWindVaneSampleAt) return;
    const delayed = this.vaneHistory.sample(
      this.elapsed - this.windVaneDelaySeconds,
    );
    if (delayed === null) return;
    const resolution = focused
      ? profile.windVaneFocusedResolutionDeg
      : profile.windVanePeripheralResolutionDeg;
    const noiseStd = focused
      ? profile.windVaneFocusedNoiseStdDeg
      : profile.windVanePeripheralNoiseStdDeg;
    this.perceivedWindAngleDeg = clamp(
      Math.round((delayed + this.vaneRandom.normal() * noiseStd) / resolution) *
        resolution,
      0,
      180,
    );
    this.perceivedWindAngleAt = this.elapsed;
    const range = focused
      ? profile.windVaneSampleSeconds
      : profile.sailSampleSeconds;
    this.nextWindVaneSampleAt = this.elapsed + this.vaneRandom.between(range);
  }

  private refreshObservation(focus: HelmFocus, rollDeg: number): void {
    const compassAge =
      this.perceivedCompassDeg === null
        ? Infinity
        : Math.max(0, this.elapsed - this.perceivedCompassAt);
    const compassConfidence =
      this.perceivedCompassDeg === null
        ? 'unacquired'
        : focus === 'checking-compass' && this.elapsed >= this.compassAcquiredAt
          ? 'focused'
          : compassAge > 5
            ? 'uncertain'
            : 'remembered';
    const swing = swingDirection(this.perceivedHeadRateDegPerS);
    const strength = swingStrength(this.perceivedHeadRateDegPerS);
    const magnitude = Math.abs(this.perceivedTillerForceN);
    const magnitudeChange = magnitude - this.previousTillerMagnitudeN;
    const tillerTrend =
      magnitudeChange > 5
        ? 'loading'
        : magnitudeChange < -5
          ? 'easing'
          : 'steady';
    this.previousTillerMagnitudeN = magnitude;

    (this.observation as MutableHelmObservation).elapsedSeconds = this.elapsed;
    (this.observation as MutableHelmObservation).focus = focus;
    this.observation.compass.readingDeg = this.perceivedCompassDeg;
    this.observation.compass.ageSeconds = compassAge;
    this.observation.compass.confidence = compassConfidence;
    this.observation.compass.trend = this.compassTrend;
    this.observation.shipHead.swing = swing;
    this.observation.shipHead.strength = strength;
    this.observation.bodyMotion.swing = swing;
    this.observation.bodyMotion.heelWeight = heelCue(rollDeg);
    this.observation.windAndSails.side = this.perceivedWindSide;
    this.observation.windAndSails.angleOffBowDeg = this.perceivedWindAngleDeg;
    this.observation.windAndSails.angleAgeSeconds =
      this.perceivedWindAngleDeg === null
        ? Infinity
        : Math.max(0, this.elapsed - this.perceivedWindAngleAt);
    this.observation.windAndSails.strength = windStrength(
      this.filteredSailWindMps,
    );
    this.observation.windAndSails.cloth =
      this.filteredLuffEvidence > 0.55
        ? 'luffing'
        : this.filteredLuffEvidence > 0.15
          ? 'trembling'
          : 'drawing';
    this.observation.tillerLoad.signedHandForceN =
      this.perceivedTillerForceN;
    this.observation.tillerLoad.direction =
      this.perceivedTillerForceN > 7
        ? 'port-helm'
        : this.perceivedTillerForceN < -7
          ? 'starboard-helm'
          : 'neutral';
    this.observation.tillerLoad.weight =
      magnitude >= 55 ? 'heavy' : magnitude >= 15 ? 'working' : 'light';
    this.observation.tillerLoad.trend = tillerTrend;
  }
}

interface MutableHelmObservation {
  elapsedSeconds: number;
  focus: HelmFocus;
}

type MutableSailTrimObservation = {
  -readonly [K in keyof SailTrimObservation]: SailTrimObservation[K];
};

function swingDirection(rateDegPerS: number): SwingDirection {
  return rateDegPerS > 0.12
    ? 'starboard'
    : rateDegPerS < -0.12
      ? 'port'
      : 'steady';
}

function swingStrength(rateDegPerS: number): SwingStrength {
  const magnitude = Math.abs(rateDegPerS);
  return magnitude >= 1.1
    ? 'fast'
    : magnitude >= 0.48
      ? 'clear'
      : magnitude >= 0.16
        ? 'hint'
        : 'none';
}

function heelCue(rollDeg: number): BodyMotionCue['heelWeight'] {
  const magnitude = Math.abs(rollDeg);
  if (magnitude < 3) return 'level';
  if (magnitude >= 13) return rollDeg > 0 ? 'hard-port' : 'hard-starboard';
  return rollDeg > 0 ? 'noticeable-port' : 'noticeable-starboard';
}

/**
 * The apparent wind's bearing off the bow, or null in a calm too stark to
 * read a vane in.
 *
 * The angle itself is the world layer's `windAngleOffBowDeg`, signed positive
 * for a wind over the port side and already pinned against the compass route
 * in `WorldWind`. The crew take the magnitude for the vane and the sign for
 * the cheek, so there is one convention for both and it cannot drift.
 */
function apparentWindBearing(
  aero: Readonly<SailAeroResult>,
): { signedDeg: number; side: WindAndSailCue['side'] } | null {
  const horizontal = Math.hypot(
    aero.hullApparentModelXMps,
    aero.hullApparentModelZMps,
  );
  if (horizontal < 0.35) return null;
  const signedDeg = windAngleOffBowDeg(
    aero.hullApparentModelXMps,
    aero.hullApparentModelZMps,
  );
  // Within a few degrees of dead ahead or dead astern there is no side to it.
  const side: WindAndSailCue['side'] =
    Math.abs(Math.sin((signedDeg * Math.PI) / 180)) < 0.08
      ? 'unclear'
      : signedDeg > 0
        ? 'port'
        : 'starboard';
  return { signedDeg, side };
}

function windStrength(speedMps: number): WindAndSailCue['strength'] {
  return speedMps < 1
    ? 'calm'
    : speedMps < 4
      ? 'light'
      : speedMps < 10
        ? 'working'
        : 'strong';
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive, got ${value}`);
  }
}

// --- the navigator's instruments ---------------------------------------------

/**
 * What the man with the chart can know.
 *
 * He is not at a sheet and not at the tiller; his instruments are the plot,
 * the binnacle, the log and his own judgement of the weather. That is a
 * different set of senses from the helmsman's, not a privileged one: the fix
 * is a few minutes old, the wind's bearing is known to about five degrees,
 * and its strength is a seaman's estimate rather than an anemometer.
 *
 * Deliberately absent, exactly as at the other stations: hull velocity, yaw
 * rate, heel, sail forces, and the mathematical apparent wind.
 */
export interface NavigatorObservation {
  readonly elapsedSeconds: number;
  /** The last fix he worked up, in radians. */
  readonly fixLatitudeRad: number;
  readonly fixLongitudeRad: number;
  readonly fixAgeSeconds: number;
  /** True bearing the wind blows *from*, degrees; null until he has judged it. */
  readonly windFromBearingDeg: number | null;
  /** His estimate of how hard it is blowing, m/s; null until judged. */
  readonly windSpeedMps: number | null;
  /** The log, read to about a tenth of a knot. */
  readonly speedThroughWaterMps: number;
  /** The card at the binnacle. */
  readonly compassHeadingDeg: number;
}

export interface NavigatorSensorOptions {
  seed: number;
  /** Exact truth conversion stays at this sensor boundary, as it does for the helm. */
  positionRad(): { readonly latitudeRad: number; readonly longitudeRad: number };
  trueWindSpeedMps(): number;
  /** True bearing the wind blows from, degrees. */
  trueWindFromBearingDeg(): number;
  speedThroughWaterMps(): number;
  /** The physical compass card — the same instrument the helmsman reads. */
  compassHeadingDeg(): number;
}

/**
 * How often he works up a position. Ordinary physics seconds, like every other
 * human interval in this layer: a fix is a task a person performs, and its
 * cost does not change because the voyage is being watched at thirty times
 * speed.
 */
const FIX_INTERVAL_SECONDS = 5;
/**
 * How long he watches the weather before his estimate of it moves.
 *
 * Long, deliberately. The decision this feeds is whether to shorten sail, and
 * a captain who reefed on a gust and shook it out in the lull would never
 * finish either job — the sail evolutions themselves cost minutes of the
 * crew's day.
 */
const WIND_JUDGEMENT_TAU_SECONDS = 75;
const WIND_ESTIMATE_INTERVAL_SECONDS = Object.freeze({ min: 12, max: 22 });
/** A seaman's estimate of wind speed is half a metre per second at best. */
const WIND_SPEED_RESOLUTION_MPS = 0.5;
const WIND_SPEED_JUDGEMENT_STD_MPS = 0.35;
/** And of its bearing, five degrees. */
const WIND_BEARING_RESOLUTION_DEG = 5;
const WIND_BEARING_JUDGEMENT_STD_DEG = 3;
const LOG_INTERVAL_SECONDS = Object.freeze({ min: 6, max: 12 });
/** The log's own reading resolution, m/s (about a tenth of a knot). */
const LOG_RESOLUTION_MPS = 0.05;

interface MutableNavigatorObservation {
  elapsedSeconds: number;
  fixLatitudeRad: number;
  fixLongitudeRad: number;
  fixAgeSeconds: number;
  windFromBearingDeg: number | null;
  windSpeedMps: number | null;
  speedThroughWaterMps: number;
  compassHeadingDeg: number;
}

/**
 * The truth-to-chart boundary. Everything the navigator is allowed to know
 * passes through here and arrives late, coarse, or both.
 */
export class NavigatorSensors {
  private readonly random: HumanRandomStream;
  private elapsed = 0;
  private filteredWindSpeedMps = 0;
  private filteredWindSinDeg = 0;
  private filteredWindCosDeg = 0;
  private initialised = false;
  private nextFixAt = 0;
  private nextWindEstimateAt = 0;
  private nextLogAt = 0;
  private fixTakenAt = 0;
  private readonly observationValue: MutableNavigatorObservation = {
    elapsedSeconds: 0,
    fixLatitudeRad: 0,
    fixLongitudeRad: 0,
    fixAgeSeconds: Infinity,
    windFromBearingDeg: null,
    windSpeedMps: null,
    speedThroughWaterMps: 0,
    compassHeadingDeg: 0,
  };

  constructor(private readonly options: NavigatorSensorOptions) {
    // Its own stream, keyed to its own station. A new sampled cue drawing from
    // an existing station's stream silently moves that station's whole
    // accepted trace — S5 lost a day to exactly that (FINDING S5-2).
    this.random = createHumanRandomStream(options.seed, 'navigator', 'perception');
  }

  get observation(): Readonly<NavigatorObservation> {
    return this.observationValue;
  }

  advance(stepSeconds: number): void {
    assertPositiveFinite(stepSeconds, 'navigator sensor step');
    this.elapsed += stepSeconds;
    const windSpeed = this.options.trueWindSpeedMps();
    const windFromDeg = this.options.trueWindFromBearingDeg();
    const sin = Math.sin((windFromDeg * Math.PI) / 180);
    const cos = Math.cos((windFromDeg * Math.PI) / 180);
    if (!this.initialised) {
      this.initialised = true;
      this.filteredWindSpeedMps = windSpeed;
      this.filteredWindSinDeg = sin;
      this.filteredWindCosDeg = cos;
    }
    const blend = 1 - Math.exp(-stepSeconds / WIND_JUDGEMENT_TAU_SECONDS);
    this.filteredWindSpeedMps +=
      (windSpeed - this.filteredWindSpeedMps) * blend;
    this.filteredWindSinDeg += (sin - this.filteredWindSinDeg) * blend;
    this.filteredWindCosDeg += (cos - this.filteredWindCosDeg) * blend;

    if (this.elapsed >= this.nextWindEstimateAt) {
      this.observationValue.windSpeedMps = Math.max(
        0,
        quantise(
          this.filteredWindSpeedMps +
            this.random.normal() * WIND_SPEED_JUDGEMENT_STD_MPS,
          WIND_SPEED_RESOLUTION_MPS,
        ),
      );
      const meanBearing =
        (Math.atan2(this.filteredWindSinDeg, this.filteredWindCosDeg) * 180) /
        Math.PI;
      this.observationValue.windFromBearingDeg = wrap360(
        quantise(
          meanBearing + this.random.normal() * WIND_BEARING_JUDGEMENT_STD_DEG,
          WIND_BEARING_RESOLUTION_DEG,
        ),
      );
      this.nextWindEstimateAt =
        this.elapsed + this.random.between(WIND_ESTIMATE_INTERVAL_SECONDS);
    }

    if (this.elapsed >= this.nextLogAt) {
      this.observationValue.speedThroughWaterMps = Math.max(
        0,
        quantise(this.options.speedThroughWaterMps(), LOG_RESOLUTION_MPS),
      );
      this.nextLogAt = this.elapsed + this.random.between(LOG_INTERVAL_SECONDS);
    }

    if (this.elapsed >= this.nextFixAt) {
      const position = this.options.positionRad();
      this.observationValue.fixLatitudeRad = position.latitudeRad;
      this.observationValue.fixLongitudeRad = position.longitudeRad;
      this.fixTakenAt = this.elapsed;
      this.nextFixAt = this.elapsed + FIX_INTERVAL_SECONDS;
    }

    this.observationValue.compassHeadingDeg = wrap360(
      this.options.compassHeadingDeg(),
    );
    this.observationValue.fixAgeSeconds = this.elapsed - this.fixTakenAt;
    this.observationValue.elapsedSeconds = this.elapsed;
  }

  reset(): void {
    this.elapsed = 0;
    this.initialised = false;
    this.filteredWindSpeedMps = 0;
    this.filteredWindSinDeg = 0;
    this.filteredWindCosDeg = 0;
    this.nextFixAt = 0;
    this.nextWindEstimateAt = 0;
    this.nextLogAt = 0;
    this.fixTakenAt = 0;
    this.observationValue.elapsedSeconds = 0;
    this.observationValue.fixLatitudeRad = 0;
    this.observationValue.fixLongitudeRad = 0;
    this.observationValue.fixAgeSeconds = Infinity;
    this.observationValue.windFromBearingDeg = null;
    this.observationValue.windSpeedMps = null;
    this.observationValue.speedThroughWaterMps = 0;
    this.observationValue.compassHeadingDeg = 0;
    this.random.reset();
  }
}

function quantise(value: number, resolution: number): number {
  return Math.round(value / resolution) * resolution;
}
