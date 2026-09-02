import type { HullWaterContactView } from '../HullWaterContact';
import {
  backboneBottomY,
  backboneSiding,
  backboneTopY,
  rudderBottomY,
  rudderTopY,
} from './backbone';
import {
  DESIGN_DRAUGHT,
  HULL_LENGTH,
  stationOffsets,
} from './hullForm';
import {
  GRAVITY,
  RHO_WATER,
  hullStations,
  hydrostaticsAt,
} from './hydrostatics';

/**
 * Passive calm-water resistance for the canonical schooner.
 *
 * This is deliberately a force model, separate from the horizontal-motion
 * integrator. It consumes the transient contact result that already knows
 * water relative to every hull station and produces body-axis surge/sway force
 * plus yaw moment. `SchoonerHorizontalDynamics` integrates those outputs while
 * the captive evidence path keeps the coefficients independently inspectable.
 *
 * Coordinates match the ship: +x port, +z forward, positive yaw turns the
 * bow toward port. Forces are forces on the hull, so a vessel moving
 * forward through still water receives a negative-z force.
 */

/** Full-scale seawater kinematic viscosity near 15 C, m2/s. */
export const SEA_WATER_KINEMATIC_VISCOSITY_M2_PER_S = 1.19e-6;

/**
 * Explicit provisional coefficients.
 *
 * The friction line is prescribed by ITTC 7.5-02-02-01 rev. 05. ITTC does not
 * prescribe this hull's form factor, residuary curve or manoeuvring derivatives;
 * without a tow-tank series those remain transparent game-model assumptions.
 * Keeping each contribution separate lets later reference data replace one
 * term without hiding a retune in a single total coefficient.
 */
export const SCHOONER_RESISTANCE_COEFFICIENTS = Object.freeze({
  /** Multiplier `(1 + k)` on ITTC friction for the full-bodied hull. */
  viscousFormFactor: 1.25,
  /** Residuary coefficient at the reference Froude number below. */
  residuaryCoefficientAtReference: 0.0025,
  residuaryReferenceFroude: 0.35,
  /** Steep hull-speed rise; bounded separately to keep pathological inputs finite. */
  residuaryFroudeExponent: 6,
  maximumResiduaryCoefficient: 0.08,
  /** Separated-flow cross-flow coefficients. */
  hullCrossFlowCoefficient: 0.85,
  backboneCrossFlowCoefficient: 1.05,
  rudderCrossFlowCoefficient: 1.10,
  /**
   * Forward-speed coupling of lateral force. Dimensionless per radian in the
   * small-angle identity `beta ~= v/u`; the force form is `0.5 rho A C u v`.
   */
  hullForwardLateralSlope: 0.35,
  /**
   * S3 retune, 2.20 → 1.30 (the joint rudder/lateral retuning the sailing
   * plan called out). Per-strip, 2.20 double-counted the keel's 3D lift: the
   * backbone is one continuous surface of aspect ratio ≈ 0.5, whose whole-
   * surface lifting-line slope is nearer 1.3 than 2.2. The overcount showed
   * up as yaw damping, priced in the tack evidence: work to rotate ≈ 100 kJ
   * against ≈ 116 kJ of way, and she died in stays crossing the eye.
   */
  backboneForwardLateralSlope: 1.30,
  rudderForwardLateralSlope: 2.80,
} as const);

/**
 * Commanded-rudder coefficients (S3), separate from the passive block above.
 *
 * The deflected blade is one lift surface, not another distributed term: the
 * passive model already carries the undeflected blade (cross-flow + coupling
 * on `rudderLateralAreaM2`), so the commanded model adds only the *increment*
 * deflection produces — the lift-curve value at the deflected angle minus the
 * same expression at zero deflection. At δ=0 the increment is identically
 * zero and the passive results are bit-identical by construction.
 *
 * All provisional: no tank data. The lift slope is a flat-plate value for the
 * blade's effective aspect ratio (geometric span²/area ≈ 3.4, raised by the
 * hull's partial end-plate effect); stall is the design's 25–30° band for a
 * working rudder. Tuned only against the S3 turn/tack/helm gates.
 */
