import type { SurfaceSample, WaveField } from '../scene/Waves';
import { createSurfaceSample } from '../scene/Waves';
import {
  createHullWaterContact,
  type HullWaterContact,
  type HullWaterContactView,
  type LongitudinalContactRegion,
  type TransverseContactRegion,
} from './HullWaterContact';

/**
 * Distributed hydrostatic buoyancy shared by every floating vessel.
 *
 * This class integrates the three waterplane degrees of freedom — heave,
 * pitch and roll. Horizontal rigid-body motion is deliberately composed by a
 * vessel adapter: the schooner now integrates surge, sway and yaw from the
 * same transient contact graph, while the diagnostic raft remains kinematic.
 *
 * Flotation is not a spring chasing the water. It is the real thing:
 *
 *   - The hull is divided into an adapter-defined fixed station set: 24 timber
 *     cells for the raft and 39 lofted sections for the schooner. Each station
 *     owns a slice of the vessel's actual flotation geometry.
 *   - Each station evaluates the water surface at its own world position at the
 *     current physics time, computes how much of its timber is under the local
 *     water plane through its adapter's exact section integration, and pushes
 *     up with rho*g*V.
 *   - Damping is against the local water velocity, not the world. When vessel
 *     and water move together the relative velocity vanishes, so damping costs
 *     nothing in phase.
 *   - Forces are applied at the stations, so pitch and roll are torque, not a
 *     fitted plane. A crossing sea that lifts one diagonal and drops the other
 *     produces the couple it should.
 *
 * Nothing here contains an animation delay, a target offset or a per-preset
 * constant. Mass comes from timber density and the geometry; the equilibrium
 * waterline is *solved* from Archimedes, then verified against the model.
 */

const GRAVITY = 9.81;
export const RHO_WATER = 1025;

/** Fixed physics substep. */
export const PHYSICS_STEP = 1 / 240;
/**
 * Emergency rigid-body guards. These are not authored motion limits and must
 * never be mistaken for capsize or comfort physics. They are exported so the
 * response harness can report how much validity margin a run retained.
 */
export const HULL_ATTITUDE_LIMIT_RADIANS = 0.7;
export const HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND = 6;
export const HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND = 12;
/** Matches the frame dt clamp in main.ts, so a stall cannot spiral. */
const MAX_SUBSTEPS = 12;

/** What a station reports about its immersion at a given local water level. */
export interface StationImmersion {
  /** Immersed volume of this station's share of the hull, m³. */
  volume: number;
  /** Waterplane area this station contributes, m². */
  waterplaneArea: number;
  /** Local x at which the buoyant force acts — the roll moment arm. */
  centroidX: number;
  /**
   * Local y at which the buoyant force acts.
   *
   * A vertical force exerts no torque about its own line of action, so it is
   * tempting to think the height of the application point cannot matter. It
   * does, because the *arm* is measured in the world: rotating a body-local
   * point into the world mixes its local y into the horizontal offset from the
   * centre of mass, by `-dy·sin(roll)`. Get the height wrong and every station
   * contributes a spurious righting moment proportional to that error.
   *
   * On a hull whose centre of buoyancy is well below its centre of gravity,
   * getting this wrong can create an error as large as the real righting arm.
   */
  centroidY: number;
  /** Number of waterline crossings represented by the two extreme points below. */
  waterlineContactCount: number;
  /** Local starboard-most intersection of the section and water plane. */
  waterlineStarboardX: number;
  waterlineStarboardY: number;
  /** Local port-most intersection of the section and water plane. */
  waterlinePortX: number;
  waterlinePortY: number;
}

export function createStationImmersion(): StationImmersion {
  return {
    volume: 0,
    waterplaneArea: 0,
    centroidX: 0,
    centroidY: 0,
    waterlineContactCount: 0,
    waterlineStarboardX: 0,
    waterlineStarboardY: 0,
    waterlinePortX: 0,
    waterlinePortY: 0,
  };
}

/**
 * The shape a station floats on.
 *
 * This is the seam between the two hulls. Everything else in this file — the
 * force balance, the damping against local water velocity, added mass, the
 * critical points, the substepping — is hull-agnostic and is shared. What
 * differs is only how much of the hull is under the water at a station, and
 * where that volume's centroid sits.
 *
 * `slope` is the gradient of the water surface across the beam in *local*
 * coordinates: the vessel's own heel plus the wave's transverse slope, combined
 * (see `waterSlopeAcrossBeam`). A vessel adapter whose stations already resolve
 * the transverse direction may intentionally ignore it.
 */
export interface StationSection {
  /** Top of the flotation body here: the edge water must cross to come aboard. */
  readonly crownY: number;
  /** Bottom of the flotation body here. Brackets the equilibrium solve. */
  readonly floorY: number;
  immerse(waterLocalY: number, slope: number, out: StationImmersion): void;
}

export interface ContactStation {
  /** Vessel-local position of the station's reference point, on the y = 0 plane. */
  x: number;
  z: number;
  section: StationSection;
  /** Top of the flotation timber here — the edge water must cross to overtop. */
  crownY: number;
  /** True when this station contributes to the body's crown/freeboard reference. */
  outerEdge: boolean;
  /** −1 starboard, +1 port, 0 centre. Used to place the overtopping cue. */
  edgeSign: number;
  longitudinalRegion: LongitudinalContactRegion;
  /** A whole schooner section is centre; point-like raft columns have a side. */
  transverseRegion: TransverseContactRegion;
  /** Length of crown represented by this station, for overtopping flux. */
  overtopContactWidthM: number;
  /** Finite deck-plan catchment represented by this station. */
  overtopTributaryAreaM2: number;
}

export interface CriticalPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  /** Live clearance above the local water surface, metres. */
  clearance: number;
  worldX: number;
  worldY: number;
  worldZ: number;
}

