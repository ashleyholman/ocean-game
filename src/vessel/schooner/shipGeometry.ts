import * as THREE from 'three';
import {
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  COMPANION_OUTBOARD_CLEARANCE,
  BULWARK_THICKNESS,
  BULWARK_TUMBLE_RATE,
  CAPRAIL_OVERHANG,
  CAPRAIL_THICKNESS,
  COUNTER_RAKE_TAN,
  DECK_BEAM_DEPTH,
  DECK_OPENINGS,
  DECK_PLANK_THICKNESS,
  DESIGN_DRAUGHT,
  counterStationZ,
  FORECASTLE_AFT_Z,
  HALF_LENGTH,
  QUARTERDECK_FORWARD_Z,
  bulwarkOuterHalfBeam,
  counterRakeShift,
  deckAtSideY,
  floorYAt,
  halfBreadthAt,
} from './hullForm';
import type { DeckOpening } from './hullForm';
import {
  openingXLimits,
  DECK_LEVELS,
  DECK_STAIRS,
  deckHalfWidth,
  deckNormal,
  deckPoint,
  deckStandAt,
  levelBulwarkTopY,
  deckOverheadAt,
  levelWalkingY,
  stairEndHeights,
  stairOutboardX,
  stairTreadCount,
  stairTreadY,
  stairTreadZ,
} from './deckSurface';
import type { DeckLevel, DeckStair } from './deckSurface';
import {
  COMPANION_COAMING_HEIGHT,
  COMPANION_COAMING_THICKNESS,
  COMPANION_CHEEK_DEPTH,
  COMPANION_CHEEK_EDGE_REVEAL,
  COMPANION_CHEEK_WIDTH,
  COMPANION_TREAD_THICKNESS,
  companionXLimits,
  BELOW_DECKS_SPACES,
  BULKHEADS,
  BULKHEAD_THICKNESS,
  COMPANION_TREADS,
  DOORWAY_HALF_BREADTH,
  CABIN_LINING_THICKNESS,
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  INTERIOR_STEPS,
  STERN_WINDOWS,
  roofHalfWidthAt,
  sternLiningHalfWidthAt,
  sternLiningZAt,
  sternWindowZAt,
  belowDecksSpace,
  bulkheadFootY,
  bulkheadHalfWidthAt,
  bulkheadRoofOn,
  companionTreadY,
  companionTreadZ,
  doorwayHeadY,
  rudderTrunkSolid,
  spaceHalfWidthAt,
  spacePlankingY,
  spaceRoofHalfWidthAt,
  spaceSideHalfWidthAt,
  stepTreadCount,
  stepTreadY,
  stepTreadZ,
  stepsLowY,
  stepsRoom,
  stepsRunLength,
} from './deckInterior';
import type { BelowDecksSpace } from './deckInterior';
import { PLATFORM_BEAM_DEPTH } from './holdStow';
import {
  backboneBottomY,
  backboneSiding,
  backboneTopY,
  rudderBottomY,
  rudderTopY,
} from './backbone';
import {
  SurfaceBuilder,
  addBox,
  addQuadFacing,
  jitter,
  makeRandom,
  rgbOf,
  v3,
} from './shipwright';
import type { Rgb, Vec3 } from './shipwright';
import { addCabinFloorcloth, addSternPanelling } from './cabinJoinery';

/**
 * The schooner's visible hull geometry, lofted from the hull form.
 *
 * Nothing here invents a shape. The moulded surface is `halfBreadthAt`, the
 * sheer is `deckAtSideY`, the timber below the rabbet is `backbone.ts` — all of
 * which the flotation model integrates. This file decides only where to *sample*
 * them, how to split the result into paint regions, and what sits above the
 * moulded body (bulwarks, caprail, deck, transom) which the offsets table has
 * nothing to say about because none of it is under water.
 *
 * THE ONE PLACE THE MESH LEAVES THE HYDROSTATIC MODEL
 * --------------------------------------------------
 * The transom rakes aft as it rises — `docs/ship/SHIP_SPEC.md` section 3's broad transom,
 * and the counter it implies. That is a shear applied to the after body, and a
 * shear applied to an underwater surface would put the drawn hull and the
 * displacement integral into exactly the disagreement this round exists to
 * prevent.
 *
 * So the shear is keyed on height, not on length: it is identically zero at and
 * below `DESIGN_DRAUGHT` and grows above it. **Every vertex the water can reach
 * at rest is the hull form's own surface, unmodified.** `ship-geometry.test.ts`
 * asserts it rather than trusting this comment.
 */

/** Paint regions, per `docs/ship/SHIP_SPEC.md` section 16. */
export type ShipRegion =
  | 'belowWaterline'
  | 'bootTop'
  | 'topsides'
  | 'wales'
  | 'trim'
  | 'transom'
  | 'deck'
  | 'deckJoinery'
  | 'inboardBulwark'
  | 'glazing'
  // Below decks. Two regions rather than one, because the room is a floor you
  // walk on and a shell you are inside, and they want different finishes — but
  // also because "which meshes are interior" is a question the lighting has to
  // ask, and a name is a better answer to it than a bounding box.
  | 'interiorSole'
  | 'interiorLining';

export const SHIP_REGIONS: readonly ShipRegion[] = [
  'belowWaterline',
  'bootTop',
  'topsides',
  'wales',
  'trim',
  'transom',
  'deck',
  'deckJoinery',
  'inboardBulwark',
  'glazing',
  'interiorSole',
  'interiorLining',
];

/** The regions that are inside the hull, and are lit as such. */
export const INTERIOR_REGIONS: readonly ShipRegion[] = ['interiorSole', 'interiorLining'];

/**
 * Deterministic seed for plank colour variation.
 *
 * Changing it re-rolls every strake on the ship. It is not a knob — the point of
 * seeding at all is that she is built identically on every load.
 */
const SHIP_SEED = 0x5c4007e7;

// --- paint band geometry ----------------------------------------------------

/**
 * The boot-top: the stripe that marks the waterline.
 *
 * Horizontal, because it marks the *water* — unlike the wales, which follow the
 * sheer. Deliberately slightly proud of the design waterline: at rest the darker
 * band sits just above the sea and the pale composition below it disappears, and
 * as she rolls the pale flashes along the lee side. That legibility is the whole
 * argument for a pale bottom over the dark merchant coating.
 */
const BOOT_TOP_LOW = DESIGN_DRAUGHT - 0.1;
const BOOT_TOP_HIGH = DESIGN_DRAUGHT + 0.14;

/** The wales: two heavy strakes below the deck edge, parallel to the sheer. */
const WALE_TOP_BELOW_DECK = 0.34;
const WALE_DEPTH = 0.3;

interface Band {
  region: ShipRegion;
  lo: number;
  hi: number;
  /** Strakes across this band. Fixed along the hull so planking runs fore-aft. */
  rows: number;
  /** Index of the first strake, for stable per-strake colouring. */
  firstRow: number;
}

/**
 * The paint bands of the shell at `z`, from the rabbet to the deck edge.
 *
 * Row counts are constant along the whole hull even though band *heights* are
 * not. That is what makes a strake a strake: row `j` of a band is one continuous
 * plank from stem to transom, narrowing at the ends the way real planking does,
 * and it can therefore carry one colour. Subdividing by absolute height instead
 * would give plank seams that drift up and down the hull and colour that
 * flickers station to station.
 *
 * **Bands that have run out are collapsed, never dropped.** Forward of the
 * forefoot the rabbet rises past the boot-top and there is no below-waterline
 * planking left to draw; aft, under the counter, the same happens. Filtering
 * those out shifts every later band up one index, so a patch that is the wales
 * at one station is the topsides at the next and the loft joins the two — which
 * produced a scatter of inside-out slivers at both ends. A collapsed band has
 * `lo === hi`, emits exact zero-area quads, and draws nothing.
 */
function shellBands(z: number): Band[] {
  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  const waleHigh = deck - WALE_TOP_BELOW_DECK;
  const waleLow = waleHigh - WALE_DEPTH;

  const wanted: { region: ShipRegion; lo: number; hi: number; rows: number }[] = [
    { region: 'belowWaterline', lo: floor, hi: BOOT_TOP_LOW, rows: 9 },
    { region: 'bootTop', lo: BOOT_TOP_LOW, hi: BOOT_TOP_HIGH, rows: 1 },
    { region: 'topsides', lo: BOOT_TOP_HIGH, hi: waleLow, rows: 5 },
    { region: 'wales', lo: waleLow, hi: waleHigh, rows: 2 },
    { region: 'topsides', lo: waleHigh, hi: deck, rows: 2 },
  ];

  const bands: Band[] = [];
  let firstRow = 0;
  for (const w of wanted) {
    const lo = Math.min(Math.max(w.lo, floor), deck);
    const hi = Math.min(Math.max(w.hi, floor), deck);
    bands.push({ ...w, lo, hi: Math.max(hi, lo), firstRow });
    firstRow += w.rows;
  }
  return bands;
}

/** Total strakes in the shell, for sizing the colour table. */
const SHELL_ROWS = 19;

// --- the counter rake -------------------------------------------------------

// The shear itself now lives in `hullForm.ts` with the rest of the vessel's
// dimensions, because the deck is carried aft by it as well as the shell, and
// the walkable surface has to invert it. Re-exported so that the tests and
// callers that ask the loft about the rake keep asking one thing.
export { counterRakeShift } from './hullForm';

/** Place a point of the shell, including the rake. Port side. */
function shellPoint(z: number, y: number): Vec3 {
  return v3(halfBreadthAt(z, y), y, z - counterRakeShift(z, y));
}

/**
 * The same point addressed by height *fraction* between rabbet and deck edge.
 *
 * The surface is the same; only the parameterisation differs. That matters for
 * the normal below: a tangent taken along constant `y` walks off the top of the
 * hull as soon as the sheer drops, and `halfBreadthAt` answers zero there.
 */
function shellPointAtFraction(z: number, t: number): Vec3 {
  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  return shellPoint(z, floor + (deck - floor) * t);
}

/**
 * Outward normal of the shell, by central difference of the placed surface.
 *
 * Differencing the *placed* point rather than the offsets means the rake is
 * carried into the normal automatically. Doing it analytically from
 * `halfBreadthAt` alone would light the counter as though it were unsheared —
 * an 18° error exactly where the stern catches the light.
 *
 * THE LONGITUDINAL TANGENT IS TAKEN AT CONSTANT *FRACTION*, NOT CONSTANT HEIGHT
 * ---------------------------------------------------------------------------
 * The sheer rises toward both ends, so a point on the deck edge at `z` is above
 * the deck edge at `z − dz`. `halfBreadthAt` returns 0 outside the section, so
 * a constant-height stencil straddling the sheer differenced 1.05 m of breadth
 * against nothing and reported `db/dz` of 131 — a normal pointing almost
 * directly aft, along the entire length of the sheer.
 *
 * It cost twelve visibly wrong facets and would have cost a black seam down both
 * sides of the ship. Differencing along constant fraction stays on the surface
 * everywhere, which is the only place a tangent to it can be taken.
 */
function shellNormal(z: number, y: number): Vec3 {
  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  const span = Math.max(deck - floor, 1e-6);
  const dy = Math.min(4e-3, span * 0.05);
  const dz = 4e-3;

  const yLo = Math.max(y - dy, floor + dy * 0.5);
  const yHi = Math.min(y + dy, deck - dy * 0.5);
  const zLo = Math.max(z - dz, -HALF_LENGTH + dz);
  const zHi = Math.min(z + dz, HALF_LENGTH - dz);
  const t = Math.min(Math.max((y - floor) / span, 0), 1);

  const py0 = shellPoint(z, yLo);
  const py1 = shellPoint(z, yHi);
  const pz0 = shellPointAtFraction(zLo, t);
  const pz1 = shellPointAtFraction(zHi, t);

  const ty = v3(py1.x - py0.x, py1.y - py0.y, py1.z - py0.z);
  const tz = v3(pz1.x - pz0.x, pz1.y - pz0.y, pz1.z - pz0.z);

  // cross(ty, tz) points outboard on the port side; see shipwright.ts.
  const nx = ty.y * tz.z - ty.z * tz.y;
  const ny = ty.z * tz.x - ty.x * tz.z;
  const nz = ty.x * tz.y - ty.y * tz.x;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return v3(1, 0, 0);
  return v3(nx / len, ny / len, nz / len);
}

// --- bulwarks ---------------------------------------------------------------

// The bulwark's own dimensions now live in `hullForm.ts` — they are dimensions
// of the vessel, not of this loft, and `rig.ts` has to place fittings on them.
// See the note there on what two descriptions of one wall cost.

// --- the build ---------------------------------------------------------------

/** Longitudinal samples along the hull. */
const LONGITUDINAL_SAMPLES = 140;

export interface ShipGeometrySet {
  geometries: Map<ShipRegion, THREE.BufferGeometry>;
  triangleCount: number;
}

interface Palette {
  base: Record<ShipRegion, number>;
  jitterAmount: Record<ShipRegion, number>;
}

/**
 * The canonical palette, per `docs/ship/SHIP_SPEC.md` section 16.
 *
 * No broad bright stripe anywhere: ochre appears on the caprail and the transom
 * moulding and nowhere else, which is what keeps her a merchantman rather than a
 * warship.
 *
 * WHY THESE ARE AS DARK AS THEY ARE, AND WHY THEY STAYED
 * ------------------------------------------------------
 * The topsides sit at about 3% linear reflectance — darker than charcoal,
 * exactly as "very dark tarred brown" implies — and this palette has been
 * blamed twice for something that was never its fault.
 *
 * The first time, `scene.environment` was null and no material carried an
 * `envMap`, so a dark glossy hull had nothing to reflect. A dark glossy surface
 * in daylight is mostly visible because of the sky *in* it; strip that away and
 * all that is left is pigment times direct light, which on a vertical face is
 * almost nothing. She rendered as a featureless silhouette. The second time, an
 * attempt to fix that by lightening the paint to 15% *under that same broken
 * lighting* produced a flat tan boat, and the palette was blamed for that too.
 *
 * The lighting is fixed now: one camera-independent radiance source, a real
 * cosine convolution for diffuse and a PMREM for specular, no ship-specific
 * gain anywhere (`WorldPbrMaterial`). Under it, these values render as what they
 * are — tarred timber with real form on a lit face and honest darkness on a
 * shaded one.
 *
 * A THIRD ROUND HAPPENED ANYWAY, AND IT IS WORTH KNOWING WHY IT REVERSED
 * ----------------------------------------------------------------------
 * With correct lighting the question could finally be asked properly, so four
 * palettes were rendered on a controlled sheet — three lights, one instant and
 * one sea per row, so along any row the only variable was the paint. Oiled larch
 * (~16%) won and was landed.
 *
 * Then the display transform changed. ACES was replaced by a hue-preserving
 * curve that compresses the peak channel and scales all three together, and
 * measured, ACES had been removing 20-30% of the chroma from every bright band.
 * Re-rendering the same sheet under the new transform moved the verdict back:
 * tar no longer reads as a black hole, because the curve that was crushing it is
 * gone, and the larch that had looked like warm timber under ACES now read light
 * and tan — the very failure the 15% experiment produced.
 *
 * The lesson is not about tar. It is that a palette verdict is only valid under
 * the display transform it was taken through, and both times this palette was
 * "wrong" the actual fault was downstream of the paint.
 *
 * **If she ever goes flat and black again, run `window.worldLightingAudit()`
 * before touching these values.** A source map of zeros publishes a black probe,
 * and a black probe is indistinguishable from a deliberately dark palette — it
 * cost this project a full contact sheet once already. `shipPalettes.ts` keeps
 * the candidates renderable so the comparison can be redone rather than
 * remembered.
 */
export const SHIP_PALETTE: Palette = {
  base: {
    // Pale protective composition — tallow and white lead, the period answer.
    belowWaterline: 0xb9b3a4,
    bootTop: 0x2b2521,
    topsides: 0x3a2f27,
    wales: 0x261e19,
    trim: 0x9c7b3a,
    transom: 0x342a23,
    deck: 0x8d7a5c,
    // Oiled companionway joinery exposed to weather-deck light. This shares
    // the cabin lining's timber colour but not its enclosed lighting region.
    deckJoinery: 0xa08258,
    // Warm dull red inboard: from the deck this is most of what surrounds you.
    inboardBulwark: 0x6d3b2d,
    glazing: 0x14161a,
    // The cabin is meant to read *warmer and lighter than the dark exterior* —
    // spec section 9 says that contrast is the point of the room. So these are
    // scrubbed pine and oiled oak rather than the tarred palette above, and they
    // are the brightest timber on the ship. Whether that survives contact with
    // the interior lighting is the thing to look at, not the hex.
    interiorSole: 0x6f5537,
    interiorLining: 0xa08258,
  },
  jitterAmount: {
    belowWaterline: 0.05,
    bootTop: 0.03,
    topsides: 0.07,
    wales: 0.05,
    trim: 0.04,
    transom: 0.04,
    deck: 0.1,
    deckJoinery: 0.05,
    inboardBulwark: 0.06,
    glazing: 0.0,
    interiorSole: 0.09,
    interiorLining: 0.05,
  },
};

class RegionBuilders {
  private readonly builders = new Map<ShipRegion, SurfaceBuilder>();

  get(region: ShipRegion): SurfaceBuilder {
    let b = this.builders.get(region);
    if (!b) {
      b = new SurfaceBuilder();
      this.builders.set(region, b);
    }
    return b;
  }

  finish(): ShipGeometrySet {
    const geometries = new Map<ShipRegion, THREE.BufferGeometry>();
    let triangleCount = 0;
    for (const region of SHIP_REGIONS) {
      const b = this.builders.get(region);
      if (!b || b.isEmpty) continue;
      geometries.set(region, b.toGeometry());
      triangleCount += b.triangleCount;
    }
    return { geometries, triangleCount };
  }
}

/** Build every mesh of the bare hull. */
export function buildShipGeometry(): ShipGeometrySet {
  const out = new RegionBuilders();
  const random = makeRandom(SHIP_SEED);

  buildShell(out, random);
  buildBulwarks(out, random);
  buildDecks(out, random);
  buildBow(out, random);
  buildTransom(out, random);
  buildBackbone(out, random);
  buildRudder(out, random);
  buildBelowDecks(out, random);

  return out.finish();
}

function longitudinalSamples(from: number, to: number, count: number): number[] {
  const zs: number[] = [];
  for (let i = 0; i <= count; i++) zs.push(from + ((to - from) * i) / count);
  return zs;
}

/**
 * One station lattice for every longitudinal hull surface.
 *
 * The two deck breaks are inserted explicitly. Shell, bulwark and deck then
 * reuse subsets of this exact array, so a shared seam cannot acquire different
 * segment endpoints merely because two builders rounded a sample count
 * differently.
 */
function hullLongitudinalSamples(): number[] {
  const zs = longitudinalSamples(-HALF_LENGTH, HALF_LENGTH, LONGITUDINAL_SAMPLES);
  zs.push(QUARTERDECK_FORWARD_Z, FORECASTLE_AFT_Z);
  zs.sort((a, b) => a - b);
  return zs.filter((z, index) => index === 0 || Math.abs(z - zs[index - 1]) > 1e-9);
}

function hullSamplesBetween(z0: number, z1: number): number[] {
  return hullLongitudinalSamples().filter((z) => z >= z0 - 1e-9 && z <= z1 + 1e-9);
}


