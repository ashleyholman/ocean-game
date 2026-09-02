import {
  STERN_WINDOWS,
  belowDecksSpace,
  sternLiningHalfWidthAt,
  sternLiningZAt,
} from './deckInterior';
import { COUNTER_RAKE_TAN } from './hullForm';
import { RUDDER_TRUNK_HALF_BREADTH } from './deckInterior';
import { addQuadFacing, jitter, rgbOf, v3 } from './shipwright';
import type { Rgb, SurfaceBuilder, Vec3 } from './shipwright';
import { boxBerthGeometry, sternLockerFrontZ } from './cabinFurniture';
import { frameToShip } from './roomFitting';
import { chartDeskGeometry } from './captainsDesk';

/**
 * The two surfaces in the captain's cabin that cannot be built out of boxes.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Everything else standing in a room below decks is a `FittingSolid`, which is
 * an axis-aligned box or a round bar, and between them they have drawn a pump, a
 * ladder, a desk, a berth and four lockers. Two things in this room defeat that
 * primitive, in two different ways, and both of them are things Ash asked for:
 *
 * **The after wall rakes.** It is the counter itself, lined, leaning aft at 18°
 * — `sternLiningZAt` moves 0.325 m for every metre of height. Panelling *lies
 * on* that wall, so every stile, rail, field and architrave on it is a
 * parallelogram in the y–z plane, and a `FittingSolid` box cannot lean. Ash's
 * report was that the wall reads as bare hull, which it was: one fair lined
 * surface with four holes in it and no joinery on it anywhere.
 *
 * **A turned box does not rescue it, and it matters which rotation is
 * missing.** A `FittingSolid` box has a *yaw*, so the desk and the berth lie
 * along the plan curve of the ship's side. That is rotation about the vertical,
 * and it is the right axis for every piece standing on a sole. What this wall
 * wants is a *pitch*: a lean back about the athwartships axis, which nothing
 * aboard has and which exactly one surface in the ship would ever use. So the
 * claim here is the narrow one — the box has no pitch — and not the broad one
 * this comment first made about the vocabulary having no rotation at all, which
 * was true for about a day.
 *
 * **The floorcloth is a painted surface rather than another furniture
 * material.** Its plain red field, rubbed walking track, stitched hems and dark
 * tack heads all belong to one piece of canvas. Drawn as fittings they would
 * need palette rows whose only difference was which mark on the cloth they
 * represented, which is the column nobody fills. Drawn here they are a small
 * surface carrying its own colours, which is what `SurfaceBuilder` has always
 * been able to do.
 *
 * WHAT THIS FILE MUST NOT DO
 * --------------------------
 * Decide where anything is. The panelling asks the windows where their openings
 * are and the lockers how high they stand; the floorcloth asks the berth and the
 * desk where the walking lane between them is. Every one of those is somebody
 * else's number, and this file has none of its own that another module could
 * disagree with.
 */

// --- the raked wall as a surface ----------------------------------------------

const RAKE = Math.atan(COUNTER_RAKE_TAN);
/** The wall's own inward normal: mostly forward, tipped up by the rake. */
const WALL_NORMAL: Vec3 = v3(0, Math.sin(RAKE), Math.cos(RAKE));

/**
 * A point on the after lining, `proud` metres out into the room from it.
 *
 * **Along the wall's normal, not along z**, and the difference is the whole
 * reason this is a function. Offsetting a raked surface in z alone slides the
 * point *down* the wall as well as off it, so a 14 mm bead would be 14 mm proud
 * at its bottom edge and 9 mm proud at its top, and every moulding on this wall
 * would taper for no reason anyone could name.
 */
function wallPoint(x: number, y: number, proud: number): Vec3 {
  return v3(
    x,
    y + WALL_NORMAL.y * proud,
    sternLiningZAt(y) + WALL_NORMAL.z * proud,
  );
}

/**
 * A rectangle standing proud of the after wall: its face and its four returns.
 *
 * The one shape everything on this wall is made of — a raised field, a chair
 * rail, a cornice, the four sides of an architrave. Five quads: the face, and
 * four short walls from the face's edges back down to the lining, which are what
 * catch the lamp and make the piece read as standing off the wall rather than
 * being painted on it.
 */
