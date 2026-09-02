import type { FittingSolid } from './deckFittings';
import { PUMP_WELL_HALF, PUMP_X, PUMP_Z } from './deckFittings';
import {
  BELOW_DECKS_SPACES,
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  belowDecksSpace,
} from './deckInterior';
import { CABIN_LINING_THICKNESS } from './deckInterior';
import { DECK_BEAM_DEPTH, DECK_PLANK_THICKNESS, floorYAt, halfBreadthAt } from './hullForm';
import { v3 } from './shipwright';

/**
 * What is under the floors — the stow, and the one place in the ship where the
 * cargo *is* the architecture.
 *
 * WHY THIS IS NOT FURNITURE
 * -------------------------
 * `interiorFittings.ts` places things in rooms, against walls, by anchor. None
 * of that applies here. The hold is not a room: it has no sole, its bounds are
 * the frames, and what fills it is not authored piece by piece but *stowed* —
 * built up from the floors in tiers by a rule, the way a stow actually is. So
 * this file takes the hull and the mass model and produces a stow, rather than
 * taking a list of objects and placing them.
 *
 * THE ARITHMETIC IS NOT OURS TO CHOOSE, AND THAT IS THE POINT
 * ----------------------------------------------------------
 * Everything here is derived from `massModel.ts` and `hullForm.ts`:
 *
 * | | |
 * |---|---|
 * | iron ballast, 32.2 t at 4200 kg/m³ stowed | 7.67 m³ |
 * | fresh water, 4.8 t in casks at ~64% | 7.50 m³ |
 * | salt provisions and dry stores | 9.30 m³ |
 * | hull under the wardroom's sole | **27.75 m³** |
 *
 * The ballast is *solved* — it is whatever closes Archimedes at the design
 * draught — so where it tops out is a fact about the ship rather than a number
 * anybody picked. It comes to **y = 0.880**, which with the platform sole at
 * 1.80 leaves 0.92 m. That is the hold's whole story: 88% full, 139 mm of air
 * if you spread the slack, and one place with real room in it because the
 * hatchway has to be kept clear to work the stow at all.
 *
 * `SHIP_SPEC.md` §10 asks for exactly this and warns against more: *a shallow
 * low-detail area visible through the cargo hatch, casks and crates and cordage
 * suggested in shadow, the deeper hold disappearing into darkness. Do not spend
 * geometry on inaccessible deep storage.* So the stow is drawn where it is seen
 * — round the hatchway well — and thins to a floor and a lining beyond it.
 */

// --- what the mass model puts down here ---------------------------------------

/** Iron ballast as stowed, m³ — `massModel.solveBallast` over pig iron's 4200. */
const BALLAST_VOLUME = 32225 / 4200;

/** Stations the stow is built between: the hold is under the wardroom. */
const HOLD = belowDecksSpace('wardroom');

/** The lowest floor aboard, and so the lid on the stow. */
export const HOLD_SOLE_Y = HOLD.soleY;

/** Hull volume between two heights over the hold's own length, m³. */
function holdVolume(yLo: number, yHi: number): number {
  const NZ = 240;
  const NY = 120;
  const dz = (HOLD.zForward - HOLD.zAft) / NZ;
  const dy = (yHi - yLo) / NY;
  let v = 0;
  for (let i = 0; i < NZ; i++) {
    const z = HOLD.zAft + (i + 0.5) * dz;
    const floor = floorYAt(z);
    for (let j = 0; j < NY; j++) {
      const y = yLo + (j + 0.5) * dy;
      if (y < floor) continue;
      v += 2 * halfBreadthAt(z, y) * dy * dz;
    }
  }
  return v;
}

/**
 * Where the iron tops out — solved, not chosen.
 *
 * **This is the number the hold's accessibility turns on**, so it is computed
 * from the ballast the ship actually carries rather than written down. Change
 * the water allowance and `massModel` re-solves the ballast; this follows, and
 * `ship-interior.test.ts` re-checks that a body still fits in the well.
 */
export const BALLAST_TOP_Y = (() => {
  let lo = floorYAt(0);
  let hi = HOLD_SOLE_Y;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (holdVolume(0, mid) < BALLAST_VOLUME) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
})();

