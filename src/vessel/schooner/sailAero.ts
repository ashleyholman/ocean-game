import { DESIGN_DRAUGHT } from './hullForm';
import {
  AUTHORED_TRIM_RAD,
  RIG_TRIM_LIMITS,
  SAILS,
  SPARS,
  liveSailCorners,
  sparLength,
  type MutableRigPoint,
  type RigHoistFractions,
  type RigPoint,
  type RigTrimAnglesRad,
  type Sail,
  type SailName,
} from './rig';

/**
 * Sail aerodynamics for the canonical schooner — pure maths, like `rig.ts`.
 *
 * This module derives every sail's aerodynamic geometry (area, centre of
 * effort, leeward normal) from the rig's authored corner nodes at module load,
 * and evaluates per-sail quasi-steady forces per physics substep. It is a
 * **transparent game-model baseline** in the same spirit as
 * `SchoonerResistance`: explicit provisional coefficients, no claim of wind-
 * tunnel data, every term separately inspectable in evidence output.
 *
 * ONE GEOMETRY TRUTH
 * ------------------
 * Areas and centres of effort come from the same corner nodes the renderer
 * lofts cloth between (`rigNode`, `SAILS`), and the leeward normal is the
 * *drawn belly direction*: the same bilinear-patch centre normal
 * `normalize(cu × cv) · side` that `rigGeometry.ts`'s `sailSurface` displaces
 * cloth along. If the drawn sail bellies one way, the physics pushes the same
 * way, by construction rather than by parallel bookkeeping.
 *
 * COORDINATES AND SIGNS
 * ---------------------
 * Sail geometry lives in model coordinates (+x port, +z bow, y up — the
 * `hullForm.ts` COORDINATES block). Force evaluation rotates the apparent
 * wind into the *attitude frame* (model axes carried through roll and pitch),
 * so lift naturally tilts as she heels and drive sags — no ad-hoc cosine
 * corrections. The wrench is split once, here (design §6.2): horizontal world
 * force + yaw moment for `SchoonerHorizontalDynamics`, vertical force +
 * pitch/roll torque (yaw-frame axes, matching `BuoyantBody`'s station
 * torques) for the `BuoyantBody` external-wrench seam. The yaw moment is
 * taken about the vertical through the centre of mass; the loaded LCG is
 * solved onto LCB, so this is the same reference the resistance model uses.
 *
 * Sign conventions are pinned by `tests/ship-sailing-aero.test.ts`, not by
 * this comment.
 *
 * THE FROZEN-TRIM CONTRACT (S2)
 * -----------------------------
 * The rig nodes are authored at fixed trim (`SHEET_*`, `BRACE_ANGLE` baked
 * into the coordinates), drawn on the **starboard tack** — booms and bellies
 * to port. This round consumes that geometry as-is: trim is frozen, sails are
 * set/furled/reefed by configuration only. The `tack` input selects the
 * authored geometry or its exact x-mirror, which is what "the same trim on
 * the other tack" means for a symmetric rig. Live trim arrives in S4, when
 * `rig.ts`'s constants become functions of control state.
 */

/** Air density at sea level, kg/m³. */
export const RHO_AIR = 1.225;

/**
 * Explicit provisional coefficients — the aero counterpart of
 * `SCHOONER_RESISTANCE_COEFFICIENTS`. Nothing here is tank or tunnel data;
 * each number is a stated game-model assumption, kept separate so later
 * reference data can replace one term without hiding a retune.
 */
export const SAIL_AERO_COEFFICIENTS = Object.freeze({
  /** Angle of attack at maximum lift, degrees (design §6.1: 25–30°). */
  aoaPeakDeg: 27,
  /**
   * Soft-stall shape: CL falls from CLmax at the peak to `stallFloor · CLmax`
   * at 90° along a half-cosine — soft, C1 at the peak, never negative.
   */
  stallFloor: 0.1,
  /** Luffing collapse band, degrees of AoA: fully collapsed at and below
   * `luffEndDeg − luffBandDeg`, fully attached at `luffEndDeg`. */
  luffEndDeg: 10,
  luffBandDeg: 6,
  /**
   * Negative AoA at which a backed sail is fully filled on its other face
   * (S6c, FINDING S4-2). The cloth has used this number since M6 to decide
   * how far the belly has inverted; the aero now reads the same one to
   * decide how much lift that inverted belly carries, so the picture and
   * the coefficient cannot disagree about whether a sail is aback.
   */
  abackFullDeg: 12,
  /** Drag coefficient of collapsed, shivering cloth (bare-pole-ish). */
  cdLuffing: 0.05,
  /**
   * Span efficiency `e` in the induced-drag term CL²/(π·AR·e).
   *
   * THE ONE NUMBER IN THIS ROUND THAT IS NOT DERIVED, AND IT IS SAID PLAINLY
   * ----------------------------------------------------------------------
   * `AR_eff` below is solved from the rig's own corners every substep; `e`
   * is a stated constant. It prices everything the lifting-line ideal does
   * not have: loading that is nowhere near elliptic, the twist the M6 cloth
   * draws, a mast or a stay standing in the luff, and eight surfaces sharing
   * one wake. 0.85 is the conventional working value for a real sail and it
   * sits deliberately *below* `SCHOONER_RUDDER_COEFFICIENTS.oswaldEfficiency`
   * (0.90), which prices a clean, rigid, untwisted blade.
   *
   * It was chosen and written down BEFORE the first polar was solved with
   * the induced term in, and it was not touched afterwards. Deriving it
   * honestly means a Glauert planform solve per sail (the chord distribution
   * is available from the same corners `AR_eff` reads) and is worth of order
   * 5% on the induced term; it is named as owed work in the round handover
   * rather than smuggled in as a dial.
   */
  spanEfficiency: 0.85,
  /**
   * How many spans of gap spend the sea's mirror, in `1/(1 + k·gap/span)`.
   *
   * A sail standing over the sea reflects in it, and a sail whose foot
   * touched the water would be one half of a wing of twice the aspect ratio
   * — the textbook image. Every foot aboard stands clear of the water, flow
   * leaks across the gap, and the mirror is spent. `k = 2` says the gain is
   * half gone when the foot stands half a span above the sea, which is the
   * same "partial end plate" the rudder is already priced with (geometric
   * 3.4 raised to 5.1 against the hull). The two limits are what matter and
   * both are right: gap 0 doubles the aspect ratio, a sail high in the air
   * keeps its own.
   */
  imageGapSpans: 2,
  /**
   * Crude downwind blanketing (design §6.1): a sail dead down-apparent-wind
   * of a drawing sail loses this fraction of its dynamic pressure. One
   * coefficient, honestly labeled; no slot effect.
   */
  blanketingLoss: 0.5,
  /** Blanketing cone: zero effect outside ~25° alignment, full inside ~10°. */
  blanketingConeCosOuter: Math.cos((25 * Math.PI) / 180),
  blanketingConeCosInner: Math.cos((10 * Math.PI) / 180),
  /** Drag coefficient for the lumped bare-pole spar windage. */
  windageCd: 1.0,
  /**
   * Reef hoist reductions: the head comes down by this fraction of the
   * sail's height, the freed cloth bundling on the boom. Area and CoE are
   * then *derived* from the shrunk corners, not scaled by a second guess.
   */
  reefHoistFraction: Object.freeze({ reef1: 0.25, reef2: 0.45 }),
} as const);

/** Lift/drag curve family per sail type (design §6.1). */
export interface SailAeroFamily {
  /** CLmax = clMaxBase + clMaxPerCamber · camber. */
  readonly clMaxBase: number;
  readonly clMaxPerCamber: number;
  /** Parasitic drag at zero AoA. */
  readonly cd0: number;
  /** Flat-on drag at 90° AoA. */
  readonly cd90: number;
}

export const SAIL_AERO_FAMILIES = Object.freeze({
  /** Boomed gaff sails — the workhorses. Camber 0.085 → CLmax ≈ 1.19. */
  boomGaff: Object.freeze({ clMaxBase: 0.55, clMaxPerCamber: 7.5, cd0: 0.05, cd90: 1.1 }),
  /** Stayed triangular headsails. Camber 0.07 → CLmax ≈ 1.08. */
  headsail: Object.freeze({ clMaxBase: 0.55, clMaxPerCamber: 7.5, cd0: 0.04, cd90: 1.0 }),
  /** The square topsail: drag-dominant off the wind, CD ≈ 1.2 square-on. */
  square: Object.freeze({ clMaxBase: 0.35, clMaxPerCamber: 7.5, cd0: 0.05, cd90: 1.2 }),
} as const);

