import * as THREE from 'three';
import {
  BULWARK_PIN_RAILS,
  CHANNEL_SEATS,
  CROSSTREES,
  FIFE_HEIGHT_ABOVE_DECK,
  FIFE_RAILS,
  fifePinX,
  fifeStanchionX,
  BOOM_R_END,
  BOOM_R_MID,
  HORSE_RADIUS,
  HORSE_SAG,
  MASTHEAD_EYES,
  RIG_BLOCKS,
  SHEET_BLOCKS,
  SHEET_FAIRLEADS,
  SHEET_HORSES,
  RATLINES,
  RATLINE_DIAMETER,
  SAILS,
  RUNNING_RIGGING,
  SPARS,
  STANDING_RIGGING,
  TOP_PROPORTIONS,
  AUTHORED_TRIM_RAD,
  applyRigTrim,
  crosstreeArmZ,
  liveSailCorners,
  chainPlateFoot,
  channelRoot,
  channelRootAt,
  pinRailSeat,
  rigNode,
} from './rig';
import type {
  Crosstrees,
  RigPoint,
  RigTrimAnglesRad,
  RiggingRun,
  Sail,
  SailName,
  SheetHorse,
} from './rig';
import { deckStandAt } from './deckSurface';
import { lookoutSolids } from './lookout';
import type { LookoutRegion } from './lookout';
import {
  HOIST_EPSILON,
  SAIL_AERO_GEOMETRY,
  SAIL_CLOTH_SHAPE,
  gatherSailCorners,
  liveSailSide,
  sailAbackFactor,
  sailCamberScale,
  sailLeewardNormal,
  sailLuffFactor,
  sailShakeFraction,
  sailQuadAreaM2,
  sailSheetHardness,
} from './sailAero';
import { SurfaceBuilder, addBox, addTube, frameFor, jitter, makeRandom, normalise, rgbOf, v3 } from './shipwright';
import type { Rgb, SeededRandom, Vec3 } from './shipwright';

/**
 * The schooner rig's visible geometry, lofted from the graph in `rig.ts`.
 *
 * Same division as the hull: `rig.ts` decides where everything *is*,
 * this file decides how to turn that into triangles. Nothing here invents a
 * position — every point comes from a named node or from a spar's two ends, so
 * retuning a mast height moves the ropes and the sails with it.
 *
 * WHY THE RIG HAS ITS OWN REGIONS
 * -------------------------------
 * The hull's paint regions are bands of *height* on one continuous surface —
 * below-waterline, boot-top, topsides. The rig's are materials: slushed pine,
 * tarred hemp, wrought iron, flax canvas. They do not overlap, so they get their
 * own enum rather than being bolted onto `ShipRegion`, and `shipGeometry.ts`'s
 * tests keep asserting the hull without knowing the rig exists.
 *
 * WINDING — every primitive here passes `flip = true`
 * ---------------------------------------------------
 * `SurfaceBuilder.addGrid` winds a face as (row step) × (column step). This
 * file's grids all run *along* the thing in rows and *around or across* it in
 * columns — down a spar and round its circumference, down a sail and across its
 * chord — which is the natural way to generate them and the opposite of what
 * that winding wants. So the supplied normals came out antiparallel to the
 * faces they belonged to, on all four rig meshes, on every single triangle.
 *
 * The visible symptom was the sails: cloth is `DoubleSide`, so three flips the
 * normal by `gl_FrontFacing`, and with the winding inverted it flipped it the
 * wrong way — the face toward the sun rendered dark and the face away from it
 * caught the sunset. The spars and rope had it too and hid it better, being
 * opaque tubes: front-face culling was throwing away the near wall and showing
 * the inside of the far one.
 *
 * The fix is the winding, not the normals — the normals are the true outward
 * normals of the surface, which is the whole reason `shipwright.ts` takes them
 * rather than computing them. `ship-rig.test.ts` asserts the agreement now.
 */

export type RigRegion = 'spar' | 'rope' | 'ironwork' | 'sailcloth';

/** Palette keys, which include one colour that is not its own region. */
type RigColourKey = RigRegion | 'runningRope';

export const RIG_REGIONS: readonly RigRegion[] = ['spar', 'rope', 'ironwork', 'sailcloth'];

/** Deterministic, for the same reason the hull's timber is — `docs/project/ASSET_CREDITS.md`. */
const RIG_SEED = 0x1f5a11e5;

export const RIG_PALETTE: Record<RigColourKey, number> = {
  /**
   * Slushed pine. Masts were greased with tallow so the hoops and mast rings ran
   * freely, which leaves them noticeably paler and warmer than the tarred hull —
   * and that contrast is most of what separates the sticks from the sea behind
   * them at distance.
   */
  spar: 0xa88a5e,
  /**
   * Tarred hemp: near-black, and it stays near-black. Standing rigging is the
   * one thing aboard that is *meant* to read as line rather than as form, and
   * `SHIP_PALETTE`'s wales note applies here too — this is dark enough that it
   * is visible through its sheen against the sky, not through its value.
   */
  rope: 0x2b2620,
  ironwork: 0x33353a,
  /**
   * Untarred manila for the running rigging — pale against the tarred web.
   * Not a separate draw call: it rides in the `rope` region as vertex colour,
   * which is what the per-strake variation on the hull already does.
   */
  runningRope: 0x8d7f66,
  /**
   * Flax canvas — `docs/ship/SHIP_SPEC.md` section 1's "flax-grey sails", section 16's
   * "cream-grey sailcloth". Warm, dirty, and well short of white: a white sail
   * on this ocean blows the exposure and reads as plastic.
   */
  sailcloth: 0xbfb7a2,
};

const JITTER: Record<RigRegion, number> = {
  spar: 0.05,
  rope: 0.04,
  ironwork: 0.05,
  // Panel-to-panel variation across the cloth: real sails are sewn from cloths
  // that weather differently, and a perfectly even sail is the flattest thing
  // in any frame.
  sailcloth: 0.045,
};

export interface RigGeometrySet {
  geometries: Map<RigRegion, THREE.BufferGeometry>;
  triangleCount: number;
}

class RigBuilders {
  private readonly builders = new Map<RigRegion, SurfaceBuilder>();

  get(region: RigRegion): SurfaceBuilder {
    let b = this.builders.get(region);
    if (!b) {
      b = new SurfaceBuilder();
      this.builders.set(region, b);
    }
    return b;
  }

  reset(): void {
    for (const b of this.builders.values()) b.reset();
  }

  /** Rewrite the matching geometries in place; report which would not fit. */
  writeInto(target: ReadonlyMap<RigRegion, THREE.BufferGeometry>): RigRegion[] {
    const resized: RigRegion[] = [];
    for (const region of RIG_REGIONS) {
      const b = this.builders.get(region);
      const geometry = target.get(region);
      if (!b || b.isEmpty || !geometry) {
        if (b && !b.isEmpty) resized.push(region);
        continue;
      }
      if (!b.writeInto(geometry)) resized.push(region);
    }
    return resized;
  }

  geometryFor(region: RigRegion): THREE.BufferGeometry | undefined {
    const b = this.builders.get(region);
    return b && !b.isEmpty ? b.toGeometry() : undefined;
  }

  finish(): RigGeometrySet {
    const geometries = new Map<RigRegion, THREE.BufferGeometry>();
    let triangleCount = 0;
    for (const region of RIG_REGIONS) {
      const b = this.builders.get(region);
      if (!b || b.isEmpty) continue;
      geometries.set(region, b.toGeometry());
      triangleCount += b.triangleCount;
    }
    return { geometries, triangleCount };
  }
}

// --- primitives --------------------------------------------------------------

function toVec3(p: RigPoint): Vec3 {
  return v3(p.x, p.y, p.z);
}

// --- spars -------------------------------------------------------------------

/** Circumferential resolution. Masts are looked at closely; ropes are not. */
const SPAR_SIDES = 10;
const ROPE_SIDES = 4;

/**
 * Whether a spar is one of the lower masts — the only timber aboard that runs
 * from the bilge to the sky through every room in the ship.
 *
 * They are treated differently twice over, for one reason: the baked
 * enclosure ramp (`interiorLightBake.bakeSparPortalLight`) rides in a vertex
 * attribute. A two-row tube interpolates that attribute linearly from a dark
 * heel to a bright head across twelve metres, so the lower masts take rows
 * every ~0.3 m — dark in the hold, room-lit in the wardroom, sky-lit above
 * the partners, with the transition inside one row of the deck. And forty
 * rows of tube are exactly what should not be re-lofted sixty times a second
 * for timber that never moves, so they build in the STATIC half
 * (`LOFT_STEPS`), which is where standing rigging always belonged.
 */
function isLowerMast(spar: (typeof SPARS)[number]): boolean {
  return spar.name === 'mainmast' || spar.name === 'foremast';
}

function addSparTube(
  out: RigBuilders,
  spar: (typeof SPARS)[number],
  colour: Rgb,
): void {
  const length = Math.hypot(
    spar.head.x - spar.heel.x,
    spar.head.y - spar.heel.y,
    spar.head.z - spar.heel.z,
  );
  addTube(
    out.get('spar'),
    toVec3(spar.heel),
    toVec3(spar.head),
    spar.heelRadius,
    spar.headRadius,
    SPAR_SIDES,
    // Straight timber needs no length resolution beyond its ends for
    // shading — the taper is linear and the normals carry it. The lower
    // masts carry the enclosure attribute; see `isLowerMast`.
    isLowerMast(spar) ? Math.max(Math.ceil(length / 0.3), 2) : 2,
    colour,
  );
}

/**
 * Each step draws colours only for the spars it builds — the fixed number of
 * draws per builder that `seedStates` depends on. The split moved every
 * spar's position in the colour stream once, which re-jittered the timber by
 * a few percent of lightness; a one-time cosmetic shuffle, not a leak.
 */
function buildMasts(out: RigBuilders, random: () => number): void {
  const base = rgbOf(RIG_PALETTE.spar);
  for (const spar of SPARS) {
    if (isLowerMast(spar)) addSparTube(out, spar, jitter(base, random, JITTER.spar));
  }
}

function buildSpars(out: RigBuilders, random: () => number): void {
  const base = rgbOf(RIG_PALETTE.spar);
  for (const spar of SPARS) {
    if (!isLowerMast(spar)) addSparTube(out, spar, jitter(base, random, JITTER.spar));
  }
}

/**
 * The mast caps — the iron-bound blocks at each lower masthead that the topmast
 * passes through.
 *
 * Small, and the reason the doubling reads as two spars held together rather
 * than as one spar that changes diameter.
 */
function buildMastCaps(out: RigBuilders, random: () => number): void {
  const iron = rgbOf(RIG_PALETTE.ironwork);
  for (const name of ['mainCap', 'foreCap'] as const) {
    const node = rigNode(name);
    addBox(
      out.get('ironwork'),
      v3(node.x, node.y - 0.06, node.z - 0.09),
      v3(0.19, 0.07, 0.29),
      jitter(iron, random, JITTER.ironwork),
    );
  }
}

function buildCrosstrees(out: RigBuilders, random: () => number): void {
  const timber = rgbOf(RIG_PALETTE.spar);
  for (const x of CROSSTREES) {
    addCrosstreeSet(out, x, jitter(timber, random, JITTER.spar));
  }
}

