import {
  BULWARK_PIN_RAILS,
  FIFE_RAILS,
  HORSE_RADIUS,
  HORSE_SAG,
  SHEET_HORSES,
  SPARS,
  rigNode,
} from './rig';
import type { RigPoint, Spar } from './rig';
import { deckStandAt, inCompanionway } from './deckSurface';
import { DECK_FITTINGS, boxAxes, fittingStandAt } from './deckFittings';
import type { FittingSolid } from './deckFittings';
import { interiorSolids, interiorSurfacesAt } from './deckInterior';
import { INTERIOR_FITTINGS, interiorFittingStandAt } from './interiorFittings';
import {
  HOLD_FLOOR_PANEL,
  HOLD_SOLE_Y,
  HOLD_STOW,
  lowestStandableY,
} from './holdStow';
import { isClosureOpen } from './closures';
import { SHIP_CLOSURES } from './shipClosures';


/**
 * Everything solid a walker on deck can run into.
 *
 * WHY THIS IS DERIVED AND NOT TYPED OUT
 * -------------------------------------
 * Every obstacle here is read from the same authored list the loft draws from —
 * `SPARS`, `FIFE_RAILS`, `SHEET_HORSES`, `BULWARK_PIN_RAILS`. A hand-typed
 * collision model is a second description of the ship, and the rig round is the
 * standing argument against those: the sail plan was checked against `SPARS`, so
 * the tops, which are a different list, went unchecked, and both gaffs turned
 * out to be unable to swing. **An intersection suite keyed to one list stops
 * covering the ship the moment someone adds geometry to a different list.**
 *
 * The structural answer is `OBSTACLE_SOURCES` below. Every list in `rig.ts` that
 * produces geometry is named there exactly once, as either collidable or
 * explicitly not, with the reason. `tests/ship-deck.test.ts` asserts that the
 * union of the two covers every list — so adding a category of object to the rig
 * fails a test until someone has decided whether a person can walk into it.
 *
 * SHAPE
 * -----
 * Two primitives, both in ship-local coordinates: a capsule between two points,
 * and an axis-aligned box. They are approximations of drawn timber, and they are
 * meant to be slightly generous — a player who is stopped 30 mm before touching
 * a mast reads as having touched it, and one who clips into it does not.
 */

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type ObstacleShape =
  | { readonly kind: 'capsule'; readonly a: Vec3Like; readonly b: Vec3Like; readonly radius: number }
  | {
      readonly kind: 'box';
      readonly centre: Vec3Like;
      readonly half: Vec3Like;
      /** Rotation about the vertical — `FittingSolid`'s, carried through. */
      readonly yaw?: number;
    };

/** Which authored list an obstacle came from. */
export type ObstacleSource =
  | 'spar'
  | 'fifeRail'
  | 'sheetHorse'
  | 'pinRail'
  | 'fitting'
  | 'interior'
  | 'interiorFitting'
  | 'stow';

export interface DeckObstacle {
  readonly name: string;
  readonly source: ObstacleSource;
  readonly shape: ObstacleShape;
}

/**
 * Every geometry-producing list in `rig.ts`, classified.
 *
 * The reasons matter as much as the classification. "Out of reach" is a claim
 * about a height, and if a later milestone lowers a spar or raises a deck it
 * becomes false — which is why each one names what would have to change.
 */
