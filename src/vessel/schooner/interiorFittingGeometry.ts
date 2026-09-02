import * as THREE from 'three';
import type { FittingMaterial, FittingSolid } from './deckFittings';
import {
  INTERIOR_FITTINGS,
  foreScuttleSoffit,
  hatchwayBoards,
} from './interiorFittings';
import { addSternDeadlights } from './cabinJoinery';
import { deskChair } from './captainsDesk';
import { boxBerthCurtain } from './cabinFurniture';
import { HOLD_STOW } from './holdStow';
import {
  SurfaceBuilder,
  addBox,
  addTube,
  jitter,
  makeRandom,
  normalise,
  rgbOf,
  v3,
} from './shipwright';
import type { Rgb, Vec3 } from './shipwright';

/**
 * The triangles for everything standing below decks — the pump, its well, and
 * the hold's stow.
 *
 * Same division the deck already has: `interiorFittings.ts` and `holdStow.ts`
 * decide where things are and what they are made of, this turns it into
 * geometry, and nothing here invents a position.
 *
 * WHY NOT JUST DRAW THESE INTO `deckFittingGeometry.ts`
 * ----------------------------------------------------
 * It would be one fewer draw call and it would break the lighting. `ShipRegion`
 * already carries the reason in its own comment: *"which meshes are interior is
 * a question the lighting has to ask, and a name is a better answer to it than
 * a bounding box"* — and `Schooner.ts` acts on exactly that, giving every
 * interior region `INTERIOR_SKY_VISIBILITY` where the rest of the ship gets 1.
 * A pump tube standing in the wardroom merged into the deck's fitting mesh
 * would be lit as though it were on the quarterdeck, and there would be no
 * name to separate it by. So: same two materials, different meshes, and the
 * `interior:` prefix is what the lighting round can find them by.
 *
 * The hold's stow shares them rather than getting a third set. A cask is oak
 * and ballast is iron; what makes the hold dark is that it is *in the hold*,
 * which is the sky-visibility term's job and not the palette's.
 */

/**
 * Below decks draws every material there is.
 *
 * Two of them are the deck's — a pump tube is oak and its bands are wrought
 * iron. Three arrived with the captain's desk and two more with his berth, and
 * they exist nowhere else aboard: see `FittingMaterial` for why the deck does
 * not get them.
 */
export type InteriorFittingRegion = FittingMaterial;

export const INTERIOR_FITTING_REGIONS: readonly InteriorFittingRegion[] = [
  'timber',
  'ironwork',
  'brass',
  'leather',
  'paper',
  'linen',
  'wool',
];

/** Deterministic, for the reason `docs/project/ASSET_CREDITS.md` gives. */
const INTERIOR_FITTING_SEED = 0x40105702;

