import {
  BULWARK_THICKNESS,
  CARGO_HATCH_HALF_BREADTH,
  CARGO_HATCH_HALF_LENGTH,
  CARGO_HATCH_Z,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
  HALF_LENGTH,
  HULL_LENGTH,
  TRANSOM_FLOOR_Y,
  bulwarkOuterHalfBeam,
  counterRakeShift,
  counterStationZ,
} from './hullForm';
import { deckStandAt } from './deckSurface';
import { FOREMAST_Z, MAINMAST_Z, SPARS } from './rig';
import type { Spar } from './rig';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * The deck's furniture: everything that stands on the planking and is not rig.
 *
 * WHY THIS IS ONE FILE AND NOT THREE
 * ----------------------------------
 * A hatch is a thing you see, a thing you walk on and a thing you walk into.
 * `deckFittingGeometry.ts` draws it, `deckObstacles.ts` stops a body at it, and
 * the walker's floor rises onto its grating — and all three read it from here.
 * That is the same contract `deckSurface.ts` holds for the deck itself and
 * `hullForm.ts` holds for the hull, and the round is emphatic about why: the rig
 * carried its own guess at where the bulwark was and put every fitting on the
 * rail inside a wall that was not there.
 *
 * COORDINATES — PLACED, NOT PARAMETER
 * -----------------------------------
 * Everything in this file is in **placed** ship-local coordinates: where the
 * thing actually is, which is what a walker, a camera and a collision test all
 * work in. It is *not* the parameter station the deck's offsets are defined
 * against. Abaft z = -6.2 and above the waterline the two differ by up to
 * 0.79 m, and that difference broke four separate things in the first slice of
 * this round.
 *
 * So no fitting here computes its own height from a station function. Every one
 * of them asks `deckStandAt`, which takes a placed position and inverts the
 * counter's rake to answer it — the same query the walker's feet make. `standOn`
 * below is the only way a height enters this file, and it throws rather than
 * quietly returning a plausible number when a fitting is placed off the ship.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * Loose gear — casks, barrels, chests, the dinghy, coils of rope at their
 * stations. `docs/ship/SHIP_SPEC.md` section 8 asks for a restrained amount of it and
 * warns against dressing her as a theatrical set. It is also the part M6 will
 * want to move, lash and wet, so it is a later pass with different requirements.
 * This file is the working structure: what she is steered, moored, pumped and
 * loaded by.
 */

// --- primitives ---------------------------------------------------------------

/**
 * What a fitting is made of.
 *
 * **Two on deck and seven below, and the split is the point.** A working deck is
 * oak and wrought iron and nothing else: everything up there is rained on,
 * scrubbed, walked on and replaced, and a deck that offered a joiner polished
 * brass would get it on a windlass. The captain's cabin is the one room aboard
 * where that stops being true — a chart desk has a leather writing surface, brass
 * on its drawers and paper in its racks, and drawn in the same oak as a hatch
 * coaming it reads as a crate.
 *
 * **`linen` and `wool` arrived with the berth, and they are the first soft
 * materials aboard.** Everything below decks up to now was timber, metal, hide
 * or paper — four hard surfaces and one thin one — and a made-up bed drawn in
 * any of them is a bed made of furniture. They are also the only two entries in
 * this union that exist for *colour* as much as for substance: the cabin is
 * otherwise brown from the sole to the deckhead, and a pale mattress with a
 * coloured blanket on it is the one thing in the room that is neither.
 *
 * So the union is shared and the *region lists* are not.
 * `deckFittingGeometry.FITTING_REGIONS` names the two that appear on deck and
 * `interiorFittingGeometry.INTERIOR_FITTING_REGIONS` names all seven, so neither
 * carries a palette row for a finish it never draws. `ship-interior.test.ts`
 * asserts that no fitting uses a material its own geometry module does not
 * list — because the failure mode of getting that wrong is silence: a builder
 * with no region simply drops the triangles, and the piece goes missing rather
 * than going wrong.
 */
export type FittingMaterial =
  | 'timber'
  | 'ironwork'
  | 'brass'
  | 'leather'
  | 'paper'
  | 'linen'
  | 'wool';

/**
 * One piece of a fitting.
 *
 * A box takes a yaw; a bar is a tapered round tube between two points and takes
 * any direction. Between them they cover every fitting on this deck, and they
 * are exactly the two primitives `shipwright.ts` already sweeps — so what is
 * drawn and what is collided with come off the same description rather than off
 * two.
 *
 * `collides` is per-piece and not per-fitting because a fitting is not uniform:
 * the hatch's coaming is a kerb you meet and its grating is a floor you stand
 * on, and calling the whole hatch "solid" would put a wall across its own lid.
 * Every `false` needs the reason on its fitting's `kind` to say why.
 *
 * WHY A BOX HAS A YAW AND ONLY A YAW
 * ----------------------------------
 * Everything structural aboard is square with the ship, and the box was
 * axis-aligned for eight rounds because of it: a coaming, a bitt and a bulkhead
 * are all built to the keel. **Furniture is not.** The captain's cabin narrows
 * 0.11 m of half-breadth per metre of length, and a desk shoved against that
 * side by a person ends up lying along it — which is a rotation of about 6.5°
 * and cannot be said at all in an axis-aligned box. `captainsDesk.ts` carried
 * the note asking for this for two rounds.
 *
 * One angle rather than a transform, and about the vertical rather than about
 * anything: a piece of joinery stands on the sole and turns on the sole. Her
 * roll and pitch belong to the hull and are applied to the whole vessel by the
 * scene, so a fitting carrying its own would be heeled twice.
 *
 * **Absent means square**, and that is deliberate rather than lazy. Every box
 * aboard but the cabin's furniture is square with the ship and always will be,
 * so requiring the field would have put `yaw: 0` on some forty pieces of
 * structure and made the one place it matters harder to see, not easier. What
 * makes the optional field safe is that no reader unpacks a box by hand:
 * `boxCorners` and `solidBounds` below are the only two ways a box becomes
 * points, the loft and the collider both go through them, and a reader that
 * forgets the yaw would have to have written the trigonometry itself.
 */
export type FittingSolid =
  | {
      readonly kind: 'box';
      readonly centre: Vec3;
      readonly half: Vec3;
      /** Rotation about the vertical, radians, about the box's own centre. */
      readonly yaw?: number;
      readonly material: FittingMaterial;
      readonly collides: boolean;
    }
  | {
      readonly kind: 'bar';
      readonly a: Vec3;
      readonly b: Vec3;
      readonly radiusA: number;
      readonly radiusB: number;
      /**
       * Rare presentation profile for a round solid. Geometry alone reads it;
       * bounds and collision continue to use the honest outer frustum.
       */
      readonly profile?: 'open-bowl';
      readonly material: FittingMaterial;
      readonly collides: boolean;
    };

/**
 * Which way a yawed box's own axes point, in ship coordinates.
 *
 * `u` is the image of its local +x — athwartships, toward port, when the yaw is
 * zero — and `w` the image of its local +z, which is forward. The pair is used
 * by the loft, by the collider and by every test that has to know where a
 * rotated corner actually is, so the convention is stated once here and nowhere
 * else. `addBox` in `shipwright.ts` builds the same basis and the two must
 * agree; `ship-interior.test.ts` checks that they do by measuring the drawn
 * triangles against these corners.
 */
export function boxAxes(yaw: number | undefined): { u: Vec3; w: Vec3 } {
  const cos = Math.cos(yaw ?? 0);
  const sin = Math.sin(yaw ?? 0);
  return { u: v3(cos, 0, -sin), w: v3(sin, 0, cos) };
}