/**
 * Dunnage: the loose battens the casks bear on, so they do not sit on iron and
 * so bilge water can run under the stow to the limbers.
 *
 * **Thin, and not a floor.** It was 0.05 m and drawn as one full-width slab at
 * a single height, which is what Ash was standing on when he asked *"the hold
 * appears to have its own floor which looks wooden? i thought we were either
 * going to be standing on barrels, or the iron at the base."* He is right twice:
 * dunnage is loose battens under cargo, not planking, and a continuous timber
 * sheet across the bottom of a hold reads as a deck that has no business being
 * there.
 */
export const DUNNAGE_THICKNESS = 0.03;

/**
 * The boards thrown down in the working space — **and the only floor down here.**
 *
 * This is the deliberate answer to "what am I standing on". Everywhere else in
 * the hold you are standing on nothing, because the stow is solid to within
 * 139 mm of the sole. In the working well the cargo has been broken out down to
 * the ballast, so what is underfoot is **iron pigs**, and a few loose boards are
 * laid over them because that is what men do where they have to kneel and work
 * — you do not put your knees on pig iron for an afternoon.
 *
 * So the floor is: iron at 0.880, three loose boards over it, and a body at
 * 0.910. Thin on purpose, so the depth reads as *the top of the ballast* rather
 * than as a deck someone built.
 */
const WELL_BOARD_THICKNESS = 0.03;

/**
 * The floor of the hold, as a body meets it — the top of the ballast, plus the
 * boards laid over it in the working space.
 *
 * **Derived from the iron, not chosen.** The ballast figure is solved to close
 * Archimedes, so this height is a fact about how much iron she has to carry.
 */
export const HOLD_FLOOR_Y = BALLAST_TOP_Y + WELL_BOARD_THICKNESS;

/** Where the casks bear: the iron, plus the battens under the stow. */
export const CASK_BED_Y = BALLAST_TOP_Y + DUNNAGE_THICKNESS;

/**
 * Moulded depth of the beams under the platform.
 *
 * **The wardroom's floor was a sheet of paper from below** — Ash: *"looks like
 * a thin sheet of paper. should be realistic thickness and look like wood."*
 * It was the planking alone, 0.05 m, because that is all a sole ever needed to
 * be while nobody could get under one.
 *
 * A platform deck is planking on beams. `massModel.ts` scantles this structure
 * at *half the weather deck's*, which carries seas where this carries people
 * and stores — so it is **derived from `DECK_BEAM_DEPTH`, not chosen**. With the
 * planking that is 0.14 m of timber overhead, which is what a floor looks like
 * from underneath.
 *
 * **Chosen freehand at 0.12 it made the hold uninhabitable**, and silently: the
 * clear height under the beams came to 0.720 m against the 0.75 m a body will
 * enter, while the walker went on reporting 0.89 because it was still measuring
 * to the planking. Drawn timber and collider disagreeing is this project's
 * standing fault, and a scantling picked by eye is how you get there.
 */
export const PLATFORM_BEAM_DEPTH = DECK_BEAM_DEPTH / 2;

/** Underside of the beams — the true ceiling of the hold, and of its stow. */
export const HOLD_DECKHEAD_Y = HOLD_SOLE_Y - DECK_PLANK_THICKNESS - PLATFORM_BEAM_DEPTH;

/** Clear height in the working well — what a body has to get through. */
export const HOLD_WELL_CLEAR = HOLD_SOLE_Y - HOLD_FLOOR_Y;

// --- the working well ---------------------------------------------------------

/**
 * The space kept clear under the hatchway.
 *
 * Not a design flourish. A stow that is rammed solid to the deckhead cannot be
 * worked: you have to be able to get at it to strike stores down and to break
 * them out, and the place you do that is directly under the hatch, because that
 * is where the whip from the yard lands. `SHIP_BELOW_DECKS_PLAN.md` §4.3.1 is
 * emphatic that the two hatchways are aligned so a cask falls down one straight
 * line from the sky to the stow — the well is the bottom of that line.
 *
 * It takes the hatchway's own footprint, widened by the working margin a body
 * needs to kneel beside the opening rather than under it.
 */