function addCrosstreeSet(out: RigBuilders, x: Crosstrees, colour: Rgb): void {
  const builder = out.get('spar');
  const p = TOP_PROPORTIONS;
  // Trestletrees: the fore-and-aft pair the topmast is fidded between.
  for (const side of [1, -1]) {
    addBox(
      builder,
      v3(side * x.thickness * p.trestleOffset, x.y, x.z),
      v3(x.thickness * p.trestleHalfBreadth, x.thickness * p.trestleHalfHeight, x.length / 2),
      colour,
    );
  }
  // Crosstrees: the athwartship arms the topmast shrouds spread to. The heights
  // and insets come from `rig.ts` because M5's lookout platform is planking laid
  // on these arms — a second copy of how high they stand would be a floor in the
  // wrong place, which is the one kind of drift a player falls through.
  for (const z of crosstreeArmZ(x)) {
    addBox(
      builder,
      v3(0, x.y + x.thickness * p.armRise, z),
      v3(x.halfSpan, x.thickness * p.armHalfHeight, x.thickness * p.armHalfDepth),
      colour,
    );
  }
}

// --- standing rigging --------------------------------------------------------

/**
 * How far a rope sags below the straight line between its ends, as a fraction of
 * its length.
 *
 * Standing rigging is set up hard, so this is small — but it is not zero, and
 * zero is what makes a rig look like a wireframe. Shrouds carry the most because
 * they are the longest unsupported runs; stays are hove tighter.
 */
/**
 * Sag, as a fraction of a run's length.
 *
 * Exported because a rope is not the straight line between its ends, and
 * anything asking whether a rope touches something has to ask about the rope
 * that is *drawn*. The bulwark check asked about the chord instead, and about
 * the centreline of a rope 34 mm thick — so it passed a main sheet whose lower
 * half was inside the caprail, which Ash could still see.
 */
export const SAG: Record<string, number> = {
  shroud: 0.006,
  stay: 0.003,
  backstay: 0.005,
  bobstay: 0.002,
  // Running rigging is not set up hard — it is hauled and belayed, and it sags
  // visibly more than a stay does. That difference is most of what separates a
  // working rope from a structural one at a glance.
  sheet: 0.018,
  halyard: 0.016,
  lift: 0.022,
  brace: 0.014,
};

/**
 * A point on a run's drawn centreline, `t` from 0 at `from` to 1 at `to`.
 *
 * The one description of where a rope goes. `rigGeometry` sweeps its tube along
 * this; the tests measure clearances against it.
 */
export function riggingRunPoint(run: RiggingRun, t: number): Vec3 {
  const from = toVec3(rigNode(run.from));
  const to = toVec3(rigNode(run.to));
  const sag = sagBend(from, to, SAG[run.kind] ?? 0.004)(t);
  return v3(
    from.x + (to.x - from.x) * t + sag.x,
    from.y + (to.y - from.y) * t + sag.y,
    from.z + (to.z - from.z) * t + sag.z,
  );
}

function sagBend(from: Vec3, to: Vec3, amount: number): (t: number) => Vec3 {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const drop = length * amount;
  return (t: number) => v3(0, -drop * 4 * t * (1 - t), 0);
}

function buildStandingRigging(out: RigBuilders, random: () => number): void {
  const base = rgbOf(RIG_PALETTE.rope);
  for (const run of STANDING_RIGGING) {
    addRiggingRun(out, run, jitter(base, random, JITTER.rope));
  }
}

/**
 * The working ropes — sheets, halyards, topping lifts, braces.
 *
 * Drawn into the same region as the standing rigging but paler: running rigging
 * is untarred, because tar stiffens a rope and a rope that has to render through
 * a block every day must stay supple. That is a real distinction and it is
 * visible from the deck — the dark web holds the masts up, the pale lines work
 * the sails.
 */
function buildRunningRigging(out: RigBuilders, random: () => number): void {
  const base = rgbOf(RIG_PALETTE.runningRope);
  for (const run of RUNNING_RIGGING) {
    addRiggingRun(out, run, jitter(base, random, JITTER.rope));
  }
}

function addRiggingRun(out: RigBuilders, run: RiggingRun, colour: Rgb): void {
  const from = toVec3(rigNode(run.from));
  const to = toVec3(rigNode(run.to));
  const sag = SAG[run.kind] ?? 0.004;
  addTube(
    out.get('rope'),
    from,
    to,
    run.diameter / 2,
    run.diameter / 2,
    ROPE_SIDES,
    // Enough segments for the sag to read as a curve rather than a kink.
    6,
    colour,
    sagBend(from, to, sag),
    // Uncapped. Every rope aboard ends inside a block, a coil, an eye or a
    // masthead, so its discs are never seen, and there are 78 ratlines alone.
    false,
  );
}

/**
 * Channels and deadeyes.
 *
 * The channel is the plank that pushes the shrouds outboard of the sheer; the
 * deadeyes are what they set up to. Both are structural — a shroud landing on
 * the deck edge has no spread and reads as a wire — and both are what a viewer
 * actually sees at deck level, where the shrouds themselves are above the eye.
 */
function buildChannels(out: RigBuilders, random: () => number): void {
  const timber = rgbOf(RIG_PALETTE.spar);
  const iron = rgbOf(RIG_PALETTE.ironwork);

  for (const seat of CHANNEL_SEATS) {
    // The deadeye: a flattened disc of lignum vitae, standing on the channel in
    // line with the shroud it terminates.
    addTube(
      out.get('spar'),
      v3(seat.x, seat.y + 0.04, seat.z),
      v3(seat.x, seat.y + 0.26, seat.z),
      0.075,
      0.075,
      8,
      1,
      jitter(timber, random, JITTER.spar),
    );
    // The chain plate: an iron strap from the deadeye's strop down and *inboard*
    // to the topside. It leans, because the hull tumbles home under it — drawn
    // as a vertical box it hung in the air alongside her, which is what made the
    // whole gang read as blue posts floating off the rail.
    const foot = chainPlateFoot(seat);
    addTube(
      out.get('ironwork'),
      v3(seat.x, seat.y + 0.06, seat.z),
      v3(foot.x, foot.y, foot.z),
      0.028,
      0.024,
      4,
      2,
      jitter(iron, random, JITTER.ironwork),
    );
  }

  // The channel planks — one per mast per side, spanning that gang and running
  // inboard to land on the hull rather than stopping short of it.
  for (const mast of ['main', 'fore'] as const) {
    for (const side of ['Port', 'Starboard'] as const) {
      const seats = CHANNEL_SEATS.filter((s) => s.name.startsWith(`${mast}Channel${side}`));
      if (seats.length === 0) continue;
      const outward = Math.sign(seats[0].x) as 1 | -1;
      const zs = seats.map((s) => s.z);
      const zMin = Math.min(...zs) - 0.24;
      const zMax = Math.max(...zs) + 0.24;
      const projection = Math.abs(seats[0].x) - Math.abs(channelRoot(seats[0]).x);
      const colour = jitter(timber, random, JITTER.spar);
      const segments = 6;
      const step = (zMax - zMin) / segments;

      /**
       * A channel follows the topside it is bolted to.
       *
       * This used to be one straight box rooted at the gang's narrowest
       * station, with another 60 mm subtracted to hide its worst exterior gap.
       * The hull opens by 0.16 m along the main channel, so that compromise put
       * the forward root through the interior lining — the pale timber captured
       * from both the wardroom and companion landing. Short overlapping pieces
       * follow the real section in x and sheer in y, just as the pin rails do.
       */
      for (let i = 0; i < segments; i++) {
        const z = zMin + (i + 0.5) * step;
        const root = channelRootAt(z, outward);
        // A few millimetres of honest fastening overlap prevents a blue seam at
        // the hull without carrying the plank through the lining behind it.
        const rootX = Math.abs(root.x) - 0.006;
        const tipX = Math.abs(root.x) + projection + 0.12;
        addBox(
          out.get('spar'),
          v3(outward * (rootX + tipX) / 2, root.y, z),
          v3((tipX - rootX) / 2, 0.05, step * 0.56),
          colour,
        );
      }
    }
  }
}

/**
 * Deck fittings — the things the running rigging ends at.
 *
 * Built because the ropes needed somewhere to go. Sheets used to stop dead at
 * the outer face of the bulwark and halyards at a bare coordinate over the
 * planking, which reads as rope disappearing into the ship. `docs/ship/SHIP_SPEC.md`
 * section 7.4's rule is that every important rope connects functional
 * components; that obliges the components to exist.
 */
function buildDeckFittings(out: RigBuilders, random: () => number): void {
  const timber = rgbOf(RIG_PALETTE.spar);
  const iron = rgbOf(RIG_PALETTE.ironwork);

  // Pin rails on the inboard face of the bulwark, where the sheets belay.
  /**
   * Pin rails, swept along the wall they are bolted to.
   *
   * **A BOARD BOLTED TO A CURVED SHIP IS NOT STRAIGHT.** This was one box placed
   * at the rail's mid-point, taking the hull's half-breadth *there* and holding
   * it for the board's whole length — so at the forward end, where the bow has
   * curved away, the timber stood proud of the planking and out through the ship's
   * side, and at the after end it was buried in it. Ash saw both ends of the same
   * fault at once, which is the signature of a straight thing on a curved one.
   *
   * The bullseyes above it were already right, and for the reason this is right
   * now: each is placed by calling `railSection` at *its own* z. A fitting that
   * sits on the hull has to ask the hull where it is, at the point where it sits.
   *
   * Swept in short segments, and the height follows the sheer as well as the
   * breadth — the rail top rises toward the bow, so a level board would dive into
   * the planking the same way.
   */
  for (const rail of BULWARK_PIN_RAILS) {
    const colour = jitter(timber, random, JITTER.spar);
    const step = (rail.halfLength * 2) / rail.seats.length;
    for (const seat of rail.seats) {
      addBox(
        out.get('spar'),
        toVec3(seat),
        // Half a step of overlap, so consecutive segments close on the curve
        // instead of leaving a gap at every joint.
        v3(0.045, 0.055, step * 0.62),
        colour,
      );
    }
    // One pin per rope, each on the wall at its own station rather than at the
    // board's mid-point — which is also where the rope that belays to it ends.
    for (const z of rail.pinZs) {
      addBelayingPin(out, toVec3(pinRailSeat(z, rail.side)), timber, random);
    }
  }

  // Fife rails abaft each mast, on two stanchions, where the halyards belay.
  for (const fife of FIFE_RAILS) {
    addBox(
      out.get('spar'),
      v3(0, fife.y, fife.z),
      v3(fife.halfSpan, 0.055, 0.06),
      jitter(timber, random, JITTER.spar),
    );
    for (const side of [1, -1] as const) {
      const x = fifeStanchionX(fife, side);
      // **A stanchion stands ON the deck; it does not run through it.** This was
      // `fife.y - halfSpan * 0.1 - 1.02` — a length chosen to be comfortably
      // longer than the 0.94 m rail height, so the foot would certainly reach
      // the planking whatever the camber did. It reached 0.15 m past it. That
      // cost nothing while the deck was the bottom of the world, and the moment
      // there were rooms under it the two stanchions of each rail came through
      // the deckhead as a pair of pegs hanging in the air — the main rail's into
      // the companionway landing, the fore rail's into the forecastle. Ash saw
      // both from below before anything here reported a fault.
      //
      // Asked of the deck at the stanchion's own (x, z), so the camber is in it
      // and the foot lands on planking rather than near it.
      const foot = deckStandAt(x, fife.z);
      addTube(
        out.get('spar'),
        v3(x, foot ? foot.y : fife.y - FIFE_HEIGHT_ABOVE_DECK, fife.z),
        v3(x, fife.y, fife.z),
        0.05,
        0.045,
        6,
        1,
        jitter(timber, random, JITTER.spar),
      );
    }
    // One pin per position, per side. This used to walk `i` across the *whole*
    // rail and then mirror `|x|`, which draws the outboard pair twice and the
    // inboard pair twice — eight pin meshes standing in four places. `fifePinX`
    // is the one description of where a pin is, and the rope that belays to a
    // pin asks the same function.
    for (let i = 0; i < fife.pins; i++) {
      for (const side of [1, -1] as const) {
        addBelayingPin(out, v3(fifePinX(fife, i, side), fife.y, fife.z), timber, random);
      }
    }
  }

  // Iron horses across the deck, which the boom sheets travel on.
  //
  // One bent bar, not three pieces butted together. A horse is a single rod
  // taken to a forge: it stands off the deck on its two ends, turns through a
  // right angle at each and arches across between them. Drawn as a bar plus two
  // legs it has visible mitre joints at the corners where no joint exists —
  // "crude corners", which is exactly what they are.
  for (const horse of SHEET_HORSES) {
    const colour = jitter(iron, random, JITTER.ironwork);
    addBentBar(out.get('ironwork'), horsePath(horse), HORSE_RADIUS, colour);
  }
}