export const OBSTACLE_SOURCES: Record<string, { collidable: boolean; reason: string }> = {
  SPARS: {
    collidable: true,
    reason:
      'Masts, booms, gaffs and the bowsprit. The booms clear the deck by 1.31–1.45 m, ' +
      'so they are head-height obstacles a walker goes around, not under.',
  },
  FIFE_RAILS: {
    collidable: true,
    reason: 'A pin rail on two stanchions abaft each mast, 0.94 m above the deck — hip height.',
  },
  SHEET_HORSES: {
    collidable: true,
    reason:
      'The iron bar across the deck, 0.34 m up. Shin-high and meant to be stepped over: ' +
      'the walker decides that from the bar height, not from a flag here.',
  },
  BULWARK_PIN_RAILS: {
    collidable: true,
    reason: 'Bolted to the inboard face of the bulwark, standing 0.045 m proud of it.',
  },
  CROSSTREES: {
    collidable: false,
    reason:
      'The tops are 12.05 m and 13.15 m up. Nothing on deck reaches them; M5 stands on ' +
      'one, and that is a climb, not a walk.',
  },
  CHANNEL_SEATS: {
    collidable: false,
    reason: 'Outboard of the bulwark. A walker is bounded by the deck, which stops inboard of it.',
  },
  STANDING_RIGGING: {
    collidable: false,
    reason:
      'Rope. Shrouds land on the channels outboard, and stays run from the mastheads ' +
      'to the bowsprit above head height over the deck.',
  },
  RUNNING_RIGGING: {
    collidable: false,
    reason:
      'Rope, and rope that moves. Sheets and halyards do cross the deck; treating them ' +
      'as walls would be wrong before they are simulated, which is M6.',
  },
  RATLINES: {
    collidable: false,
    reason: 'Rungs on the shrouds, outboard of the deck. They are the M5 climb, not a wall.',
  },
  SAILS: {
    collidable: false,
    reason:
      'Cloth, and cloth that is deformed in its vertex shader — its rest geometry is a ' +
      'poor proxy for where it is. The boom under each fore-and-aft sail is the solid part.',
  },
  SHEET_BLOCKS: {
    collidable: false,
    reason:
      'A block the size of a fist hanging under the horse it rides, inside the horse’s ' +
      'own footprint.',
  },
  SHEET_FAIRLEADS: {
    collidable: false,
    reason: 'Bullseyes on the caprail, outboard of the walkable deck.',
  },
  MASTHEAD_EYES: {
    collidable: false,
    reason:
      'Iron seizings round the fore masthead at 12.60 m and 14.05 m, where the spring ' +
      'stay and the main topmast stay set up. Nine metres above the forecastle.',
  },
  RIG_BLOCKS: {
    collidable: false,
    reason:
      'Blocks that running rigging turns on, all of them aloft: the lowest is the ' +
      'fisherman’s sheet block at 13.0 m, which is 9 m over the deck. They hang off ' +
      'spars that are already collidable, and nothing on deck reaches them.',
  },
};

function point(p: RigPoint): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}

/**
 * A drawn solid, as the thing a body runs into.
 *
 * **One function, and it was three copies.** The deck's fittings, the rooms'
 * fittings and the hold's stow each mapped `FittingSolid` to `ObstacleShape`
 * with the same eight lines, which is exactly the arrangement that lets a
 * primitive gain a field in one place and be silently dropped in the other two —
 * and a box that loses its yaw on the way here does not fail, it just stops a
 * body somewhere the timber is not. Same reason `OBSTACLE_SOURCES` exists.
 */
function obstacleShapeOf(solid: FittingSolid): ObstacleShape {
  return solid.kind === 'box'
    ? { kind: 'box', centre: solid.centre, half: solid.half, yaw: solid.yaw }
    : {
        kind: 'capsule',
        a: solid.a,
        b: solid.b,
        radius: Math.max(solid.radiusA, solid.radiusB),
      };
}

/** Every collidable piece of a fitting, named by its index in the drawn list. */
function fittingObstacles(
  name: string,
  solids: readonly FittingSolid[],
  source: ObstacleSource,
): DeckObstacle[] {
  return solids
    .map((solid, index) => ({ solid, index }))
    .filter(({ solid }) => solid.collides)
    .map(({ solid, index }) => ({
      name: `${name}[${index}]`,
      source,
      shape: obstacleShapeOf(solid),
    }));
}

/**
 * A spar, as one capsule at its mean radius.
 *
 * A mast tapers and a boom tapers, and neither taper is worth modelling for a
 * body that is stopped by the widest part anyway. The mean of heel and head is
 * generous at the head and tight at the heel by a few centimetres of timber.
 */
function sparObstacle(spar: Spar): DeckObstacle {
  return {
    name: spar.name,
    source: 'spar',
    shape: {
      kind: 'capsule',
      a: point(spar.heel),
      b: point(spar.head),
      radius: (spar.heelRadius + spar.headRadius) * 0.5,
    },
  };
}

