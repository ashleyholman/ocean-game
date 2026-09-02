import { rigNode } from './rig';
import {
  BULWARK_THICKNESS,
  CAPRAIL_OVERHANG,
  CAPRAIL_THICKNESS,
  HALF_LENGTH,
  bulwarkTopY,
  counterRakeShift,
  railSection,
} from './hullForm';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * The wind cues: the ensign, the masthead pennant and the dogvane.
 *
 * `docs/ship/SHIP_DECK_HANDOVER.md` closed M3 with this as a recorded gap — *"she has no
 * wind indicator of any kind… `docs/ship/SHIP_SPEC.md` never mentions one, so this is a
 * gap in the spec rather than a deferred milestone. It matters more than
 * dressing: it is how a helmsman reads the wind."* This module is that gap
 * filled.
 *
 * WHY THESE ARE NOT TREATED LIKE THE SAILS
 * ---------------------------------------
 * Every sail aboard is drawn at a fixed sheeted angle and will stay that way
 * until S4 makes trim a control. That is defensible for a sail, because a
 * sail's angle is a *trim decision*: `SHEET_MAIN = 26°` is not a lie, it is a
 * vessel that has been sheeted and left.
 *
 * A wind indicator has one job, which is to point. A pennant frozen at an
 * authored angle is not an unanimated pennant — it is an instrument showing a
 * wrong reading, and the correct reading already exists: `WorldWind` has been
 * the world's wind authority since S1, gusts included. So the cues are built
 * **fixed in shape and live in orientation**. The cloth is a rigid strip with a
 * shallow standing wave baked into it — no flutter, no shiver, no cloth
 * dynamics, all of which are M6 — and its attitude is recomputed every frame
 * from the apparent wind at the cue's own position.
 *
 * Ash's call, and the reason it matters: **the truth ships even where it
 * contradicts the rig.** She is drawn as a correctly trimmed starboard-tack
 * vessel with everything sheeted to port, while her heading is free. So on most
 * headings these cues will show a wind the sails are not set for. That is the
 * honest state of the ship until S2 puts wind into the sails and S4 lets the
 * trim move; the cue is right and the sheeting is provisional, and hiding the
 * disagreement would mean building a second, wrong wind.
 *
 * WHERE THEY WENT, AND WHY IT WAS A SOLVE
 * ---------------------------------------
 * A cue sweeps a disc: it points anywhere in 360° and droops toward the deck as
 * the wind drops. So its placement is not a position, it is a *volume*, and the
 * only honest way to choose one is to sweep it against everything the ship
 * already carries. `tests/ship-wind-cues.test.ts` is that sweep and it chose all
 * three numbers below. What it rejected is as informative as what it kept:
 *
 * - **The gaff peak, where a gaff vessel actually wears her ensign, cannot
 *   carry a rigid one.** The peak is the gaff's own end, so a flag streaming
 *   forward from it lies *along* the spar it is bent to — 0.07 m inside it at
 *   the worst heading, and no lateral standoff fixes that, because the standoff
 *   rotates with the wind and the cloth simply crosses the spar 0.28 m out
 *   instead of 0. (A real ensign does lie on the gaff there; cloth can do that
 *   and a rigid strip cannot.) That is why she wears hers on a taffrail staff,
 *   which is also what a boom overhanging the transom by two metres forces.
 * - **The main sheet, not the transom, sets the ensign staff's height.** The
 *   sheet drops from the boom to a horse abaft the rudder head, straight through
 *   the airspace over the taffrail, and clearance to it is monotone in staff
 *   height: 1.86 m of staff fouls it, 2.16 m grazes it by 0.010 m. The staff is
 *   1.75 m above the caprail it is socketed in — 2.59 m from the deck — and
 *   clears the sheet by 0.43 m at every wind direction and every droop. The last
 *   130 mm of it were bought by the *limp* case rather than the sheet: below
 *   that the drooping cloth hangs under the taffrail and over the counter.
 * - **The pennant's droop bound is set by ropes that end where it does.** The
 *   topsail braces run from the yardarms up to the main topmast head, arriving
 *   at the very point the pennant is hoisted at, so a pennant streaming forward
 *   and drooping lies on them. Pig-stick length is what buys droop, in
 *   proportion — the higher the hoist, the further the braces have fallen away
 *   by the time the cloth reaches them. At 0.9 m of stick they bit at 40°; at
 *   1.4 m the cloth clears by 0.32 m at 50° and is inside them at 65°.
 *
 * THE DROOP BOUND IS AN HONEST LIMIT, NOT A TUNING
 * ------------------------------------------------
 * `FLAT` and `FROZEN_SINGLE` carry 0 m/s of wind and `DEAD_CALM` 0.8, so the
 * limp case is a real state of this world — and a limp flag does two things a
 * rigid quadrilateral cannot. It hangs *against* the spar it is bent to, and its
 * fly and its drop fall the same way, so the cloth folds onto itself. Here the
 * second is what bites: past about 60° the fly and the luff point so nearly
 * alike that the sheared quadrilateral closes to a sliver.
 *
 * So every cue stops at `maxDroopRad`, and each one names which of two things
 * set it — the rig it would foul, or the collapse. In a flat calm they show a
 * heavy, obviously light-air attitude rather than a dead vertical one. That is
 * the one thing here an eye can catch as wrong, and it is cloth behaviour, which
 * is M6's.
 */