export type SailAeroFamilyName = keyof typeof SAIL_AERO_FAMILIES;

const FAMILY_BY_SAIL: Readonly<Record<SailName, SailAeroFamilyName>> = Object.freeze({
  mainsail: 'boomGaff',
  foresail: 'boomGaff',
  foreStaysail: 'headsail',
  jib: 'headsail',
  flyingJib: 'headsail',
  foreTopsail: 'square',
  mainTopmastStaysail: 'headsail',
  mainGaffTopsail: 'boomGaff',
});

// --- how full the cloth actually is (M6 ↔ aero, one derivation) --------------

/**
 * The two numbers that say how a sail's *shape* answers its sheet.
 *
 * They used to live in `rigGeometry.CLOTH_CUTS` and be read only by the loft,
 * which is how the M6 round could give the drawn cloth a live camber while
 * `sailClMax` went on reading `Sail.camber`, the number the sail was designed
 * at. The picture and the coefficient then disagreed about how full every
 * sail was — SHIP_RIG_HANDOVER §11.6. They are here now because the physics
 * has to read them, and the loft reads them from here: one table, two
 * consumers, the same discipline `sailLeewardNormal` is under.
 *
 * The rest of `ClothCut` stayed behind, because the rest of it genuinely is
 * about drawing — where the draft peaks, how far a leech falls off, how big
 * the flogging wave is. These two are about how much air the sail bends.
 */
export interface SailClothShape {
  /** How much of the draft a fully hardened sheet takes out. */
  readonly flatten: number;
  /** Aback belly as a fraction of the drawing draft. */
  readonly aback: number;
}

export const SAIL_CLOTH_SHAPE: Readonly<Record<SailName, SailClothShape>> =
  Object.freeze({
    mainsail: Object.freeze({ flatten: 0.35, aback: 0.35 }),
    foresail: Object.freeze({ flatten: 0.35, aback: 0.35 }),
    foreStaysail: Object.freeze({ flatten: 0.4, aback: 0.4 }),
    jib: Object.freeze({ flatten: 0.4, aback: 0.4 }),
    flyingJib: Object.freeze({ flatten: 0.4, aback: 0.4 }),
    /**
     * `aback` is the small number in this table on purpose: measured, the
     * square topsail's flat patch clears the fore topmast by 0.094 m, so a
     * backed square sail lies against the mast and top rather than bagging
     * aft. It is also the sail FINDING S5-3 says she carries aback on every
     * beat, so 0.10 is now a *physics* number as well as a drawn one — it
     * says how much lift that sail carries the wrong way all the way up a
     * beat.
     */
    foreTopsail: Object.freeze({ flatten: 0.3, aback: 0.1 }),
    mainTopmastStaysail: Object.freeze({ flatten: 0.35, aback: 0.3 }),
    mainGaffTopsail: Object.freeze({ flatten: 0.35, aback: 0.25 }),
  });

/**
 * A fore-and-aft sail crossing the centreline flattens and refills on the
 * other face; the drawn camber ramps to zero across this many degrees of
 * trim either side of amidships so the belly never pops sides.
 */
export const CAMBER_RAMP_DEG = 5;

/** The centreline camber ramp: 0 amidships, 1 beyond `CAMBER_RAMP_DEG`. */
export function sailCamberScale(name: SailName, trimDeg: number): number {
  // The square topsail's cloth rotates with its yard and never crosses.
  if (name === 'foreTopsail') return 1;
  return Math.min(Math.abs(trimDeg) / CAMBER_RAMP_DEG, 1);
}

/**
 * How hard this sheet is in, 1 flat and 0 eased to the mechanical stop.
 *
 * Derived from `RIG_TRIM_LIMITS` — the rig's own geometry — rather than from
 * the crew's working floor, so both the cloth and the coefficient answer the
 * sheet and not a policy that might be retuned underneath them.
 */
export function sailSheetHardness(name: SailName, trimDeg: number): number {
  const key = name === 'mainGaffTopsail' ? 'mainsail' : name;
  const limits = RIG_TRIM_LIMITS[key];
  const span = Math.max(Math.abs(limits.minDeg), Math.abs(limits.maxDeg));
  if (!(span > 0)) return 1;
  return 1 - Math.min(Math.abs(trimDeg) / span, 1);
}

/**
 * The camber the cloth is actually cut and sheeted to at this trim — the
 * number `sailClMax` reads.
 *
 * NO FLOW IN HERE, DELIBERATELY. The drawn draft is
 * `shape · fill · (attach − abackFill · aback)`; the flow half of that
 * product is *already* in the aero as the attachment gate on CL and as the
 * dynamic pressure, so folding it in twice would price a luffing sail's
 * collapse twice over. What was missing was the shape half — the centreline
 * ramp and the flattening a hard sheet does — and that is exactly what this
 * returns.
 */
export function sailShapeCamber(
  name: SailName,
  designCamber: number,
  trimDeg: number,
): number {
  return (
    designCamber *
    sailCamberScale(name, trimDeg) *
    (1 - SAIL_CLOTH_SHAPE[name].flatten * sailSheetHardness(name, trimDeg))
  );
}

/**
 * The camber a backed sail takes on its other face — the drawing shape times
 * this sail's aback fraction, sign carried by the lift, not by the depth.
 *
 * The loft's aback belly is `camberScale · aback` WITHOUT the flattening
 * term, and this matches it exactly rather than being more coherent than it:
 * the point of the round is that the coefficient reads the drawn cloth, and
 * the drawn cloth is what it is. Deliberately no pixels move here.
 */
export function sailAbackCamber(
  name: SailName,
  designCamber: number,
  trimDeg: number,
): number {
  return (
    designCamber * sailCamberScale(name, trimDeg) * SAIL_CLOTH_SHAPE[name].aback
  );
}

export type SailSetState = 'set' | 'reef1' | 'reef2' | 'furled';

/** Which set states each sail actually has (design §5.1). */
export const VALID_SET_STATES: Readonly<Record<SailName, readonly SailSetState[]>> =
  Object.freeze({
    mainsail: ['set', 'reef1', 'reef2', 'furled'],
    foresail: ['set', 'reef1', 'furled'],
    foreStaysail: ['set', 'furled'],
    jib: ['set', 'furled'],
    flyingJib: ['set', 'furled'],
    foreTopsail: ['set', 'furled'],
    mainTopmastStaysail: ['set', 'furled'],
    mainGaffTopsail: ['set', 'furled'],
  });

/** The S2 canvas configuration: per-sail set state, trim frozen. */
export type CanvasState = Readonly<Record<SailName, SailSetState>>;

export const FULL_SAIL: CanvasState = Object.freeze({
  mainsail: 'set',
  foresail: 'set',
  foreStaysail: 'set',
  jib: 'set',
  flyingJib: 'set',
  foreTopsail: 'set',
  mainTopmastStaysail: 'set',
  mainGaffTopsail: 'set',
}) as CanvasState;

/** The kites struck — what a crew carries once the breeze means business. */
export const WORKING_SAIL: CanvasState = Object.freeze({
  mainsail: 'set',
  foresail: 'set',
  foreStaysail: 'set',
  jib: 'set',
  flyingJib: 'set',
  foreTopsail: 'set',
  mainTopmastStaysail: 'furled',
  mainGaffTopsail: 'furled',
}) as CanvasState;

/**
 * What she carries close-hauled once somebody has looked aloft: the working
 * canvas with the SQUARE TOPSAIL HANDED.
 *
 * A square sail cannot be braced to draw on a beat — her braces stop at 22°
 * (`RIG_TRIM_LIMITS`, the backstays) and the apparent wind is 40° forward of
 * that — so close-hauled it stands aback and is a brake, which is why square
 * topsails come in first when beating. Until the S6c coefficient round an
 * aback sail carried nothing at all and the point was invisible; it is now
 * measured at −1.6 kN of drive at 60° true in 8 m/s, and this canvas exists
 * so the polar can say what she does WITHOUT that sea anchor as well as with
 * it. It is also, measured, what S6's navigator does: the hand at the yard
 * reports `cannot draw` and the topsail is handed 4.0 s later.
 */
export const BEATING_SAIL: CanvasState = Object.freeze({
  mainsail: 'set',
  foresail: 'set',
  foreStaysail: 'set',
  jib: 'set',
  flyingJib: 'set',
  foreTopsail: 'furled',
  mainTopmastStaysail: 'furled',
  mainGaffTopsail: 'furled',
}) as CanvasState;

/**
 * Snugged down: kites and light headsail in, a reef in each gaff sail.
 *
 * The order matters and is the order a crew works in — the topsail and
 * fisherman come off first, then the flying jib, and only then does anyone tie
 * a reef in. Stated as a destination rather than a sequence because
 * `SailingControls` already prices and interlocks each evolution; commanding
 * this plan is commanding the whole job, and it takes the crew minutes.
 */