/**
 * The obstacles, in ship-local coordinates.
 *
 * Read once at module load. The rig is static geometry — nothing here moves
 * until M6 gives the booms a working sheet — so this is a constant, and the
 * walker indexes it rather than rebuilding it per step.
 */
export const DECK_OBSTACLES: readonly DeckObstacle[] = [
  ...SPARS.map(sparObstacle),

  // The fife rail: the board across, and the two stanchions holding it up. The
  // stanchion geometry follows `rigGeometry.ts` — 0.09 m inboard of each end,
  // dropping 1.02 m plus a tenth of the half-span to the deck.
  ...FIFE_RAILS.flatMap((fife): DeckObstacle[] => [
    {
      name: `${fife.name}Board`,
      source: 'fifeRail',
      shape: {
        kind: 'box',
        centre: { x: 0, y: fife.y, z: fife.z },
        half: { x: fife.halfSpan, y: 0.055, z: 0.06 },
      },
    },
    ...[1, -1].map((side): DeckObstacle => {
      const x = side * (fife.halfSpan - 0.09);
      const foot = fife.y - fife.halfSpan * 0.1 - 1.02;
      return {
        name: `${fife.name}Stanchion${side > 0 ? 'Port' : 'Starboard'}`,
        source: 'fifeRail',
        shape: {
          kind: 'capsule',
          a: { x, y: foot, z: fife.z },
          b: { x, y: fife.y, z: fife.z },
          radius: 0.05,
        },
      };
    }),
  ]),

  // The horse: the arched bar, and the two feet it stands on. `HORSE_SAG` is
  // imported rather than assumed — the bar dips at midspan, which is exactly the
  // sort of thing a collision model invents wrongly if it draws its own.
  ...SHEET_HORSES.flatMap((horse): DeckObstacle[] => [
    {
      name: `${horse.name}Bar`,
      source: 'sheetHorse',
      shape: {
        kind: 'capsule',
        a: { x: -horse.halfSpan, y: horse.y - HORSE_SAG * 0.5, z: horse.z },
        b: { x: horse.halfSpan, y: horse.y - HORSE_SAG * 0.5, z: horse.z },
        radius: HORSE_RADIUS,
      },
    },
    ...[1, -1].map((side): DeckObstacle => ({
      name: `${horse.name}Foot${side > 0 ? 'Port' : 'Starboard'}`,
      source: 'sheetHorse',
      shape: {
        kind: 'capsule',
        a: { x: side * horse.halfSpan, y: horse.y - 0.34, z: horse.z },
        b: { x: side * horse.halfSpan, y: horse.y, z: horse.z },
        radius: 0.028,
      },
    })),
  ]),

  // Pin rails, swept along the wall exactly as they are drawn: one box per seat,
  // each asking the hull where it is at its own station.
  ...BULWARK_PIN_RAILS.flatMap((rail) =>
    rail.seats.map((seat, seatIndex): DeckObstacle => ({
      name: `${rail.name}[${seatIndex}]`,
      source: 'pinRail',
      shape: {
        kind: 'box',
        centre: point(seat),
        half: {
          x: 0.045,
          y: 0.055,
          z: ((rail.halfLength * 2) / rail.seats.length) * 0.62,
        },
      },
    })),
  ),

  // The deck's furniture, piece by drawn piece.
  //
  // Not one collider per fitting: a hatch's coaming is a kerb and its grating is
  // a floor, and a windlass's bitt heads are solid where the whelps on its barrel
  // are already inside the barrel. `deckFittings.ts` says which pieces are solid
  // and its `FITTING_KINDS` says why for each kind, and `ship-deck.test.ts` reads
  // that classification back against the geometry rather than trusting it — the
  // same arrangement `OBSTACLE_SOURCES` above holds for the rig.
  ...DECK_FITTINGS.flatMap((fitting) =>
    fittingObstacles(fitting.name, fitting.solids, 'fitting'),
  ),

  // Everything solid below decks: the companionway's coaming, which is the one
  // piece standing where a body on the weather deck can walk into it; the four
  // bulkheads; and the rudder trunk in the after end of the cabin. The soles,
  // the treads and the beams are not here — `INTERIOR_SOURCES` in
  // `deckInterior.ts` classifies every kind and says why for each.
  ...interiorSolids().map(
    (solid): DeckObstacle => ({
      name: solid.name,
      source: 'interior',
      shape: { kind: 'box', centre: solid.centre, half: solid.half },
    }),
  ),

  // What stands *in* the rooms rather than bounding them: the pump's tube and
  // the well round its foot. Same per-piece rule the deck's fittings use, and
  // `INTERIOR_FITTING_KINDS` in `interiorFittings.ts` says why for each kind.
  ...INTERIOR_FITTINGS.flatMap((fitting) =>
    fittingObstacles(fitting.name, fitting.solids, 'interiorFitting'),
  ),

  // The stow. **Cargo is a collider here and that is not decoration**: the
  // working well is a hole broken out of the casks, so what stops a body
  // wandering out of it into the rest of the hold is the stow itself. There is
  // no bulkhead down there to do the job — the hold's walls are made of barrels.
  // Indexed over the collidable pieces only — `stow[0]` is the first cask that
  // stops a body, not the first solid in the list — which is what it has always
  // been and is why the stow does not go through `fittingObstacles`.
  ...HOLD_STOW.filter((solid) => solid.collides).map(
    (solid, index): DeckObstacle => ({
      name: `stow[${index}]`,
      source: 'stow',
      shape: obstacleShapeOf(solid),
    }),
  ),
];