const WELL_MARGIN = 0.22;

export const HOLD_WELL = {
  xLo: -HATCHWAY_HALF_BREADTH - WELL_MARGIN,
  xHi: HATCHWAY_HALF_BREADTH + WELL_MARGIN,
  zAft: HATCHWAY_AFT_Z - WELL_MARGIN,
  zForward: HATCHWAY_FORWARD_Z + WELL_MARGIN,
} as const;

/** Whether a point is inside the working well's footprint. */
export function inHoldWell(x: number, z: number): boolean {
  return x > HOLD_WELL.xLo && x < HOLD_WELL.xHi && z > HOLD_WELL.zAft && z < HOLD_WELL.zForward;
}

/**
 * Whether a cask's whole body intrudes into the working well.
 *
 * **A cask is 0.66 m long, and asking whether its *centre* is in the well lets
 * every cask stowed just outside poke a third of a metre into it.** That is
 * what walled the ladder off: a barrel centred 0.19 m abaft the well reached
 * z = 0.52, inside the ladder's own footprint, and the walker stopped dead on
 * it half a metre short of the rungs with `lastContact = stow[76]`.
 *
 * The fault is the same one the ocean cutout's conservative erosion had in
 * `OCEAN_INTERIOR_CUTOUT_HANDOVER.md` §4, from the other side: **a point test
 * standing in for a volume test.** It is invisible in the render — the stow
 * looks correct, because a cask leaning into the working space is exactly what
 * a real stow looks like — and it is only wrong to a body trying to get past.
 */
function caskFoulsWell(x: number, zAft: number, zForward: number): boolean {
  const half = CASK_DIAMETER / 2;
  return (
    x + half > HOLD_WELL.xLo &&
    x - half < HOLD_WELL.xHi &&
    zForward > HOLD_WELL.zAft &&
    zAft < HOLD_WELL.zForward
  );
}

// --- the casks ----------------------------------------------------------------

/**
 * A water cask, **sized by the space it has to live in rather than chosen.**
 *
 * Two nested tiers have to fit between the dunnage the stow bears on and the
 * underside of the platform's beams, and nesting puts the tiers √3/2 of a
 * diameter apart — so the whole stack is `D(1 + √3/2)` and the diameter falls
 * out of the arithmetic:
 *
 *     available = HOLD_DECKHEAD_Y − CASK_BED_Y
 *     D         = available / (1 + √3/2)
 *
 * **It used to be 0.45 m, and that was set against the sole rather than against
 * the beams** — so the top tier stood 0.12 m up inside the timber the moment
 * the beams were drawn. This is the same mistake as measuring headroom to the
 * planking instead of to the beam: `spaceDeckheadY` exists because a room is
 * measured under a beam, and a stow is stowed under one.
 *
 * The number it gives is about 0.38 m — a rundlet rather than a hogshead, some
 * 40 litres and 40 kg. That is *more* plausible for this vessel, not less:
 * eight people have to strike these down a 1.5 m hatch and shift them in a
 * seaway, and a cask one man can handle is the one a small vessel carries.
 */
export const CASK_DIAMETER = (HOLD_DECKHEAD_Y - CASK_BED_Y) / (1 + Math.sqrt(3) / 2);

/** Length, in the proportion a bilged cask has: about 1.45 diameters. */
export const CASK_LENGTH = CASK_DIAMETER * 1.45;

/**
 * Vertical pitch between nested tiers.
 *
 * Casks stowed bilge-and-cantline sit in the hollow between the two below, so
 * the tiers are √3/2 of a diameter apart rather than a whole one. That is the
 * honeycomb `SHIP_BELOW_DECKS_PLAN.md` §4.5 describes, and it is also why a
 * stow is stiff: nothing can roll without lifting.
 */
const TIER_PITCH = CASK_DIAMETER * Math.sqrt(3) / 2;

/** Half-width of the hold's inside at a station and height, less the lining. */
function holdHalfWidthAt(z: number, y: number): number {
  return Math.max(halfBreadthAt(z, y) - CABIN_LINING_THICKNESS, 0);
}