export interface OvertopEvent {
  x: number;
  y: number;
  z: number;
  /** Relative entry speed, m/s. */
  speed: number;
  /** Depth of water over the crown, metres. */
  depth: number;
  /** Fixed integration interval represented by this contact fact. */
  durationSeconds: number;
  /** Length of rail/crown in simultaneous contact with the boarding water. */
  contactWidthM: number;
  /** Finite deck-plan catchment used to cap the event's water prism. */
  tributaryAreaM2: number;
  /** Station identity within this body's fixed contact array. */
  stationIndex: number;
  /**
   * Fixed-step ordinal within the current caller batch.
   *
   * It resets whenever `update` clears `overtopEvents` and advances even on a
   * step with no event. Consumers can therefore reject a duplicated
   * station/step fact without collapsing legitimate contact on later substeps.
   */
  batchStepIndex: number;
  /** Vessel-local longitudinal station position, metres (+z forward). */
  stationLocalZ: number;
  /** The one rail/edge this event entered across. */
  boardingSide: 'starboard' | 'port';
  /** Horizontal water velocity, so the cue is thrown the way the water is going. */
  flowX: number;
  flowZ: number;
}

/**
 * Attitude sampled for one completed body substep.
 *
 * The pose is captured at the start of the step, exactly where contacts and
 * overtopping are evaluated. `batchStepIndex` therefore shares its clock and
 * identity with `OvertopEvent.batchStepIndex`; a consumer must not substitute
 * the body's frame-final attitude for every fact in the batch.
 */
export interface BuoyantBodySubstepAttitude {
  readonly batchStepIndex: number;
  readonly durationSeconds: number;
  readonly pitchRad: number;
  readonly rollRad: number;
}

interface MutableBuoyantBodySubstepAttitude {
  batchStepIndex: number;
  durationSeconds: number;
  pitchRad: number;
  rollRad: number;
}

export interface MassItem {
  mass: number;
  x: number;
  y: number;
  z: number;
  /** Own moment of inertia about its own X and Z axes through its centroid. */
  ixx: number;
  izz: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Immersion ratio limiter for the damping and added-mass coefficients.
 *
 * Both scale with how much hull is in the water, and both are calibrated at the
 * designed waterline — where the ratio is exactly 1. A hard `min(r, 1)` there
 * would put a derivative discontinuity precisely on the operating point: the
 * vessel crosses it twice per wave cycle, and the coefficient's slope steps every
 * time. Leaving it unbounded is no better — a deeply buried hull would get up to
 * 1.92x the damping and added mass exactly when it needs to come back up, and
 * measurably kept the deck under in a large swell.
 *
 * So: identity below 1, C1-continuous at 1, gently saturating above, bounded at
 * 4/3. Smooth everywhere, calibrated where it matters, and it cannot run away.
 */
function softSaturate(r: number): number {
  if (r <= 1) return r;
  const excess = r - 1;
  return 1 + excess / (1 + 3 * excess);
}


/** A hull, and everything it carries. The generic body's whole input. */
export interface BuoyantBodyOptions {
  /** Contact stations, already built with their sections. */
  stations: ContactStation[];
  /** Every mass the body carries, structure included. */
  masses: readonly MassItem[];
  /**
   * Added mass as a multiple of displaced mass. This is vessel-specific and
   * must be supplied by the adapter.
   */
  addedMassCoefficient: number;
  /**
   * Damping ratio against the heave restoring stiffness. This is vessel-specific
   * and must be supplied by the adapter.
   *
   * This drives a *vertical* force at each station, so it damps heave directly
   * and pitch through the station's longitudinal arm. It reaches roll only
   * through the transverse arm of the immersed centroid — see
   * `rollDampingRatio`, which exists because on a hull that arm is nearly zero.
   */
  dampingRatio: number;
  /**
   * Linear roll damping, as a fraction of critical. Defaults to 0.
   *
   * WHY ROLL NEEDS ITS OWN TERM AND THE OTHER MODES DO NOT
   * -----------------------------------------------------
   * Station damping is a vertical force applied at the immersed centroid, and
   * its roll torque is that force times the centroid's *transverse* offset. The
   * Some station layouts carry real transverse arms and produce roll damping
   * directly. A centreline hull's immersed centroid may barely leave that line,
   * especially upright when roll rate peaks, so it needs an explicit moment.
   *
   * Measured on the schooner before this existed: a declared ratio of 0.18 was
   * delivering an effective **0.0011** in roll. She lost 0.7% of amplitude per
   * cycle, wound up to the ±40° limiter at resonance, and sat there. It was not
   * a tuning error; the mechanism was missing.
   *
   * So roll is damped explicitly as a moment. Zero remains a valid adapter
   * choice for bodies whose station forces already provide the required torque.
   */
  rollDampingRatio?: number;
  /**
   * Quadratic roll damping, per radian. Defaults to 0.
   *
   * Real roll damping is not linear. Radiation and skin friction are, roughly,
   * but eddy shedding off the bilges — which dominates for a hull with no bilge
   * keels — goes as `|phi_dot| * phi_dot`. That nonlinearity is the thing that
   * actually limits a vessel's roll at resonance: a purely linear model is well
   * behaved at small amplitude and then predicts a knockdown, because nothing in
   * it grows with amplitude.
   *
   * Applied as `beta * I_roll * |phi_dot| * phi_dot`.
   */
  rollQuadraticDamping?: number;
  /**
   * Whether this body advances the wave field as it substeps. Defaults to true.
   *
   * The field is shared, and advancing it is a side effect on the whole scene —
   * so exactly one body may own it. Two bodies floating on one field each
   * calling `advance` run the sea at double speed, which is a bug that hides
   * well: the water still looks like water, everything just moves too fast and
   * every body integrates against a surface that jumped twice as far as it
   * expected between substeps.
   *
   * Ownership is selected by the scene: exactly one active vessel advances a
   * shared field and any additional diagnostic bodies must opt out.
   */
  advancesWaveField?: boolean;
  /**
   * Metacentric height, metres — only used to scale `rollDampingRatio`.
   *
   * Supplied rather than computed here so the hull's GM keeps coming from the
   * one place that owns it. Omit it and the linear roll damping is zero, which
   * is what a body without explicit roll damping wants.
   */
  metacentricHeight?: number;
}

export class BuoyantBody {
  readonly stations: ContactStation[] = [];
  private readonly contactResults: HullWaterContact[] = [];
  /** Allocation-free, transient results parallel to `stations`. */
  readonly contacts: readonly HullWaterContactView[] = this.contactResults;
  readonly critical: CriticalPoint[] = [];