/** The eight corners of a box, yaw included. */
export function boxCorners(solid: Extract<FittingSolid, { kind: 'box' }>): Vec3[] {
  const { u, w } = boxAxes(solid.yaw);
  const { centre, half } = solid;
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push(
          v3(
            centre.x + sx * half.x * u.x + sz * half.z * w.x,
            centre.y + sy * half.y,
            centre.z + sx * half.x * u.z + sz * half.z * w.z,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * The axis-aligned bounds of a solid — what it occupies, not what shape it is.
 *
 * For a square box this is the box. For a yawed one it is bigger than the piece,
 * and callers have to want that: it is the right answer for "could this be
 * anywhere near that" and the wrong answer for "is this inside that", which is
 * why the collider slices `boxCorners` instead.
 */
export function solidBounds(solid: FittingSolid): {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
} {
  if (solid.kind === 'bar') {
    const r = Math.max(solid.radiusA, solid.radiusB);
    return {
      x0: Math.min(solid.a.x, solid.b.x) - r,
      x1: Math.max(solid.a.x, solid.b.x) + r,
      y0: Math.min(solid.a.y, solid.b.y) - r,
      y1: Math.max(solid.a.y, solid.b.y) + r,
      z0: Math.min(solid.a.z, solid.b.z) - r,
      z1: Math.max(solid.a.z, solid.b.z) + r,
    };
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const c of boxCorners(solid)) {
    x0 = Math.min(x0, c.x);
    x1 = Math.max(x1, c.x);
    z0 = Math.min(z0, c.z);
    z1 = Math.max(z1, c.z);
  }
  return { x0, x1, y0: solid.centre.y - solid.half.y, y1: solid.centre.y + solid.half.y, z0, z1 };
}

/**
 * A flat top a walker stands on.
 *
 * The deck answers one height for any (x, z) — on an open deck there is one —
 * and a fitting with a lid is the first thing aboard that adds a second. It is
 * the cheap half of the problem M4 has to solve properly: a panel is *higher*
 * than the deck, so "the highest surface that admits the query wins" answers it,
 * which is the rule `deckStandAt` already uses across the three deck levels. A
 * cabin sole is *lower* than the deck above it, and that rule cannot answer it.
 */
export interface StandablePanel {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  /** Height of the standing surface, ship-local, above the baseline. */
  readonly y: number;
}

/** Every kind of fitting on this deck. */
export type FittingKind =
  | 'cargoHatch'
  | 'bilgePump'
  | 'mastPartner'
  | 'windlass'
  | 'bowspritHeel'
  | 'tiller'
  | 'foreScuttle';

export interface DeckFitting {
  readonly name: string;
  readonly kind: FittingKind;
  readonly solids: readonly FittingSolid[];
  /** The flat top, if this fitting has one a walker can stand on. */
  readonly standable: StandablePanel | null;
}

/**
 * Every kind of fitting, classified — the same device `OBSTACLE_SOURCES` uses
 * for the rig, and for the same reason.
 *
 * The reasons are claims about dimensions, and a claim that can go stale is
 * worth more than a flag: "under the step-over height" stops being true the
 * moment somebody lowers `stepOver` or raises a coaming, and `ship-deck.test.ts`
 * checks each one against the geometry rather than believing it.
 */
export const FITTING_KINDS: Record<FittingKind, { readonly reason: string }> = {
  cargoHatch: {
    reason:
      'Coaming is a solid kerb; the grating on top of it is a floor. The walker steps up ' +
      'onto the lid because the coaming stands under the step-up height, and the coaming ' +
      'itself is below the step-over height, so it is a thing you cross rather than a wall.',
  },
  bilgePump: {
    reason:
      'A chest-high timber tube with a brake on it, standing in the waist by the mainmast. ' +
      'Solid to a body from the deck to well above the head.',
  },
  mastPartner: {
    reason:
      'The wedged collar where a mast passes through the deck. 0.075 m proud, entirely ' +
      'inside the mast’s own collider, and stepped over rather than walked into.',
  },
  windlass: {
    reason:
      'Barrel and bitt heads across the forecastle. The barrel’s top stands above the ' +
      'step-over height, so the centreline route onto the forecastle is closed and the ' +
      'gangways either side of the bitts are how she is crossed forward.',
  },
  bowspritHeel: {
    reason:
      'Bitts either side of the sprit, the chocks between them, and the bolster under it. ' +
      'The bolster is what stops the sprit reading as a pole passing through the planking; ' +
      'as a collider the sprit is already in SPARS and this timber only fills under it.',
  },
  tiller: {
    reason:
      'It moves. Solid where it is, and the arc it sweeps is reserved space that nothing ' +
      'else may stand in — reserved by a test, not by a collider, because a collider over ' +
      'the whole arc would fence the helmsman out of the place he has to stand.',
  },
  foreScuttle: {
    reason:
      'The rebate frame and the lid, on the starboard gangway forward. **The frame ' +
      'never collides and is never standable**, which is the opposite call from the ' +
      'cargo hatch’s coaming and is the right one twice over: a collidable ring round ' +
      'a hole seals the hole, because with the lid up there is nothing behind the ' +
      'timber to step onto; and a *standable* one 0.22 m from the bulwark turns the ' +
      'pin rail into a kerb the walker can stride over. The lid is let in flush, so ' +
      'the deck answers for this footprint whenever it is shut. The standing lid is ' +
      'the one exception and does collide: 0.75 m of oak on end, over every threshold ' +
      'the walker has, and meant to be walked round.',
  },
};

// --- the deck under a fitting -------------------------------------------------

/**
 * Height of the walking surface under a placed position.
 *
 * The single door through which a height enters this file. It throws, because
 * every caller below is authored data: a fitting whose foot is off the ship is
 * not a fitting drawn slightly wrong, it is a mistake in this file, and the
 * useful moment to say so is the one where the number would have been invented.
 */
function standOn(x: number, z: number): number {
  const stand = deckStandAt(x, z);
  if (!stand) {
    throw new Error(`deck fitting placed off the deck at x=${x.toFixed(3)}, z=${z.toFixed(3)}`);
  }
  return stand.y;
}

function box(
  centre: Vec3,
  half: Vec3,
  material: FittingMaterial,
  collides = true,
): FittingSolid {
  return { kind: 'box', centre, half, material, collides };
}

function bar(
  a: Vec3,
  b: Vec3,
  radiusA: number,
  radiusB: number,
  material: FittingMaterial,
  collides = true,
): FittingSolid {
  return { kind: 'bar', a, b, radiusA, radiusB, material, collides };
}

/**
 * How far a fitting's foot is sunk below the deck it stands on.
 *
 * The deck is crowned 1/50 of its beam, so a level fitting of any width meets a
 * curved floor along one line and lifts off it either side. Sinking the foot
 * hides the gap in the planking rather than trying to follow the camber with the
 * timber, which is what the quarterdeck ladder's treads do — and they do it
 * because a tread is a thing you look straight down at, which a coaming is not.
 */
const FOOT_SINK = 0.06;

// --- the cargo hatch -----------------------------------------------------------

/**
 * The hatch's plan is `hullForm.ts`'s, not this file's.
 *
 * It lived here, and while the deck was the only thing it opened into that was
 * right. It is now the head of a two-deck shaft — the platform's hatchway takes
 * the same footprint directly under it, so a cask falls one straight line from
 * the sky to the stow — and a footprint two decks share is a fact about the
 * vessel. Left here, `deckInterior.ts` could only have agreed with it by typing
 * the same three numbers again.
 */
const HATCH_Z = CARGO_HATCH_Z;
const HATCH_HALF_LENGTH = CARGO_HATCH_HALF_LENGTH;
const HATCH_HALF_BREADTH = CARGO_HATCH_HALF_BREADTH;
/** Thickness of the coaming timber. */
const HATCH_COAMING_THICKNESS = 0.09;

/**
 * How high the coaming stands above the deck.
 *
 * 0.28 m, and the number is not free: `DEFAULT_WALKER_TUNING.stepUp` is 0.32 m,
 * so a coaming taller than that turns the hatch into an island in the middle of
 * the working deck — visible, walkable-looking, and unreachable. It is also a
 * real dimension. A coaming is what keeps a boarding sea out of the hold, and
 * 0.28 m on a 15.5 m vessel is a working height rather than a token lip.
 *
 * `ship-deck.test.ts` asserts the relationship against the walker's own tuning
 * rather than against 0.32 written out again here.
 */
export const HATCH_COAMING_HEIGHT = 0.28;

/**
 * Width of one grating batten, and the clear space between two.
 *
 * Exported because the wardroom's daylight is derived from them: the grating's
 * open-cell fraction is what the interior light model passes through the
 * cargo hatch (`interiorLight.gratingTransmittance`). Change the lattice and
 * the room below changes with it.
 */
export const GRATING_BATTEN = 0.045;
export const GRATING_GAP = 0.052;
/** How far the grating sits below the top of the coaming it lands in. */
const GRATING_REBATE = 0.02;

function cargoHatch(): DeckFitting {
  const outerX = HATCH_HALF_BREADTH + HATCH_COAMING_THICKNESS;
  const outerZ = HATCH_HALF_LENGTH + HATCH_COAMING_THICKNESS;

  // Level, and set from the LOWEST deck around its own edge.
  //
  // A hatch that followed the camber would not take a flat cover, which is the
  // one thing a hatch has to do. But a level lid measured from the crown at the
  // hatch's middle is not 0.28 m above every point you might step from: she
  // rises 85 mm over the hatch's length and falls 18 mm across its breadth to
  // the camber, so the after outboard corners were 0.334 m below the lid —
  // *above* the 0.32 m a body can step. Ash found it as "the grating only
  // allows step-up from certain parts of its border", which is exactly what a
  // step that is 18 mm too tall on two corners of four looks like from the deck.
  //
  // Measured from the lowest point of the perimeter, the tallest step onto it is
  // `HATCH_COAMING_HEIGHT` by construction and every other approach is easier.
  let lowest = Infinity;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    for (const [x, z] of [
      [-outerX + 2 * outerX * t, HATCH_Z - outerZ],
      [-outerX + 2 * outerX * t, HATCH_Z + outerZ],
      [-outerX, HATCH_Z - outerZ + 2 * outerZ * t],
      [outerX, HATCH_Z - outerZ + 2 * outerZ * t],
    ]) {
      lowest = Math.min(lowest, standOn(x, z));
    }
  }
  const deckY = lowest;
  const topY = deckY + HATCH_COAMING_HEIGHT;
  const halfHeight = (HATCH_COAMING_HEIGHT + FOOT_SINK) * 0.5;
  const centreY = topY - halfHeight;

  const solids: FittingSolid[] = [
    // Fore and aft coamings, full width, so the corners are butted by the
    // athwartships pieces — which is how a coaming is framed.
    box(
      v3(0, centreY, HATCH_Z + HATCH_HALF_LENGTH + HATCH_COAMING_THICKNESS * 0.5),
      v3(outerX, halfHeight, HATCH_COAMING_THICKNESS * 0.5),
      'timber',
    ),
    box(
      v3(0, centreY, HATCH_Z - HATCH_HALF_LENGTH - HATCH_COAMING_THICKNESS * 0.5),
      v3(outerX, halfHeight, HATCH_COAMING_THICKNESS * 0.5),
      'timber',
    ),
    ...[1, -1].map((side) =>
      box(
        v3(side * (HATCH_HALF_BREADTH + HATCH_COAMING_THICKNESS * 0.5), centreY, HATCH_Z),
        v3(HATCH_COAMING_THICKNESS * 0.5, halfHeight, HATCH_HALF_LENGTH),
        'timber',
      ),
    ),
  ];

  // The grating: battens both ways, half-lapped, sitting in the coaming's
  // rebate. Not collidable — it is the floor the panel below raises the walker
  // onto, and a grating that was also a wall would stop the body at its own lid.
  const gratingTop = topY - GRATING_REBATE;
  const pitch = GRATING_BATTEN + GRATING_GAP;
  const alongCount = Math.floor((HATCH_HALF_BREADTH * 2) / pitch);
  const acrossCount = Math.floor((HATCH_HALF_LENGTH * 2) / pitch);
  for (let i = 0; i < alongCount; i++) {
    const x = -HATCH_HALF_BREADTH + pitch * (i + 0.5) + GRATING_BATTEN * 0.5;
    solids.push(
      box(
        v3(x, gratingTop - 0.03, HATCH_Z),
        v3(GRATING_BATTEN * 0.5, 0.03, HATCH_HALF_LENGTH),
        'timber',
        false,
      ),
    );
  }
  for (let i = 0; i < acrossCount; i++) {
    const z = HATCH_Z - HATCH_HALF_LENGTH + pitch * (i + 0.5) + GRATING_BATTEN * 0.5;
    solids.push(
      box(
        v3(0, gratingTop - 0.018, z),
        v3(HATCH_HALF_BREADTH, 0.018, GRATING_BATTEN * 0.5),
        'timber',
        false,
      ),
    );
  }

  return {
    name: 'cargoHatch',
    kind: 'cargoHatch',
    solids,
    // The whole footprint, coaming top included: the coaming's top face and the
    // grating are one plane to within the rebate, and a 0.09 m ring of deck at a
    // different height is a trip hazard the walker would have to be told about.
    standable: {
      x0: -outerX,
      x1: outerX,
      z0: HATCH_Z - outerZ,
      z1: HATCH_Z + outerZ,
      y: topY,
    },
  };
}

// --- the fore scuttle ----------------------------------------------------------

/**
 * The crew's scuttle: a coaming, a hinged lid, and a ladder under it.
 *
 * THREE ATTEMPTS, AND THE GEOMETRY DECIDED IT
 * -------------------------------------------
 * This was built flush first, and the argument for flush was good: the scuttle
 * stands in a **1.46 m gangway**, crossed twice by anyone going forward on the
 * starboard hand, and a coaming there is a permanent trip where the cargo
 * hatch's 0.28 m is a thing you walk *to* in the open waist.
 *
 * Flush is not available, and the number that settled it is **0.090 m — the
 * deck's own fall across this footprint.** Measured, not assumed: the planking
 * rises 53 mm with the sheer over the hatch's length and 39 mm with the camber
 * across its breadth, and the two add on a diagonal. A flat lid over that is
 * flush at exactly one corner and 90 mm wrong at the far one, whichever datum
 * it takes — buried on the low rule, floating on the high rule, and splitting
 * it into planks only helps in one axis when the slope runs in two (four
 * strips: 62 mm remaining fore-and-aft, 54 mm athwartships).
 *
 * **Which is what coamings are for.** A coaming is the level rim a flat cover
 * needs over a deck that has none — the reason is naval architecture, not
 * ornament, and this ship's own cargo hatch already records the derived half of
 * it (measure the height from the *lowest* point of the perimeter, or the low
 * corners end up further below the lid than a body can step).
 *
 * So the coaming is back, and the two faults it caused the first time are fixed
 * at their sources rather than by removing it:
 *
 * 1. **It made the lid a mounting block for the ship's rail.** A body on a
 *    raised lid is that much taller than the deck says, and the walker's
 *    step-over test is measured from its feet — so the headsail pin rail on the
 *    bulwark, solid from the planking, came under the step-over height from the
 *    lid, and the walker strode over the rail and came down outboard of it.
 *    `tests/ship-deck.test.ts` caught it as a body 0.145 m inside
 *    `headsailPinRailStarboard[4]` on one heading of sixteen. **The general
 *    rule: any raised standable surface within a stride of the bulwark does
 *    this.** The fix is distance — `FORE_SCUTTLE_X` moved inboard until a body
 *    standing anywhere on the lid cannot reach the rail at all.
 * 2. **Its inner faces glowed into the forecastle.** Everything here stands
 *    above the planking, so `bakeFittingPortalLight` gives it full sky — and
 *    with the hole cut in the deckhead, the room looks straight up at it. Ash
 *    reported the room staying lit with the hatch shut; the light channel was
 *    the main cause and this was the rest. The fix is
 *    `foreScuttleSoffit` in `interiorFittings.ts`: with the lid on, the
 *    underside of the cover *is* the room's ceiling, so an interior-lit panel
 *    closes the hole from below and occludes all of this. Lid up, it is gone
 *    and the shaft is honestly daylit.
 */

/**
 * How high the coaming stands above the lowest planking round its own edge.
 *
 * **It has to clear the deck's 0.090 m fall across the footprint**, or the
 * coaming's own top dips under the planking at the high corner and the lid
 * lands in a hollow. 0.16 leaves 70 mm proud at the highest corner and is
 * itself half the walker's 0.32 m step-up, so the tallest step onto the lid is
 * comfortable from every point of its border — which is the property the cargo
 * hatch's `HATCH_COAMING_HEIGHT` documents and Ash found the absence of.
 *
 * Well under the cargo hatch's 0.28 because this one is stepped *over* on a
 * gangway rather than walked *to* across open deck.
 */
export const FORE_SCUTTLE_COAMING_HEIGHT = 0.16;
const FORE_SCUTTLE_COAMING_THICKNESS = 0.07;
/** Thickness of the lid — one thickness of oak, cleated across the grain. */
const FORE_SCUTTLE_LID_THICKNESS = 0.05;

const FORE_SCUTTLE_OUTER =
  FORE_SCUTTLE_HALF_BREADTH + FORE_SCUTTLE_COAMING_THICKNESS;

/**
 * The level top of the coaming, from the **lowest** planking round its
 * perimeter.
 *
 * The cargo hatch's rule, and its reason applies here unchanged: a lid is flat
 * and the deck under it is not, so a height taken from the crown leaves the low
 * corners further below the lid than the walker can step. Ash found that one as
 * *"the grating only allows step-up from certain parts of its border"*.
 */
export function foreScuttleCoamingTopY(): number {
  let lowest = Infinity;
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const span = -FORE_SCUTTLE_OUTER + 2 * FORE_SCUTTLE_OUTER * t;
    for (const [x, z] of [
      [FORE_SCUTTLE_X + span, FORE_SCUTTLE_Z - FORE_SCUTTLE_OUTER],
      [FORE_SCUTTLE_X + span, FORE_SCUTTLE_Z + FORE_SCUTTLE_OUTER],
      [FORE_SCUTTLE_X - FORE_SCUTTLE_OUTER, FORE_SCUTTLE_Z + span],
      [FORE_SCUTTLE_X + FORE_SCUTTLE_OUTER, FORE_SCUTTLE_Z + span],
    ]) {
      lowest = Math.min(lowest, standOn(x, z));
    }
  }
  return lowest + FORE_SCUTTLE_COAMING_HEIGHT;
}

/**
 * The surface a body walks over while the lid is down.
 *
 * The whole outer ring, coaming included, exactly as the cargo hatch takes its
 * grating and its coaming as one plane: 0.07 m of timber at a different height
 * round the edge of a thing you step onto is a trip hazard only the walker
 * would ever know about.
 *
 * **Not published through `FITTING_PANELS`**, and that is why it is a function.
 * `FITTING_PANELS` is built once at module load; this surface exists only while
 * the lid is shut. `deckObstacles.ts` asks `closures.ts` and then asks this.
 */
export function foreScuttleLidPanel(): StandablePanel {
  return {
    x0: FORE_SCUTTLE_X - FORE_SCUTTLE_OUTER,
    x1: FORE_SCUTTLE_X + FORE_SCUTTLE_OUTER,
    z0: FORE_SCUTTLE_Z - FORE_SCUTTLE_OUTER,
    z1: FORE_SCUTTLE_Z + FORE_SCUTTLE_OUTER,
    y: foreScuttleCoamingTopY() + FORE_SCUTTLE_LID_THICKNESS,
  };
}

function foreScuttleCoaming(): DeckFitting {
  const topY = foreScuttleCoamingTopY();
  const inner = FORE_SCUTTLE_HALF_BREADTH;
  const outer = FORE_SCUTTLE_OUTER;
  const mid = (inner + outer) * 0.5;
  const halfThick = FORE_SCUTTLE_COAMING_THICKNESS * 0.5;

  /** One length of coaming, reaching down to the planking it stands on. */
  const piece = (x: number, z: number, halfX: number, halfZ: number): FittingSolid => {
    let lowest = Infinity;
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 3; j++) {
        lowest = Math.min(
          lowest,
          standOn(x - halfX + (2 * halfX * i) / 3, z - halfZ + (2 * halfZ * j) / 3),
        );
      }
    }
    const foot = lowest - FOOT_SINK;
    const halfHeight = (topY - foot) * 0.5;
    return box(
      v3(x, topY - halfHeight, z),
      v3(halfX, halfHeight, halfZ),
      'timber',
      // **Nothing here collides**, which is the opposite call from the cargo
      // hatch's coaming and is right for this one: a collidable ring round a
      // hole seals the hole, because with the lid up there is nothing behind
      // the timber for a body to step onto and the collider would shut the
      // scuttle exactly when it is meant to be the way below. What stops a body
      // walking in with the lid down is the lid — a real surface at a real
      // height — and what lets it in with the lid up is that there is none.
      false,
    );
  };

  // Fore and aft pieces run the full outer width, so the corners are butted by
  // the athwartships pieces — which is how a coaming is framed.
  const solids: FittingSolid[] = [
    ...[1, -1].map((end) =>
      piece(FORE_SCUTTLE_X, FORE_SCUTTLE_Z + end * mid, outer, halfThick),
    ),
    ...[1, -1].map((side) =>
      piece(FORE_SCUTTLE_X + side * mid, FORE_SCUTTLE_Z, halfThick, inner),
    ),
  ];

  return { name: 'foreScuttle', kind: 'foreScuttle', solids, standable: null };
}