/**
 * The stow, cask by cask — **and the chocks that stop it moving.**
 *
 * HOW A CASK IS ACTUALLY KEPT STILL
 * ---------------------------------
 * Ash asked what stops them rolling, having seen no ropes. There are none, and
 * there would not be: **you do not lash casks, you wedge them.** A rope goes
 * slack the moment a cask works, and a hold full of individually lashed casks
 * is a hold nobody can break out stores from. Four things do the work, and this
 * file now draws all four:
 *
 * 1. **Bilge and cantline.** Each upper cask sits in the *cantline* — the
 *    hollow between two below — rather than on top of one. That is `TIER_PITCH`
 *    at √3/2 of a diameter, and it is most of the answer: a nested cask cannot
 *    roll without first lifting the two it lies between.
 * 2. **Beds of dunnage.** The ground tier bears on battens rather than on iron
 *    or on the ceiling, so it sits in a shallow trough instead of on a curve.
 * 3. **Quoins** — the wedges driven into the cantlines of the *ground* tier,
 *    which has no hollow of its own to sit in and is the only tier that could
 *    roll. This is what the word is for; a quoin is precisely the wedge that
 *    chocks a cask.
 * 4. **Rammed solid.** The stow is built out to the ship's side and up to the
 *    beams with no slack in it, which the geometry here does by construction —
 *    `CASK_DIAMETER` is derived so two tiers exactly fill the space.
 *
 * They are stowed **fore-and-aft**, which is the period norm: heads and quarters
 * toward you as you look down the hatch, so the bilge of each bears on its
 * chocks rather than on its neighbour's head, and so a whip down the hatchway
 * lands along a row rather than across one.
 */
function casks(): FittingSolid[] {
  const out: FittingSolid[] = [];
  const rows = Math.floor((HOLD.zForward - HOLD.zAft) / CASK_LENGTH);
  const zStart = HOLD.zAft + ((HOLD.zForward - HOLD.zAft) - rows * CASK_LENGTH) / 2;

  for (let tier = 0; ; tier++) {
    const centreY = CASK_BED_Y + CASK_DIAMETER / 2 + tier * TIER_PITCH;
    if (centreY + CASK_DIAMETER / 2 > HOLD_DECKHEAD_Y + 1e-9) break;
    // Every other tier is offset half a cask, which is what nesting is —
    // **measured from the centreline, not from the ship's side.**
    //
    // It was `-limit + offset` before, and that is the bug Ash saw: *"your 2nd
    // layer of barrels is stacked directly on top of first."* The offset was a
    // true half-diameter, but `limit` is the hull's half-width *at that tier's
    // own height*, and the hull opens as it rises — by 194 mm between these two
    // tiers, against a half-diameter of 201. The two cancelled and the tiers
    // came out **7 mm** apart, which is stacked.
    //
    // A lattice anchored to a moving edge is not a lattice. Anchored on the
    // centreline the courses break like brickwork whatever the hull does, and
    // the ship's side becomes what *clips* the row rather than what positions
    // it.
    const stagger = tier % 2 === 0 ? 0 : CASK_DIAMETER / 2;

    for (let row = 0; row < rows; row++) {
      const zAft = zStart + row * CASK_LENGTH;
      const zMid = zAft + CASK_LENGTH / 2;
      const limit = holdHalfWidthAt(zMid, centreY);
      const placed: number[] = [];

      // Walk the lattice out from the centreline both ways, and stop where the
      // ship's side does.
      const reach = Math.ceil(limit / CASK_DIAMETER) + 1;
      for (let k = -reach; k <= reach; k++) {
        const x = stagger + CASK_DIAMETER * k;
        if (Math.abs(x) + CASK_DIAMETER / 2 > limit) continue;
        if (caskFoulsWell(x, zAft, zAft + CASK_LENGTH)) continue;
        // The pump's well is boarded clear from the limbers up; the stow is
        // built round it, which is the entire reason a well is boarded.
        if (
          Math.abs(x - PUMP_X) < PUMP_WELL_HALF + CASK_DIAMETER / 2 &&
          Math.abs(zMid - PUMP_Z) < PUMP_WELL_HALF + CASK_LENGTH / 2
        ) {
          continue;
        }
        placed.push(x);
        out.push({
          kind: 'bar',
          a: v3(x, centreY, zAft + 0.02),
          b: v3(x, centreY, zAft + CASK_LENGTH - 0.02),
          // The bilge of a cask is fuller than its heads. Two tubes would draw
          // it properly; one tapered tube drawn head-to-head cannot bulge, so
          // the stave line is carried by the row rather than by the barrel.
          radiusA: CASK_DIAMETER / 2,
          radiusB: CASK_DIAMETER / 2,
          material: 'timber',
          // Solid: a body in the well is standing among these.
          collides: true,
        });
      }

      // Quoins, ground tier only. The tiers above sit in cantlines and need
      // none — which is the whole argument for stowing bilge and cantline.
      if (tier !== 0) continue;

      // **Every cantline that exists, from both hands.**
      //
      // The first version walked the casks and drew one wedge per cask, on the
      // same side each time, which chocked every barrel from one hand only and
      // left the port faces and the outboard edges bare — Ash saw it at once:
      // *"you only chocked starboard and aft barrels."*
      //
      // Worse, it trusted the index order to say which casks are neighbours,
      // and `placed` is not contiguous: the working well and the pump's trunk
      // cut holes in a row, so the cask before a hole and the cask after it are
      // adjacent in the array and half a metre apart in the ship. Collecting
      // the *gaps* instead makes both problems go away — a shared cantline is
      // named identically by the casks either side of it and so is wedged once,
      // and the open edge of a broken row gets the wedge it actually needs,
      // which is the edge a cask would roll off.
      const cantlines = new Set<number>();
      for (const x of placed) {
        cantlines.add(Math.round((x - CASK_DIAMETER / 2) * 1e4));
        cantlines.add(Math.round((x + CASK_DIAMETER / 2) * 1e4));
      }
      for (const key of cantlines) {
        out.push({
          kind: 'box',
          centre: v3(key / 1e4, CASK_BED_Y + CASK_DIAMETER * 0.11, zMid),
          half: v3(
            CASK_DIAMETER * 0.15,
            CASK_DIAMETER * 0.11,
            CASK_LENGTH * 0.40,
          ),
          material: 'timber',
          collides: false,
        });
      }
    }
  }
  return out;
}