function addProudPanel(
  builder: SurfaceBuilder,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  proud: number,
  shade: () => Rgb,
): void {
  if (x1 - x0 <= 1e-4 || y1 - y0 <= 1e-4) return;
  const face = (x: number, y: number): Vec3 => wallPoint(x, y, proud);
  const back = (x: number, y: number): Vec3 => wallPoint(x, y, 0);

  addQuadFacing(
    builder,
    face(x0, y0),
    face(x1, y0),
    face(x1, y1),
    face(x0, y1),
    WALL_NORMAL,
    shade(),
  );
  // The returns. Each faces away from the panel's centre, along the wall.
  addQuadFacing(
    builder,
    back(x0, y0),
    face(x0, y0),
    face(x0, y1),
    back(x0, y1),
    v3(-1, 0, 0),
    shade(),
  );
  addQuadFacing(
    builder,
    back(x1, y0),
    face(x1, y0),
    face(x1, y1),
    back(x1, y1),
    v3(1, 0, 0),
    shade(),
  );
  // Up and down the wall: the normals lean with the rake, the same way the
  // wall's does, so a rail's underside is lit like an underside.
  const down = v3(0, -WALL_NORMAL.z, WALL_NORMAL.y);
  const up = v3(0, WALL_NORMAL.z, -WALL_NORMAL.y);
  addQuadFacing(builder, back(x0, y0), face(x0, y0), face(x1, y0), back(x1, y0), down, shade());
  addQuadFacing(builder, back(x0, y1), face(x0, y1), face(x1, y1), back(x1, y1), up, shade());
}

// --- the panelled after bulkhead ----------------------------------------------

/** How far a raised field stands off the ground of the panelling. */
const FIELD_PROUD = 0.011;
/** How far a rail or an architrave stands off it. Mouldings are the bolder relief. */
const MOULDING_PROUD = 0.016;
/** Width of the stile left between a field and the edge of its bay. */
const FIELD_STILE = 0.055;
/** Depth of the rails top and bottom of the panelled band. */
const RAIL_DEPTH = 0.055;
/** Width of the moulding round a stern light. */
const ARCHITRAVE_WIDTH = 0.058;
/** Depth of the cornice under the deckhead. */
const CORNICE_DEPTH = 0.070;
/** The narrowest bay worth putting a field in; anything less is a stile. */
const MIN_FIELD_BAY = 0.17;
/** Clear timber left between the panelling and the ship's side at each quarter. */
const QUARTER_MARGIN = 0.02;

/**
 * The after bulkhead, panelled.
 *
 * WHERE THE BAND STARTS AND STOPS, AND WHY IT IS NOT THE WHOLE WALL
 * -----------------------------------------------------------------
 * At the bottom, the stern lockers' lids. Below them the wall is behind 0.48 m
 * of locker carcase and cannot be seen from anywhere in the room, and panelling
 * a surface nothing can look at is triangles spent on nothing. It is asked of
 * the lockers rather than typed, so raising them raises the dado with them.
 *
 * At the top, the sills of the lights. The band between the sills and the heads
 * is the piers, which get architraves instead, and above the heads there is a
 * cornice and nothing else — that strip is 0.28 m under a deckhead and is seen
 * at a glance from below, where a panel would be foreshortened to a line.
 *
 * WHERE THE BAYS COME FROM
 * ------------------------
 * The windows. A field under each light and a plain stile under each pier is
 * what makes panelling look built rather than applied: the verticals in the
 * lower half of the wall line up with the verticals in the upper half, and the
 * eye reads one wall instead of two bands that happen to share a surface. So the
 * bay boundaries are the stern lights' own edges, taken from `STERN_WINDOWS`,
 * plus the rudder trunk and the ship's side. Move a light and the panelling
 * moves with it.
 */
