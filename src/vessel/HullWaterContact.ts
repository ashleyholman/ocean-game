/** Vessel-fixed longitudinal region used to route contact physics and effects. */
export type LongitudinalContactRegion = 'bow' | 'midships' | 'stern';

/** Vessel-fixed transverse region. A whole cross-section is `centre`. */
export type TransverseContactRegion = 'starboard' | 'centre' | 'port';

export interface ContactVector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * One side of a station's intersection with the locally planar water surface.
 *
 * The object is permanent and allocation-free; `active` says whether the
 * current water plane actually cuts that side of the section. A dry or fully
 * submerged section has no waterline intersection even though it may still
 * have a valid station result.
 */
export interface HullWaterlineContact {
  readonly side: Exclude<TransverseContactRegion, 'centre'>;
  active: boolean;
  readonly localPoint: ContactVector3;
  readonly worldPoint: ContactVector3;
}

/**
 * Derived contact and relative-flow facts for one flotation station.
 *
 * Instances are allocated once with the body and overwritten at every contact
 * evaluation. Consumers may retain the object identity, but not its old
 * values: this is a view of the current physics/presentation instant, not
 * history or canonical world state.
 */
export interface HullWaterContact {
  readonly stationIndex: number;
  readonly longitudinalRegion: LongitudinalContactRegion;
  readonly transverseRegion: TransverseContactRegion;

  /** Fixed station reference on the vessel's local y = 0 plane. */
  readonly stationReferenceLocal: ContactVector3;
  /** The same reference transformed into the local render/wave frame. */
  readonly stationReferenceWorld: ContactVector3;
  /** Surface point at which the wave sampler was evaluated. */
  readonly waterSurfaceWorld: ContactVector3;

  /** Centroid of this station's immersed volume, where buoyancy acts. */
  readonly forcePointLocal: ContactVector3;
  readonly forcePointWorld: ContactVector3;

  readonly portWaterline: HullWaterlineContact;
  readonly starboardWaterline: HullWaterlineContact;

  readonly surfaceNormalWorld: ContactVector3;
  /** Water-particle velocity supplied by the wave model. */
  readonly waterVelocityWorldMps: ContactVector3;
  /** Translational plus pitch/roll velocity at `forcePointWorld`. */
  readonly hullPointVelocityWorldMps: ContactVector3;
  /** Water minus hull-point velocity. */
  readonly relativeWaterVelocityWorldMps: ContactVector3;

  /** Closing speed along the outward water-surface normal. */
  normalEntrySpeedMps: number;
  /**
   * Existing response-compatible vertical entry speed used by damping and
   * overtopping. Kept distinct from the new 3D normal projection so exposing
   * the contract does not silently retune vessel motion.
   */
  verticalEntrySpeedMps: number;

  immersedVolumeM3: number;
  /** Actual immersed volume divided by this station's design immersion. */
  designImmersionRatio: number;
  isWet: boolean;
  /** Positive is a gap below the design waterline; negative is immersion. */
  waterlineClearanceM: number;
  /** Existing crown/rail height in the render/wave frame. */
  crownWorldY: number;

  buoyancyForceN: number;
  dampingForceN: number;
  overtopping: boolean;
}

/** Deep read-only surface exposed outside the body that owns the reusable buffer. */
export type HullWaterlineContactView = {
  readonly [Key in keyof HullWaterlineContact]:
    HullWaterlineContact[Key] extends ContactVector3
      ? Readonly<ContactVector3>
      : HullWaterlineContact[Key];
};

export type HullWaterContactView = {
  readonly [Key in keyof HullWaterContact]:
    HullWaterContact[Key] extends ContactVector3
      ? Readonly<ContactVector3>
      : HullWaterContact[Key] extends HullWaterlineContact
        ? HullWaterlineContactView
        : HullWaterContact[Key];
};

function vector3(x = 0, y = 0, z = 0): ContactVector3 {
  return { x, y, z };
}

function waterlineContact(
  side: HullWaterlineContact['side'],
): HullWaterlineContact {
  return {
    side,
    active: false,
    localPoint: vector3(),
    worldPoint: vector3(),
  };
}

export function createHullWaterContact(options: {
  stationIndex: number;
  stationX: number;
  stationZ: number;
  longitudinalRegion: LongitudinalContactRegion;
  transverseRegion: TransverseContactRegion;
}): HullWaterContact {
  return {
    stationIndex: options.stationIndex,
    longitudinalRegion: options.longitudinalRegion,
    transverseRegion: options.transverseRegion,
    stationReferenceLocal: vector3(options.stationX, 0, options.stationZ),
    stationReferenceWorld: vector3(),
    waterSurfaceWorld: vector3(),
    forcePointLocal: vector3(0, 0, options.stationZ),
    forcePointWorld: vector3(),
    portWaterline: waterlineContact('port'),
    starboardWaterline: waterlineContact('starboard'),
    surfaceNormalWorld: vector3(0, 1, 0),
    waterVelocityWorldMps: vector3(),
    hullPointVelocityWorldMps: vector3(),
    relativeWaterVelocityWorldMps: vector3(),
    normalEntrySpeedMps: 0,
    verticalEntrySpeedMps: 0,
    immersedVolumeM3: 0,
    designImmersionRatio: 0,
    isWet: false,
    waterlineClearanceM: 0,
    crownWorldY: 0,
    buoyancyForceN: 0,
    dampingForceN: 0,
    overtopping: false,
  };
}

/** Divide a vessel's local longitudinal span into stable stern/middle/bow thirds. */
export function classifyLongitudinalContact(
  z: number,
  sternZ: number,
  bowZ: number,
): LongitudinalContactRegion {
  if (
    !Number.isFinite(z) ||
    !Number.isFinite(sternZ) ||
    !Number.isFinite(bowZ) ||
    bowZ <= sternZ
  ) {
    throw new RangeError('contact classification needs a finite stern-to-bow span');
  }
  const fraction = (z - sternZ) / (bowZ - sternZ);
  if (fraction < 1 / 3) return 'stern';
  if (fraction > 2 / 3) return 'bow';
  return 'midships';
}