export const REEFED_SAIL: CanvasState = Object.freeze({
  mainsail: 'reef1',
  foresail: 'reef1',
  foreStaysail: 'set',
  jib: 'set',
  flyingJib: 'furled',
  foreTopsail: 'furled',
  mainTopmastStaysail: 'furled',
  mainGaffTopsail: 'furled',
}) as CanvasState;

export const BARE_POLES: CanvasState = Object.freeze({
  mainsail: 'furled',
  foresail: 'furled',
  foreStaysail: 'furled',
  jib: 'furled',
  flyingJib: 'furled',
  foreTopsail: 'furled',
  mainTopmastStaysail: 'furled',
  mainGaffTopsail: 'furled',
}) as CanvasState;

/**
 * The tack a frozen-trim configuration is set for. 'starboard' is the
 * authored geometry (wind over the starboard side, booms to port); 'port'
 * is its exact mirror. With live trim (S4) the tack is emergent — the sign
 * of each trim says where the cloth is — and this type survives as the
 * fixture vocabulary of the S2/S3 evidence and its harness.
 */
export type TackSide = 'starboard' | 'port';

/**
 * One sail's live rig state — what the aero consumes per substep (S4).
 * `label` is telemetry vocabulary only; the physics reads the two numbers.
 */
export interface SailAeroSailState {
  label: SailSetState;
  /** Continuous hoist in [0, 1]; set = 1, reefs at their fixed points, furled = 0. */
  hoistFraction: number;
  /** Trim, degrees, positive toward +x/port (the authored side's sign). */
  trimDeg: number;
}

/** Below this hoist there is no cloth worth evaluating (or lofting). */
export const HOIST_EPSILON = 0.02;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// --- geometry derivation, once at module load --------------------------------

/** Corners as the loft patch orders them; a triangle doubles its head. */
function quadCorners(points: readonly RigPoint[]): [Vec3, Vec3, Vec3, Vec3] {
  const c = points;
  return c.length === 3
    ? [c[0], c[0], c[2], c[1]]
    : [c[0], c[1], c[2], c[3]];
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/** Flat quad area — the same two-triangle measure `ship-rig.test.ts` uses. */
export function sailQuadAreaM2(points: readonly RigPoint[]): number {
  const [a, b, c, d] = quadCorners(points);
  return triangleArea(a, b, c) + triangleArea(a, c, d);
}

/** Area-weighted centroid of the flat quad — the sail's centre of effort. */
export function sailQuadCentroid(points: readonly RigPoint[]): Vec3 {
  const [a, b, c, d] = quadCorners(points);
  const a1 = triangleArea(a, b, c);
  const a2 = triangleArea(a, c, d);
  const total = Math.max(a1 + a2, 1e-12);
  return {
    x: (a1 * (a.x + b.x + c.x) + a2 * (a.x + c.x + d.x)) / (3 * total),
    y: (a1 * (a.y + b.y + c.y) + a2 * (a.y + c.y + d.y)) / (3 * total),
    z: (a1 * (a.z + b.z + c.z) + a2 * (a.z + c.z + d.z)) / (3 * total),
  };
}

/**
 * The drawn belly direction: the bilinear patch's centre normal times the
 * sail's measured `side` sign — the unit vector from the sail toward its
 * leeward face. Written into `out`; false if the patch has collapsed and has
 * no normal to give (a gaff sail at the bottom of its hoist lies along its
 * own boom).
 *
 * ONE DERIVATION, TWO CONSUMERS
 * -----------------------------
 * This is also the direction `rigGeometry.ts` lays the drawn belly along, and
 * it calls this function to get it. It used to hold a second copy of the same
 * cross product, and the two agreed because someone kept them agreeing — the
 * M6 cloth makes the belly a live shape, so "the aero's leeward face and the
 * drawn belly are the same vector" is now true by construction instead.
 */
export function sailLeewardNormal(
  points: readonly RigPoint[],
  side: 1 | -1,
  out: MutableRigPoint,
): boolean {
  const [p0, p1, p2, p3] = quadCorners(points);
  // cu = flat(1, 0.5) − flat(0, 0.5); cv = flat(0.5, 1) − flat(0.5, 0).
  const cuX = (p1.x + p2.x - p0.x - p3.x) / 2;
  const cuY = (p1.y + p2.y - p0.y - p3.y) / 2;
  const cuZ = (p1.z + p2.z - p0.z - p3.z) / 2;
  const cvX = (p3.x + p2.x - p0.x - p1.x) / 2;
  const cvY = (p3.y + p2.y - p0.y - p1.y) / 2;
  const cvZ = (p3.z + p2.z - p0.z - p1.z) / 2;
  const nx = cuY * cvZ - cuZ * cvY;
  const ny = cuZ * cvX - cuX * cvZ;
  const nz = cuX * cvY - cuY * cvX;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 1e-9)) return false;
  out.x = (nx / length) * side;
  out.y = (ny / length) * side;
  out.z = (nz / length) * side;
  return true;
}

const normalScratch: MutableRigPoint = { x: 0, y: 0, z: 0 };

/** The allocating form, for the frozen table and the inspectable API. */
function belliedNormal(points: readonly RigPoint[], side: 1 | -1): Vec3 {
  if (!sailLeewardNormal(points, side, normalScratch)) {
    throw new Error('sail patch normal is degenerate');
  }
  return { x: normalScratch.x, y: normalScratch.y, z: normalScratch.z };
}

/** One evaluated cloth shape: a set state of a sail, on one tack. */
export interface SailVariantGeometry {
  readonly areaM2: number;
  readonly coe: Vec3;
  /** Unit normal toward the leeward face — the drawn belly direction. */
  readonly leewardNormal: Vec3;
}

export interface SailAeroGeometry {
  readonly name: SailName;
  readonly family: SailAeroFamilyName;
  readonly camber: number;
  /** Cloth states that exist for this sail, per tack. 'furled' has none. */
  readonly variants: Readonly<
    Record<TackSide, Partial<Record<'set' | 'reef1' | 'reef2', SailVariantGeometry>>>
  >;
}

function mirroredCorners(points: readonly RigPoint[]): RigPoint[] {
  return points.map((p) => ({ x: -p.x, y: p.y, z: p.z }));
}

function buildVariant(points: readonly RigPoint[], side: 1 | -1): {
  starboard: SailVariantGeometry;
  port: SailVariantGeometry;
} {
  const starboardNormal = belliedNormal(points, side);
  const coe = sailQuadCentroid(points);
  const areaM2 = sailQuadAreaM2(points);
  const mirrored = mirroredCorners(points);
  return {
    starboard: Object.freeze({ areaM2, coe: Object.freeze(coe), leewardNormal: Object.freeze(starboardNormal) }),
    // The port-tack shape is the exact reflection of the authored one, so its
    // belly is the reflected belly: negate x of the leeward normal directly
    // rather than re-deriving a sign from mirrored winding.
    port: Object.freeze({
      areaM2: sailQuadAreaM2(mirrored),
      coe: Object.freeze(sailQuadCentroid(mirrored)),
      leewardNormal: Object.freeze({
        x: -starboardNormal.x,
        y: starboardNormal.y,
        z: starboardNormal.z,
      }),
    }),
  };
}

/**
 * The two gaff heights the rig needs while one sail is being evaluated.
 *
 * Only `mainsail` and `foresail` own a gaff, and only the gaff topsail reads
 * someone else's — its clew is hauled out on the *main* gaff, so it follows
 * the mainsail's hoist and not its own. Every other sail leaves both gaffs
 * where the sail plan draws them.
 */
const rigHoistsScratch = { mainsail: 1, foresail: 1 };

function rigHoists(name: SailName, hoist: number): RigHoistFractions {
  rigHoistsScratch.mainsail = name === 'mainsail' ? hoist : 1;
  rigHoistsScratch.foresail = name === 'foresail' ? hoist : 1;
  return rigHoistsScratch;
}