export const INTERIOR_FITTING_PALETTE: Record<InteriorFittingRegion, number> = {
  /**
   * Unscrubbed, unweathered oak. Darker than the deck's fittings (0x6a5232),
   * which are oiled and rained on: nothing below decks is either, and the
   * timber down here is what a cask and a pump tube are — bare wood that has
   * been wet and dried a hundred times.
   */
  timber: 0x5b452c,
  /**
   * Pig iron and the bands. Rustier than the rig's ironwork, because it lives
   * in the bilge and no one paints ballast.
   */
  ironwork: 0x2e2a26,
  /**
   * Cast and polished brass: drawer rings, the barometer's case, the desk's
   * candle sconce.
   *
   * **Bright for a colour in a dark room, and that is the point of it.** Brass
   * is the only thing below decks that is *supposed* to be a highlight — its
   * whole job is to find what light there is and hand it back, which is why a
   * ship's joinery has it on every handle. At 0.35 roughness and 0.85 metalness
   * it takes the stern windows' bath and the lantern's cone and nothing else,
   * so it goes dark with the room rather than glowing in it.
   */
  brass: 0x9c7c33,
  /**
   * Dark leather, the writing skiver let into the desk top.
   *
   * **This was green baize and Ash asked what it was, which is the answer.**
   * Baize is a writing-desk and card-table cloth; a chart table at sea is
   * timber or leather, because you spread wet charts on it and work across it
   * with dividers and parallel rules, and wool snags and stains. The green was
   * picked to give the room a colour that was not brown — a composition reason
   * rather than a shipwright's one — and at 81 % of the desk top it did not
   * read as a cloth let into a desk at all. It read as a card table.
   *
   * Dark, and darker than the oak around it (0x5b452c) on purpose: the desk's
   * one job as a background is to let a book, a chart and a brass ring sit on
   * it and be seen. A skiver the colour of the timber it is let into is the
   * invisible-book fault waiting to happen again.
   */
  leather: 0x412319,
  /**
   * Chart paper and the leaves of a book.
   *
   * The palest thing in the ship by a wide margin, and it has to be: paper in a
   * dark cabin is what the eye goes to, and every reason to draw a rolled chart
   * at all is that it is a light shape against timber. Not white — rag paper
   * that has been at sea is warm and it is grubby.
   */
  paper: 0xc9b99a,
  /**
   * Mattress ticking, the pillow, the towel on the washstand, the berth curtain.
   *
   * **Deliberately just below the paper, and that ordering is the decision.**
   * Paper is the palest thing in the ship because a rolled chart has to read as
   * a light shape against timber in a dark room. A bed is a much larger area of
   * the same kind of pale, and at the paper's own value a 1.9 m mattress would
   * be the brightest object below decks by area — a slab of light lying along
   * the starboard side, which is the strip-light fault the chart rack already
   * taught this cabin once. Unbleached linen that has been slept in is warm,
   * grey and grubby anyway, so the honest colour and the composed one agree.
   */
  linen: 0xa2947c,
  /**
   * The blanket on the berth and the squabs on the stern lockers.
   *
   * **The one saturated colour below decks, and it is here on purpose.** The
   * cabin is oak, pine, dark leather and iron — every surface in it is a brown
   * between 0x41 and 0xa0, which is the flatness Ash has named more than once.
   * A blanket is the one object in the room that has no reason to be timber
   * coloured: cheap wool went into the dye pot, and madder red is what it came
   * out of. It is dark enough not to fight the lantern for attention and it is
   * the only thing in here that is not a shade of the wall.
   */
  wool: 0x6e2f26,
};

const JITTER: Record<InteriorFittingRegion, number> = {
  // Heavy on the timber, because ninety-six identical casks is the flattest
  // thing in the ship and cask-to-cask variation is most of what a stow looks
  // like. This is the grating argument from `deckFittingGeometry.ts`, worse.
  timber: 0.13,
  ironwork: 0.06,
  // Light on the three cabin materials, and for the opposite reason to the
  // stow's. Jitter is there to break up repetition, and there is none here:
  // three drawer rings, one cloth, a handful of rolled charts. What jitter buys
  // on a polished fitting is the look of tarnish, so brass gets a little and
  // the skiver gets almost none — a leather top with visible per-face variation
  // reads as stained, which is a story about the desk nobody asked for.
  brass: 0.07,
  leather: 0.03,
  paper: 0.09,
  // Heavier than any of the hard materials, and it is doing a different job.
  // A box has faces; a folded blanket and a stuffed mattress do not, and the
  // only thing separating one slab of a soft object from the next is that no
  // two parts of cloth catch the light alike. This is the closest a flat-shaded
  // box gets to the folds it does not have.
  linen: 0.11,
  wool: 0.1,
};

export interface InteriorFittingGeometrySet {
  geometries: Map<InteriorFittingRegion, THREE.BufferGeometry>;
  triangleCount: number;
}

class Builders {
  private readonly builders = new Map<InteriorFittingRegion, SurfaceBuilder>();

  get(region: InteriorFittingRegion): SurfaceBuilder {
    let b = this.builders.get(region);
    if (!b) {
      b = new SurfaceBuilder();
      this.builders.set(region, b);
    }
    return b;
  }

  finish(): InteriorFittingGeometrySet {
    const geometries = new Map<InteriorFittingRegion, THREE.BufferGeometry>();
    let triangleCount = 0;
    for (const region of INTERIOR_FITTING_REGIONS) {
      const b = this.builders.get(region);
      if (!b || b.isEmpty) continue;
      geometries.set(region, b.toGeometry());
      triangleCount += b.triangleCount;
    }
    return { geometries, triangleCount };
  }
}