/**
 * The lid, in one state.
 *
 * **Hinged on its forward edge, so it opens aft**, and that is a working detail
 * rather than a preference: a sea coming in over the bow meets the *back* of a
 * lid hinged this way and presses it down onto its coaming. Hinged the other
 * way the same sea takes it off. It also means the standing lid is a thin plane
 * over the forward edge of the hole rather than a panel lying across the deck
 * abaft it, so it blocks nothing the open scuttle was not already blocking.
 *
 * Two states drawn as two geometries, one visible at a time — the reading
 * `buildHatchwayBoardGeometry` sets out. A rotation would serve, since a hinged
 * lid really is one rigid body about one axis; two geometries win anyway
 * because the open state is then something a test can measure rather than a
 * transform nobody checks.
 */
export function foreScuttleLid(open: boolean): DeckFitting {
  const topY = foreScuttleCoamingTopY();
  const half = FORE_SCUTTLE_OUTER;
  const halfThick = FORE_SCUTTLE_LID_THICKNESS * 0.5;
  const hingeZ = FORE_SCUTTLE_Z + FORE_SCUTTLE_OUTER;
  const solids: FittingSolid[] = [];

  if (open) {
    // On end over its own hinge: the free edge stands directly above the
    // forward coaming, not out over the deck forward of it.
    //
    // **This one does collide.** It is 0.89 m of oak standing on end, well over
    // any threshold the walker has, and being an obstacle is the whole of what
    // an open hatch cover is for.
    solids.push(
      box(
        v3(FORE_SCUTTLE_X, topY + half, hingeZ),
        v3(half, half, halfThick),
        'timber',
      ),
    );
  } else {
    solids.push(
      box(
        v3(FORE_SCUTTLE_X, topY + halfThick, FORE_SCUTTLE_Z),
        v3(half, halfThick, half),
        'timber',
        // Shut, the lid is a floor rather than a wall: `foreScuttleLidPanel`
        // raises the walker onto it, and a lid that was also a collider would
        // stop the body at the thing it is standing on.
        false,
      ),
    );
    // A ring bolt in the after edge — what a hand pulls on, and the only thing
    // that says which end of the lid lifts.
    solids.push(
      bar(
        v3(FORE_SCUTTLE_X, topY + FORE_SCUTTLE_LID_THICKNESS, FORE_SCUTTLE_Z - half + 0.09),
        v3(FORE_SCUTTLE_X, topY + FORE_SCUTTLE_LID_THICKNESS + 0.05, FORE_SCUTTLE_Z - half + 0.09),
        0.022,
        0.022,
        'ironwork',
        false,
      ),
    );
  }

  // The two hinges, on the forward coaming. Drawn in both states because they
  // do not move, which is also the cheapest possible proof that the lid pivots
  // about the edge the geometry says it does.
  for (const side of [1, -1]) {
    solids.push(
      bar(
        v3(FORE_SCUTTLE_X + side * half * 0.55, topY + 0.015, hingeZ - 0.05),
        v3(FORE_SCUTTLE_X + side * half * 0.55, topY + 0.015, hingeZ + 0.03),
        0.018,
        0.018,
        'ironwork',
        false,
      ),
    );
  }

  return {
    name: `foreScuttleLid:${open ? 'open' : 'shut'}`,
    kind: 'foreScuttle',
    solids,
    standable: null,
  };
}