/**
 * The fittings that follow the live state, drawn between the two halves of
 * the deck ironwork so the draw order — and the colour stream with it — is
 * exactly what it was when this was one builder.
 *
 * Both of these hang off things that move: a headsail's bullseye is on
 * whichever side the clew is sheeted to, and `RIG_BLOCKS` includes the peak
 * halyard's block on the main gaff and the main sheet's bail on the boom.
 */
function buildMovingFittings(out: RigBuilders, random: SeededRandom): void {
  const iron = rgbOf(RIG_PALETTE.ironwork);

  /**
   * The bullseyes the headsail sheets turn through on the rail.
   *
   * A rope changes direction at a *thing*. Without these the turn was a bare
   * vertex on the caprail and the sheets read as vanishing into it.
   */
  for (const name of SHEET_FAIRLEADS) {
    const seat = rigNode(name);
    addBox(
      out.get('ironwork'),
      v3(seat.x, seat.y - 0.02, seat.z),
      v3(0.055, 0.045, 0.075),
      jitter(iron, random, JITTER.ironwork),
    );
  }

  buildRunningBlocks(out, random);
}

/** The rest of the deck ironwork: masthead eyes and the traveller blocks. */
function buildFixedFittings(out: RigBuilders, random: SeededRandom): void {
  const iron = rgbOf(RIG_PALETTE.ironwork);
  buildMastheadEyes(out, random);

  /**
   * The traveller blocks. Without these the boom sheets turn on nothing: two
   * rope segments meeting at a shared point read as two ropes ending at a
   * corner, which is exactly how it looked.
   *
   * A shackle gripping the bar, and a block hung under it whose sheave is the
   * point both parts of the sheet run to.
   */
  for (const block of SHEET_BLOCKS) {
    const colour = jitter(iron, random, JITTER.ironwork);
    // The shackle: from the bar down to the block's crown.
    addTube(
      out.get('ironwork'),
      v3(0, block.shackleY, block.z),
      v3(0, block.y + 0.055, block.z),
      0.017,
      0.014,
      6,
      1,
      colour,
    );
    // The block's shell, standing fore-and-aft so the sheave lies in the plane
    // the sheet works in.
    addBox(
      out.get('ironwork'),
      v3(0, block.y, block.z),
      v3(0.052, 0.115, 0.078),
      colour,
    );
  }
}


/**
 * The point on the nearest spar's surface that a block is strapped to.
 *
 * Derived rather than authored: `RIG_BLOCKS` says a node is a block, and the
 * spars say what is close enough to hang it from. So moving a masthead, or
 * swinging a gaff, carries its blocks with it — the alternative is a second copy
 * of where the timber is, which is the fault this whole file exists to avoid.
 */
function nearestSparSurface(p: Vec3): { point: Vec3; gap: number } {
  let best = { point: p, gap: Infinity };
  for (const spar of SPARS) {
    const ax = spar.head.x - spar.heel.x;
    const ay = spar.head.y - spar.heel.y;
    const az = spar.head.z - spar.heel.z;
    const l2 = ax * ax + ay * ay + az * az;
    if (l2 < 1e-9) continue;
    let t = ((p.x - spar.heel.x) * ax + (p.y - spar.heel.y) * ay + (p.z - spar.heel.z) * az) / l2;
    t = Math.min(Math.max(t, 0), 1);
    const cx = spar.heel.x + ax * t;
    const cy = spar.heel.y + ay * t;
    const cz = spar.heel.z + az * t;
    const distance = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
    const radius = spar.heelRadius + (spar.headRadius - spar.heelRadius) * t;
    const gap = distance - radius;
    if (gap >= best.gap) continue;
    // Walk out from the axis toward the block, and stop on the timber's surface.
    const k = distance > 1e-6 ? radius / distance : 0;
    best = {
      point: v3(cx + (p.x - cx) * k, cy + (p.y - cy) * k, cz + (p.z - cz) * k),
      gap,
    };
  }
  return best;
}

/**
 * The blocks that running rigging turns and terminates on.
 *
 * Each is a shell with its sheave at the node the rope actually addresses, and a
 * strop from the spar it is strapped to. **The strop is the point.** A block
 * drawn without one is a fitting floating beside a mast, which is the same fault
 * as no block at all — and the M2 round rejected an earlier offset peak halyard
 * for exactly that, calling it "a turn in mid-air". A rope ends at the sheave,
 * the sheave is in a shell, the shell hangs on a strop, and the strop is seized
 * round timber.
 */
function buildMastheadEyes(out: RigBuilders, random: () => number): void {
  for (const name of MASTHEAD_EYES) {
    const node = toVec3(rigNode(name));
    const anchor = nearestSparSurface(node);
    const colour = jitter(rgbOf(RIG_PALETTE.ironwork), random, JITTER.ironwork);
    // The seizing: an iron band round the masthead at the eye's own height,
    // taken from the spar's surface rather than from a second guess at where the
    // stick is. Short and thick, because that is what a strop round a masthead
    // looks like from the deck.
    addTube(out.get('ironwork'), anchor.point, node, 0.026, 0.020, 6, 1, colour);
    addBox(out.get('ironwork'), node, v3(0.028, 0.045, 0.045), colour);
  }
}

function buildRunningBlocks(out: RigBuilders, random: () => number): void {
  for (const name of RIG_BLOCKS) {
    const node = toVec3(rigNode(name));
    const anchor = nearestSparSurface(node);
    const ironColour = jitter(rgbOf(RIG_PALETTE.ironwork), random, JITTER.ironwork);
    const shellColour = jitter(rgbOf(RIG_PALETTE.spar), random, JITTER.spar);

    // The strop, from the timber to the shell's crown. Short by construction:
    // the block hangs where the rope needs it, which is a hand off the spar.
    const crown = v3(
      node.x + (anchor.point.x - node.x) * 0.42,
      node.y + (anchor.point.y - node.y) * 0.42 + 0.055,
      node.z + (anchor.point.z - node.z) * 0.42,
    );
    addTube(out.get('ironwork'), anchor.point, crown, 0.014, 0.012, 5, 1, ironColour);
    // The shell: elm, iron-bound, hanging under the strop with the sheave at the
    // node. Half the traveller block's size — these are halyard and sheet blocks
    // aloft, not the main sheet's.
    addBox(out.get('spar'), v3(node.x, node.y, node.z), v3(0.042, 0.085, 0.055), shellColour);
    addTube(
      out.get('ironwork'),
      v3(node.x, node.y + 0.085, node.z),
      v3(node.x, node.y + 0.055, node.z),
      0.013,
      0.011,
      5,
      1,
      ironColour,
    );
  }
}

/**
 * The centreline of a sheet horse, as one path from deck to deck.
 *
 * Up the port leg, round the shoulder, across the arch — which dips
 * `HORSE_SAG` at midspan so a travelling block does not have to climb as the
 * boom swings out — round the other shoulder and down. The corners are quarter
 * arcs of `HORSE_CORNER`, which is what a rod of this size can actually be bent
 * to without collapsing its section.
 */
function horsePath(horse: SheetHorse): Vec3[] {
  const CORNER = 0.09;
  const ARCH_STEPS = 14;
  const CORNER_STEPS = 4;
  const footY = horse.y - 0.34;
  const half = horse.halfSpan;
  const path: Vec3[] = [];

  const archY = (t: number): number => horse.y - HORSE_SAG * 4 * t * (1 - t);
  const inner = Math.max(half - CORNER, 0);

  path.push(v3(-half, footY, horse.z));
  path.push(v3(-half, horse.y - CORNER, horse.z));
  for (let i = 1; i <= CORNER_STEPS; i++) {
    const a = (i / CORNER_STEPS) * (Math.PI / 2);
    path.push(
      v3(
        -half + CORNER * (1 - Math.cos(a)),
        horse.y - CORNER * (1 - Math.sin(a)),
        horse.z,
      ),
    );
  }
  for (let i = 1; i < ARCH_STEPS; i++) {
    const u = i / ARCH_STEPS;
    const x = -inner + 2 * inner * u;
    path.push(v3(x, archY((x + half) / (2 * half)), horse.z));
  }
  for (let i = 0; i <= CORNER_STEPS; i++) {
    const a = (Math.PI / 2) * (1 - i / CORNER_STEPS);
    path.push(
      v3(
        half - CORNER * (1 - Math.cos(a)),
        horse.y - CORNER * (1 - Math.sin(a)),
        horse.z,
      ),
    );
  }
  path.push(v3(half, footY, horse.z));
  return path;
}

/**
 * A rod of constant section swept along a path.
 *
 * Each joint is drawn as one ring shared by the segments either side of it, so
 * the metal is continuous through a corner instead of two tubes ending in the
 * same place. The ring's frame is carried along the path rather than rebuilt per
 * segment, which is what stops the section spinning about its own axis as the
 * path turns.
 */
function addBentBar(
  builder: SurfaceBuilder,
  path: readonly Vec3[],
  radius: number,
  colour: Rgb,
): void {
  if (path.length < 2) return;
  const SIDES = 8;

  const tangents: Vec3[] = path.map((_, i) => {
    const a = path[Math.max(i - 1, 0)];
    const b = path[Math.min(i + 1, path.length - 1)];
    return normalise(v3(b.x - a.x, b.y - a.y, b.z - a.z));
  });

  let { u, v } = frameFor(tangents[0]);
  const rings: Vec3[][] = [];
  const normals: Vec3[][] = [];
  const colours: Rgb[][] = [];

  for (let i = 0; i < path.length; i++) {
    const w = tangents[i];
    // Re-orthogonalise the carried frame against the new tangent: parallel
    // transport, so the section does not roll as the bar bends.
    const dot = u.x * w.x + u.y * w.y + u.z * w.z;
    u = normalise(v3(u.x - w.x * dot, u.y - w.y * dot, u.z - w.z * dot));
    v = v3(w.y * u.z - w.z * u.y, w.z * u.x - w.x * u.z, w.x * u.y - w.y * u.x);

    const ring: Vec3[] = [];
    const ringN: Vec3[] = [];
    const ringC: Rgb[] = [];
    for (let j = 0; j <= SIDES; j++) {
      const th = (j / SIDES) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const n = v3(u.x * c + v.x * s, u.y * c + v.y * s, u.z * c + v.z * s);
      ring.push(v3(path[i].x + n.x * radius, path[i].y + n.y * radius, path[i].z + n.z * radius));
      ringN.push(n);
      ringC.push(colour);
    }
    rings.push(ring);
    normals.push(ringN);
    colours.push(ringC);
  }
  // Wound the other way from the obvious: the ring runs anticlockwise about the
  // tangent, so the grid's own winding faces inward. `ship-rig.test.ts` checks
  // every face against its normal and said so.
  builder.addGrid(rings, normals, colours, true);
}

/** One belaying pin: a turned peg through a rail, with its head standing proud. */
function addBelayingPin(
  out: RigBuilders,
  seat: Vec3,
  timber: Rgb,
  random: () => number,
): void {
  addTube(
    out.get('spar'),
    v3(seat.x, seat.y - 0.16, seat.z),
    v3(seat.x, seat.y + 0.17, seat.z),
    0.019,
    0.016,
    6,
    2,
    jitter(timber, random, JITTER.spar),
  );
}