/** Which reference frame a cue's attitude is set in. */
export type WindCueAttitude =
  /**
   * Free cloth on a halyard. Gravity and the wind set its attitude, not the
   * spar — so it stays level in the world as she rolls, rotating about its own
   * hoist. Parenting a flag rigidly to a mast would heel it with the mast,
   * which is the one thing a flag visibly does not do.
   */
  | 'free'
  /**
   * A vane on a spindle. The spindle is seized to the rail and tilts with the
   * ship; the vane pivots about it. So this one *does* heel with her, and that
   * is the difference between a vane and a flag rather than an inconsistency.
   */
  | 'spindle';

export type WindCueKind = 'ensign' | 'pennant' | 'dogvane';

export interface WindCue {
  readonly name: string;
  readonly kind: WindCueKind;
  readonly attitude: WindCueAttitude;
  /** The staff or spindle the cloth is bent to, in placed model coordinates. */
  readonly staff: {
    readonly foot: Vec3;
    readonly head: Vec3;
    readonly footRadius: number;
    readonly headRadius: number;
  };
  /**
   * The iron arm carrying the staff clear of what it is clamped to, if any.
   *
   * Only the dogvane has one, and the walker is why. On the middle of the
   * caprail its spindle stood 0.240 m from the nearest place a body can put its
   * whole footprint, against a body radius of 0.26 — so "out of reach" was false
   * by 20 mm and the classification in `WIND_CUE_KINDS` would have been a claim
   * the ship did not support. A bracket clamped to the rail's outboard face
   * carries it 0.11 m further out, which is both where a vane socket is actually
   * fitted (clear of the working deck, on purpose) and enough to make the claim
   * true with margin.
   */
  readonly bracket?: {
    readonly from: Vec3;
    readonly to: Vec3;
    readonly radius: number;
  };
  /**
   * How far the hoist stands off the staff's head, along the wind.
   *
   * A halyard is not the staff: the cloth hangs a little clear of the timber and
   * swings round it, which is what keeps the root of the flag out of the spar it
   * is bent to at every heading.
   */
  readonly standoff: number;
  /** Length along the wind. */
  readonly fly: number;
  /** Depth of the cloth at the hoist and at the fly end — the taper. */
  readonly hoistDepth: number;
  readonly flyDepth: number;
  /** The baked-in standing wave: peak displacement, and cycles along the fly. */
  readonly waveAmplitude: number;
  readonly waveCycles: number;
  /** The droop it stops at, however light the air. See the note above. */
  readonly maxDroopRad: number;
  /** Apparent-wind speed at which the cloth stands at 45°. */
  readonly limpSpeedMps: number;
  /** First-order lag on the attitude, standing in for the cloth's inertia. */
  readonly settleSeconds: number;
  readonly cloth: 'ensignRed' | 'flax' | 'vane';
  readonly staffMaterial: 'pine' | 'iron';
}

const DEG = Math.PI / 180;