  /** Solved equilibrium waterline in vessel-local space, metres. */
  readonly designWaterlineY: number;
  readonly mass: number;
  readonly comX: number;
  readonly comY: number;
  readonly comZ: number;
  readonly inertiaPitch: number;
  readonly inertiaRoll: number;
  /** Dry rigid-body moment about local +Y through the centre of mass. */
  readonly inertiaYaw: number;
  readonly waterplaneArea: number;
  readonly displacedVolume: number;
  /** Mean crown height of the participating outer hull — the freeboard reference. */
  readonly outerCrownY: number;

  // --- rigid-body state ----------------------------------------------------
  comWorldY = 0;
  velocityY = 0;
  pitch = 0;
  roll = 0;
  pitchRate = 0;
  rollRate = 0;

  /** Water height directly under the vessel centre — the camera's bob reference. */
  centreWaterY = 0;
  immersedCount = 0;
  readonly overtopEvents: OvertopEvent[] = [];
  /** Batch-local pose facts paired with `OvertopEvent.batchStepIndex`. */
  private readonly substepAttitudeFacts: MutableBuoyantBodySubstepAttitude[] = [];
  /** Reused across batches so the ordinary no-water path creates no step objects. */
  private readonly substepAttitudePool: MutableBuoyantBodySubstepAttitude[] = [];
  /** Ordinal shared by the current batch's overtop and attitude facts. */
  private bodyBatchStepIndex = 0;
  lastSubsteps = 0;
  /** Vertical acceleration from the last substep, for jerk/comfort metrics. */
  accelerationY = 0;

  /**
   * External wrench on the body's three waterplane DOF, applied every
   * integration substep. The generic seam for forces that are not water:
   * sail rig wrench today; green water, towing, collision later.
   *
   * Zero-default and caller-owned: with nothing writing it, every existing
   * trajectory is bit-identical. A consumer that applies a force must write
   * all three components every substep it participates in — the body never
   * clears them, exactly like the tow bridge's velocity. Axes match the
   * station torques: vertical force in world Y, pitch torque about the
   * yaw-frame x-axis, roll torque about the yaw-frame z-axis.
   */
  readonly externalWrench = { forceYN: 0, pitchTorqueNm: 0, rollTorqueNm: 0 };
  /**
   * Cumulative work done by the external wrench on these DOF since `reset`,
   * for energy-accounting evidence. Explicit-Euler consistent: pre-step rates
   * times the step, matching how the wrench enters the integration.
   */
  externalWrenchWorkJ = 0;

  /**
   * Transient view of the current caller batch; entries are reused next batch.
   * Consumers must finish reading it before the next non-preserving `update`.
   */
  get substepAttitudes(): readonly Readonly<BuoyantBodySubstepAttitude>[] {
    return this.substepAttitudeFacts;
  }

  private readonly addedMass: number;
  private readonly damping: number;
  private readonly designVolumePerStation: number[] = [];
  private readonly designWaterplanePerStation: number[] = [];
  private readonly forceArmRollPerStation: number[] = [];
  private readonly forceArmPitchPerStation: number[] = [];
  private readonly dampingPerArea: number;
  /** Roll damping moment per unit roll rate, N·m·s. */
  private readonly rollDampingLinear: number;
  /** Roll damping moment per unit roll rate squared, N·m·s². */
  private readonly rollDampingQuadratic: number;
  private readonly advancesWaveField: boolean;
  private readonly sample: SurfaceSample = createSurfaceSample();
  private accumulator = 0;
  private settled = false;
  private previousVelocityY = 0;

  constructor(options: BuoyantBodyOptions) {
    this.stations.push(...options.stations);
    this.contactResults.push(...this.stations.map((station, stationIndex) =>
      createHullWaterContact({
        stationIndex,
        stationX: station.x,
        stationZ: station.z,
        longitudinalRegion: station.longitudinalRegion,
        transverseRegion: station.transverseRegion,
      }),
    ));
    this.forceArmRollPerStation.length = this.stations.length;
    this.forceArmPitchPerStation.length = this.stations.length;
    this.forceArmRollPerStation.fill(0);
    this.forceArmPitchPerStation.fill(0);

    let crownSum = 0;
    let crownCount = 0;
    for (const st of this.stations) {
      if (!st.outerEdge) continue;
      crownSum += st.crownY;
      crownCount++;
    }
    this.outerCrownY = crownCount ? crownSum / crownCount : 0.25;

    const items = options.masses;
    const addedMass = options.addedMassCoefficient;
    const damping = options.dampingRatio;
    this.addedMass = addedMass;
    this.damping = damping;
    let totalMass = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const it of items) {
      totalMass += it.mass;
      mx += it.mass * it.x;
      my += it.mass * it.y;
      mz += it.mass * it.z;
    }
    this.mass = totalMass;
    this.comX = mx / totalMass;
    this.comY = my / totalMass;
    this.comZ = mz / totalMass;