/** The planked shell, from the rabbet to the deck edge, both sides. */
function buildShell(out: RegionBuilders, random: () => number): void {
  const zs = hullLongitudinalSamples();

  // Draw the per-strake colours up front so they do not depend on band order.
  const perStrake: Rgb[] = [];
  {
    const byRow = new Map<number, ShipRegion>();
    for (const band of shellBands(0)) {
      for (let j = 0; j < band.rows; j++) byRow.set(band.firstRow + j, band.region);
    }
    for (let i = 0; i < SHELL_ROWS; i++) {
      const region = byRow.get(i) ?? 'topsides';
      perStrake.push(
        jitter(rgbOf(SHIP_PALETTE.base[region]), random, SHIP_PALETTE.jitterAmount[region]),
      );
    }
  }

  // Bands are the same list at every station, so walk them by index.
  const template = shellBands(0);
  for (let b = 0; b < template.length; b++) {
    const rows = template[b].rows;
    const firstRow = template[b].firstRow;
    const region = template[b].region;

    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];

    for (const z of zs) {
      const bands = shellBands(z);
      const band = bands[b];
      const rowPoints: Vec3[] = [];
      const rowNormals: Vec3[] = [];
      const rowColours: Rgb[] = [];

      for (let j = 0; j <= rows; j++) {
        const t = j / rows;
        const y = band.lo + (band.hi - band.lo) * t;
        rowPoints.push(shellPoint(z, y));
        rowNormals.push(shellNormal(z, y));
        rowColours.push(perStrake[Math.min(firstRow + Math.max(j - 1, 0), SHELL_ROWS - 1)]);
      }

      points.push(rowPoints);
      normals.push(rowNormals);
      colours.push(rowColours);
    }

    addMirrored(out, region, points, normals, colours, true);
  }
}

/**
 * The deck levels the bulwarks and the deck are both built over.
 *
 * `deckSurface.ts` owns them now — including the two bulwark heights, which were
 * literals here and literals in `hullForm.bulwarkTopY`, two descriptions of one
 * wall that happened to agree.
 */
type BulwarkSegment = DeckLevel;
const BULWARK_SEGMENTS = DECK_LEVELS;

function segmentWalkingY(z: number, segment: BulwarkSegment): number {
  return levelWalkingY(z, segment);
}

function segmentBulwarkTopY(z: number, segment: BulwarkSegment): number {
  return levelBulwarkTopY(z, segment);
}

function segmentRowsY(z: number, segment: BulwarkSegment): number[] {
  const deck = deckAtSideY(z);
  const walking = segmentWalkingY(z, segment);
  const top = segmentBulwarkTopY(z, segment);
  const rows = [deck];
  if (walking - deck > 1e-6) rows.push(walking);
  rows.push(walking + (top - walking) * 0.5, top);
  return rows;
}

function mirrorPoint(point: Vec3): Vec3 {
  return v3(-point.x, point.y, point.z);
}


/**
 * Bulwarks and caprails are closed solids, one per deck level.
 *
 * Splitting them at the two deck breaks is essential. A single longitudinal
 * grid used to bridge each discontinuity diagonally, while the deck stopped at
 * the exact break, leaving neither a real step nor a shared edge. Each segment
 * now owns exact outer/inner boundaries and exposed end grain; the deck and
 * caprail complete the ordered envelope. The caprail is likewise a complete
 * tapered section rather than the old top-and-outboard-edge ribbon.
 */
function buildBulwarks(out: RegionBuilders, random: () => number): void {
  const topsides = rgbOf(SHIP_PALETTE.base.topsides);
  const inboard = rgbOf(SHIP_PALETTE.base.inboardBulwark);
  const trim = rgbOf(SHIP_PALETTE.base.trim);

  for (const segment of BULWARK_SEGMENTS) {
    const zs = hullSamplesBetween(segment.z0, segment.z1);
    const portRows = zs.map((z) =>
      segmentRowsY(z, segment).map((y) => {
        const outer = bulwarkOuterHalfBeam(z, y);
        const inner = Math.max(outer - BULWARK_THICKNESS, 0);
        const placedZ = z - counterRakeShift(z, y);
        return {
          outer: v3(outer, y, placedZ),
          inner: v3(inner, y, placedZ),
        };
      }),
    );
    const walkingRowIndex = segment.deckRise > 1e-6 ? 1 : 0;

    for (let i = 0; i < zs.length - 1; i++) {
      const aRows = portRows[i];
      const bRows = portRows[i + 1];
      for (let j = 0; j < aRows.length - 1; j++) {
        const colourOut = jitter(topsides, random, 0.05);
        const colourIn = jitter(inboard, random, 0.05);
        addQuadFacing(
          out.get('topsides'),
          aRows[j].outer,
          bRows[j].outer,
          bRows[j + 1].outer,
          aRows[j + 1].outer,
          outerFaceNormal((zs[i] + zs[i + 1]) * 0.5, (aRows[j].outer.y + aRows[j + 1].outer.y) * 0.5),
          colourOut,
        );
        addQuadFacing(
          out.get('topsides'),
          mirrorPoint(aRows[j].outer),
          mirrorPoint(aRows[j + 1].outer),
          mirrorPoint(bRows[j + 1].outer),
          mirrorPoint(bRows[j].outer),
          v3(-1, 0, 0),
          colourOut,
        );
        if (j >= walkingRowIndex) {
          addQuadFacing(
            out.get('inboardBulwark'),
            aRows[j].inner,
            aRows[j + 1].inner,
            bRows[j + 1].inner,
            bRows[j].inner,
            v3(-1, 0, 0),
            colourIn,
          );
          addQuadFacing(
            out.get('inboardBulwark'),
            mirrorPoint(aRows[j].inner),
            mirrorPoint(bRows[j].inner),
            mirrorPoint(bRows[j + 1].inner),
            mirrorPoint(aRows[j + 1].inner),
            v3(1, 0, 0),
            colourIn,
          );
        }
      }

      const aTop = aRows[aRows.length - 1];
      const bTop = bRows[bRows.length - 1];

      // The caprail is part of the same exterior envelope. Its underside is only
      // the two overhang strips; the span directly over the wall is internal and
      // must not become a third face along the wall/cap junction.
      for (const side of [1, -1] as const) {
        const capAt = (row: { outer: Vec3; inner: Vec3 }) => {
          const sign = side;
          const outerX = sign * (Math.abs(row.outer.x) + CAPRAIL_OVERHANG);
          const innerX = sign * Math.max(Math.abs(row.inner.x) - CAPRAIL_OVERHANG, 0);
          return {
            outerBottom: v3(outerX, row.outer.y, row.outer.z),
            innerBottom: v3(innerX, row.outer.y, row.outer.z),
            outerTop: v3(outerX, row.outer.y + CAPRAIL_THICKNESS, row.outer.z),
            innerTop: v3(innerX, row.outer.y + CAPRAIL_THICKNESS, row.outer.z),
          };
        };
        const ca = capAt(aTop);
        const cb = capAt(bTop);
        const outward = v3(side, 0, 0);
        const inward = v3(-side, 0, 0);
        const colour = jitter(trim, random, 0.04);
        addQuadFacing(out.get('trim'), ca.innerTop, ca.outerTop, cb.outerTop, cb.innerTop, v3(0, 1, 0), colour);
        const wallOuterA = side === 1 ? aTop.outer : mirrorPoint(aTop.outer);
        const wallOuterB = side === 1 ? bTop.outer : mirrorPoint(bTop.outer);
        const wallInnerA = side === 1 ? aTop.inner : mirrorPoint(aTop.inner);
        const wallInnerB = side === 1 ? bTop.inner : mirrorPoint(bTop.inner);
        addQuadFacing(out.get('trim'), ca.outerBottom, wallOuterA, wallOuterB, cb.outerBottom, v3(0, -1, 0), colour);
        addQuadFacing(out.get('trim'), wallInnerA, ca.innerBottom, cb.innerBottom, wallInnerB, v3(0, -1, 0), colour);
        addQuadFacing(out.get('trim'), ca.outerBottom, cb.outerBottom, cb.outerTop, ca.outerTop, outward, colour);
        addQuadFacing(out.get('trim'), ca.innerBottom, ca.innerTop, cb.innerTop, cb.innerBottom, inward, colour);
      }
    }

    // End-grain closes both the bulwark plank and the caprail at each end of the
    // segment. Neighbouring deck levels can overlap at a break, but neither can
    // expose an unpaired open wall there.
    for (const endIndex of [0, zs.length - 1]) {
      const rows = portRows[endIndex];
      const endZ = zs[endIndex];
      // Bow and stern are closed once, by buildEndPanel, from the exact complete
      // cross-section. Emitting each side's end grain there as well put coplanar
      // faces under the closure and produced the critic's patchy/starburst bow.
      if (Math.abs(Math.abs(endZ) - HALF_LENGTH) < 1e-9) continue;
      const normal = v3(0, 0, endIndex === 0 ? -1 : 1);
      for (const side of [1, -1] as const) {
        const point = (p: Vec3): Vec3 => (side === 1 ? p : mirrorPoint(p));
        for (let j = walkingRowIndex; j < rows.length - 1; j++) {
          addQuadFacing(
            out.get('inboardBulwark'),
            point(rows[j].inner),
            point(rows[j].outer),
            point(rows[j + 1].outer),
            point(rows[j + 1].inner),
            normal,
            jitter(inboard, random, 0.03),
          );
        }
        const top = rows[rows.length - 1];
        const sign = side;
        const outerX = sign * (Math.abs(top.outer.x) + CAPRAIL_OVERHANG);
        const innerX = sign * Math.max(Math.abs(top.inner.x) - CAPRAIL_OVERHANG, 0);
        const outerBottom = v3(outerX, top.outer.y, top.outer.z);
        const innerBottom = v3(innerX, top.outer.y, top.outer.z);
        addQuadFacing(
          out.get('trim'),
          innerBottom,
          outerBottom,
          v3(outerX, top.outer.y + CAPRAIL_THICKNESS, top.outer.z),
          v3(innerX, top.outer.y + CAPRAIL_THICKNESS, top.outer.z),
          normal,
          jitter(trim, random, 0.03),
        );
      }
    }
  }
}

function outerFaceNormal(z: number, y: number): Vec3 {
  const dz = 4e-3;
  const zLo = Math.max(z - dz, -HALF_LENGTH + dz);
  const zHi = Math.min(z + dz, HALF_LENGTH - dz);
  const p0 = v3(bulwarkOuterHalfBeam(zLo, y), y, zLo - counterRakeShift(zLo, y));
  const p1 = v3(bulwarkOuterHalfBeam(zHi, y), y, zHi - counterRakeShift(zHi, y));
  const tz = v3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
  const ty = v3(BULWARK_TUMBLE_RATE, 1, -COUNTER_RAKE_TAN * 0);
  const nx = ty.y * tz.z - ty.z * tz.y;
  const ny = ty.z * tz.x - ty.x * tz.z;
  const nz = ty.x * tz.y - ty.y * tz.x;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return v3(1, 0, 0);
  return v3(nx / len, ny / len, nz / len);
}

/**
 * Emit a port patch and its mirror image.
 *
 * Mirroring x reverses the handedness of every triangle, so the starboard copy takes
 * the opposite winding to end up facing outward again. Getting that backwards
 * makes one whole side of the ship invisible from outside and perfectly solid
 * from within, which is a strange thing to debug by eye — `ship-geometry.test.ts`
 * checks winding against the supplied normals instead.
 */
function addMirrored(
  out: RegionBuilders,
  region: ShipRegion,
  points: Vec3[][],
  normals: Vec3[][],
  colours: Rgb[][],
  flip: boolean,
): void {
  out.get(region).addGrid(points, normals, colours, flip);
  const mp = points.map((r) => r.map((p) => v3(-p.x, p.y, p.z)));
  const mn = normals.map((r) => r.map((n) => v3(-n.x, n.y, n.z)));
  out.get(region).addGrid(mp, mn, colours, !flip);
}

/**
 * One patch of deck: stations `zs`, across-beam `u` from `uFrom` to `uTo`.
 *
 * Split out of `buildDecks` so the quarterdeck can be lofted *around* the
 * companionway rather than straight over it. The hole is a fact about the
 * drawn deck and about nothing else — `deckSurface.ts` still answers the lofted
 * height inside it, which is what the rig and the fittings mean when they ask
 * how high the deck is near a hatch, and only a body asks `deckObstacles.ts`,
 * which is where the opening is subtracted.
 */
function addDeckPatch(
  out: RegionBuilders,
  random: () => number,
  segment: BulwarkSegment,
  zs: readonly number[],
  uFrom: (z: number) => number,
  uTo: (z: number) => number,
  cols: number,
): void {
  const deckColour = rgbOf(SHIP_PALETTE.base.deck);
  const points: Vec3[][] = [];
  const normals: Vec3[][] = [];
  const colours: Rgb[][] = [];

  for (const z of zs) {
    const rowP: Vec3[] = [];
    const rowN: Vec3[] = [];
    const rowC: Rgb[] = [];
    const u0 = uFrom(z);
    const u1 = uTo(z);
    for (let j = 0; j <= cols; j++) {
      const u = u0 + ((u1 - u0) * j) / cols;
      rowP.push(deckPoint(z, u, segment));
      rowN.push(deckNormal(z, u, segment));
      // Planks run fore and aft, so the colour is keyed across the beam.
      rowC.push(jitter(deckColour, random, SHIP_PALETTE.jitterAmount.deck));
    }
    points.push(rowP);
    normals.push(rowN);
    colours.push(rowC);
  }
  out.get('deck').addGrid(points, normals, colours, false);
}

/** Stations spanning `z0` to `z1`, with both ends present exactly. */
function deckPatchSamples(z0: number, z1: number): number[] {
  const zs = hullSamplesBetween(z0, z1).filter((z) => z > z0 + 1e-6 && z < z1 - 1e-6);
  return [z0, ...zs, z1];
}

/**
 * An opening's edge as an across-beam fraction at station `z`.
 *
 * The opening is a fixed number of metres off the centreline, and the deck's
 * grid runs in fractions of a half-breadth that changes with the station — so
 * the fraction has to be recomputed at every row or the hole comes out tapered,
 * following the sheer instead of standing square as a carpentered opening does.
 */
function openingEdgeU(
  opening: DeckOpening,
  z: number,
  segment: BulwarkSegment,
  side: 1 | -1,
): number {
  const w = deckHalfWidth(z, segment);
  if (w <= 1e-6) return side;
  const { xLo, xHi } = openingXLimits(opening, z);
  return Math.max(-1, Math.min(1, (side > 0 ? xHi : xLo) / w));
}

/**
 * Cambered deck in three levels, with a riser at each break and a hole at each
 * opening.
 *
 * **Two holes now, and the second one is the cargo hatch.** M3 drew the hatch as
 * a coaming and a grating standing on unbroken planking — which is a hatch you
 * cannot see through, and while the hold was undrawn nothing was lost by it.
 * The platform deck makes that shaft the wardroom's only daylight and the only
 * line a cask can travel from the sky to the stow, so the deck under the grating
 * has to actually be open. Nothing about the *walk* changes: the grating is a
 * standable panel over the whole footprint and the walker stands on it, so
 * `deckSurface.ts` still answers the lofted height inside the hole, which is
 * what the rig and the fittings mean when they ask how high the deck is there.
 */
function buildDecks(out: RegionBuilders, random: () => number): void {
  const COLS = 8;

  for (const segment of BULWARK_SEGMENTS) {
    // **Inclusive at the segment's own ends, and that is not tidying.** It was
    // `zForward < segment.z1`, which is right for an opening in the middle of a
    // deck and silently wrong for one that reaches the edge. The companionway's
    // head is now the quarterdeck break — the same number as this segment's
    // forward limit — so the filter dropped it, the deck was lofted straight
    // across the hole, and the first thing Ash saw was the planking still lying
    // inside the coaming with the lantern standing on it.
    //
    // The walker never agreed with any of it: `schoonerStandAt` reads
    // `inCompanionway` and had been withdrawing the deck there the whole time.
    // A hole you fall through and cannot see is the same class of fault as a
    // wall you can see through and walk past.
    const openings = DECK_OPENINGS.filter(
      (opening) => opening.zAft >= segment.z0 && opening.zForward <= segment.z1,
    ).sort((a, b) => a.zAft - b.zAft);

    let z0 = segment.z0;
    for (const opening of openings) {
      addDeckPatch(out, random, segment, deckPatchSamples(z0, opening.zAft), () => -1, () => 1, COLS);
      // And beside it, a strip each side. Half the columns: these are a quarter
      // of the beam apiece and the camber across them is 9 mm.
      const beside = deckPatchSamples(opening.zAft, opening.zForward);
      addDeckPatch(out, random, segment, beside, () => -1, (z) => openingEdgeU(opening, z, segment, -1), COLS / 2);
      addDeckPatch(out, random, segment, beside, (z) => openingEdgeU(opening, z, segment, 1), () => 1, COLS / 2);
      z0 = opening.zForward;
    }
    addDeckPatch(out, random, segment, deckPatchSamples(z0, segment.z1), () => -1, () => 1, COLS);
  }

  // Risers at the two breaks: a vertical face across the beam, joining the lower
  // deck's surface to the raised one. The quarterdeck's riser faces forward, the
  // forecastle's faces aft — both are seen from the working deck between them.
  buildRiser(out, random, QUARTERDECK_FORWARD_Z, COLS, BULWARK_SEGMENTS[1], BULWARK_SEGMENTS[0], 1);
  buildRiser(out, random, FORECASTLE_AFT_Z, COLS, BULWARK_SEGMENTS[1], BULWARK_SEGMENTS[2], -1);
  buildDeckStairs(out, random);
}

/**
 * The ladders at the quarterdeck break, drawn from the surface's own data.
 *
 * Each tread is a solid block standing on the waist deck, so the flight reads as
 * timber rather than as a floating plank, and its top face is exactly the height
 * `deckStandAt` answers there. Neither of those is a coincidence — both come out
 * of `stairTreadY`, which is what the walker climbs.
 */
function buildDeckStairs(out: RegionBuilders, random: () => number): void {
  const deckColour = rgbOf(SHIP_PALETTE.base.deck);

  for (const stair of DECK_STAIRS) {
    const treads = stairTreadCount(stair);
    for (const side of stair.sides) {
      for (let index = 1; index <= treads; index++) {
        const { zAft, zForward } = stairTreadZ(stair, index);
        // One timber block, one finish. The former dark-red risers and cheeks
        // could look like the top plank under direct Sun and collapse to black
        // when they turned away from it, which made one stair appear to change
        // material over an afternoon. Preserve the per-block deck variation,
        // but carry the exact same sample around every face.
        const timberColour = jitter(
          deckColour,
          random,
          SHIP_PALETTE.jitterAmount.deck,
        );
        addTreadBlock(
          out.get('deck'),
          timberColour,
          timberColour,
          stair,
          index,
          zAft,
          zForward,
          side,
        );
      }
    }
  }
}

/**
 * One tread: a block whose top carries the deck's camber and whose outboard side
 * follows the ship.
 *
 * Both are the same point. A tread drawn as a flat plane against a deck crowned
 * 90 mm across its half-breadth reads as crooked, and a tread with a straight
 * outboard edge against a curved side leaves a wedge of deck nobody can stand
 * in. So the top is a strip of quads sampled across the width, each corner
 * asking `deckSurface.ts` where the tread is at *that* x — the same question the
 * walker asks when it stands there.
 */
