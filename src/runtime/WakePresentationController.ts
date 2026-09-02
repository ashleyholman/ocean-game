import type { OvertopEvent } from '../vessel/BuoyantBody';
import type { HullWaterContactView } from '../vessel/HullWaterContact';
import type { HorizontalVelocity } from '../vessel/VesselMotion';
import { WakeSources } from '../vessel/WakeSources';
import type { HullWetBandAppearance } from '../scene/HullWetBand';
import {
  MAX_WATERLINE_WAKE_POINTS,
  MAX_WATERLINE_WAKE_STATIONS,
  type FoamHullWakeSource,
  type FoamWaterlineWakeSource,
} from '../scene/FoamField';
import {
  type BowMoundAppearance,
  type ShipWakePatternAppearance,
  type WakeTrailAppearance,
} from '../scene/Ocean';
import {
  createWakeBowPolicyResult,
  createWakePatternPolicyResult,
  createWakeTrailPolicyResult,
  gateWakeBowAppearance,
  gateWakeTrailAppearance,
  resolveWakeBowPolicy,
  resolveWakePatternPolicy,
  resolveWakeTrailPolicy,
  type WakeBowAppearanceGains,
  type WakeBowPolicyInput,
  type WakePatternPolicyInput,
  type WakeTrailPolicyInput,
} from '../scene/wakePolicy';
import {
  resolveBowPressureFrontGeometry,
  type BowPressureFrontGeometry,
} from '../scene/bowWakeGeometry';
import {
  HullSprayEventDetector,
  type HullSprayBurst,
  type HullSprayEventInput,
} from '../scene/hullSprayEvents';

export type WakeTrailFeature =
  | 'injection'
  | 'bubbleHaze'
  | 'whitecapSuppression'
  | 'trailFoamFloor';

export type WakeBowFeature =
  | 'collar'
  | 'wetHull'
  | 'bowMound'
  /** The near-field bow pressure front. Master switch for both wave models. */
  | 'wavePattern'
  /** The far-field Kelvin wedge alone. Off by default since WK-R10. */
  | 'kelvinPattern'
  /** WK3's episodic bow-entry spray. */
  | 'entrySpray';

export interface WakeWaveField {
  invertDisplacement(
    x: number,
    z: number,
    out: { x: number; z: number },
  ): void;
}

/**
 * The wind **now**, for the two wake terms that answer to it.
 *
 * WX2 re-pointed this. It used to be a `SeaStateController`, read for
 * `state.wind.speedMps`, which before the split was the same number as the
 * world wind's mean. It is not any more, and of the two the wake wants the
 * present one: `wakePolicy`'s `windMixing = smoothstep(windSpeedMps, 4, 18)`
 * is how fast the air is tearing this frame's trail apart, which a freshening
 * breeze does immediately and a sea that is still up from yesterday's gale
 * does not do at all. The *sea's* contribution to the same policy arrives
 * separately and correctly as `ambientWhitecapCoverage`, which is the
 * developed statistic.
 *
 * Structurally satisfied by `WorldWind`.
 */
export interface WakePresentWindSource {
  readonly meanSpeedMps: number;
}

export interface WakeOceanTarget {
  setWakeTrailAppearance(appearance: Readonly<WakeTrailAppearance>): void;
  setWakeStreakTarget(x: number, z: number): void;
  setBowMoundAppearance(appearance: Readonly<BowMoundAppearance>): void;
  setShipWakePattern(appearance: Readonly<ShipWakePatternAppearance>): void;
}

export interface WakeSchoonerTarget {
  readonly yaw: number;
  updateWetHullBand(
    sources: Readonly<WakeSources>,
    appearance: Readonly<HullWetBandAppearance>,
  ): void;
}

export interface WakePresentationControllerOptions {
  contacts: readonly HullWaterContactView[];
  overtopEvents: readonly OvertopEvent[];
  waves: WakeWaveField;
  presentWind: WakePresentWindSource;
  ocean: WakeOceanTarget;
  encounterVelocity: Readonly<HorizontalVelocity>;
  vesselHalfBeamM: number;
  schooner?: WakeSchoonerTarget;
}

/**
 * One-way adapter from the completed vessel contact instant to water effects.
 *
 * Every output and scratch object is allocated once. `captureContacts()` copies
 * the just-completed physics graph; `prepareWater()` then resolves presentation
 * policy into the stable FoamField and Ocean inputs without writing back to
 * vessel physics or WaveField state.
 */