/**
 * The bowsprit's heel, as a sanity landmark for tests and panels.
 *
 * It is already in `DECK_OBSTACLES` through `SPARS`; this only names where the
 * forward end of the walkable deck runs into it.
 */
export function bowspritHeel(): Vec3Like {
  return point(rigNode('bowspritHeel'));
}

// --- the walker's index ------------------------------------------------------

/**
 * One horizontal slice of an obstacle: a 2D capsule with a vertical extent.
 *
 * Collision on a deck is very nearly a two-dimensional problem — a body is a
 * vertical cylinder, and everything it can hit is a solid that occupies some
 * band of heights. Slicing each obstacle into short columns turns "does this
 * capsule hit that raked mast" into "is this circle inside that circle, and do
 * the heights overlap", which is cheap, has no failure modes worth debugging,
 * and is easy to draw as an overlay.
 */
export interface ObstacleColumn {
  readonly name: string;
  readonly source: ObstacleSource;
  /** Horizontal segment, in ship-local x/z. */
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly radius: number;
  readonly yLo: number;
  readonly yHi: number;
}

/**
 * Heights the index covers.
 *
 * The deck runs 3.82–4.68 above the baseline and a standing body is under 2 m,
 * so nothing above 7.2 can be walked into. This is a speed clip on the *index*,
 * not a claim about the obstacles: `DECK_OBSTACLES` keeps every spar at its real
 * height, and the gaffs and topmasts drop out here because of where they are,
 * not because they were left out.
 *
 * **The low end is derived, not chosen, and it has moved twice.** It was a
 * literal 3.0, which was true of a ship whose lowest floor was the deck. M4 made
 * it `CABIN_SOLE_Y − 0.2`, which was true of a ship whose lowest floor was the
 * cabin sole at 2.45. The platform deck is at 1.80, so it is now the lowest sole
 * *aboard*, asked of the list of rooms rather than of any one of them.
 *
 * Both moves are the same fault caught before it bit: a literal here goes on
 * silently discarding anything below-decks whose top is under it, and it
 * discards them from the *index* while `DECK_OBSTACLES` still lists them — so
 * the wardroom's bulkheads would be drawn, would be classified collidable, would
 * appear in every enumerating test, and a body would walk straight through them
 * with nothing looking wrong anywhere.
 *
 * **It has now moved a third time, and this is the run that proves the shape of
 * the fault.** The hold's working well floors at 0.93 and its casks reach down
 * to 0.71 — all of it under the platform's 1.80, and every bit of it would have
 * been clipped out of the index by a bound derived from the list of *rooms*.
 * The stow would have been drawn, classified collidable, covered by the
 * enumerating tests, and walked straight through, in a place where the cargo is
 * the only thing standing between a body and the rest of the hold. It is asked
 * of the lowest surface a body can be *on* now, which is what it always meant.
 */