function addTreadBlock(
  builder: SurfaceBuilder,
  topColour: Rgb,
  sideColour: Rgb,
  stair: DeckStair,
  index: number,
  zAft: number,
  zForward: number,
  side: 1 | -1,
): void {
  const COLUMNS = 4;
  const inboard = stair.xInboard;
  const outboardAft = stairOutboardX(stair, zAft);
  const outboardForward = stairOutboardX(stair, zForward);
  // The block stands on the deck under the flight's foot, a little below it so
  // the planking hides the join rather than z-fighting with it.
  const baseY = stairEndHeights(stair, inboard).footY - 0.06;

  const at = (u: number, z: number, outboard: number) => {
    const x = inboard + (outboard - inboard) * u;
    return { x: x * side, y: stairTreadY(stair, index, x), z };
  };

  for (let i = 0; i < COLUMNS; i++) {
    const u0 = i / COLUMNS;
    const u1 = (i + 1) / COLUMNS;
    const aft0 = at(u0, zAft, outboardAft);
    const aft1 = at(u1, zAft, outboardAft);
    const fwd0 = at(u0, zForward, outboardForward);
    const fwd1 = at(u1, zForward, outboardForward);
    addQuadFacing(
      builder,
      v3(aft0.x, aft0.y, aft0.z),
      v3(aft1.x, aft1.y, aft1.z),
      v3(fwd1.x, fwd1.y, fwd1.z),
      v3(fwd0.x, fwd0.y, fwd0.z),
      v3(0, 1, 0),
      topColour,
    );
    // The riser you climb, under the forward edge of this strip.
    addQuadFacing(
      builder,
      v3(fwd0.x, baseY, fwd0.z),
      v3(fwd1.x, baseY, fwd1.z),
      v3(fwd1.x, fwd1.y, fwd1.z),
      v3(fwd0.x, fwd0.y, fwd0.z),
      v3(0, 0, 1),
      sideColour,
    );
  }

  const cheek = (x: number, z: number, outboard: number, normalX: number) => {
    const top = at(x === inboard ? 0 : 1, z, outboard);
    return { top, normalX };
  };
  const inAft = cheek(inboard, zAft, outboardAft, -side);
  const inFwd = cheek(inboard, zForward, outboardForward, -side);
  addQuadFacing(
    builder,
    v3(inAft.top.x, baseY, zAft),
    v3(inFwd.top.x, baseY, zForward),
    v3(inFwd.top.x, inFwd.top.y, zForward),
    v3(inAft.top.x, inAft.top.y, zAft),
    v3(-side, 0, 0),
    sideColour,
  );
  const outAft = at(1, zAft, outboardAft);
  const outFwd = at(1, zForward, outboardForward);
  addQuadFacing(
    builder,
    v3(outAft.x, baseY, zAft),
    v3(outFwd.x, baseY, zForward),
    v3(outFwd.x, outFwd.y, zForward),
    v3(outAft.x, outAft.y, zAft),
    v3(side, 0, 0),
    sideColour,
  );
}

/**
 * One deck riser at `zBreak`.
 *
 * `facing` is +1 when the raised deck is aft (so the riser looks forward) and
 * −1 when it is forward.
 */
/**
 * A break's vertical face, with a gap where an opening meets it.
 *
 * **The gap is the companionway's entrance.** Its head is the break itself, so
 * the face a body would walk into is exactly where it walks *in*. Drawing the
 * riser across it would wall up the only way below decks — and it would do so
 * invisibly from the waist, because the flight beyond is in shadow.
 */
function buildRiser(
  out: RegionBuilders,
  random: () => number,
  zBreak: number,
  cols: number,
  lowSegment: BulwarkSegment,
  highSegment: BulwarkSegment,
  facing: 1 | -1,
): void {
  const normal = v3(0, 0, facing);
  const colour = jitter(rgbOf(SHIP_PALETTE.base.inboardBulwark), random, 0.04);

  // Openings that land on this break, in u, on the high side's own half-width —
  // which is the one the missing deck belongs to.
  const highWidth = deckHalfWidth(zBreak, highSegment);
  const gaps = DECK_OPENINGS.filter(
    (o) => !o.covered && Math.min(Math.abs(o.zAft - zBreak), Math.abs(o.zForward - zBreak)) < 1e-6,
  ).map((o) => {
    const { xLo, xHi } = openingXLimits(o, zBreak);
    return highWidth > 1e-6
      ? { u0: xLo / highWidth, u1: xHi / highWidth }
      : { u0: 0, u1: 0 };
  });

  // **Split at the opening's own edges, not on the column grid.** This dropped
  // whole columns, and a column is 0.47 m against an 0.84 m opening — so the
  // riser lost up to 1.4 m of face for a 0.84 m hole and the break stood open
  // half a metre either side of the stair. Ash saw it as the transverse wall
  // being cut wider than the staircase, which is exactly what it was.
  const edges = new Set<number>();
  for (let j = 0; j <= cols; j++) edges.add((j / cols) * 2 - 1);
  for (const gap of gaps) {
    if (gap.u0 > -1 && gap.u0 < 1) edges.add(gap.u0);
    if (gap.u1 > -1 && gap.u1 < 1) edges.add(gap.u1);
  }
  const us = [...edges].sort((a, b) => a - b);

  for (let j = 0; j < us.length - 1; j++) {
    const u0 = us[j];
    const u1 = us[j + 1];
    if (u1 - u0 <= 1e-9) continue;
    const mid = (u0 + u1) * 0.5;
    if (gaps.some((gap) => mid > gap.u0 && mid < gap.u1)) continue;
    const low0 = deckPoint(zBreak, u0, lowSegment);
    const low1 = deckPoint(zBreak, u1, lowSegment);
    const high0 = deckPoint(zBreak, u0, highSegment);
    const high1 = deckPoint(zBreak, u1, highSegment);
    // **Both faces.** A riser was one quad facing the working deck, which is
    // right for the only eye that used to be able to see it. The quarterdeck's
    // break stands from the waist deck at 3.88 to the quarterdeck at 4.45, and
    // the landing's own deckhead is 4.27 — so the lower 0.39 m of it is *inside
    // the landing*, at head height, and from in there it was a wall you could
    // see straight through into daylight over the waist.
    //
    // This is the one-sided-surface fault the round has been carrying as a
    // known open item, found by eye at the one place the new arrangement put an
    // eye. It also explains the room-seal sweep's escapes at y = 3.95 heading
    // forward, which had been written off as the test not knowing about the new
    // opening. It was not the test.
    addQuadFacing(out.get('inboardBulwark'), low0, low1, high1, high0, normal, colour);
    addQuadFacing(
      out.get('inboardBulwark'),
      high0,
      high1,
      low1,
      low0,
      v3(0, 0, -facing),
      colour,
    );
  }
}

function buildEndPanel(
  out: RegionBuilders,
  random: () => number,
  z: number,
  segment: BulwarkSegment,
  normal: Vec3,
  shellRegion: (band: Band) => ShipRegion,
  upperRegion: ShipRegion,
): void {
  const baseFor = (region: ShipRegion): Rgb => rgbOf(SHIP_PALETTE.base[region]);

  // The shell edge is not re-sampled: it uses the exact same band rows as the
  // side loft. That removes the transom's former T-junctions and makes the bow
  // closure share every edge, including rows that collapse at the forefoot.
  for (const band of shellBands(z)) {
    const region = shellRegion(band);
    for (let j = 0; j < band.rows; j++) {
      const y0 = band.lo + ((band.hi - band.lo) * j) / band.rows;
      const y1 = band.lo + ((band.hi - band.lo) * (j + 1)) / band.rows;
      const p0 = shellPoint(z, y0);
      const p1 = shellPoint(z, y1);
      addQuadFacing(
        out.get(region),
        mirrorPoint(p0),
        p0,
        p1,
        mirrorPoint(p1),
        normal,
        jitter(baseFor(region), random, SHIP_PALETTE.jitterAmount[region] * 0.5),
      );
    }
  }

  const rows = segmentRowsY(z, segment);
  for (let j = 0; j < rows.length - 1; j++) {
    const y0 = rows[j];
    const y1 = rows[j + 1];
    const b0 = bulwarkOuterHalfBeam(z, y0);
    const b1 = bulwarkOuterHalfBeam(z, y1);
    const z0 = z - counterRakeShift(z, y0);
    const z1 = z - counterRakeShift(z, y1);
    addQuadFacing(
      out.get(upperRegion),
      v3(-b0, y0, z0),
      v3(b0, y0, z0),
      v3(b1, y1, z1),
      v3(-b1, y1, z1),
      normal,
      jitter(baseFor(upperRegion), random, SHIP_PALETTE.jitterAmount[upperRegion]),
    );
  }

  /**
   * The inboard face of the end bulwark, and the caprail that caps it.
   *
   * BOTH WERE MISSING, AND THE HOLE WAS ONE-SIDED
   * ---------------------------------------------
   * This routine emitted a single outward-facing panel across the end and
   * nothing behind it. From astern the transom looked solid; from anywhere
   * forward of it you were looking at that panel's back face, which is culled,
   * so the after wall of the deck was simply *transparent* — a hull you could
   * see out through in one direction only. The side bulwarks have had an
   * `inboardBulwark` face all along; the two ends never got one.
   *
   * The caprail had the same shape of gap. The sides carry a full box — top,
   * two undersides, outer and inner faces — and it stopped dead at each end
   * with only its aft *edge* drawn, so the stern had no thick rail while every
   * other part of the sheer did. Now it turns the corner.
   */
  const topY = rows[rows.length - 1];
  const placedZ = z - counterRakeShift(z, topY);
  const trimColour = (): Rgb => jitter(baseFor('trim'), random, 0.03);

  // Inward is along the panel's own normal, reversed: the transom rakes, so
  // "toward the ship" is not simply +z.
  const inward = v3(-normal.x, -normal.y, -normal.z);
  const inset = (p: Vec3, by: number): Vec3 =>
    v3(p.x + inward.x * by, p.y + inward.y * by, p.z + inward.z * by);

  const walkingRowIndex = segment.deckRise > 1e-6 ? 1 : 0;
  const inboardColour = jitter(baseFor('inboardBulwark'), random, 0.05);
  for (let j = walkingRowIndex; j < rows.length - 1; j++) {
    const y0 = rows[j];
    const y1 = rows[j + 1];
    const b0 = Math.max(bulwarkOuterHalfBeam(z, y0) - BULWARK_THICKNESS, 0);
    const b1 = Math.max(bulwarkOuterHalfBeam(z, y1) - BULWARK_THICKNESS, 0);
    const z0 = z - counterRakeShift(z, y0);
    const z1 = z - counterRakeShift(z, y1);
    addQuadFacing(
      out.get('inboardBulwark'),
      inset(v3(-b0, y0, z0), BULWARK_THICKNESS),
      inset(v3(b0, y0, z0), BULWARK_THICKNESS),
      inset(v3(b1, y1, z1), BULWARK_THICKNESS),
      inset(v3(-b1, y1, z1), BULWARK_THICKNESS),
      inward,
      inboardColour,
    );
  }

  // The caprail across the end: a box turning the corner from the two sides.
  const outer = bulwarkOuterHalfBeam(z, topY) + CAPRAIL_OVERHANG;
  /**
   * The rail's inboard edge, forward of its outer one and **level with it**.
   *
   * This was inset along the panel's own normal, which at the transom is tilted
   * back 18 degrees by the counter's rake. That lifted the inboard edge 45 mm
   * and moved it 139 mm forward, so the stern rail was a plank tilted up toward
   * the deck, standing proud of the side rails it meets at both quarters — the
   * step Ash photographed. A rail is a flat plank laid on top of a wall: the
   * rake tilts the wall's *face*, not the timber lying on it.
   *
   * The depth is the same 0.146 the side rail has across its own width — wall
   * plus both overhangs — so the two are one section turning a corner.
   */
  const capDepth = BULWARK_THICKNESS + CAPRAIL_OVERHANG * 2;
  const capFrontZ = placedZ + capDepth * (normal.z < 0 ? 1 : -1);
  // And its height is the sheer's at the station that edge lands on, not the
  // end station's. The rail drops 12 mm over the cap's own depth here, and a
  // flat cap against a falling sheer leaves exactly that as a step at both
  // quarters. `counterStationZ` is what turns "where this edge is" back into
  // "which station that is" — the same inversion the ropes and the walker use.
  const capFrontStation = counterStationZ(capFrontZ, topY);
  const capFront = v3(
    0,
    Number.isFinite(capFrontStation)
      ? segmentBulwarkTopY(
          Math.min(Math.max(capFrontStation, segment.z0), segment.z1),
          segment,
        )
      : topY,
    capFrontZ,
  );
  const capTop = CAPRAIL_THICKNESS;

  const backLo = v3(-outer, topY, placedZ);
  const backHi = v3(outer, topY, placedZ);
  const frontLo = v3(-outer, capFront.y, capFront.z);
  const frontHi = v3(outer, capFront.y, capFront.z);
  const up = (p: Vec3): Vec3 => v3(p.x, p.y + capTop, p.z);

  // Aft (or forward, at the bow) face — the only one this used to draw.
  addQuadFacing(out.get('trim'), backLo, backHi, up(backHi), up(backLo), normal, trimColour());
  // The top of the rail, which is what makes it read as a rail at all.
  addQuadFacing(out.get('trim'), up(backLo), up(backHi), up(frontHi), up(frontLo), v3(0, 1, 0), trimColour());
  // Its underside and its inboard face.
  addQuadFacing(out.get('trim'), backLo, frontLo, frontHi, backHi, v3(0, -1, 0), trimColour());
  addQuadFacing(out.get('trim'), frontLo, frontHi, up(frontHi), up(frontLo), inward, trimColour());
}

/** The stem face closing the finite siding between starboard and port. */
function buildBow(out: RegionBuilders, random: () => number): void {
  buildEndPanel(
    out,
    random,
    HALF_LENGTH,
    BULWARK_SEGMENTS[2],
    v3(0, 0, 1),
    (band) => band.region,
    'topsides',
  );
}

/** The transom: a raked panel closing the after end, with four stern windows. */
function buildTransom(out: RegionBuilders, random: () => number): void {
  const z = -HALF_LENGTH;
  const deck = deckAtSideY(z);

  // The panel's own normal: mostly aft, tilted back by the rake.
  const rake = Math.atan(COUNTER_RAKE_TAN);
  const n = v3(0, -Math.sin(rake), -Math.cos(rake));
  buildEndPanel(
    out,
    random,
    z,
    BULWARK_SEGMENTS[0],
    n,
    () => 'transom',
    'transom',
  );

  // Four stern windows, in two pairs either side of the rudder trunk. The list
  // and the plane are `deckInterior.ts`'s, because the cabin's own lining cuts
  // reveals to exactly these openings — and it was three in a row, one of them
  // on the centreline, until the room reached the transom and the middle one
  // turned out to look at the back of the rudder's casing.
  for (const window of STERN_WINDOWS) {
    const glass = rgbOf(SHIP_PALETTE.base.glazing);
    // **Raked with the transom it is set in.** The panes were flat quads at one
    // z, which was near enough while they were 0.44 m tall; at 0.55 m on an 18°
    // rake the sill and the head are 0.18 m apart in the fore-and-aft, and a
    // flat pane across that stands half proud of the planking and half sunk in.
    const lo = window.y - window.halfHeight;
    const hi = window.y + window.halfHeight;
    out
      .get('glazing')
      .addQuad(
        v3(window.x - window.halfWidth, lo, sternWindowZAt(lo)),
        v3(window.x + window.halfWidth, lo, sternWindowZAt(lo)),
        v3(window.x + window.halfWidth, hi, sternWindowZAt(hi)),
        v3(window.x - window.halfWidth, hi, sternWindowZAt(hi)),
        n,
        glass,
        true,
      );
  }

  // An ochre moulding across the transom under the caprail — the only place
  // section 16 permits ochre besides the rail itself and the bow trim.
  const mouldY = deck - 0.06;
  const mouldB = halfBreadthAt(z, deck);
  const mz = -HALF_LENGTH - counterRakeShift(z, mouldY) + 0.015;
  out
    .get('trim')
    .addQuad(
      v3(-mouldB, mouldY - 0.05, mz),
      v3(mouldB, mouldY - 0.05, mz),
      v3(mouldB, mouldY + 0.05, mz),
      v3(-mouldB, mouldY + 0.05, mz),
      n,
      jitter(rgbOf(SHIP_PALETTE.base.trim), random, 0.03),
      true,
    );
}

/** Keel, forefoot, deadwood and stem — the timber `backbone.ts` describes. */
function buildBackbone(out: RegionBuilders, random: () => number): void {
  sweepSlab(
    out,
    random,
    longitudinalSamples(-HALF_LENGTH, HALF_LENGTH, LONGITUDINAL_SAMPLES),
    (z) => backboneBottomY(z),
    (z) => backboneTopY(z),
    (z) => backboneSiding(z) / 2,
  );
}

/** The rudder blade, hung on the after face of the sternpost. */
function buildRudder(out: RegionBuilders, random: () => number): void {
  const RUDDER_HALF_THICKNESS = 0.07;
  sweepSlab(
    out,
    random,
    longitudinalSamples(-HALF_LENGTH, -6.6, 18),
    () => rudderBottomY(),
    (z) => rudderTopY(z),
    () => RUDDER_HALF_THICKNESS,
  );
}

// --- below decks --------------------------------------------------------------

/** Moulded siding of a deck beam, metres. */
const DECK_BEAM_SIDING = 0.11;

/** Nominal spacing of the beams overhead, metres. */
const DECK_BEAM_SPACING = 0.52;

/** Rows up a room's side lining, sole to deckhead. */
const SIDE_ROWS = 6;

/** Columns across a room, port to starboard. */
const ROOM_COLS = 8;

/**
 * Below decks, as four rooms on three floors.
 *
 * Soles, deckheads and beams, the ship's sides, the four bulkheads with their
 * doorways, the steps between the levels, the companion ladder and its coaming,
 * the transom lining with the stern windows in it, the rudder trunk, and the
 * boards over the platform's hatchway. **No furniture**: `docs/ship/SHIP_SPEC.md`
 * section 9 asks for a berth, a chart desk, a stern bench, a gimballed lantern
 * and the rest, and `docs/ship/SHIP_BELOW_DECKS_PLAN.md` section 7 says in terms
 * that the blocks inside the rooms are indicative and want Ash's eye once the
 * rooms are standing. What is here is the *volume*.
 *
 * Every surface is asked of `deckInterior.ts`, which is asked of
 * `deckSurface.ts`. The walker stands on exactly these numbers.
 */
function buildBelowDecks(out: RegionBuilders, random: () => number): void {
  for (const space of BELOW_DECKS_SPACES) {
    buildSpaceSole(out, random, space);
    buildSpaceDeckhead(out, random, space);
    buildSpaceSides(out, random, space);
  }
  buildUnderFloorLining(out, random);
  buildHoldStructure(out, random);
  buildSternLining(out, random);
  buildRudderTrunk(out, random);
  buildInteriorBulkheads(out, random);
  buildInteriorStepFlights(out, random);
  buildCompanionLadder(out, random);
  buildCompanionCoaming(out, random);
  for (const opening of DECK_OPENINGS) buildOpeningLining(out, random, opening);
}

/** Stations across a room, at the loft's own spacing plus both bulkheads. */
function spaceSamples(z0: number, z1: number): number[] {
  const inner = hullSamplesBetween(z0, z1).filter((z) => z > z0 + 1e-6 && z < z1 - 1e-6);
  return [z0, ...inner, z1];
}

/**
 * The opening through the deck over a room, if it has one.
 *
 * **Inclusive at the room's own bulkheads**, and this is the third place the
 * same millimetre has bitten. The companionway reaches the quarterdeck break,
 * which is also the landing's forward bulkhead, so a strict `<` said the
 * landing had no opening at all — and everything downstream believed it. The
 * deckhead was lofted across the shaft and the deck beams were spaced *through*
 * it rather than clear of it, which is what Ash saw as rafters in the way of
 * the way down.
 *
 * The pattern is worth naming since it has now cost three separate faults: a
 * bound written for a feature in the *middle* of a thing is silently wrong for
 * one that reaches its edge, and nothing about the symptom points at the bound.
 */
function spaceOpening(space: BelowDecksSpace): DeckOpening | null {
  return (
    DECK_OPENINGS.find((o) => o.zAft >= space.zAft && o.zForward <= space.zForward) ?? null
  );
}

/**
 * Where a hook can be screwed to a deck beam over a space: the nearest beam
 * to `nearZ` that carries timber AT THIS `x`, and its underside there.
 *
 * Mirrors the beam loop in `buildSpaceDeckhead` exactly — same count, same
 * stations, same opening and carling-gap tests — and the underside is
 * `addDeckBeam`'s own soffit: planking top minus the moulded depth. A lamp
 * hung from this lands on drawn timber, and a re-spaced deckhead carries
 * the hook with it, the same reasoning that ties the davit's foot to
 * `walkingDeckY`.
 *
 * The gap test is per-x, not per-beam, and that distinction cost a metre:
 * a beam crossing a hatchway is **interrupted, not deleted** — it stops at
 * the carlings and carries on to the ship's side. Rejecting the whole beam
 * pushed a lamp Ash had marked on real timber a full beam bay aft. Only
 * the carling gap itself is air.
 */