function buildSailGeometry(sail: Sail): SailAeroGeometry {
  const states: Array<'set' | 'reef1' | 'reef2'> = ['set'];
  for (const reef of ['reef1', 'reef2'] as const) {
    if (VALID_SET_STATES[sail.name].includes(reef)) states.push(reef);
  }
  const starboard: Partial<Record<'set' | 'reef1' | 'reef2', SailVariantGeometry>> = {};
  const port: Partial<Record<'set' | 'reef1' | 'reef2', SailVariantGeometry>> = {};
  const corners: MutableRigPoint[] = sail.corners.map(() => ({ x: 0, y: 0, z: 0 }));
  for (const state of states) {
    // The frozen table is built through the *live* constructors at the
    // authored trims. It was two derivations before — this one and a corner
    // compression of its own — and they agreed only as long as nobody changed
    // what a hoist does to a gaff. Now there is one, and 'set' still lands
    // bit-identical on the baked nodes because the constructors do.
    const hoist =
      state === 'set' ? 1 : 1 - SAIL_AERO_COEFFICIENTS.reefHoistFraction[state];
    liveSailCorners(sail.name, AUTHORED_TRIM_RAD, corners, rigHoists(sail.name, hoist));
    gatherSailCorners(sail.name, corners, hoist);
    const built = buildVariant(corners, sail.side);
    starboard[state] = built.starboard;
    port[state] = built.port;
  }
  return Object.freeze({
    name: sail.name,
    family: FAMILY_BY_SAIL[sail.name],
    camber: sail.camber,
    variants: Object.freeze({ starboard: Object.freeze(starboard), port: Object.freeze(port) }),
  });
}

/** Derived aero geometry for every sail, in `SAILS` order — the authored
 * (frozen-trim) fixture table. The live path re-derives geometry per
 * evaluation and is pinned bit-identical to this table at the authored
 * trims and hoists. */
export const SAIL_AERO_GEOMETRY: readonly SailAeroGeometry[] = Object.freeze(
  SAILS.map(buildSailGeometry),
);

/** Index of the mainsail in `SAILS` order (the windage mirror key). */
const MAINSAIL_INDEX = SAILS.findIndex((sail) => sail.name === 'mainsail');

/**
 * The lumped bare-pole windage: every spar's projected side area, so a storm
 * still pushes a stripped ship. Mean diameter × length per spar, centroid
 * area-weighted. Standing rigging and tops are deliberately not itemised —
 * one small term, one honest label.
 */
export const RIG_WINDAGE = (() => {
  let areaM2 = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const spar of SPARS) {
    const sparAreaM2 = sparLength(spar) * (spar.heelRadius + spar.headRadius);
    areaM2 += sparAreaM2;
    cx += (sparAreaM2 * (spar.heel.x + spar.head.x)) / 2;
    cy += (sparAreaM2 * (spar.heel.y + spar.head.y)) / 2;
    cz += (sparAreaM2 * (spar.heel.z + spar.head.z)) / 2;
  }
  return Object.freeze({
    areaM2,
    coe: Object.freeze({ x: cx / areaM2, y: cy / areaM2, z: cz / areaM2 }),
  });
})();

// --- live trim geometry (S4) -------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Gather a sail's corners toward its stowage as the hoist comes down —
 * in place, per family, ONE formula shared by physics and loft:
 *
 * - the two **boom-and-gaff sails** gather nowhere, because their hoist is
 *   not a property of the cloth: it lowers the gaff, and `liveSailCorners`
 *   has already put their head on the descending spar and left their foot on
 *   the boom. Compressing the cloth here as well would pull it off both;
 * - the **gaff topsail** has no spar of its own to lower — it is bent to a
 *   yard aloft and hauled down to its tack — so its head comes down toward
 *   the tack, which is the lowest corner;
 * - headsails and the fisherman: the cloth comes down the stay, gathering
 *   at the tack (corner 1);
 * - the square topsail: the clews rise to the yard — each clew gathers
 *   toward its own side's head corner.
 *
 * At hoist 1 the corners are untouched (no arithmetic — bitwise identity
 * with the frozen 'set' geometry).
 */
export function gatherSailCorners(
  name: SailName,
  corners: readonly MutableRigPoint[],
  hoistFraction: number,
): void {
  if (hoistFraction >= 1) return;
  if (name === 'mainsail' || name === 'foresail') return;
  const family = FAMILY_BY_SAIL[name];
  if (name === 'foreTopsail') {
    for (const [clew, head] of [
      [corners[2], corners[1]],
      [corners[3], corners[0]],
    ] as const) {
      clew.x = head.x + (clew.x - head.x) * hoistFraction;
      clew.y = head.y + (clew.y - head.y) * hoistFraction;
      clew.z = head.z + (clew.z - head.z) * hoistFraction;
    }
    return;
  }
  if (family === 'headsail') {
    const tack = corners[1];
    for (let i = 0; i < corners.length; i++) {
      if (i === 1) continue;
      const c = corners[i];
      c.x = tack.x + (c.x - tack.x) * hoistFraction;
      c.y = tack.y + (c.y - tack.y) * hoistFraction;
      c.z = tack.z + (c.z - tack.z) * hoistFraction;
    }
    return;
  }
  // The gaff topsail: head-toward-foot compression, its whole triangle
  // shrinking onto its tack as it comes in.
  let footY = Infinity;
  for (const c of corners) footY = Math.min(footY, c.y);
  for (const c of corners) {
    c.y = footY + (c.y - footY) * hoistFraction;
  }
}

/**
 * Which way the belly falls at a live trim. The authored `side` belongs to
 * the authored (positive) trim; a fore-and-aft sail sheeted through the
 * centreline fills on its other face, so the sign flips with the trim. The
 * square topsail's cloth rotates *with* the yard — its normal follows the
 * corner positions continuously and the sign never flips (aback is handled
 * by the aero as collapsed lift, not by relabeling faces).
 *
 * Like the authored `side`, the truth of this rule is the belly test in
 * `tests/ship-rig.test.ts` — measured on both tacks, never reasoned.
 */
export function liveSailSide(sail: Sail, trimDeg: number): 1 | -1 {
  if (sail.name === 'foreTopsail') return sail.side;
  return trimDeg >= 0 ? sail.side : ((-sail.side) as 1 | -1);
}

/** Map a frozen S2/S3 configuration onto per-sail live states — the
 * fixture path: authored trims, signed by tack, hoists at the state's
 * fixed point. This is exactly what the drawn rig and the committed
 * evidence were generated at. */
export function frozenSailStates(
  canvas: CanvasState,
  tack: TackSide,
  out?: SailAeroSailState[],
): SailAeroSailState[] {
  const sign = tack === 'port' ? -1 : 1;
  const states =
    out ??
    SAILS.map(() => ({ label: 'set' as SailSetState, hoistFraction: 1, trimDeg: 0 }));
  for (let i = 0; i < SAILS.length; i++) {
    const sail = SAILS[i];
    const state = canvas[sail.name];
    const trimRad =
      sail.name === 'mainGaffTopsail'
        ? AUTHORED_TRIM_RAD.mainsail
        : AUTHORED_TRIM_RAD[sail.name as keyof RigTrimAnglesRad];
    states[i].label = state;
    states[i].hoistFraction =
      state === 'furled' ? 0 : state === 'set' ? 1 : 1 - SAIL_AERO_COEFFICIENTS.reefHoistFraction[state];
    states[i].trimDeg = sign * trimRad * RAD_TO_DEG;
  }
  return states;
}

/**
 * One sail's live geometry at a given trim and hoist — the allocating,
 * inspectable form of what `evaluateSailAero` derives per substep. The gaff
 * topsail swings with the *mainsail's* trim and rides the *mainsail's* gaff;
 * pass either when they differ from the defaults.
 */
export function liveSailVariantGeometry(
  name: SailName,
  trimDeg: number,
  hoistFraction: number,
  mainsailTrimDeg: number = trimDeg,
  mainsailHoistFraction = 1,
): SailVariantGeometry & {
  side: 1 | -1;
  spanM: number;
  footAboveSeaM: number;
  aspectRatioEff: number;
} {
  const sail = SAILS.find((s) => s.name === name);
  if (!sail) throw new Error(`no such sail "${name}"`);
  const trims: RigTrimAnglesRad = { ...AUTHORED_TRIM_RAD };
  if (name === 'mainGaffTopsail') {
    trims.mainsail = mainsailTrimDeg * DEG_TO_RAD;
  } else {
    trims[name as keyof RigTrimAnglesRad] = trimDeg * DEG_TO_RAD;
  }
  const corners: MutableRigPoint[] = sail.corners.map(() => ({ x: 0, y: 0, z: 0 }));
  const hoists =
    name === 'mainGaffTopsail'
      ? { mainsail: mainsailHoistFraction, foresail: 1 }
      : rigHoists(name, hoistFraction);
  liveSailCorners(name, trims, corners, hoists);
  gatherSailCorners(name, corners, hoistFraction);
  const side = liveSailSide(sail, trimDeg);
  const areaM2 = sailQuadAreaM2(corners);
  let footY = Infinity;
  let headY = -Infinity;
  for (const corner of corners) {
    if (corner.y < footY) footY = corner.y;
    if (corner.y > headY) headY = corner.y;
  }
  const spanM = headY - footY;
  const footAboveSeaM = footY - SEA_LEVEL_MODEL_Y;
  return {
    areaM2,
    coe: sailQuadCentroid(corners),
    leewardNormal: belliedNormal(corners, side),
    side,
    spanM,
    footAboveSeaM,
    aspectRatioEff: sailEffectiveAspectRatio(spanM, areaM2, footAboveSeaM),
  };
}