/** How far above the shut lid the aiming volume stands. Knee height. */
const FORE_SCUTTLE_LID_TARGET_HEIGHT = 0.45;

/**
 * Where a hand goes to work the scuttle.
 *
 * Knee-high over the lid when it is down, and the standing lid's own volume
 * when it is up — the quantity `hatchwayBoardsBox` reasons out at length: the
 * target is the space a hand would enter, not the 50 mm of oak itself, because
 * a ray aimed at a plank lying on the deck enters it two metres away however
 * close you are standing.
 */
export function foreScuttleLidBox(open: boolean): {
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
} {
  const topY = foreScuttleCoamingTopY();
  const outer = FORE_SCUTTLE_OUTER;
  return {
    xLo: FORE_SCUTTLE_X - outer,
    xHi: FORE_SCUTTLE_X + outer,
    // From the planking rather than the coaming top, so a player standing in
    // the shaft with their head at deck level is still aiming at something.
    yLo: topY - FORE_SCUTTLE_COAMING_HEIGHT,
    yHi: open ? topY + outer * 2 : topY + FORE_SCUTTLE_LID_TARGET_HEIGHT,
    zLo: FORE_SCUTTLE_Z - outer,
    zHi: FORE_SCUTTLE_Z + outer,
  };
}

// --- the bilge pump ------------------------------------------------------------