export function deckBeamHangPoint(
  space: BelowDecksSpace,
  x: number,
  nearZ: number,
): { z: number; y: number } | null {
  const opening = spaceOpening(space);
  const span = space.zForward - space.zAft;
  const count = Math.max(2, Math.round(span / DECK_BEAM_SPACING));
  let best: { z: number; y: number } | null = null;
  for (let i = 1; i < count; i++) {
    const z = space.zAft + (span * i) / count;
    const crossesOpening =
      opening !== null &&
      z > opening.zAft - DECK_BEAM_SIDING &&
      z < opening.zForward + DECK_BEAM_SIDING;
    if (crossesOpening && opening) {
      // The carlings' own widened gap, exactly as `addDeckBeam` cuts it.
      const limits = openingXLimits(opening, z);
      if (x > limits.xLo - DECK_BEAM_SIDING && x < limits.xHi + DECK_BEAM_SIDING) {
        continue;
      }
    }
    if (spaceRoofHalfWidthAt(space, z) <= 0) continue;
    const top = spacePlankingY(space, x, z);
    if (top === null) continue;
    const y = top - (DECK_BEAM_DEPTH - DECK_PLANK_THICKNESS);
    if (best === null || Math.abs(z - nearZ) < Math.abs(best.z - nearZ)) {
      best = { z, y };
    }
  }
  return best;
}

/**
 * A sole: flat, because a sole is laid level while the deck over it is not.
 *
 * **With a hole in it where a well is cut**, drawn the same way
 * `buildSpaceDeckhead` draws round a deck opening: full-width panels clear of
 * the well, and two strips beside it that carry every station between its ends
 * rather than a chord across them. The reason is the one that section already
 * records — a chord under a curved ship's side leaves a slot of daylight that
 * is invisible as geometry and perfectly visible as a hard line.
 */
function buildSpaceSole(out: RegionBuilders, random: () => number, space: BelowDecksSpace): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorSole);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorSole;

  /**
   * One patch of floor — **drawn from both sides.**
   *
   * A sole used to be a single sheet wound to face up, and from underneath it
   * was not there: Ash, ducked in the hold, *"can't see the floor of the
   * wardroom at all... it appears like the floor disappears."* He is right, and
   * it is the fault this ship keeps finding for the sixth time — **a one-sided
   * surface reads as transparency, not as a solid.** A raycast up from the hold
   * went through the platform at 1.80 and hit the wardroom's own deckhead at
   * 3.87.
   *
   * It cost nothing while nobody could be under a sole. The hold is the first
   * space below one that a body can occupy, and the first thing that changes
   * when a floor gets a room under it is that its underside becomes real.
   *
   * **Both faces come off the same rows**, offset by the planking's thickness
   * and wound the other way. That is deliberate rather than tidy: the openings
   * cut in this surface are worked out once, below, and an underside built by a
   * second pass over a second copy of that list is a second chance to disagree
   * about where the hatchway is.
   */
  const addPanel = (
    rows: readonly number[],
    uFrom: (z: number) => number,
    uTo: (z: number) => number,
  ): void => {
    const top: Vec3[][] = [];
    const under: Vec3[][] = [];
    const topN: Vec3[][] = [];
    const underN: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (const z of rows) {
      const w = spaceHalfWidthAt(space, z);
      if (w <= 0) continue;
      const u0 = uFrom(z);
      const u1 = uTo(z);
      if (u1 - u0 <= 1e-6) continue;
      const rowT: Vec3[] = [];
      const rowU: Vec3[] = [];
      const rowTN: Vec3[] = [];
      const rowUN: Vec3[] = [];
      const rowC: Rgb[] = [];
      for (let j = 0; j <= ROOM_COLS; j++) {
        const u = u0 + ((u1 - u0) * j) / ROOM_COLS;
        rowT.push(v3(u * w, space.soleY, z));
        rowU.push(v3(u * w, space.soleY - DECK_PLANK_THICKNESS, z));
        rowTN.push(v3(0, 1, 0));
        rowUN.push(v3(0, -1, 0));
        rowC.push(jitter(colour, random, jitterAmount));
      }
      top.push(rowT);
      under.push(rowU);
      topN.push(rowTN);
      underN.push(rowUN);
      colours.push(rowC);
    }
    // Unflipped. Rows run forward and columns run to port, so `addGrid`'s
    // a->b->c winding crosses +z into +x and comes out +y, which is what a floor
    // wants. Derived rather than tried: this is the *fourth* time on this ship
    // that a winding taken from an argument that sounded right has come out
    // inverted, and the fourth time `ship-geometry.test.ts` has been what said so.
    if (top.length > 1) {
      out.get('interiorSole').addGrid(top, topN, colours, false);
      // The underside is the same sheet seen from the other hand, so its
      // winding is the mirror. It goes in the lining's region rather than the
      // sole's: the top of a sole is scrubbed planking and the underside is
      // bare joinery nobody has ever holystoned, which is the same distinction
      // `deckFittingGeometry.ts` makes between a deck and the fittings on it.
      out.get('interiorLining').addGrid(under, underN, colours, true);
    }
  };

  // The captain's floorcloth lies on this sole, 4 mm up, in the sole's own
  // region: it is a floor you walk on and it is lit as one.
  //
  // **Once per room, and not once per panel.** The obvious home for this was
  // inside `addPanel` beside the planking it lies on — where it would have been
  // right, silently, for exactly as long as the cabin has no hole in its floor.
  // The wardroom is laid in five panels because it has two; the day anybody cuts
  // a well or a scuttle into this room, a call in there draws the whole cloth
  // once per piece of surviving floor, all of it coplanar. Coincident painted
  // cloth is not a subtle failure, but it is a distant one from its cause.
  if (space.name === 'cabin') addCabinFloorcloth(out.get('interiorSole'), random);

  const zs = spaceSamples(space.zAft, space.zForward);
  const uAt = (z: number, x: number): number => {
    const w = spaceHalfWidthAt(space, z);
    return w > 1e-6 ? Math.max(-1, Math.min(1, x / w)) : 0;
  };

  /**
   * Every hole in this room's floor.
   *
   * **There can be more than one now, and that is what changed.** The routine
   * below was written for the single steps well and read it straight out of
   * `INTERIOR_STEPS`; the wardroom then turned out to have a second hole that
   * comes from somewhere else entirely — the platform's hatchway, which is a
   * shaft down to the hold rather than a stair.
   *
   * While the boards were merged into this surface the hatchway was not a hole
   * at all: the sole ran across it and six boards were laid on top, so lifting
   * them revealed **solid floor**. That is the failure mode a decorative
   * surface always has — it reads correctly right up until the thing it is
   * standing in for has to do something.
   */
  const cuts: { zAft: number; zForward: number; xLo: number; xHi: number }[] = [];

  const well = INTERIOR_STEPS.find((steps) => steps.farY === space.soleY && steps.sillRun >= 0
    && steps.farY > steps.sillY && stepsRoom(steps) === space);
  if (well) {
    const run = stepsRunLength(well);
    const zNear = well.zTop;
    const zFar = well.zTop + well.direction * run;
    cuts.push({
      zAft: Math.min(zNear, zFar),
      zForward: Math.max(zNear, zFar),
      xLo: well.x - well.halfBreadth,
      xHi: well.x + well.halfBreadth,
    });
  }

  // The hatchway, in whichever room the platform's opening falls in. Read from
  // `HATCHWAY_*` rather than named here, so it stays under the cargo hatch by
  // construction — `SHIP_BELOW_DECKS_PLAN.md` §4.3.1 is emphatic that the two
  // openings are one vertical line and that an earlier draft got it wrong by
  // treating the deck hatch as decoration rather than as the top of a route.
  if (HATCHWAY_AFT_Z >= space.zAft && HATCHWAY_FORWARD_Z <= space.zForward) {
    cuts.push({
      zAft: HATCHWAY_AFT_Z,
      zForward: HATCHWAY_FORWARD_Z,
      xLo: -HATCHWAY_HALF_BREADTH,
      xHi: HATCHWAY_HALF_BREADTH,
    });
  }

  if (cuts.length === 0) {
    addPanel(zs, () => -1, () => 1);
    return;
  }

  cuts.sort((a, b) => a.zAft - b.zAft);
  const unique = (list: number[]): number[] =>
    list.filter((z, i, a) => a.indexOf(z) === i).sort((a, b) => a - b);

  // Walk the room aft to forward, laying full planking between the holes and a
  // strip either side of each one. Every band carries the room's own stations
  // rather than a chord across its ends, which is the rule this file's own
  // comment gives and the one a straight edge under a curved side breaks.
  let z0 = space.zAft;
  for (const cut of cuts) {
    if (cut.zAft > z0 + 1e-6) {
      addPanel(unique([z0, ...zs.filter((z) => z > z0 && z < cut.zAft), cut.zAft]), () => -1, () => 1);
    }
    const beside = unique([
      cut.zAft,
      ...zs.filter((z) => z > cut.zAft && z < cut.zForward),
      cut.zForward,
    ]);
    addPanel(beside, () => -1, (z) => uAt(z, cut.xLo));
    addPanel(beside, (z) => uAt(z, cut.xHi), () => 1);
    z0 = cut.zForward;
  }
  if (space.zForward > z0 + 1e-6) {
    addPanel(unique([z0, ...zs.filter((z) => z > z0), space.zForward]), () => -1, () => 1);
  }
}

/**
 * A deckhead: the underside of the deck overhead, and the beams under that.
 *
 * Two surfaces, not one. The planking's underside carries the deck's camber —
 * it is the same surface the player walks on, 0.05 m lower — and the beams hang
 * 0.13 m below it. That is the whole of `DECK_BEAM_DEPTH`, so the height a head
 * meets is a beam's underside, which is what `spaceClearHeightAt` reports and
 * what the spec's 1.85 m is measured to.
 *
 * The planking is *not* drawn over an opening: that is where the hole is, and a
 * ceiling there would roof the companionway you just came down, or cap the shaft
 * a cask is lowered through.
 */
function buildSpaceDeckhead(
  out: RegionBuilders,
  random: () => number,
  space: BelowDecksSpace,
): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;
  const zs = spaceSamples(space.zAft, space.zForward);

  const addPanel = (
    rows: readonly number[],
    uFrom: (z: number) => number,
    uTo: (z: number) => number,
  ): void => {
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (const z of rows) {
      // The *roof's* half-width, out to where the deck meets the ship's side —
      // not the sole's. The two differ by the lining's thickness, and lofting
      // this to the sole's left a 60 mm slot round the cabin that the sky came
      // through in M4.
      const w = spaceRoofHalfWidthAt(space, z);
      if (w <= 0) continue;
      const u0 = uFrom(z);
      const u1 = uTo(z);
      const rowP: Vec3[] = [];
      const rowN: Vec3[] = [];
      const rowC: Rgb[] = [];
      for (let j = 0; j <= ROOM_COLS; j++) {
        const u = u0 + ((u1 - u0) * j) / ROOM_COLS;
        const x = u * w;
        const y = spacePlankingY(space, x, z);
        if (y === null) break;
        rowP.push(v3(x, y, z));
        // Downward: this is a ceiling, seen from under it.
        rowN.push(v3(0, -1, 0));
        rowC.push(jitter(colour, random, jitterAmount));
      }
      if (rowP.length !== ROOM_COLS + 1) continue;
      points.push(rowP);
      normals.push(rowN);
      colours.push(rowC);
    }
    // Flipped: same row/column sense as the sole, so unflipped points *up*, and
    // this is a ceiling.
    if (points.length > 1) out.get('interiorLining').addGrid(points, normals, colours, true);
  };

  const opening = spaceOpening(space);
  if (!opening) {
    addPanel(zs, () => -1, () => 1);
  } else {
    const holeU = (z: number, side: 1 | -1): number => {
      const w = spaceRoofHalfWidthAt(space, z);
      if (w <= 1e-6) return side;
      const { xLo, xHi } = openingXLimits(opening, z);
      return Math.max(-1, Math.min(1, (side > 0 ? xHi : xLo) / w));
    };
    const unique = (list: number[]): number[] =>
      list.filter((z, i, a) => a.indexOf(z) === i).sort((a, b) => a - b);
    const aft = unique([...zs.filter((z) => z <= opening.zAft), opening.zAft]);
    const forward = unique([opening.zForward, ...zs.filter((z) => z >= opening.zForward)]);
    // **Every station between the coamings, not just the two ends.** The strips
    // beside the opening were lofted from the endpoints alone in M4, and their
    // outboard edge came out a straight chord under a deck that curves — 9 mm of
    // daylight between the chord and the ship's side, which follows the same
    // stations the rest of the loft does. A slot that thin is invisible as
    // geometry and perfectly visible as a hard blue line along the whole length
    // of the room, which is how it was found: by raycasting the pixel, not by
    // reading the code.
    const beside = unique([
      opening.zAft,
      ...zs.filter((z) => z > opening.zAft && z < opening.zForward),
      opening.zForward,
    ]);
    addPanel(aft, () => -1, () => 1);
    addPanel(forward, () => -1, () => 1);
    addPanel(beside, () => -1, (z) => holeU(z, -1));
    addPanel(beside, (z) => holeU(z, 1), () => 1);
  }

  // The beams, athwartships, hung under the planking. Spaced to land clear of
  // any opening rather than through it — a beam across a companionway is a beam
  // you would hit on the way down, and a beam across a cargo hatch is one the
  // cask lands on.
  const span = space.zForward - space.zAft;
  const count = Math.max(2, Math.round(span / DECK_BEAM_SPACING));
  for (let i = 1; i < count; i++) {
    const z = space.zAft + (span * i) / count;
    const crossesOpening =
      opening !== null &&
      z > opening.zAft - DECK_BEAM_SIDING &&
      z < opening.zForward + DECK_BEAM_SIDING;
    // A beam spans the ship, so it runs to the deckhead's edge rather than the
    // sole's — it lands on the shelf where the deck meets the side.
    const w = spaceRoofHalfWidthAt(space, z);
    if (w <= 0) continue;
    addDeckBeam(
      out.get('interiorLining'),
      random,
      colour,
      jitterAmount,
      space,
      z,
      w,
      // Carlings each side of the opening take the interrupted ends. The gap is
      // widened by the beam's own siding so a beam does not clip the coaming it
      // is supposed to stop short of.
      crossesOpening && opening
        ? {
            xLo: openingXLimits(opening, z).xLo - DECK_BEAM_SIDING,
            xHi: openingXLimits(opening, z).xHi + DECK_BEAM_SIDING,
          }
        : null,
    );
  }
}

/** Stations across one beam. Enough that the arc reads as an arc. */
const BEAM_STATIONS = 20;

/**
 * One deck beam, swept along the round of beam.
 *
 * WHAT WAS WRONG WITH IT, AND WHY IT MATTERED
 * -------------------------------------------
 * This was eight axis-aligned boxes side by side, each with its top set to the
 * deck height at its own midpoint. The reasoning was right — a straight beam
 * under a crowned deck stands proud of it amidships and hangs off it at the
 * sides — and the remedy was a staircase: **a curve drawn as eight steps, read
 * as eight steps.** Ash's first word about the interior was that the beams are
 * jagged.
 *
 * The camber itself was never the problem. The deck crowns 65 mm over a 3.25 m
 * beam, which is 1/4 inch to the foot: the traditional round of beam almost
 * exactly. A period beam is sawn or grown to that arc, sided about 4–5 in and
 * moulded about 5 in, and lands on a clamp at the ship's side. So this sweeps a
 * rectangular section along the deck's own underside at constant moulded depth,
 * which is what such a beam is.
 *
 * The top face is not drawn: it is flush against the planking above it, which is
 * already a surface, and two coincident faces are a z-fight rather than a beam.
 */
function addDeckBeam(
  builder: SurfaceBuilder,
  random: () => number,
  colour: Rgb,
  jitterAmount: number,
  space: BelowDecksSpace,
  z: number,
  halfWidth: number,
  gap: { xLo: number; xHi: number } | null = null,
): void {
  const moulded = DECK_BEAM_DEPTH - DECK_PLANK_THICKNESS;
  const half = DECK_BEAM_SIDING * 0.5;
  const xs: number[] = [];
  const tops: number[] = [];
  for (let i = 0; i <= BEAM_STATIONS; i++) {
    const x = -halfWidth + (2 * halfWidth * i) / BEAM_STATIONS;
    const top = spacePlankingY(space, x, z);
    if (top === null) return;
    xs.push(x);
    tops.push(top);
  }

  const shade = (): Rgb => jitter(colour, random, jitterAmount);
  for (let i = 0; i < BEAM_STATIONS; i++) {
    // **Interrupted at a hatchway, not deleted.** A beam is stopped by the
    // carlings each side of an opening and carries on to the ship's side — an
    // opening 0.84 m wide in a 3.6 m beam does not disqualify the other 2.7 m
    // of timber, and dropping the whole beam is what left the deckhead over the
    // landing with nothing under it wherever the shaft happened to be.
    if (gap && xs[i] >= gap.xLo - 1e-6 && xs[i + 1] <= gap.xHi + 1e-6) continue;
    const [xA, xB] = [xs[i], xs[i + 1]];
    const [tA, tB] = [tops[i], tops[i + 1]];
    const bA = tA - moulded;
    const bB = tB - moulded;
    // The soffit — the face a body below decks actually looks at.
    addQuadFacing(
      builder,
      v3(xA, bA, z - half),
      v3(xB, bB, z - half),
      v3(xB, bB, z + half),
      v3(xA, bA, z + half),
      v3(0, -1, 0),
      shade(),
    );
    // And the two sides, which is what gives a beam its depth in a raking light.
    for (const side of [-1, 1] as const) {
      addQuadFacing(
        builder,
        v3(xA, bA, z + side * half),
        v3(xB, bB, z + side * half),
        v3(xB, tB, z + side * half),
        v3(xA, tA, z + side * half),
        v3(0, 0, side),
        shade(),
      );
    }
  }

  // The ends, where the beam runs into the ship's side. Small, and the lining is
  // usually over them — but an unclosed sweep is an open-ended surface, and this
  // ship has been bitten four times by an open-ended surface reading as
  // transparency rather than as a hole.
  for (const [index, side] of [[0, -1] as const, [BEAM_STATIONS, 1] as const]) {
    const x = xs[index];
    const top = tops[index];
    addQuadFacing(
      builder,
      v3(x, top - moulded, z - half),
      v3(x, top - moulded, z + half),
      v3(x, top, z + half),
      v3(x, top, z - half),
      v3(side, 0, 0),
      shade(),
    );
  }
}

/**
 * The ship's sides, from the sole up to the deckhead.
 *
 * **Sampled up the hull's own section rather than run as a chord.** In the
 * cabin the wall leans 0.06 m outboard over its height and a straight line was
 * right; in the forecastle the sections close 0.8 m inboard between the sole and
 * the deck edge, and a chord across that stands up to 0.4 m clear of the
 * planking it is meant to be lining. It is the M4 chord leak in the other axis:
 * that one was solved by sampling the loft's own stations, and this one by
 * sampling its own waterlines.
 *
 * It is the ceiling planking — the *inside* lining of the frames, which is what
 * "ceiling" means on a ship and is exactly the wrong word here, so the region is
 * `interiorLining`.
 */