/**
 * Facets round a cask.
 *
 * **Eight, and this was six until the hold could be entered.** The argument for
 * six was that a cask is seen in near darkness at two metres and there are
 * ninety-six of them, so the count matters and the silhouette does not. That
 * was a true statement about looking *down* at the stow and a false one the
 * moment a body could crawl in among it: on hands and knees the nearest casks
 * are half a metre from the eye, filling a third of the screen, and six facets
 * read as a hexagonal crate rather than as a barrel.
 *
 * It cost about 2,300 triangles, which is the right trade for the only objects
 * in the ship a player's face is ever this close to. **The lesson is that a
 * detail budget is an argument about viewing distance, and the viewing distance
 * changed when the hatch became something you could go through.**
 */
const CASK_SIDES = 8;

/**
 * Facets round the cabin's small round things — a drawer ring, the barometer's
 * case, a rolled chart.
 *
 * **Twelve, and it is the cask's own argument arriving at a different answer.**
 * That comment's lesson is that a facet budget is a statement about viewing
 * distance; these are the objects with the shortest viewing distance in the
 * ship. A seated player's eye is 0.6 m from a drawer ring and *fixed there* —
 * you cannot walk past a thing you are sitting at — so there is no moment of
 * motion to hide an octagon behind. There are also about a dozen of them
 * against ninety-six casks, so twelve sides costs a few hundred triangles.
 */
const CABIN_SIDES = 12;

function sidesFor(material: FittingSolid['material']): number {
  return material === 'timber' || material === 'ironwork' ? CASK_SIDES : CABIN_SIDES;
}

/**
 * A genuinely open wash bowl, drawn inside the same frustum used for bounds.
 *
 * `addTube` is deliberately capped because spars and furniture bars are solids.
 * A basin is the exception: capping its wide end made it a pale disc, so no
 * amount of taper could communicate a cavity. The outside, rounded inner wall,
 * lip and low floor are separate surfaces with cavity-facing normals.
 */