    let ixx = 0;
    let iyy = 0;
    let izz = 0;
    for (const it of items) {
      const dx = it.x - this.comX;
      const dy = it.y - this.comY;
      const dz = it.z - this.comZ;
      ixx += it.ixx + it.mass * (dy * dy + dz * dz);
      // Mass items are already distributed through the hull and rig. Their
      // own compact-item yaw inertia is intentionally negligible, matching
      // the existing pitch/roll mass-budget assumption.
      iyy += it.mass * (dx * dx + dz * dz);
      izz += it.izz + it.mass * (dx * dx + dy * dy);
    }

    // --- solve the equilibrium waterline -----------------------------------
    const probe = createStationImmersion();
    const volumeAt = (w: number): number => {
      let v = 0;
      for (const st of this.stations) {
        st.section.immerse(w, 0, probe);
        v += probe.volume;
      }
      return v;
    };
    // Bracket the solve with the hull's own extent rather than a constant. The
    // A fixed shallow bracket can be correct for one vessel and silently wrong for
    // anything deeper: a 2.3 m draught saturates at the top of that bracket and
    // the body floats on a seventh of its displacement, with no error raised.
    let lo = Infinity;
    let hi = -Infinity;
    for (const st of this.stations) {
      lo = Math.min(lo, st.section.floorY);
      hi = Math.max(hi, st.section.crownY);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
      throw new Error('hull has no flotation geometry to solve a waterline on');
    }
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (volumeAt(mid) * RHO_WATER < totalMass) lo = mid;
      else hi = mid;
    }
    this.designWaterlineY = (lo + hi) / 2;
    this.displacedVolume = volumeAt(this.designWaterlineY);

    let awp = 0;
    for (const st of this.stations) {
      st.section.immerse(this.designWaterlineY, 0, probe);
      this.designVolumePerStation.push(Math.max(probe.volume, 1e-9));
      this.designWaterplanePerStation.push(probe.waterplaneArea);
      awp += probe.waterplaneArea;
    }
    this.waterplaneArea = awp;

    this.inertiaPitch = ixx * (1 + addedMass);
    this.inertiaRoll = izz * (1 + addedMass);
    // The flotation model's single added-mass coefficient was derived for its
    // waterplane modes. Do not silently reuse it for manoeuvring yaw.
    this.inertiaYaw = iyy;

    // --- damping ----------------------------------------------------------
    // Expressed from the restoring stiffness, so the damping ratio is the
    // documented physical parameter rather than a magic coefficient.
    const stiffness = RHO_WATER * GRAVITY * this.waterplaneArea;
    const virtualMass = this.mass + addedMass * this.displacedVolume * RHO_WATER;
    const totalDamping = 2 * damping * Math.sqrt(stiffness * virtualMass);
    this.dampingPerArea = totalDamping / Math.max(this.waterplaneArea, 1e-6);

    // --- roll damping -------------------------------------------------------
    // `C44 = rho g V GM` is the roll restoring stiffness, and it is what turns a
    // dimensionless damping ratio into a moment coefficient.
    //
    // GM is supplied rather than re-derived here. That is deliberate: the hull's
    // metacentric height is computed in exactly one place — `hydrostatics.ts` —
    // and recomputing it from the stations would be a second implementation of
    // the same integral, free to drift from the first. The body is handed the
    // answer the hull already knows.
    const gm = Math.max(options.metacentricHeight ?? 0, 0);
    const c44 = RHO_WATER * GRAVITY * this.displacedVolume * gm;
    this.rollDampingLinear =
      2 * (options.rollDampingRatio ?? 0) * Math.sqrt(Math.max(c44, 0) * this.inertiaRoll);
    this.rollDampingQuadratic = (options.rollQuadraticDamping ?? 0) * this.inertiaRoll;
    this.advancesWaveField = options.advancesWaveField ?? true;