export class WakePresentationController {
  /** Stable contact condensation, refreshed immediately after vessel physics. */
  readonly wakeSources: WakeSources;

  readonly wakeTrailPolicy = createWakeTrailPolicyResult();
  readonly wakeBowPolicy = createWakeBowPolicyResult();
  readonly wakePatternPolicy = createWakePatternPolicyResult();

  /** WK3's bow-entry tear detector. Owns the only history in this controller. */
  readonly hullSprayEvents = new HullSprayEventDetector();

  readonly foamHullWakeSource: FoamHullWakeSource = {
    enabled: false,
    portX: 0,
    portZ: 0,
    starboardX: 0,
    starboardZ: 0,
    radiusM: 0.55,
    activeFoamRatePerSecond: 0,
    residualFoamRatePerSecond: 0,
    turbulenceRatePerSecond: 0,
    turbulenceTauSeconds: 24,
    railBias: 0,
  };

  readonly foamWaterlineWakeSource: FoamWaterlineWakeSource = {
    enabled: false,
    stationCount: 0,
    points: Array.from(
      { length: MAX_WATERLINE_WAKE_POINTS },
      () => ({ x: 0, z: 0 }),
    ),
    radiusM: 0.48,
    tearX: 0,
    tearZ: 0,
    activeFoamRatePerSecond: 0,
    residualFoamRatePerSecond: 0,
    turbulenceRatePerSecond: 0,
  };

  // Ash's 2026-08-07 default-on decision. The Ocean Lab master remains the
  // one diagnostic off switch; query parameters are benchmark launchers only.
  private effectsEnabled = true;
  private trailInjectionEnabled = true;
  private trailBubbleHazeEnabled = true;
  private trailWhitecapSuppressionEnabled = true;
  private trailFoamFloorEnabled = true;
  private bowCollarEnabled = true;
  private wetHullEnabled = true;
  private bowMoundEnabled = true;
  private patternEnabled = true;
  private entrySprayEnabled = true;
  /** Lab-only multiplier; the tuned shipping and evidence value is exactly 1. */
  private hullSprayDensityScale = 1;

  /** Far-field decal candidate remains off until it gains real displacement. */
  private kelvinPatternEnabled = false;

  private readonly wakeTrailPolicyInput: WakeTrailPolicyInput = {
    speedThroughWaterMps: 0,
    ambientWhitecapCoverage: 0,
    windSpeedMps: 0,
    sternWidthM: 0,
    sternSourceAvailable: false,
  };

  private readonly wakeBowPolicyInput: WakeBowPolicyInput = {
    speedThroughWaterMps: 0,
    ambientWhitecapCoverage: 0,
    windSpeedMps: 0,
    bowWaterlinePointCount: 0,
  };

  private readonly wakePatternPolicyInput: WakePatternPolicyInput = {
    speedThroughWaterMps: 0,
    ambientWhitecapCoverage: 0,
    turnRateRadPerSec: 0,
  };

  private readonly hullSprayInput: HullSprayEventInput = {
    dtSeconds: 0,
    speedThroughWaterMps: 0,
    ambientWhitecapCoverage: 0,
    densityScale: 1,
    enabled: false,
  };

  private readonly wakeTrailAppearance: WakeTrailAppearance = {
    bubbleHaze: 0,
    whitecapSuppression: 0,
    trailFoamFloor: 0,
  };

  /** Gerstner seed-position inverse scratch shared by every wake source. */
  private readonly wakeSourceSeedScratch = { x: 0, z: 0 };

  private readonly bowPressureFrontGeometry: BowPressureFrontGeometry = {
    tipCentreX: 0,
    tipCentreZ: 0,
    tipHalfWidthM: 0,
    shoulderCentreX: 0,
    shoulderCentreZ: 0,
    shoulderHalfWidthM: 0,
    crownHalfWidthM: 0,
  };

  private readonly shipWakePatternAppearance: ShipWakePatternAppearance = {
    originX: 0,
    originZ: 0,
    dirX: 0,
    dirZ: 1,
    hullForwardX: 0,
    hullForwardZ: 1,
    hullLengthM: 14.3,
    halfBeamM: 2.5,
    bowShoulderCentreX: 0,
    bowShoulderCentreZ: -2.4,
    bowShoulderHalfWidthM: 2,
    bowCrownHalfWidthM: 0.65,
    wavelengthM: 8,
    normalStrength: 0,
    kelvinStrength: 0,
    wedgeLengthM: 60,
  };