/** One live-derived cloth shape, reused per evaluation. */
interface LiveVariantScratch {
  active: boolean;
  areaM2: number;
  coe: MutableRigPoint;
  leewardNormal: MutableRigPoint;
  /** Effective aspect ratio of the shape actually standing there. */
  aspectRatioEff: number;
}

const trimsScratch: RigTrimAnglesRad = { ...AUTHORED_TRIM_RAD };
const hoistsScratch = { mainsail: 1, foresail: 1 };
const cornersScratch3: MutableRigPoint[] = [0, 1, 2].map(() => ({ x: 0, y: 0, z: 0 }));
const cornersScratch4: MutableRigPoint[] = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
const liveVariantScratch: LiveVariantScratch[] = SAILS.map(() => ({
  active: false,
  areaM2: 0,
  coe: { x: 0, y: 0, z: 0 },
  leewardNormal: { x: 0, y: 0, z: 0 },
  aspectRatioEff: 1,
}));

/**
 * Derive every sail's live geometry for one evaluation. Corners re-run the
 * rig's own constructors at the commanded trims (`liveSailCorners`), gather
 * with the hoist, and reduce through the same area/centroid/patch-normal
 * functions the frozen table was built with — at the authored trims and
 * full hoist the results are bit-identical to `SAIL_AERO_GEOMETRY`,
 * pinned by test.
 */
function deriveLiveVariants(sails: readonly SailAeroSailState[]): void {
  for (let i = 0; i < SAILS.length; i++) {
    const sail = SAILS[i];
    if (sail.name === 'mainGaffTopsail') continue;
    trimsScratch[sail.name as keyof RigTrimAnglesRad] = sails[i].trimDeg * DEG_TO_RAD;
    // The two gaffs are shared timber: the mainsail's hoist decides where the
    // main gaff is, and the gaff topsail's clew is out on it. Gathered once
    // for the whole evaluation rather than per sail.
    if (sail.name === 'mainsail' || sail.name === 'foresail') {
      hoistsScratch[sail.name] = sails[i].hoistFraction;
    }
  }
  for (let i = 0; i < SAILS.length; i++) {
    const sail = SAILS[i];
    const state = sails[i];
    const scratch = liveVariantScratch[i];
    if (state.hoistFraction <= HOIST_EPSILON) {
      scratch.active = false;
      scratch.areaM2 = 0;
      continue;
    }
    const corners = sail.corners.length === 3 ? cornersScratch3 : cornersScratch4;
    liveSailCorners(sail.name, trimsScratch, corners, hoistsScratch);
    gatherSailCorners(sail.name, corners, state.hoistFraction);
    const side = liveSailSide(sail, state.trimDeg);
    scratch.active = true;
    scratch.areaM2 = sailQuadAreaM2(corners);
    // The lifting span and the gap to the sea, from the cloth actually up.
    let footY = Infinity;
    let headY = -Infinity;
    for (let c = 0; c < sail.corners.length; c++) {
      const y = corners[c].y;
      if (y < footY) footY = y;
      if (y > headY) headY = y;
    }
    scratch.aspectRatioEff = sailEffectiveAspectRatio(
      headY - footY,
      scratch.areaM2,
      footY - SEA_LEVEL_MODEL_Y,
    );
    const coe = sailQuadCentroid(corners);
    scratch.coe.x = coe.x;
    scratch.coe.y = coe.y;
    scratch.coe.z = coe.z;
    const normal = belliedNormal(corners, side);
    scratch.leewardNormal.x = normal.x;
    scratch.leewardNormal.y = normal.y;
    scratch.leewardNormal.z = normal.z;
  }
}

// --- aspect ratio and induced drag (FINDING S4-1) ----------------------------

/**
 * The sea surface in model coordinates. Model `y` is height above the
 * baseline (`hullForm.ts`'s COORDINATES block) and she floats at her design
 * draught, so this is where the mirror is.
 */
export const SEA_LEVEL_MODEL_Y = DESIGN_DRAUGHT;

/**
 * The effective aspect ratio of one sail, from that sail's own cloth.
 *
 * WHY THIS EXISTS: FINDING S4-1. The provisional aero had no induced drag —
 * CD was `cd0 + (cd90−cd0)·sin²AoA` and nothing scaled with CL² — so the rig
 * had no pointing limit of its own and a gaff schooner made 2.7 m/s at 30°
 * off the true wind. Induced drag is the term that says a low-aspect sail
 * pays for its lift, and it is *the* reason gaffers do not point.
 *
 * THE DERIVATION, WHICH IS ALL GEOMETRY
 * -------------------------------------
 * 1. `span` is the cloth's own vertical extent and `areaM2` its planform,
 *    both read from the live corners the loft draws between — so a reefed
 *    sail, a half-hoisted headsail and a sail swung to a new trim each get
 *    the aspect ratio of the shape actually standing there.
 * 2. `AR_geom = span²/area`. No choice in it. The rig's own numbers at the
 *    authored trims: mainsail 1.94, foresail 2.50, fore staysail 4.26, jib
 *    6.43, flying jib 5.31, square topsail **0.94**, fisherman 2.94, gaff
 *    topsail 4.25. That spread is the whole finding in one line — the two
 *    workhorses and the square topsail are the low-aspect surfaces, and they
 *    are 60% of her canvas.
 * 3. The sea is a mirror. A sail whose foot touched the water would be half
 *    of a wing of twice the aspect ratio; a gap lets the flow across and
 *    spends the mirror. `imageGain = 1/(1 + k·gap/span)` with `k` in the
 *    coefficient block, gap measured from the foot to the sea at her design
 *    draught. Her feet stand 2.9–3.9 m up on the working sails (gap/span
 *    0.31–0.41, gain ≈ 0.55–0.62) and 10–12 m up on the three sails set
 *    aloft, where the mirror is nearly gone.
 *
 * The result, authored trims: mainsail 3.06, foresail 3.89, fore staysail
 * 6.60, jib 10.4, flying jib 8.48, **square topsail 1.14**, fisherman 3.57,
 * gaff topsail 5.39.
 */
export function sailEffectiveAspectRatio(
  spanM: number,
  areaM2: number,
  footAboveSeaM: number,
): number {
  if (!(spanM > 1e-6) || !(areaM2 > 1e-9)) return 1e-6;
  const geometric = (spanM * spanM) / areaM2;
  const gap = Math.max(footAboveSeaM, 0);
  const imageGain =
    1 / (1 + SAIL_AERO_COEFFICIENTS.imageGapSpans * (gap / spanM));
  return geometric * (1 + imageGain);
}

/**
 * Induced drag: the price of the lift, `CL²/(π·AR·e)`.
 *
 * The same form `SCHOONER_RUDDER_COEFFICIENTS` already prices the blade's
 * lift with, on the CL the sail is *actually* carrying — so a luffing sail,
 * whose CL the attachment gate has already taken away, pays nothing, and a
 * backed sail pays for the lift it carries backwards.
 */
export function sailInducedDragCoefficient(
  cl: number,
  effectiveAspectRatio: number,
): number {
  return (
    (cl * cl) /
    (Math.PI *
      Math.max(effectiveAspectRatio, 1e-6) *
      SAIL_AERO_COEFFICIENTS.spanEfficiency)
  );
}

// --- lift, drag and luffing curves -------------------------------------------

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** CLmax for a sail from its family and camber. */
export function sailClMax(family: SailAeroFamilyName, camber: number): number {
  const f = SAIL_AERO_FAMILIES[family];
  return f.clMaxBase + f.clMaxPerCamber * camber;
}

/**
 * Lift coefficient over AoA ∈ [0°, 90°]: a linear-ish rise to CLmax at the
 * peak, then a soft half-cosine stall down to `stallFloor · CLmax` at 90°.
 * C1-continuous at the peak.
 *
 * This is a MAGNITUDE on the face the wind is on, and it is zero at and
 * below zero AoA because there is no cloth angle there, not because an aback
 * sail is dead. An aback sail is the same curve read on its other face at
 * `−aoa` with `sailAbackCamber`'s shallower belly, gated by
 * `sailAbackFactor` and subtracted — see `evaluateSailAero`. (Until S6c it
 * really was dead: "an aback sail in v1 is treated as collapsed, like
 * luffing", which is FINDING S4-2 and the reason backing a headsail out of
 * irons did literally nothing.)
 */