export const SCHOONER_RUDDER_COEFFICIENTS = Object.freeze({
  /**
   * dCL/dα at small effective angles, per radian, in CL = slope·sinα·cosα.
   * This is the lifting-line value 2π·AR/(AR+2) at the effective aspect
   * ratio below — not an independent tuning knob. The S3 tack evidence is
   * what showed a more conservative slope to be wrong: with it she could
   * not carry 2.8 m/s of way through the eye in flat water.
   */
  liftSlopePerRad: 4.5,
  /** Effective aspect ratio: geometric 3.4 × ~1.5 hull end-plate factor. */
  effectiveAspectRatio: 5.1,
  /** Oswald efficiency in the induced-drag term CL²/(π·AR·e). */
  oswaldEfficiency: 0.9,
  /** Attached flow up to here, degrees of effective angle of attack. */
  stallStartDeg: 25,
  /** Fully stalled beyond here; half-cosine blend between. */
  stallEndDeg: 40,
  /** Lift retained past stall — a stalled barn door still turns the ship. */
  stallFloor: 0.35,
  /** Pressure-drag rise of the deflected plate, on sin² of the attack angle. */
  crossDragCoefficient: 1.0,
} as const);

export interface ResistanceVector3 {
  x: number;
  y: number;
  z: number;
}

export interface SchoonerResistanceInput {
  readonly contacts: readonly HullWaterContactView[];
  /** Model yaw in the local render/wave frame, radians. */
  modelYawRad: number;
  /** Positive turns the bow toward +x/port, radians per second. */
  yawRateRadPerSecond?: number;
  /**
   * Commanded rudder deflection, radians. Positive = trailing edge to
   * +x/port, which with headway pushes the stern to starboard and the bow to
   * port — the same rotational sense as positive yaw (pinned by test, not by
   * this comment). Zero or absent reproduces the passive model bit-exactly.
   */
  rudderAngleRad?: number;
}

export interface SchoonerResistanceResult {
  /** Total passive force on the hull in body axes. */
  readonly forceBodyN: ResistanceVector3;
  /** Total moment about the vertical axis through the design LCB/LCG. */
  yawMomentNm: number;

  reynoldsNumber: number;
  froudeNumber: number;
  frictionCoefficient: number;
  residuaryCoefficient: number;
  effectiveWettedSurfaceAreaM2: number;
  meanRelativeForwardWaterSpeedMps: number;

  /** Signed body-z contributions; their sum is `forceBodyN.z`. */
  frictionForceN: number;
  formForceN: number;
  residuaryForceN: number;

  /** Signed body-x lateral contributions; with the deflection force below,
   * their sum is `forceBodyN.x`. */
  hullLateralForceN: number;
  backboneLateralForceN: number;
  rudderLateralForceN: number;
  hullYawMomentNm: number;
  backboneYawMomentNm: number;
  rudderYawMomentNm: number;

  /** Commanded rudder deflection this evaluation used, radians. */
  rudderAngleRad: number;
  /** Water speed past the blade centroid (yaw-rate included), m/s. */
  rudderInflowSpeedMps: number;
  /**
   * Inflow angle off "streaming aft" at the blade, degrees: 0 = clean
   * headway, ±180 = sternway, positive = flow angling toward +x/port.
   */
  rudderInflowAngleDeg: number;
  /** Effective blade angle of attack (deflection against inflow), degrees. */
  rudderEffectiveAoaDeg: number;
  /** 1 attached … `stallFloor` fully stalled, at the effective angle. */
  rudderStallFactor: number;
  /** Deflection increment, body axes; zero whenever the helm is amidships. */
  rudderDeflectionForceXN: number;
  rudderDeflectionForceZN: number;
  rudderDeflectionYawMomentNm: number;
}

export interface SchoonerResistanceStationGeometry {
  readonly stationIndex: number;
  readonly z: number;
  readonly length: number;
  /** Wetted surface used by the longitudinal friction calculation. */
  readonly wettedSurfaceAreaM2: number;
  /** Side-profile areas used by the distributed lateral calculation. */
  readonly hullLateralAreaM2: number;
  readonly backboneLateralAreaM2: number;
  readonly rudderLateralAreaM2: number;
}