function addOpenBowl(
  builder: SurfaceBuilder,
  solid: Extract<FittingSolid, { kind: 'bar' }>,
  sides: number,
  colour: Rgb,
): void {
  const aIsBottom = solid.a.y <= solid.b.y;
  const bottom = aIsBottom ? solid.a : solid.b;
  const top = aIsBottom ? solid.b : solid.a;
  const outerBottom = aIsBottom ? solid.radiusA : solid.radiusB;
  const outerRim = aIsBottom ? solid.radiusB : solid.radiusA;
  const height = top.y - bottom.y;
  if (
    height <= 1e-5 ||
    Math.hypot(top.x - bottom.x, top.z - bottom.z) > 1e-5
  ) {
    addTube(
      builder,
      solid.a,
      solid.b,
      solid.radiusA,
      solid.radiusB,
      sides,
      2,
      colour,
    );
    return;
  }

  const ring = (
    radius: number,
    y: number,
    normalAt: (c: number, s: number) => Vec3,
  ): { points: Vec3[]; normals: Vec3[]; colours: Rgb[] } => {
    const points: Vec3[] = [];
    const normals: Vec3[] = [];
    const colours: Rgb[] = [];
    for (let j = 0; j <= sides; j++) {
      const theta = (j / sides) * Math.PI * 2;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      points.push(v3(bottom.x + c * radius, y, bottom.z + s * radius));
      normals.push(normalAt(c, s));
      colours.push(colour);
    }
    return { points, normals, colours };
  };

  const outerSlope = (outerRim - outerBottom) / height;
  const outerPoints: Vec3[][] = [];
  const outerNormals: Vec3[][] = [];
  const outerColours: Rgb[][] = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const r = outerBottom + (outerRim - outerBottom) * t;
    const row = ring(r, bottom.y + height * t, (c, s) =>
      normalise(v3(c, -outerSlope, s)),
    );
    outerPoints.push(row.points);
    outerNormals.push(row.normals);
    outerColours.push(row.colours);
  }
  builder.addGrid(outerPoints, outerNormals, outerColours, true);

  const wall = Math.min(0.014, outerRim * 0.16);
  const cavityFloorY = bottom.y + height * 0.20;
  const innerFloor = Math.max(0.026, outerBottom * 0.24);
  const innerRim = Math.max(innerFloor + 0.01, outerRim - wall);
  const innerHeight = top.y - wall * 0.35 - cavityFloorY;
  const innerPoints: Vec3[][] = [];
  const innerNormals: Vec3[][] = [];
  const innerColours: Rgb[][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const curve = Math.sin((t * Math.PI) / 2);
    const r = innerFloor + (innerRim - innerFloor) * curve;
    const derivative =
      ((innerRim - innerFloor) * (Math.PI / 2) * Math.cos((t * Math.PI) / 2)) /
      innerHeight;
    const row = ring(r, cavityFloorY + innerHeight * t, (c, s) =>
      normalise(v3(-c, Math.max(derivative, 0.02), -s)),
    );
    innerPoints.push(row.points);
    innerNormals.push(row.normals);
    innerColours.push(row.colours);
  }
  // Opposite winding to the outside: these faces look into the cavity.
  builder.addGrid(innerPoints, innerNormals, innerColours, false);

  const outerLip = ring(outerRim, top.y, () => v3(0, 1, 0));
  const innerLip = ring(innerRim, top.y - wall * 0.35, () => v3(0, 1, 0));
  builder.addGrid(
    [outerLip.points, innerLip.points],
    [outerLip.normals, innerLip.normals],
    [outerLip.colours, innerLip.colours],
    false,
  );

  // A low ceramic floor closes the cavity; the brass drain is a separate solid.
  const floor = ring(innerFloor, cavityFloorY, () => v3(0, 1, 0));
  builder.addPolygon(floor.points.slice(0, sides), v3(0, 1, 0), colour, true);
  const underside = ring(outerBottom, bottom.y, () => v3(0, -1, 0));
  builder.addPolygon(
    underside.points.slice(0, sides),
    v3(0, -1, 0),
    colour,
    false,
  );
}

function addSolid(out: Builders, solid: FittingSolid, colour: Rgb): void {
  const builder = out.get(solid.material);
  if (solid.kind === 'box') {
    addBox(builder, solid.centre, solid.half, colour, solid.yaw);
  } else if (solid.profile === 'open-bowl') {
    addOpenBowl(builder, solid, CABIN_SIDES + 4, colour);
  } else {
    const sides = sidesFor(solid.material);
    addTube(builder, solid.a, solid.b, solid.radiusA, solid.radiusB, sides, 1, colour);
  }
}

function palette(): Record<InteriorFittingRegion, Rgb> {
  return {
    timber: rgbOf(INTERIOR_FITTING_PALETTE.timber),
    ironwork: rgbOf(INTERIOR_FITTING_PALETTE.ironwork),
    brass: rgbOf(INTERIOR_FITTING_PALETTE.brass),
    leather: rgbOf(INTERIOR_FITTING_PALETTE.leather),
    paper: rgbOf(INTERIOR_FITTING_PALETTE.paper),
    linen: rgbOf(INTERIOR_FITTING_PALETTE.linen),
    wool: rgbOf(INTERIOR_FITTING_PALETTE.wool),
  };
}

export function buildInteriorFittingGeometry(): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED);
  const base = palette();

  const draw = (solid: FittingSolid): void =>
    addSolid(out, solid, jitter(base[solid.material], random, JITTER[solid.material]));

  for (const fitting of INTERIOR_FITTINGS) fitting.solids.forEach(draw);
  HOLD_STOW.forEach(draw);

  return out.finish();
}