/**
 * Where the ensign staff is socketed: the middle of the taffrail's own width.
 *
 * Derived from the caprail rather than measured off a screenshot. The transom's
 * rail is drawn in `shipGeometry.ts` from exactly these four quantities — the
 * bulwark top at the after perpendicular, the counter's rake shift that turns
 * that station into a placed position, the cap's thickness, and its depth of
 * wall-plus-two-overhangs. A staff standing on a number typed in here instead
 * would sink into the rail the moment the sheer is retuned.
 */
function taffrailSocket(): Vec3 {
  const topY = bulwarkTopY(-HALF_LENGTH);
  const placedZ = -HALF_LENGTH - counterRakeShift(-HALF_LENGTH, topY);
  const capDepth = BULWARK_THICKNESS + CAPRAIL_OVERHANG * 2;
  return v3(0, topY + CAPRAIL_THICKNESS, placedZ + capDepth / 2);
}

/**
 * Where the dogvane's spindle is seized: the starboard quarter rail, abreast the
 * after end of the main channel.
 *
 * Forward of the counter's shear, so the station and the placed position are the
 * same z — the one place on this ship where that is safe to assume, and it is
 * asserted rather than assumed in the test.
 *
 * **Starboard because starboard is the weather side as she is drawn**, and a
 * dogvane is shifted to the weather rigging by hand when she goes about. That
 * makes its *station* a trim decision of exactly the same kind as the sheets —
 * frozen with them, and pointing true regardless.
 */
const DOGVANE_STATION_Z = -4.6;

/** How far outboard of the caprail's face the bracket carries the spindle. */
const DOGVANE_BRACKET_REACH = 0.11;

function dogvaneBracket(): { from: Vec3; to: Vec3 } {
  const rail = railSection(DOGVANE_STATION_Z);
  return {
    // Clamped to the rail's outboard face, a little under the cap.
    from: v3(-rail.capOuterX, rail.capY - 0.035, DOGVANE_STATION_Z),
    to: v3(-(rail.capOuterX + DOGVANE_BRACKET_REACH), rail.capY, DOGVANE_STATION_Z),
  };
}

/** The main truck — the highest point of the rig, and where a pennant belongs. */
function mainTruck(): Vec3 {
  const truck = rigNode('mainTopmastHead');
  return v3(truck.x, truck.y, truck.z);
}

/**
 * The pig stick: the light staff a pennant is hoisted on above the truck.
 *
 * Its length is not decoration. See the head note — it is what buys the pennant
 * its droop against the port topsail brace, which ends at the same masthead the
 * pennant is hoisted at, and it buys it in proportion: the higher the hoist, the
 * further the brace has fallen away by the time the cloth reaches it.
 *
 * 1.4 m rather than the 0.9 this round started with, because Ash's first look
 * said the pennant read as having no height. A deeper pennant sweeps a deeper
 * volume, so the depth had to be bought from the same budget as the fly, and the
 * stick is where it came from.
 */
const PIG_STICK_LENGTH = 1.4;

/**
 * The ensign staff's height above the caprail it is socketed in.
 *
 * Set by what the cloth must clear when it is *limp*, not by proportion: at its
 * droop bound the ensign's lowest corner hangs 1.65 m below the truck of the
 * staff, and at 1.62 m that put it 30 mm under the taffrail, over the counter.
 * 1.75 m keeps the whole swept envelope above the rail at every wind direction.
 */
const ENSIGN_STAFF_HEIGHT = 1.75;

/** How high the dogvane's vane stands above the rail it is seized to. */
const DOGVANE_SPINDLE_HEIGHT = 0.8;