/**
 * Ratlines: the rungs seized across each shroud gang.
 *
 * A rung spans from the forward shroud to the after one at a constant height,
 * which means its two ends have to be found *on* those shrouds rather than at
 * their anchors — the shroud is a line from a channel seat up to the hounds, and
 * the rung meets it wherever that line crosses this height.
 */
function buildRatlines(out: RigBuilders, random: () => number): void {
  const base = rgbOf(RIG_PALETTE.rope);
  for (const rung of RATLINES) {
    const mast = rung.name.startsWith('main') ? 'main' : 'fore';
    const hounds = rigNode(`${mast}Hounds`);
    const a = pointOnShroud(rigNode(rung.fromShroud), hounds, rung.y);
    const b = pointOnShroud(rigNode(rung.toShroud), hounds, rung.y);
    if (!a || !b) continue;
    addTube(
      out.get('rope'),
      a,
      b,
      RATLINE_DIAMETER / 2,
      RATLINE_DIAMETER / 2,
      ROPE_SIDES,
      2,
      jitter(base, random, JITTER.rope),
      // A rung stood on sags; one that does not reads as a ladder rather than
      // as rope.
      (t: number) => v3(0, -0.022 * 4 * t * (1 - t), 0),
      // Uncapped: both ends are seized to a shroud, and there are 78 of them.
      false,
    );
  }
}

function pointOnShroud(foot: RigPoint, head: RigPoint, y: number): Vec3 | null {
  const span = head.y - foot.y;
  if (Math.abs(span) < 1e-6) return null;
  const t = (y - foot.y) / span;
  if (t < 0 || t > 1) return null;
  return v3(
    foot.x + (head.x - foot.x) * t,
    y,
    foot.z + (head.z - foot.z) * t,
  );
}

/**
 * The M5 lookout: the planking, the lifelines and the futtock shrouds.
 *
 * Appended to `LOFT_STEPS` at the very end rather than filed beside the
 * crosstrees it stands on, and the reason is `seedStates()`. That table records
 * where the shared colour stream stands as each builder begins; inserting a step
 * in the middle shifts every later builder's position in it, which re-jitters
 * the timber, the rope and the cloth by a few percent of lightness. A cosmetic
 * shuffle, but a free one to avoid — the draw order of opaque geometry does not
 * matter, so the new work goes on the end.
 */
function buildLookout(out: RigBuilders, random: () => number): void {
  const base: Record<LookoutRegion, Rgb> = {
    spar: rgbOf(RIG_PALETTE.spar),
    rope: rgbOf(RIG_PALETTE.rope),
    ironwork: rgbOf(RIG_PALETTE.ironwork),
  };
  for (const solid of lookoutSolids()) {
    const colour = jitter(base[solid.region], random, JITTER[solid.region]);
    const builder = out.get(solid.region);
    if (solid.kind === 'box') {
      addBox(builder, solid.centre, solid.half, colour);
    } else {
      addTube(builder, solid.a, solid.b, solid.radius, solid.radius, ROPE_SIDES, 2, colour);
    }
  }
}

// --- sails -------------------------------------------------------------------

/** Grid resolution across and down a sail. */
const SAIL_U = 14;
const SAIL_V = 12;

/**
 * Where the deepest part of the draft sits, as a fraction of the chord from the
 * luff.
 *
 * About 40%, which is where a working sail of flax actually bellies. Further
 * forward reads as a modern racing cut; further aft reads as a sail that has
 * blown out.
 *
 * This is the fore-and-aft number and the pre-M6 one; `ClothCut.draftPosition`
 * now carries it per cut, because a square sail's chord runs from one leech to
 * the other and has no luff to be 40% aft of (see `CLOTH_CUTS`).
 */
const DRAFT_POSITION = 0.4;

function draftProfileAt(u: number, position: number): number {
  // sin(pi * u^k) peaks where u^k = 0.5, so k is chosen to put the peak at
  // `position` rather than at the middle.
  const k = Math.log(0.5) / Math.log(position);
  return Math.sin(Math.PI * Math.pow(Math.min(Math.max(u, 0), 1), k));
}

/** Vertical falloff: full through the body, pinned at head and foot. */
function heightProfile(v: number): number {
  return Math.pow(Math.sin(Math.PI * Math.min(Math.max(v, 0), 1)), 0.55);
}

/** Derivative of `draftProfileAt` — the analytic form of the u tangent's belly. */
function draftSlopeAt(u: number, position: number): number {
  const k = Math.log(0.5) / Math.log(position);
  const t = Math.min(Math.max(u, 0), 1);
  return Math.cos(Math.PI * Math.pow(t, k)) * Math.PI * k * Math.pow(t, k - 1);
}

/** Derivative of `heightProfile`. */
function heightSlope(v: number): number {
  const t = Math.min(Math.max(v, 0), 1);
  return (
    0.55 * Math.pow(Math.sin(Math.PI * t), -0.45) * Math.PI * Math.cos(Math.PI * t)
  );
}

/**
 * The profiles, sampled once for the grid every sail is lofted on.
 *
 * `u` and `v` only ever take the values `j / SAIL_U` and `i / SAIL_V`, and the
 * profiles are the same functions for every sail on every rebuild — so the
 * `sin`/`pow` work is done once at module load rather than five times per
 * vertex per re-loft. The `*_AT` pair is sampled at the true grid point (the
 * cloth's position); the `*_SLOPE` pair at the same point pulled just inside
 * the patch, because a tangent taken exactly on the boundary — or at the
 * collapsed head of a triangular headsail — has no surface to measure.
 *
 * M6 adds four more mode shapes on the same footing. Every one of them is a
 * separable product of a u profile and a v profile, which is the whole reason
 * the inner loop stays multiply-add: the cloth got a great deal more shape and
 * did not get a single new `sin` per vertex.
 */
const SAMPLE_INSET = 8e-3;

function tabulate(n: number, f: (t: number) => number, inset: number): Float64Array {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out[i] = f(Math.min(Math.max(t, inset), 1 - inset));
  }
  return out;
}

const HEIGHT_AT = tabulate(SAIL_V, heightProfile, 0);
const HEIGHT_SLOPE = tabulate(SAIL_V, heightSlope, SAMPLE_INSET);
const HEIGHT_AT_INSET = tabulate(SAIL_V, heightProfile, SAMPLE_INSET);
const U_INSET = tabulate(SAIL_U, (t) => t, SAMPLE_INSET);
const V_INSET = tabulate(SAIL_V, (t) => t, SAMPLE_INSET);

// --- the M6 mode shapes ------------------------------------------------------
//
// Each is zero at all four corners, which is not a nicety: the corners are
// where the rig bends the cloth to a spar, a stay or a sheet, and `rig.ts`
// owns them. A mode that moved a corner would be the cloth inventing its own
// attachment point, and `ship-rig-cloth.test.ts` asserts it never happens.

/** Weight toward the leech: 0 on the luff, 1 on the leech. */
const LEECH_POWER = 2.5;
/** Weight toward the luff: 1 on the luff, 0 on the leech. */
const LUFF_POWER = 2;
/** Weight toward the foot: 0 at the head, 1 at the foot. */
const FOOT_POWER = 3;
/** Weight toward the leech for flogging cloth. */
const SHAKE_POWER = 1.5;
/** Wavelengths of flogging across the chord. */
const SHAKE_WAVES = 1.6;

const leechProfile = (u: number): number => Math.pow(u, LEECH_POWER);
const leechSlope = (u: number): number => LEECH_POWER * Math.pow(u, LEECH_POWER - 1);
/**
 * Twist's height weight: the *upper* leech falls off to leeward and the lower
 * one does not, because the boom (or the clew's own sheet) holds the foot
 * where it is. `H(v)·(1 − v)` is zero at the head corner, zero at the foot,
 * and peaks about a third of the way down.
 */
const twistHeight = (v: number): number => heightProfile(v) * (1 - v);
const twistHeightSlope = (v: number): number =>
  heightSlope(v) * (1 - v) - heightProfile(v);
const luffProfile = (u: number): number => Math.pow(1 - u, LUFF_POWER);
const luffSlopeProfile = (u: number): number =>
  -LUFF_POWER * Math.pow(1 - u, LUFF_POWER - 1);
const footProfile = (v: number): number => Math.pow(v, FOOT_POWER);
const footSlopeProfile = (v: number): number => FOOT_POWER * Math.pow(v, FOOT_POWER - 1);
const shakeEnvelope = (u: number): number => Math.pow(u, SHAKE_POWER);
const shakeEnvelopeSlope = (u: number): number =>
  SHAKE_POWER * Math.pow(u, SHAKE_POWER - 1);

const LEECH_AT = tabulate(SAIL_U, leechProfile, 0);
const LEECH_SLOPE = tabulate(SAIL_U, leechSlope, SAMPLE_INSET);
const LEECH_AT_INSET = tabulate(SAIL_U, leechProfile, SAMPLE_INSET);
const TWIST_V_AT = tabulate(SAIL_V, twistHeight, 0);
const TWIST_V_SLOPE = tabulate(SAIL_V, twistHeightSlope, SAMPLE_INSET);
const TWIST_V_AT_INSET = tabulate(SAIL_V, twistHeight, SAMPLE_INSET);
const LUFF_AT = tabulate(SAIL_U, luffProfile, 0);
const LUFF_SLOPE = tabulate(SAIL_U, luffSlopeProfile, SAMPLE_INSET);
const LUFF_AT_INSET = tabulate(SAIL_U, luffProfile, SAMPLE_INSET);
const FOOT_AT = tabulate(SAIL_V, footProfile, 0);
const FOOT_SLOPE = tabulate(SAIL_V, footSlopeProfile, SAMPLE_INSET);
const FOOT_AT_INSET = tabulate(SAIL_V, footProfile, SAMPLE_INSET);
const SHAKE_ENV_AT = tabulate(SAIL_U, shakeEnvelope, 0);
const SHAKE_ENV_SLOPE = tabulate(SAIL_U, shakeEnvelopeSlope, SAMPLE_INSET);
const SHAKE_ENV_AT_INSET = tabulate(SAIL_U, shakeEnvelope, SAMPLE_INSET);
/**
 * The flogging wave's `sin` and `cos` across the chord, tabulated at a zero
 * phase. A live phase then costs one angle-sum per sail rather than one `sin`
 * per vertex: `sin(θ + φ) = sinθ·cosφ + cosθ·sinφ`.
 */
const SHAKE_SIN_AT = tabulate(SAIL_U, (u) => Math.sin(2 * Math.PI * SHAKE_WAVES * u), 0);
const SHAKE_COS_AT = tabulate(SAIL_U, (u) => Math.cos(2 * Math.PI * SHAKE_WAVES * u), 0);
const SHAKE_SIN_AT_INSET = tabulate(
  SAIL_U,
  (u) => Math.sin(2 * Math.PI * SHAKE_WAVES * u),
  SAMPLE_INSET,
);
const SHAKE_COS_AT_INSET = tabulate(
  SAIL_U,
  (u) => Math.cos(2 * Math.PI * SHAKE_WAVES * u),
  SAMPLE_INSET,
);

/**
 * One sail's chordwise draft tables — the only mode whose shape depends on the
 * cut, because a square sail's deepest point is in the middle of its width and
 * a fore-and-aft sail's is 40% aft of its luff.
 */
interface DraftTables {
  readonly at: Float64Array;
  readonly slope: Float64Array;
  readonly atInset: Float64Array;
}

const draftTablesByPosition = new Map<number, DraftTables>();