const INDEX_Y_LO = lowestStandableY() - 0.2;
const INDEX_Y_HI = 7.4;

/** Longest column a capsule is sliced into, metres. */
const COLUMN_HEIGHT = 0.25;

/**
 * The most invisible reach a box may have off its own ends, metres.
 *
 * A box is carried into this index as capsules along its longer horizontal
 * axis, and a capsule's rounded cap reaches past the timber by its own radius —
 * see `buildColumns`. 0.06 is chosen against the *body*, not against the
 * furniture: a walker is 0.52 m across, so a sixth of a body-radius of phantom
 * is under the width of the contact the player already cannot see, and it keeps
 * the strip count off a wide piece in single figures. The mess table goes from
 * one column with 0.42 m of ghost to seven with 0.06 m.
 */
const MAX_BOX_CAP_REACH = 0.06;

function pushColumn(out: ObstacleColumn[], column: ObstacleColumn): void {
  if (column.yHi < INDEX_Y_LO || column.yLo > INDEX_Y_HI) return;
  out.push(column);
}

function sliceCapsule(
  out: ObstacleColumn[],
  obstacle: DeckObstacle,
  a: Vec3Like,
  b: Vec3Like,
  radius: number,
): void {
  const rise = Math.abs(b.y - a.y);
  const steps = Math.max(1, Math.ceil(rise / COLUMN_HEIGHT));
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const y0 = a.y + (b.y - a.y) * t0;
    const y1 = a.y + (b.y - a.y) * t1;
    pushColumn(out, {
      name: obstacle.name,
      source: obstacle.source,
      x0: a.x + (b.x - a.x) * t0,
      z0: a.z + (b.z - a.z) * t0,
      x1: a.x + (b.x - a.x) * t1,
      z1: a.z + (b.z - a.z) * t1,
      radius,
      yLo: Math.min(y0, y1) - radius,
      yHi: Math.max(y0, y1) + radius,
    });
  }
}