function buildSpaceSides(
  out: RegionBuilders,
  random: () => number,
  space: BelowDecksSpace,
): void {
  const liningColour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const liningJitter = SHIP_PALETTE.jitterAmount.interiorLining;
  const bulwarkColour = rgbOf(SHIP_PALETTE.base.inboardBulwark);
  const bulwarkJitter = SHIP_PALETTE.jitterAmount.inboardBulwark;

  /** One uninterrupted patch of side lining. */
  const addPanel = (
    side: 1 | -1,
    zs: readonly number[],
    bulwarkContinuation = false,
  ): void => {
    const builder = out.get(bulwarkContinuation ? 'inboardBulwark' : 'interiorLining');
    const colour = bulwarkContinuation ? bulwarkColour : liningColour;
    const jitterAmount = bulwarkContinuation ? bulwarkJitter : liningJitter;
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (const z of zs) {
      const roof = spaceRoofHalfWidthAt(space, z);
      if (roof <= 0) continue;
      const deckEdgeX = bulwarkContinuation
        ? companionXLimits(z).xHi + COMPANION_OUTBOARD_CLEARANCE
        : null;
      // Ordinary ceiling planking meets the deckhead at the roof edge. Along
      // the port-side companionway the bulwark is the outboard coaming. That
      // exposed wall therefore terminates on the bulwark's *actual inner edge*,
      // not on the 20 mm-inset edge of the deck cut.
      const top = deckEdgeX === null
        ? spacePlankingY(space, side * roof, z)
        : deckStandAt(deckEdgeX, z)?.y ?? null;
      if (top === null) continue;
      const ys: number[] = [];
      const ws: number[] = [];
      for (let j = 0; j <= SIDE_ROWS; j++) {
        ys.push(space.soleY + ((top - space.soleY) * j) / SIDE_ROWS);
      }
      for (const y of ys) {
        ws.push(visibleSpaceSideHalfWidthAt(space, side, z, y, y === top));
      }
      const rowP: Vec3[] = [];
      const rowN: Vec3[] = [];
      const rowC: Rgb[] = [];
      for (let j = 0; j < ys.length; j++) {
        // The inward normal of a wall whose half-width varies with height is
        // (−1, dw/dy) on the port hand. Left at (−1, 0) the forecastle's 19° of
        // lean would be lit as if it were plumb.
        const j0 = Math.max(j - 1, 0);
        const j1 = Math.min(j + 1, ys.length - 1);
        const dy = ys[j1] - ys[j0];
        const slope = Math.abs(dy) > 1e-9 ? (ws[j1] - ws[j0]) / dy : 0;
        const len = Math.hypot(1, slope);
        rowP.push(v3(side * ws[j], ys[j], z));
        // `buildBulwarks` shades its inner planking with a straight inboard
        // normal. Match it at the shared row so the continuation is one finish
        // rather than two differently-lit surfaces meeting at the deck.
        rowN.push(
          bulwarkContinuation
            ? v3(-side, 0, 0)
            : v3(-side / len, slope / len, 0),
        );
        rowC.push(jitter(colour, random, jitterAmount));
      }
      points.push(rowP);
      normals.push(rowN);
      colours.push(rowC);
    }
    if (points.length > 1) {
      // Rows run forward, columns run upward, so unflipped crosses to -x. The
      // port wall (side +1) faces inboard, which *is* -x, so port is unflipped
      // and starboard is the mirror.
      builder.addGrid(points, normals, colours, side < 0);
    }
  };

  for (const side of [1, -1] as const) {
    if (space.name !== 'landing' || side < 0) {
      addPanel(side, spaceSamples(space.zAft, space.zForward));
      continue;
    }

    // The whole port wall of the landing is one continuation of the bulwark,
    // including the short landing abaft the flight. Ending that finish at the
    // opening's after bound created a dark vertical jamb between two profiles
    // in the middle of an otherwise uninterrupted ship side. The cabin
    // bulkhead is the real place this wall ends; no invented seam is needed.
    addPanel(side, spaceSamples(space.zAft, space.zForward), true);
    buildLandingWardroomSideReturn(out, random, space);
    buildLandingWaistBulwarkReturn(out, random, space);
  }
}

/**
 * The landing's port wall is the continuation of the inboard bulwark, not the
 * ordinary curved ceiling planking used elsewhere. This profile is shared by
 * the wall and every bulkhead edge that lands on it; two independent profiles
 * at that junction leave a narrow view straight through to the sea.
 */
function visibleSpaceSideHalfWidthAt(
  space: BelowDecksSpace,
  side: 1 | -1,
  z: number,
  y: number,
  atDeckhead: boolean,
): number {
  if (space.name !== 'landing' || side < 0) {
    return spaceSideHalfWidthAt(space, z, y, atDeckhead);
  }

  const deckEdgeX = companionXLimits(z).xHi + COMPANION_OUTBOARD_CLEARANCE;
  if (atDeckhead) return deckEdgeX;

  const deck = deckStandAt(deckEdgeX, z);
  if (!deck) {
    throw new Error('Landing bulwark continuation is not founded on deck');
  }
  const top = deck.y;
  const foot = spaceSideHalfWidthAt(space, z, space.soleY, false);
  const t = Math.max(
    0,
    Math.min(1, (y - space.soleY) / Math.max(top - space.soleY, 1e-6)),
  );
  // One fair plane from the room lining to the bulwark. The former casing
  // stood at the deck cut for nearly its whole height and then kicked out over
  // the last beam depth. The shared line stays inside the shell at the sole and
  // reaches the exact bulwark vertex at deck level.
  return foot + (deckEdgeX - foot) * t;
}

/**
 * Close the landing wall into the wardroom lining below the waist deck.
 *
 * The companion opening deliberately leaves the upper port part of the
 * wardroom's after bulkhead open above the top tread: that is where the flight
 * passes up to the waist. The panel below now reaches that tread — also the
 * wardroom deckhead — so the room itself is fully partitioned. At the
 * *outboard* edge of the opening, the two rooms still need a side jamb. The
 * landing uses its fair bulwark-continuation profile there while the wardroom
 * uses the ordinary shell lining; those profiles differ by about 30 mm at eye
 * height. With no return between them a ray from the wardroom passed through
 * that strip, through the back face of the topsides, and on to the ocean.
 */
function buildLandingWardroomSideReturn(
  out: RegionBuilders,
  random: () => number,
  space: BelowDecksSpace,
): void {
  const z = space.zForward;
  if (Math.abs(z - QUARTERDECK_FORWARD_Z) > 1e-6) return;

  const wardroom = belowDecksSpace('wardroom');
  const waist = DECK_LEVELS.find((level) => level.name === 'waist');
  if (!waist) throw new Error('Landing side return cannot find the waist deck');
  const yLo = space.soleY;
  const yHi = levelWalkingY(z, waist);
  const builder = out.get('interiorLining');
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;

  const pointPair = (y: number): [Vec3, Vec3] => {
    const landingX = visibleSpaceSideHalfWidthAt(space, 1, z, y, false);
    const wardroomX = Math.max(
      landingX,
      spaceSideHalfWidthAt(wardroom, z, y, false),
    );
    return [v3(landingX, y, z), v3(wardroomX, y, z)];
  };

  for (let i = 0; i < SIDE_ROWS; i++) {
    const y0 = yLo + ((yHi - yLo) * i) / SIDE_ROWS;
    const y1 = yLo + ((yHi - yLo) * (i + 1)) / SIDE_ROWS;
    const [landing0, wardroom0] = pointPair(y0);
    const [landing1, wardroom1] = pointPair(y1);
    if (
      Math.abs(wardroom0.x - landing0.x) < 1e-7 &&
      Math.abs(wardroom1.x - landing1.x) < 1e-7
    ) {
      continue;
    }
    const shade = jitter(colour, random, jitterAmount);
    addQuadFacing(
      builder,
      landing0,
      wardroom0,
      wardroom1,
      landing1,
      v3(0, 0, 1),
      shade,
    );
    addQuadFacing(
      builder,
      landing1,
      wardroom1,
      wardroom0,
      landing0,
      v3(0, 0, -1),
      shade,
    );
  }
}

/**
 * Close the forward end of the landing wall into the waist bulwark.
 *
 * At the quarterdeck break the waist bulwark begins on the lower deck while
 * the landing wall rises to the raised deck. Their upper vertices meet, but
 * their profiles differ below that: the bulwark tumbles home and the landing
 * wall is the fair plane down to the sole. Without this narrow return, a ray
 * from the waist passes between them and lands on the main channel plank on the
 * outside of the hull — the apparently wooden "gap" reported from the deck.
 */
function buildLandingWaistBulwarkReturn(
  out: RegionBuilders,
  random: () => number,
  space: BelowDecksSpace,
): void {
  const z = space.zForward;
  if (Math.abs(z - QUARTERDECK_FORWARD_Z) > 1e-6) return;

  const waist = DECK_LEVELS.find((level) => level.name === 'waist');
  if (!waist) throw new Error('Landing return cannot find the waist deck');
  const yLo = levelWalkingY(z, waist);
  const deckEdgeX = companionXLimits(z).xHi + COMPANION_OUTBOARD_CLEARANCE;
  const highDeck = deckStandAt(deckEdgeX, z);
  if (!highDeck) throw new Error('Landing return is not founded on the quarterdeck');
  const yHi = highDeck.y;
  const builder = out.get('inboardBulwark');
  const colour = rgbOf(SHIP_PALETTE.base.inboardBulwark);
  const jitterAmount = SHIP_PALETTE.jitterAmount.inboardBulwark;

  const pointPair = (y: number): [Vec3, Vec3] => {
    const landingX = visibleSpaceSideHalfWidthAt(space, 1, z, y, false);
    // Once the two profiles cross near the raised deck, the landing wall is
    // already inside the bulwark solid. Clamp there rather than turning the
    // final strip back on itself.
    const waistInnerX = Math.max(
      landingX,
      bulwarkOuterHalfBeam(z, y) - BULWARK_THICKNESS,
    );
    return [v3(landingX, y, z), v3(waistInnerX, y, z)];
  };

  for (let i = 0; i < SIDE_ROWS; i++) {
    const y0 = yLo + ((yHi - yLo) * i) / SIDE_ROWS;
    const y1 = yLo + ((yHi - yLo) * (i + 1)) / SIDE_ROWS;
    const [landing0, waist0] = pointPair(y0);
    const [landing1, waist1] = pointPair(y1);
    if (
      Math.abs(waist0.x - landing0.x) < 1e-7 &&
      Math.abs(waist1.x - landing1.x) < 1e-7
    ) {
      continue;
    }
    const shade = jitter(colour, random, jitterAmount);
    addQuadFacing(
      builder,
      landing0,
      waist0,
      waist1,
      landing1,
      v3(0, 0, 1),
      shade,
    );
    addQuadFacing(
      builder,
      landing1,
      waist1,
      waist0,
      landing0,
      v3(0, 0, -1),
      shade,
    );
  }
}

/**
 * The cabin's after wall: the transom, lined, with the four stern lights in it.
 *
 * **The lining follows the transom now.** It was plumb — at the transom's own
 * station taken down at the sole — and the argument for that was that a lining
 * which leaned would put the room's ceiling out over a wedge of counter with no
 * floor under it. True, and the wedge is roofed here instead, because the price
 * of the plumb wall turned out to be the windows: the reveal from the panelling
 * to the glass grows 0.325 m for every metre of height, so no light could be
 * raised out of the sea's reach without becoming a tunnel. `deckInterior`'s
 * `sternLiningZAt` is the argument in full.
 *
 * So the after end of the cabin is now the counter itself, lined: a raked wall,
 * the ceiling carried aft over it to meet the wall's head, and the two sides of
 * the wedge closed. The lights sit in the rake with a reveal of the lining's own
 * thickness, which is what a stern light looks like from inside.
 */
function buildSternLining(out: RegionBuilders, random: () => number): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;
  const space = belowDecksSpace('cabin');
  const builder = out.get('interiorLining');
  const shade = (): Rgb => jitter(colour, random, jitterAmount);
  const sill = STERN_WINDOWS[0].y - STERN_WINDOWS[0].halfHeight;
  const head = STERN_WINDOWS[0].y + STERN_WINDOWS[0].halfHeight;
  /**
   * Bury the wall's perimeter in the neighbouring lining by one lining depth.
   *
   * The wall, wedge sides, sole and deckhead describe the same curved joins but
   * do not share every intermediate vertex. Meeting on a zero-width edge thus
   * left 19--37 mm slots between their different chords. An actual lining is
   * landed behind the adjacent board, not balanced edge-on against it; this
   * overlap models that joint and makes the raster seal independent of either
   * surface's tessellation. Window edges remain exact and are not overlapped.
   */
  const sealOverlap = CABIN_LINING_THICKNESS;
  /**
   * The deck's underside over a point of the wedge — **at that point.**
   *
   * Taken once on the centreline first, which is the crown and 60 mm higher
   * than the deck edge, so the wall, the wedge's ceiling and its sides all
   * finished proud of the room's own deckhead and left four hairlines of sky in
   * the after corners. The deck is cambered; anything that lands on it has to
   * ask where it is standing. That is the same sentence as the bulkhead tops
   * and as the beams, in the third place this round.
   */
  const deckheadAt = (x: number, z: number): number => {
    const over = deckOverheadAt(x, z);
    return over ? over.y - DECK_PLANK_THICKNESS : head + 1;
  };
  const deckhead = deckheadAt(0, space.zAft);

  /**
   * Half-width of the after wall at a height — **and the deck-edge exception.**
   *
   * Everything below decks runs to the shell less the lining, except its top
   * row, which runs to the deck's own edge because that is where the deckhead
   * ends and the two have to be one x. The side lining and the bulkheads both
   * already say so; this wall did not, and it cost two hard triangles of
   * daylight up in the after corners where it met them.
   */
  const wallHalfWidth = (y: number, atDeckhead: boolean): number =>
    atDeckhead ? roofHalfWidthAt(sternLiningZAt(y)) : sternLiningHalfWidthAt(y);

  /** A point on the raked wall, with its outer edge buried behind the sides. */
  const wall = (u: number, y: number, atDeckhead = false): Vec3 =>
    v3(u * (wallHalfWidth(y, atDeckhead) + sealOverlap), y, sternLiningZAt(y));

  // The wall's own normal leans with it: mostly forward, tipped up by the rake.
  const rake = Math.atan(COUNTER_RAKE_TAN);
  const inward = v3(0, Math.sin(rake), Math.cos(rake));

  /** A full-width band of the raked wall between two heights. */
  const addBand = (yLo: number, yHi: number): void => {
    if (yHi - yLo <= 1e-6) return;
    const ROWS = 4;
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (let j = 0; j <= ROOM_COLS; j++) {
      const u = (j / ROOM_COLS) * 2 - 1;
      const column: Vec3[] = [];
      const cn: Vec3[] = [];
      const cc: Rgb[] = [];
      const toDeckhead = yHi >= deckhead - 1e-6;
      const top = toDeckhead ? deckheadAt(u * wallHalfWidth(yHi, true), sternLiningZAt(yHi)) : yHi;
      for (let i = 0; i <= ROWS; i++) {
        const y = yLo + ((top - yLo) * i) / ROWS;
        column.push(wall(u, y, i === ROWS && toDeckhead));
        cn.push(inward);
        cc.push(shade());
      }
      points.push(column);
      normals.push(cn);
      colours.push(cc);
    }
    // Rows run to port and columns run upward, so unflipped crosses to +z —
    // which is the way this wall faces, into the room.
    builder.addGrid(points, normals, colours, false);
  };

  addBand(space.soleY, sill);
  addBand(head, deckhead);

  // Separate skirts preserve the wall bands' existing chords while carrying
  // their perimeter behind the sole and deckhead. Folding the overlap into a
  // band's row spacing moved its first chord across the raked-wall kink at the
  // sole — exactly the sort of tessellation-dependent seal this is removing.
  const addHorizontalSeal = (edge: 'foot' | 'head'): void => {
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (let j = 0; j <= ROOM_COLS; j++) {
      const u = (j / ROOM_COLS) * 2 - 1;
      const baseY = edge === 'foot'
        ? space.soleY
        : deckheadAt(u * wallHalfWidth(deckhead, true), sternLiningZAt(deckhead));
      const buriedY = baseY + (edge === 'foot' ? -sealOverlap : sealOverlap);
      points.push([
        wall(u, baseY, edge === 'head'),
        wall(u, buriedY, edge === 'head'),
      ]);
      normals.push([inward, inward]);
      colours.push([shade(), shade()]);
    }
    builder.addGrid(points, normals, colours, edge === 'foot');
  };
  addHorizontalSeal('foot');
  addHorizontalSeal('head');

  // The joinery on the wall: the dado, the fields, the architraves and the
  // cornice. Drawn after the ground it stands on and into the same builder, so
  // it is one mesh, one material and one lighting bake with the lining — which
  // is what it is in the ship, too. `cabinJoinery.ts` says why it cannot be a
  // fitting: everything on this wall leans 18° and a `FittingSolid` box cannot.
  addSternPanelling(builder, shade);

  // The window band: piers of lining between the openings and out to the ship's
  // side. Each is a panel of the raked wall, so its two corners at the sill and
  // its two at the head are 0.18 m apart fore and aft.
  const edges: number[] = [-1];
  for (const window of STERN_WINDOWS) {
    edges.push(window.x - window.halfWidth, window.x + window.halfWidth);
  }
  edges.push(1);
  edges.sort((a, b) => a - b);
  for (let i = 0; i < edges.length - 1; i += 2) {
    const [x0, x1] = [edges[i], edges[i + 1]];
    if (x1 - x0 <= 1e-4) continue;
    // The two ends of the run are the ship's side, and take the wall's own
    // half-width at each height rather than a fixed x.
    const at = (x: number, y: number): Vec3 => {
      const w = wallHalfWidth(y, false);
      return v3(
        Math.abs(x) > 1 - 1e-9 ? Math.sign(x) * (w + sealOverlap) : x,
        y,
        sternLiningZAt(y),
      );
    };
    addQuadFacing(
      builder,
      at(x0, sill),
      at(x1, sill),
      at(x1, head),
      at(x0, head),
      inward,
      shade(),
    );
  }

  // The reveals: four short returns from the lining to the glass. They are the
  // lining's own thickness deep now rather than half a metre.
  for (const window of STERN_WINDOWS) {
    const x0 = window.x - window.halfWidth;
    const x1 = window.x + window.halfWidth;
    const y0 = window.y - window.halfHeight;
    const y1 = window.y + window.halfHeight;
    const face = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3): void =>
      addQuadFacing(builder, a, b, c, d, normal, shade());
    const inner = (x: number, y: number): Vec3 => v3(x, y, sternLiningZAt(y));
    const glass = (x: number, y: number): Vec3 => v3(x, y, sternWindowZAt(y));
    face(inner(x0, y0), inner(x1, y0), glass(x1, y0), glass(x0, y0), v3(0, 1, 0));
    face(inner(x0, y1), inner(x1, y1), glass(x1, y1), glass(x0, y1), v3(0, -1, 0));
    face(inner(x0, y0), inner(x0, y1), glass(x0, y1), glass(x0, y0), v3(1, 0, 0));
    face(inner(x1, y0), inner(x1, y1), glass(x1, y1), glass(x1, y0), v3(-1, 0, 0));
  }

  // The wedge the rake opens up, roofed and closed at the sides. Without these
  // the room simply ends in mid-air above the sole's own after edge — which is
  // the open-ended-surface fault this ship keeps finding, and the reason the
  // plumb wall was chosen in the first place.
  const zSole = space.zAft;
  const zHead = sternLiningZAt(deckhead);
  if (zHead < zSole - 1e-4) {
    const STEPS = 4;
    /**
     * The wedge's own upper edge, where its ceiling meets its two sides.
     *
     * **One polyline, read by both.** They were parametrised separately — the
     * ceiling stepping z from the sole's station to the wall's, the sides
     * stepping y from the sole to a top of their own — and two different walks
     * between the same corners left a hairline of sky in each after corner. The
     * ship has now been bitten by that in five places this round; it is always
     * two curves through shared endpoints, and it is always fixed by making one
     * of them read the other.
     */
    const wedgeEdge = (along: number): { halfWidth: number; y: number; z: number } => {
      const z = zHead + (zSole - zHead) * along;
      const halfWidth = roofHalfWidthAt(z);
      return { halfWidth, y: deckheadAt(halfWidth, z), z };
    };

    // The ceiling over the wedge, carried aft from where the room's own
    // deckhead stops to where the wall's head lands.
    const ceilingPoints: Vec3[][] = [];
    const ceilingNormals: Vec3[][] = [];
    const ceilingColours: Rgb[][] = [];
    for (let j = 0; j <= ROOM_COLS; j++) {
      const u = (j / ROOM_COLS) * 2 - 1;
      const row: Vec3[] = [];
      const rn: Vec3[] = [];
      const rc: Rgb[] = [];
      for (let i = 0; i <= STEPS; i++) {
        const edge = wedgeEdge(1 - i / STEPS);
        const x = u * edge.halfWidth;
        row.push(v3(x, deckheadAt(x, edge.z), edge.z));
        rn.push(v3(0, -1, 0));
        rc.push(shade());
      }
      ceilingPoints.push(row);
      ceilingNormals.push(rn);
      ceilingColours.push(rc);
    }
    // Flipped: rows run to port and columns run aft, so unflipped points *up*,
    // and this is a ceiling. `ship-geometry.test.ts` is what said so — the fifth
    // time on this ship that a winding taken from an argument that sounded right
    // has come out inverted, and the fifth time that test has been what caught it.
    builder.addGrid(ceilingPoints, ceilingNormals, ceilingColours, true);

    // And the two sides of it: the counter's own topsides, lined.
    //
    // **Both edges are the neighbouring panel's own polyline, row for row.** The
    // forward column repeats exactly what `buildSpaceSides` lays down at its
    // aftmost station — same `SIDE_ROWS`, same top, same width function — and
    // the aft column is the raked wall's edge. Built with its own row count and
    // its own top it agreed with the side lining only at the two ends and parted
    // between them, which is the M4 chord leak in a third axis: two curves
    // through the same endpoints are not the same curve.
    for (const side of [1, -1] as const) {
      const roofAtSole = spaceRoofHalfWidthAt(space, zSole);
      const topFwd = spacePlankingY(space, side * roofAtSole, zSole) ?? deckhead;
      const topAft = deckheadAt(side * wallHalfWidth(deckhead, true), sternLiningZAt(deckhead));
      const points: Vec3[][] = [];
      const normals: Vec3[][] = [];
      const colours: Rgb[][] = [];
      for (let j = 0; j <= SIDE_ROWS; j++) {
        const t = j / SIDE_ROWS;
        const atDeckhead = j === SIDE_ROWS;
        const row: Vec3[] = [];
        const rn: Vec3[] = [];
        const rc: Rgb[] = [];
        for (let k = 0; k <= STEPS; k++) {
          const along = k / STEPS;
          if (atDeckhead) {
            // The shared edge, verbatim, so the ceiling and this wall are one
            // polyline rather than two that agree at the ends.
            const edge = wedgeEdge(along);
            row.push(v3(side * edge.halfWidth, edge.y, edge.z));
            rn.push(v3(-side, 0, 0));
            rc.push(shade());
            continue;
          }
          const top = topAft + (topFwd - topAft) * along;
          const y = space.soleY + (top - space.soleY) * t;
          const zAftEdge = sternLiningZAt(y);
          const z = zAftEdge + (zSole - zAftEdge) * along;
          const wAft = wallHalfWidth(y, false);
          const wFwd = spaceSideHalfWidthAt(space, zSole, y, false);
          row.push(v3(side * (wAft + (wFwd - wAft) * along), y, z));
          rn.push(v3(-side, 0, 0));
          rc.push(shade());
        }
        points.push(row);
        normals.push(rn);
        colours.push(rc);
      }
      // Rows run upward and columns run forward, so unflipped crosses +y into
      // +z and comes out **+x** — outboard on the port hand. Flipped there and
      // not to starboard.
      builder.addGrid(points, normals, colours, side > 0);
    }
  }
}