function draftTables(position: number): DraftTables {
  let tables = draftTablesByPosition.get(position);
  if (!tables) {
    tables = {
      at: tabulate(SAIL_U, (u) => draftProfileAt(u, position), 0),
      slope: tabulate(SAIL_U, (u) => draftSlopeAt(u, position), SAMPLE_INSET),
      atInset: tabulate(SAIL_U, (u) => draftProfileAt(u, position), SAMPLE_INSET),
    };
    draftTablesByPosition.set(position, tables);
  }
  return tables;
}

/** One sail's worth of grid, reused by every sail on every re-loft. */
const CLOTH_VERTS = (SAIL_U + 1) * (SAIL_V + 1) * 3;
const clothPositions = new Float64Array(CLOTH_VERTS);
const clothNormals = new Float64Array(CLOTH_VERTS);
const clothColours = new Float64Array(CLOTH_VERTS);
const clothPanels: Rgb[] = Array.from({ length: SAIL_U + 1 }, () => ({ r: 0, g: 0, b: 0 }));
const clothCorners = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
/** The first three of the same corners — a triangular sail's whole set. */
const clothTriangle = [clothCorners[0], clothCorners[1], clothCorners[2]];

/**
 * What one sail's wind is doing, as the physics already decided it (M6).
 *
 * Every field is *read*, never recomputed. `aoaDeg` and `luffing` come
 * straight off `SailAeroResult.perSail`; `cannotDraw` is the trimmer's own
 * sustained report from `crew/Trimmers.ts`. The cloth's job is to make these
 * legible, and the way to keep the picture and the physics from drifting
 * apart is for the picture to have no opinion of its own.
 */
export interface SailClothFlow {
  /** Signed angle of attack, degrees: positive drawing, negative aback. */
  aoaDeg: number;
  /** Apparent wind speed at this sail's centre of effort, m/s. */
  apparentSpeedMps: number;
  /** Fraction of dynamic pressure left after another sail's wind shadow. */
  blanketFactor: number;
  /** The hand at this sheet has reported he cannot make her draw. */
  cannotDraw: boolean;
}

/**
 * `PerSailForce.luffing` is deliberately NOT in this record.
 *
 * It is `sailLuffFactor(aoaDeg) < 0.5` — a boolean cut out of a continuous
 * curve. The cloth wants the curve, and it gets it by calling the aero's own
 * `sailLuffFactor` on the same `aoaDeg`. Carrying the boolean too would be a
 * second, coarser copy of a quantity the loft already has exactly, and the
 * first thing that happens to two copies of one quantity in this codebase is
 * that they stop agreeing.
 */
export function createSailClothFlow(): SailClothFlow {
  return { aoaDeg: 0, apparentSpeedMps: 0, blanketFactor: 1, cannotDraw: false };
}

/**
 * The live cloth state (M6) — flow per sail plus the presentation clock the
 * flogging phase is read off.
 */
export interface SailClothState {
  /** Per sail, by name. */
  flow: Readonly<Record<SailName, SailClothFlow>>;
  /** Presentation seconds. Only slatting cloth reads it. */
  elapsedSeconds: number;
  /**
   * False freezes the flogging phase — the `?cloth=still` arm of the A/B,
   * which exists so a cold-machine measurement can separate the cost of the
   * extra cloth shape from the cost of re-lofting on animation frames.
   */
  animate: boolean;
}

/**
 * The live rig state a loft can be asked to draw (S4). Absent, the loft
 * draws the authored pose — bit-identical to the pre-S4 build.
 *
 * `cloth` absent is the pre-M6 presentation, also bit-identical: that is the
 * `?cloth=flat` arm, and `ship-rig-cloth.test.ts` asserts the identity rather
 * than trusting this sentence.
 */
export interface RigLoftState {
  trims: Readonly<RigTrimAnglesRad>;
  hoists: Readonly<Record<SailName, number>>;
  cloth?: SailClothState;
}

/**
 * How a sail is cut, and therefore which of its edges can move.
 *
 * The M6 modes are not decoration bolted onto every sail equally — each one
 * exists because a particular edge of a particular sail is *free*. A gaff
 * mainsail is laced to a boom along its foot and hooped to the mast along its
 * luff, so neither of those edges can go anywhere; a jib is hanked to a wire
 * that sags and has a loose foot, so both do. Getting this table wrong shows
 * up as cloth doing something its own rigging forbids.
 */
interface ClothCut {
  /** Deepest draft, as a fraction of the chord from `u = 0`. */
  draftPosition: number;
  /** Upper-leech fall-off when eased right out, as a fraction of the draft. */
  twist: number;
  /** Luff bow to leeward at full load, as a fraction of the luff's length. */
  luffSag: number;
  /** Free-foot round at the foot, as a fraction of the draft. */
  foot: number;
  /** Flogging amplitude as a fraction of the chord. */
  shake: number;
  /**
   * A hard ceiling on how far any of this may carry the cloth off the flat
   * patch, metres. A rail, not a shape: the modes are independent and nothing
   * else stops them stacking. The sweep in `ship-rig-trim-envelope.test.ts`
   * is what proves the numbers, and the square topsail's is the tight one —
   * measured, its flat patch passes 0.094 m from the fore topmast, so its
   * cloth has almost no room *aft* whatever the wind is doing.
   */
  maxDepthM: number;
}

/**
 * The pre-M6 cut: draft and nothing else, at the fore-and-aft draft position.
 * Used for every sail when no cloth state is supplied, which is what makes
 * `?cloth=flat` byte-identical to what shipped.
 */
const LEGACY_CUT: ClothCut = Object.freeze({
  draftPosition: DRAFT_POSITION,
  twist: 0,
  luffSag: 0,
  foot: 0,
  shake: 0,
  maxDepthM: Infinity,
});

const CLOTH_CUTS: Readonly<Record<SailName, ClothCut>> = Object.freeze({
  // Boomed gaff sails: luff on mast hoops, foot laced to the boom. Only the
  // leech is free, so twist is the whole story and the sail cannot bag at
  // either edge.
  mainsail: Object.freeze({
    draftPosition: DRAFT_POSITION,
    twist: 0.45,
    luffSag: 0,
    foot: 0,
    shake: 0.07,
    maxDepthM: 1.6,
  }),
  foresail: Object.freeze({
    draftPosition: DRAFT_POSITION,
    twist: 0.45,
    luffSag: 0,
    foot: 0,
    shake: 0.08,
    maxDepthM: 1.1,
  }),
  // Headsails: hanked to a wire that sags to leeward under load, loose foot
  // between tack and clew, and the freest leech in the rig.
  foreStaysail: Object.freeze({
    draftPosition: 0.38,
    twist: 0.5,
    luffSag: 0.03,
    foot: 0.4,
    shake: 0.1,
    maxDepthM: 0.6,
  }),
  jib: Object.freeze({
    draftPosition: 0.38,
    twist: 0.5,
    luffSag: 0.03,
    foot: 0.4,
    shake: 0.1,
    maxDepthM: 0.65,
  }),
  flyingJib: Object.freeze({
    draftPosition: 0.38,
    twist: 0.55,
    luffSag: 0.035,
    foot: 0.4,
    shake: 0.11,
    maxDepthM: 0.8,
  }),
  /**
   * The square topsail, and the one sail whose draft position is NOT 40%.
   *
   * Its `u` runs starboard head to port head — both vertical edges are
   * leeches and it has no luff at all, so a draft peaked 40% of the way
   * across it was a symmetric sail bellied asymmetrically. Pre-M6 it was, and
   * you can see the skew on the flat drawing once you know to look for it.
   *
   * Its aback belly is the small number in `SAIL_CLOTH_SHAPE`, on purpose.
   * Measured, the flat patch clears the fore topmast by 0.094 m; a backed
   * square sail lies flat against the mast and top rather than bagging aft,
   * which is both what the rig permits and what the sail actually does.
   */
  foreTopsail: Object.freeze({
    draftPosition: 0.5,
    twist: 0.2,
    luffSag: 0,
    foot: 0.25,
    shake: 0.05,
    maxDepthM: 0.6,
  }),
  mainTopmastStaysail: Object.freeze({
    draftPosition: 0.4,
    twist: 0.45,
    luffSag: 0.02,
    foot: 0.35,
    shake: 0.09,
    maxDepthM: 0.5,
  }),
  // Set flying above the mainsail and sheeted hard; its foot lies along the
  // gaff, so the foot mode is small and the belly falls across the one
  // direction it has no room in (see `SAILS`).
  mainGaffTopsail: Object.freeze({
    draftPosition: 0.4,
    twist: 0.3,
    luffSag: 0.015,
    foot: 0.15,
    shake: 0.07,
    maxDepthM: 0.45,
  }),
});

/**
 * Dynamic pressure, in m/s of apparent wind, at which load-driven shapes are
 * fully developed. Half a gale over the deck; below it the stay sags less and
 * the cloth flogs more gently, which is the difference between a light-airs
 * day and a hard one.
 */
const FULL_LOAD_MPS = 10;
/**
 * The most attached the cloth may be drawn while the hand at that sheet is
 * reporting he cannot make her draw.
 *
 * `cannotDraw` is a *sustained* verdict — he has hauled three times and the
 * rope will not go any further — so this sail is not going to fill, whatever
 * the instantaneous angle of attack happens to be at the moment the loft
 * looks. Capping attachment is the one coherent way to draw that: the draft
 * comes off and the shake comes on out of a single number, so the two cannot
 * disagree about how unsettled the sail is.
 *
 * 0.5 exactly, because that is `PerSailForce.luffing`'s own threshold. The
 * crew's verdict pins the cloth at the aero's luffing boundary at best, and
 * leaves it alone wherever it is already worse than that.
 *
 * A GAIN ON THE SHAKE WAS TRIED FIRST AND IS A TRAP. Shake is `1 − attach`,
 * so it is already saturated at 1 everywhere inside the luff band — which is
 * exactly the set of states this report is raised in. Multiplying it changed
 * nothing at all in the only cases that mattered, and the test that caught it
 * (`flogs harder once the hand has given her up`) failed with 0.3 against 0.3.
 */
const CANNOT_DRAW_ATTACH_CAP = 0.5;
/** Flogging frequency of a one-metre chord, Hz; longer cloth flogs slower. */
const SHAKE_HZ_AT_1M = 2.4;