/**
 * By the mainmast, to port, in the waist.
 *
 * A pump stands at the mast because the well is there: the mast step is the
 * lowest point of the hold and the tube goes down beside it. Offset to port
 * so it is not in the way of the hatch's fore-and-aft working line, and forward
 * of the mast so it is clear of the quarterdeck break.
 */
/**
 * Port, and exported because the pump does not stop at this deck.
 *
 * The tube is a bored log running from the brake down to the limbers — 3.74 m
 * of it, against the 0.92 m that stands above the planking. `interiorFittings.ts`
 * draws the rest: the length standing in the wardroom and the well round its
 * foot in the hold. **It reads its station from here rather than repeating it**,
 * which is the doctrine `hullForm.cabinHeadroomAt`, `INDEX_Y_LO` and the bilge
 * pump's own mass entry each cost this project once — two sources for one
 * position. `ship-interior.test.ts` asserts the two halves meet.
 */
export const PUMP_X = 0.55;
export const PUMP_Z = MAINMAST_Z + 0.55;
const PUMP_HEIGHT = 0.92;
export const PUMP_RADIUS = 0.075;

/**
 * The well's inside, round the tube, and the boards that close it.
 *
 * The casing is not decoration and it is not a shroud. A well is what keeps the
 * cargo off the pump — stow casks against a bare tube and the first heavy sea
 * shifts one against it and the ship has no pump — and it is what you sound to
 * find out how much water she is making. So it is a clear shaft from the
 * limbers to the platform, boarded on four sides, and the stow is built round
 * it rather than through it.
 *
 * **Here rather than in `interiorFittings.ts`, which draws it, and the move is
 * the same cycle `placeInRoom` was moved out of that file for.** The wardroom's
 * mess table is cut short at its after end by this well; the well belongs to
 * the pump and the pump's station is already in this file; and a furniture
 * module that has to import the list it is itself listed in is precisely the
 * import cycle `roomFitting.ts`'s own head records. Only the three plan
 * dimensions moved — the timber is still lofted where it was.
 */
export const PUMP_WELL_CLEAR = PUMP_RADIUS + 0.075;
export const PUMP_WELL_BOARD = 0.04;
export const PUMP_WELL_HALF = PUMP_WELL_CLEAR + PUMP_WELL_BOARD;

/**
 * How far the well head stands above the wardroom sole.
 *
 * Proud enough to read as a thing and to keep sole washings out of the well;
 * under the walker's `stepOver` of 0.40 so it is crossed rather than walked
 * into. The same number `INTERIOR_STEPS` gives the forecastle's sill.
 */
export const PUMP_WELL_HEAD_HEIGHT = 0.25;

function bilgePump(): DeckFitting {
  const deckY = standOn(PUMP_X, PUMP_Z);
  const headY = deckY + PUMP_HEIGHT;
  return {
    name: 'bilgePump',
    kind: 'bilgePump',
    solids: [
      bar(
        v3(PUMP_X, deckY - FOOT_SINK, PUMP_Z),
        v3(PUMP_X, headY, PUMP_Z),
        PUMP_RADIUS * 1.08,
        PUMP_RADIUS,
        'timber',
      ),
      // Iron bands top and bottom — a pump tube is a bored log, and the bands
      // are what stop it splitting.
      bar(
        v3(PUMP_X, headY - 0.09, PUMP_Z),
        v3(PUMP_X, headY - 0.04, PUMP_Z),
        PUMP_RADIUS + 0.012,
        PUMP_RADIUS + 0.012,
        'ironwork',
        false,
      ),
      bar(
        v3(PUMP_X, deckY + 0.12, PUMP_Z),
        v3(PUMP_X, deckY + 0.17, PUMP_Z),
        PUMP_RADIUS * 1.06 + 0.012,
        PUMP_RADIUS * 1.06 + 0.012,
        'ironwork',
        false,
      ),
      // The brake: the lever the pump is worked by, lying forward at rest.
      bar(
        v3(PUMP_X, headY - 0.06, PUMP_Z),
        v3(PUMP_X, headY - 0.20, PUMP_Z + 0.62),
        0.032,
        0.026,
        'timber',
      ),
      // The discharge spout, leading outboard so what comes up goes over the
      // side rather than back down through the deck.
      bar(
        v3(PUMP_X, deckY + 0.34, PUMP_Z),
        v3(PUMP_X + 0.26, deckY + 0.29, PUMP_Z),
        0.045,
        0.038,
        'timber',
        false,
      ),
    ],
    standable: null,
  };
}