/** The boxed casing round the rudder stock, standing in the after end of the cabin. */
function buildRudderTrunk(out: RegionBuilders, random: () => number): void {
  const solid = rudderTrunkSolid();
  addBox(
    out.get('interiorLining'),
    v3(solid.centre.x, solid.centre.y, solid.centre.z),
    v3(solid.half.x, solid.half.y, solid.half.z),
    jitter(rgbOf(SHIP_PALETTE.base.interiorLining), random, 0.03),
  );
}

/**
 * The four bulkheads, each as two faces with the doorway cut through them.
 *
 * Two faces and not one panel: a bulkhead is 0.06 m of timber, and a single
 * one-sided surface would be a wall from one room and a hole from the other.
 * The doorway's reveal — jambs and soffit — closes the gap between them, which
 * is the only edge of the pair that is open.
 */
function buildInteriorBulkheads(out: RegionBuilders, random: () => number): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;
  const builder = out.get('interiorLining');
  const half = BULKHEAD_THICKNESS * 0.5;

  for (const bulkhead of BULKHEADS) {
    const width = bulkheadHalfWidthAt(bulkhead);
    if (width <= 0) continue;
    const foot = bulkheadFootY(bulkhead);
    const door = bulkhead.sillY === null ? 0 : DOORWAY_HALF_BREADTH;
    const headY = doorwayHeadY(bulkhead);
    // The companionway by name — see the twin of this in `deckInterior.ts`.
    // `shaftBottomAt` below is `companionTreadY`, so "the uncovered opening on
    // this bulkhead" was only ever a description of the companionway.
    const shaft = DECK_OPENINGS.find(
      (opening) =>
        opening.name === 'companionway' &&
        Math.min(
          Math.abs(opening.zAft - bulkhead.z),
          Math.abs(opening.zForward - bulkhead.z),
        ) < 1e-6,
    );
    const shaftSpan = shaft ? openingXLimits(shaft, bulkhead.z) : null;
    // The visible cut starts on the flight's actual top tread. It used to stop
    // on the penultimate tread, leaving a 0.25 m band open through the
    // wardroom-facing side of this bulkhead even though the last tread remains
    // wholly abaft it. The real top tread is also the wardroom deckhead at this
    // station: carrying the timber to it seals that room while leaving the
    // taller landing-side ladder exit open above. Collision uses the same datum
    // so the drawn wall and the wall a body steps over cannot disagree.
    const shaftBottomAt = (x: number): number =>
      companionTreadY(COMPANION_TREADS, x);

    // One face, seen from `facing`.
    //
    // **Lofted up the ship's own side, not out to one half-width.** A bulkhead
    // drawn as a rectangle to the room's width *at the sole* is 0.1 m short of
    // the lining at head height, because the hull opens outward as it rises —
    // and a slot that thin, at the join of two panels, is a hard line of daylight
    // the height of the room. That is M4's 60 mm leak in its third place, and the
    // fix is the same one every time: ask the file that owns the edge, at the
    // height the edge is actually at. The top row is the deck edge and the
    // outboard edge is `spaceSideHalfWidthAt`, so this panel and the side lining
    // are one x at every row by construction.
    const ROWS = SIDE_ROWS;

    const addFace = (zFace: number, facing: 1 | -1): void => {
      const normal = v3(0, 0, facing);
      // **Each face reaches its own room's deckhead.** Both used to be lofted
      // to `bulkhead.roof`, the *lower* of the two ceilings — right for the
      // doorway and wrong for the wall. Under the quarterdeck break that left
      // 0.59 m of open air over the whole bulkhead, and from the landing you
      // looked over the top of it at the weather deck and the sky.
      const room = bulkheadRoofOn(bulkhead, facing) ?? bulkhead.roof;
      const topAt = (x: number): number =>
        spacePlankingY(room, x, bulkhead.z) ?? foot + 2;
      const sideAt = (
        side: 1 | -1,
        y: number,
        atDeckhead: boolean,
      ): number =>
        visibleSpaceSideHalfWidthAt(room, side, bulkhead.z, y, atDeckhead);
      // A panel from the ship's side inboard to `inner`, on the given hand.
      const sidePanel = (
        side: 1 | -1,
        inner: number,
        topLimit: ((x: number) => number) | null = null,
      ): void => {
        const COLUMNS = 6;
        const points: Vec3[][] = [];
        const normals: Vec3[][] = [];
        const colours: Rgb[][] = [];
        const edgeX = side * sideAt(side, 0, true);
        for (let j = 0; j <= COLUMNS; j++) {
          const s = j / COLUMNS;
          // **The top of the panel follows the deck it lands on, column by
          // column.** This computed `top` once, at the deck edge, and reused it
          // across the whole panel — so the top edge was a level line under a
          // deck that crowns 53–86 mm to the centreline, and every bulkhead on
          // the ship had a wedge of open sky over it, widest amidships where
          // someone standing in the doorway is looking. Ash saw daylight over
          // the cabin's forward wall and over the forecastle's after one, which
          // is the two ends of the same mistake.
          //
          // The top row's x is known without knowing its y — it is the deck edge
          // blended toward the doorway — so there is no circularity to break:
          // ask the deck for its height *there*.
          const xTop = edgeX + (side * inner - edgeX) * s;
          // **`topAt`, which is this face's own room — not `bulkhead.roof`.**
          // `roof` is deliberately the *lower* of the two ceilings, right for
          // the doorway and wrong for the timber, and this line was still
          // reading it after the rest of the function had been fixed. So the
          // landing-facing panels stopped at the wardroom's 3.72 instead of the
          // landing's 4.27 and left 0.55 m of open air over the bulkhead each
          // side of the door — §10.4's fault, back through the one line that
          // had not been changed with the others.
          const top = Math.min(topAt(xTop), topLimit?.(xTop) ?? Infinity);
          if (top <= foot + 1e-6) continue;
          const rowP: Vec3[] = [];
          const rowN: Vec3[] = [];
          const rowC: Rgb[] = [];
          for (let i = 0; i <= ROWS; i++) {
            const t = i / ROWS;
            const y = foot + (top - foot) * t;
            // A capped panel's last row is the sill of an opening, not the
            // deckhead. Asking for the deckhead width there pushes that row out
            // through the side and makes the sill a triangular black flap.
            const outboard = side * sideAt(
              side,
              y,
              i === ROWS && topLimit === null,
            );
            rowP.push(v3(outboard + (side * inner - outboard) * s, y, zFace));
            rowN.push(normal);
            rowC.push(jitter(colour, random, jitterAmount));
          }
          points.push(rowP);
          normals.push(rowN);
          colours.push(rowC);
        }
        if (points.length > 1) {
          // Rows run inboard and columns run upward. Unflipped that crosses to
          // −z on the port hand and +z on the starboard, so the two faces of one
          // bulkhead take opposite windings on each hand.
          builder.addGrid(points, normals, colours, side * facing > 0);
        }
      };

      /** A full-height inboard panel whose two x edges are fixed carpentry. */
      const panelToDeck = (x0: number, x1: number): void => {
        if (x1 - x0 <= 1e-6) return;
        const COLUMNS = 6;
        const points: Vec3[][] = [];
        const normals: Vec3[][] = [];
        const colours: Rgb[][] = [];
        for (let j = 0; j <= COLUMNS; j++) {
          const x = x0 + ((x1 - x0) * j) / COLUMNS;
          const top = topAt(x);
          const rowP: Vec3[] = [];
          const rowN: Vec3[] = [];
          const rowC: Rgb[] = [];
          for (let i = 0; i <= ROWS; i++) {
            rowP.push(v3(x, foot + ((top - foot) * i) / ROWS, zFace));
            rowN.push(normal);
            rowC.push(jitter(colour, random, jitterAmount));
          }
          points.push(rowP);
          normals.push(rowN);
          colours.push(rowC);
        }
        // Rows run to port and columns upward: +x × +y is +z.
        builder.addGrid(points, normals, colours, facing < 0);
      };

      // A flat strip at fixed x across the doorway: the sill under it and the
      // lintel over it. Both are carpentry rather than hull, so their edges do
      // not follow the section.
      const strip = (x0: number, x1: number, yLo: number, yHi: number): void => {
        if (x1 - x0 <= 1e-6 || yHi <= yLo + 1e-6) return;
        addQuadFacing(
          builder,
          v3(x0, yLo, zFace),
          v3(x1, yLo, zFace),
          v3(x1, yHi, zFace),
          v3(x0, yHi, zFace),
          normal,
          jitter(colour, random, jitterAmount),
        );
      };

      const doorLo = bulkhead.doorX - door;
      const doorHi = bulkhead.doorX + door;
      if (door <= 0 || doorLo <= -width || doorHi >= width) {
        sidePanel(1, 0);
        sidePanel(-1, 0);
        return;
      }

      // The companion exits through the port side of this bulkhead. Keep the
      // full-height timber between the doorway and the companion jamb, then
      // cap the outboard panel at the actual top tread used by collision. That
      // tread is the wardroom deckhead; above it is the way out on the taller
      // landing side, not a wall merely made non-collidable.
      if (
        shaftSpan !== null &&
        shaftSpan.xLo > doorHi + 1e-6 &&
        shaftSpan.xLo < width - 1e-6
      ) {
        panelToDeck(doorHi, shaftSpan.xLo);
        sidePanel(1, shaftSpan.xLo, shaftBottomAt);
      } else {
        sidePanel(1, doorHi);
      }
      sidePanel(-1, -doorLo);
      // Under the sill, where the two floors differ — this is the face the steps
      // come down off.
      if (bulkhead.sillY! > foot + 1e-6) strip(doorLo, doorHi, foot, bulkhead.sillY!);
      // And the lintel over the door, where the room is tall enough to have one.
      //
      // Its *top* follows the deck for the same reason the side panels' does,
      // and it is not negligible here: the wardroom's door is 0.75 m off the
      // centreline, so the camber falls 22 mm across the 0.70 m of opening. A
      // level top edge there leaves the same wedge of sky the panels beside it
      // used to, in the one place a body is looking straight at.
      if (headY !== null) {
        const LINTEL_COLUMNS = 4;
        const points: Vec3[][] = [];
        const normals: Vec3[][] = [];
        const colours: Rgb[][] = [];
        for (let j = 0; j <= LINTEL_COLUMNS; j++) {
          const x = doorLo + ((doorHi - doorLo) * j) / LINTEL_COLUMNS;
          points.push([v3(x, headY, zFace), v3(x, topAt(x), zFace)]);
          normals.push([normal, normal]);
          const shade = jitter(colour, random, jitterAmount);
          colours.push([shade, shade]);
        }
        // Rows run to port and columns run upward, the same sense the starboard
        // side panel takes, so the two agree on which way this face points.
        builder.addGrid(points, normals, colours, facing < 0);
      }
    };

    addFace(bulkhead.z - half, -1);
    addFace(bulkhead.z + half, 1);

    if (shaftSpan !== null) {
      const trim = jitter(colour, random, jitterAmount);
      const xLo = shaftSpan.xLo;
      const xHi = shaftSpan.xHi;
      const yLo = shaftBottomAt(xLo);
      const yHi = shaftBottomAt(xHi);

      // The head ledge is the exposed top of the timber left below the cut.
      // Close it across the bulkhead's thickness so the new opening is a real
      // cut through a volume, not two faces with a transparent edge between.
      addQuadFacing(
        builder,
        v3(xLo, yLo, bulkhead.z - half),
        v3(xHi, yHi, bulkhead.z - half),
        v3(xHi, yHi, bulkhead.z + half),
        v3(xLo, yLo, bulkhead.z + half),
        v3(0, 1, 0),
        trim,
      );

      // And close the inboard jamb up to the lower of the two deckheads. The
      // opening reaches the ship's side, so there is deliberately no matching
      // outboard jamb competing with the continuous bulwark wall.
      const aftRoom = bulkheadRoofOn(bulkhead, -1) ?? bulkhead.roof;
      const forwardRoom = bulkheadRoofOn(bulkhead, 1) ?? bulkhead.roof;
      const jambTop = Math.min(
        spacePlankingY(aftRoom, xLo, bulkhead.z) ?? yLo,
        spacePlankingY(forwardRoom, xLo, bulkhead.z) ?? yLo,
      );
      if (jambTop > yLo + 1e-6) {
        addQuadFacing(
          builder,
          v3(xLo, yLo, bulkhead.z - half),
          v3(xLo, yLo, bulkhead.z + half),
          v3(xLo, jambTop, bulkhead.z + half),
          v3(xLo, jambTop, bulkhead.z - half),
          v3(1, 0, 0),
          trim,
        );
      }
    }

    if (door > 0 && door < width && headY !== null) {
      const sill = bulkhead.sillY!;
      const trim = jitter(colour, random, jitterAmount);
      for (const side of [1, -1] as const) {
        const x = bulkhead.doorX + side * door;
        addQuadFacing(
          builder,
          v3(x, sill, bulkhead.z - half),
          v3(x, sill, bulkhead.z + half),
          v3(x, headY, bulkhead.z + half),
          v3(x, headY, bulkhead.z - half),
          v3(-side, 0, 0),
          trim,
        );
      }
      addQuadFacing(
        builder,
        v3(bulkhead.doorX - door, headY, bulkhead.z - half),
        v3(bulkhead.doorX + door, headY, bulkhead.z - half),
        v3(bulkhead.doorX + door, headY, bulkhead.z + half),
        v3(bulkhead.doorX - door, headY, bulkhead.z + half),
        v3(0, -1, 0),
        trim,
      );
    }
  }
}

/**
 * The steps between the floors, tread by tread — and the well one is cut into.
 *
 * The forecastle's 0.25 m rise is one riser under the walker's step-up, so its
 * face is the bulkhead's own sill piece and there is no tread to draw. Drawing
 * one would be drawing a stair a body walks straight over.
 *
 * The aft flight draws three things: its treads, the flat at the sill it
 * arrives on, and the three cut faces of the sole it is let into. Without the
 * last of those the landing's floor ends in mid-air along the well and you see
 * out through the edge of it — which is the one-sided-surface fault this ship
 * keeps finding, arrived at from a new direction.
 */
function buildInteriorStepFlights(out: RegionBuilders, random: () => number): void {
  const treadColour = rgbOf(SHIP_PALETTE.base.interiorSole);
  const cheekColour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const liningColour = rgbOf(SHIP_PALETTE.base.interiorLining);

  for (const steps of INTERIOR_STEPS) {
    const lowY = stepsLowY(steps);
    const half = steps.halfBreadth;

    for (let index = 1; index <= stepTreadCount(steps); index++) {
      const { zAft, zForward } = stepTreadZ(steps, index);
      const top = stepTreadY(steps, index);
      const COLUMNS = 4;
      for (let j = 0; j < COLUMNS; j++) {
        const x0 = steps.x - half + (2 * half * j) / COLUMNS;
        const x1 = steps.x - half + (2 * half * (j + 1)) / COLUMNS;
        addBox(
          out.get('interiorSole'),
          v3((x0 + x1) * 0.5, (lowY + top) * 0.5, (zAft + zForward) * 0.5),
          v3((x1 - x0) * 0.5, (top - lowY) * 0.5, (zForward - zAft) * 0.5),
          jitter(j === 0 || j === COLUMNS - 1 ? cheekColour : treadColour, random, 0.04),
        );
      }
    }

    // The well: only where the flight is cut *down into* the far room's sole.
    if (steps.farY <= steps.sillY + 1e-6) continue;

    const run = stepsRunLength(steps);
    const zNear = steps.zTop;
    const zFar = steps.zTop + steps.direction * run;
    const wellAft = Math.min(zNear, zFar);
    const wellForward = Math.max(zNear, zFar);
    const thickness = 0.05;

    // The floor of the well, flush with the low room's sole through the door.
    addBox(
      out.get('interiorSole'),
      v3(steps.x, steps.sillY - thickness * 0.5, (wellAft + wellForward) * 0.5),
      v3(half, thickness * 0.5, (wellForward - wellAft) * 0.5),
      jitter(treadColour, random, 0.04),
    );

    // Its two cheeks, standing the full depth of the cut.
    for (const side of [-1, 1] as const) {
      addBox(
        out.get('interiorLining'),
        v3(
          steps.x + side * (half + thickness * 0.5),
          (steps.sillY + steps.farY) * 0.5,
          (wellAft + wellForward) * 0.5,
        ),
        v3(thickness * 0.5, (steps.farY - steps.sillY) * 0.5, (wellForward - wellAft) * 0.5),
        jitter(liningColour, random, 0.04),
      );
    }

    // The far end: the cut edge of the sole, and the last riser with it. The
    // treads stand against this face rather than replacing it, so the 0.217 m
    // between the top tread and the sole is closed by the same piece.
    const endZ = steps.direction > 0 ? wellForward : wellAft;
    addBox(
      out.get('interiorLining'),
      v3(steps.x, (steps.sillY + steps.farY) * 0.5, endZ + steps.direction * thickness * 0.5),
      v3(half + thickness, (steps.farY - steps.sillY) * 0.5, thickness * 0.5),
      jitter(liningColour, random, 0.04),
    );
  }
}