function smoothstepLocal(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Per-sail loft parameters derived from the live state. */
export interface SailLoftLive {
  hoistFraction: number;
  side: 1 | -1;
  camberScale: number;
  /** M6: which edges may move, and by how much. */
  cut: ClothCut;
  /**
   * Signed multiplier on the design camber. Positive is a drawing sail
   * bellied to leeward; negative is an aback one pressed the other way. It is
   * the aero's own attachment factor, so the cloth fills and empties on
   * exactly the curve the lift does.
   */
  draftScale: number;
  /** Upper-leech fall-off, 0..1 of the cut's twist. */
  twist: number;
  /** Foot round as a fraction of the draft. */
  footScale: number;
  /**
   * Luff bow to leeward as a fraction of the luff's own length, signed with
   * `draftScale`. Metres only once `sailPatch` knows how long the luff is.
   */
  luffSagFraction: number;
  /** Flogging amplitude as a fraction of the chord. Zero for steady cloth. */
  shakeFraction: number;
  /** Presentation seconds the flogging phase is read off; frozen at 0 still. */
  shakeTimeSeconds: number;
}

/** Exported so the trim-envelope tests measure exactly the drawn cloth. */
export function sailLoftLive(sail: Sail, state: RigLoftState): SailLoftLive {
  const trimRad =
    sail.name === 'mainGaffTopsail'
      ? state.trims.mainsail
      : state.trims[sail.name as keyof RigTrimAnglesRad];
  const trimDeg = (trimRad * 180) / Math.PI;
  const camberScale = sailCamberScale(sail.name, trimDeg);
  const hoistFraction = state.hoists[sail.name];
  const side = liveSailSide(sail, trimDeg);
  const flow = state.cloth?.flow[sail.name];
  if (!flow) {
    return {
      hoistFraction,
      side,
      camberScale,
      cut: LEGACY_CUT,
      draftScale: 1,
      twist: 0,
      footScale: 0,
      luffSagFraction: 0,
      shakeFraction: 0,
      shakeTimeSeconds: 0,
    };
  }
  const cut = CLOTH_CUTS[sail.name];
  // The two shape numbers live in `sailAero` now, because the coefficient
  // block reads them too: the drawn belly and CLmax must agree about how
  // full this sail is (SHIP_RIG_HANDOVER §11.6, closed by the S6c round).
  const shape = SAIL_CLOTH_SHAPE[sail.name];
  const hardness = sailSheetHardness(sail.name, trimDeg);

  // The wind this sail actually stands in: its own apparent speed, discounted
  // by whatever is blanketing it. A staysail dead behind the foresail on a run
  // is in half the pressure and goes soft, which is the thing you can see.
  const effectiveMps =
    flow.apparentSpeedMps * Math.sqrt(Math.max(flow.blanketFactor, 0));

  // Attachment: the aero's own curve, not a second one shaped like it. A sail
  // that carries no lift carries no belly, on the same degrees of AoA — and
  // the crew's sustained verdict caps it, because a sail the hand has given up
  // on is not about to fill just because this instant's AoA looks better.
  const attach = Math.min(
    sailLuffFactor(flow.aoaDeg),
    flow.cannotDraw ? CANNOT_DRAW_ATTACH_CAP : 1,
  );
  const abackFill = sailAbackFactor(flow.aoaDeg);
  // Cloth needs air in it to hold any shape at all. The floor is not physics,
  // it is the absence of one: a becalmed sail hangs in vertical folds and
  // nothing here models that, so it keeps a soft bag rather than going to a
  // geometric plane. See the handover's owed list.
  const fill = Math.max(smoothstepLocal(0.5, 3, effectiveMps), 0.15);
  const draftScale =
    fill * (attach * (1 - shape.flatten * hardness) - abackFill * shape.aback);

  // Load-driven shapes. A stay only sags when something is pulling on it, and
  // it pulls as the square of the wind.
  const windFraction = Math.min(effectiveMps / FULL_LOAD_MPS, 1);
  const load = attach * windFraction * windFraction;

  // Flogging lives in the band between drawing and firmly aback: cloth that is
  // neither holding shape nor pressed against anything is the cloth that
  // shakes. The capped `attach` above carries the crew's verdict into this for
  // free — no second rule about abandoned sails.
  const shake = sailShakeFraction(
    flow.aoaDeg,
    flow.apparentSpeedMps,
    flow.blanketFactor,
    flow.cannotDraw,
  );

  return {
    hoistFraction,
    side,
    camberScale,
    cut,
    draftScale,
    twist: cut.twist * (1 - hardness),
    footScale: cut.foot,
    // Signed with the draft so a backed headsail's stay bows the other way.
    luffSagFraction: cut.luffSag * load * (draftScale < 0 ? -1 : 1),
    shakeFraction: cut.shake * shake,
    shakeTimeSeconds: state.cloth!.animate ? state.cloth!.elapsedSeconds : 0,
  };
}

function buildSails(out: RigBuilders, random: () => number, state?: RigLoftState): void {
  const base = rgbOf(RIG_PALETTE.sailcloth);
  for (const sail of SAILS) {
    addSail(out, sail, base, random, state ? sailLoftLive(sail, state) : undefined);
  }
}

/**
 * The bellied surface of a sail, as a function of `(u, v)` over `[0,1]²`.
 *
 * Exported, and it has to be. `ship-rig.test.ts` checks that no two sails share
 * space, and for a while it checked the flat quad through the four corners while
 * the renderer drew this — up to 0.63 m of camber away from it. A test that
 * measures a different object than the one on screen will pass while the thing
 * you can see is broken, and it did: the square topsail's belly reaches into the
 * headsails and the flat quads never touched.
 *
 * One description of one object, the same contract `hullForm.ts` holds with the
 * flotation model.
 */
export function sailSurface(
  sail: Sail,
  live?: SailLoftLive,
): (u: number, v: number) => Vec3 {
  const patch = sailPatch(sail, live);
  const { p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, p3x, p3y, p3z } = patch;
  const { nx, ny, nz, depth, draftPosition } = patch;
  const { twistM, footM, luffSagM, shakeM, shakeCos, shakeSin } = patch;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return (u: number, v: number): Vec3 => {
    const draft = draftProfileAt(u, draftPosition);
    const height = heightProfile(v);
    const wave = 2 * Math.PI * SHAKE_WAVES * u;
    const d =
      depth * draft * height +
      twistM * leechProfile(u) * twistHeight(v) +
      footM * draft * footProfile(v) +
      luffSagM * luffProfile(u) * height +
      shakeM *
        shakeEnvelope(u) *
        height *
        (Math.sin(wave) * shakeCos + Math.cos(wave) * shakeSin);
    return v3(
      lerp(lerp(p0x, p1x, u), lerp(p3x, p2x, u), v) + nx * d,
      lerp(lerp(p0y, p1y, u), lerp(p3y, p2y, u), v) + ny * d,
      lerp(lerp(p0z, p1z, u), lerp(p3z, p2z, u), v) + nz * d,
    );
  };
}

/** The four patch corners and every mode's amplitude — see `sailPatch`. */
interface SailPatch {
  p0x: number; p0y: number; p0z: number;
  p1x: number; p1y: number; p1z: number;
  p2x: number; p2y: number; p2z: number;
  p3x: number; p3y: number; p3z: number;
  /** Unit normal toward the leeward face — `sailAero.sailLeewardNormal`. */
  nx: number; ny: number; nz: number;
  /** Signed draft depth at the deepest point, metres. */
  depth: number;
  /** Where the draft peaks along the chord, this cut's number. */
  draftPosition: number;
  /** Upper-leech fall-off, metres, signed with the draft. */
  twistM: number;
  /** Free-foot round, metres, signed with the draft. */
  footM: number;
  /** Luff bow to leeward, metres, signed with the draft. */
  luffSagM: number;
  /** Flogging amplitude, metres. */
  shakeM: number;
  /** cos/sin of the flogging phase — the angle-sum the tables are turned by. */
  shakeCos: number;
  shakeSin: number;
}

const patchScratch: SailPatch = {
  p0x: 0, p0y: 0, p0z: 0,
  p1x: 0, p1y: 0, p1z: 0,
  p2x: 0, p2y: 0, p2z: 0,
  p3x: 0, p3y: 0, p3z: 0,
  nx: 0, ny: 0, nz: 0,
  depth: 0,
  draftPosition: DRAFT_POSITION,
  twistM: 0,
  footM: 0,
  luffSagM: 0,
  shakeM: 0,
  shakeCos: 1,
  shakeSin: 0,
};

const patchNormalScratch = { x: 0, y: 0, z: 0 };

/**
 * Resolve one sail to its four patch corners and its belly.
 *
 * Three corners or four. A headsail is a triangle, and it enters here as a
 * quad with its head doubled — head, head, clew, tack — so one patch routine
 * serves both and the `v = 0` row simply collapses.
 *
 * With a live state (S4), the corners read the trim-overlaid nodes (the caller
 * holds `applyRigTrim` open), gather with the hoist through the same
 * `gatherSailCorners` the physics uses, and the belly takes the live side and
 * the centreline camber ramp. Without one, this is the authored pose.
 *
 * Returns a shared scratch record, valid until the next call. Callers read it
 * out immediately; nothing holds onto it, because this runs eight times per
 * re-loft and a re-loft now runs every frame the rig is moving.
 */
function sailPatch(sail: Sail, live?: SailLoftLive): SailPatch {
  const c = clothCorners;
  for (let i = 0; i < sail.corners.length; i++) {
    const node = rigNode(sail.corners[i]);
    c[i].x = node.x;
    c[i].y = node.y;
    c[i].z = node.z;
  }
  const triangle = sail.corners.length === 3;
  if (live) {
    gatherSailCorners(sail.name, triangle ? clothTriangle : c, live.hoistFraction);
  }
  const side = live ? live.side : sail.side;
  const camberScale = live ? live.camberScale : 1;
  // head, head, clew, tack for a triangle; the authored order for a quad.
  const q0 = c[0];
  const q1 = triangle ? c[0] : c[1];
  const q2 = c[2];
  const q3 = triangle ? c[1] : c[3];

  const out = patchScratch;
  out.p0x = q0.x; out.p0y = q0.y; out.p0z = q0.z;
  out.p1x = q1.x; out.p1y = q1.y; out.p1z = q1.z;
  out.p2x = q2.x; out.p2y = q2.y; out.p2z = q2.z;
  out.p3x = q3.x; out.p3y = q3.y; out.p3z = q3.z;

  // The belly falls along the sail's LEEWARD NORMAL, and it is the aero's own
  // — `sailAero.sailLeewardNormal`, the same call the lift direction is built
  // from — taken at the patch's centre so the whole sail bellies one way
  // rather than reversing across a twist. Two copies of this cross product
  // existed until M6 and agreed only by maintenance.
  if (sailLeewardNormal(triangle ? clothTriangle : c, side, patchNormalScratch)) {
    out.nx = patchNormalScratch.x;
    out.ny = patchNormalScratch.y;
    out.nz = patchNormalScratch.z;
  } else {
    // A collapsed patch has no belly direction to give. `side` is kept in the
    // fallback so a degenerate pose is the same numbers it was before M6.
    out.nx = 0;
    out.ny = side;
    out.nz = 0;
  }

  // `cu` is the mid-height chord and `cv` the mid-chord hoist: the two lengths
  // every mode is scaled by, so a big sail's shapes are big.
  const cux = (q1.x + q2.x) * 0.5 - (q0.x + q3.x) * 0.5;
  const cuy = (q1.y + q2.y) * 0.5 - (q0.y + q3.y) * 0.5;
  const cuz = (q1.z + q2.z) * 0.5 - (q0.z + q3.z) * 0.5;
  const chord = Math.hypot(cux, cuy, cuz);
  const draftScale = live ? live.draftScale : 1;
  // Depth is measured ALONG the leeward normal, so `side` is already in the
  // direction and must not be in the magnitude as well.
  let depth = chord * sail.camber * camberScale * draftScale;

  if (!live || live.cut === LEGACY_CUT) {
    out.depth = depth;
    out.draftPosition = DRAFT_POSITION;
    out.twistM = 0;
    out.footM = 0;
    out.luffSagM = 0;
    out.shakeM = 0;
    out.shakeCos = 1;
    out.shakeSin = 0;
    return out;
  }

  // The luff is the q0→q3 edge: throat to gooseneck on a gaff sail, head to
  // tack on a headsail. Its own length is what a sagging stay bows by.
  const luffLength = Math.hypot(q3.x - q0.x, q3.y - q0.y, q3.z - q0.z);
  let twistM = depth * live.twist;
  let footM = depth * live.footScale;
  let luffSagM = luffLength * live.luffSagFraction;
  let shakeM = chord * live.shakeFraction;

  // THE RAIL. The modes are independent and nothing else stops them stacking
  // into cloth that reaches further off the flat patch than the rig has room
  // for. Scale the whole set down together rather than clipping one, so the
  // shape stays the shape it was and only gets smaller.
  const reach =
    Math.abs(depth) + Math.abs(twistM) + Math.abs(footM) + Math.abs(luffSagM) + shakeM;
  if (reach > live.cut.maxDepthM) {
    const scale = live.cut.maxDepthM / reach;
    depth *= scale;
    twistM *= scale;
    footM *= scale;
    luffSagM *= scale;
    shakeM *= scale;
  }

  out.depth = depth;
  out.draftPosition = live.cut.draftPosition;
  out.twistM = twistM;
  out.footM = footM;
  out.luffSagM = luffSagM;
  out.shakeM = shakeM;
  // A long sail flogs slower than a short one; the period goes as the square
  // root of the chord, the way any hanging length does.
  const phase =
    live.shakeTimeSeconds *
    2 *
    Math.PI *
    (SHAKE_HZ_AT_1M / Math.sqrt(Math.max(chord, 0.2)));
  out.shakeCos = Math.cos(phase);
  out.shakeSin = Math.sin(phase);
  return out;
}

/**
 * The spar or stay a sail gathers onto as it comes down, and how thick that
 * timber is at each end — the roll is a *sleeve* over it, so it has to know.
 *
 * Null for the flying kites that are handed and sent below rather than stowed
 * aloft (gaff topsail, fisherman). Those two genuinely have nowhere to gather:
 * they shrink onto their tacks and go.
 */
interface FurlLine {
  a: RigPoint;
  b: RigPoint;
  /** Radius of what the cloth is gathering onto, at each end. */
  coreA: number;
  coreB: number;
}

/** Radius of the wire a headsail is hanked to — thin, but not nothing. */
const STAY_CORE_RADIUS = 0.012;

function furlLine(sail: Sail): FurlLine | null {
  switch (sail.name) {
    case 'mainsail':
      return {
        a: rigNode('mainGooseneck'),
        b: rigNode('mainBoomEnd'),
        coreA: BOOM_R_MID,
        coreB: BOOM_R_END,
      };
    case 'foresail':
      return {
        a: rigNode('foreGooseneck'),
        b: rigNode('foreBoomEnd'),
        coreA: BOOM_R_MID,
        coreB: BOOM_R_END,
      };
    case 'foreStaysail':
    case 'jib':
    case 'flyingJib': {
      // Hanked to its stay, dropped: a roll along the lower third of the luff.
      const head = rigNode(sail.corners[0]);
      const tack = rigNode(sail.corners[1]);
      return {
        a: tack,
        b: {
          x: tack.x + (head.x - tack.x) * FURL_ALONG_LUFF,
          y: tack.y + (head.y - tack.y) * FURL_ALONG_LUFF,
          z: tack.z + (head.z - tack.z) * FURL_ALONG_LUFF,
        },
        coreA: STAY_CORE_RADIUS,
        coreB: STAY_CORE_RADIUS,
      };
    }
    case 'foreTopsail':
      // Clewed up: the cloth gathers along its own yard.
      return {
        a: rigNode('topsailClothHeadStarboard'),
        b: rigNode('topsailClothHeadPort'),
        coreA: YARD_CORE_RADIUS,
        coreB: YARD_CORE_RADIUS,
      };
    default:
      return null;
  }
}

/** How far up its luff a dropped headsail piles — the roll's length. */
const FURL_ALONG_LUFF = 0.35;

/** The topsail yard where the clewed-up cloth gathers on it. */
const YARD_CORE_RADIUS = 0.055;

/**
 * Effective thickness of loosely-gathered canvas, metres.
 *
 * The one number behind every furl bundle's size. A sail does not vanish as it
 * comes down — the cloth has to go somewhere, and where it goes is around the
 * spar under it, in a roll that thickens as more of the sail arrives. So the
 * roll is sized by *conserving the cloth*: area gathered so far, times this
 * thickness, is the volume wrapped along the stow line, and the outer radius
 * follows from the spar it is wrapped around.
 *
 * That is what makes the roll grow, and it is why there is no per-sail bundle
 * radius table — a big sail makes a fat roll because it is a big sail.
 *
 * 12 mm is well over canvas's own 1–2 mm and deliberately so: a furled sail is
 * loose folds with air between them, not a wound bolt of cloth. It puts the
 * mainsail's finished roll at about 0.18 m radius on an 8.6 m boom, which is
 * the sausage you see along a gaff boom in any harbour photograph. Tune it by
 * eye; nothing else depends on it.
 */
const FURL_PACKED_THICKNESS_M = 0.012;

/** Clear air between the roll's skin and the spar inside it, metres. */
const FURL_CORE_CLEARANCE_M = 0.012;

/**
 * The roll's outer radius at one end, from the cloth gathered so far.
 *
 * Volume in, radius out: `π(r² − core²) · length` of cloth is wrapped around a
 * core of radius `core`. Below a whisker of gathered area the roll is nothing
 * but the gaskets, so it starts at the spar's own size and grows from there —
 * no pop.
 */
function furlRollRadius(
  gatheredAreaM2: number,
  rollLengthM: number,
  coreRadius: number,
): number {
  const crossSection = (gatheredAreaM2 * FURL_PACKED_THICKNESS_M) / Math.max(rollLengthM, 0.1);
  const core = coreRadius + FURL_CORE_CLEARANCE_M;
  return Math.sqrt(core * core + crossSection / Math.PI);
}

/** Corners for measuring the standing area of a sail at some hoist. */
const gatherScratch4 = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
const gatherScratch3 = gatherScratch4.slice(0, 3);
const gatherHoists = { mainsail: 1, foresail: 1 };

/**
 * How much cloth is IN the roll: exactly the cloth that is no longer in the
 * sail, `set area − standing area`, both measured the same way.
 *
 * THE PLACEHOLDER'S DISHONESTY, NAMED
 * -----------------------------------
 * This used to be `setArea · (1 − hoist)` — the assumption that a sail loses
 * its canvas in proportion to its halyard. No family aboard does:
 *
 * - a **headsail** shrinks toward its tack in BOTH directions at once, so its
 *   area goes as `hoist²`. At the first reef point the roll was taking a
 *   quarter of the cloth while the sail had given up nearly half of it, and
 *   17.7% of the jib and staysail's canvas was simply gone — measured, not
 *   estimated;
 * - the two **gaff sails** lose area as the gaff comes down toward the boom,
 *   which is slower than linear near the top: their rolls were ~12% too fat
 *   and their total canvas 5–6% too much;
 * - only the **square topsail**, whose clews rise straight to the yard, is
 *   close to linear, and it was the one that looked right.
 *
 * Subtracting the measured standing area is right for every family at once
 * and cannot drift when a family's gather rule changes, because it does not
 * know what the rule is. `ship-rig-cloth.test.ts` holds the sum to a stated
 * bound across the whole hoist range.
 *
 * Measured at the AUTHORED trims, deliberately. How much cloth is in the roll
 * is a question about how much halyard is out, not about where the sheet is —
 * and answering it from the posed graph would give this function a hidden
 * precondition (`applyRigTrim` held open at the same hoist) that a caller
 * could satisfy by accident and a test could miss. Swinging a boom rotates a
 * sail; it does not resize it.
 */
export function gatheredClothAreaM2(sail: Sail, hoistFraction: number): number {
  const setArea =
    SAIL_AERO_GEOMETRY.find((g) => g.name === sail.name)?.variants.starboard.set
      ?.areaM2 ?? 20;
  const hoist = Math.min(Math.max(hoistFraction, 0), 1);
  if (hoist <= 0) return setArea;
  if (hoist >= 1) return 0;
  // The standing area at this hoist, through the same corner constructors and
  // the same quad measure the frozen table itself was built with.
  const triangle = sail.corners.length === 3;
  const corners = triangle ? gatherScratch3 : gatherScratch4;
  gatherHoists.mainsail = sail.name === 'mainsail' ? hoist : 1;
  gatherHoists.foresail = sail.name === 'foresail' ? hoist : 1;
  liveSailCorners(sail.name, AUTHORED_TRIM_RAD, corners, gatherHoists);
  gatherSailCorners(sail.name, corners, hoist);
  return Math.max(setArea - sailQuadAreaM2(corners), 0);
}

/** The roll a sail has made of itself at one hoist — see `furlRollRadius`. */
export interface FurlRoll {
  a: RigPoint;
  b: RigPoint;
  lengthM: number;
  radiusA: number;
  radiusB: number;
  /** Radius of the spar or stay inside it, at each end. */
  coreA: number;
  coreB: number;
  /** How far the roll's middle droops between gaskets, metres. */
  sagM: number;
}

/**
 * Where a sail's gathered cloth is, and how thick, at a given hoist. Null for
 * the two kites, which are handed and sent below rather than stowed aloft.
 *
 * Exported so the rig suite can measure the roll against the spar it wraps —
 * a sleeve that lets the timber out through the top of it is exactly the
 * fault this replaced, and a picture is a poor way to keep checking.
 */
export function furlRoll(sail: Sail, hoistFraction: number): FurlRoll | null {
  const line = furlLine(sail);
  if (!line) return null;
  const lengthM = Math.hypot(
    line.b.x - line.a.x,
    line.b.y - line.a.y,
    line.b.z - line.a.z,
  );
  const gathered = gatheredClothAreaM2(sail, hoistFraction);
  const radiusA = furlRollRadius(gathered, lengthM, line.coreA);
  const radiusB = furlRollRadius(gathered, lengthM, line.coreB);
  return {
    a: line.a,
    b: line.b,
    lengthM,
    radiusA,
    radiusB,
    coreA: line.coreA,
    coreB: line.coreB,
    // The sag is a fraction of the cloth's own thickness over the spar, so a
    // thin new roll cannot droop far enough to let the timber out through the
    // top of it — which is what the old fixed 0.03 m did at the gooseneck,
    // where the boom is thickest.
    sagM: Math.min(radiusA - line.coreA, radiusB - line.coreB) * 0.35,
  };
}

function addSail(
  out: RigBuilders,
  sail: Sail,
  base: Rgb,
  random: () => number,
  live?: SailLoftLive,
): void {
  // Every sail draws exactly SAIL_U+1 cloth colours whatever state it is in,
  // so no other sail's panels shift when this one furls (the loft shares one
  // deterministic stream). The roll takes the first of them: a furled sail is
  // the same canvas as a set one.
  const panels = clothPanels;
  for (let j = 0; j <= SAIL_U; j++) panels[j] = jitter(base, random, JITTER.sailcloth);

  // The gathered cloth, from the first turn to the last.
  //
  // The roll used to appear only once the sail was fully struck, at a fixed
  // diameter, and Ash saw exactly what that is: cloth disappearing into thin
  // air and a white cylinder popping into existence at the end of it. A sail
  // coming down goes *somewhere*, and it is visible going there from the
  // first foot of halyard.
  if (live && live.hoistFraction < 1) {
    // The two kites are handed and sent below; they have no spar to gather on
    // and no business staying aloft. They shrink onto their tacks and go.
    const roll = furlRoll(sail, live.hoistFraction);
    if (roll) {
      addTube(
        out.get('sailcloth'),
        v3(roll.a.x, roll.a.y, roll.a.z),
        v3(roll.b.x, roll.b.y, roll.b.z),
        roll.radiusA,
        roll.radiusB,
        8,
        4,
        panels[0],
        // A lashed roll sags a little between gaskets.
        (t: number) => v3(0, -roll.sagM * 4 * t * (1 - t), 0),
        true,
      );
    }
  }

  if (live && live.hoistFraction <= HOIST_EPSILON) return; // struck: no cloth left

  // The bilinear patch and its belly, evaluated straight into the scratch
  // buffers. This runs every frame a sheet or a halyard is moving, so it
  // allocates nothing and calls no transcendental: the profile curves are
  // tabulated at module load (they are the same for every sail) and the
  // normals are the surface's own analytic ones.
  const patch = sailPatch(sail, live);
  const { p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z, p3x, p3y, p3z } = patch;
  const { nx, ny, nz, depth, twistM, footM, luffSagM, shakeM } = patch;
  const { shakeCos, shakeSin } = patch;
  const draft = draftTables(patch.draftPosition);
  const draftAt = draft.at;
  const draftAtInset = draft.atInset;
  const draftSlopeAtTable = draft.slope;
  const shakeWaveRate = 2 * Math.PI * SHAKE_WAVES;

  // du/dv of the flat bilinear patch: linear in the *other* parameter, so the
  // two edge differences are all that is needed.
  const eu0x = p1x - p0x, eu0y = p1y - p0y, eu0z = p1z - p0z; // head edge, in u
  const eu1x = p2x - p3x, eu1y = p2y - p3y, eu1z = p2z - p3z; // foot edge, in u
  const ev0x = p3x - p0x, ev0y = p3y - p0y, ev0z = p3z - p0z; // luff, in v
  const ev1x = p2x - p1x, ev1y = p2y - p1y, ev1z = p2z - p1z; // leech, in v

  for (let i = 0, k = 0; i <= SAIL_V; i++) {
    const v = i / SAIL_V;
    const hAt = HEIGHT_AT[i];
    const twistVAt = TWIST_V_AT[i];
    const footVAt = FOOT_AT[i];
    // Normals are sampled a little inside the patch. On a triangular headsail
    // the whole `v = 0` row is one point — the head — so a tangent taken there
    // is zero in u however it is measured, and the guard has to be about where
    // the normal is *sampled*, not which direction it steps in.
    const sv = V_INSET[i];
    const hIn = HEIGHT_AT_INSET[i];
    const hSlope = HEIGHT_SLOPE[i];
    const twistVIn = TWIST_V_AT_INSET[i];
    const twistVSlope = TWIST_V_SLOPE[i];
    const footVIn = FOOT_AT_INSET[i];
    const footVSlope = FOOT_SLOPE[i];
    for (let j = 0; j <= SAIL_U; j++, k += 3) {
      const u = j / SAIL_U;
      const dAt = draftAt[j];
      // The flogging wave at this station, phase-shifted by one angle-sum on
      // tabulated sin/cos rather than a `sin` per vertex.
      const waveAt = SHAKE_SIN_AT[j] * shakeCos + SHAKE_COS_AT[j] * shakeSin;
      // Position: bilinear corner blend, displaced along the leeward normal by
      // every mode at once.
      const fx = p0x + eu0x * u + (ev0x + (eu1x - eu0x) * u) * v;
      const fy = p0y + eu0y * u + (ev0y + (eu1y - eu0y) * u) * v;
      const fz = p0z + eu0z * u + (ev0z + (eu1z - eu0z) * u) * v;
      const d =
        depth * dAt * hAt +
        twistM * LEECH_AT[j] * twistVAt +
        footM * dAt * footVAt +
        luffSagM * LUFF_AT[j] * hAt +
        shakeM * SHAKE_ENV_AT[j] * hAt * waveAt;
      clothPositions[k] = fx + nx * d;
      clothPositions[k + 1] = fy + ny * d;
      clothPositions[k + 2] = fz + nz * d;

      // Tangents at the inset sample. The belly is the only thing giving a
      // sail its shading, and a flat normal throws all of it away.
      const su = U_INSET[j];
      const dIn = draftAtInset[j];
      const dSlope = draftSlopeAtTable[j];
      const waveIn = SHAKE_SIN_AT_INSET[j] * shakeCos + SHAKE_COS_AT_INSET[j] * shakeSin;
      const waveSlope =
        shakeWaveRate * (SHAKE_COS_AT_INSET[j] * shakeCos - SHAKE_SIN_AT_INSET[j] * shakeSin);
      const bu =
        depth * dSlope * hIn +
        twistM * LEECH_SLOPE[j] * twistVIn +
        footM * dSlope * footVIn +
        luffSagM * LUFF_SLOPE[j] * hIn +
        shakeM * hIn * (SHAKE_ENV_SLOPE[j] * waveIn + SHAKE_ENV_AT_INSET[j] * waveSlope);
      const bv =
        depth * dIn * hSlope +
        twistM * LEECH_AT_INSET[j] * twistVSlope +
        footM * dIn * footVSlope +
        luffSagM * LUFF_AT_INSET[j] * hSlope +
        shakeM * SHAKE_ENV_AT_INSET[j] * hSlope * waveIn;
      const ax = eu0x + (eu1x - eu0x) * sv + nx * bu;
      const ay = eu0y + (eu1y - eu0y) * sv + ny * bu;
      const az = eu0z + (eu1z - eu0z) * sv + nz * bu;
      const bx = ev0x + (ev1x - ev0x) * su + nx * bv;
      const by = ev0y + (ev1y - ev0y) * su + ny * bv;
      const bz = ev0z + (ev1z - ev0z) * su + nz * bv;
      let mx = ay * bz - az * by;
      let my = az * bx - ax * bz;
      let mz = ax * by - ay * bx;
      const length = Math.hypot(mx, my, mz);
      if (length > 1e-9) {
        mx /= length;
        my /= length;
        mz /= length;
      } else {
        mx = 0;
        my = 1;
        mz = 0;
      }
      clothNormals[k] = mx;
      clothNormals[k + 1] = my;
      clothNormals[k + 2] = mz;
    }
  }

  // Cloth-to-cloth variation, applied per column so it reads as panels: the
  // seams run up and down the sail, so the colour varies across it and not
  // along it. Drawn above, before the roll, so the stream is the same length
  // in every state.
  for (let j = 0; j <= SAIL_U; j++) {
    const panel = panels[j];
    for (let i = 0; i <= SAIL_V; i++) {
      const k = (i * (SAIL_U + 1) + j) * 3;
      clothColours[k] = panel.r;
      clothColours[k + 1] = panel.g;
      clothColours[k + 2] = panel.b;
    }
  }

  out
    .get('sailcloth')
    .addGridFlat(SAIL_V + 1, SAIL_U + 1, clothPositions, clothNormals, clothColours, true);
}

// --- assembly ----------------------------------------------------------------

/**
 * One builder in the loft, and whether a live state can move what it draws.
 *
 * S4 re-lofts the rig every frame a sheet or a halyard is moving, and most of
 * this ship cannot move: masts, tops, channels, deck fittings, standing
 * rigging and ratlines stand where they were bolted. Rebuilding them 60 times
 * a second was three quarters of the cost of the rebuild. The `live` flag is
 * the only thing separating the two, and `ship-rig.test.ts` *measures* it —
 * builds at two different live states and asserts the static half comes out
 * byte-identical — rather than trusting this table.
 */
interface LoftStep {
  readonly name: string;
  readonly live: boolean;
  readonly run: (out: RigBuilders, random: SeededRandom, state?: RigLoftState) => void;
}

const LOFT_STEPS: readonly LoftStep[] = [
  // The lower masts stand where they were stepped; see `isLowerMast` for why
  // they are both static and the most finely lofted timber aboard.
  { name: 'masts', live: false, run: buildMasts },
  // Booms, gaffs and yards swing and lower with the sails they carry.
  { name: 'spars', live: true, run: buildSpars },
  { name: 'mastCaps', live: false, run: buildMastCaps },
  { name: 'crosstrees', live: false, run: buildCrosstrees },
  { name: 'channels', live: false, run: buildChannels },
  { name: 'deckFittings', live: false, run: buildDeckFittings },
  { name: 'movingFittings', live: true, run: buildMovingFittings },
  { name: 'fixedFittings', live: false, run: buildFixedFittings },
  { name: 'standingRigging', live: false, run: buildStandingRigging },
  // Sheets and halyards are made fast to the things that move.
  { name: 'runningRigging', live: true, run: buildRunningRigging },
  { name: 'ratlines', live: false, run: buildRatlines },
  { name: 'sails', live: true, run: buildSails },
  // On the end deliberately — `buildLookout` says why.
  { name: 'lookout', live: false, run: buildLookout },
];

/**
 * Where the shared colour stream stands as each builder begins.
 *
 * A partial rebuild skips builders that sit between the live ones in the draw
 * order, so it has to put the generator back to the exact point each live
 * builder started at — otherwise the spars, ropes and cloth panels would be
 * repainted every frame. Every builder consumes a fixed number of draws
 * whatever the live state is (that is why the furled-sail path burns the
 * cloth's draws before returning), so these states are recorded once from the
 * authored pose and hold for every pose after it.
 */
let stepSeedStates: readonly number[] | null = null;

function seedStates(): readonly number[] {
  if (!stepSeedStates) {
    const random = makeRandom(RIG_SEED);
    const out = new RigBuilders();
    const states: number[] = [];
    for (const step of LOFT_STEPS) {
      states.push(random.state);
      step.run(out, random);
    }
    stepSeedStates = states;
  }
  return stepSeedStates;
}

/** The per-frame path's builders, kept so a re-loft allocates nothing. */
const liveBuilders = new RigBuilders();

function runLoftInto(
  out: RigBuilders,
  live: boolean | null,
  state: RigLoftState | undefined,
): void {
  // With a live state, the trim- and hoist-driven nodes move for the duration
  // of the loft (`applyRigTrim` mutates the shared node objects, so spars,
  // ropes, blocks and sail corners all follow) and are restored before
  // returning — module state never leaks. The PRNG restarts from the same
  // seed on every build and each sail consumes a fixed number of draws
  // regardless of its state, so a rebuilt rig keeps its colours: the same
  // pose always draws the same ship.
  const restore = state ? applyRigTrim(state.trims, state.hoists) : null;
  try {
    const random = makeRandom(RIG_SEED);
    const rewind = live === null ? null : seedStates();
    for (let i = 0; i < LOFT_STEPS.length; i++) {
      const step = LOFT_STEPS[i];
      if (live !== null && step.live !== live) continue;
      if (rewind) random.state = rewind[i];
      step.run(out, random, state);
    }
  } finally {
    restore?.();
  }
}

function runLoft(live: boolean | null, state: RigLoftState | undefined): RigGeometrySet {
  const out = new RigBuilders();
  runLoftInto(out, live, state);
  return out.finish();
}

/** The whole rig in one set of meshes — every builder, in draw order. */
export function buildRigGeometry(state?: RigLoftState): RigGeometrySet {
  return runLoft(null, state);
}

/** Only what a live trim or hoist can move: the swinging spars, the running
 * rigging made fast to them, and the cloth. This is the per-frame path. */
export function buildLiveRigGeometry(state?: RigLoftState): RigGeometrySet {
  return runLoft(true, state);
}

/** Only what it cannot: masts, tops, channels, fittings, shrouds, ratlines. */
export function buildStaticRigGeometry(state?: RigLoftState): RigGeometrySet {
  return runLoft(false, state);
}

/**
 * Re-loft the live half straight into the buffers already on the GPU.
 *
 * The allocation-free path, and the one the frame loop takes. A rebuild that
 * runs every frame while a sheet is easing cannot hand the collector three
 * megabytes a second — that showed up as a clean 0.6 ms median with a 6 ms
 * tail, which is a dropped frame in the middle of the motion it was meant to
 * smooth. Buffers are reused; the returned regions are the ones whose vertex
 * count changed (a sail crossing furled) and which the caller must swap.
 */
export function refreshLiveRigGeometry(
  state: RigLoftState,
  current: ReadonlyMap<RigRegion, THREE.BufferGeometry>,
): Map<RigRegion, THREE.BufferGeometry> {
  liveBuilders.reset();
  runLoftInto(liveBuilders, true, state);
  const replaced = new Map<RigRegion, THREE.BufferGeometry>();
  for (const region of liveBuilders.writeInto(current)) {
    const geometry = liveBuilders.geometryFor(region);
    if (geometry) replaced.set(region, geometry);
  }
  return replaced;
}