  private wakePatternPreviousYawRad: number | undefined;
  private wakePatternTurnRateRadPerSec = 0;

  private readonly wakeBowAppearance: WakeBowAppearanceGains = {
    collarEnabled: false,
    wetBandEnabled: false,
    wetBandHeightM: 0.46,
    wetBandDarkening: 0.28,
    wetBandRoughnessScale: 0.58,
    moundNormalStrength: 0,
    moundAcrossRadiusM: 0.9,
    moundAlongRadiusM: 1.6,
  };

  private readonly bowMoundAppearance: BowMoundAppearance = {
    centreX: 0,
    centreZ: 0,
    forwardX: 0,
    forwardZ: 1,
    normalStrength: 0,
    acrossRadiusM: 0.9,
    alongRadiusM: 1.6,
  };

  private readonly wetHullAppearance: HullWetBandAppearance = {
    enabled: false,
    heightM: 0.46,
    darkening: 0.28,
    roughnessScale: 0.58,
  };

  constructor(private readonly options: WakePresentationControllerOptions) {
    this.wakeSources = new WakeSources(
      options.contacts,
      options.overtopEvents,
    );
  }

  captureContacts(): void {
    this.wakeSources.update();
  }

  /** Resolve completed contacts and motion into stable FoamField/Ocean inputs. */
  prepareWater(ambientWhitecaps: number, dtSeconds: number): void {
    const {
      encounterVelocity,
      ocean,
      schooner,
      presentWind,
      vesselHalfBeamM,
      waves,
    } = this.options;
    const wakeSources = this.wakeSources;
    const stern = wakeSources.sternWaterline;
    const sternWidthM = stern.active
      ? Math.hypot(
          stern.port.x - stern.starboard.x,
          stern.port.z - stern.starboard.z,
        )
      : 0;

    const speedThroughWaterMps = Math.hypot(
      encounterVelocity.x,
      encounterVelocity.z,
    );
    this.wakeTrailPolicyInput.speedThroughWaterMps = speedThroughWaterMps;
    this.wakeTrailPolicyInput.ambientWhitecapCoverage = ambientWhitecaps;
    this.wakeTrailPolicyInput.windSpeedMps = presentWind.meanSpeedMps;
    this.wakeTrailPolicyInput.sternWidthM = sternWidthM;
    this.wakeTrailPolicyInput.sternSourceAvailable = stern.active;
    resolveWakeTrailPolicy(this.wakeTrailPolicyInput, this.wakeTrailPolicy);

    if (stern.active) {
      // Seed positions, not world positions: the field lives in parameter space.
      waves.invertDisplacement(
        stern.port.x,
        stern.port.z,
        this.wakeSourceSeedScratch,
      );
      this.foamHullWakeSource.portX = this.wakeSourceSeedScratch.x;
      this.foamHullWakeSource.portZ = this.wakeSourceSeedScratch.z;
      waves.invertDisplacement(
        stern.starboard.x,
        stern.starboard.z,
        this.wakeSourceSeedScratch,
      );
      this.foamHullWakeSource.starboardX = this.wakeSourceSeedScratch.x;
      this.foamHullWakeSource.starboardZ = this.wakeSourceSeedScratch.z;
    }
    this.foamHullWakeSource.enabled =
      this.effectsEnabled && this.trailInjectionEnabled && stern.active;
    this.foamHullWakeSource.radiusM = this.wakeTrailPolicy.sourceRadiusM;
    this.foamHullWakeSource.railBias = this.wakeTrailPolicy.railBias;
    this.foamHullWakeSource.activeFoamRatePerSecond =
      this.wakeTrailPolicy.activeFoamRatePerSecond;
    this.foamHullWakeSource.residualFoamRatePerSecond =
      this.wakeTrailPolicy.residualFoamRatePerSecond;
    this.foamHullWakeSource.turbulenceRatePerSecond =
      this.wakeTrailPolicy.turbulenceRatePerSecond;
    this.foamHullWakeSource.turbulenceTauSeconds =
      this.wakeTrailPolicy.turbulenceTauSeconds;

    gateWakeTrailAppearance(
      this.wakeTrailPolicy,
      this.effectsEnabled,
      this.trailBubbleHazeEnabled,
      this.trailWhitecapSuppressionEnabled,
      this.trailFoamFloorEnabled,
      this.wakeTrailAppearance,
    );
    ocean.setWakeTrailAppearance(this.wakeTrailAppearance);
    // A target for the ocean's frame latch, not the frame itself: this vector
    // yaws with her and wanders with the orbital water under her, and a grain
    // frame that followed it slid the whole trail's texture. Publishing nothing
    // at negligible speed holds the previous target so a stopping ship's trail
    // does not spin.
    if (speedThroughWaterMps > 0.3) {
      ocean.setWakeStreakTarget(encounterVelocity.x, encounterVelocity.z);
    }

    this.wakeBowPolicyInput.speedThroughWaterMps = speedThroughWaterMps;
    this.wakeBowPolicyInput.ambientWhitecapCoverage = ambientWhitecaps;
    this.wakeBowPolicyInput.windSpeedMps = presentWind.meanSpeedMps;
    this.wakeBowPolicyInput.bowWaterlinePointCount =
      wakeSources.bowWaterlinePointCount;
    resolveWakeBowPolicy(this.wakeBowPolicyInput, this.wakeBowPolicy);
    gateWakeBowAppearance(
      this.wakeBowPolicy,
      this.effectsEnabled,
      this.bowCollarEnabled,
      this.wetHullEnabled,
      this.bowMoundEnabled,
      this.wakeBowAppearance,
    );

    const waterlineStationCount = Math.min(
      wakeSources.waterlinePolylineStationCount,
      MAX_WATERLINE_WAKE_STATIONS,
    );
    const waterlinePoints = this.foamWaterlineWakeSource.points as Array<{
      x: number;
      z: number;
    }>;
    for (let i = 0; i < waterlineStationCount * 2; i++) {
      const point = wakeSources.waterlinePolylinePoints[i];
      waves.invertDisplacement(
        point.x,
        point.z,
        this.wakeSourceSeedScratch,
      );
      waterlinePoints[i].x = this.wakeSourceSeedScratch.x;
      waterlinePoints[i].z = this.wakeSourceSeedScratch.z;
    }
    this.foamWaterlineWakeSource.enabled =
      this.wakeBowAppearance.collarEnabled && waterlineStationCount > 0;
    this.foamWaterlineWakeSource.stationCount = waterlineStationCount;
    this.foamWaterlineWakeSource.radiusM = this.wakeBowPolicy.sourceRadiusM;
    // Astern along the track, from the vessel's own motion through the water.
    const trackSpeed = Math.hypot(
      encounterVelocity.x,
      encounterVelocity.z,
    );
    if (trackSpeed > 1e-3) {
      this.foamWaterlineWakeSource.tearX =
        (-encounterVelocity.x / trackSpeed) * this.wakeBowPolicy.tearLengthM;
      this.foamWaterlineWakeSource.tearZ =
        (-encounterVelocity.z / trackSpeed) * this.wakeBowPolicy.tearLengthM;
    } else {
      this.foamWaterlineWakeSource.tearX = 0;
      this.foamWaterlineWakeSource.tearZ = 0;
    }
    this.foamWaterlineWakeSource.activeFoamRatePerSecond =
      this.wakeBowPolicy.activeFoamRatePerSecond;
    this.foamWaterlineWakeSource.residualFoamRatePerSecond =
      this.wakeBowPolicy.residualFoamRatePerSecond;
    this.foamWaterlineWakeSource.turbulenceRatePerSecond =
      this.wakeBowPolicy.turbulenceRatePerSecond;

    // Resolve ahead of every consumer because the mound needs to know whether
    // the finite pressure front is already live.
    const bowPressureFrontActive = resolveBowPressureFrontGeometry(
      waterlinePoints,
      waterlineStationCount,
      this.bowPressureFrontGeometry,
    );

    this.wetHullAppearance.enabled = this.wakeBowAppearance.wetBandEnabled;
    this.wetHullAppearance.heightM = this.wakeBowAppearance.wetBandHeightM;
    this.wetHullAppearance.darkening =
      this.wakeBowAppearance.wetBandDarkening;
    this.wetHullAppearance.roughnessScale =
      this.wakeBowAppearance.wetBandRoughnessScale;
    schooner?.updateWetHullBand(wakeSources, this.wetHullAppearance);

    const stem = wakeSources.bowStemWaterline;
    if (stem.active && schooner) {
      const forwardX = Math.sin(schooner.yaw);
      const forwardZ = Math.cos(schooner.yaw);
      const forwardOffset = this.wakeBowAppearance.moundAlongRadiusM * 0.22;
      waves.invertDisplacement(
        (stem.port.x + stem.starboard.x) * 0.5 + forwardX * forwardOffset,
        (stem.port.z + stem.starboard.z) * 0.5 + forwardZ * forwardOffset,
        this.wakeSourceSeedScratch,
      );
      this.bowMoundAppearance.centreX = this.wakeSourceSeedScratch.x;
      this.bowMoundAppearance.centreZ = this.wakeSourceSeedScratch.z;
      this.bowMoundAppearance.forwardX = forwardX;
      this.bowMoundAppearance.forwardZ = forwardZ;
      // The finite front supersedes the older mound when both describe the
      // same physical pile-up ahead of the stem.
      this.bowMoundAppearance.normalStrength = bowPressureFrontActive
        ? 0
        : this.wakeBowAppearance.moundNormalStrength;
    } else {
      this.bowMoundAppearance.normalStrength = 0;
    }
    this.bowMoundAppearance.acrossRadiusM =
      this.wakeBowAppearance.moundAcrossRadiusM;
    this.bowMoundAppearance.alongRadiusM =
      this.wakeBowAppearance.moundAlongRadiusM;
    ocean.setBowMoundAppearance(this.bowMoundAppearance);

    // Presentation-smoothed |yaw rate| feeds the steady-pattern turn fade.
    const yawRad = schooner ? schooner.yaw : 0;
    if (this.wakePatternPreviousYawRad !== undefined && dtSeconds > 1e-4) {
      let yawDelta = yawRad - this.wakePatternPreviousYawRad;
      if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      const rawRate = Math.min(Math.abs(yawDelta) / dtSeconds, 2);
      this.wakePatternTurnRateRadPerSec +=
        (rawRate - this.wakePatternTurnRateRadPerSec) *
        Math.min(dtSeconds * 2.5, 1);
    }
    this.wakePatternPreviousYawRad = yawRad;

    this.wakePatternPolicyInput.speedThroughWaterMps = speedThroughWaterMps;
    this.wakePatternPolicyInput.ambientWhitecapCoverage = ambientWhitecaps;
    this.wakePatternPolicyInput.turnRateRadPerSec =
      this.wakePatternTurnRateRadPerSec;
    resolveWakePatternPolicy(
      this.wakePatternPolicyInput,
      this.wakePatternPolicy,
    );

    if (stem.active && schooner && bowPressureFrontActive) {
      this.shipWakePatternAppearance.originX =
        this.bowPressureFrontGeometry.tipCentreX;
      this.shipWakePatternAppearance.originZ =
        this.bowPressureFrontGeometry.tipCentreZ;
      this.shipWakePatternAppearance.hullForwardX = Math.sin(schooner.yaw);
      this.shipWakePatternAppearance.hullForwardZ = Math.cos(schooner.yaw);
      this.shipWakePatternAppearance.halfBeamM = vesselHalfBeamM;
      this.shipWakePatternAppearance.bowShoulderCentreX =
        this.bowPressureFrontGeometry.shoulderCentreX;
      this.shipWakePatternAppearance.bowShoulderCentreZ =
        this.bowPressureFrontGeometry.shoulderCentreZ;
      this.shipWakePatternAppearance.bowShoulderHalfWidthM =
        this.bowPressureFrontGeometry.shoulderHalfWidthM;
      this.shipWakePatternAppearance.bowCrownHalfWidthM =
        this.bowPressureFrontGeometry.crownHalfWidthM;
      if (stern.active) {
        const stemX = (stem.port.x + stem.starboard.x) * 0.5;
        const stemZ = (stem.port.z + stem.starboard.z) * 0.5;
        const sternX = (stern.port.x + stern.starboard.x) * 0.5;
        const sternZ = (stern.port.z + stern.starboard.z) * 0.5;
        this.shipWakePatternAppearance.hullLengthM = Math.hypot(
          stemX - sternX,
          stemZ - sternZ,
        );
      }
    }
    if (speedThroughWaterMps > 0.3) {
      this.shipWakePatternAppearance.dirX = encounterVelocity.x;
      this.shipWakePatternAppearance.dirZ = encounterVelocity.z;
    }
    this.shipWakePatternAppearance.wavelengthM =
      this.wakePatternPolicy.wavelengthM;
    this.shipWakePatternAppearance.wedgeLengthM =
      this.wakePatternPolicy.wedgeLengthM;
    const wakePatternLive =
      this.effectsEnabled &&
      this.patternEnabled &&
      stem.active &&
      bowPressureFrontActive;
    this.shipWakePatternAppearance.normalStrength = wakePatternLive
      ? this.wakePatternPolicy.normalStrength
      : 0;
    this.shipWakePatternAppearance.kelvinStrength =
      wakePatternLive && this.kelvinPatternEnabled
        ? this.wakePatternPolicy.normalStrength
        : 0;
    ocean.setShipWakePattern(this.shipWakePatternAppearance);

    // WK3. Last, because it reads the same condensed sources everything above
    // does and publishes a burst nothing above consumes; and it is the one
    // consumer here that carries state between frames, so it must not be
    // stepped twice for one presentation frame.
    this.hullSprayInput.dtSeconds = dtSeconds;
    this.hullSprayInput.speedThroughWaterMps = speedThroughWaterMps;
    this.hullSprayInput.ambientWhitecapCoverage = ambientWhitecaps;
    this.hullSprayInput.densityScale = this.hullSprayDensityScale;
    this.hullSprayInput.enabled = this.effectsEnabled && this.entrySprayEnabled;
    this.hullSprayEvents.update(wakeSources, this.hullSprayInput);
  }