/**
 * The companion ladder: closed tread boards carried by two raking cheeks.
 *
 * This used to be twenty axis-aligned boxes, four abreast on each step, every
 * one running from its tread down to the sole. The result read as a stack of
 * mismatched cupboards: seams across every tread, a saw-toothed solid wall on
 * both sides, and square ends against an opening which follows the hull.
 *
 * A ship's ladder is joinery. Each tread is now one closed, tapered board whose
 * two ends come from the opening at their own stations; the top still uses the
 * walker's exact cambered height. Two closed diagonal cheeks support the flight
 * without filling all of the space beneath it.
 */
function buildCompanionLadder(out: RegionBuilders, random: () => number): void {
  const treadColour = rgbOf(SHIP_PALETTE.base.interiorSole);
  const cheekColour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const builder = out.get('interiorSole');
  const COLUMNS = 8;

  const shadeRows = (points: readonly (readonly Vec3[])[], colour: Rgb): Rgb[][] =>
    points.map((row) => row.map(() => jitter(colour, random, 0.035)));

  const topNormal = (x: number, index: number): Vec3 => {
    const dx = 0.004;
    const slope = (companionTreadY(index, x + dx) - companionTreadY(index, x - dx)) / (2 * dx);
    const length = Math.hypot(1, slope);
    return v3(-slope / length, 1 / length, 0);
  };

  for (let index = 1; index <= COMPANION_TREADS; index++) {
    const { zAft, zForward } = companionTreadZ(index);
    const top: Vec3[][] = [];
    const bottom: Vec3[][] = [];
    const topNormals: Vec3[][] = [];
    const bottomNormals: Vec3[][] = [];
    for (const z of [zAft, zForward]) {
      const { xLo, xHi } = companionXLimits(z);
      const topRow: Vec3[] = [];
      const bottomRow: Vec3[] = [];
      const topNormalRow: Vec3[] = [];
      const bottomNormalRow: Vec3[] = [];
      for (let j = 0; j <= COLUMNS; j++) {
        const x = xLo + ((xHi - xLo) * j) / COLUMNS;
        const y = companionTreadY(index, x);
        const normal = topNormal(x, index);
        topRow.push(v3(x, y, z));
        bottomRow.push(v3(x, y - COMPANION_TREAD_THICKNESS, z));
        topNormalRow.push(normal);
        bottomNormalRow.push(v3(-normal.x, -normal.y, -normal.z));
      }
      top.push(topRow);
      bottom.push(bottomRow);
      topNormals.push(topNormalRow);
      bottomNormals.push(bottomNormalRow);
    }

    builder.addGrid(top, topNormals, shadeRows(top, treadColour), false);
    builder.addGrid(bottom, bottomNormals, shadeRows(bottom, treadColour), true);

    // Aft and forward end grain, segmented to follow the camber without facets
    // that bridge across the curve.
    for (let j = 0; j < COLUMNS; j++) {
      addQuadFacing(
        builder,
        bottom[0][j],
        bottom[0][j + 1],
        top[0][j + 1],
        top[0][j],
        v3(0, 0, -1),
        jitter(treadColour, random, 0.035),
      );
      addQuadFacing(
        builder,
        bottom[1][j],
        top[1][j],
        top[1][j + 1],
        bottom[1][j + 1],
        v3(0, 0, 1),
        jitter(treadColour, random, 0.035),
      );
    }
    for (const [column, facing] of [[0, -1] as const, [COLUMNS, 1] as const]) {
      addQuadFacing(
        builder,
        bottom[0][column],
        top[0][column],
        top[1][column],
        bottom[1][column],
        v3(facing, 0, 0),
        jitter(treadColour, random, 0.035),
      );
    }
  }

  const first = companionTreadZ(1);
  const last = companionTreadZ(COMPANION_TREADS);

  /** A closed, tapered six-faced beam beneath one side of the flight. */
  const addCheek = (outboard: boolean): void => {
    const section = (z: number, index: number) => {
      const { xLo, xHi } = companionXLimits(z);
      const edge = outboard
        ? xHi - COMPANION_CHEEK_EDGE_REVEAL
        : xLo + COMPANION_CHEEK_EDGE_REVEAL;
      const x0 = outboard ? edge - COMPANION_CHEEK_WIDTH : edge;
      const x1 = outboard ? edge : edge + COMPANION_CHEEK_WIDTH;
      const y0 = companionTreadY(index, x0) - COMPANION_TREAD_THICKNESS;
      const y1 = companionTreadY(index, x1) - COMPANION_TREAD_THICKNESS;
      return {
        top0: v3(x0, y0, z),
        top1: v3(x1, y1, z),
        bottom0: v3(x0, y0 - COMPANION_CHEEK_DEPTH, z),
        bottom1: v3(x1, y1 - COMPANION_CHEEK_DEPTH, z),
      };
    };
    const aft = section(first.zAft, 1);
    const forward = section(last.zForward, COMPANION_TREADS);
    const colour = (): Rgb => jitter(cheekColour, random, 0.035);
    addQuadFacing(builder, aft.top0, aft.top1, forward.top1, forward.top0, v3(0, 1, 0), colour());
    addQuadFacing(builder, aft.bottom0, forward.bottom0, forward.bottom1, aft.bottom1, v3(0, -1, 0), colour());
    addQuadFacing(builder, aft.bottom0, aft.top0, forward.top0, forward.bottom0, v3(-1, 0, 0), colour());
    addQuadFacing(builder, aft.top1, aft.bottom1, forward.bottom1, forward.top1, v3(1, 0, 0), colour());
    addQuadFacing(builder, aft.bottom0, aft.bottom1, aft.top1, aft.top0, v3(0, 0, -1), colour());
    addQuadFacing(
      builder,
      forward.bottom0,
      forward.top0,
      forward.top1,
      forward.bottom1,
      v3(0, 0, 1),
      colour(),
    );
  };

  addCheek(false);
  addCheek(true);
}

/**
 * The coaming round the companionway.
 *
 * `companionCoamingSolids()` drawn, so the timber a body is stopped by is the
 * timber it can see.
 */
/**
 * The coaming, as a continuous ribbon rather than as its colliders.
 *
 * **Drawn from the same runs the solids are cut from, but not as those boxes.**
 * The solids are eight butted boxes per run so that each is founded on the deck
 * beneath itself — a coaming drawn as one box meets a sheered, cambered deck
 * along exactly one line, which is the fault Ash reported in both axes. That is
 * right for a collider and wrong for timber: eight boxes butted end to end put
 * a pair of coincident end caps at every joint, and coplanar faces are notches
 * of z-fighting down the top of the rail.
 *
 * So the *drawing* is one strip of quads per face, sharing every vertex along
 * the run. Same stations, same deck query, no seams.
 */
function buildCompanionCoaming(out: RegionBuilders, random: () => number): void {
  // This joinery stands wholly above the weather deck. It deliberately shares
  // the cabin lining's oak colour, but putting it in `interiorLining` also gave
  // it the cabin's 14% sky visibility and excluded it from deck bounce. In
  // noon shade it therefore rendered black beside fully lit stairs. Region is
  // lighting ownership as well as palette ownership, so keep the exterior
  // coaming distinct from the lining below its sill.
  const colour = rgbOf(SHIP_PALETTE.base.deckJoinery);
  const jitterAmount = SHIP_PALETTE.jitterAmount.deckJoinery;
  const builder = out.get('deckJoinery');
  const t = COMPANION_COAMING_THICKNESS;
  const h = COMPANION_COAMING_HEIGHT;
  const STATIONS = 16;

  const run = (
    from: { x: number; z: number },
    to: { x: number; z: number },
    // Which way the run's inner face looks, as a unit vector in plan.
    inward: { x: number; z: number },
    caps: { start: boolean; end: boolean },
  ): void => {
    const inner: Vec3[][] = [];
    const outer: Vec3[][] = [];
    const top: Vec3[][] = [];
    const bottom: Vec3[][] = [];
    for (let i = 0; i <= STATIONS; i++) {
      const s = i / STATIONS;
      const cx = from.x + (to.x - from.x) * s;
      const cz = from.z + (to.z - from.z) * s;
      const iz = cz + inward.z * t * 0.5;
      const oz = cz - inward.z * t * 0.5;
      // The after run terminates against a hull edge that narrows abaft. Its
      // inner and outer corners are therefore founded at different x values.
      // Keeping both at the opening's after-corner x put the outer corner
      // outside the deck query; the old cabin-sole fallback then stretched the
      // underside down nearly two metres into a paper-thin silver blade.
      const ix = Math.min(
        cx + inward.x * t * 0.5,
        companionXLimits(iz).xHi,
      );
      const ox = Math.min(
        cx - inward.x * t * 0.5,
        companionXLimits(oz).xHi,
      );
      // Sample beneath each edge, not beneath the centreline. Reusing the
      // centre height put the inner edge above the cambered deck and the outer
      // edge through it — the hairline seam along both coamings.
      const innerBase = deckStandAt(ix, iz)?.y;
      const outerBase = deckStandAt(ox, oz)?.y;
      if (innerBase === undefined || outerBase === undefined) {
        throw new Error('Companion coaming is not founded on the weather deck');
      }
      const innerBottom = v3(ix, innerBase, iz);
      const outerBottom = v3(ox, outerBase, oz);
      const innerTop = v3(ix, innerBase + h, iz);
      const outerTop = v3(ox, outerBase + h, oz);
      inner.push([innerBottom, innerTop]);
      outer.push([outerBottom, outerTop]);
      top.push([innerTop, outerTop]);
      bottom.push([innerBottom, outerBottom]);
    }
    const shade = (rows: Vec3[][]): Rgb[][] =>
      rows.map((row) => row.map(() => jitter(colour, random, jitterAmount)));

    /**
     * Add a strip, working the flip out rather than being told it.
     *
     * **`addGrid` unflipped points along rowDir × colDir**, and both of those
     * reverse with the run's own direction — so a flag that is right for the
     * after run is inverted for the inboard one. Hardcoding them got 96 faces
     * backwards and `windingAgreement` said so, which is the fifth time on this
     * ship that a winding taken from an argument that sounded right has come
     * out inverted. Derive it from the normal the face is supposed to have and
     * there is no argument to get wrong.
     */
    const strip = (rows: Vec3[][], n: Vec3): void => {
      const a = rows[0][0];
      const b = rows[1][0];
      const c = rows[0][1];
      const rowDir = v3(b.x - a.x, b.y - a.y, b.z - a.z);
      const colDir = v3(c.x - a.x, c.y - a.y, c.z - a.z);
      const cross = v3(
        rowDir.y * colDir.z - rowDir.z * colDir.y,
        rowDir.z * colDir.x - rowDir.x * colDir.z,
        rowDir.x * colDir.y - rowDir.y * colDir.x,
      );
      const flip = cross.x * n.x + cross.y * n.y + cross.z * n.z < 0;
      builder.addGrid(
        rows,
        rows.map((row) => row.map(() => n)),
        shade(rows),
        flip,
      );
    };

    strip(inner, v3(inward.x, 0, inward.z));
    strip(outer, v3(-inward.x, 0, -inward.z));
    strip(top, v3(0, 1, 0));
    strip(bottom, v3(0, -1, 0));

    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    const tangent = length > 1e-9 ? { x: dx / length, z: dz / length } : { x: 0, z: 1 };
    const cap = (index: number, normal: Vec3): void => {
      addQuadFacing(
        builder,
        inner[index][0],
        outer[index][0],
        outer[index][1],
        inner[index][1],
        normal,
        jitter(colour, random, jitterAmount),
      );
    };
    if (caps.start) cap(0, v3(-tangent.x, 0, -tangent.z));
    if (caps.end) cap(STATIONS, v3(tangent.x, 0, tangent.z));
  };

  const aft = companionXLimits(COMPANION_AFT_Z);
  const fore = companionXLimits(COMPANION_FORWARD_Z);
  // Inboard run: its inner face looks outboard, across the opening.
  run(
    { x: aft.xLo - t * 0.5, z: COMPANION_AFT_Z - t },
    { x: fore.xLo - t * 0.5, z: COMPANION_FORWARD_Z },
    { x: 1, z: 0 },
    { start: true, end: true },
  );
  // After run: its inner face looks forward, into the opening.
  run(
    { x: aft.xLo, z: COMPANION_AFT_Z - t * 0.5 },
    { x: aft.xHi, z: COMPANION_AFT_Z - t * 0.5 },
    { x: 0, z: 1 },
    // Its inboard end butts against the extended inboard rail, whose face
    // closes the joint. The outboard end remains a real, capped end grain.
    { start: false, end: true },
  );
}

/**
 * The lining of an opening's cut: the four faces from the deck down to the beams.
 *
 * Easy to forget and impossible to miss once it is: a deck lofted as a surface
 * has no thickness, so without this the cut edge is a zero-width nothing and you
 * see straight through the deck from below. It drops to the beams' underside,
 * which is where the carlings round a real hatchway are.
 *
 * Sampled at the loft's own stations for the reason the deckhead is: a top edge
 * taken as a chord under a curved deck leaves a slot, and the slot is the whole
 * width of a pixel and the whole length of the opening.
 */
function buildOpeningLining(
  out: RegionBuilders,
  random: () => number,
  opening: DeckOpening,
): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;
  const zs = spaceSamples(opening.zAft, opening.zForward);

  for (const side of [1, -1] as const) {
    // The companionway's port wall is a single casing from sole to deck, built
    // with the room sides. Drawing this short ribbon as well recreates the very
    // seam and coplanar overlap that casing removes.
    if (opening.name === 'companionway' && side > 0) continue;
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    for (const z of zs) {
      const edgeX = side > 0 ? openingXLimits(opening, z).xHi : openingXLimits(opening, z).xLo;
      const over = deckStandAt(edgeX, z);
      if (!over) continue;
      points.push([
        v3(edgeX, over.y - DECK_BEAM_DEPTH, z),
        v3(edgeX, over.y, z),
      ]);
      normals.push([v3(-side, 0, 0), v3(-side, 0, 0)]);
      colours.push([
        jitter(colour, random, jitterAmount),
        jitter(colour, random, jitterAmount),
      ]);
    }
    if (points.length > 1) {
      out.get('interiorLining').addGrid(points, normals, colours, side < 0);
    }
  }
  for (const [z, facing] of [
    [opening.zAft, 1],
    [opening.zForward, -1],
  ] as const) {
    // The companion head is the deck break itself and is deliberately open
    // forward. Its *high* deck therefore has no cut edge across the opening: a
    // generic 180 mm ribbon here used to stand across the sky at the top of the
    // ladder, visible (and black in shadow) only from below.
    //
    // The low waist deck is different. Its after edge is exposed across the
    // opening, and the 50 mm of plank end grain is real geometry. Skipping the
    // whole head removed that face too, leaving a slot exactly one plank thick:
    // a recorded ray at y=3.817 passed between its top at 3.848 and underside
    // at 3.798, through the back of the topsides, and on to the ocean. Draw only
    // that low-deck edge; the 0.55 m stair exit above it remains open.
    const companionHead = opening.name === 'companionway' && z === opening.zForward;
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    const ends = openingXLimits(opening, z);
    const across = companionHead ? 4 : 2;
    for (let j = 0; j <= across; j++) {
      const x = ends.xLo + ((ends.xHi - ends.xLo) * j) / across;
      if (companionHead) {
        const lowDeck = BULWARK_SEGMENTS[1];
        const width = deckHalfWidth(z, lowDeck);
        if (width <= 1e-6) continue;
        const over = deckPoint(z, x / width, lowDeck);
        points.push([v3(x, over.y - DECK_PLANK_THICKNESS, z), over]);
      } else {
        const over = deckStandAt(x, z);
        if (!over) continue;
        points.push([v3(x, over.y - DECK_BEAM_DEPTH, z), v3(x, over.y, z)]);
      }
      normals.push([v3(0, 0, facing), v3(0, 0, facing)]);
      colours.push([
        jitter(colour, random, jitterAmount),
        jitter(colour, random, jitterAmount),
      ]);
    }
    if (points.length > 1) {
      // Rows run to port and columns run upward, so unflipped crosses to +z —
      // the same sense as the bulkheads above, and flipped for the same reason.
      out.get('interiorLining').addGrid(points, normals, colours, facing < 0);
    }
  }
}


/**
 * The beams under the platform, and the bulkheads that close the hold.
 *
 * TWO THINGS ASH FOUND FROM INSIDE THE HOLD, WHICH IS THE ONLY PLACE THEY SHOW
 * ---------------------------------------------------------------------------
 * **"the floor looks like a thin sheet of paper."** It was: a sole is planking
 * and nothing else, which is all it ever needed to be while no one could be
 * underneath one. A platform deck is planking *on beams*, and from below the
 * beams are the whole of what you see. `PLATFORM_BEAM_DEPTH` is scantled at
 * half the weather deck's, which is what `massModel.ts` already weighs it as.
 *
 * **"i can see into the bow, with the fore mast coming through it. is that part
 * of the hold or not?"** It is not, and the plan already said so:
 * `SHIP_BELOW_DECKS_PLAN.md` §4.5 gives the space under the forecastle to the
 * **cable tier** and the space under the cabin and landing to the **bread room
 * and lazarette**. Three compartments, and the hold is only the middle one. It
 * looked like one continuous cavern because the under-floor lining runs the
 * whole ship — correctly, it has to stop a ray — and nothing divided it.
 *
 * The bulkheads stand at the platform's own stations, so the hold below is the
 * wardroom above and the two cannot drift apart. That is also where they belong
 * structurally: the platform's ends need something under them.
 */