    this.reset();
  }

  /** Heave natural frequency, rad/s. Reported by the harness. */
  get heaveNaturalFrequency(): number {
    const stiffness = RHO_WATER * GRAVITY * this.waterplaneArea;
    const virtualMass = this.mass + this.addedMass * this.displacedVolume * RHO_WATER;
    return Math.sqrt(stiffness / virtualMass);
  }

  get dampingRatio(): number {
    return this.damping;
  }

  get addedMassCoefficient(): number {
    return this.addedMass;
  }

  /** Freeboard at the designed waterline, metres. */
  get freeboard(): number {
    return this.outerCrownY - this.designWaterlineY;
  }

  /**
   * Gradient of the water surface across the beam, in local coordinates.
   *
   * A point at local x offset `dx` from a station sits at world
   * `(X + ex·dx, Y + ey·dx, Z + ez·dx)`, where `(ex, ey, ez)` is the body's
   * local x axis in world. It is at the surface when
   *
   *     Y + ey·dx + upY·ly = W(X + ex·dx, Z + ez·dx)
   *                        ≈ W + (∂W/∂X)·ex·dx + (∂W/∂Z)·ez·dx
   *
   * so the water's local height varies linearly across the section with
   *
   *     slope = ((∂W/∂X)·ex + (∂W/∂Z)·ez − ey) / upY
   *
   * and the surface gradients come straight off the sampled normal. Two limits
   * check it: on flat water this reduces to −tan(roll), and with the body
   * upright it reduces to the wave's own transverse slope.
   */
  private waterSlopeAcrossBeam(sample: SurfaceSample, upY: number): number {
    const ny = Math.abs(sample.normalY) > 1e-6 ? sample.normalY : 1e-6;
    const dWdX = -sample.normalX / ny;
    const dWdZ = -sample.normalZ / ny;
    return (
      (dWdX * this.contactRotation.ex +
        dWdZ * this.contactRotation.ez -
        this.contactRotation.ey) /
      upY
    );
  }

  /** World-Y component of the vessel's local up axis. */
  private upY(): number {
    return Math.max(Math.cos(this.roll) * Math.cos(this.pitch), 1e-3);
  }

  /** World height of the vessel group's origin. */
  originWorldY(): number {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    // World Y of R * com. Yaw does not change the Y component.
    const comLiftY = this.comX * sr * cp - this.comZ * sp + this.comY * cr * cp;
    return this.comWorldY - comLiftY;
  }

  /** World height of the designed waterline at the vessel's centre. */
  designWaterlineWorldY(): number {
    return this.originWorldY() + this.designWaterlineY * this.upY();
  }

  /**
   * Rotate a vessel-local point into the world, relative to the centre of mass.
   * R = Ry(yaw) * Rx(pitch) * Rz(roll), matching the group's 'YXZ' Euler order.
   */
  transform(
    lx: number,
    ly: number,
    lz: number,
    yaw: number,
    out: { x: number; y: number; z: number; fx: number; fz: number },
  ): void {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const dx = lx - this.comX;
    const dy = ly - this.comY;
    const dz = lz - this.comZ;
    // Rz then Rx, giving the offset in the yaw-rotated frame.
    const ax = dx * cr - dy * sr;
    const ay = dx * sr + dy * cr;
    const fx = ax;
    const fy = ay * cp - dz * sp;
    const fz = ay * sp + dz * cp;
    out.fx = fx;
    out.fz = fz;
    out.x = fx * cy + fz * sy;
    out.y = fy;
    out.z = -fx * sy + fz * cy;
  }

  private readonly scratch = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };
  private readonly scratchB = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };
  private readonly scratchC = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };
  private readonly immersion = createStationImmersion();
  private readonly contactRotation = {
    cp: 1,
    sp: 0,
    cr: 1,
    sr: 0,
    cy: 1,
    sy: 0,
    ex: 1,
    ey: 0,
    ez: 0,
  };

  private prepareContactRotation(yaw: number): void {
    const rotation = this.contactRotation;
    rotation.cp = Math.cos(this.pitch);
    rotation.sp = Math.sin(this.pitch);
    rotation.cr = Math.cos(this.roll);
    rotation.sr = Math.sin(this.roll);
    rotation.cy = Math.cos(yaw);
    rotation.sy = Math.sin(yaw);
    rotation.ex = rotation.cr * rotation.cy + rotation.sr * rotation.sp * rotation.sy;
    rotation.ey = rotation.sr * rotation.cp;
    rotation.ez = -rotation.cr * rotation.sy + rotation.sr * rotation.sp * rotation.cy;
  }

  /** `transform`, using the rotation cached once for this contact evaluation. */
  private transformContact(
    lx: number,
    ly: number,
    lz: number,
    out: { x: number; y: number; z: number; fx: number; fz: number },
  ): void {
    const { cp, sp, cr, sr, cy, sy } = this.contactRotation;
    const dx = lx - this.comX;
    const dy = ly - this.comY;
    const dz = lz - this.comZ;
    const ax = dx * cr - dy * sr;
    const ay = dx * sr + dy * cr;
    const fx = ax;
    const fy = ay * cp - dz * sp;
    const fz = ay * sp + dz * cp;
    out.fx = fx;
    out.fz = fz;
    out.x = fx * cy + fz * sy;
    out.y = fy;
    out.z = -fx * sy + fz * cy;
  }

  /**
   * World position of a vessel-local point, given the vessel's local horizontal
   * position and heading. The single place any consumer — the renderer, the
   * markers, the harness — converts vessel space to the space the water is
   * sampled in.
   */
  worldPoint(
    lx: number,
    ly: number,
    lz: number,
    localX: number,
    localZ: number,
    yaw: number,
    out: { x: number; y: number; z: number },
  ): void {
    this.transform(lx, ly, lz, yaw, this.scratchB);
    out.x = localX + this.scratchB.x;
    out.y = this.comWorldY + this.scratchB.y;
    out.z = localZ + this.scratchB.z;
  }

  reset(): void {
    this.pitch = 0;
    this.roll = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.velocityY = 0;
    this.previousVelocityY = 0;
    this.accelerationY = 0;
    this.comWorldY = this.comY - this.designWaterlineY;
    this.accumulator = 0;
    this.overtopEvents.length = 0;
    this.substepAttitudeFacts.length = 0;
    this.bodyBatchStepIndex = 0;
    this.settled = false;
    this.externalWrench.forceYN = 0;
    this.externalWrench.pitchTorqueNm = 0;
    this.externalWrench.rollTorqueNm = 0;
    this.externalWrenchWorkJ = 0;
  }

  /**
   * Place the body directly on the local water plane with no dynamics, by
   * fitting a plane through the stations. Used on load so there is no settling
   * transient, and by the harness's frozen-wave parity test.
   *
   * The fit is centred on the *footprint centroid*, not on the centre of mass.
   * Offsets taken about the centre of mass do not sum to zero — the seated
   * figure pulls the COM 0.10 m forward — so a fit without an intercept leaks
   * the mean water height into the slope. At this footprint that was several
   * degrees of pure artefact, proportional to whatever the sea happened to be
   * doing at t = 0.
   */
  snapToSurface(waves: WaveField, localX: number, localZ: number, yaw: number): void {
    this.pitch = 0;
    this.roll = 0;
    this.pitchRate = 0;
    this.rollRate = 0;
    this.velocityY = 0;

    const n = this.stations.length;
    let centroidX = 0;
    let centroidZ = 0;
    for (const st of this.stations) {
      centroidX += st.x;
      centroidZ += st.z;
    }
    centroidX /= n;
    centroidZ /= n;

    const heights: number[] = [];
    let sumH = 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    for (const st of this.stations) {
      const dx = st.x - this.comX;
      const dz = st.z - this.comZ;
      const h = waves.sampleHeight(localX + dx * cy + dz * sy, localZ - dx * sy + dz * cy);
      heights.push(h);
      sumH += h;
    }
    const meanH = sumH / n;

    let sumXH = 0;
    let sumZH = 0;
    let sumX2 = 0;
    let sumZ2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = this.stations[i].x - centroidX;
      const dz = this.stations[i].z - centroidZ;
      const dh = heights[i] - meanH;
      sumXH += dx * dh;
      sumZH += dz * dh;
      sumX2 += dx * dx;
      sumZ2 += dz * dz;
    }
    this.roll = Math.atan(sumXH / Math.max(sumX2, 1e-6));
    this.pitch = -Math.atan(sumZH / Math.max(sumZ2, 1e-6));

    const originY = meanH - this.designWaterlineY * this.upY();
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    this.comWorldY = originY + (this.comX * sr * cp - this.comZ * sp + this.comY * cr * cp);
    this.settled = true;
    this.accumulator = 0;
  }

  /**
   * Advance the body by `dt` seconds using fixed substeps.
   *
   * The wave field is advanced *inside* the loop, so every substep evaluates
   * the surface that actually exists at that instant. The caller must treat
   * `waves.time` as authoritative afterwards and render the ocean at that time,
   * which is what keeps CPU and GPU exactly in step.
   */
  update(
    dt: number,
    waves: WaveField,
    localX: number,
    localZ: number,
    yaw: number,
    stepOverride?: number,
    observerVelocityX = 0,
    observerVelocityZ = 0,
    preserveBatchFacts = false,
  ): void {
    const step = Math.max(stepOverride ?? PHYSICS_STEP, 1 / 1000);
    // A composed outer integrator may call this once per fixed horizontal step.
    // It clears at the caller boundary, then preserves event and attitude
    // facts across those individual calls so a four-substep presentation frame
    // does not retain only its final quarter.
    if (!preserveBatchFacts) {
      this.overtopEvents.length = 0;
      this.substepAttitudeFacts.length = 0;
      this.bodyBatchStepIndex = 0;
    }

    if (!this.settled) {
      this.snapToSurface(waves, localX, localZ, yaw);
      this.refreshDiagnostics(
        waves,
        localX,
        localZ,
        yaw,
        observerVelocityX,
        observerVelocityZ,
      );
      return;
    }

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < MAX_SUBSTEPS) {
      if (this.advancesWaveField) {
        waves.advance(
          step,
          observerVelocityX,
          observerVelocityZ,
        );
      }
      this.integrate(
        step,
        waves,
        localX,
        localZ,
        yaw,
        observerVelocityX,
        observerVelocityZ,
      );
      this.accumulator -= step;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    this.lastSubsteps = steps;

    this.refreshDiagnostics(
      waves,
      localX,
      localZ,
      yaw,
      observerVelocityX,
      observerVelocityZ,
    );
  }

  /**
   * Populate the permanent contact-result buffer for one simulation instant.
   *
   * This is the only dynamic water/hull sampling path. The integrator consumes
   * it immediately during fixed substeps; after the final substep it is run once
   * more so diagnostics and future continuous effects describe the pose being
   * rendered. No contact object or vector is allocated here.
   */
  private evaluateContacts(
    waves: WaveField,
    localX: number,
    localZ: number,
    yaw: number,
    observerVelocityX: number,
    observerVelocityZ: number,
  ): void {
    const upY = this.upY();
    this.prepareContactRotation(yaw);
    const { cy, sy } = this.contactRotation;
    let immersed = 0;

    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i];
      const contact = this.contactResults[i];

      this.transformContact(st.x, 0, st.z, this.scratch);
      const stationArmPitch = this.scratch.fz;
      const worldX = localX + this.scratch.x;
      const worldY = this.comWorldY + this.scratch.y;
      const worldZ = localZ + this.scratch.z;

      contact.stationReferenceWorld.x = worldX;
      contact.stationReferenceWorld.y = worldY;
      contact.stationReferenceWorld.z = worldZ;

      waves.sample(worldX, worldZ, this.sample);
      contact.waterSurfaceWorld.x = worldX;
      contact.waterSurfaceWorld.y = this.sample.height;
      contact.waterSurfaceWorld.z = worldZ;
      contact.surfaceNormalWorld.x = this.sample.normalX;
      contact.surfaceNormalWorld.y = this.sample.normalY;
      contact.surfaceNormalWorld.z = this.sample.normalZ;
      contact.waterVelocityWorldMps.x = this.sample.velocityX;
      contact.waterVelocityWorldMps.y = this.sample.velocityY;
      contact.waterVelocityWorldMps.z = this.sample.velocityZ;

      const waterLocal = (this.sample.height - worldY) / upY;
      st.section.immerse(
        waterLocal,
        this.waterSlopeAcrossBeam(this.sample, upY),
        this.immersion,
      );

      const volume = this.immersion.volume;
      const designImmersionRatio = volume / this.designVolumePerStation[i];
      contact.immersedVolumeM3 = volume;
      contact.designImmersionRatio = designImmersionRatio;
      contact.isWet = volume > 1e-6;
      if (contact.isWet) immersed++;

      contact.forcePointLocal.x = this.immersion.centroidX;
      contact.forcePointLocal.y = this.immersion.centroidY;
      contact.forcePointLocal.z = st.z;
      this.transformContact(
        contact.forcePointLocal.x,
        contact.forcePointLocal.y,
        contact.forcePointLocal.z,
        this.scratchC,
      );
      contact.forcePointWorld.x = localX + this.scratchC.x;
      contact.forcePointWorld.y = this.comWorldY + this.scratchC.y;
      contact.forcePointWorld.z = localZ + this.scratchC.z;

      this.forceArmRollPerStation[i] = this.scratchC.fx;
      // Preserve the established vertical-force moment arm exactly. The
      // existing response uses the station's longitudinal reference rather
      // than allowing immersed-centroid height to perturb the pitch arm.
      this.forceArmPitchPerStation[i] = stationArmPitch;

      // Angular point velocity in the yaw-rotated frame, from
      // omega=(pitchRate, 0, rollRate) crossed with the centroid arm.
      const rotationVelocityFrameX = -this.rollRate * this.scratchC.y;
      const rotationVelocityY =
        this.rollRate * this.scratchC.fx - this.pitchRate * this.scratchC.fz;
      const rotationVelocityFrameZ = this.pitchRate * this.scratchC.y;
      contact.hullPointVelocityWorldMps.x =
        observerVelocityX +
        rotationVelocityFrameX * cy +
        rotationVelocityFrameZ * sy;
      contact.hullPointVelocityWorldMps.y = this.velocityY + rotationVelocityY;
      contact.hullPointVelocityWorldMps.z =
        observerVelocityZ -
        rotationVelocityFrameX * sy +
        rotationVelocityFrameZ * cy;

      contact.relativeWaterVelocityWorldMps.x =
        contact.waterVelocityWorldMps.x - contact.hullPointVelocityWorldMps.x;
      contact.relativeWaterVelocityWorldMps.y =
        contact.waterVelocityWorldMps.y - contact.hullPointVelocityWorldMps.y;
      contact.relativeWaterVelocityWorldMps.z =
        contact.waterVelocityWorldMps.z - contact.hullPointVelocityWorldMps.z;
      contact.normalEntrySpeedMps = Math.max(
        0,
        contact.relativeWaterVelocityWorldMps.x * contact.surfaceNormalWorld.x +
          contact.relativeWaterVelocityWorldMps.y * contact.surfaceNormalWorld.y +
          contact.relativeWaterVelocityWorldMps.z * contact.surfaceNormalWorld.z,
      );

      // Keep the old damping/overtopping vertical kinematics byte-for-byte:
      // roll uses the immersed centroid's transverse arm while pitch uses the
      // station reference above. The complete force-point velocity is exposed
      // separately and does not retune the response merely by existing.
      const responsePointVelocityY =
        this.velocityY +
        this.rollRate * this.forceArmRollPerStation[i] -
        this.pitchRate * this.forceArmPitchPerStation[i];
      contact.verticalEntrySpeedMps = this.sample.velocityY - responsePointVelocityY;

      const dampingWetness = softSaturate(designImmersionRatio);
      contact.buoyancyForceN = RHO_WATER * GRAVITY * volume;
      contact.dampingForceN =
        this.dampingPerArea *
        this.designWaterplanePerStation[i] *
        dampingWetness *
        contact.verticalEntrySpeedMps;

      const waterlineWorldY = worldY + this.designWaterlineY * upY;
      contact.waterlineClearanceM =
        (waterlineWorldY - this.sample.height) * this.sample.normalY;
      contact.crownWorldY = worldY + st.crownY * upY;
      contact.overtopping =
        this.sample.height > contact.crownWorldY &&
        contact.verticalEntrySpeedMps > 0.05;

      this.populateWaterlineContact(
        contact.portWaterline,
        this.immersion.waterlineContactCount > 0,
        this.immersion.waterlinePortX,
        this.immersion.waterlinePortY,
        st.z,
        localX,
        localZ,
      );
      this.populateWaterlineContact(
        contact.starboardWaterline,
        this.immersion.waterlineContactCount > 0,
        this.immersion.waterlineStarboardX,
        this.immersion.waterlineStarboardY,
        st.z,
        localX,
        localZ,
      );
    }

    this.immersedCount = immersed;
  }

  private populateWaterlineContact(
    contact: HullWaterContact['portWaterline'],
    active: boolean,
    localContactX: number,
    localContactY: number,
    localContactZ: number,
    localX: number,
    localZ: number,
  ): void {
    contact.active = active;
    if (!active) return;
    contact.localPoint.x = localContactX;
    contact.localPoint.y = localContactY;
    contact.localPoint.z = localContactZ;
    this.transformContact(localContactX, localContactY, localContactZ, this.scratchB);
    contact.worldPoint.x = localX + this.scratchB.x;
    contact.worldPoint.y = this.comWorldY + this.scratchB.y;
    contact.worldPoint.z = localZ + this.scratchB.z;
  }

  private integrate(
    h: number,
    waves: WaveField,
    localX: number,
    localZ: number,
    yaw: number,
    observerVelocityX: number,
    observerVelocityZ: number,
  ): void {
    const batchStepIndex = this.bodyBatchStepIndex++;
    this.recordSubstepAttitude(batchStepIndex, h);
    let force = -this.mass * GRAVITY;
    let torquePitch = 0;
    let torqueRoll = 0;
    let wetVolume = 0;
    this.evaluateContacts(
      waves,
      localX,
      localZ,
      yaw,
      observerVelocityX,
      observerVelocityZ,
    );

    for (let i = 0; i < this.contactResults.length; i++) {
      const contact = this.contactResults[i];
      const station = this.stations[i];
      const total = contact.buoyancyForceN + contact.dampingForceN;
      force += total;
      torquePitch += -this.forceArmPitchPerStation[i] * total;
      torqueRoll += this.forceArmRollPerStation[i] * total;

      wetVolume += contact.immersedVolumeM3;

      // Overtopping: the crest must clear the timber crown AND be entering the
      // vessel, so a static render mismatch cannot trigger it.
      //
      // Checked at *every* station, not only the outer columns. Water comes
      // aboard over an edge, but it washes across the deck, and a crest that
      // buries the middle of the vessel with nothing drawn is exactly the silent
      // intersection this cue exists to prevent.
      if (contact.overtopping) {
        const flowX = contact.waterVelocityWorldMps.x - observerVelocityX;
        const flowZ = contact.waterVelocityWorldMps.z - observerVelocityZ;
        // Schooner sections represent the whole transverse hull and therefore
        // carry `centre` here. Resolve their one entering rail from inboard
        // horizontal flow in the vessel's beam axis. At an exact horizontal
        // tie, heel selects the low rail; a level tie canonically selects
        // starboard. Point-like raft columns already name their physical side.
        const localFlowX =
          flowX * this.contactRotation.ex + flowZ * this.contactRotation.ez;
        const boardingSide =
          station.transverseRegion === 'starboard' ||
          (station.transverseRegion === 'centre' &&
            (localFlowX > 1e-9 ||
              (Math.abs(localFlowX) <= 1e-9 && this.roll >= 0)))
            ? 'starboard'
            : 'port';
        this.overtopEvents.push({
          x: contact.stationReferenceWorld.x,
          y: contact.crownWorldY,
          z: contact.stationReferenceWorld.z,
          speed: contact.verticalEntrySpeedMps,
          depth: contact.waterSurfaceWorld.y - contact.crownWorldY,
          durationSeconds: h,
          contactWidthM: station.overtopContactWidthM,
          tributaryAreaM2: station.overtopTributaryAreaM2,
          stationIndex: i,
          batchStepIndex,
          stationLocalZ: station.z,
          boardingSide,
          // Flow as experienced aboard. The hull remains at the render origin,
          // so its horizontal velocity is supplied as motion of the observer
          // through wave coordinates rather than as a kilometre-scale mesh
          // translation.
          flowX,
          flowZ,
        });
      }
    }

    // Added mass scales with how much hull is actually wet, so a vessel
    // momentarily clear of the surface falls under gravity alone.
    const wetFraction = softSaturate(wetVolume / Math.max(this.displacedVolume, 1e-9));
    const virtualMass = this.mass + this.addedMass * this.displacedVolume * RHO_WATER * wetFraction;

    // Explicit roll damping, because the station forces above cannot deliver it
    // on a centreline hull — see `rollDampingRatio`. Scaled by how much hull is
    // wet, on the same argument as added mass: a body clear of the surface is
    // not being damped by water it is not touching.
    if (this.rollDampingLinear > 0 || this.rollDampingQuadratic > 0) {
      const w = this.rollRate;
      torqueRoll -=
        (this.rollDampingLinear * w + this.rollDampingQuadratic * Math.abs(w) * w) * wetFraction;
    }

    // The external wrench enters beside the water forces, once per substep.
    const wrench = this.externalWrench;
    force += wrench.forceYN;
    torquePitch += wrench.pitchTorqueNm;
    torqueRoll += wrench.rollTorqueNm;
    this.externalWrenchWorkJ +=
      (wrench.forceYN * this.velocityY +
        wrench.pitchTorqueNm * this.pitchRate +
        wrench.rollTorqueNm * this.rollRate) *
      h;

    this.previousVelocityY = this.velocityY;
    this.velocityY += (force / virtualMass) * h;
    this.pitchRate += (torquePitch / this.inertiaPitch) * h;
    this.rollRate += (torqueRoll / this.inertiaRoll) * h;
    this.accelerationY = (this.velocityY - this.previousVelocityY) / h;

    // Safety net only. The buoyancy of a fully submerged hull is bounded at
    // under 2x the weight, so these are unreachable in normal operation; they
    // exist so a pathological preset cannot produce NaNs.
    this.velocityY = clamp(
      this.velocityY,
      -HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND,
      HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND,
    );
    this.pitchRate = clamp(
      this.pitchRate,
      -HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
      HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
    );
    this.rollRate = clamp(
      this.rollRate,
      -HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
      HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
    );

    this.comWorldY += this.velocityY * h;
    this.pitch = clamp(
      this.pitch + this.pitchRate * h,
      -HULL_ATTITUDE_LIMIT_RADIANS,
      HULL_ATTITUDE_LIMIT_RADIANS,
    );
    this.roll = clamp(
      this.roll + this.rollRate * h,
      -HULL_ATTITUDE_LIMIT_RADIANS,
      HULL_ATTITUDE_LIMIT_RADIANS,
    );
  }

  private recordSubstepAttitude(
    batchStepIndex: number,
    durationSeconds: number,
  ): void {
    let fact = this.substepAttitudePool[batchStepIndex];
    if (!fact) {
      fact = {
        batchStepIndex,
        durationSeconds,
        pitchRad: this.pitch,
        rollRad: this.roll,
      };
      this.substepAttitudePool[batchStepIndex] = fact;
    } else {
      fact.batchStepIndex = batchStepIndex;
      fact.durationSeconds = durationSeconds;
      fact.pitchRad = this.pitch;
      fact.rollRad = this.roll;
    }
    this.substepAttitudeFacts.push(fact);
  }

  /**
   * Recompute the reported quantities for the instant that is about to be
   * drawn. Diagnostics must describe the rendered frame, not the last
   * intermediate substep.
   */
  private refreshDiagnostics(
    waves: WaveField,
    localX: number,
    localZ: number,
    yaw: number,
    observerVelocityX: number,
    observerVelocityZ: number,
  ): void {
    this.centreWaterY = waves.sampleHeight(localX, localZ);
    this.evaluateContacts(
      waves,
      localX,
      localZ,
      yaw,
      observerVelocityX,
      observerVelocityZ,
    );

    for (const point of this.critical) {
      this.transform(point.x, point.y, point.z, yaw, this.scratch);
      point.worldX = localX + this.scratch.x;
      point.worldZ = localZ + this.scratch.z;
      point.worldY = this.comWorldY + this.scratch.y;
      point.clearance = point.worldY - waves.sampleHeight(point.worldX, point.worldZ);
    }
  }

  /** Register a point that must stay dry, in vessel-local coordinates. */
  addCriticalPoint(name: string, x: number, y: number, z: number): void {
    this.critical.push({ name, x, y, z, clearance: 0, worldX: 0, worldY: 0, worldZ: 0 });
  }
}