export function addSternPanelling(builder: SurfaceBuilder, shade: () => Rgb): void {
  const space = belowDecksSpace('cabin');
  const sill = STERN_WINDOWS[0].y - STERN_WINDOWS[0].halfHeight;
  const head = STERN_WINDOWS[0].y + STERN_WINDOWS[0].halfHeight;

  // The dado band: from the lockers' lids to the sills, less its two rails.
  const dadoFoot = space.soleY + STERN_DADO_FOOT;
  const bandLo = dadoFoot + RAIL_DEPTH;
  const bandHi = sill - RAIL_DEPTH;

  // --- the two rails that bound the panelled band --------------------------
  // Full width at each rail's own height, which is not the same width: the
  // counter narrows as it rises, by 8 mm over this band. Small, and the sort of
  // small that leaves a visible step where a rail meets the lining if it is
  // taken once and used twice.
  for (const [yLo, yHi] of [
    [dadoFoot, bandLo],
    [bandHi, sill],
  ] as const) {
    const halfWidth = Math.min(
      sternLiningHalfWidthAt(yLo),
      sternLiningHalfWidthAt(yHi),
    ) - QUARTER_MARGIN;
    addProudPanel(builder, -halfWidth, halfWidth, yLo, yHi, MOULDING_PROUD, shade);
  }

  // --- a raised field in every bay wide enough to take one -----------------
  const halfWidth =
    Math.min(sternLiningHalfWidthAt(bandLo), sternLiningHalfWidthAt(bandHi)) - QUARTER_MARGIN;
  for (const [x0, x1] of panelBays(halfWidth)) {
    addProudPanel(
      builder,
      x0 + FIELD_STILE,
      x1 - FIELD_STILE,
      bandLo + FIELD_STILE,
      bandHi - FIELD_STILE,
      FIELD_PROUD,
      shade,
    );
  }

  // --- an architrave round each light --------------------------------------
  // Four sides per window, mitred at the corners by running the head and sill
  // pieces the full width and the jambs between them. Lapped rather than butted,
  // which is `pumpWell`'s lesson: four coincident faces are four dark seams.
  for (const window of STERN_WINDOWS) {
    const x0 = window.x - window.halfWidth - ARCHITRAVE_WIDTH;
    const x1 = window.x + window.halfWidth + ARCHITRAVE_WIDTH;
    const y0 = window.y - window.halfHeight - ARCHITRAVE_WIDTH;
    const y1 = window.y + window.halfHeight + ARCHITRAVE_WIDTH;
    addProudPanel(builder, x0, x1, y0, y0 + ARCHITRAVE_WIDTH, MOULDING_PROUD, shade);
    addProudPanel(builder, x0, x1, y1 - ARCHITRAVE_WIDTH, y1, MOULDING_PROUD, shade);
    addProudPanel(
      builder,
      x0,
      x0 + ARCHITRAVE_WIDTH,
      y0 + ARCHITRAVE_WIDTH,
      y1 - ARCHITRAVE_WIDTH,
      MOULDING_PROUD,
      shade,
    );
    addProudPanel(
      builder,
      x1 - ARCHITRAVE_WIDTH,
      x1,
      y0 + ARCHITRAVE_WIDTH,
      y1 - ARCHITRAVE_WIDTH,
      MOULDING_PROUD,
      shade,
    );
  }

  // --- the cornice ---------------------------------------------------------
  // A single band a little above the heads of the lights. It stops short of the
  // deckhead rather than meeting it: the wall's head runs into a wedge of
  // ceiling carried aft over it, and a moulding butted into that join would be
  // fighting a surface built out of a different polyline.
  const corniceLo = head + 0.055;
  const corniceHalf =
    Math.min(sternLiningHalfWidthAt(corniceLo), sternLiningHalfWidthAt(corniceLo + CORNICE_DEPTH)) -
    QUARTER_MARGIN;
  addProudPanel(
    builder,
    -corniceHalf,
    corniceHalf,
    corniceLo,
    corniceLo + CORNICE_DEPTH,
    MOULDING_PROUD,
    shade,
  );
}

/**
 * How far above the sole the panelled dado starts — the lockers' own lids.
 *
 * Asked of the furniture rather than typed, so the two cannot part company. It
 * is the *lid*, not the squab: the cushion is a loose thing lying on the locker
 * and the panelling behind it stops where the joinery does.
 */
const STERN_DADO_FOOT = 0.48;