// --- mast partners -------------------------------------------------------------

/** Radius of a spar at a height, from its own taper. */
function sparRadiusAtY(spar: Spar, y: number): number {
  const span = spar.head.y - spar.heel.y;
  const t = span > 1e-6 ? Math.min(Math.max((y - spar.heel.y) / span, 0), 1) : 0;
  return spar.heelRadius + (spar.headRadius - spar.heelRadius) * t;
}

function sparByName(name: string): Spar {
  const spar = SPARS.find((s) => s.name === name);
  if (!spar) throw new Error(`no spar named ${name}`);
  return spar;
}

/** How far the wedged collar stands proud of the planking. */
const PARTNER_HEIGHT = 0.075;
/** How far the collar stands out from the mast it is wedged around. */
const PARTNER_MARGIN = 0.13;

function mastPartner(name: string, sparName: string, z: number): DeckFitting {
  const deckY = standOn(0, z);
  const spar = sparByName(sparName);
  const radius = sparRadiusAtY(spar, deckY) + PARTNER_MARGIN;
  return {
    name,
    kind: 'mastPartner',
    solids: [
      bar(
        v3(0, deckY - FOOT_SINK, z),
        v3(0, deckY + PARTNER_HEIGHT, z),
        radius,
        radius * 0.9,
        'timber',
        false,
      ),
    ],
    standable: null,
  };
}

// --- the windlass --------------------------------------------------------------

/**
 * Across the forecastle, abaft the bowsprit's heel.
 *
 * There is one place for it and the ship chose it, not this file. The forecastle
 * runs from its break at z = 4.6 to the stem; the bowsprit's heel is at z = 5.15
 * and from there forward the sprit's underside runs 0.12–0.34 m above the
 * planking the whole way, so nothing at all stands under it. That leaves 0.55 m
 * of clear deck, and the windlass fills it.
 *
 * The consequence is deliberate and is the answer to "is she cramped": the
 * centreline route onto the forecastle is closed by the barrel, and she is
 * crossed forward by the gangways outboard of the bitt heads.
 * `ship-deck.test.ts` measures both, and the reachability fill proves the
 * forecastle is still reachable without them being written down here.
 */
const WINDLASS_Z = 4.86;
/** Half the barrel's length, between the bitt heads. */
const WINDLASS_HALF_SPAN = 0.62;
const WINDLASS_RADIUS = 0.12;
/** Height of the barrel's axis above the deck. */
const WINDLASS_AXIS_HEIGHT = 0.4;
/** Where the bitt heads stand, and how far they rise. */
const WINDLASS_BITT_X = 0.72;
const WINDLASS_BITT_HEIGHT = 0.62;

function windlass(): DeckFitting {
  const deckY = standOn(0, WINDLASS_Z);
  const axisY = deckY + WINDLASS_AXIS_HEIGHT;
  const solids: FittingSolid[] = [
    bar(
      v3(-WINDLASS_HALF_SPAN, axisY, WINDLASS_Z),
      v3(WINDLASS_HALF_SPAN, axisY, WINDLASS_Z),
      WINDLASS_RADIUS,
      WINDLASS_RADIUS,
      'timber',
    ),
  ];

  // The bitt heads the barrel turns in, and the iron gudgeons in them.
  for (const side of [1, -1]) {
    const x = side * WINDLASS_BITT_X;
    const footY = standOn(x, WINDLASS_Z);
    const height = deckY + WINDLASS_BITT_HEIGHT - (footY - FOOT_SINK);
    solids.push(
      box(
        v3(x, footY - FOOT_SINK + height * 0.5, WINDLASS_Z),
        v3(0.08, height * 0.5, 0.12),
        'timber',
      ),
      // The gudgeon runs from *inside* the barrel to the face of the bitt it
      // turns in. It used to start 0.02 m outboard of the barrel's end and stop
      // 0.06 m short of the bitt — a 20 mm stub floating in a 20 mm gap, which
      // is what Ash saw as the metal not quite reaching the pieces it belongs
      // to. An axle that does not touch either thing it joins is drawn from two
      // numbers that were never checked against each other.
      bar(
        v3(side * (WINDLASS_HALF_SPAN - 0.04), axisY, WINDLASS_Z),
        v3(side * (WINDLASS_BITT_X - 0.08), axisY, WINDLASS_Z),
        0.045,
        0.045,
        'ironwork',
        false,
      ),
    );
  }

  // Whelps: the raised strips the cable bites on, so the barrel is not a
  // featureless cylinder when you are standing over it. They run the barrel's
  // full length between the bitts — stopping short of it left a bare collar at
  // each end that read as the strips having failed to reach.
  for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const y = axisY + Math.sin(angle) * (WINDLASS_RADIUS - 0.01);
    const z = WINDLASS_Z + Math.cos(angle) * (WINDLASS_RADIUS - 0.01);
    solids.push(
      box(
        v3(0, y, z),
        v3(WINDLASS_HALF_SPAN - 0.02, 0.022, 0.022),
        'timber',
        false,
      ),
    );
  }

  return { name: 'windlass', kind: 'windlass', solids, standable: null };
}

// --- the bowsprit's heel -------------------------------------------------------

/** A point on the bowsprit's axis, and its radius there, at a placed z. */
function bowspritAt(z: number): { y: number; radius: number } {
  const sprit = sparByName('bowsprit');
  const span = sprit.head.z - sprit.heel.z;
  const t = Math.min(Math.max((z - sprit.heel.z) / span, 0), 1);
  return {
    y: sprit.heel.y + (sprit.head.y - sprit.heel.y) * t,
    radius: sprit.heelRadius + (sprit.headRadius - sprit.heelRadius) * t,
  };
}

/** Where the bitts straddle the sprit, and how far the bolster runs forward. */
const BOWSPRIT_BITT_Z = 5.35;
const BOWSPRIT_BITT_X = 0.3;
const BOWSPRIT_BITT_HEIGHT = 0.58;
const BOLSTER_FORWARD_Z = 6.0;
/** Half the bolster's width — narrower than the sprit, so it reads as a chock. */
const BOLSTER_HALF_BREADTH = 0.19;
/** Where the gammoning binds the sprit down, near the stemhead. */
const GAMMON_Z = 7.35;