/**
 * The bottom of the hold: iron, battens, and the boards in the working space.
 *
 * **The ballast's top is drawn as pigs where it can be seen and as a mass where
 * it cannot**, which is `SHIP_SPEC.md` §10's instruction applied honestly rather
 * than as an excuse — a pig is a 60 kg casting about a forearm long, and a
 * hold's floor is a rubble of them wedged between the frames. Drawn as one
 * smooth box it reads as a moulded tray, and the working well is the one place
 * a face gets close enough to tell.
 */
const PIG_LENGTH = 0.34;
const PIG_WIDTH = 0.16;
const PIG_HEIGHT = 0.10;

function floors(): FittingSolid[] {
  const out: FittingSolid[] = [];
  const NZ = 14;
  const dz = (HOLD.zForward - HOLD.zAft) / NZ;

  for (let i = 0; i < NZ; i++) {
    const zMid = HOLD.zAft + (i + 0.5) * dz;
    const rabbet = floorYAt(zMid);

    // The mass of iron, stopping a pig's depth short of its own top so the
    // castings above sit *in* it rather than on it.
    const massTop = BALLAST_TOP_Y - PIG_HEIGHT;
    if (massTop > rabbet) {
      const half = holdHalfWidthAt(zMid, (rabbet + massTop) / 2);
      out.push({
        kind: 'box',
        centre: v3(0, (rabbet + massTop) / 2, zMid),
        half: v3(half, (massTop - rabbet) / 2, dz / 2),
        material: 'ironwork',
        collides: false,
      });
    }

    // The battens the stow bears on. Laid fore-and-aft in runs with gaps between
    // them, which is what dunnage is — not a sheet.
    const bedHalf = holdHalfWidthAt(zMid, CASK_BED_Y);
    const battens = Math.max(2, Math.round((bedHalf * 2) / 0.55));
    for (let b = 0; b < battens; b++) {
      const x = -bedHalf + ((b + 0.5) * (bedHalf * 2)) / battens;
      out.push({
        kind: 'box',
        centre: v3(x, BALLAST_TOP_Y + DUNNAGE_THICKNESS / 2, zMid),
        half: v3(0.09, DUNNAGE_THICKNESS / 2, dz / 2),
        material: 'timber',
        collides: false,
      });
    }
  }

  // The top course of pigs, only where a body can see them: the working well and
  // a little beyond it. Everywhere else they are under two tiers of cask.
  const pigZ0 = HOLD_WELL.zAft - 0.4;
  const pigZ1 = HOLD_WELL.zForward + 0.4;
  const rows = Math.max(1, Math.round((pigZ1 - pigZ0) / PIG_LENGTH));
  for (let r = 0; r < rows; r++) {
    const z = pigZ0 + (r + 0.5) * ((pigZ1 - pigZ0) / rows);
    const half = holdHalfWidthAt(z, BALLAST_TOP_Y);
    const across = Math.max(1, Math.floor((half * 2) / PIG_WIDTH));
    for (let c = 0; c < across; c++) {
      const x = -half + (c + 0.5) * ((half * 2) / across);
      // Wedged, not stacked: alternate courses sit a little lower and turned,
      // so the surface is a rubble of ends rather than a tiled plane. Derived
      // from the indices so it stays identical between runs.
      const sink = ((r + c) % 3) * 0.012;
      out.push({
        kind: 'box',
        centre: v3(x, BALLAST_TOP_Y - PIG_HEIGHT / 2 - sink, z),
        half: v3(PIG_WIDTH / 2 - 0.008, PIG_HEIGHT / 2, PIG_LENGTH / 2 - 0.01),
        material: 'ironwork',
        collides: false,
      });
    }
  }

  // The boards in the working space — the floor a body actually stands on.
  // Loose, fore-and-aft, with gaps, so the iron shows between them.
  const boards = 4;
  const span = HOLD_WELL.xHi - HOLD_WELL.xLo;
  for (let b = 0; b < boards; b++) {
    const x = HOLD_WELL.xLo + ((b + 0.5) * span) / boards;
    out.push({
      kind: 'box',
      centre: v3(x, HOLD_FLOOR_Y - WELL_BOARD_THICKNESS / 2, (HOLD_WELL.zAft + HOLD_WELL.zForward) / 2),
      half: v3(
        span / (boards * 2) - 0.02,
        WELL_BOARD_THICKNESS / 2,
        (HOLD_WELL.zForward - HOLD_WELL.zAft) / 2,
      ),
      material: 'timber',
      collides: false,
    });
  }

  return out;
}