  /**
   * This frame's hull spray, for the particle pool to shed.
   *
   * `active` is false on the overwhelming majority of frames. The object is
   * stable and rewritten in place, like every other output here.
   */
  get hullSprayBurst(): Readonly<HullSprayBurst> {
    return this.hullSprayEvents.burst;
  }

  /** Forget any entry in progress. Paired with the vessel's `resetEffects`. */
  resetHullSprayEvents(): void {
    this.hullSprayEvents.reset();
  }

  /** Scale only how much water a real entry sheds; event timing stays physical. */
  setHullSprayDensityScale(scale: number): void {
    if (!Number.isFinite(scale)) {
      throw new RangeError(`hull spray density scale must be finite, got ${scale}`);
    }
    this.hullSprayDensityScale = Math.min(Math.max(scale, 0), 4);
  }

  hullSprayDensity(): number {
    return this.hullSprayDensityScale;
  }

  setWakeEffectsEnabled(enabled: boolean): void {
    this.effectsEnabled = enabled;
  }

  wakeEffectsEnabled(): boolean {
    return this.effectsEnabled;
  }

  setWakeTrailFeatureEnabled(
    feature: WakeTrailFeature,
    enabled: boolean,
  ): void {
    switch (feature) {
      case 'injection':
        this.trailInjectionEnabled = enabled;
        break;
      case 'bubbleHaze':
        this.trailBubbleHazeEnabled = enabled;
        break;
      case 'whitecapSuppression':
        this.trailWhitecapSuppressionEnabled = enabled;
        break;
      case 'trailFoamFloor':
        this.trailFoamFloorEnabled = enabled;
        break;
    }
  }