function bowspritHeel(): DeckFitting {
  const sprit = sparByName('bowsprit');
  const solids: FittingSolid[] = [];

  // The step: the block of oak the heel butts into.
  //
  // A bowsprit is in compression — every headsail and the fore topmast stay pull
  // it forward, and something has to take that. The heel ended in mid-air here,
  // which Ash asked about directly: "is it meant to front up against something
  // at the end or just hang there?" It is meant to front up against something,
  // and this is it. The block stands from the planking to just over the sprit's
  // top at the heel, so the timber is housed rather than resting on a shelf.
  {
    const at = bowspritAt(sprit.heel.z);
    const zAft = WINDLASS_Z + 0.13;
    const zFwd = sprit.heel.z + 0.02;
    const zMid = (zAft + zFwd) * 0.5;
    const deckY = standOn(0, zMid);
    const topY = at.y + at.radius + 0.03;
    solids.push(
      box(
        v3(0, deckY - FOOT_SINK + (topY - (deckY - FOOT_SINK)) * 0.5, zMid),
        v3(0.22, (topY - (deckY - FOOT_SINK)) * 0.5, (zFwd - zAft) * 0.5),
        'timber',
      ),
    );
  }

  // The bitts, either side of the sprit, and the chocks that close the gap
  // between each bitt and the timber it is holding.
  for (const side of [1, -1]) {
    const x = side * BOWSPRIT_BITT_X;
    const footY = standOn(x, BOWSPRIT_BITT_Z);
    const topY = footY + BOWSPRIT_BITT_HEIGHT;
    const halfHeight = (topY - (footY - FOOT_SINK)) * 0.5;
    solids.push(
      box(v3(x, footY - FOOT_SINK + halfHeight, BOWSPRIT_BITT_Z), v3(0.075, halfHeight, 0.09), 'timber'),
    );

    const at = bowspritAt(BOWSPRIT_BITT_Z);
    const inner = BOWSPRIT_BITT_X - 0.075;
    const chockHalf = Math.max((inner - at.radius) * 0.5, 0.01);
    solids.push(
      box(
        v3(side * (at.radius + chockHalf), at.y, BOWSPRIT_BITT_Z),
        v3(chockHalf, at.radius * 0.8, 0.075),
        'timber',
        false,
      ),
    );
  }

  // The bolster under the sprit, in four steps that each meet its underside at
  // their own station. One block fitted at the middle would stand clear of the
  // timber at the forward end and bury itself in it at the after end, because
  // the sprit rises 0.18 m per metre over this run.
  const steps = 4;
  for (let i = 0; i < steps; i++) {
    const z0 = sprit.heel.z + ((BOLSTER_FORWARD_Z - sprit.heel.z) * i) / steps;
    const z1 = sprit.heel.z + ((BOLSTER_FORWARD_Z - sprit.heel.z) * (i + 1)) / steps;
    const zMid = (z0 + z1) * 0.5;
    const at = bowspritAt(zMid);
    const deckY = standOn(0, zMid);
    const topY = at.y - at.radius * 0.94;
    if (topY <= deckY) continue;
    const halfHeight = (topY - (deckY - FOOT_SINK)) * 0.5;
    solids.push(
      box(
        v3(0, deckY - FOOT_SINK + halfHeight, zMid),
        v3(BOLSTER_HALF_BREADTH, halfHeight, (z1 - z0) * 0.5),
        'timber',
      ),
    );
  }

  // The gammoning: an iron band round the sprit with a strap either side down
  // to the stemhead. Rope gammoning is the older answer and would be a rigging
  // run — this is iron so it stays a fitting, and so the rope-versus-ship
  // checks are not asked a question about a lashing that never moves.
  const gammon = bowspritAt(GAMMON_Z);
  const gammonDeckY = standOn(0, GAMMON_Z);
  solids.push(
    bar(
      v3(0, gammon.y, GAMMON_Z - 0.05),
      v3(0, gammon.y, GAMMON_Z + 0.05),
      gammon.radius + 0.018,
      gammon.radius + 0.018,
      'ironwork',
      false,
    ),
  );
  for (const side of [1, -1]) {
    const x = side * (gammon.radius + 0.01);
    solids.push(
      box(
        v3(x, (gammon.y + gammonDeckY) * 0.5, GAMMON_Z),
        v3(0.016, (gammon.y - gammonDeckY) * 0.5, 0.05),
        'ironwork',
        false,
      ),
    );
  }

  return { name: 'bowspritHeel', kind: 'bowspritHeel', solids, standable: null };
}

// --- the tiller ----------------------------------------------------------------

/**
 * Where the rudder stock comes up through the counter.
 *
 * Derived, not chosen. The sternpost's head is at the after perpendicular, at
 * the underside of the counter — parameter station `-HALF_LENGTH`, height
 * `TRANSOM_FLOOR_Y` — and the stock stands vertically on it. Because that height
 * is below the design draught the counter's shear has not moved it, so the
 * placed z is the station; the expression is written out anyway so that it stays
 * true if the shear is ever keyed differently.
 */
export const RUDDER_STOCK_Z = -HALF_LENGTH - counterRakeShift(-HALF_LENGTH, TRANSOM_FLOOR_Y);

/** How far the rudder head stands above the deck before the tiller is shipped. */
const RUDDER_HEAD_HEIGHT = 0.34;
/** Height of the tiller's socket, and of its forward end, above their own deck. */
const TILLER_SOCKET_HEIGHT = 0.3;
const TILLER_END_HEIGHT = 0.95;
const TILLER_ROOT_RADIUS = 0.058;
const TILLER_END_RADIUS = 0.042;

/**
 * Full helm, either side.
 *
 * A rudder stop, not a taste: 35° is where a rudder stalls and stops steering,
 * and it is the angle the stops are set at on a vessel this size. The tiller's
 * *length* is then whatever the deck permits at that angle — see below. Setting
 * the length first and discovering the helm angle second would be the same
 * mistake in the other direction.
 */
export const TILLER_MAX_HELM = (35 * Math.PI) / 180;

/**
 * How much clear air the tiller keeps from the inboard face of the bulwark at
 * full helm.
 */
const TILLER_RAIL_CLEARANCE = 0.1;

/** Where the tiller is socketed into the rudder head. */
function tillerSocket(): Vec3 {
  return v3(0, standOn(0, RUDDER_STOCK_Z) + TILLER_SOCKET_HEIGHT, RUDDER_STOCK_Z);
}

/**
 * How far the tiller lifts as it runs forward, radians above the horizontal.
 *
 * A tiller is a rigid bar in a socket. Its height above the deck is a property
 * of the bar and of the deck under it, and it does **not** change when the helm
 * goes over — the first version of this function recomputed the rise from the
 * deck under each swept point, which quietly made the tiller bend upward as it
 * swung and put its tip 1.37 m over the planking at full helm.
 *
 * The angle is solved rather than written because both ends are constrained by
 * the deck, and the deck is not flat: the quarterdeck falls 0.33 m from the
 * taffrail forward to its break, so a bar rising at a fixed angle from a socket
 * 0.30 m up arrives at some other height entirely. Two or three passes converge,
 * because the deck's slope here is under 1 in 10.
 */
function tillerRise(length: number): number {
  const socket = tillerSocket();
  let angle = 0;
  for (let pass = 0; pass < 4; pass++) {
    const z = socket.z + length * Math.cos(angle);
    const stand = deckStandAt(0, z);
    if (!stand) break;
    const target = stand.y + TILLER_END_HEIGHT;
    const sin = Math.min(Math.max((target - socket.y) / length, -0.9), 0.9);
    angle = Math.asin(sin);
  }
  return angle;
}

/** A point on the tiller's axis at helm angle `helm`, `t` of the way out. */
function tillerPointAt(helm: number, t: number, length: number, rise: number): Vec3 {
  const socket = tillerSocket();
  const d = length * t;
  const flat = d * Math.cos(rise);
  return v3(
    socket.x + flat * Math.sin(helm),
    socket.y + d * Math.sin(rise),
    socket.z + flat * Math.cos(helm),
  );
}