export interface SchoonerResistanceGeometry {
  readonly waterlineLengthM: number;
  readonly yawReferenceZ: number;
  readonly wettedSurfaceAreaM2: number;
  readonly hullLateralAreaM2: number;
  readonly backboneLateralAreaM2: number;
  readonly rudderLateralAreaM2: number;
  readonly stations: readonly SchoonerResistanceStationGeometry[];
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** One side of the moulded section below a level waterline. */
function immersedSectionGirth(z: number, waterlineY: number): number {
  const offsets = stationOffsets(z, 96);
  let girth = 0;
  for (let i = 1; i < offsets.length; i++) {
    const a = offsets[i - 1];
    const b = offsets[i];
    if (a.y >= waterlineY && b.y >= waterlineY) continue;

    let fraction = 1;
    if (b.y > waterlineY) {
      fraction = clamp(
        (waterlineY - a.y) / Math.max(b.y - a.y, 1e-12),
        0,
        1,
      );
    }
    girth += Math.hypot(
      (b.y - a.y) * fraction,
      (b.halfBreadth - a.halfBreadth) * fraction,
    );
  }
  return girth;
}

function immersedHeight(bottomY: number, topY: number, waterlineY: number): number {
  return Math.max(0, Math.min(topY, waterlineY) - bottomY);
}

function buildResistanceGeometry(): SchoonerResistanceGeometry {
  const hydrostatics = hydrostaticsAt(DESIGN_DRAUGHT);
  const stations = hullStations().map((station, stationIndex) => {
    const mouldedGirth = immersedSectionGirth(station.z, DESIGN_DRAUGHT);
    const backboneHeight = immersedHeight(
      backboneBottomY(station.z),
      backboneTopY(station.z),
      DESIGN_DRAUGHT,
    );
    const rudderHeight = immersedHeight(
      rudderBottomY(),
      rudderTopY(station.z),
      DESIGN_DRAUGHT,
    );
    const hullDepth = immersedHeight(
      station.moulded.floorY,
      station.moulded.crownY,
      DESIGN_DRAUGHT,
    );

    // Station-girth integration is the same approximation already used to
    // weigh the shell. End faces and the waterplane are not wetted surface.
    const mouldedWettedArea = 2 * mouldedGirth * station.length;
    const backboneWettedArea =
      backboneHeight > 0
        ? (2 * backboneHeight + backboneSiding(station.z)) * station.length
        : 0;
    // The rudder's two broad faces dominate its friction area. Its narrow edges
    // are deliberately omitted rather than inventing a second blade thickness.
    const rudderWettedArea = 2 * rudderHeight * station.length;

    return Object.freeze({
      stationIndex,
      z: station.z,
      length: station.length,
      wettedSurfaceAreaM2:
        mouldedWettedArea + backboneWettedArea + rudderWettedArea,
      hullLateralAreaM2: hullDepth * station.length,
      backboneLateralAreaM2: backboneHeight * station.length,
      rudderLateralAreaM2: rudderHeight * station.length,
    });
  });

  const sum = (read: (station: SchoonerResistanceStationGeometry) => number) =>
    stations.reduce((total, station) => total + read(station), 0);

  return Object.freeze({
    waterlineLengthM: hydrostatics.waterlineLength,
    // The loaded LCG is solved onto LCB, so this is also the yaw origin without
    // importing the mass model and creating a geometry/mass dependency cycle.
    yawReferenceZ: hydrostatics.lcb,
    wettedSurfaceAreaM2: sum((station) => station.wettedSurfaceAreaM2),
    hullLateralAreaM2: sum((station) => station.hullLateralAreaM2),
    backboneLateralAreaM2: sum((station) => station.backboneLateralAreaM2),
    rudderLateralAreaM2: sum((station) => station.rudderLateralAreaM2),
    stations: Object.freeze(stations),
  });
}

export const SCHOONER_RESISTANCE_GEOMETRY = buildResistanceGeometry();

/** ITTC-1957 model-ship correlation line, used here at full-scale Reynolds number. */
export function ittc1957FrictionCoefficient(reynoldsNumber: number): number {
  if (!Number.isFinite(reynoldsNumber) || reynoldsNumber < 0) {
    throw new RangeError(`Reynolds number must be finite and non-negative, got ${reynoldsNumber}`);
  }
  if (reynoldsNumber === 0) return 0;
  // The correlation line is turbulent. Holding its lowest evaluated Reynolds
  // number avoids a singular low-speed extrapolation while force still tends
  // continuously to zero with velocity squared.
  const boundedReynolds = Math.max(reynoldsNumber, 1e5);
  return 0.075 / (Math.log10(boundedReynolds) - 2) ** 2;
}

/** Explicit provisional hull-speed rise, separate from the sourced friction line. */
export function schoonerResiduaryCoefficient(froudeNumber: number): number {
  if (!Number.isFinite(froudeNumber) || froudeNumber < 0) {
    throw new RangeError(`Froude number must be finite and non-negative, got ${froudeNumber}`);
  }
  const coefficients = SCHOONER_RESISTANCE_COEFFICIENTS;
  return Math.min(
    coefficients.maximumResiduaryCoefficient,
    coefficients.residuaryCoefficientAtReference *
      (froudeNumber / coefficients.residuaryReferenceFroude) **
        coefficients.residuaryFroudeExponent,
  );
}

export function createSchoonerResistanceResult(): SchoonerResistanceResult {
  return {
    forceBodyN: { x: 0, y: 0, z: 0 },
    yawMomentNm: 0,
    reynoldsNumber: 0,
    froudeNumber: 0,
    frictionCoefficient: 0,
    residuaryCoefficient: 0,
    effectiveWettedSurfaceAreaM2: 0,
    meanRelativeForwardWaterSpeedMps: 0,
    frictionForceN: 0,
    formForceN: 0,
    residuaryForceN: 0,
    hullLateralForceN: 0,
    backboneLateralForceN: 0,
    rudderLateralForceN: 0,
    hullYawMomentNm: 0,
    backboneYawMomentNm: 0,
    rudderYawMomentNm: 0,
    rudderAngleRad: 0,
    rudderInflowSpeedMps: 0,
    rudderInflowAngleDeg: 0,
    rudderEffectiveAoaDeg: 0,
    rudderStallFactor: 1,
    rudderDeflectionForceXN: 0,
    rudderDeflectionForceZN: 0,
    rudderDeflectionYawMomentNm: 0,
  };
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
}

const RAD_TO_DEG = 180 / Math.PI;

function wrapPi(angle: number): number {
  let wrapped = (angle + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

/**
 * Acute angle between the flow line and the blade's chord line, radians.
 * A chord line has no head or tail: flow streaming aft (α ≈ 0) and flow
 * streaming forward (α ≈ ±π) are both zero attack for stall purposes.
 */
function rudderAttackAngleRad(alphaRad: number): number {
  const a = Math.abs(wrapPi(alphaRad));
  return Math.min(a, Math.PI - a);
}

/** Attached-flow factor at an attack angle: 1 below stall, floor beyond. */
export function rudderStallFactorAt(attackAngleDeg: number): number {
  const { stallStartDeg, stallEndDeg, stallFloor } = SCHOONER_RUDDER_COEFFICIENTS;
  const a = Math.abs(attackAngleDeg);
  if (a <= stallStartDeg) return 1;
  if (a >= stallEndDeg) return stallFloor;
  const past = (a - stallStartDeg) / (stallEndDeg - stallStartDeg);
  return stallFloor + (1 - stallFloor) * 0.5 * (1 + Math.cos(Math.PI * past));
}

/**
 * Blade lift coefficient at flow-relative angle `alphaRad` (flow angle minus
 * deflection). The sin·cos flat-plate form folds over at ±90° and reverses
 * sign past it, which is exactly the sternway-steering reversal; stall acts
 * on the acute attack angle.
 */
export function rudderLiftCoefficient(alphaRad: number): number {
  const coefficients = SCHOONER_RUDDER_COEFFICIENTS;
  const attackDeg = rudderAttackAngleRad(alphaRad) * RAD_TO_DEG;
  return (
    coefficients.liftSlopePerRad *
    Math.sin(alphaRad) *
    Math.cos(alphaRad) *
    rudderStallFactorAt(attackDeg)
  );
}

/** Induced drag of the blade's lift plus deflected-plate pressure drag. */
export function rudderDragCoefficient(alphaRad: number): number {
  const coefficients = SCHOONER_RUDDER_COEFFICIENTS;
  const rawLift =
    coefficients.liftSlopePerRad * Math.sin(alphaRad) * Math.cos(alphaRad);
  const induced =
    (rawLift * rawLift) /
    (Math.PI * coefficients.effectiveAspectRatio * coefficients.oswaldEfficiency);
  const crossSin = Math.sin(rudderAttackAngleRad(alphaRad));
  return induced + coefficients.crossDragCoefficient * crossSin * crossSin;
}

function lateralForce(
  relativeLateralSpeedMps: number,
  relativeForwardSpeedMps: number,
  areaM2: number,
  crossFlowCoefficient: number,
  forwardLateralSlope: number,
): number {
  return (
    0.5 *
    RHO_WATER *
    areaM2 *
    relativeLateralSpeedMps *
    (crossFlowCoefficient * Math.abs(relativeLateralSpeedMps) +
      forwardLateralSlope * Math.abs(relativeForwardSpeedMps))
  );
}

/**
 * Evaluate one instant, overwriting `out` when supplied.
 *
 * No contact or geometry is retained. Passing a reusable result makes the call
 * allocation-free for the later 240 Hz integrator while the default remains
 * convenient for tests and evidence generation.
 */
export function evaluateSchoonerResistance(
  input: SchoonerResistanceInput,
  out: SchoonerResistanceResult = createSchoonerResistanceResult(),
): SchoonerResistanceResult {
  const yawRate = input.yawRateRadPerSecond ?? 0;
  const rudderAngle = input.rudderAngleRad ?? 0;
  assertFinite(input.modelYawRad, 'model yaw');
  assertFinite(yawRate, 'yaw rate');
  assertFinite(rudderAngle, 'rudder angle');
  if (Math.abs(rudderAngle) > Math.PI / 2) {
    throw new RangeError(
      `rudder angle must lie within ±90°, got ${rudderAngle * RAD_TO_DEG}°`,
    );
  }
  if (input.contacts.length !== SCHOONER_RESISTANCE_GEOMETRY.stations.length) {
    throw new RangeError(
      `schooner resistance needs ${SCHOONER_RESISTANCE_GEOMETRY.stations.length} contacts, ` +
        `got ${input.contacts.length}`,
    );
  }

  out.forceBodyN.x = 0;
  out.forceBodyN.y = 0;
  out.forceBodyN.z = 0;
  out.yawMomentNm = 0;
  out.reynoldsNumber = 0;
  out.froudeNumber = 0;
  out.frictionCoefficient = 0;
  out.residuaryCoefficient = 0;
  out.effectiveWettedSurfaceAreaM2 = 0;
  out.meanRelativeForwardWaterSpeedMps = 0;
  out.frictionForceN = 0;
  out.formForceN = 0;
  out.residuaryForceN = 0;
  out.hullLateralForceN = 0;
  out.backboneLateralForceN = 0;
  out.rudderLateralForceN = 0;
  out.hullYawMomentNm = 0;
  out.backboneYawMomentNm = 0;
  out.rudderYawMomentNm = 0;
  out.rudderAngleRad = rudderAngle;
  out.rudderInflowSpeedMps = 0;
  out.rudderInflowAngleDeg = 0;
  out.rudderEffectiveAoaDeg = 0;
  out.rudderStallFactor = 1;
  out.rudderDeflectionForceXN = 0;
  out.rudderDeflectionForceZN = 0;
  out.rudderDeflectionYawMomentNm = 0;

  const cy = Math.cos(input.modelYawRad);
  const sy = Math.sin(input.modelYawRad);
  let forwardAreaSpeed = 0;
  // The deflected blade acts as one lift surface: area-weighted inflow and
  // arm accumulate here, with the yaw-rate point velocity added once at the
  // centroid below — the same explicit treatment (and the same gotcha) as
  // the per-station terms, applied at the aggregate blade.
  let bladeArea = 0;
  let bladeAreaArmX = 0;
  let bladeAreaArmZ = 0;
  let bladeAreaRelX = 0;
  let bladeAreaRelZ = 0;

  for (let i = 0; i < input.contacts.length; i++) {
    const contact = input.contacts[i];
    const geometry = SCHOONER_RESISTANCE_GEOMETRY.stations[i];
    if (
      contact.stationIndex !== geometry.stationIndex ||
      Math.abs(contact.stationReferenceLocal.z - geometry.z) > 1e-9
    ) {
      throw new RangeError(`contact ${i} does not match resistance station geometry`);
    }
    assertFinite(contact.designImmersionRatio, `contact ${i} immersion ratio`);
    assertFinite(
      contact.relativeWaterVelocityWorldMps.x,
      `contact ${i} relative-water x velocity`,
    );
    assertFinite(
      contact.relativeWaterVelocityWorldMps.z,
      `contact ${i} relative-water z velocity`,
    );

    const immersionScale = contact.isWet
      ? clamp(contact.designImmersionRatio, 0, 1.5)
      : 0;
    if (immersionScale === 0) continue;

    const relativeWorld = contact.relativeWaterVelocityWorldMps;
    // Inverse of the vessel's Ry(yaw) transform.
    const relativeBodyX = relativeWorld.x * cy - relativeWorld.z * sy;
    const relativeBodyZ = relativeWorld.x * sy + relativeWorld.z * cy;
    const armX = contact.forcePointLocal.x;
    const armZ = contact.forcePointLocal.z - SCHOONER_RESISTANCE_GEOMETRY.yawReferenceZ;
    // BuoyantBody contact kinematics include translation, pitch and roll. The
    // schooner owns yaw rate separately, so add its point velocity here:
    // omega_y cross arm = (+r*z, 0, -r*x), subtracted from water-relative flow.
    const relativeLateralSpeed = relativeBodyX - yawRate * armZ;
    const relativeForwardSpeed = relativeBodyZ + yawRate * armX;

    const wettedArea = geometry.wettedSurfaceAreaM2 * immersionScale;
    out.effectiveWettedSurfaceAreaM2 += wettedArea;
    forwardAreaSpeed += wettedArea * relativeForwardSpeed;

    const hullArea = geometry.hullLateralAreaM2 * immersionScale;
    const backboneArea = geometry.backboneLateralAreaM2 * immersionScale;
    const rudderArea = geometry.rudderLateralAreaM2 * immersionScale;
    if (rudderArea > 0) {
      bladeArea += rudderArea;
      bladeAreaArmX += rudderArea * armX;
      bladeAreaArmZ += rudderArea * armZ;
      bladeAreaRelX += rudderArea * relativeBodyX;
      bladeAreaRelZ += rudderArea * relativeBodyZ;
    }
    const coefficients = SCHOONER_RESISTANCE_COEFFICIENTS;
    const hullForce = lateralForce(
      relativeLateralSpeed,
      relativeForwardSpeed,
      hullArea,
      coefficients.hullCrossFlowCoefficient,
      coefficients.hullForwardLateralSlope,
    );
    const backboneForce = lateralForce(
      relativeLateralSpeed,
      relativeForwardSpeed,
      backboneArea,
      coefficients.backboneCrossFlowCoefficient,
      coefficients.backboneForwardLateralSlope,
    );
    const rudderForce = lateralForce(
      relativeLateralSpeed,
      relativeForwardSpeed,
      rudderArea,
      coefficients.rudderCrossFlowCoefficient,
      coefficients.rudderForwardLateralSlope,
    );

    out.hullLateralForceN += hullForce;
    out.backboneLateralForceN += backboneForce;
    out.rudderLateralForceN += rudderForce;
    out.hullYawMomentNm += armZ * hullForce;
    out.backboneYawMomentNm += armZ * backboneForce;
    out.rudderYawMomentNm += armZ * rudderForce;
  }

  const wettedArea = out.effectiveWettedSurfaceAreaM2;
  const meanRelativeForwardSpeed =
    wettedArea > 0 ? forwardAreaSpeed / wettedArea : 0;
  const speed = Math.abs(meanRelativeForwardSpeed);
  const length = SCHOONER_RESISTANCE_GEOMETRY.waterlineLengthM;
  const reynolds =
    (speed * length) / SEA_WATER_KINEMATIC_VISCOSITY_M2_PER_S;
  const froude = speed / Math.sqrt(GRAVITY * Math.max(length, 1e-9));
  const frictionCoefficient = ittc1957FrictionCoefficient(reynolds);
  const residuaryCoefficient = schoonerResiduaryCoefficient(froude);
  const signedDynamicArea =
    0.5 * RHO_WATER * wettedArea * speed * meanRelativeForwardSpeed;

  out.meanRelativeForwardWaterSpeedMps = meanRelativeForwardSpeed;
  out.reynoldsNumber = reynolds;
  out.froudeNumber = froude;
  out.frictionCoefficient = frictionCoefficient;
  out.residuaryCoefficient = residuaryCoefficient;
  out.frictionForceN = signedDynamicArea * frictionCoefficient;
  out.formForceN =
    signedDynamicArea *
    frictionCoefficient *
    (SCHOONER_RESISTANCE_COEFFICIENTS.viscousFormFactor - 1);
  out.residuaryForceN = signedDynamicArea * residuaryCoefficient;
  out.forceBodyN.x =
    out.hullLateralForceN +
    out.backboneLateralForceN +
    out.rudderLateralForceN;
  out.forceBodyN.z =
    out.frictionForceN + out.formForceN + out.residuaryForceN;
  out.yawMomentNm =
    out.hullYawMomentNm +
    out.backboneYawMomentNm +
    out.rudderYawMomentNm;

  if (bladeArea > 0) {
    const armXBar = bladeAreaArmX / bladeArea;
    const armZBar = bladeAreaArmZ / bladeArea;
    const flowX = bladeAreaRelX / bladeArea - yawRate * armZBar;
    const flowZ = bladeAreaRelZ / bladeArea + yawRate * armXBar;
    const flowSpeedSq = flowX * flowX + flowZ * flowZ;
    const flowSpeed = Math.sqrt(flowSpeedSq);
    const flowAngle = Math.atan2(flowX, -flowZ);
    out.rudderInflowSpeedMps = flowSpeed;
    out.rudderInflowAngleDeg = flowAngle * RAD_TO_DEG;

    // The commanded increment: lift-curve force at the deflected angle minus
    // the same expression undeflected. Guarded on the exact zero so amidships
    // helm cannot perturb the passive sums by even a floating-point rounding.
    if (rudderAngle !== 0 && flowSpeedSq > 0) {
      const alpha = wrapPi(flowAngle - rudderAngle);
      out.rudderEffectiveAoaDeg = alpha * RAD_TO_DEG;
      out.rudderStallFactor = rudderStallFactorAt(
        rudderAttackAngleRad(alpha) * RAD_TO_DEG,
      );
      const deltaLift =
        rudderLiftCoefficient(alpha) - rudderLiftCoefficient(flowAngle);
      const deltaDrag =
        rudderDragCoefficient(alpha) - rudderDragCoefficient(flowAngle);
      // Dynamic pressure over the immersed blade; effectiveness scales with
      // inflow speed squared, so a stopped ship does not answer her helm.
      const dynamicArea = 0.5 * RHO_WATER * bladeArea * flowSpeedSq;
      const flowUnitX = flowX / flowSpeed;
      const flowUnitZ = flowZ / flowSpeed;
      // Lift acts perpendicular to the inflow (f̂ rotated −90° in the yaw
      // sense), drag along it; both reverse naturally when the flow does.
      const forceX = dynamicArea * (deltaLift * -flowUnitZ + deltaDrag * flowUnitX);
      const forceZ = dynamicArea * (deltaLift * flowUnitX + deltaDrag * flowUnitZ);
      out.rudderDeflectionForceXN = forceX;
      out.rudderDeflectionForceZN = forceZ;
      out.rudderDeflectionYawMomentNm = armZBar * forceX - armXBar * forceZ;
      out.forceBodyN.x += forceX;
      out.forceBodyN.z += forceZ;
      out.yawMomentNm += out.rudderDeflectionYawMomentNm;
    }
  }

  return out;
}

/** Representative length used by the captive-test yaw-rate normalization. */
export const SCHOONER_RESISTANCE_REFERENCE_LENGTH_M = HULL_LENGTH;