  wakeTrailFeatureEnabled(feature: WakeTrailFeature): boolean {
    switch (feature) {
      case 'injection':
        return this.trailInjectionEnabled;
      case 'bubbleHaze':
        return this.trailBubbleHazeEnabled;
      case 'whitecapSuppression':
        return this.trailWhitecapSuppressionEnabled;
      case 'trailFoamFloor':
        return this.trailFoamFloorEnabled;
    }
  }

  setWakeBowFeatureEnabled(
    feature: WakeBowFeature,
    enabled: boolean,
  ): void {
    switch (feature) {
      case 'collar':
        this.bowCollarEnabled = enabled;
        break;
      case 'wetHull':
        this.wetHullEnabled = enabled;
        break;
      case 'bowMound':
        this.bowMoundEnabled = enabled;
        break;
      case 'wavePattern':
        this.patternEnabled = enabled;
        break;
      case 'kelvinPattern':
        this.kelvinPatternEnabled = enabled;
        break;
      case 'entrySpray':
        this.entrySprayEnabled = enabled;
        // A tear left open by the switch would resume mid-plunge when it came
        // back on, so the off state is a clean one.
        if (!enabled) this.hullSprayEvents.reset();
        break;
    }
  }

  wakeBowFeatureEnabled(feature: WakeBowFeature): boolean {
    switch (feature) {
      case 'collar':
        return this.bowCollarEnabled;
      case 'wetHull':
        return this.wetHullEnabled;
      case 'bowMound':
        return this.bowMoundEnabled;
      case 'wavePattern':
        return this.patternEnabled;
      case 'kelvinPattern':
        return this.kelvinPatternEnabled;
      case 'entrySpray':
        return this.entrySprayEnabled;
    }
  }

  wakeSpeedThroughWaterMps(): number {
    const velocity = this.options.encounterVelocity;
    return Math.hypot(velocity.x, velocity.z);
  }
}