function buildCues(): readonly WindCue[] {
  const socket = taffrailSocket();
  const bracket = dogvaneBracket();
  const vaneFoot = bracket.to;
  const truck = mainTruck();

  return [
    {
      name: 'ensign',
      kind: 'ensign',
      attitude: 'free',
      /**
       * Vertical, and it is worth saying why, because a real ensign staff rakes
       * aft. The flag's luff hangs from gravity — that is the shear this round
       * had to build to keep it on the halyard at all — so a raked staff and a
       * hanging luff diverge by the rake over the depth of the flag: 43 mm at
       * 3.5° of rake over 0.7 m of hoist, which is more than the standoff and
       * reads as the cloth pulling away from the timber at the foot. Following
       * the staff instead would mean a luff that heels with the ship, which is
       * the thing a flag conspicuously does not do. A plumb staff makes the two
       * agree exactly and costs a detail nobody will miss.
       */
      staff: {
        foot: socket,
        head: v3(socket.x, socket.y + ENSIGN_STAFF_HEIGHT, socket.z),
        footRadius: 0.038,
        headRadius: 0.022,
      },
      // The luff hangs a hand's breadth off the staff, which is a halyard's
      // worth of clearance and no more. It was 0.06 while the droop was a
      // rotation and the luff swung away from the staff anyway; with the shear
      // holding the luff vertical this is the whole of the visible gap, so it is
      // the staff's own radius plus a little.
      standoff: 0.035,
      fly: 1.1,
      hoistDepth: 0.7,
      flyDepth: 0.7,
      waveAmplitude: 0.075,
      waveCycles: 1.15,
      // Nothing in the rig binds this one at any droop — the sweep says so, and
      // records it. The bound is the collapse: it is the deepest cloth aboard, so
      // it is the first to close on itself as the fly falls toward the luff.
      maxDroopRad: 60 * DEG,
      // The heaviest cloth aboard and the largest: she needs real air to stand
      // out, and this is the cue that reads wind *strength* rather than
      // direction.
      limpSpeedMps: 4.0,
      settleSeconds: 0.7,
      cloth: 'ensignRed',
      staffMaterial: 'pine',
    },
    {
      name: 'mastheadPennant',
      kind: 'pennant',
      attitude: 'free',
      staff: {
        foot: truck,
        head: v3(truck.x, truck.y + PIG_STICK_LENGTH, truck.z),
        footRadius: 0.026,
        headRadius: 0.014,
      },
      standoff: 0.1,
      fly: 2.4,
      /**
       * 0.42 m at the hoist, tapering to a point-ish 0.05.
       *
       * It began as a 0.16 m ribbon, which is what a commissioning pennant
       * actually is, and at 23 m it read as a scratch. This is a broad pennant
       * instead — a swallowtail without the swallow — and the argument for it is
       * legibility rather than precedent: the masthead cue is the one a sailor
       * looks at first and it is the furthest from the eye, so it is the one
       * that can least afford to be correct and invisible.
       */
      hoistDepth: 0.42,
      flyDepth: 0.05,
      waveAmplitude: 0.11,
      waveCycles: 1.4,
      /**
       * The port topsail brace ends at this masthead, and the starboard one just
       * beyond it: the cloth clears them by 0.32 m at 50°, by 0.04 m at 60°, and
       * is inside them at 65°. 50° is the bound, and it is also comfortably
       * below where a pennant this deep would start collapsing on itself.
       *
       * The taller pig stick bought this: at 0.9 m of stick the same braces bit
       * at 40°.
       */
      maxDroopRad: 50 * DEG,
      // Light bunting on a long fly. It stands out in almost anything, which is
      // why it is the cue you read from the deck at a glance.
      limpSpeedMps: 2.0,
      settleSeconds: 0.9,
      cloth: 'flax',
      staffMaterial: 'pine',
    },
    {
      name: 'dogvane',
      kind: 'dogvane',
      attitude: 'spindle',
      staff: {
        foot: vaneFoot,
        head: v3(vaneFoot.x, vaneFoot.y + DOGVANE_SPINDLE_HEIGHT, vaneFoot.z),
        footRadius: 0.012,
        headRadius: 0.008,
      },
      bracket: { from: bracket.from, to: bracket.to, radius: 0.014 },
      standoff: 0.04,
      fly: 0.4,
      hoistDepth: 0.13,
      flyDepth: 0.05,
      waveAmplitude: 0.02,
      waveCycles: 0.9,
      // The sweep says 0.9 m of clear air in every direction — nothing is near
      // it. Bounded by the collapse, and later than the ensign because a vane
      // this shallow stays a readable shape further over.
      maxDroopRad: 62 * DEG,
      // The lightest thing aboard, and deliberately so: a dogvane that needs a
      // breeze to work is not a dogvane.
      limpSpeedMps: 1.0,
      settleSeconds: 0.35,
      cloth: 'vane',
      staffMaterial: 'iron',
    },
  ];
}