function buildColumns(): ObstacleColumn[] {
  const out: ObstacleColumn[] = [];
  for (const obstacle of DECK_OBSTACLES) {
    if (obstacle.shape.kind === 'capsule') {
      sliceCapsule(out, obstacle, obstacle.shape.a, obstacle.shape.b, obstacle.shape.radius);
    } else {
      // A box becomes capsules laid along its longer horizontal axis.
      //
      // Each segment runs the box's **full** half-length rather than stopping a
      // radius short of it, which is the textbook way to inscribe a capsule in a
      // box and is the wrong way round here. Inscribed, the capsule's rounded end
      // cuts each corner: a hatch coaming 1.68 m by 0.09 m lost 19 mm at all four
      // of them, and a corner is exactly where a body walking a diagonal meets a
      // fitting. Run to the full half-length the corner sits on the cap's own
      // radius and is covered, at the cost of a radius of extra reach off each
      // end — which is the direction this model is documented to err in: a player
      // stopped 30 mm before touching a coaming reads as having touched it, and
      // one who clips through its corner does not.
      //
      // **That cost is a radius, and a radius stopped being small the moment
      // furniture arrived.** Every box on the weather deck is long and thin — a
      // coaming, a rail, a bitt — so its cap radius is 45 mm and the paragraph
      // above is true. The wardroom's mess table is 0.84 m by 1.34 m: as one
      // capsule its cap radius is 0.42 m, and 0.42 m of invisible table hangs
      // off each end. That is not a tolerance, it is a second table. It was
      // found by walking rather than by reading — a body climbing out of the
      // hold stopped 0.53 m short of the hatchway it was standing directly
      // under, held by a table more than a metre away — and every chunky piece
      // of furniture built after it would have found it again.
      //
      // So a box is sliced across its width as well, into strips no wider than
      // `MAX_BOX_CAP_REACH`, and the phantom off each end is that instead. The
      // strips touch exactly rather than overlapping — a point midway between
      // two centres is one strip-half from each, and a corner of the rectangle
      // is one strip-half from the nearest cap — so the union is still the whole
      // rectangle plus a margin, which is the same guarantee the single capsule
      // made and the same direction of error. Anything already thinner than a
      // strip gets one and is unchanged, which is every box aboard before this
      // round.
      //
      // **A yawed box costs this index nothing, and that is not luck.** A column
      // is already a segment with a radius rather than a rectangle — chosen
      // because it makes a raked mast the same problem as an upright one — so a
      // box that has been turned about the vertical only turns its segments. The
      // whole reason furniture could be given an angle in one round is that the
      // thing a body is actually stopped by was never axis-aligned to begin with.
      const { centre, half } = obstacle.shape;
      const { u, w } = boxAxes(obstacle.shape.yaw);
      const alongX = half.x >= half.z;
      const reach = alongX ? half.x : half.z;
      const across = alongX ? half.z : half.x;
      const along = alongX ? u : w;
      const sideways = alongX ? w : u;
      const strips = Math.max(1, Math.ceil(across / MAX_BOX_CAP_REACH - 1e-9));
      const stripHalf = across / strips;
      for (let i = 0; i < strips; i++) {
        const offset = -across + stripHalf * (2 * i + 1);
        const cx = centre.x + sideways.x * offset;
        const cz = centre.z + sideways.z * offset;
        pushColumn(out, {
          name: obstacle.name,
          source: obstacle.source,
          x0: cx - along.x * reach,
          z0: cz - along.z * reach,
          x1: cx + along.x * reach,
          z1: cz + along.z * reach,
          radius: stripHalf,
          yLo: centre.y - half.y,
          yHi: centre.y + half.y,
        });
      }
    }
  }
  return out;
}

/** The index, built once. */
export const OBSTACLE_COLUMNS: readonly ObstacleColumn[] = buildColumns();

/** Where a body stands, and what is directly over its head. */
export interface SchoonerStand {
  /** Height of the walking surface under the query. */
  readonly y: number;
  /** Underside of whatever is overhead. `Infinity` under open sky. */
  readonly ceilingY: number;
  /**
   * Is this a rung in a closure's shaft rather than a floor?
   *
   * Set only by `SHIP_CLOSURES`' footholds. `DeckWalker` climbs these at a
   * deliberate rate in both directions instead of striding up them and falling
   * down them — see `WalkerTuning.ladderSpeed`.
   */
  readonly climbable?: boolean;
  /** Keep horizontal input on this compact ladder until its support is reached. */
  readonly climbLocked?: boolean;
}

/**
 * The floor under a placed position: the deck, a fitting standing on it, or a
 * surface below decks — whichever one the body asking can actually be on.
 *
 * The union is taken here rather than inside `deckSurface.ts` and the reason is
 * dependency, not taste. A fitting has to ask the deck how high it is before it
 * can say how high its own lid is, so `deckFittings.ts` imports `deckSurface.ts`
 * — and a deck surface that also knew about fittings would close that ring.
 * `deckInterior.ts` has the same shape, for the same reason. This module already
 * imports all three, and composing what the walker stands on is exactly its job.
 *
 * WHY THIS TAKES A HEIGHT NOW, AND WHY THE OLD RULE COULD NOT
 * ----------------------------------------------------------
 * Through M3 the rule was "the highest surface that admits the query wins", and
 * it was sound because every surface M3 added stood *on* the deck: a hatch lid,
 * a grating, a tread. `SHIP_DECK_HANDOVER.md` section 12 named the case that
 * breaks it before it was built — **a cabin sole is lower than the deck above
 * it** — and "highest wins" answers that by standing a body in the cabin on the
 * quarterdeck, through two metres of timber.
 *
 * So the query carries `reachY`: the highest surface the asking body could get
 * its feet onto, which is its feet plus whatever it can step up. The floor is
 * the highest candidate at or below that. The body's own step-up is the
 * walker's tuning and stays there — this file is told the reach, not the rule
 * that produced it, so a second kind of body with a longer stride needs nothing
 * here.
 *
 * The fallback, when *no* candidate is within reach, is the lowest surface
 * rather than none. A body that is somehow under every floor is falling, and it
 * should be falling toward something. Answering `null` would mean "not ship at
 * all" and would let it through the bottom.
 *
 * `null` still means exactly that: not deck at all. Nothing below decks extends
 * outboard of the deck that roofs it — `cabinHalfWidthAt` clips the sole to
 * `deckStandAt`'s own half-width — so a query the weather deck refuses is off
 * the ship, and no interior surface can rescue it.
 */