/**
 * The bays of the after wall, port to starboard, as x ranges.
 *
 * Boundaries are the ship's side, the rudder trunk's casing and the edges of the
 * four lights. Bays narrower than a stile are dropped — they *are* the stiles.
 */
function panelBays(halfWidth: number): Array<[number, number]> {
  const edges = new Set<number>([-halfWidth, halfWidth]);
  edges.add(-RUDDER_TRUNK_HALF_BREADTH);
  edges.add(RUDDER_TRUNK_HALF_BREADTH);
  for (const window of STERN_WINDOWS) {
    edges.add(window.x - window.halfWidth);
    edges.add(window.x + window.halfWidth);
  }
  const sorted = [...edges].filter((x) => Math.abs(x) <= halfWidth + 1e-9).sort((a, b) => a - b);
  const bays: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [x0, x1] = [sorted[i], sorted[i + 1]];
    // The bay behind the rudder trunk is not panelled: the casing stands in
    // front of it floor to deckhead, so nothing there is ever seen.
    if (x0 >= -RUDDER_TRUNK_HALF_BREADTH - 1e-9 && x1 <= RUDDER_TRUNK_HALF_BREADTH + 1e-9) continue;
    if (x1 - x0 < MIN_FIELD_BAY) continue;
    bays.push([x0, x1]);
  }
  return bays;
}

// --- the deadlights ------------------------------------------------------------

/**
 * How far the shutter's face stands off the lining.
 *
 * 0.050 m of oak, and the number is doing legibility work as much as joinery.
 * The architrave round each light is already 0.016 m proud, so a deadlight at
 * 0.050 stands 0.034 m clear of its own moulding: it reads as a board *plugged
 * into* the opening rather than as a panel painted where the glass was. Its
 * four returns are what catch the lantern.
 */
const DEADLIGHT_PROUD = 0.050;

/** How far the board laps onto the reveal all round, so no daylight gets by. */
const DEADLIGHT_LAP = 0.020;

/** The two iron strongbacks across each shutter, and how far they stand off it. */
const STRONGBACK_DEPTH = 0.038;
const STRONGBACK_PROUD = DEADLIGHT_PROUD + 0.014;

/** The brass plate in the middle, which is what a hand takes hold of. */
const DEADLIGHT_GRIP = 0.052;
const GRIP_PROUD = STRONGBACK_PROUD + 0.012;

/** The materials a deadlight is made of, in the order they are drawn. */
export type DeadlightMaterial = 'timber' | 'ironwork' | 'brass';

/**
 * The four deadlights, shipped over the stern lights.
 *
 * WHY THEY ARE HERE AND NOT A FITTING
 * -----------------------------------
 * The third surface in this cabin that cannot be a box, for this file's own
 * first reason: **the wall rakes**. A shutter lies *on* the opening it fills,
 * and a 0.55 m light on an 18° counter is 0.18 m of station from sill to head —
 * so a plumb board across it would stand 90 mm proud at one edge and 90 mm
 * inside the planking at the other. `FittingSolid` has a yaw and no pitch, and
 * `cabinJoinery.ts`'s head says why that is the narrow and correct claim.
 *
 * WHY THEY ARE FITTING MATERIALS AND NOT LINING
 * ---------------------------------------------
 * **Because a shut deadlight has to read as shut**, and the round that built
 * the wardroom left this exact problem written down: oak on oak in an unlit
 * room is nothing. The lining is `0xa08258` and the fitting timber is
 * `0x5b452c` — a little over half its value — so the board is a dark rectangle
 * in a pale wall rather than a slightly different pale rectangle in it. The two
 * strongbacks are `ironwork` at `0x2e2a26`, darker again, and the grip is
 * `brass`, which `INTERIOR_FITTING_PALETTE` describes as the one thing below
 * decks whose whole job is to find what light there is and hand it back.
 *
 * That gives the shut state three values against the wall's one, which is what
 * makes it legible at night with the lantern lit. By day it is legible for a
 * second reason that needs no palette at all: the thing it replaces was a hole
 * with the sea in it.
 *
 * There is no unshipped state to draw. They stow in the stern lockers directly
 * under the lights — which is what those lockers are for and why they are
 * 0.48 m deep — and a thing inside a shut chest is not drawn. The fore
 * scuttle's soffit is the same one-state case and got there first.
 */