/**
 * The hatchway's boards, in one state, as their own geometry.
 *
 * **Two geometries, one visible at a time** — not one geometry whose vertices
 * move. The boards change twice a voyage; a mesh that rebuilt on a toggle would
 * be a buffer upload in the middle of a frame for something a stack of six
 * boards can express by existing twice. It also means the *open* state is real
 * geometry that can be looked at and tested rather than a transform nobody
 * checks.
 *
 * WHAT THIS ACTUALLY DRAWS, against what the sentence below wanted. The
 * vertex attribute comes from `INTERIOR_FITTING_PALETTE.timber`, 0x5b452c —
 * the stow's oak. The intent recorded here was the lining's paler 0xa08258,
 * and it was never carried out: the material that used to name the lining had
 * its colour overwritten before it drew anything. The two are 1.8x apart in
 * brightness, so making the intent true is a real look change in an unlit room
 * and it belongs with REVIEW_QUEUE 1.5b, which is the same question about the
 * same surfaces. Recorded, not silently taken.
 *
 * The intent, unchanged and still arguable: the paler timber is the lining's,
 * not the stow's, because it was the lining's before this moved out of
 * `shipGeometry.ts` — the boards have to read as joinery you could get your
 * fingers under, against a sole that is scrubbed planking.
 */
export function buildHatchwayBoardGeometry(open: boolean): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED ^ 0x5b0a2d);
  const base = palette();
  for (const solid of hatchwayBoards(open).solids) {
    addSolid(out, solid, jitter(base[solid.material], random, 0.05));
  }
  return out.finish();
}
/**
 * The captain's chair, in one state, as its own geometry.
 *
 * The boards' argument exactly — two geometries, one visible at a time, rather
 * than one whose vertices move. The chair changes state twice per sitting
 * instead of twice per voyage, which if anything strengthens it: a buffer
 * upload every time somebody sits down is a hitch at the precise moment the
 * camera is easing into a fixed composition, and it would be a hitch to
 * translate a rigid body 0.5 m.
 */
export function buildDeskChairGeometry(drawnOut: boolean): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED ^ 0xc4a19);
  const base = palette();
  for (const solid of deskChair(drawnOut).solids) {
    addSolid(out, solid, jitter(base[solid.material], random, JITTER[solid.material]));
  }
  return out.finish();
}

/** The captain's berth curtain in one of its two opaque cloth states. */
export function buildBoxBerthCurtainGeometry(open: boolean): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED ^ 0xc047a17);
  const base = palette();
  for (const solid of boxBerthCurtain(open).solids) {
    addSolid(out, solid, jitter(base[solid.material], random, JITTER[solid.material]));
  }
  return out.finish();
}

/**
 * The four deadlights, shipped, as their own geometry.
 *
 * One state, like the soffit and unlike the boards: unshipped, they are inside
 * the stern lockers and there is nothing to draw. So the vessel carries one set
 * of meshes and hides them, rather than a pair it swaps between.
 *
 * **It goes through `Builders` rather than one `SurfaceBuilder`, which is why
 * it is here and not in `shipGeometry`'s stern lining.** The panelling on that
 * wall is drawn straight into the lining's own builder because it *is* lining —
 * one mesh, one material, one bake. A deadlight is three materials, and it is
 * three on purpose: `cabinJoinery.addSternDeadlights` sets out why a board the
 * colour of the wall behind it would not read as shut at all.
 */
export function buildSternDeadlightGeometry(): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED ^ 0xdead1);
  const base = palette();
  addSternDeadlights(
    (material) => out.get(material),
    (material) => jitter(base[material], random, JITTER[material]),
  );
  return out.finish();
}

/**
 * The shut scuttle's soffit, as its own geometry.
 *
 * One state only, unlike the boards: there is nothing to draw when the lid is
 * up, because the hole in the deckhead is then genuinely a hole. So the vessel
 * carries one mesh and hides it, rather than a pair it swaps between.
 *
 * It *is* lining — the piece of the forecastle's ceiling that the scuttle
 * interrupts — and it is drawn in the stow's oak all the same, for the reason
 * set out over `buildHatchwayBoardGeometry`. Same unresolved question, same
 * queue line.
 */
export function buildForeScuttleSoffitGeometry(): InteriorFittingGeometrySet {
  const out = new Builders();
  const random = makeRandom(INTERIOR_FITTING_SEED ^ 0x5c0ff17);
  const base = palette();
  for (const solid of foreScuttleSoffit().solids) {
    addSolid(out, solid, jitter(base[solid.material], random, 0.05));
  }
  return out.finish();
}