export function sailLiftCoefficient(
  aoaDeg: number,
  family: SailAeroFamilyName,
  camber: number,
): number {
  if (aoaDeg <= 0) return 0;
  const clMax = sailClMax(family, camber);
  const { aoaPeakDeg, stallFloor } = SAIL_AERO_COEFFICIENTS;
  if (aoaDeg <= aoaPeakDeg) {
    return clMax * Math.sin((Math.PI / 2) * (aoaDeg / aoaPeakDeg));
  }
  const past = Math.min((aoaDeg - aoaPeakDeg) / (90 - aoaPeakDeg), 1);
  const mid = (1 + stallFloor) / 2;
  const half = (1 - stallFloor) / 2;
  return clMax * (mid + half * Math.cos(Math.PI * past));
}

/** Drag coefficient: small base rising as sin²(AoA) to the flat-on value. */
export function sailDragCoefficient(
  aoaDeg: number,
  family: SailAeroFamilyName,
): number {
  const f = SAIL_AERO_FAMILIES[family];
  const s = Math.sin(Math.abs(aoaDeg) * DEG_TO_RAD);
  return f.cd0 + (f.cd90 - f.cd0) * s * s;
}

/**
 * Attachment factor: 1 when drawing, 0 when the sail cannot hold shape.
 * Collapses smoothly across the luff band as AoA falls toward (and past)
 * zero — the design's "lift collapses smoothly to zero over a few degrees".
 */
export function sailLuffFactor(aoaDeg: number): number {
  const { luffEndDeg, luffBandDeg } = SAIL_AERO_COEFFICIENTS;
  return smoothstep(luffEndDeg - luffBandDeg, luffEndDeg, aoaDeg);
}

/**
 * How far the belly has inverted: 0 while the sail is drawing or merely
 * shaking, 1 once the wind is `abackFullDeg` onto its leeward face.
 *
 * The counterpart of `sailLuffFactor` on the other side of zero, and the
 * function `rigGeometry`'s cloth has used since M6 to decide how far the
 * drawn belly has gone the other way. The aero now reads it too, so the
 * lift a backed sail carries and the shape it is drawn in come off one
 * curve. Between the two there is a band where a sail is neither attached
 * nor pressed — that is the cloth that flogs, and it carries no lift from
 * either branch.
 */
export function sailAbackFactor(aoaDeg: number): number {
  return smoothstep(0, SAIL_AERO_COEFFICIENTS.abackFullDeg, -aoaDeg);
}

/**
 * The most attached the cloth may be drawn while the hand at that sheet is
 * reporting he cannot make her draw.
 *
 * `cannotDraw` is a *sustained* verdict — he has hauled three times and the
 * rope will not go further — so the sail is not about to fill because this
 * instant's angle of attack happens to look better. 0.5 exactly, because that
 * is `PerSailForce.luffing`'s own threshold.
 */
export const CANNOT_DRAW_ATTACH_CAP = 0.5;

/** Apparent wind at which shaking reaches full amplitude, m/s. */
const FULL_SHAKE_MPS = 8;

/**
 * How much of this sail is *in motion* — neither drawing nor firmly aback.
 *
 * ONE DERIVATION, THREE CONSUMERS. Cloth holding its shape is quiet; cloth
 * pressed hard against its windward face is also quiet; the cloth that
 * thunders is the cloth in between, and only when there is wind enough to move
 * it. That is one fact about a sail, and the thing you *see* (M6's flogging
 * mode), the thing you *hear* (the sound round's cloth voice) and the crew's
 * own verdict are all functions of it. It lives here, beside the two curves it
 * is built from, because three rounds derived it separately within a day of
 * each other and three copies of a curve is how they drift apart.
 */
export function sailShakeFraction(
  aoaDeg: number,
  apparentSpeedMps: number,
  blanketFactor: number,
  cannotDraw: boolean,
): number {
  // The wind this sail actually stands in. Square root because blanketing is a
  // loss of dynamic pressure and the shapes respond to speed.
  const effectiveMps =
    Math.max(apparentSpeedMps, 0) * Math.sqrt(Math.max(blanketFactor, 0));
  const attach = Math.min(
    sailLuffFactor(aoaDeg),
    cannotDraw ? CANNOT_DRAW_ATTACH_CAP : 1,
  );
  const abackFill = sailAbackFactor(aoaDeg);
  const shakeWind = Math.min(effectiveMps / FULL_SHAKE_MPS, 1);
  return (1 - attach) * (1 - abackFill) * shakeWind;
}

// --- evaluation --------------------------------------------------------------

export interface SailAeroInput {
  /** Instantaneous true wind, render/world axes (the S1 heading→vector form). */
  trueWindWorldX: number;
  trueWindWorldZ: number;
  /** Hull velocity, world axes; Y is `BuoyantBody.velocityY`. */
  velocityWorldX: number;
  velocityWorldY: number;
  velocityWorldZ: number;
  /** Attitude and rates. Yaw rate is owned by the horizontal dynamics and is
   * added to the rig's point velocities here, once — the same explicit
   * treatment the resistance model gives the underwater stations. */
  yawRad: number;
  pitchRad: number;
  rollRad: number;
  yawRateRadPerSecond: number;
  pitchRateRadPerSecond: number;
  rollRateRadPerSecond: number;
  /** Centre of mass, model coordinates (`BuoyantBody.comX/Y/Z`). */
  comX: number;
  comY: number;
  comZ: number;
  /** Per-sail live rig state, in `SAILS` order (see `frozenSailStates` for
   * the fixture mapping from the S2/S3 canvas + tack vocabulary). */
  sails: readonly SailAeroSailState[];
}

export interface PerSailForce {
  readonly name: SailName;
  state: SailSetState;
  /** True when cloth is up and evaluated (not furled). */
  active: boolean;
  areaM2: number;
  /** Signed AoA, degrees: positive = wind on the windward face, drawing. */
  aoaDeg: number;
  luffing: boolean;
  blanketFactor: number;
  apparentSpeedMps: number;
  /**
   * The coefficient block, per sail, per instant — the world-lighting
   * round's per-term-views lesson applied to the rig: an aggregate drive
   * number cannot tell you whether a sail is paying for its lift or simply
   * not making any.
   */
  aspectRatioEff: number;
  /** The camber the drawn cloth is at — what CLmax is read from (M6 §11.6). */
  camberDrawn: number;
  /** Net lift coefficient. NEGATIVE when the sail is aback (S4-2). */
  liftCoefficient: number;
  /** Profile + separated drag, before the induced term. */
  dragCoefficient: number;
  /** CL²/(π·AR·e) — the term FINDING S4-1 said was missing. */
  inducedDragCoefficient: number;
  /** Force on the hull, attitude-frame model axes (+x port, +z bow). */
  forceModelXN: number;
  forceModelYN: number;
  forceModelZN: number;
  /** Where it acts, model coordinates. */
  coeXM: number;
  coeYM: number;
  coeZM: number;
}

export interface SailAeroResult {
  readonly perSail: readonly PerSailForce[];
  windage: {
    areaM2: number;
    forceModelXN: number;
    forceModelYN: number;
    forceModelZN: number;
  };
  /** Total force on the hull, world/render axes. */
  forceWorldXN: number;
  forceWorldYN: number;
  forceWorldZN: number;
  /** Torques about the centre of mass, yaw-frame axes — the same axes
   * `BuoyantBody`'s station torques use. Yaw moment is the vertical
   * component; positive turns the bow toward +x/port. */
  yawMomentNm: number;
  pitchTorqueNm: number;
  rollTorqueNm: number;
  luffingCount: number;
  activeClothAreaM2: number;
  /**
   * Hull-level apparent wind in attitude-frame model axes (+x port, +z bow),
   * excluding rotation rates — the same vector the blanketing geometry and the
   * windage lump are built on, published rather than recomputed.
   *
   * This is the flow direction, so it points where the wind is *going*: a wind
   * blowing toward +x is a wind *from starboard* (`ship-sailing-aero.test.ts`
   * pins that on the beam reach). S5's crew sensors reduce it to a coarse
   * dogvane reading; nothing that steers may read it directly.
   */
  hullApparentModelXMps: number;
  hullApparentModelYMps: number;
  hullApparentModelZMps: number;
  hullApparentSpeedMps: number;
}