function buildHoldStructure(out: RegionBuilders, random: () => number): void {
  const space = belowDecksSpace('wardroom');
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;
  const beamTop = space.soleY - DECK_PLANK_THICKNESS;
  const beamFoot = beamTop - PLATFORM_BEAM_DEPTH;

  // --- the beams -------------------------------------------------------------
  // Athwartships, on the platform's own span, and interrupted at the hatchway
  // the way `addDeckBeam` interrupts the weather deck's at the cargo hatch: a
  // beam across an opening is a beam through the route a cask comes down.
  const span = space.zForward - space.zAft;
  const count = Math.max(2, Math.round(span / 0.62));
  for (let i = 0; i < count; i++) {
    const z = space.zAft + ((i + 0.5) * span) / count;
    // Interrupted at the hatchway, the way `addDeckBeam` interrupts the
    // weather deck's at the cargo hatch — and this interruption is load
    // bearing twice over: it is also the only headroom in the hold, which is
    // why `HOLD_FLOOR_PANEL` is the opening's own footprint.
    if (z > HATCHWAY_AFT_Z && z < HATCHWAY_FORWARD_Z) continue;
    const half = spaceHalfWidthAt(space, z);
    if (half <= 0) continue;
    addBox(
      out.get('interiorLining'),
      v3(0, (beamTop + beamFoot) / 2, z),
      v3(half, PLATFORM_BEAM_DEPTH / 2, 0.055),
      jitter(colour, random, jitterAmount),
    );
  }

  // --- the bulkheads ---------------------------------------------------------
  // Lofted up the hull's own section rather than run as a rectangle to the
  // width at the floor. That is the furnishing slice's 0.1 m fault: the hull
  // opens outward as it rises, so a rectangle sized at the bottom leaves a slot
  // at the top — and a slot in a bulkhead is a view into the next compartment.
  const ROWS = 8;
  for (const z of [space.zAft, space.zForward]) {
    const rabbet = floorYAt(z);
    if (rabbet >= space.soleY) continue;
    const points: Vec3[][] = [];
    const normals: Vec3[][] = [];
    const colours: Rgb[][] = [];
    // Facing: the aft bulkhead is seen from forward of it and vice versa.
    const facing = z === space.zAft ? 1 : -1;
    for (let j = 0; j <= ROWS; j++) {
      const y = rabbet + ((space.soleY - rabbet) * j) / ROWS;
      const half = Math.max(halfBreadthAt(z, y) - CABIN_LINING_THICKNESS, 0);
      const row: Vec3[] = [];
      const rowN: Vec3[] = [];
      const rowC: Rgb[] = [];
      for (let k = 0; k <= ROOM_COLS; k++) {
        const u = -1 + (2 * k) / ROOM_COLS;
        row.push(v3(u * half, y, z));
        rowN.push(v3(0, 0, facing));
        rowC.push(jitter(colour, random, jitterAmount));
      }
      points.push(row);
      normals.push(rowN);
      colours.push(rowC);
    }
    // Two-sided: a bulkhead in the dark is looked at from whichever side a body
    // happens to be on, and the hold has been through this once already.
    out.get('interiorLining').addGrid(points, normals, colours, facing > 0);
    out.get('interiorLining').addGrid(
      points,
      normals.map((r) => r.map((n) => v3(-n.x, -n.y, -n.z))),
      colours,
      facing < 0,
    );
  }
}

/**
 * The lining under every floor in the ship, from the rabbet up to the sole.
 *
 * **Without this the ship is a hole.** Every other below-decks surface stops at
 * a room's sole, and below the soles the only thing drawn is `buildShell` — the
 * hull's *outside*, lofted one-sided. An open-ended surface reads as
 * transparency rather than as a hole, which this project has now recorded five
 * times, and here it is the entire planking under the accommodation.
 *
 * It exists because the boards come up now. While the hatchway was solid there
 * was nowhere to look from, so the missing surface cost nothing and could not
 * be seen; the first thing that changes when a floor becomes an opening is
 * which surfaces are load-bearing for the illusion.
 *
 * **It runs the whole ship, not just the hold, and that was found by looking.**
 * Lofted over the wardroom's stations alone, the view down the open hatchway
 * ran *forward past the hold's own bulkhead* into the unlined space under the
 * forecastle and straight out through the shell to the sky — a raycast through
 * the offending pixels returned nothing nearer than 500 m. A sightline does not
 * stop at the room it started in, which is the whole lesson: the bound that
 * matters is where a ray can reach, not where the thing you were drawing ends.
 *
 * Sampled up the hull's own waterlines for the reason `buildSpaceSides` gives
 * at length — the sections close hard toward the ends and a chord across the
 * turn of the bilge stands a long way clear of the planking it is lining.
 */
function buildUnderFloorLining(out: RegionBuilders, random: () => number): void {
  const colour = rgbOf(SHIP_PALETTE.base.interiorLining);
  const jitterAmount = SHIP_PALETTE.jitterAmount.interiorLining;

  const lineBetween = (zAft: number, zForward: number, topY: number): void => {
    for (const side of [1, -1] as const) {
      const points: Vec3[][] = [];
      const normals: Vec3[][] = [];
      const colours: Rgb[][] = [];
      for (const z of spaceSamples(zAft, zForward)) {
        const rabbet = floorYAt(z);
        if (rabbet >= topY) continue;
        const ys: number[] = [];
        const ws: number[] = [];
        for (let j = 0; j <= SIDE_ROWS; j++) {
          const y = rabbet + ((topY - rabbet) * j) / SIDE_ROWS;
          ys.push(y);
          // Clamped at zero because down at the rabbet the hull is narrower
          // than the lining is thick, and a negative half-width turns the
          // surface inside out — a winding fault, not a small one.
          ws.push(Math.max(halfBreadthAt(z, y) - CABIN_LINING_THICKNESS, 0));
        }
        const rowP: Vec3[] = [];
        const rowN: Vec3[] = [];
        const rowC: Rgb[] = [];
        for (let j = 0; j < ys.length; j++) {
          const j0 = Math.max(j - 1, 0);
          const j1 = Math.min(j + 1, ys.length - 1);
          const dy = ys[j1] - ys[j0];
          const slope = Math.abs(dy) > 1e-9 ? (ws[j1] - ws[j0]) / dy : 0;
          const len = Math.hypot(1, slope);
          rowP.push(v3(side * ws[j], ys[j], z));
          rowN.push(v3(-side / len, slope / len, 0));
          rowC.push(jitter(colour, random, jitterAmount));
        }
        points.push(rowP);
        normals.push(rowN);
        colours.push(rowC);
      }
      if (points.length > 1) {
        // Same sense as `buildSpaceSides`: rows forward, columns upward, so
        // unflipped crosses to -x and the port hand (+1) is already inboard.
        out.get('interiorLining').addGrid(points, normals, colours, side < 0);
      }
    }
  };

  for (const space of BELOW_DECKS_SPACES) {
    lineBetween(space.zAft, space.zForward, space.soleY);
  }
  // The peak, forward of the forecastle: no floor of its own, because it is the
  // sail room and is stowed solid. It still has to stop a ray — the sightline
  // from the hatchway reaches this far, and the sea does not care that nobody
  // can stand here.
  const forecastle = belowDecksSpace('forecastle');
  lineBetween(forecastle.zForward, HALF_LENGTH - 0.05, forecastle.soleY);
}

/**
 * Sweep a centreline slab along `zs`, split into the shell's paint bands.
 *
 * The band split is what makes the boot-top stripe continue across the stem
 * instead of stopping at the planking, which is the sort of thing that is
 * invisible until you look at her bow-on and then is all you can see.
 */
function sweepSlab(
  out: RegionBuilders,
  random: () => number,
  zs: number[],
  bottomY: (z: number) => number,
  topY: (z: number) => number,
  halfWidth: (z: number) => number,
): void {
  const bandsOf = (lo: number, hi: number): { region: ShipRegion; lo: number; hi: number }[] => {
    const cuts: { region: ShipRegion; lo: number; hi: number }[] = [
      { region: 'belowWaterline', lo: -Infinity, hi: BOOT_TOP_LOW },
      { region: 'bootTop', lo: BOOT_TOP_LOW, hi: BOOT_TOP_HIGH },
      { region: 'topsides', lo: BOOT_TOP_HIGH, hi: Infinity },
    ];
    return cuts.map((cut) => {
      const a = Math.min(Math.max(cut.lo, lo), hi);
      const b = Math.min(Math.max(cut.hi, lo), hi);
      return { region: cut.region, lo: a, hi: Math.max(a, b) };
    });
  };

  const regionAt = (y: number): ShipRegion =>
    y < BOOT_TOP_LOW ? 'belowWaterline' : y < BOOT_TOP_HIGH ? 'bootTop' : 'topsides';

  for (let i = 0; i < zs.length - 1; i++) {
    const zA = zs[i];
    const zB = zs[i + 1];
    const loA = bottomY(zA);
    const hiA = topY(zA);
    const loB = bottomY(zB);
    const hiB = topY(zB);
    if (hiA - loA < 1e-6 && hiB - loB < 1e-6) continue;

    const wA = halfWidth(zA);
    const wB = halfWidth(zB);

    const spanA = bandsOf(loA, hiA);
    const spanB = bandsOf(loB, hiB);
    for (let k = 0; k < spanA.length; k++) {
      const a = spanA[k];
      const b = spanB[k];
      const region = a.region;
      const colour = jitter(
        rgbOf(SHIP_PALETTE.base[region]),
        random,
        SHIP_PALETTE.jitterAmount[region] * 0.5,
      );
      const builder = out.get(region);

      // Port and starboard faces.
      builder.addQuad(
        v3(wA, a.lo, zA),
        v3(wB, b.lo, zB),
        v3(wB, b.hi, zB),
        v3(wA, a.hi, zA),
        v3(1, 0, 0),
        colour,
        true,
      );
      builder.addQuad(
        v3(-wA, a.lo, zA),
        v3(-wB, b.lo, zB),
        v3(-wB, b.hi, zB),
        v3(-wA, a.hi, zA),
        v3(-1, 0, 0),
        colour,
      );

    }

    // The physical top and bottom are single surfaces. Tying them to the first
    // or last *surviving* paint band was the indexing bug that folded the rudder
    // and backbone when a band disappeared between stations.
    const bottomRegion = regionAt((loA + loB) * 0.5);
    const bottomColour = jitter(
      rgbOf(SHIP_PALETTE.base[bottomRegion]),
      random,
      SHIP_PALETTE.jitterAmount[bottomRegion] * 0.5,
    );
    addQuadFacing(
      out.get(bottomRegion),
      v3(-wA, loA, zA),
      v3(wA, loA, zA),
      v3(wB, loB, zB),
      v3(-wB, loB, zB),
      v3(0, -1, 0),
      bottomColour,
    );
    const topRegion = regionAt((hiA + hiB) * 0.5);
    const topColour = jitter(
      rgbOf(SHIP_PALETTE.base[topRegion]),
      random,
      SHIP_PALETTE.jitterAmount[topRegion] * 0.5,
    );
    addQuadFacing(
      out.get(topRegion),
      v3(-wA, hiA, zA),
      v3(wA, hiA, zA),
      v3(wB, hiB, zB),
      v3(-wB, hiB, zB),
      v3(0, 1, 0),
      topColour,
    );
  }

  // End grain. Usually the backbone collapses to a point at stem and stern, but
  // the rudder has a broad aft face and used to be entirely open there.
  for (const endIndex of [0, zs.length - 1]) {
    const z = zs[endIndex];
    const lo = bottomY(z);
    const hi = topY(z);
    if (hi - lo <= 1e-6) continue;
    const width = halfWidth(z);
    const normal = v3(0, 0, endIndex === 0 ? -1 : 1);
    for (const band of bandsOf(lo, hi)) {
      addQuadFacing(
        out.get(band.region),
        v3(-width, band.lo, z),
        v3(width, band.lo, z),
        v3(width, band.hi, z),
        v3(-width, band.hi, z),
        normal,
        jitter(
          rgbOf(SHIP_PALETTE.base[band.region]),
          random,
          SHIP_PALETTE.jitterAmount[band.region] * 0.5,
        ),
      );
    }
  }
}

/** A position on the outside or inside face of the bulwark. */
function bulwarkPoint(z: number, y: number, inside: boolean): Vec3 {
  const outer = bulwarkOuterHalfBeam(z, y);
  const x = inside ? Math.max(outer - BULWARK_THICKNESS, 0) : outer;
  return v3(x, y, z - counterRakeShift(z, y));
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9;
}

/**
 * One closed cross-section of the visible hull envelope.
 *
 * This walks the actual analytic surfaces in order: port shell, outer
 * bulwark, around the caprail, down the inboard face, across the cambered deck,
 * then the mirrored starboard path back to the rabbet. It is the canonical boundary
 * used by the manifold gate below; no separate "close enough" offsets exist.
 */
function hullEnvelopeRing(z: number, segment: BulwarkSegment): Vec3[] {
  const ring: Vec3[] = [];
  // Keep the address of every boundary row stable even when a row collapses at
  // the stem. SurfaceBuilder drops the resulting zero-area cells, while the
  // neighbouring station still knows exactly which row it tapers into.
  const push = (point: Vec3): void => {
    ring.push(point);
  };

  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  const walking = segmentWalkingY(z, segment);
  const top = segmentBulwarkTopY(z, segment);
  const wallMid = walking + (top - walking) * 0.5;
  const shell: Vec3[] = [];
  for (let row = 0; row <= SHELL_ROWS; row++) {
    const y = row === 0 ? floor : row === SHELL_ROWS ? deck : floor + ((deck - floor) * row) / SHELL_ROWS;
    shell.push(shellPoint(z, y));
  }
  for (const point of shell) push(point);

  if (walking - deck > 1e-6) push(bulwarkPoint(z, walking, false));
  push(bulwarkPoint(z, wallMid, false));
  const wallOuterTop = bulwarkPoint(z, top, false);
  const wallInnerTop = bulwarkPoint(z, top, true);
  push(wallOuterTop);

  const capOuterX = wallOuterTop.x + CAPRAIL_OVERHANG;
  const capInnerX = Math.max(wallInnerTop.x - CAPRAIL_OVERHANG, 0);
  push(v3(capOuterX, top, wallOuterTop.z));
  push(v3(capOuterX, top + CAPRAIL_THICKNESS, wallOuterTop.z));
  push(v3(capInnerX, top + CAPRAIL_THICKNESS, wallOuterTop.z));
  push(v3(capInnerX, top, wallOuterTop.z));
  push(wallInnerTop);
  push(bulwarkPoint(z, wallMid, true));
  const wallInnerWalking = bulwarkPoint(z, walking, true);
  push(wallInnerWalking);

  // Port to starboard. The end points are the same analytic inner-bulwark
  // points as above, so the deck cannot overhang or stop short of the wall.
  const deckPoints: Vec3[] = [];
  for (let col = 0; col <= 8; col++) {
    deckPoints.push(deckPoint(z, 1 - (2 * col) / 8, segment));
  }
  for (const point of deckPoints) push(point);

  push(mirrorPoint(bulwarkPoint(z, wallMid, true)));
  push(mirrorPoint(wallInnerTop));
  push(v3(-capInnerX, top, wallOuterTop.z));
  push(v3(-capInnerX, top + CAPRAIL_THICKNESS, wallOuterTop.z));
  push(v3(-capOuterX, top + CAPRAIL_THICKNESS, wallOuterTop.z));
  push(v3(-capOuterX, top, wallOuterTop.z));
  push(mirrorPoint(wallOuterTop));
  push(mirrorPoint(bulwarkPoint(z, wallMid, false)));
  if (walking - deck > 1e-6) push(mirrorPoint(bulwarkPoint(z, walking, false)));
  for (let row = shell.length - 1; row >= 0; row--) push(mirrorPoint(shell[row]));

  return ring;
}

function capEnvelopeRing(
  builder: SurfaceBuilder,
  ring: Vec3[],
  normal: Vec3,
  colour: Rgb,
  reverse: boolean,
): void {
  const centre = v3(
    ring.reduce((sum, point) => sum + point.x, 0) / ring.length,
    ring.reduce((sum, point) => sum + point.y, 0) / ring.length,
    ring.reduce((sum, point) => sum + point.z, 0) / ring.length,
  );
  // A centre fan deliberately preserves every longitudinal boundary edge.
  // General polygon triangulators are allowed to discard collinear outline
  // vertices, which is geometrically harmless but turns the neighbouring side
  // subdivision into a T-junction in an incidence audit.
  for (let edge = 0; edge < ring.length; edge++) {
    const next = (edge + 1) % ring.length;
    if (samePoint(ring[edge], ring[next])) continue;
    builder.addPolygon([centre, ring[edge], ring[next]], normal, colour, reverse);
  }
}

function buildHullEnvelopeSolid(segment: BulwarkSegment): THREE.BufferGeometry {
  const builder = new SurfaceBuilder();
  const colour = rgbOf(SHIP_PALETTE.base.topsides);
  const zs = hullSamplesBetween(segment.z0, segment.z1);
  const rings = zs.map((z) => hullEnvelopeRing(z, segment));
  const ringLength = rings[0].length;
  if (!rings.every((ring) => ring.length === ringLength)) {
    throw new Error(
      `hull envelope ring length changed inside ${segment.z0}..${segment.z1}: ` +
        rings.map((ring, index) => `${zs[index].toFixed(3)}=${ring.length}`).join(', '),
    );
  }
  for (let station = 0; station < rings.length - 1; station++) {
    const a = rings[station];
    const b = rings[station + 1];
    for (let edge = 0; edge < ringLength; edge++) {
      const next = (edge + 1) % ringLength;
      // The ring is clockwise viewed from forward. This order carries that
      // orientation along +z; the topology test additionally checks opposite
      // edge directions, so a global inside-out flip cannot hide a crack.
      builder.addQuad(a[edge], b[edge], b[next], a[next], v3(0, 1, 0), colour);
    }
  }
  capEnvelopeRing(builder, rings[0], v3(0, 0, -1), colour, false);
  capEnvelopeRing(builder, rings[rings.length - 1], v3(0, 0, 1), colour, true);
  return builder.toGeometry();
}

function buildSlabSealSolid(
  zs: number[],
  bottomY: (z: number) => number,
  topY: (z: number) => number,
  halfWidth: (z: number) => number,
): THREE.BufferGeometry {
  const builder = new SurfaceBuilder();
  const colour = rgbOf(SHIP_PALETTE.base.belowWaterline);
  for (let i = 0; i < zs.length - 1; i++) {
    const z0 = zs[i];
    const z1 = zs[i + 1];
    const lo0 = bottomY(z0);
    const lo1 = bottomY(z1);
    const hi0 = topY(z0);
    const hi1 = topY(z1);
    const w0 = halfWidth(z0);
    const w1 = halfWidth(z1);
    addQuadFacing(builder, v3(w0, lo0, z0), v3(w1, lo1, z1), v3(w1, hi1, z1), v3(w0, hi0, z0), v3(1, 0, 0), colour);
    addQuadFacing(builder, v3(-w0, hi0, z0), v3(-w1, hi1, z1), v3(-w1, lo1, z1), v3(-w0, lo0, z0), v3(-1, 0, 0), colour);
    addQuadFacing(builder, v3(-w0, lo0, z0), v3(w0, lo0, z0), v3(w1, lo1, z1), v3(-w1, lo1, z1), v3(0, -1, 0), colour);
    addQuadFacing(builder, v3(w0, hi0, z0), v3(-w0, hi0, z0), v3(-w1, hi1, z1), v3(w1, hi1, z1), v3(0, 1, 0), colour);
  }
  for (const end of [0, zs.length - 1]) {
    const z = zs[end];
    const lo = bottomY(z);
    const hi = topY(z);
    if (hi - lo <= 1e-6) continue;
    const w = halfWidth(z);
    addQuadFacing(
      builder,
      v3(-w, lo, z),
      v3(w, lo, z),
      v3(w, hi, z),
      v3(-w, hi, z),
      v3(0, 0, end === 0 ? -1 : 1),
      colour,
    );
  }
  return builder.toGeometry();
}

/**
 * Strict logical solids used by the topology gate.
 *
 * Decorative window and moulding overlays are intentionally absent. Every
 * returned geometry must be a closed two-manifold after position welding.
 */
export function buildShipSealSolids(): Map<string, THREE.BufferGeometry> {
  return new Map([
    ['hull:quarterdeck', buildHullEnvelopeSolid(BULWARK_SEGMENTS[0])],
    ['hull:main', buildHullEnvelopeSolid(BULWARK_SEGMENTS[1])],
    ['hull:forecastle', buildHullEnvelopeSolid(BULWARK_SEGMENTS[2])],
    [
      'backbone',
      buildSlabSealSolid(
        hullLongitudinalSamples(),
        (z) => backboneBottomY(z),
        (z) => backboneTopY(z),
        (z) => backboneSiding(z) / 2,
      ),
    ],
    [
      'rudder',
      buildSlabSealSolid(
        longitudinalSamples(-HALF_LENGTH, -6.6, 18),
        () => rudderBottomY(),
        (z) => rudderTopY(z),
        () => 0.07,
      ),
    ],
  ]);
}