/** Radius of the tiller's timber `t` of the way out. */
export function tillerRadius(t: number): number {
  return TILLER_ROOT_RADIUS + (TILLER_END_RADIUS - TILLER_ROOT_RADIUS) * t;
}

/**
 * The longest tiller that sweeps its full helm and stays inboard of the bulwark.
 *
 * WHY THE LENGTH IS SOLVED AND NOT CHOSEN
 * ---------------------------------------
 * Her counter is narrow — 1.20 m of half-breadth abreast the rudder head against
 * 2.27 m amidships — and it narrows in exactly the direction the tiller's tip
 * travels. So the tiller's reach at full helm and the deck's width at the station
 * it reaches are two curves that cross, and the crossing is what sets the length.
 * A plausible number written here instead would have produced a tiller that
 * either swept through the rail or gave up a helm angle nobody noticed it had
 * lost.
 *
 * INBOARD OF THE RAIL, NOT MERELY CLEAR OF IT
 * -------------------------------------------
 * The quarterdeck's bulwark is 0.80 m and the tiller's forward end is 0.95 m up,
 * so for its last third the tiller is *above* the caprail and could legally sweep
 * out over the water. That is not the rule used here. A tiller overhanging the
 * sea at full helm is a thing you would notice from the deck and would not
 * believe, and it puts the helmsman's hands outboard of the ship. So the whole
 * bar stays inboard, and that is what makes the constraint bind at all: measured
 * against the rail's *top* the deck never limits her, and the number this
 * function returned was simply its own upper bound.
 *
 * AGAINST THE WALL AT THE TILLER'S OWN HEIGHT
 * -------------------------------------------
 * `deckHalfWidth` is the wall where it meets the floor, and the tiller never
 * sweeps there — it runs 0.30 m up at the socket and 0.95 m up at its end. The
 * bulwark tumbles home 0.11 m per metre of height, so at the tiller's tip the
 * wall stands about 0.10 m further inboard than the deck it is measured over.
 * Clearing the deck's edge by 0.10 m therefore meant touching the planking, and
 * the first solve did exactly that: it put the tip 1.24 m out against a wall that
 * was at 1.28 m, and grazed the main sheet's fairlead on the way. This is the
 * same fault the rig round found in `rig.ts` — a fitting placed against a wall
 * that was not there — arrived at from the other direction.
 */
const LONGEST_PLAUSIBLE_TILLER = HULL_LENGTH / 6;

/** Inboard face of the bulwark beside a placed point, at that point's height. */
function bulwarkInnerXAt(z: number, y: number): number {
  const zParam = counterStationZ(z, y);
  if (Number.isNaN(zParam)) return 0;
  return Math.max(bulwarkOuterHalfBeam(zParam, y) - BULWARK_THICKNESS, 0);
}

function solveTillerLength(): number {
  const clear = (length: number): boolean => {
    const rise = tillerRise(length);
    for (let i = 1; i <= 24; i++) {
      const t = i / 24;
      const p = tillerPointAt(TILLER_MAX_HELM, t, length, rise);
      if (!deckStandAt(0, p.z)) return false;
      const room = bulwarkInnerXAt(p.z, p.y);
      if (Math.abs(p.x) + tillerRadius(t) + TILLER_RAIL_CLEARANCE > room) return false;
    }
    return true;
  };

  // Bisect between something certainly clear and something certainly not. The
  // upper bound is a sixth of her length, which is already a long tiller; the
  // sweep is symmetric, so scanning one side is scanning both.
  let lo = 0.4;
  let hi = LONGEST_PLAUSIBLE_TILLER;
  if (clear(hi)) return hi;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) * 0.5;
    if (clear(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The tiller's length, in metres. Solved once, at module load. */
export const TILLER_LENGTH = solveTillerLength();

/** The tiller's rise above the horizontal, radians. */
export const TILLER_RISE = tillerRise(TILLER_LENGTH);

/** A point on the tiller's axis at helm angle `helm`, `t` of the way out. */
export function tillerAxisPoint(helm: number, t: number): Vec3 {
  return tillerPointAt(helm, t, TILLER_LENGTH, TILLER_RISE);
}

/**
 * The tiller at rest, amidships.
 *
 * M3 has no steering input — heading is still a captive-tow command — and the
 * rudder is real in the mass and hydrostatic models but has nothing driving it.
 * So the tiller is drawn amidships, and what M3 owes the deck is the *space*: a
 * helmsman needs the arc kept clear, and that is checked rather than fenced.
 */
export const TILLER_REST_HELM = 0;

function tiller(): DeckFitting {
  const deckY = standOn(0, RUDDER_STOCK_Z);
  const socket = tillerAxisPoint(TILLER_REST_HELM, 0);
  const end = tillerAxisPoint(TILLER_REST_HELM, 1);
  return {
    name: 'tiller',
    kind: 'tiller',
    solids: [
      // The rudder head: the top of the stock, standing proud of the deck in its
      // trunk, with the iron band the tiller is socketed into.
      box(
        v3(0, deckY - FOOT_SINK + (RUDDER_HEAD_HEIGHT + FOOT_SINK) * 0.5, RUDDER_STOCK_Z),
        v3(0.11, (RUDDER_HEAD_HEIGHT + FOOT_SINK) * 0.5, 0.11),
        'timber',
      ),
      bar(
        v3(0, deckY + RUDDER_HEAD_HEIGHT - 0.09, RUDDER_STOCK_Z),
        v3(0, deckY + RUDDER_HEAD_HEIGHT - 0.03, RUDDER_STOCK_Z),
        0.135,
        0.135,
        'ironwork',
        false,
      ),
      bar(socket, end, TILLER_ROOT_RADIUS, TILLER_END_RADIUS, 'timber'),
    ],
    standable: null,
  };
}

// --- the deck, furnished -------------------------------------------------------

/**
 * Everything standing on her, built once at module load.
 *
 * Static for the same reason `DECK_OBSTACLES` is: nothing here moves until M6
 * gives the tiller a rudder to turn, so the loft, the collision index and the
 * tests all read one constant rather than each rebuilding it.
 */
export const DECK_FITTINGS: readonly DeckFitting[] = [
  cargoHatch(),
  // The coaming only. The lid is state and is built by `foreScuttleLid`, which
  // is not in this list for the reason `FITTING_PANELS` exists at all: this
  // list is static, and a hatch that is in it is a hatch in one state forever.
  foreScuttleCoaming(),
  bilgePump(),
  mastPartner('mainPartner', 'mainmast', MAINMAST_Z),
  mastPartner('forePartner', 'foremast', FOREMAST_Z),
  windlass(),
  bowspritHeel(),
  tiller(),
];

/** Every standable top on deck, in the order the fittings declare them. */
export const FITTING_PANELS: readonly StandablePanel[] = DECK_FITTINGS.flatMap((f) =>
  f.standable ? [f.standable] : [],
);

/**
 * The highest fitting top under a placed position, or null.
 *
 * Highest rather than first, for the same reason `deckStandAt` takes the highest
 * level: two panels that overlap are a mistake, but answering the lower of them
 * would be a mistake that hides inside a working deck.
 */
export function fittingStandAt(x: number, z: number): number | null {
  let best: number | null = null;
  for (const panel of FITTING_PANELS) {
    if (x < panel.x0 || x > panel.x1) continue;
    if (z < panel.z0 || z > panel.z1) continue;
    if (best === null || panel.y > best) best = panel.y;
  }
  return best;
}

/** Length of a fitting's bar, for tests and reports. */
export function solidExtent(solid: FittingSolid): { yLo: number; yHi: number } {
  const bounds = solidBounds(solid);
  return { yLo: bounds.y0, yHi: bounds.y1 };
}