export const WIND_CUES: readonly WindCue[] = buildCues();

/**
 * Every kind of wind cue, classified for collision.
 *
 * `OBSTACLE_SOURCES` in `deckObstacles.ts` enumerates `rig.ts`; `FITTING_KINDS`
 * enumerates `deckFittings.ts`. Neither can see this module, and both would have
 * gone on passing forever while a third list of solid objects grew beside them —
 * **a completeness check is only complete about the thing it enumerates**
 * (`docs/ship/SHIP_DECK_HANDOVER.md` §8.1). So this is the third one.
 *
 * All three are out of reach, and each reason names what would have to change
 * for it to stop being true.
 */
export const WIND_CUE_KINDS: Record<WindCueKind, { collidable: boolean; reason: string }> = {
  ensign: {
    collidable: false,
    reason:
      'Socketed in the taffrail, which stands on the bulwark — outboard of the deck the ' +
      'walker is bounded by, and 0.83 m above it. A body is stopped by the bulwark before ' +
      'its footprint reaches the staff at any height. Moving the socket inboard onto the ' +
      'planking would make this false.',
  },
  pennant: {
    collidable: false,
    reason:
      'On a pig stick above the main truck, 22.9 m up. M5 climbs to the crosstrees at ' +
      '13.15 m, which is 9 m below it.',
  },
  dogvane: {
    collidable: false,
    reason:
      'A spindle on a bracket clamped to the outboard face of the quarter caprail, 0.11 m ' +
      'clear of it. Measured: 0.42 m from the nearest place a body can stand with its ' +
      'whole footprint on deck, against a 0.26 m body. On the middle of the rail instead ' +
      'of outboard of it that figure was 0.240 m and this reason was false, which is what ' +
      'put the bracket there. Bringing it back inboard would make it false again.',
  },
};

/**
 * How far the cloth droops below the horizontal, from the apparent wind speed.
 *
 * A flag hangs where its own weight balances the air's push, and the push goes
 * as speed squared — so `tan(droop) ∝ 1/v²`, which is what this is, with
 * `limpSpeedMps` naming the speed at which the two are equal and the cloth
 * stands at 45°. It is not a curve fitted to look right; the only fitted number
 * is the one speed, per cue, and the clamp above it.
 *
 * The clamp is the honest part: see the head note. Below the bound the strip
 * would be inside the spar it is bent to.
 */
export function windCueDroopRad(cue: WindCue, apparentSpeedMps: number): number {
  const v = Math.max(apparentSpeedMps, 0);
  if (v <= 1e-6) return cue.maxDroopRad;
  const droop = Math.atan((cue.limpSpeedMps * cue.limpSpeedMps) / (v * v));
  return Math.min(droop, cue.maxDroopRad);
}

/**
 * A point on the cue's cloth, in the cue's own frame: +x along the fly, −y down
 * the drop, +z across the standing wave.
 *
 * **This is the shape, and it is the only description of it.** The loft builds
 * its vertices from this function and the clearance sweep measures this
 * function, so the thing tested is the thing drawn — `docs/ship/SHIP_DECK_HANDOVER.md` §2,
 * where a main sheet was cleared by measuring the straight line between its ends
 * while the drawn rope sagged 18% and lay inside the caprail.
 */
export function windCueClothPoint(cue: WindCue, u: number, v: number): Vec3 {
  const depth = cue.hoistDepth + (cue.flyDepth - cue.hoistDepth) * u;
  // The luff is held straight by the halyard, so the wave grows from nothing at
  // the hoist. A flag that waves at its own hoist reads as a flag that is not
  // attached to anything.
  const grow = u * u;
  const phase = 2 * Math.PI * cue.waveCycles * u - 0.6 * v;
  return v3(cue.fly * u, -depth * v, cue.waveAmplitude * grow * Math.sin(phase));
}