/**
 * The ladder out of the hold.
 *
 * **This replaced a flight of steps that did not work, and the way it failed is
 * worth keeping.** The steps ran aft-and-up out of the hatchway, and every
 * tread was given the platform sole as its ceiling — so a tread at 1.22 m
 * reported 0.58 m of clear and one at 1.51 m reported 0.29 m, both under the
 * 0.75 m a body will enter. Only the topmost was ever climbable, and it could
 * not be reached from below. Ash found it by being trapped down there.
 *
 * **A tread inside the hatchway has the shaft over it, not the floor it passes
 * through.** That is the same sentence this ship has now written five times in
 * five places, committed here by the person writing it down.
 *
 * It is a vertical ladder now, on Ash's call, and it is the right thing for a
 * second reason: a stair needs run, and run is the one thing a hatchway has
 * none of — every centimetre a flight reaches aft is a centimetre out from
 * under the opening and therefore under solid planking, which is what the old
 * one did. A ladder spiked to the after coaming of the hatchway needs no run at
 * all, and it is what a hold actually has.
 */
const HOLD_LADDER_RUNGS = 3;

/** Half-width of the ladder — narrow enough that you step to it deliberately. */
const HOLD_LADDER_HALF_BREADTH = 0.34;

/** How far forward of the hatchway's after edge the rungs stand. */
const HOLD_LADDER_DEPTH = 0.26;