export function addSternDeadlights(
  builderFor: (material: DeadlightMaterial) => SurfaceBuilder,
  shadeFor: (material: DeadlightMaterial) => Rgb,
): void {
  for (const window of STERN_WINDOWS) {
    const x0 = window.x - window.halfWidth - DEADLIGHT_LAP;
    const x1 = window.x + window.halfWidth + DEADLIGHT_LAP;
    const y0 = window.y - window.halfHeight - DEADLIGHT_LAP;
    const y1 = window.y + window.halfHeight + DEADLIGHT_LAP;

    addProudPanel(builderFor('timber'), x0, x1, y0, y1, DEADLIGHT_PROUD, () =>
      shadeFor('timber'),
    );

    // Two strongbacks across the grain, a third of the way in from each end.
    // Across and not up and down: the sea comes at a stern light square, and
    // the boards behind these run vertically.
    for (const t of [1 / 3, 2 / 3]) {
      const y = y0 + (y1 - y0) * t;
      addProudPanel(
        builderFor('ironwork'),
        x0,
        x1,
        y - STRONGBACK_DEPTH / 2,
        y + STRONGBACK_DEPTH / 2,
        STRONGBACK_PROUD,
        () => shadeFor('ironwork'),
      );
    }

    // The grip, between the two straps. **A plate, not a ring** — `addTube`
    // sweeps a solid, so there is no ring in this vocabulary, and the
    // chronometer's gimbal spent a round being a cylinder across its own dial
    // before anybody noticed.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    addProudPanel(
      builderFor('brass'),
      cx - DEADLIGHT_GRIP / 2,
      cx + DEADLIGHT_GRIP / 2,
      cy - DEADLIGHT_GRIP / 2,
      cy + DEADLIGHT_GRIP / 2,
      GRIP_PROUD,
      () => shadeFor('brass'),
    );
  }
}

/**
 * The face of a shipped deadlight at one height — what a ray from the room hits
 * before it reaches the glass.
 *
 * Published so the suite can assert the covering rather than re-deriving the
 * rake, and so that a round which moves the lights or the shutters cannot move
 * one without the test following.
 */
export function deadlightFaceZAt(y: number): number {
  return wallPoint(0, y, DEADLIGHT_PROUD).z;
}

/** How far the shipped board laps past its opening on every side. */
export function deadlightLap(): number {
  return DEADLIGHT_LAP;
}

// --- the floorcloth -----------------------------------------------------------

/**
 * The colours of a plain red painted-canvas floorcloth.
 *
 * **Plain red is evidence rather than compromise.** Joseph Banks described the
 * great cabin aboard *Endeavour* as covered by a red painted-canvas floorcloth
 * issued from Deptford and washed with salt water every morning. A chequer was
 * possible in this period, but it made this small room read as a tiled parlour
 * rather than a working survey vessel and Ash does not like it. The field is
 * therefore one restrained iron-oxide red. The other colours below are not
 * a pattern: they are the brown paint exposed where boots have rubbed it, the
 * dark doubled canvas at its hems, and the tack heads holding it down.
 *
 * Owned here rather than in `SHIP_PALETTE` because these are marks inside one
 * painted object, not four materials the rest of the hull can ask for.
 */
const FLOORCLOTH_RED = 0x71352c;
const FLOORCLOTH_WORN = 0x79523a;
const FLOORCLOTH_HEM = 0x4d2924;
const FLOORCLOTH_TACK = 0x292724;
/** Enough to stop a broad painted field being one computer-perfect value. */
const FLOORCLOTH_JITTER = 0.025;

/** How far the canvas lies above the sole. Painted duck, tacked down. */
export const CABIN_FLOORCLOTH_LIFT = 0.004;
/** Clear sole left round the cloth, so it is a cloth and not a floor. */
const CLOTH_MARGIN = 0.11;
/** Doubled-under canvas round the perimeter. */
const CLOTH_HEM = 0.035;
/** A sewn join between the two bolts of duck that make the runner's width. */
const CLOTH_SEAM = 0.012;
/** Small dark heads, visible as punctuation rather than decoration. */
const TACK_SIDE = 0.010;