/** The surface normal of `windCueClothPoint` at (u, v), by its own partials. */
export function windCueClothNormal(cue: WindCue, u: number, v: number): Vec3 {
  const h = 1e-4;
  const a = windCueClothPoint(cue, Math.min(u + h, 1), v);
  const b = windCueClothPoint(cue, Math.max(u - h, 0), v);
  const c = windCueClothPoint(cue, u, Math.min(v + h, 1));
  const d = windCueClothPoint(cue, u, Math.max(v - h, 0));
  const du = v3(a.x - b.x, a.y - b.y, a.z - b.z);
  const dv = v3(c.x - d.x, c.y - d.y, c.z - d.z);
  const n = v3(
    du.y * dv.z - du.z * dv.y,
    du.z * dv.x - du.x * dv.z,
    du.x * dv.y - du.y * dv.x,
  );
  const length = Math.hypot(n.x, n.y, n.z);
  if (length < 1e-12) return v3(0, 0, 1);
  return v3(n.x / length, n.y / length, n.z / length);
}

/**
 * The basis the cue's cloth is carried in, for a wind blowing *toward*
 * `headingRad` and a droop of `droopRad`.
 *
 * `headingRad` is a render/body-frame heading in this file's own axes: the
 * direction `(sin, −cos)`, which is the same convention `WorldWind` uses to turn
 * a compass bearing into a vector.
 *
 * **THIS IS A SHEAR, NOT A ROTATION, AND THAT IS THE WHOLE POINT.**
 *
 * The first version rotated the entire flag by the droop — an orthonormal basis,
 * one quaternion, and wrong. A flag is held along its *luff* by a halyard, and
 * the halyard does not tip: only the fly falls. Rotating the whole cloth swings
 * the luff away from the staff with the fly, so the bottom of the ensign's hoist
 * stood 0.28 m off its own staff at 24° of droop — at which point the flag reads
 * as floating beside the ship rather than being bent to anything. Ash saw it in
 * the first frame he looked at.
 *
 * So `y` is the luff, and it stays put: straight up, along the halyard. `x` is
 * the fly, and it droops. The two are **not perpendicular** — their dot product
 * is exactly `−sin(droop)` — which is what makes this a shear and is why the
 * cue's transform is a matrix rather than a quaternion. `z` is their normalised
 * cross product, so the cloth still has an honest normal to be lit by.
 */
export function windCueBasis(
  headingRad: number,
  droopRad: number,
): { x: Vec3; y: Vec3; z: Vec3 } {
  const s = Math.sin(headingRad);
  const c = Math.cos(headingRad);
  const cd = Math.cos(droopRad);
  const sd = Math.sin(droopRad);
  // +x is the fly: the wind's direction, tipped down by the droop.
  const x = v3(s * cd, -sd, -c * cd);
  // +y is the luff: the halyard, which is vertical whatever the fly is doing.
  const y = v3(0, 1, 0);
  const cross = v3(
    x.y * y.z - x.z * y.y,
    x.z * y.x - x.x * y.z,
    x.x * y.y - x.y * y.x,
  );
  const length = Math.hypot(cross.x, cross.y, cross.z);
  const z =
    length < 1e-9 ? v3(0, 0, 1) : v3(cross.x / length, cross.y / length, cross.z / length);
  return { x, y, z };
}

/**
 * Where the cue's hoist sits for a given wind — the staff's head, plus the
 * standoff, carried round the staff by the wind.
 */
export function windCueHoistPoint(cue: WindCue, headingRad: number): Vec3 {
  return v3(
    cue.staff.head.x + Math.sin(headingRad) * cue.standoff,
    cue.staff.head.y,
    cue.staff.head.z - Math.cos(headingRad) * cue.standoff,
  );
}

/**
 * A point of the swept cloth in ship-local coordinates, composed from the three
 * functions above. The clearance sweep is this; so is what is drawn.
 */
export function windCueSweptPoint(
  cue: WindCue,
  headingRad: number,
  droopRad: number,
  u: number,
  v: number,
): Vec3 {
  const basis = windCueBasis(headingRad, droopRad);
  const local = windCueClothPoint(cue, u, v);
  const root = windCueHoistPoint(cue, headingRad);
  return v3(
    root.x + basis.x.x * local.x + basis.y.x * local.y + basis.z.x * local.z,
    root.y + basis.x.y * local.x + basis.y.y * local.y + basis.z.y * local.z,
    root.z + basis.x.z * local.x + basis.y.z * local.y + basis.z.z * local.z,
  );
}