export const HOLD_LADDER_RISE = (HOLD_SOLE_Y - HOLD_FLOOR_Y) / HOLD_LADDER_RUNGS;

/** Aft and forward limits of the ladder, inside the hatchway's own footprint. */
export const HOLD_LADDER_Z_AFT = HATCHWAY_AFT_Z;
export const HOLD_LADDER_Z_FORWARD = HATCHWAY_AFT_Z + HOLD_LADDER_DEPTH;

function holdLadder(): FittingSolid[] {
  const out: FittingSolid[] = [];
  const zMid = (HOLD_LADDER_Z_AFT + HOLD_LADDER_Z_FORWARD) / 2;
  for (let i = 0; i < HOLD_LADDER_RUNGS; i++) {
    out.push({
      kind: 'box',
      centre: v3(0, HOLD_FLOOR_Y + HOLD_LADDER_RISE * (i + 1) - 0.025, zMid),
      half: v3(HOLD_LADDER_HALF_BREADTH, 0.025, HOLD_LADDER_DEPTH / 2),
      material: 'timber',
      // A rung is a floor, not a wall — the reading `INTERIOR_SOURCES` gives
      // the companion flight and the wardroom's steps.
      collides: false,
    });
  }
  // The two stiles the rungs are let into, carried up to the sole.
  for (const side of [1, -1]) {
    out.push({
      kind: 'box',
      centre: v3(
        side * HOLD_LADDER_HALF_BREADTH,
        (HOLD_FLOOR_Y + HOLD_SOLE_Y) / 2,
        zMid,
      ),
      half: v3(0.03, (HOLD_SOLE_Y - HOLD_FLOOR_Y) / 2, 0.04),
      material: 'timber',
      collides: false,
    });
  }
  return out;
}

/**
 * The rungs, as surfaces a body stands on.
 *
 * **They carry the shaft's ceiling, not the hold's**, and that is the whole
 * repair: a body on a rung is inside the hatchway with the deck two floors up
 * over it, which is what lets it straighten as it climbs and step off at the
 * top. `deckObstacles.ts` supplies the height, because the shaft's ceiling is
 * the wardroom's business and this file does not import rooms.
 */
export const HOLD_LADDER_PANELS = Array.from({ length: HOLD_LADDER_RUNGS }, (_, i) => ({
  x0: -HOLD_LADDER_HALF_BREADTH,
  x1: HOLD_LADDER_HALF_BREADTH,
  z0: HOLD_LADDER_Z_AFT,
  z1: HOLD_LADDER_Z_FORWARD,
  y: HOLD_FLOOR_Y + HOLD_LADDER_RISE * (i + 1),
}));

/** Everything stowed below the floors. */
export const HOLD_STOW: readonly FittingSolid[] = [...floors(), ...casks(), ...holdLadder()];

/** How many casks the stow actually drew — for the tests and the panel. */
export const HOLD_CASK_COUNT = HOLD_STOW.filter((s) => s.kind === 'bar').length;

/**
 * The hold's own floor, as the walker's surface list wants it.
 *
 * **The hatchway's footprint, not the wider well** — and the beams are the
 * reason. A beam is interrupted where a deck is cut and nowhere else, so the
 * hatchway is the one part of the hold with the full 0.89 m under it; a
 * hand's breadth outside the opening the beams come down to 0.72 m, which is
 * under the 0.75 m a body will enter.
 *
 * That is not a restriction invented to keep the player somewhere. It is what
 * a hold is: the cargo is rammed to the beams and the only clear space is the
 * hatchway you struck it down through. The stow being in the way everywhere
 * else is the honest reason, and it is drawn.
 */
export const HOLD_FLOOR_PANEL = {
  x0: -HATCHWAY_HALF_BREADTH,
  x1: HATCHWAY_HALF_BREADTH,
  z0: HATCHWAY_AFT_Z,
  z1: HATCHWAY_FORWARD_Z,
  y: HOLD_FLOOR_Y,
} as const;

/** Every space below decks, including the one under the floors. */
export function lowestStandableY(): number {
  return Math.min(HOLD_FLOOR_Y, ...BELOW_DECKS_SPACES.map((space) => space.soleY));
}