export function createSailAeroResult(): SailAeroResult {
  return {
    perSail: SAILS.map((sail) => ({
      name: sail.name,
      state: 'furled' as SailSetState,
      active: false,
      areaM2: 0,
      aoaDeg: 0,
      luffing: false,
      blanketFactor: 1,
      apparentSpeedMps: 0,
      aspectRatioEff: 1,
      camberDrawn: 0,
      liftCoefficient: 0,
      dragCoefficient: 0,
      inducedDragCoefficient: 0,
      forceModelXN: 0,
      forceModelYN: 0,
      forceModelZN: 0,
      coeXM: 0,
      coeYM: 0,
      coeZM: 0,
    })),
    windage: { areaM2: RIG_WINDAGE.areaM2, forceModelXN: 0, forceModelYN: 0, forceModelZN: 0 },
    forceWorldXN: 0,
    forceWorldYN: 0,
    forceWorldZN: 0,
    yawMomentNm: 0,
    pitchTorqueNm: 0,
    rollTorqueNm: 0,
    luffingCount: 0,
    activeClothAreaM2: 0,
    hullApparentModelXMps: 0,
    hullApparentModelYMps: 0,
    hullApparentModelZMps: 0,
    hullApparentSpeedMps: 0,
  };
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

/**
 * Evaluate one instant of sail forces, overwriting `out`.
 *
 * Allocation-free with a reusable result, like `evaluateSchoonerResistance`.
 * Three passes over the eight sails: apparent wind and AoA at each centre of
 * effort; the crude blanketing factors; then forces and the single wrench
 * split for the two integrators.
 */
export function evaluateSailAero(
  input: SailAeroInput,
  out: SailAeroResult = createSailAeroResult(),
): SailAeroResult {
  assertFinite(input.trueWindWorldX, 'true wind x');
  assertFinite(input.trueWindWorldZ, 'true wind z');
  assertFinite(input.velocityWorldX, 'velocity x');
  assertFinite(input.velocityWorldY, 'velocity y');
  assertFinite(input.velocityWorldZ, 'velocity z');
  assertFinite(input.yawRad, 'yaw');
  assertFinite(input.pitchRad, 'pitch');
  assertFinite(input.rollRad, 'roll');
  assertFinite(input.yawRateRadPerSecond, 'yaw rate');
  assertFinite(input.pitchRateRadPerSecond, 'pitch rate');
  assertFinite(input.rollRateRadPerSecond, 'roll rate');

  const cy = Math.cos(input.yawRad);
  const sy = Math.sin(input.yawRad);
  const cp = Math.cos(input.pitchRad);
  const sp = Math.sin(input.pitchRad);
  const cr = Math.cos(input.rollRad);
  const sr = Math.sin(input.rollRad);

  // world → attitude-frame model axes (undo yaw, then pitch, then roll).
  const worldToModel = (
    wx: number,
    wy: number,
    wz: number,
    dst: { x: number; y: number; z: number },
  ): void => {
    const fx = wx * cy - wz * sy;
    const fz = wx * sy + wz * cy;
    const ay = wy * cp + fz * sp;
    dst.z = -wy * sp + fz * cp;
    dst.x = fx * cr + ay * sr;
    dst.y = -fx * sr + ay * cr;
  };

  // model → yaw-frame (apply roll, then pitch) — `transformContact`'s rows.
  const modelToYawFrame = (
    mx: number,
    my: number,
    mz: number,
    dst: { x: number; y: number; z: number },
  ): void => {
    const ax = mx * cr - my * sr;
    const ay = mx * sr + my * cr;
    dst.x = ax;
    dst.y = ay * cp - mz * sp;
    dst.z = ay * sp + mz * cp;
  };

  const scratch = { x: 0, y: 0, z: 0 };

  // Hull-level apparent wind (no rotation rates) — the blanketing geometry
  // and the windage lump both use it.
  const hullApparentWorldX = input.trueWindWorldX - input.velocityWorldX;
  const hullApparentWorldY = -input.velocityWorldY;
  const hullApparentWorldZ = input.trueWindWorldZ - input.velocityWorldZ;
  worldToModel(hullApparentWorldX, hullApparentWorldY, hullApparentWorldZ, scratch);
  const hullApparentModelX = scratch.x;
  const hullApparentModelY = scratch.y;
  const hullApparentModelZ = scratch.z;
  const hullApparentSpeed = Math.hypot(
    hullApparentModelX,
    hullApparentModelY,
    hullApparentModelZ,
  );
  out.hullApparentModelXMps = hullApparentModelX;
  out.hullApparentModelYMps = hullApparentModelY;
  out.hullApparentModelZMps = hullApparentModelZ;
  out.hullApparentSpeedMps = hullApparentSpeed;

  out.luffingCount = 0;
  out.activeClothAreaM2 = 0;

  // Derive every sail's live geometry once for this instant: the rig's own
  // corner constructors at the commanded trims, gathered by hoist.
  deriveLiveVariants(input.sails);

  // Pass 1 — per-sail apparent wind, AoA, luffing.
  for (let i = 0; i < SAIL_AERO_GEOMETRY.length; i++) {
    const geometry = SAIL_AERO_GEOMETRY[i];
    const record = out.perSail[i] as PerSailForce;
    const state = input.sails[i].label;
    if (!VALID_SET_STATES[geometry.name].includes(state)) {
      throw new RangeError(`${geometry.name} cannot be "${state}"`);
    }
    record.state = state;
    record.blanketFactor = 1;
    record.forceModelXN = 0;
    record.forceModelYN = 0;
    record.forceModelZN = 0;
    record.camberDrawn = 0;
    record.liftCoefficient = 0;
    record.dragCoefficient = 0;
    record.inducedDragCoefficient = 0;
    const variant = liveVariantScratch[i];
    record.aspectRatioEff = variant.active ? variant.aspectRatioEff : 1;
    if (!variant.active) {
      record.active = false;
      record.areaM2 = 0;
      record.aoaDeg = 0;
      record.luffing = false;
      record.apparentSpeedMps = 0;
      continue;
    }
    record.active = true;
    record.areaM2 = variant.areaM2;
    record.coeXM = variant.coe.x;
    record.coeYM = variant.coe.y;
    record.coeZM = variant.coe.z;
    out.activeClothAreaM2 += variant.areaM2;

    // Rig point velocity at the CoE: hull translation plus ω × r, with the
    // yaw rate included here explicitly (the schooner owns it separately).
    const dx = variant.coe.x - input.comX;
    const dy = variant.coe.y - input.comY;
    const dz = variant.coe.z - input.comZ;
    modelToYawFrame(dx, dy, dz, scratch);
    const armX = scratch.x;
    const armY = scratch.y;
    const armZ = scratch.z;
    const wx = input.pitchRateRadPerSecond;
    const wy = input.yawRateRadPerSecond;
    const wz = input.rollRateRadPerSecond;
    const spinX = wy * armZ - wz * armY;
    const spinY = wz * armX - wx * armZ;
    const spinZ = wx * armY - wy * armX;
    const pointVelocityWorldX = input.velocityWorldX + spinX * cy + spinZ * sy;
    const pointVelocityWorldY = input.velocityWorldY + spinY;
    const pointVelocityWorldZ = input.velocityWorldZ - spinX * sy + spinZ * cy;

    worldToModel(
      input.trueWindWorldX - pointVelocityWorldX,
      -pointVelocityWorldY,
      input.trueWindWorldZ - pointVelocityWorldZ,
      scratch,
    );
    const apparentX = scratch.x;
    const apparentY = scratch.y;
    const apparentZ = scratch.z;
    const speed = Math.hypot(apparentX, apparentY, apparentZ);
    record.apparentSpeedMps = speed;
    if (speed < 1e-9) {
      record.aoaDeg = 0;
      record.luffing = true;
      out.luffingCount++;
      continue;
    }
    const n = liveVariantScratch[i].leewardNormal;
    const sinAoa =
      (apparentX * n.x + apparentY * n.y + apparentZ * n.z) / speed;
    record.aoaDeg =
      Math.asin(Math.min(Math.max(sinAoa, -1), 1)) * RAD_TO_DEG;
    record.luffing = sailLuffFactor(record.aoaDeg) < 0.5;
    if (record.luffing) out.luffingCount++;
  }

  // Pass 2 — crude downwind blanketing. A drawing sail shadows what stands
  // dead down-apparent-wind of it; take the worst single shadow, not a stack.
  const coefficients = SAIL_AERO_COEFFICIENTS;
  if (hullApparentSpeed > 1e-9) {
    const wxu = hullApparentModelX / hullApparentSpeed;
    const wyu = hullApparentModelY / hullApparentSpeed;
    const wzu = hullApparentModelZ / hullApparentSpeed;
    for (let b = 0; b < SAIL_AERO_GEOMETRY.length; b++) {
      const shadowed = out.perSail[b] as PerSailForce;
      if (!shadowed.active) continue;
      let worst = 0;
      for (let a = 0; a < SAIL_AERO_GEOMETRY.length; a++) {
        if (a === b) continue;
        const blanketer = out.perSail[a];
        if (!blanketer.active || blanketer.luffing) continue;
        const ex = shadowed.coeXM - blanketer.coeXM;
        const ey = shadowed.coeYM - blanketer.coeYM;
        const ez = shadowed.coeZM - blanketer.coeZM;
        const distance = Math.hypot(ex, ey, ez);
        if (distance < 1e-6) continue;
        const alignment = (ex * wxu + ey * wyu + ez * wzu) / distance;
        const ramp = smoothstep(
          coefficients.blanketingConeCosOuter,
          coefficients.blanketingConeCosInner,
          alignment,
        );
        if (ramp > worst) worst = ramp;
      }
      shadowed.blanketFactor = 1 - coefficients.blanketingLoss * worst;
    }
  }

  // Pass 3 — forces and the wrench, split once for the two integrators.
  let forceModelX = 0;
  let forceModelY = 0;
  let forceModelZ = 0;
  let torqueModelX = 0;
  let torqueModelY = 0;
  let torqueModelZ = 0;

  const addForceAt = (
    fx: number,
    fy: number,
    fz: number,
    px: number,
    py: number,
    pz: number,
  ): void => {
    forceModelX += fx;
    forceModelY += fy;
    forceModelZ += fz;
    const rx = px - input.comX;
    const ry = py - input.comY;
    const rz = pz - input.comZ;
    torqueModelX += ry * fz - rz * fy;
    torqueModelY += rz * fx - rx * fz;
    torqueModelZ += rx * fy - ry * fx;
  };

  for (let i = 0; i < SAIL_AERO_GEOMETRY.length; i++) {
    const geometry = SAIL_AERO_GEOMETRY[i];
    const record = out.perSail[i] as PerSailForce;
    if (!record.active || record.apparentSpeedMps < 1e-9) continue;
    const variant = liveVariantScratch[i];

    // Rebuild the per-sail apparent unit vector from stored magnitude and
    // AoA? No — recompute it; passes are cheap and exactness beats caching.
    const dx = variant.coe.x - input.comX;
    const dy = variant.coe.y - input.comY;
    const dz = variant.coe.z - input.comZ;
    modelToYawFrame(dx, dy, dz, scratch);
    const armX = scratch.x;
    const armY = scratch.y;
    const armZ = scratch.z;
    const wxr = input.pitchRateRadPerSecond;
    const wyr = input.yawRateRadPerSecond;
    const wzr = input.rollRateRadPerSecond;
    const spinX = wyr * armZ - wzr * armY;
    const spinY = wzr * armX - wxr * armZ;
    const spinZ = wxr * armY - wyr * armX;
    worldToModel(
      input.trueWindWorldX - (input.velocityWorldX + spinX * cy + spinZ * sy),
      -(input.velocityWorldY + spinY),
      input.trueWindWorldZ - (input.velocityWorldZ - spinX * sy + spinZ * cy),
      scratch,
    );
    const speed = record.apparentSpeedMps;
    const wux = scratch.x / speed;
    const wuy = scratch.y / speed;
    const wuz = scratch.z / speed;

    const q =
      0.5 * RHO_AIR * speed * speed * record.blanketFactor * variant.areaM2;

    // THE COEFFICIENT BLOCK (S6c). Three changes from S2a's version, all of
    // them things the model was known to be missing:
    //
    // 1. CLmax reads the camber the CLOTH IS DRAWN AT, not the camber the
    //    sail was designed at. The M6 round made the belly a live shape and
    //    left the coefficient reading the static number.
    // 2. An ABACK sail carries lift, on its other face, off the same curve
    //    with the shallower belly a backed sail actually takes. Below zero
    //    AoA the two branches hand over through the flogging band, where
    //    neither holds and there is no lift from either.
    // 3. INDUCED DRAG. CL²/(π·AR·e) on the sail's own effective aspect
    //    ratio, which is what makes a low-aspect gaff sail expensive to
    //    point with.
    const trimDeg = input.sails[i].trimDeg;
    const camberDraw = sailShapeCamber(geometry.name, geometry.camber, trimDeg);
    const camberAback = sailAbackCamber(geometry.name, geometry.camber, trimDeg);
    const attach = sailLuffFactor(record.aoaDeg);
    const aback = sailAbackFactor(record.aoaDeg);
    const cl =
      attach * sailLiftCoefficient(record.aoaDeg, geometry.family, camberDraw) -
      aback * sailLiftCoefficient(-record.aoaDeg, geometry.family, camberAback);
    // A backed sail is pressed cloth, not a shivering rag: it carries the
    // attached drag curve too. `pressed` is how much of either shape the
    // sail is holding, and `cdLuffing` owns the band between them.
    const pressed = attach > aback ? attach : aback;
    const cdAttached = sailDragCoefficient(record.aoaDeg, geometry.family);
    const cdInduced = sailInducedDragCoefficient(cl, variant.aspectRatioEff);
    const cd =
      coefficients.cdLuffing +
      (cdAttached - coefficients.cdLuffing) * pressed +
      cdInduced;
    record.aspectRatioEff = variant.aspectRatioEff;
    record.camberDrawn = cl < 0 ? -camberAback : camberDraw;
    record.liftCoefficient = cl;
    record.dragCoefficient = cd - cdInduced;
    record.inducedDragCoefficient = cdInduced;

    // Lift is perpendicular to the apparent wind, in the wind–normal plane,
    // pointing to leeward. Degenerate square-on flow carries no lift.
    const n = variant.leewardNormal;
    const nDotW = n.x * wux + n.y * wuy + n.z * wuz;
    let liftX = n.x - nDotW * wux;
    let liftY = n.y - nDotW * wuy;
    let liftZ = n.z - nDotW * wuz;
    const liftLength = Math.hypot(liftX, liftY, liftZ);
    if (liftLength > 1e-6) {
      liftX /= liftLength;
      liftY /= liftLength;
      liftZ /= liftLength;
    } else {
      liftX = 0;
      liftY = 0;
      liftZ = 0;
    }

    const fx = q * (cl * liftX + cd * wux);
    const fy = q * (cl * liftY + cd * wuy);
    const fz = q * (cl * liftZ + cd * wuz);
    record.forceModelXN = fx;
    record.forceModelYN = fy;
    record.forceModelZN = fz;
    addForceAt(fx, fy, fz, variant.coe.x, variant.coe.y, variant.coe.z);
  }

  // The bare-pole windage lump: always present, spars do not furl. Its
  // centre mirrors with the booms — the spars that hang to port at positive
  // trim hang to starboard at negative — keyed to the mainsail trim's sign
  // so a mirrored trim set mirrors the whole wrench exactly.
  out.windage.areaM2 = RIG_WINDAGE.areaM2;
  if (hullApparentSpeed > 1e-9) {
    const q =
      0.5 * RHO_AIR * hullApparentSpeed * RIG_WINDAGE.areaM2 * coefficients.windageCd;
    const fx = q * hullApparentModelX;
    const fy = q * hullApparentModelY;
    const fz = q * hullApparentModelZ;
    out.windage.forceModelXN = fx;
    out.windage.forceModelYN = fy;
    out.windage.forceModelZN = fz;
    const mainsailTrimDeg = input.sails[MAINSAIL_INDEX].trimDeg;
    const windageX =
      mainsailTrimDeg < 0 ? -RIG_WINDAGE.coe.x : RIG_WINDAGE.coe.x;
    addForceAt(fx, fy, fz, windageX, RIG_WINDAGE.coe.y, RIG_WINDAGE.coe.z);
  } else {
    out.windage.forceModelXN = 0;
    out.windage.forceModelYN = 0;
    out.windage.forceModelZN = 0;
  }

  // The split (design §6.2): one wrench, expressed for its two consumers.
  modelToYawFrame(forceModelX, forceModelY, forceModelZ, scratch);
  const forceYawX = scratch.x;
  const forceYawY = scratch.y;
  const forceYawZ = scratch.z;
  out.forceWorldXN = forceYawX * cy + forceYawZ * sy;
  out.forceWorldYN = forceYawY;
  out.forceWorldZN = -forceYawX * sy + forceYawZ * cy;
  modelToYawFrame(torqueModelX, torqueModelY, torqueModelZ, scratch);
  out.pitchTorqueNm = scratch.x;
  out.yawMomentNm = scratch.y;
  out.rollTorqueNm = scratch.z;
  return out;
}