export interface CabinFloorclothPlan {
  readonly xLo: number;
  readonly xHi: number;
  readonly zLo: number;
  readonly zHi: number;
  readonly y: number;
}

/**
 * The rectangle of clear sole the floorcloth occupies.
 *
 * Published because the cloth's construction tests and the geometry must ask
 * the same furniture for the same lane. It is a fact of the arrangement, not a
 * second set of constants: move the desk, berth, lockers or forward bulkhead
 * and this answer moves with them.
 */
export function cabinFloorclothPlan(): CabinFloorclothPlan {
  const space = belowDecksSpace('cabin');
  const desk = chartDeskGeometry();
  const berth = boxBerthGeometry();
  const midZ = (sternLockerFrontZ() + space.zForward) / 2;
  const berthFront = frameToShip(berth.frame, berth.xInboard, midZ);
  const deskFront = frameToShip(desk.frame, desk.xInboard, midZ);
  return {
    xLo: berthFront.x + CLOTH_MARGIN,
    xHi: deskFront.x - CLOTH_MARGIN,
    zLo: sternLockerFrontZ() + CLOTH_MARGIN,
    zHi: space.zForward - 0.30,
    y: space.soleY + CABIN_FLOORCLOTH_LIFT,
  };
}

function mixColour(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

/**
 * The painted canvas floorcloth down the middle of the cabin.
 *
 * WHY THIS IS IN THE ROUND AT ALL
 * -------------------------------
 * Because the room is brown. Every surface in it — sole, lining, deckhead,
 * beams, desk, berth, lockers, press — is a timber between 0x41 and 0xa0, and
 * Ash has named the flat orange wood as ugly more than once. A painted
 * floorcloth is the cheapest honest answer available: it is what actually went
 * on a cabin sole before carpet, it is a large area, it is on the one surface
 * that appears in every single view of the room, and it costs sixty quads.
 *
 * **It is not the answer to the timber, and it should not be sold as one.** The
 * materials round this ship still owes is still owed. What this does is give the
 * eye one rectangle in the room that is not made of wood.
 *
 * WHERE IT GOES
 * -------------
 * The lane between the desk and the berth, which is the only clear floor in the
 * cabin and is also §4.1's reason for the whole arrangement — the centreline is
 * the route from the door to the stern windows and it is kept clear. So the
 * cloth is asked for the desk's inboard face and the berth's front and lies
 * between them: move either and it re-cuts itself, and it can never end up under
 * a piece of furniture that was moved after it was laid.
 */
export function addCabinFloorcloth(builder: SurfaceBuilder, random: () => number): void {
  const space = belowDecksSpace('cabin');
  const { xLo, xHi, zLo, zHi, y } = cabinFloorclothPlan();
  if (xHi - xLo < CLOTH_HEM * 4 || zHi - zLo < CLOTH_HEM * 4) return;

  const red = rgbOf(FLOORCLOTH_RED);
  const worn = rgbOf(FLOORCLOTH_WORN);
  const hem = rgbOf(FLOORCLOTH_HEM);
  const tack = rgbOf(FLOORCLOTH_TACK);
  const up = v3(0, 1, 0);

  // One smoothly varied painted field. The colour changes by vertex and
  // interpolates across the triangles, so it reads as wear in paint rather than
  // as another grid of coloured patches. The middle of the runner is browner:
  // that is the route from the door to the windows and where boots remove the
  // top coat first.
  const rows = 8;
  const cols = 5;
  const points: Vec3[][] = [];
  const normals: Vec3[][] = [];
  const colours: Rgb[][] = [];
  const xMid = (xLo + xHi) / 2;
  const halfWidth = (xHi - xLo) / 2;
  for (let i = 0; i < rows; i++) {
    const zT = i / (rows - 1);
    const z = zLo + (zHi - zLo) * zT;
    const pointRow: Vec3[] = [];
    const normalRow: Vec3[] = [];
    const colourRow: Rgb[] = [];
    for (let j = 0; j < cols; j++) {
      const x = xLo + ((xHi - xLo) * j) / (cols - 1);
      const track = Math.max(0, 1 - Math.abs(x - xMid) / (halfWidth * 0.62));
      const travelled = 0.72 + Math.sin(zT * Math.PI) * 0.28;
      pointRow.push(v3(x, y, z));
      normalRow.push(up);
      colourRow.push(
        jitter(
          mixColour(red, worn, track * travelled * 0.34),
          random,
          FLOORCLOTH_JITTER,
        ),
      );
    }
    points.push(pointRow);
    normals.push(normalRow);
    colours.push(colourRow);
  }
  builder.addGrid(points, normals, colours, false);

  const markY = y + 0.0005;
  const addMark = (
    ax: number,
    bx: number,
    az: number,
    bz: number,
    colour: Rgb,
    lift = markY,
  ): void => {
    addQuadFacing(
      builder,
      v3(ax, lift, az),
      v3(bx, lift, az),
      v3(bx, lift, bz),
      v3(ax, lift, bz),
      up,
      colour,
    );
  };

  // Doubled hems, a single sewn centre join, and no decorative border. These
  // are just enough construction to stop the lifted rectangle reading as paint
  // applied directly to the planking.
  addMark(xLo, xLo + CLOTH_HEM, zLo, zHi, hem);
  addMark(xHi - CLOTH_HEM, xHi, zLo, zHi, hem);
  addMark(xLo, xHi, zLo, zLo + CLOTH_HEM, hem);
  addMark(xLo, xHi, zHi - CLOTH_HEM, zHi, hem);
  addMark(
    xMid - CLOTH_SEAM / 2,
    xMid + CLOTH_SEAM / 2,
    zLo + CLOTH_HEM,
    zHi - CLOTH_HEM,
    hem,
  );

  // Four shallow returns expose the canvas thickness at grazing angles. A flat
  // coloured plane with no edge is a painted floor however historically sound
  // the comment above it may be.
  const bottom = space.soleY + 0.0008;
  addQuadFacing(
    builder,
    v3(xLo, bottom, zLo),
    v3(xLo, y, zLo),
    v3(xLo, y, zHi),
    v3(xLo, bottom, zHi),
    v3(-1, 0, 0),
    hem,
  );
  addQuadFacing(
    builder,
    v3(xHi, bottom, zHi),
    v3(xHi, y, zHi),
    v3(xHi, y, zLo),
    v3(xHi, bottom, zLo),
    v3(1, 0, 0),
    hem,
  );
  addQuadFacing(
    builder,
    v3(xHi, bottom, zLo),
    v3(xHi, y, zLo),
    v3(xLo, y, zLo),
    v3(xLo, bottom, zLo),
    v3(0, 0, -1),
    hem,
  );
  addQuadFacing(
    builder,
    v3(xLo, bottom, zHi),
    v3(xLo, y, zHi),
    v3(xHi, y, zHi),
    v3(xHi, bottom, zHi),
    v3(0, 0, 1),
    hem,
  );

  // Tack heads at a workmanlike spacing. They are deliberately tiny and dark:
  // close up they explain why the cloth does not slide as the vessel rolls;
  // from the doorway they disappear into the hem instead of becoming a motif.
  const addTack = (x: number, z: number): void =>
    addMark(
      x - TACK_SIDE / 2,
      x + TACK_SIDE / 2,
      z - TACK_SIDE / 2,
      z + TACK_SIDE / 2,
      tack,
      y + 0.001,
    );
  const longCount = Math.max(2, Math.floor((zHi - zLo) / 0.42));
  for (let i = 0; i <= longCount; i++) {
    const z = zLo + CLOTH_HEM / 2 + ((zHi - zLo - CLOTH_HEM) * i) / longCount;
    addTack(xLo + CLOTH_HEM / 2, z);
    addTack(xHi - CLOTH_HEM / 2, z);
  }
  const endCount = Math.max(2, Math.floor((xHi - xLo) / 0.42));
  for (let i = 1; i < endCount; i++) {
    const x = xLo + ((xHi - xLo) * i) / endCount;
    addTack(x, zLo + CLOTH_HEM / 2);
    addTack(x, zHi - CLOTH_HEM / 2);
  }
}