export function schoonerStandAt(x: number, z: number, reachY: number): SchoonerStand | null {
  const deck = deckStandAt(x, z);
  if (!deck) return null;

  const candidates: SchoonerStand[] = [];

  // The weather deck — except where it has a hole in it. The opening is a fact
  // about what is *cut out of* the deck rather than about the deck's own
  // surface, so `deckSurface.ts` does not know about it: `deckStandAt` still
  // answers the lofted height there, which is what the rig and the fittings mean
  // when they ask how high the deck is near a hatch. Only a body falling through
  // it cares, and a body asks here.
  // **Every closure aboard, by one rule.** `SHIP_CLOSURES` says where each
  // barrier lies and what it does; this applies the walker's half of the
  // contract to all of them: shut, a closure is floor from above and ceiling
  // from below; open, it is a hole with footholds through it. A hatch added to
  // that table cannot be one you fall through when it is shut or climb through
  // when it is not, because neither behaviour is written per hatch any more.
  let deckWithdrawn = inCompanionway(x, z);
  let inOpenShaft = false;
  let climbLocked = false;
  const withdrawnSoles: number[] = [];
  const closureSurfaces: SchoonerStand[] = [];

  for (const closure of SHIP_CLOSURES) {
    const barrier = closure.barrier;
    if (!barrier || !barrier.covers(x, z)) continue;
    if (isClosureOpen(closure.name)) {
      // **The whole shaft is climbable, not only the rungs.** Marking the rungs
      // alone left the last part of a descent as a free fall: a body that walks
      // into an open scuttle drops onto the top rung, shuffles forward past the
      // ladder's 0.32 m climb envelope, and from there the floor under it is the
      // sole two metres down — an ordinary surface, fallen to at 9.81 m/s².
      // What paces a climb is being *inside the hole*, so that is what carries
      // the flag.
      inOpenShaft = true;
      climbLocked ||= barrier.climbLocked === true;
      // Open: its own floor is withdrawn, and the footholds appear.
      if (barrier.level.kind === 'deck') deckWithdrawn = true;
      else withdrawnSoles.push(barrier.level.y);
      for (const hold of barrier.footholds()) {
        if (x < hold.x0 || x > hold.x1 || z < hold.z0 || z > hold.z1) continue;
        closureSurfaces.push({ y: hold.y, ceilingY: barrier.footholdCeiling(x, z) });
      }
    } else {
      // Shut: whatever it adds above its own floor is a surface. A flush
      // closure adds nothing and its floor already answers.
      const surface = barrier.shutSurface();
      if (surface !== null) {
        closureSurfaces.push({ y: surface.y, ceilingY: Infinity });
      }
    }
  }

  // The weather deck — except where it has a hole in it. The opening is a fact
  // about what is *cut out of* the deck rather than about the deck's own
  // surface, so `deckSurface.ts` does not know about it: `deckStandAt` still
  // answers the lofted height there, which is what the rig and the fittings
  // mean when they ask how high the deck is near a hatch. Only a body falling
  // through it cares, and a body asks here.
  if (!deckWithdrawn) candidates.push({ y: deck.y, ceilingY: Infinity });
  candidates.push(...closureSurfaces);

  const panel = fittingStandAt(x, z);
  if (panel !== null) candidates.push({ y: panel, ceilingY: Infinity });

  const belowDecksPanel = interiorFittingStandAt(x, z);
  for (const surface of interiorSurfacesAt(x, z)) {
    // A sole a closure has withdrawn is not there — the same shape
    // `inCompanionway` gives the weather deck, and now the same shape for
    // every row of `SHIP_CLOSURES` rather than a special case per hatch.
    if (withdrawnSoles.some((y) => Math.abs(surface.y - y) < 1e-6)) continue;
    candidates.push({ y: surface.y, ceilingY: surface.ceilingY });
    // A fitting standing in a room keeps the *room's* ceiling. The well head is
    // 0.25 m of step in a room with 1.9 m of headroom, and letting the fitting
    // answer with a headroom of its own is how a body ends up crouching on a
    // kerb in a room it can stand up in.
    if (belowDecksPanel !== null && belowDecksPanel > surface.y) {
      candidates.push({ y: belowDecksPanel, ceilingY: surface.ceilingY });
    }
  }

  // The hold's working well — the one floor in the ship that is not a sole.
  //
  // Its ceiling is the platform *sole*, not a deckhead, because that is what is
  // literally over your head down there: the underside of the wardroom's floor.
  // The 0.87 m between them is what makes the walker crawl, and the walker gets
  // there through this one number rather than through a special case.
  if (
    x > HOLD_FLOOR_PANEL.x0 &&
    x < HOLD_FLOOR_PANEL.x1 &&
    z > HOLD_FLOOR_PANEL.z0 &&
    z < HOLD_FLOOR_PANEL.z1
  ) {
    // **The hold's ceiling is the platform sole, everywhere, including under an
    // open hatch.** It used to report the deck two floors up when a body stood
    // in the opening, on the reasoning that your head would really be up
    // through the hole. It is true and it plays terribly: the eye goes to 2.55,
    // which is *above* the sole at 1.80, so you drop into the hold and find
    // yourself looking at the wardroom, unable to see the room you are standing
    // in. Ash: *"at first i got stuck standing in the hold, couldnt see in it."*
    //
    // So a body in the hold is ducked, always, and the way to put your head up
    // is to get on the ladder — which is a thing you do deliberately rather
    // than something that happens because of where you landed.
    candidates.push({ y: HOLD_FLOOR_PANEL.y, ceilingY: HOLD_SOLE_Y });
  }

  // The ladders out of both shafts are footholds on their closures now, applied
  // by the loop above. They used to be two hand-written blocks here — the
  // hold's gated on `boardsOpen`, the scuttle's on `scuttleOpen` — each
  // repeating the same sentence this ship has had to write in five places: **a
  // rung inside a hatchway has the *hatchway* over it, not the floor it passes
  // through**, and a rung published through a shut lid is a body climbing out
  // through 50 mm of oak. Both sentences are now said once, in `SHIP_CLOSURES`.

  if (candidates.length === 0) return null;

  let best: SchoonerStand | null = null;
  let lowest = candidates[0];
  for (const candidate of candidates) {
    if (candidate.y < lowest.y) lowest = candidate;
    if (candidate.y > reachY) continue;
    if (best === null || candidate.y > best.y) best = candidate;
  }
  const chosen = best ?? lowest;
  return inOpenShaft ? { ...chosen, climbable: true, climbLocked } : chosen;
}

/**
 * The schooner as something to walk on.
 *
 * The two questions `DeckWalker` asks — what is the floor here, and what is
 * solid — answered by the files that already own those facts. Nothing new is
 * described.
 */
export const SCHOONER_DECK_ENVIRONMENT = {
  standAt: schoonerStandAt,
  columns: OBSTACLE_COLUMNS,
};

/** Squared distance from a point to a segment, in the horizontal plane. */
export function columnDistance(
  column: ObstacleColumn,
  x: number,
  z: number,
): { distance: number; nearestX: number; nearestZ: number } {
  const dx = column.x1 - column.x0;
  const dz = column.z1 - column.z0;
  const lengthSq = dx * dx + dz * dz;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((x - column.x0) * dx + (z - column.z0) * dz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const nearestX = column.x0 + dx * t;
  const nearestZ = column.z0 + dz * t;
  return {
    distance: Math.hypot(x - nearestX, z - nearestZ),
    nearestX,
    nearestZ,
  };
}
