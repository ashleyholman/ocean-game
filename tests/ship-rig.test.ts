import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyRigTrim,
  fifePinX,
  fifeStanchionX,
  AUTHORED_TRIM_RAD,
  BULWARK_PIN_RAILS,
  CHANNEL_SEATS,
  CROSSTREES,
  FIFE_RAILS,
  FOREMAST_Z,
  MAINMAST_Z,
  RATLINES,
  MASTHEAD_EYES,
  RIG_BLOCKS,
  RIG_TRIM_LIMITS,
  RUNNING_RIGGING,
  SAILS,
  SHEET_BLOCKS,
  SHEET_FAIRLEADS,
  SHEET_HORSES,
  SPARS,
  STANDING_RIGGING,
  chainPlateFoot,
  channelRootAt,
  liveSailCorners,
  foreBoomClearance,
  pinRailSeat,
  mainBoomClearance,
  mainBoomOverhang,
  mainTruckAboveWaterline,
  rigMassAudit,
  rigNode,
  sparLength,
  topsailForwardOfGaff,
} from '../src/vessel/schooner/rig';
import type {
  RigPoint,
  RigTrimAnglesRad,
  Sail,
  SailName,
  Spar,
} from '../src/vessel/schooner/rig';
import {
  buildLiveRigGeometry,
  buildRigGeometry,
  buildStaticRigGeometry,
  createSailClothFlow,
  furlRoll,
  riggingRunPoint,
  sailLoftLive,
  sailSurface,
} from '../src/vessel/schooner/rigGeometry';
import type {
  RigLoftState,
  SailClothFlow,
  SailClothState,
} from '../src/vessel/schooner/rigGeometry';
import { buildShipGeometry } from '../src/vessel/schooner/shipGeometry';
import { deckStandAt } from '../src/vessel/schooner/deckSurface';
import {
  BULWARK_THICKNESS,
  HALF_LENGTH,
  bulwarkOuterHalfBeam,
  counterStationZ,
  deckAtSideY,
  halfBreadthAt,
  railSection,
  walkingDeckY,
} from '../src/vessel/schooner/hullForm';

/**
 * The rig's acceptance tests.
 *
 * `docs/ship/SHIP_ROUND_HANDOVER.md` section 6 accepts M2 when "silhouette reads as a
 * topsail schooner at distance; perf budget still passing *with* ratlines;
 * hydrostatics re-verified". Only two of those three are assertable without eyes
 * and a GPU, and this file asserts what it can:
 *
 * - the geometric facts a topsail schooner's silhouette depends on;
 * - that no two sails occupy the same space;
 * - the draw-call and triangle budgets, with ratlines built;
 * - what the drawn spars weigh, against what `massModel.ts` assumed.
 *
 * THE INTERSECTION TESTS ARE THE POINT
 * ------------------------------------
 * The first sail plan had 30% of the fore staysail inside the foresail, the
 * gaff cutting through the square topsail, and three headsails 77% stacked on
 * one another — none of which was visible under real light and perspective,
 * where a sail passing through another reads as shading. A number caught every
 * one of them. Keep it that way: if a sail moves, this file is what says
 * whether it landed somewhere real.
 */

// --- geometry helpers --------------------------------------------------------

type V = { x: number; y: number; z: number };

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V, b: V): V => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Corners of a sail as a quad; a three-cornered sail doubles its head. */
function sailQuad(corners: readonly string[]): RigPoint[] {
  const c = corners.map(rigNode);
  return c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
}

function sailTriangles(corners: readonly string[]): [V, V, V][] {
  const [a, b, c, d] = sailQuad(corners);
  return [
    [a, b, c],
    [a, c, d],
  ];
}

/** The four edges a sail is actually bounded by — luff, head, leech, foot. */
function sailEdges(corners: readonly string[]): [V, V][] {
  const q = sailQuad(corners);
  const edges: [V, V][] = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1e-6) edges.push([a, b]);
  }
  return edges;
}

const len = (a: V): number => Math.hypot(a.x, a.y, a.z);

/** Shortest distance from a point to a segment, and where along it that falls. */
function pointToSegment(pt: V, a: V, b: V): { distance: number; t: number } {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  const t = denom < 1e-12 ? 0 : Math.min(Math.max(dot(sub(pt, a), ab) / denom, 0), 1);
  const near = { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t };
  return { distance: len(sub(pt, near)), t };
}

/**
 * Distance from a point to a spar's *surface*, allowing for its taper.
 *
 * Negative means inside the timber. The taper matters: a topmast is 0.095 m at
 * the heel and 0.052 m at the head, and taking the thicker figure everywhere
 * would report a collision 43 mm from where one is.
 */
function distanceToSpar(pt: V, spar: Spar): number {
  const { distance, t } = pointToSegment(pt, spar.heel, spar.head);
  return distance - (spar.heelRadius + (spar.headRadius - spar.heelRadius) * t);
}

const sparNamed = (name: string): Spar => SPARS.find((s) => s.name === name)!;

/**
 * The drawn surface of a sail, sampled on an `n × n` grid.
 *
 * Every clearance question in this file goes through here rather than through
 * the flat quad. Section 3.2 of the handover is about what happens when it does
 * not: the intersection test checked a flat quad through the corner nodes while
 * the renderer drew a cambered surface up to 0.63 m away from it, and passed
 * while the topsail visibly reached through both jibs.
 */
function sailPoints(sail: Sail, n = 24): V[] {
  const surface = sailSurface(sail);
  const out: V[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) out.push(surface(j / n, i / n));
  }
  return out;
}

/** Triangulate the exact live cloth surface a rope has to stay outside. */
function liveSailTriangles(
  sail: Sail,
  state: RigLoftState,
  n = 16,
): Array<[V, V, V]> {
  const surface = sailSurface(sail, sailLoftLive(sail, state));
  const points: V[][] = [];
  for (let v = 0; v <= n; v++) {
    points[v] = [];
    for (let u = 0; u <= n; u++) points[v][u] = surface(u / n, v / n);
  }
  const triangles: Array<[V, V, V]> = [];
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      triangles.push([points[v][u], points[v][u + 1], points[v + 1][u]]);
      triangles.push([
        points[v][u + 1],
        points[v + 1][u + 1],
        points[v + 1][u],
      ]);
    }
  }
  return triangles;
}

/**
 * Closest approach of a sail's cloth to a spar's timber, metres.
 *
 * `ignoreCorners` drops samples within a short radius of the sail's own corner
 * nodes. **A corner on a spar is an attachment, not a collision** — this file
 * has said so since M2, but the measurement did not honour it until the headsail
 * stays were set up on the timber instead of standing off it, at which point
 * every headsail reported 0.000 m inside the fore topmast for the entirely
 * correct reason that its head is bent to a stay on that mast.
 *
 * Excluding a corner's neighbourhood is a structural rule, not a per-sail
 * exemption: it says nothing about *which* sails may touch, only that the point
 * where a sail is made fast is not where you look for a collision.
 */
function sailToSpar(sailName: string, sparName: string, ignoreCorners = 0): number {
  const sail = SAILS.find((s) => s.name === sailName)!;
  const spar = sparNamed(sparName);
  const corners = sail.corners.map(rigNode);
  let worst = Infinity;
  for (const pt of sailPoints(sail)) {
    if (ignoreCorners > 0 && corners.some((c) => len(sub(pt, c)) < ignoreCorners)) continue;
    worst = Math.min(worst, distanceToSpar(pt, spar));
  }
  return worst;
}

/** Möller–Trumbore, bounded to the segment. Returns the hit point or null. */
function segmentHitsTriangle(
  p0: V,
  p1: V,
  t0: V,
  t1: V,
  t2: V,
): V | null {
  const dir = sub(p1, p0);
  const e1 = sub(t1, t0);
  const e2 = sub(t2, t0);
  const h = cross(dir, e2);
  const a = dot(e1, h);
  if (Math.abs(a) < 1e-12) return null;
  const f = 1 / a;
  const s = sub(p0, t0);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = f * dot(dir, q);
  if (v < 0 || u + v > 1) return null;
  const t = f * dot(e2, q);
  // Trim the very ends: sails that share a corner node (the headsails do not,
  // but a future rig might) would otherwise report a hit at the shared point.
  if (t <= 1e-4 || t >= 1 - 1e-4) return null;
  return { x: p0.x + dir.x * t, y: p0.y + dir.y * t, z: p0.z + dir.z * t };
}

// --- the silhouette ----------------------------------------------------------

describe('rig — the silhouette a topsail schooner depends on', () => {
  it('puts the main truck in the band the spec fixes', () => {
    // docs/ship/SHIP_SPEC.md section 2: main masthead 19–20 m above the waterline. This is
    // the only rig dimension the spec states outright.
    expect(mainTruckAboveWaterline()).toBeGreaterThanOrEqual(19);
    expect(mainTruckAboveWaterline()).toBeLessThanOrEqual(20);
  });

  it('crosses exactly two yards, which is what her century allows', () => {
    /**
     * A REGRESSION GUARD WITH A DATE ON IT
     * ------------------------------------
     * `docs/ship/SHIP_SPEC.md` section 2 dates her 1765–1780. A square topsail bent
     * between two yards *on the topmast*, with a third yard bare below, is the
     * double topsail — patented in the 1850s. She carried it for a round, and it
     * arrived by a plausible-looking route: the topsail was raised to clear the
     * fore gaff, the yard it left behind stayed crossed, and nothing objected.
     *
     * So the count is asserted, and the sail is asserted to reach both of them.
     * Splitting a topsail in two is exactly the "improvement" a later session
     * would make in good faith.
     */
    const yards = SPARS.filter((s) => /Yard/.test(s.name));
    expect(yards.map((s) => s.name).sort()).toEqual([
      'lowerYardPort',
      'lowerYardStarboard',
      'topsailYardPort',
      'topsailYardStarboard',
    ]);
  });

  it('spans the square topsail from the lower yard to the topsail yard', () => {
    /**
     * Head bent aloft, clews hauled down to the lower yardarms, foot loose
     * between them. The hoist is the whole gap — **5.65 m against the 3.10 m** it
     * had when the sail lived entirely on the topmast.
     *
     * Not the 6.65 m the handover's arithmetic predicted, and both ends were
     * squeezed by things that only became visible once the sail was actually
     * drawn at full size:
     *
     * - the **foot** rose 11.75 → 12.35, because the lower yard is slung under
     *   the fore trestletrees and everything set on a stay forward of the mast
     *   has to pass beneath it;
     * - the **head** fell 18.40 → 18.00, because the jib's cloth descends past
     *   the topsail for the first couple of metres below its own head, and at
     *   18.40 the two passed 0.06 m apart. Buying that clearance by standing the
     *   jib stay further forward is what made the head rig look detached from the
     *   mast, so it was bought vertically instead.
     */
    const head = rigNode('topsailClothHeadPort').y;
    const clew = rigNode('topsailClewPort').y;
    expect(clew).toBeCloseTo(rigNode('lowerYardArmPort').y, 6);
    expect(head).toBeCloseTo(rigNode('topsailYardArmPort').y, 6);
    expect(head - clew).toBeGreaterThan(5.4);
  });

  it('makes the square topsail big enough to be a distance cue', () => {
    /**
     * Section 3 names "a single square topsail forward" as one of only four
     * things she must be recognisable by at distance. At 24.8 m² — the double
     * topsail's upper half — it read as a handkerchief, and Ash said so.
     *
     * **34.7 m², up 40%.** The handover predicted about 40 by assuming the sail
     * could keep the whole gap between the existing yards; the note on the test
     * above records why both ends moved in once it was drawn. 34.7 is still the
     * second-largest sail in the plan and the largest on the foremast, which is
     * what the silhouette needs.
     *
     * Measured on the flat quad, which is the projected area a silhouette sees;
     * the bellied surface is slightly larger and would flatter the number.
     */
    const sail = SAILS.find((s) => s.name === 'foreTopsail')!;
    const [a, b, c, d] = sail.corners.map(rigNode);
    const area =
      len(cross(sub(b, a), sub(c, a))) / 2 + len(cross(sub(c, a), sub(d, a))) / 2;
    expect(area).toBeGreaterThan(33);
    // Bigger than either gaff sail forward of the mainsail, and bigger than any
    // headsail — if it ever is not, it has stopped being a distance cue.
    const areaOf = (name: string): number => {
      const s = SAILS.find((x) => x.name === name)!;
      const q = sailQuad(s.corners);
      return (
        len(cross(sub(q[1], q[0]), sub(q[2], q[0]))) / 2 +
        len(cross(sub(q[2], q[0]), sub(q[3], q[0]))) / 2
      );
    };
    for (const other of ['foresail', 'flyingJib', 'jib']) {
      expect(`topsail vs ${other}`).toBe(
        area > areaOf(other) ? `topsail vs ${other}` : `topsail is smaller than ${other}`,
      );
    }
  });

  it('separates the square topsail from the fore gaff in space, not in height', () => {
    /**
     * THE TEST THAT CAUSED THE ANACHRONISM, REPLACED
     * ----------------------------------------------
     * This used to read `topsailFootY − foreGaffPeakY > 0.6` — vertical daylight
     * between the two sails. It was a fair test of the original fault, when the
     * topsail was set *below* the gaff peak and 37 m² of square sail genuinely
     * shared a band with 37 m² of gaff sail. But the only way to raise that
     * number is to raise the sail, so the test itself pointed at the wrong fix,
     * and the rig ended up in the wrong century satisfying it.
     *
     * A gaff and a square topsail overlap in height on every real rig of the
     * type. They never overlap in space: one is set abaft the mast, the other
     * forward of it. Measure the thing that is actually true.
     */
    /**
     * A sanity bound, not a target — and it used to be 0.3, which was the same
     * mistake this file keeps writing down.
     *
     * Asserting the standoff *number* asserts the mechanism. The property is the
     * two measured separations below, and they are what a rig has to satisfy. The
     * 0.3 bound outlived its usefulness the moment the standoff had to come down
     * to 0.26 to stop the jib crossing the topsail — at which point a rig that
     * was measurably *better* separated failed the test that existed to protect
     * the separation.
     *
     * This one only says the yard really is slung forward of the stick, which is
     * what makes the whole arrangement possible.
     */
    expect(topsailForwardOfGaff()).toBeGreaterThan(0.15);
    // The gaff itself, against the cloth that is drawn — belly included. Its
    // peak reaches 14.34, which is 2 m up inside the topsail's hoist, and the
    // whole claim of section 4a is that this is fine because they are separated
    // fore-and-aft. This is the number that says so.
    const gaff = sailToSpar('foreTopsail', 'foreGaff');
    expect(`topsail to fore gaff: ${gaff.toFixed(2)} m`).toBe(
      `topsail to fore gaff: ${Math.max(gaff, 0.2).toFixed(2)} m`,
    );
    // And the two sails' cloth, which is the pair the eye actually reads.
    let worst = Infinity;
    const foresail = SAILS.find((s) => s.name === 'foresail')!;
    const topsailPts = sailPoints(SAILS.find((s) => s.name === 'foreTopsail')!, 20);
    const foresailPts = sailPoints(foresail, 20);
    for (const a of topsailPts) {
      for (const b of foresailPts) worst = Math.min(worst, len(sub(a, b)));
    }
    expect(`topsail to foresail: ${worst.toFixed(2)} m`).toBe(
      `topsail to foresail: ${Math.max(worst, 0.3).toFixed(2)} m`,
    );
  });

  it('stands the square topsail clear of every stick it passes', () => {
    /**
     * THE STANDOFF IS PINCHED, NOT CHOSEN
     * ------------------------------------
     * The sail spans the doubling, where the lower masthead, the trestletrees
     * and the fidded topmast are all in one place, and `YARD_FORWARD_OF_MAST`
     * has to satisfy two constraints pulling opposite ways:
     *
     * - **larger** stands the cloth clear of the masthead behind it;
     * - **smaller** keeps it out of the jib, whose stay is set up on the topmast
     *   and therefore starts *behind* the sail's plane.
     *
     * Swept: at 0.26 the jib crosses the topsail, at 0.24 it does not, and the
     * masthead clearance at 0.24 is 0.13 m. There is no value that gives both
     * more room — the window is one step wide. The bound here is 0.12 rather
     * than a rounder number because it is reporting what the geometry allows,
     * and a bound above 0.13 would be asserting that this rig is impossible.
     *
     * If the mast, the doubling or the headsail fan ever move, re-run the sweep
     * rather than nudging this: the two constraints have to be re-balanced
     * together, and neither of them is visible from the other's test.
     */
    for (const spar of ['foremast', 'foreTopmast'] as const) {
      const clear = sailToSpar('foreTopsail', spar);
      expect(`topsail to ${spar}: ${clear.toFixed(2)} m`).toBe(
        `topsail to ${spar}: ${Math.max(clear, 0.12).toFixed(2)} m`,
      );
    }
  });

  it('rakes both masts aft, the main harder than the fore', () => {
    const foreRake = rigNode('foreStep').z - rigNode('foreTopmastHead').z;
    const mainRake = rigNode('mainStep').z - rigNode('mainTopmastHead').z;
    expect(foreRake).toBeGreaterThan(0.8);
    expect(mainRake).toBeGreaterThan(foreRake);
  });

  it('keeps the foremast shorter than the main', () => {
    expect(rigNode('foreCap').y).toBeLessThan(rigNode('mainCap').y);
    expect(rigNode('foreTopmastHead').y).toBeLessThan(rigNode('mainTopmastHead').y);
  });

  it('overhangs the transom with the main boom', () => {
    // A schooner's most quoted feature. 15–20% of LOA is normal. Measured along
    // the spar, so the answer is about the vessel rather than about her trim —
    // the same boom eased to a broad reach projects less far aft.
    expect(mainBoomOverhang() / 15.5).toBeGreaterThan(0.15);
    expect(mainBoomOverhang() / 15.5).toBeLessThan(0.2);
  });

  it('leaves the fore boom room to swing past the mainmast', () => {
    // Swept, not sampled where she is drawn: amidships binds at 0.82 m and every
    // angle outboard of that opens up. `foreBoomClearance` carries the reason.
    expect(`fore boom past the mainmast: ${foreBoomClearance().toFixed(2)} m`).toBe(
      `fore boom past the mainmast: ${Math.max(foreBoomClearance(), 0.8).toFixed(2)} m`,
    );
  });

  it('leaves headroom under the main boom', () => {
    expect(mainBoomClearance()).toBeGreaterThan(1.0);
  });

  it('bends the square topsail inside its yardarms', () => {
    // Bare yardarm projecting past the cloth is most of what reads as square rig
    // rather than as a rectangle hung between two lines. True at the head, where
    // the sail is bent to the yard, and at the clews, where the sheet reeves
    // through a sheave in the arm and the cloth stops short of it.
    for (const [yard, cloth] of [
      ['lowerYardArmPort', 'topsailClewPort'],
      ['topsailYardArmPort', 'topsailClothHeadPort'],
    ] as const) {
      const arm = rigNode(yard);
      const corner = rigNode(cloth);
      const bare = Math.hypot(arm.x, arm.z) - Math.hypot(corner.x, corner.z);
      expect(`${yard}: ${bare.toFixed(2)} m bare`).toBe(
        `${yard}: ${Math.max(bare, 0.25).toFixed(2)} m bare`,
      );
    }
  });

  it('spreads the foot wider than the head, which is what a topsail does', () => {
    // The lower yard is longer than the topsail yard, so the sail is a trapezoid
    // narrowing upward. If this ever inverts, someone has bent the head to the
    // wrong spar.
    const foot = rigNode('topsailClewPort').x - rigNode('topsailClewStarboard').x;
    const head =
      rigNode('topsailClothHeadPort').x - rigNode('topsailClothHeadStarboard').x;
    expect(foot).toBeGreaterThan(head * 1.15);
  });
});

// --- the three headsails -----------------------------------------------------

describe('rig — the headsails read as three', () => {
  const heads = ['staysailHead', 'jibHead', 'flyingJibHead'].map(rigNode);
  const tacks = ['stemhead', 'bowspritMid', 'bowspritEnd'].map(rigNode);

  it('steps the heads up the fore rigging, clear of one another', () => {
    /**
     * THE QUANTITY THIS MEASURES CHANGED MEANING, SO THE NUMBER HAD TO
     * ----------------------------------------------------------------
     * These used to be the points where the stays are *set up on the mast*, and
     * 1.2 m of separation between mastheads was a fair proxy for three
     * distinguishable sails. A headsail's head is not the top of its stay — the
     * stay runs on to the masthead and the sail is hoisted part-way up it, which
     * is what every reference photograph shows and what finally got the jib out
     * of the square topsail (`HEADSAIL_HEAD_ON_STAY`).
     *
     * So `heads` now names three *sail corners* rather than three mast fittings,
     * and their spacing is compressed by exactly the fraction the sails were
     * lowered by. Holding 1.2 against the new quantity would not be protecting
     * the old property; it would be forbidding the fix.
     *
     * What is asserted instead is the property directly, and more of it than
     * before: the heads still step up in order, and the sails' *cloth* is
     * measurably apart — which is the thing the spacing was ever a proxy for.
     */
    expect(heads[0].y).toBeLessThan(heads[1].y);
    expect(heads[1].y).toBeLessThan(heads[2].y);
    const gaps = [heads[1].y - heads[0].y, heads[2].y - heads[1].y];
    for (const gap of gaps) expect(gap).toBeGreaterThan(1.0);

    // And no two of them are near enough to read as one sail.
    const names = ['foreStaysail', 'jib', 'flyingJib'] as const;
    for (let i = 0; i + 1 < names.length; i++) {
      const a = sailPoints(SAILS.find((s) => s.name === names[i])!, 20);
      const b = sailPoints(SAILS.find((s) => s.name === names[i + 1])!, 20);
      let worst = Infinity;
      for (const p of a) for (const q of b) worst = Math.min(worst, len(sub(p, q)));
      expect(`${names[i]} to ${names[i + 1]}: ${worst.toFixed(2)} m`).toBe(
        `${names[i]} to ${names[i + 1]}: ${Math.max(worst, 0.3).toFixed(2)} m`,
      );
    }
  });

  it('keeps the three comparable in size', () => {
    /**
     * This is what the even-step rule was really protecting, and asserting the
     * spacing instead of the areas cost a round.
     *
     * The original fault was heads at 13.15, 14.60 and 20.40 — which made the
     * flying jib 56 m², a quarter of the whole sail plan, with the other two
     * nested inside it. Even spacing fixed that, so even spacing became the
     * test. But the square topsail takes the middle of the topmast, and once the
     * jib's head was moved clear of it the spacing had to go uneven — 5.65 m
     * then 1.35 m. The sails stayed comparable, which was the point all along.
     *
     * Assert the property, not the mechanism that happened to deliver it.
     *
     * THIS GOT TIGHTER WHEN THE TOPSAIL CAME BACK DOWN, AND IT IS A REAL SIGNAL
     * ------------------------------------------------------------------------
     * Restoring the square topsail's full hoist forced the fore stay down off
     * the masthead (see `STAYSAIL_HEAD_Y`), which cost the staysail 2.25 m of
     * luff. Leading its clew aft recovered part of that and the three now run
     * **11.4 / 22.7 / 30.9 m², a spread of 2.70** against 2.44 before.
     *
     * The margin is thinner because the fan is the wrong way round, and that is
     * worth stating plainly rather than absorbing: `rig.ts` says in its own
     * comments that "the flying jib is the *smallest* headsail, not the largest",
     * and ours is the largest by a factor of 2.7 over the staysail. That was true
     * before this change too — the topsail merely stopped it being comfortable.
     * Rebalancing it means moving the flying jib's tack and clew, which is a
     * headsail-fan decision and not one to make silently inside a topsail fix.
     * Recorded, not fixed.
     */
    const area = (name: string): number => {
      const sail = SAILS.find((s) => s.name === name)!;
      const [h, t, c] = sail.corners.map(rigNode);
      const u = { x: t.x - h.x, y: t.y - h.y, z: t.z - h.z };
      const v = { x: c.x - h.x, y: c.y - h.y, z: c.z - h.z };
      const n = cross(u, v);
      return Math.hypot(n.x, n.y, n.z) / 2;
    };
    const areas = ['foreStaysail', 'jib', 'flyingJib'].map(area);
    const spread = Math.max(...areas) / Math.min(...areas);
    expect(spread).toBeLessThan(2.8);
    // And together they should be a real share of the plan, not an afterthought.
    const total = areas.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(50);
  });

  it('steps the tacks out along the bowsprit', () => {
    expect(tacks[1].z).toBeGreaterThan(tacks[0].z + 1.2);
    expect(tacks[2].z).toBeGreaterThan(tacks[1].z + 1.2);
  });

  it('sheets every headsail clew forward of the foremast', () => {
    // Two clews used to land abaft it, so their cloth passed through the mast
    // and through the foresail.
    for (const name of ['staysailClew', 'jibClew', 'flyingJibClew']) {
      expect(rigNode(name).z).toBeGreaterThan(4.1);
    }
  });

  it('sheets them to different angles, so no two are coplanar', () => {
    const xs = ['staysailClew', 'jibClew', 'flyingJibClew'].map((n) => rigNode(n).x);
    expect(xs[0]).toBeGreaterThan(0.5);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
  });
});

// --- no sail occupies another sail's space -----------------------------------

describe('rig — no two sails intersect', () => {
  /**
   * Contacts within this radius of a mast axis are attachments, not collisions.
   *
   * Several sails are bent to the same stick — the jib and flying jib take their
   * heads on the fore topmast, and the square topsail's yards are slung on it
   * between them. Cloth meeting cloth at the spar they all hang from is what
   * being rigged to one mast means. Anything further out is not.
   */
  const ATTACHMENT_RADIUS = 0.9;

  const MAST_AXES = [
    { heel: rigNode('foreStep'), head: rigNode('foreTopmastHead') },
    { heel: rigNode('mainStep'), head: rigNode('mainTopmastHead') },
  ];

  function nearAMast(pt: V): boolean {
    for (const axis of MAST_AXES) {
      if (pt.y < axis.heel.y || pt.y > axis.head.y) continue;
      const t = (pt.y - axis.heel.y) / (axis.head.y - axis.heel.y);
      const mz = axis.heel.z + (axis.head.z - axis.heel.z) * t;
      // The topmast is fidded abaft its lower mast, so allow for the doubling's
      // width as well as the radius.
      if (Math.hypot(pt.x, pt.z - mz) < ATTACHMENT_RADIUS) return true;
    }
    return false;
  }

  /**
   * Tessellate a sail the way the renderer does — bellied, not flat.
   *
   * This test used to check the flat quad through the four corner nodes while
   * the renderer drew a surface up to 0.63 m away from it. It passed while the
   * square topsail's belly reached through both jibs, sixteen crossings each,
   * plainly visible on screen. A test that measures a different object than the
   * one being drawn is worse than no test: it reports safety it never checked.
   */
  function sailMesh(sail: (typeof SAILS)[number]): { tris: [V, V, V][]; edges: [V, V][] } {
    const surface = sailSurface(sail);
    const N = 14;
    const grid: V[][] = [];
    for (let i = 0; i <= N; i++) {
      const row: V[] = [];
      for (let j = 0; j <= N; j++) row.push(surface(j / N, i / N));
      grid.push(row);
    }
    const tris: [V, V, V][] = [];
    const edges: [V, V][] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        tris.push([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1]]);
        tris.push([grid[i][j], grid[i + 1][j + 1], grid[i][j + 1]]);
      }
    }
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j < N; j++) edges.push([grid[i][j], grid[i][j + 1]]);
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j <= N; j++) edges.push([grid[i][j], grid[i + 1][j]]);
    }
    return { tris, edges };
  }

  it('passes no sail through another sail, on the surface actually drawn', () => {
    const meshes = SAILS.map((sail) => ({ name: sail.name, ...sailMesh(sail) }));
    const failures: string[] = [];
    for (const a of meshes) {
      for (const b of meshes) {
        if (a === b) continue;
        for (const [p0, p1] of a.edges) {
          for (const tri of b.tris) {
            const hit = segmentHitsTriangle(p0, p1, tri[0], tri[1], tri[2]);
            if (!hit || nearAMast(hit)) continue;
            failures.push(
              `${a.name} crosses ${b.name} at ` +
                `(${hit.x.toFixed(2)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(2)})`,
            );
          }
        }
      }
    }
    // One line per pair, not per triangle — sixteen copies of the same fault is
    // noise, and the count is what says how deep it goes.
    const byPair = new Map<string, number>();
    for (const f of failures) {
      const key = f.slice(0, f.indexOf(' at '));
      byPair.set(key, (byPair.get(key) ?? 0) + 1);
    }
    expect([...byPair].map(([k, n]) => `${k} (${n}x)`)).toEqual([]);
  });

  it('passes no sail edge through another sail, at the corners', () => {
    const failures: string[] = [];
    for (const a of SAILS) {
      for (const b of SAILS) {
        if (a === b) continue;
        for (const [p0, p1] of sailEdges(a.corners)) {
          for (const tri of sailTriangles(b.corners)) {
            const hit = segmentHitsTriangle(p0, p1, tri[0], tri[1], tri[2]);
            if (!hit || nearAMast(hit)) continue;
            failures.push(
              `${a.name} edge passes through ${b.name} at ` +
                `(${hit.x.toFixed(2)}, ${hit.y.toFixed(2)}, ${hit.z.toFixed(2)})`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('passes no sail body through a mast', () => {
    /**
     * TWO CORRECTIONS, BOTH OF THEM THE MISTAKE SECTION 3.2 IS ABOUT
     * --------------------------------------------------------------
     * This modelled each mast as ONE straight segment from the step to the
     * topmast head, against a flat 0.2 m radius. A mast is two sticks: a lower
     * mast, and a topmast fidded 0.17 m *abaft* it and overlapping it through
     * the doubling. One line between them describes neither — at the fore cap it
     * ran 0.107 m aft of the real lower masthead, which is most of the clearance
     * being measured, and in the direction that flattered the answer.
     *
     * It also sampled the flat quad through the corner nodes rather than the
     * surface the renderer draws. That is precisely the fault section 3.2 of the
     * handover is about, still alive in this file after being fixed in the test
     * directly above it.
     *
     * Both are fixed here: the real spars with their real taper, against the
     * bellied cloth. It matters now — the square topsail spans the doubling, so
     * this is the test that says whether `YARD_FORWARD_OF_MAST` is big enough.
     */
    const failures: string[] = [];
    /**
     * A sail is exempt from a stick only when it is bent to it or its luff runs
     * along it. Nothing else.
     *
     * The square topsail was once exempt from the foremast, reasoning that a
     * square sail is bent to yards slung on the mast so its cloth must span the
     * stick. That is wrong — the yard pivots on a truss forward of the mast and
     * a drawing square sail bellies forward — and the exemption hid the topmast
     * visibly piercing the sail at two points. It stays off this list.
     */
    const sticks = [
      { spar: 'foremast', own: ['foresail'] },
      { spar: 'foreTopmast', own: ['foresail'] },
      { spar: 'mainmast', own: ['mainsail', 'mainTopmastStaysail'] },
      // The gaff topsail is hooped to the main topmast, so its luff lies on the
      // stick for its whole length — the same relationship the mainsail has with
      // the mast below, and exempt for the same reason. It was held 0.18 m clear
      // to avoid needing this line, and the result was a sail whose tack visibly
      // touched nothing. An exemption that states a true attachment is cheaper
      // than a coordinate that states a false position.
      { spar: 'mainTopmast', own: ['mainsail', 'mainTopmastStaysail', 'mainGaffTopsail'] },
    ] as const;
    for (const sail of SAILS) {
      for (const stick of sticks) {
        if ((stick.own as readonly string[]).includes(sail.name)) continue;
        // 0.35 m around a corner is where the sail is made fast; look for
        // penetration in the body, which is the thing that cannot be real.
        const clear = sailToSpar(sail.name, stick.spar, 0.35);
        // Positive means clear of the timber. A sail bent to a spar may touch
        // it, so fail only on penetration.
        if (clear < 0) {
          failures.push(
            `${sail.name} passes ${(-clear).toFixed(3)} m inside the ${stick.spar}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// --- solids that are not spars -----------------------------------------------

describe('rig — no sail passes through a top', () => {
  /**
   * A WHOLE CATEGORY OF SOLID OBJECT WAS OUTSIDE THE COVERAGE
   * ---------------------------------------------------------
   * Every intersection test in this file checked sails against `SPARS`. The
   * trestletrees and crosstrees are not spars — they are `CROSSTREES`, their own
   * list — so nothing ever compared a sail with one, and the fore top projected
   * 0.72 m forward of its mast straight through the square topsail. Ash saw it
   * as **wood coming out of the front of the sail from behind**, which is
   * exactly what a platform's leading edge does when it is 0.29 m proud of the
   * cloth.
   *
   * The lesson is not "check the tops". It is that an intersection suite keyed to
   * one *list* silently stops covering the ship the moment someone adds geometry
   * to a different list. What follows checks every solid the rig owns.
   */
  const SOLIDS = CROSSTREES.map((x) => ({
    name: x.name,
    // Athwart by halfSpan, fore-and-aft by length, thin in y.
    half: { x: x.halfSpan, y: x.thickness * 0.5, z: x.length * 0.5 },
    centre: { x: 0, y: x.y, z: x.z },
  }));

  /** Distance from a point to an axis-aligned box; 0 when inside it. */
  function distanceToBox(p: V, centre: V, half: V): number {
    return Math.hypot(
      Math.max(Math.abs(p.x - centre.x) - half.x, 0),
      Math.max(Math.abs(p.y - centre.y) - half.y, 0),
      Math.max(Math.abs(p.z - centre.z) - half.z, 0),
    );
  }

  it('keeps every sail out of the tops it does not hang from', () => {
    /**
     * A gaff sail's luff runs up the mast the top sits on, so its cloth passes
     * the top by construction — that is the same exemption the masts already
     * carry, for the same reason, and the same two sails.
     */
    const own: Record<string, readonly string[]> = {
      mainCrosstrees: ['mainsail', 'mainTopmastStaysail'],
      foreCrosstrees: ['foresail'],
    };
    const failures: string[] = [];
    for (const solid of SOLIDS) {
      for (const sail of SAILS) {
        if (own[solid.name]?.includes(sail.name)) continue;
        let worst = Infinity;
        for (const q of sailPoints(sail, 24)) {
          worst = Math.min(worst, distanceToBox(q, solid.centre, solid.half));
        }
        if (worst <= 0) failures.push(`${sail.name} passes through the ${solid.name}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('lets both gaffs swing clear under their tops', () => {
    /**
     * THE ONE FAULT IN THIS ROUND THAT WAS ABOUT MOTION, NOT APPEARANCE
     * -----------------------------------------------------------------
     * A gaff rises aft from its throat at roughly 1.1 m aft per metre of rise.
     * With the throat 0.35 m below the hounds it reached the **trestletrees** —
     * the fore-and-aft members the topmast is fidded between — around 0.34 m
     * abaft the mast, at exactly their height. Both gaffs passed through their
     * own tops. Ash saw it as *the big wooden bar across the top of the sail
     * could not swing*, and that is precisely the consequence: the spar is
     * inside the structure it has to move under.
     *
     * Every other intersection test in this file is about a thing looking wrong.
     * This one is about a thing that cannot happen, which is worse, and it went
     * unnoticed through four reviews because nothing compared a spar with a top.
     *
     * `THROAT_BELOW_HOUNDS` and the tops' `length` are a *pair* — lengthening a
     * top pushes its trestletrees back into the gaff's path. This is what says
     * whether that trade is still balanced.
     */
    const failures: string[] = [];
    for (const x of CROSSTREES) {
      const mast = x.name.startsWith('main') ? 'main' : 'fore';
      const gaff = SPARS.find((s) => s.name === `${mast}Gaff`)!;
      // The trestletrees: narrow in x, thin in y, running the top's full length.
      const trestleHalf = { x: x.thickness * 2.6, y: x.thickness * 0.7, z: x.length / 2 };
      let worst = Infinity;
      for (let i = 0; i <= 300; i++) {
        const t = i / 300;
        const q = {
          x: gaff.heel.x + (gaff.head.x - gaff.heel.x) * t,
          y: gaff.heel.y + (gaff.head.y - gaff.heel.y) * t,
          z: gaff.heel.z + (gaff.head.z - gaff.heel.z) * t,
        };
        const r = gaff.heelRadius + (gaff.headRadius - gaff.heelRadius) * t;
        worst = Math.min(
          worst,
          Math.hypot(
            Math.max(Math.abs(q.x) - trestleHalf.x, 0),
            Math.max(Math.abs(q.y - x.y) - trestleHalf.y, 0),
            Math.max(Math.abs(q.z - x.z) - trestleHalf.z, 0),
          ) - r,
        );
      }
      failures.push(`${mast} gaff under ${x.name}: ${Math.max(worst, 0.05).toFixed(2)} m`);
      expect(`${mast} gaff under ${x.name}: ${worst.toFixed(2)} m`).toBe(
        `${mast} gaff under ${x.name}: ${Math.max(worst, 0.05).toFixed(2)} m`,
      );
    }
  });

  it('projects each top abaft its mast, which is where the topmast is', () => {
    // The fix for the above, asserted as the property rather than the number: a
    // top carries a topmast fidded ABAFT the lower mast, so it reaches aft. If it
    // ever reaches as far forward as it does aft, it is back in the sail.
    for (const x of CROSSTREES) {
      const axis = x.name.startsWith('main') ? rigNode('mainHounds') : rigNode('foreHounds');
      const forward = x.z + x.length * 0.5 - axis.z;
      const aft = axis.z - (x.z - x.length * 0.5);
      expect(`${x.name}: ${forward.toFixed(2)} fwd / ${aft.toFixed(2)} aft`).toBe(
        `${x.name}: ${forward.toFixed(2)} fwd / ${Math.max(aft, forward + 0.2).toFixed(2)} aft`,
      );
    }
  });
});

// --- no rope passes through the ship -----------------------------------------

describe('rig — no rope passes through the bulwark', () => {
  /**
   * THE CHECK THAT PROVED THIS WAS ITSELF THE BUG
   * ----------------------------------------------
   * The headsail sheets ran from clews outboard of the bulwark to a fairlead on
   * its *inboard* face, so every one of them entered the planking from outside
   * and came out inside. Moving the fairlead onto the rail fixed the half of the
   * run coming in from the clew and broke the half going on to the pin, which
   * then descended back through the inner face.
   *
   * Both times the verification said it was fine. The check only matched runs
   * whose names ended in `Sheet` — and every one of these ropes has a second
   * half named `SheetFall`. **It reported success for ropes it had never
   * looked at.** Ash checked by eye and it was still wrong, twice.
   *
   * So this sweeps every run in the rig against the bulwark as a solid, with no
   * name matching anywhere in it. The wall is the band between the deck edge and
   * the rail top; a point is inside the timber when its half-breadth lies between
   * the inboard face and the hull's own side at that height.
   */
  /**
   * AND THE CHECK WAS MEASURING THE SAME WRONG WALL
   * ------------------------------------------------
   * This used `halfBreadthAt(z, deck) − 0.14` for the inboard face — the very
   * expression `rig.ts` was placing fittings with. So the test and the thing
   * under test shared a fiction, and both agreed the ropes were fine while Ash
   * could see them coming out of the planking. **A test that derives the truth
   * the same wrong way as the code cannot fail.**
   *
   * It reads `railSection()` now, which is the hull's own description of its
   * side, and it checks the caprail as well as the planking — the rail is 0.07 m
   * proud of `bulwarkTopY` and overhangs both faces, and a fairlead placed at
   * `bulwarkTopY` sits *inside* it.
   */
  it('passes no rope through the bulwark or its caprail, on any run in the rig', () => {
    const failures: string[] = [];
    for (const run of [...STANDING_RIGGING, ...RUNNING_RIGGING]) {
      const a = rigNode(run.from);
      const b = rigNode(run.to);
      let deepest = 0;
      let where = '';
      for (let i = 0; i <= 400; i++) {
        const t = i / 400;
        const q = {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        };
        // The station, not the position. Abaft the shear these differ by up to
        // 0.79 m, and this used the position — so every rope over the counter
        // was measured against a section from the wrong part of the ship. See
        // `counterStationZ`.
        const station = counterStationZ(q.z, q.y);
        if (!Number.isFinite(station) || Math.abs(station) > 7.7) continue;
        const rail = railSection(station);
        const ax = Math.abs(q.x);
        let depth = 0;
        if (q.y <= rail.topY && q.y >= deckAtSideY(station) - 0.25) {
          // Inside the planking.
          const outer = halfBreadthAt(station, Math.min(q.y, deckAtSideY(station) - 0.02));
          if (ax > rail.innerX && ax < outer) {
            depth = Math.min(ax - rail.innerX, outer - ax);
          }
        } else if (q.y > rail.topY && q.y < rail.capY) {
          // Inside the caprail itself.
          if (ax > rail.capInnerX && ax < rail.capOuterX) {
            depth = Math.min(ax - rail.capInnerX, rail.capOuterX - ax);
          }
        }
        if (depth > deepest) {
          deepest = depth;
          where = `y ${q.y.toFixed(2)} z ${q.z.toFixed(2)}`;
        }
      }
      if (deepest > 0.005) {
        failures.push(`${run.name} is ${deepest.toFixed(3)} m inside the rail at ${where}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps every fitting on the rail following the ship, along its whole length', () => {
    /**
     * A STRAIGHT THING BOLTED TO A CURVED SHIP
     * -----------------------------------------
     * The pin rail was one box placed at its own mid-point, taking the hull's
     * half-breadth *there* and holding it for the board's full length. Forward,
     * where the bow has curved away, the timber stood out through the ship's
     * side; aft it was buried in the planking. Both ends of one fault, which is
     * what this always looks like.
     *
     * The general rule, and the reason the bullseyes above it were already
     * right: **a fitting that sits on the hull must ask the hull where it is at
     * the point where it sits** — not once, at a convenient station, for a run
     * of timber a metre and a half long.
     *
     * So this sweeps each rail's declared extent rather than checking a centre
     * point, and it checks the fairleads and pins at their own stations too.
     */
    const failures: string[] = [];
    const onTheWall = (x: number, z: number, what: string): void => {
      const rail = railSection(z);
      const ax = Math.abs(x);
      // Outboard of the caprail's outer edge is outside the ship; more than a
      // hand's breadth inboard of the planking is standing off it.
      if (ax > rail.capOuterX) {
        failures.push(`${what} at z ${z.toFixed(2)} is ${(ax - rail.capOuterX).toFixed(3)} m outside the hull`);
      } else if (ax < rail.innerX - 0.16) {
        failures.push(`${what} at z ${z.toFixed(2)} floats ${(rail.innerX - ax).toFixed(3)} m inboard of the wall`);
      }
    };

    for (const rail of BULWARK_PIN_RAILS) {
      // The seats the loft actually draws from — not re-derived here, or this
      // test would be checking its own arithmetic instead of the ship's.
      for (const seat of rail.seats) onTheWall(seat.x, seat.z, `${rail.name} board`);
      for (const z of rail.pinZs) {
        onTheWall(pinRailSeat(z, rail.side).x, z, `${rail.name} pin`);
      }

      /**
       * And the seats must actually *follow* the curve, not merely sit on it at
       * one point. A straight board would have every seat at the same x and pass
       * the check above at its mid-point while standing out through the planking
       * at one end — which is precisely what it did.
       *
       * The forward rail spans a station where the bow closes fast, so its ends
       * differ by more than the board is thick. If that ever stops being true,
       * this rail no longer needs sweeping and the assertion should be revisited
       * rather than deleted.
       */
      const xs = rail.seats.map((s) => Math.abs(s.x));
      const spread = Math.max(...xs) - Math.min(...xs);
      if (rail.halfLength > 0.5) {
        expect(`${rail.name} sweep: ${spread.toFixed(3)} m`).toBe(
          `${rail.name} sweep: ${Math.max(spread, 0.09).toFixed(3)} m`,
        );
      }
    }
    for (const name of SHEET_FAIRLEADS) {
      const n = rigNode(name);
      onTheWall(n.x, n.z, name);
    }
    expect(failures).toEqual([]);
  });

  it('gives every belaying pin a rope, and every rope a pin of its own', () => {
    // Ash's question: why do the boards carry pins that hold nothing? They no
    // longer do. One rail forward with a pin per headsail sheet, and one pin on
    // each boom-sheet rail — asserted against the ropes that actually end there.
    // S4 added each rail's starboard twin (a sheet belays to whichever side
    // its clew is hauled to; the other side's pin stands spare), so the
    // one-pin-per-rope count runs over the port rails and the twins are
    // asserted to be exact mirrors rather than a second pin population.
    const roped = new Set(RUNNING_RIGGING.map((r) => r.to));
    const pinNodes = [...roped].filter((n) => /Pin$/.test(n) && !/Fife/.test(n));
    const portRails = BULWARK_PIN_RAILS.filter((r) => !r.mirrorOf);
    const drawnPins = portRails.reduce((n, r) => n + r.pinZs.length, 0);
    expect(`${drawnPins} pins for ${pinNodes.length} ropes`).toBe(
      `${pinNodes.length} pins for ${pinNodes.length} ropes`,
    );
  });

  it('draws every pin rail with an exact starboard twin (S4)', () => {
    const portRails = BULWARK_PIN_RAILS.filter((r) => !r.mirrorOf);
    const twins = BULWARK_PIN_RAILS.filter((r) => r.mirrorOf);
    expect(twins.length).toBe(portRails.length);
    for (const twin of twins) {
      const partner = portRails.find((r) => r.name === twin.mirrorOf)!;
      expect(partner).toBeDefined();
      expect(twin.side).toBe(-partner.side);
      expect(twin.z).toBe(partner.z);
      expect(twin.y).toBe(partner.y);
      expect(twin.pinZs).toEqual(partner.pinZs);
      for (let i = 0; i < twin.seats.length; i++) {
        expect(twin.seats[i].x).toBeCloseTo(-partner.seats[i].x, 12);
        expect(twin.seats[i].y).toBe(partner.seats[i].y);
        expect(twin.seats[i].z).toBe(partner.seats[i].z);
      }
    }
  });
});

// --- no rope passes through cloth --------------------------------------------

describe('rig — rope and cloth do not share space', () => {
  /**
   * NOTHING CHECKED THIS BEFORE, AND ADDING THE GAFF TOPSAIL FOUND OUT WHY
   * ----------------------------------------------------------------------
   * Every intersection test in this file compared sails with sails, or sails
   * with spars. There are forty-odd runs of rope aboard and not one of them was
   * ever measured against a sail — the braces carry a comment saying they "lead
   * aft, and they lead *high* … so they pass over the foresail instead of
   * through it", which was reasoned and never checked.
   *
   * The main gaff topsail is what made it matter. A peak halyard rises from the
   * gaff to the masthead, and **that is the definition of the triangle a gaff
   * topsail occupies** — no straight line between those two points is outside
   * the sail. The halyard passed 0.015 m from the new cloth, with the sail's
   * clew landing on its line to within 4 mm. It is now a span on the gaff led to
   * a block on the starboard cheek of the masthead, which is how a real vessel keeps
   * the two apart, and this is the number that says whether it worked.
   *
   * The bar is penetration, not daylight. Ropes bearing against sails is what
   * happens at sea: a gaff sail eased out lies against its own shrouds, and the
   * measured 0.04–0.11 m there is correct rather than a defect. What must never
   * happen is a rope passing *inside* the cloth.
   */
  const RUNS = [...STANDING_RIGGING, ...RUNNING_RIGGING];

  /**
   * A rope's ends are where it is made fast, and things are made fast to spars —
   * which is also where sails are bent. So contact within this fraction of
   * either end is an attachment, not a crossing.
   *
   * THIS REPLACED A LIST OF EXEMPTIONS, WHICH IS THE POINT
   * ------------------------------------------------------
   * The first version named individual rope/sail pairs to skip. That list was
   * already growing — the topsail's tye touches the cloth at the yard sling it is
   * made fast to, and the peak halyard's span legs touch the mainsail at the gaff
   * they are seized round — and every entry on it is a place a real fault could
   * hide, which is section 3.3's whole warning.
   *
   * Trimming the ends instead is one rule that covers all of them, and it does
   * not hide the fault this describe block was written for: the peak halyard's
   * original run approached the gaff topsail in the *middle*, nowhere near either
   * end, so the measurement is unchanged at 0.015 m.
   *
   * **But 0.015 m clears the halyard's own 0.012 m radius, so this test would
   * pass it.** Restoring the old `mainPeak` → `mainCap` routing confirms that:
   * this test stays green and only the named one below goes red. Penetration is a
   * floor, not a standard — a rope 3 mm off a sail is a rope drawn on a sail. The
   * specific test underneath, with a real gap to clear, is what actually holds
   * this piece of geometry, and that is why it is written separately rather than
   * folded in here.
   */
  const ATTACHMENT_END = 0.06;

  /**
   * The one pair the end-trim cannot cover: the fisherman does not merely touch
   * the main topmast stay, its **luff is that stay** for the sail's whole hoist.
   * `alongMainTopmastStay()` places its head and tack on the stay by
   * construction, and an earlier version that floated the sail beside the stay
   * rather than on it was the bug. Contact along the whole middle is what being
   * a staysail means.
   */
  const BENT_TO: Record<string, readonly string[]> = {
    mainTopmastStaysail: ['mainTopmastStay'],
  };

  /** Distance from a point to a rope, ignoring `trim` of its length at each end. */
  function segmentToPoint(a: V, b: V, q: V, trim = 0): number {
    const ab = sub(b, a);
    const d2 = dot(ab, ab);
    if (d2 < 1e-12) return len(sub(q, a));
    const t = Math.min(Math.max(dot(sub(q, a), ab) / d2, trim), 1 - trim);
    return len(sub(q, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }));
  }

  it('passes no rope inside a sail', () => {
    const failures: string[] = [];
    const cloth = SAILS.map((s) => ({ sail: s, pts: sailPoints(s, 20) }));
    for (const run of RUNS) {
      const a = rigNode(run.from);
      const b = rigNode(run.to);
      for (const { sail, pts } of cloth) {
        // A rope made fast to one of this sail's own corners is holding it, and
        // touching it there is the whole point.
        if (sail.corners.includes(run.from) || sail.corners.includes(run.to)) continue;
        if (BENT_TO[sail.name]?.includes(run.name)) continue;
        let worst = Infinity;
        for (const q of pts) {
          worst = Math.min(worst, segmentToPoint(a, b, q, ATTACHMENT_END));
        }
        // The rope is a tube, so its surface is `radius` from its axis.
        if (worst < run.diameter / 2) {
          failures.push(
            `${run.name} passes ${worst.toFixed(3)} m from ${sail.name}` +
              ` — inside its own ${(run.diameter / 2).toFixed(3)} m radius`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * Called out separately because it is the one this test was written for, and
   * because the clearance is fragile in a specific way: it comes from **both**
   * ends of the halyard being carried to port, and restoring either one to the
   * centreline puts the rope straight back inside the cloth. Moving one end alone
   * is worth 0.004–0.02 m; moving both is worth 0.10 m. A chord pivots when you
   * move one end and translates when you move two.
   */
  it('keeps the peak halyard out of the gaff topsail it now has to clear', () => {
    const run = RUNS.find((r) => r.name === 'mainPeakHalyard')!;
    const a = rigNode(run.from);
    const b = rigNode(run.to);
    const sail = SAILS.find((s) => s.name === 'mainGaffTopsail')!;
    let worst = Infinity;
    for (const q of sailPoints(sail, 24)) worst = Math.min(worst, segmentToPoint(a, b, q));
    expect(`peak halyard to gaff topsail: ${worst.toFixed(2)} m`).toBe(
      `peak halyard to gaff topsail: ${Math.max(worst, 0.05).toFixed(2)} m`,
    );
    // Both ends to port, which is where the clearance actually comes from.
    expect(a.x, 'the gaff block has come back onto the spar’s axis').toBeLessThan(
      rigNode('mainPeak').x * 0.8,
    );
    expect(b.x, 'the masthead block has come back onto the mast’s axis').toBeLessThan(-0.1);
  });

  /**
   * Every running rope ends or turns at something drawn.
   *
   * THE STRUCTURAL VERSION OF A FAULT FOUND BY EYE THREE TIMES
   * ----------------------------------------------------------
   * The sheet horses got traveller blocks because two rope segments meeting at a
   * point "read as two ropes ending at a corner". The headsail sheets got
   * bullseyes because their turns "disappeared into the top rail". Each fix drew
   * fittings at *one named list* and stopped, and five more nodes went on turning
   * and terminating on nothing — including the fisherman's sheet block, hanging
   * 0.14 m clear of the mainmast, which is the one Ash found: "it just kinda
   * kinks in mid air."
   *
   * The failure mode is the rig round's signature one: **an intersection suite
   * keyed to one list stops covering the ship the moment geometry lands in a
   * different list.** So this enumerates the ropes instead. Every endpoint of
   * every running rope must be one of four things, and a fifth kind fails here
   * until somebody says what the rope is holding onto.
   */
  it('ends every running rope on a spar, a block, a pin or a sail', () => {
    const sailCorners = new Set(SAILS.flatMap((s) => s.corners));
    const drawnFittings = new Set<string>([
      ...RIG_BLOCKS,
      ...MASTHEAD_EYES,
      ...SHEET_FAIRLEADS,
      // The traveller blocks are named for their horses.
      ...SHEET_BLOCKS.map((b) => b.name.replace(/Block$/, '')),
      // Deadeyes, drawn on the channels by `buildChannels`.
      ...CHANNEL_SEATS.map((seat) => seat.name),
      // The two ends that land on the hull rather than on the rig: the bobstay
      // sets up at the stem's foot and the headstay at its head. Both are drawn
      // timber — `shipGeometry.ts` lofts the stem — so they are anchored, they
      // are just not anchored to anything in this module.
      'stemFoot',
      'stemhead',
    ]);

    const onASpar = (p: RigPoint): boolean =>
      SPARS.some((spar) => {
        const ax = spar.head.x - spar.heel.x;
        const ay = spar.head.y - spar.heel.y;
        const az = spar.head.z - spar.heel.z;
        const l2 = ax * ax + ay * ay + az * az;
        let t = ((p.x - spar.heel.x) * ax + (p.y - spar.heel.y) * ay + (p.z - spar.heel.z) * az) / l2;
        t = Math.min(Math.max(t, 0), 1);
        const d = Math.hypot(
          p.x - (spar.heel.x + ax * t),
          p.y - (spar.heel.y + ay * t),
          p.z - (spar.heel.z + az * t),
        );
        const r = spar.heelRadius + (spar.headRadius - spar.heelRadius) * t;
        // Touching the timber, with a rope's own thickness of tolerance.
        return d - r <= 0.03;
      });

    const homeless: string[] = [];
    for (const run of RUNS) {
      for (const name of [run.from, run.to]) {
        if (drawnFittings.has(name)) continue;
        if (sailCorners.has(name)) continue;
        if (/Pin$/.test(name)) continue;
        const p = rigNode(name);
        if (onASpar(p)) continue;
        homeless.push(`${name} (${run.name})`);
      }
    }
    expect(
      [...new Set(homeless)].sort(),
      'a rope ends here and there is nothing drawn for it to end on',
    ).toEqual([]);
  });

  /**
   * A block hangs on a strop, and a strop needs timber to be seized to.
   *
   * The other half of the same statement: naming a node a block is only honest if
   * something is near enough to hang it from. `rigGeometry.ts` finds that spar by
   * asking which is nearest, so a block that drifted out of reach would quietly
   * grow a metre-long strop instead of failing.
   */
  it('keeps every block within a strop’s reach of its spar', () => {
    for (const name of [...RIG_BLOCKS, ...MASTHEAD_EYES]) {
      const p = rigNode(name);
      let gap = Infinity;
      for (const spar of SPARS) {
        const ax = spar.head.x - spar.heel.x;
        const ay = spar.head.y - spar.heel.y;
        const az = spar.head.z - spar.heel.z;
        const l2 = ax * ax + ay * ay + az * az;
        let t = ((p.x - spar.heel.x) * ax + (p.y - spar.heel.y) * ay + (p.z - spar.heel.z) * az) / l2;
        t = Math.min(Math.max(t, 0), 1);
        const d = Math.hypot(
          p.x - (spar.heel.x + ax * t),
          p.y - (spar.heel.y + ay * t),
          p.z - (spar.heel.z + az * t),
        );
        gap = Math.min(gap, d - (spar.heelRadius + (spar.headRadius - spar.heelRadius) * t));
      }
      expect(`${name}: ${gap.toFixed(2)} m off its spar`).toBe(
        `${name}: ${Math.min(Math.max(gap, 0), 0.35).toFixed(2)} m off its spar`,
      );
    }
  });

  /**
   * The topsail's foot lies along its gaff.
   *
   * This is the shape of the sail, and nothing held it. For a round the tack sat
   * 2.35 m above the throat — a legal cut, a topsail set flying, chosen to keep
   * the peak halyard underneath the cloth — and it read as a wedge of daylight
   * where a topsail schooner should have sail. Ash saw it against photographs of
   * the type before any test could: a working gaff topsail is tacked down at the
   * jaws and its foot follows the spar.
   *
   * Bounded rather than pinned. The foot is carried clear of the gaff on purpose
   * — `MAIN_TOPSAIL_ABOVE_GAFF`, because a foot lying *on* the spar is a corner
   * sitting on the mainsail's own head edge — so the test is that the clearance
   * stays a hand's breadth and never becomes a gap.
   */
  it('lays the gaff topsail’s foot along the gaff', () => {
    const throat = rigNode('mainThroat');
    const peak = rigNode('mainPeak');
    const tack = rigNode('mainTopsailTack');
    const clew = rigNode('mainTopsailClew');
    let worst = 0;
    let worstAt = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const gaffY = throat.y + (peak.y - throat.y) * t;
      const footY = tack.y + (clew.y - tack.y) * t;
      if (footY - gaffY > worst) {
        worst = footY - gaffY;
        worstAt = t;
      }
      expect(footY, `the foot dips below the gaff at t=${t.toFixed(2)}`).toBeGreaterThan(gaffY);
    }
    expect(`widest gap over the gaff: ${worst.toFixed(2)} m at t ${worstAt.toFixed(2)}`).toBe(
      `widest gap over the gaff: ${Math.min(worst, 0.4).toFixed(2)} m at t ${worstAt.toFixed(2)}`,
    );
  });
});

// --- every sail bellies to leeward -------------------------------------------

describe('rig — the bellies fall to leeward', () => {
  /**
   * SIX SAILS WERE BELLIED TO WINDWARD, AND A COMMENT IS WHY
   * --------------------------------------------------------
   * `Sail.side` was documented as a world side (literally "+1 to starboard,
   * −1 to port" in the pre-W1 mirrored labels; today's labels would say "+1 to
   * port"). It is not: it is a sign on the corner patch's normal, and which way
   * that normal points falls out of the order the corners happen to be listed
   * in. Every fore-and-aft sail was set to +1 against that doc, and every one
   * of them bellied to starboard — to windward, on a vessel with every clew
   * sheeted out to port.
   *
   * Nothing caught it. The silhouette is nearly the same either way and the
   * intersection tests passed, because a belly on the wrong side is still a
   * belly; what it changes is the shading, which is exactly how the winding bug
   * in section 3.1 of the handover hid too.
   *
   * The lesson is the same one three times now: **a quantity that depends on
   * local ordering must be measured, not reasoned about.** So this measures it,
   * against the surface the renderer draws, and it is the thing to run when
   * setting `side` on a new sail.
   */
  const lerp = (a: V, b: V, t: number): V => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  });

  /** Where the belly carries the middle of the cloth, off the flat patch. */
  function bellyOffset(sail: Sail): V {
    const q = sailQuad(sail.corners);
    const flatMid = lerp(lerp(q[0], q[1], 0.5), lerp(q[3], q[2], 0.5), 0.5);
    return sub(sailSurface(sail)(0.5, 0.5), flatMid);
  }

  it('sheets every clew to port, which is what makes port leeward', () => {
    // The premise the rest of this rests on. If she is ever re-trimmed onto the
    // other tack, this fails first and says so, instead of every belly quietly
    // becoming wrong again.
    for (const name of ['mainBoomEnd', 'foreBoomEnd', 'staysailClew', 'jibClew']) {
      expect(`${name}.x = ${rigNode(name).x.toFixed(2)}`).toBe(
        `${name}.x = ${Math.max(rigNode(name).x, 0.1).toFixed(2)}`,
      );
    }
  });

  it('bellies every fore-and-aft sail to port', () => {
    const failures: string[] = [];
    for (const sail of SAILS) {
      if (sail.name === 'foreTopsail') continue;
      const d = bellyOffset(sail);
      if (d.x <= 0.02) {
        failures.push(`${sail.name} bellies ${d.x.toFixed(3)} m in x — to windward`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('bellies the square sail forward, not sideways', () => {
    // A square sail on a broad reach takes the wind on its after face, so its
    // belly goes forward — and forward is also the only direction that clears
    // the mast it is set in front of.
    const d = bellyOffset(SAILS.find((s) => s.name === 'foreTopsail')!);
    expect(d.z).toBeGreaterThan(0.2);
    expect(Math.abs(d.x)).toBeLessThan(d.z);
  });
});

// --- the rig is attached to the ship -----------------------------------------

describe('rig — every fitting lands on the hull', () => {
  it('roots each chain plate on the topside, not beside it', () => {
    // The fault this replaced: the channels were sized off `maxHalfBeamAt`, the
    // section's widest point 0.3 m under water, so the whole gang floated 0.58 m
    // clear of the ship.
    for (const seat of CHANNEL_SEATS) {
      const foot = chainPlateFoot(seat);
      const hull = halfBreadthAt(foot.z, foot.y);
      expect(Math.abs(Math.abs(foot.x) - hull)).toBeLessThan(1e-6);
      expect(hull).toBeGreaterThan(0.5);
    }
  });

  it('projects the channels outboard of the hull at their own height', () => {
    for (const seat of CHANNEL_SEATS) {
      const hull = halfBreadthAt(seat.z, seat.y);
      const projection = Math.abs(seat.x) - hull;
      expect(projection).toBeGreaterThan(0.2);
      expect(projection).toBeLessThan(0.6);
    }
  });

  it('keeps the main channel behind the interior lining on the captured wardroom ray', () => {
    // Frozen vessel-local ray 4 from the multi-ray scene inspector. The old
    // one-box channel was rooted at the gang's narrowest station and buried a
    // further 60 mm, so its forward end crossed the lining and became the first
    // visible surface inside the wardroom.
    const origin = new THREE.Vector3(
      1.0056134605761764,
      3.42,
      -1.4452003942894138,
    );
    const direction = new THREE.Vector3(
      0.711198006338925,
      0.23815149708831118,
      -0.6614236616678713,
    ).normalize();
    const ray = new THREE.Raycaster(origin, direction, 0, 10);
    const lining = new THREE.Mesh(
      buildShipGeometry().geometries.get('interiorLining')!,
      new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
    );
    const channelTimber = new THREE.Mesh(
      buildStaticRigGeometry().geometries.get('spar')!,
      new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
    );
    const liningHit = ray.intersectObject(lining)[0];
    const timberHit = ray.intersectObject(channelTimber)[0];

    expect(liningHit).toBeDefined();
    expect(liningHit.distance).toBeLessThan(timberHit?.distance ?? Infinity);
  });

  it('follows the hull with the channel root beyond both end deadeyes', () => {
    for (const prefix of [
      'mainChannelPort',
      'mainChannelStarboard',
      'foreChannelPort',
      'foreChannelStarboard',
    ]) {
      const seats = CHANNEL_SEATS.filter((seat) => seat.name.startsWith(prefix));
      const side = Math.sign(seats[0].x) as 1 | -1;
      const zLo = Math.min(...seats.map((seat) => seat.z)) - 0.24;
      const zHi = Math.max(...seats.map((seat) => seat.z)) + 0.24;
      for (let i = 0; i <= 12; i++) {
        const root = channelRootAt(zLo + ((zHi - zLo) * i) / 12, side);
        expect(Math.abs(root.x)).toBeCloseTo(halfBreadthAt(root.z, root.y), 9);
      }
    }
  });

  it('names both ends of every standing-rigging run', () => {
    for (const run of STANDING_RIGGING) {
      expect(() => rigNode(run.from)).not.toThrow();
      expect(() => rigNode(run.to)).not.toThrow();
    }
  });

  it('names every sail corner', () => {
    for (const sail of SAILS) {
      for (const corner of sail.corners) expect(() => rigNode(corner)).not.toThrow();
    }
  });

  it('puts a rope on every clew', () => {
    /**
     * The free after corner of a sail must have a sheet on it.
     *
     * It is the one corner not held by a spar or a stay, and without a line it
     * is holding nothing — a real one would flog itself apart in a minute. The
     * first rig had standing rigging and no running rigging at all, so every
     * clew aboard was hanging in space. `docs/ship/SHIP_SPEC.md` section 7.4 asks for
     * these, and the check is cheap: a clew is a node whose name says clew.
     */
    const roped = new Set<string>();
    for (const run of RUNNING_RIGGING) {
      roped.add(run.from);
      roped.add(run.to);
    }
    const clews = new Set<string>();
    for (const sail of SAILS) {
      for (const corner of sail.corners) {
        if (/clew$/i.test(corner) || /BoomEnd$/.test(corner)) clews.add(corner);
      }
    }
    expect(clews.size).toBeGreaterThan(3);
    for (const clew of clews) {
      expect(`${clew}: ${roped.has(clew) ? 'sheeted' : 'NO SHEET'}`).toBe(`${clew}: sheeted`);
    }
  });

  it('names both ends of every running-rigging run', () => {
    for (const run of RUNNING_RIGGING) {
      expect(() => rigNode(run.from)).not.toThrow();
      expect(() => rigNode(run.to)).not.toThrow();
    }
  });
});

// --- the deck stays walkable -------------------------------------------------

describe('rig — deck fittings leave a gangway', () => {
  /**
   * M3 puts a player on this deck, and the rig is the first thing that ever put
   * furniture on it. `docs/ship/SHIP_ROUND_HANDOVER.md` M3 accepts when "a player can walk
   * bow to stern and around both masts without snagging" — which is a promise
   * this round can already break, silently, by making a fitting too wide.
   *
   * The main sheet horse did exactly that on its first pass: ±1.15 m on a
   * quarterdeck ±1.32 m wide inboard of the bulwark, leaving 0.17 m of gangway.
   */
  /**
   * The walkable half-width, asked of the surface a body actually stands on.
   *
   * This used to be `halfBreadthAt(z, deckAtSideY(z) - 0.02) - 0.14` — which is,
   * to the character, the expression `deckSurface.ts`'s header names as the
   * reason that file exists: a second description of the deck's edge, against a
   * wall that is 0.09 m thick and tumbles home. It agreed with the real surface
   * to about 40 mm amidships, so nothing ever caught it, and it was in *parameter*
   * coordinates: moving the main sheet horse abaft the rudder head made it answer
   * **-0.14 m** of half-breadth at a station where the deck is 1.17 m wide.
   *
   * A test that derives the truth its own way cannot check the code, and this one
   * had quietly stopped being about the ship at all.
   */
  const deckHalfWidth = (z: number): number => {
    const stand = deckStandAt(0, z);
    if (!stand) throw new Error(`no deck at z=${z}`);
    return stand.halfWidth;
  };

  /** Shoulder width plus a hand on something. Below this it is not a path. */
  const GANGWAY = 0.45;

  it('leaves a gangway past every fife rail', () => {
    for (const fife of FIFE_RAILS) {
      const clear = deckHalfWidth(fife.z) - fife.halfSpan;
      expect(`${fife.name}: ${clear.toFixed(2)} m`).toBe(
        `${fife.name}: ${Math.max(clear, GANGWAY).toFixed(2)} m`,
      );
    }
  });

  it('leaves a gangway past every sheet horse, and keeps it step-over height', () => {
    for (const horse of SHEET_HORSES) {
      const clear = deckHalfWidth(horse.z) - horse.halfSpan;
      expect(`${horse.name}: ${clear.toFixed(2)} m`).toBe(
        `${horse.name}: ${Math.max(clear, GANGWAY).toFixed(2)} m`,
      );
      // A horse is meant to be stepped over, not walked around. Above about
      // 0.45 m it stops being a step and starts being a fence. Measured at its
      // own feet, on the placed deck — `walkingDeckY(horse.z)` answered for a
      // parameter station and was 0.03 m out under the old main horse and
      // meaningless under the new one.
      const foot = deckStandAt(horse.halfSpan, horse.z);
      expect(foot).not.toBeNull();
      expect(horse.y - (foot?.y ?? 0)).toBeLessThan(0.45);
    }
  });

  it('keeps both masts clear of the deck edges', () => {
    for (const z of [MAINMAST_Z, FOREMAST_Z]) {
      expect(deckHalfWidth(z) - 0.18).toBeGreaterThan(1.2);
    }
  });

  const boomYAt = (gooseneck: RigPoint, end: RigPoint, z: number): number => {
    const t = (gooseneck.z - z) / (gooseneck.z - end.z);
    return gooseneck.y + (end.y - gooseneck.y) * Math.min(Math.max(t, 0), 1);
  };

  const BOOMS = [
    { name: 'main', gooseneck: 'mainGooseneck', end: 'mainBoomEnd', fife: 0 },
    { name: 'fore', gooseneck: 'foreGooseneck', end: 'foreBoomEnd', fife: 1 },
  ] as const;

  it('swings each boom clear of the fife rail beneath it', () => {
    // The fife rail stands abaft its mast and the boom swings directly over it.
    // At the first pass the main boom passed *through* the rail's pins and the
    // fore boom grazed them — the boom is lowest at its own gooseneck, which is
    // exactly where the rail is.
    for (const boom of BOOMS) {
      const fife = FIFE_RAILS[boom.fife];
      const pinTop = fife.y + 0.17;
      const overhead = boomYAt(rigNode(boom.gooseneck), rigNode(boom.end), fife.z);
      expect(`${boom.name}: ${(overhead - pinTop).toFixed(2)} m over the pins`).toBe(
        `${boom.name}: ${Math.max(overhead - pinTop, 0.15).toFixed(2)} m over the pins`,
      );
    }
  });

  /**
   * Headroom under each boom, measured over the deck a body actually stands on.
   *
   * This used `walkingDeckY(z)`, twice wrong in the same way the rest of the
   * ship has been: it answers for a *parameter* station against a placed z — so
   * over the counter it read the wrong part of the ship — and it answers for the
   * deck **at the side**, which is 90 mm below the crown a body walks along. Both
   * errors flatter the clearance. `deckStandAt` is the surface the walker's feet
   * are on.
   *
   * Not a comfort target: a schooner's main boom is low and you duck under it.
   * But 0.87 m, which is what the quarterdeck had before the goosenecks were
   * raised, is crawling. The place a body has to stand *still* under a boom is
   * the helm, and that has its own test in `ship-deck.test.ts` with a much
   * higher bar.
   */
  it('leaves headroom under both booms along the whole deck', () => {
    for (const boom of BOOMS) {
      const gooseneck = rigNode(boom.gooseneck);
      const end = rigNode(boom.end);
      let worst = Infinity;
      let worstAt = 0;
      for (let z = Math.min(gooseneck.z, end.z); z <= Math.max(gooseneck.z, end.z); z += 0.1) {
        const stand = deckStandAt(0, z);
        if (!stand) continue;
        const clearance = boomYAt(gooseneck, end, z) - 0.098 - stand.y;
        if (clearance < worst) {
          worst = clearance;
          worstAt = z;
        }
      }
      expect(`${boom.name}: ${worst.toFixed(2)} m at z ${worstAt.toFixed(1)}`).toBe(
        `${boom.name}: ${Math.max(worst, 1.25).toFixed(2)} m at z ${worstAt.toFixed(1)}`,
      );
    }
  });
});

// --- budget ------------------------------------------------------------------

describe('rig — the live re-loft (S4)', () => {
  const FULL_HOISTS = Object.fromEntries(
    SAILS.map((sail) => [sail.name, 1]),
  ) as Record<Sail['name'], number>;

  /** Distance from a point to a segment, metres. */
  const toSegment = (p: RigPoint, a: RigPoint, b: RigPoint): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const l2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-12);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2;
    t = Math.min(Math.max(t, 0), 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t), p.z - (a.z + dz * t));
  };

  it('lofts the authored pose bit-identically through the live path', () => {
    const baked = buildRigGeometry();
    const live = buildRigGeometry({
      trims: AUTHORED_TRIM_RAD,
      hoists: FULL_HOISTS,
    });
    for (const region of ['spar', 'rope', 'ironwork', 'sailcloth'] as const) {
      const a = baked.geometries.get(region)!.getAttribute('position');
      const b = live.geometries.get(region)!.getAttribute('position');
      expect(b.count, region).toBe(a.count);
      let identical = true;
      for (let i = 0; i < a.array.length; i++) {
        if (a.array[i] !== b.array[i]) {
          identical = false;
          break;
        }
      }
      expect(identical, `${region} positions`).toBe(true);
    }
  });

  it('restores the graph exactly after a trimmed loft', () => {
    const before = { ...rigNode('mainBoomEnd') };
    const trims = { ...AUTHORED_TRIM_RAD, mainsail: -AUTHORED_TRIM_RAD.mainsail };
    buildRigGeometry({ trims, hoists: FULL_HOISTS });
    const after = rigNode('mainBoomEnd');
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.z).toBe(before.z);
  });

  it('swings the boom to the commanded side while the loft holds the trim', () => {
    const trims = { ...AUTHORED_TRIM_RAD, mainsail: -AUTHORED_TRIM_RAD.mainsail };
    const restore = applyRigTrim(trims);
    try {
      // The mirror of the authored swing: same offsets, other side.
      expect(rigNode('mainBoomEnd').x).toBeLessThan(0);
      expect(rigNode('mainBoomSheetBlock').x).toBeLessThan(0);
      // The gaff-span block follows its gaff.
      expect(rigNode('mainGaffSpan').x).toBeLessThan(0.2);
    } finally {
      restore();
    }
  });

  it('flips the headsail sheet leads to the sheeted side', () => {
    const trims = { ...AUTHORED_TRIM_RAD, jib: -AUTHORED_TRIM_RAD.jib };
    const authoredPin = { ...rigNode('jibPin') };
    const restore = applyRigTrim(trims);
    try {
      expect(rigNode('jibPin').x).toBeCloseTo(-authoredPin.x, 6);
      // The other headsails' leads stay where their (unchanged) trims put them.
      expect(rigNode('staysailPin').x).toBeGreaterThan(0);
    } finally {
      restore();
    }
    expect(rigNode('jibPin').x).toBe(authoredPin.x);
  });

  it('carries every weather-side running lead across with its sail', () => {
    /**
     * Ash's first live tack found the missing relationship: the sail and its
     * outboard rope end crossed the ship while masthead blocks, cheek blocks
     * and belaying pins stayed in the authored pose. The resulting chord ran
     * straight through the cloth. There is deliberately no tack flag here —
     * the signed trims are already the state that moves the sails.
     */
    const mirrored = Object.fromEntries(
      Object.entries(AUTHORED_TRIM_RAD).map(([name, trim]) => [name, -trim]),
    ) as unknown as RigTrimAnglesRad;
    const runs = [
      'mainPeakHalyard',
      'mainToppingLift',
      'mainHalyardFall',
      'foreToppingLift',
      'foreHalyardFall',
      'fishermanSheet',
      'fishermanSheetFall',
    ] as const;
    const fittings = [
      'mainGaffSpan',
      'mainPeakBlock',
      'mainMastheadBlock',
      'mainFifePin',
      'foreMastheadBlock',
      'foreFifePin',
      'fishermanSheetBlock',
      'fishermanFifePin',
    ] as const;

    const snapshot = (trims: RigTrimAnglesRad) => {
      const restore = applyRigTrim(trims);
      try {
        return {
          fittings: Object.fromEntries(
            fittings.map((name) => [name, { ...rigNode(name) }]),
          ) as Record<(typeof fittings)[number], RigPoint>,
          ropes: Object.fromEntries(
            runs.map((name) => {
              const run = RUNNING_RIGGING.find((candidate) => candidate.name === name)!;
              return [name, riggingRunPoint(run, 0.5)];
            }),
          ) as Record<(typeof runs)[number], V>,
        };
      } finally {
        restore();
      }
    };

    const port = snapshot({ ...AUTHORED_TRIM_RAD });
    const starboard = snapshot(mirrored);
    for (const name of fittings) {
      expect(starboard.fittings[name].x, `${name}.x`).toBeCloseTo(
        -port.fittings[name].x,
        10,
      );
      expect(starboard.fittings[name].y, `${name}.y`).toBeCloseTo(
        port.fittings[name].y,
        10,
      );
      expect(starboard.fittings[name].z, `${name}.z`).toBeCloseTo(
        port.fittings[name].z,
        10,
      );
    }
    for (const name of runs) {
      expect(starboard.ropes[name].x, `${name} midpoint.x`).toBeCloseTo(
        -port.ropes[name].x,
        10,
      );
      expect(starboard.ropes[name].y, `${name} midpoint.y`).toBeCloseTo(
        port.ropes[name].y,
        10,
      );
      expect(starboard.ropes[name].z, `${name} midpoint.z`).toBeCloseTo(
        port.ropes[name].z,
        10,
      );
    }
  });

  it('keeps tack-coupled running gear out of the live cloth on both tacks', () => {
    const pairs: ReadonlyArray<{ run: string; sail: SailName }> = [
      { run: 'mainToppingLift', sail: 'mainsail' },
      { run: 'mainHalyardFall', sail: 'mainsail' },
      { run: 'foreToppingLift', sail: 'foresail' },
      { run: 'foreHalyardFall', sail: 'foresail' },
      { run: 'mainPeakHalyard', sail: 'mainGaffTopsail' },
      { run: 'fishermanSheet', sail: 'mainTopmastStaysail' },
      { run: 'fishermanSheetFall', sail: 'mainTopmastStaysail' },
    ];

    const pose = (sign: 1 | -1, fraction: number): RigTrimAnglesRad => ({
      mainsail:
        (sign * RIG_TRIM_LIMITS.mainsail.maxDeg * fraction * Math.PI) / 180,
      foresail:
        (sign * RIG_TRIM_LIMITS.foresail.maxDeg * fraction * Math.PI) / 180,
      foreStaysail:
        (sign * RIG_TRIM_LIMITS.foreStaysail.maxDeg * fraction * Math.PI) / 180,
      jib: (sign * RIG_TRIM_LIMITS.jib.maxDeg * fraction * Math.PI) / 180,
      flyingJib:
        (sign * RIG_TRIM_LIMITS.flyingJib.maxDeg * fraction * Math.PI) / 180,
      foreTopsail:
        (sign * RIG_TRIM_LIMITS.foreTopsail.maxDeg * fraction * Math.PI) / 180,
      // Its control has one fixed magnitude and changes sign only.
      mainTopmastStaysail:
        (sign * RIG_TRIM_LIMITS.mainTopmastStaysail.maxDeg * Math.PI) / 180,
    });

    const failures: string[] = [];
    const poses: Array<[string, RigTrimAnglesRad]> = [];
    for (const sign of [1, -1] as const) {
      for (const fraction of [0.1, 0.25, 0.5, 0.75, 1]) {
        poses.push([
          `${sign > 0 ? 'starboard' : 'port'} at ${(fraction * 100).toFixed(0)}%`,
          pose(sign, fraction),
        ]);
      }
    }
    const drawing: SailClothState = {
      flow: Object.fromEntries(
        SAILS.map((sail) => [
          sail.name,
          {
            ...createSailClothFlow(),
            aoaDeg: 26,
            apparentSpeedMps: 14,
          },
        ]),
      ) as Record<SailName, SailClothFlow>,
      elapsedSeconds: 0,
      animate: true,
    };
    const clothStates: ReadonlyArray<readonly [string, SailClothState | undefined]> = [
      ['flat', undefined],
      ['drawing', drawing],
    ];
    for (const [tack, trims] of poses) {
      for (const [clothName, cloth] of clothStates) {
        const state: RigLoftState = { trims, hoists: FULL_HOISTS, cloth };
        const restore = applyRigTrim(trims);
        try {
          for (const pair of pairs) {
            const run = RUNNING_RIGGING.find(
              (candidate) => candidate.name === pair.run,
            )!;
            const sail = SAILS.find((candidate) => candidate.name === pair.sail)!;
            const triangles = liveSailTriangles(sail, state);
            let crossed = false;
            for (let step = 0; step < 12 && !crossed; step++) {
              // A line bent to the sail's own corner is meant to meet it there.
              if (step === 0 && sail.corners.includes(run.from)) continue;
              if (step === 11 && sail.corners.includes(run.to)) continue;
              const a = riggingRunPoint(run, step / 12);
              const b = riggingRunPoint(run, (step + 1) / 12);
              crossed = triangles.some((triangle) =>
                segmentHitsTriangle(a, b, triangle[0], triangle[1], triangle[2]),
              );
            }
            if (crossed) {
              failures.push(`${clothName}, ${tack}: ${pair.run} through ${pair.sail}`);
            }
          }
        } finally {
          restore();
        }
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('rebuilds inside the measured budget', () => {
    const state = {
      trims: { ...AUTHORED_TRIM_RAD, mainsail: 0.1, foresail: -0.2 },
      hoists: { ...FULL_HOISTS, flyingJib: 0 },
    };
    buildLiveRigGeometry(state); // warm
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      buildLiveRigGeometry(state);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    // Measured 2026-08-08 on an M-class laptop: ~0.46 ms median for the live
    // half, against ~2.4 ms for the whole rig before this round. The budget is
    // generous because CI machines vary; what it guards is the *class* of the
    // cost — the per-frame re-loft must stay a sub-millisecond operation,
    // because the whole reason the rig moves smoothly now is that it is cheap
    // enough to rebuild on the frame that needs it rather than rationed to
    // eight a second.
    expect(times[4]).toBeLessThan(8);
  });

  it('rebuilds only what a live state can actually move', () => {
    // The guard on `LOFT_STEPS`: mark a builder static that isn't, and the
    // masts, shrouds or fittings it draws silently stop following the rig.
    // Two states as different as the controls allow, and the static half has
    // to come out byte-identical.
    const a = buildStaticRigGeometry({ trims: AUTHORED_TRIM_RAD, hoists: FULL_HOISTS });
    const b = buildStaticRigGeometry({
      trims: {
        ...AUTHORED_TRIM_RAD,
        mainsail: -0.4,
        foresail: 0.3,
        jib: -0.5,
        foreStaysail: -0.5,
        flyingJib: -0.5,
        foreTopsail: 0.2,
        mainTopmastStaysail: -0.4,
      },
      hoists: { ...FULL_HOISTS, mainsail: 0.4, foresail: 0.8, jib: 0.2, foreTopsail: 0.5 },
    });
    for (const region of ['spar', 'rope', 'ironwork', 'sailcloth'] as const) {
      const x = a.geometries.get(region);
      const y = b.geometries.get(region);
      expect(Boolean(x), `${region} present`).toBe(Boolean(y));
      if (!x || !y) continue;
      for (const attribute of ['position', 'normal', 'color'] as const) {
        const p = x.getAttribute(attribute).array;
        const q = y.getAttribute(attribute).array;
        expect(q.length, `${region}.${attribute} length`).toBe(p.length);
        let differing = 0;
        for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) differing++;
        expect(differing, `${region}.${attribute} values that moved`).toBe(0);
      }
    }
  });

  it('splits the rig without dropping or duplicating a vertex', () => {
    const state = {
      trims: { ...AUTHORED_TRIM_RAD, mainsail: -0.3 },
      hoists: { ...FULL_HOISTS, mainsail: 0.6, jib: 0 },
    };
    const whole = buildRigGeometry(state);
    const halves = [buildStaticRigGeometry(state), buildLiveRigGeometry(state)];
    let wholeTriangles = 0;
    for (const region of ['spar', 'rope', 'ironwork', 'sailcloth'] as const) {
      const all = whole.geometries.get(region);
      const parts = halves.map((half) => half.geometries.get(region));
      const count = parts.reduce((n, g) => n + (g?.getAttribute('position').count ?? 0), 0);
      expect(count, `${region} vertices`).toBe(all?.getAttribute('position').count ?? 0);
      wholeTriangles += all ? all.getIndex()!.count / 3 : 0;
    }
    expect(halves[0].triangleCount + halves[1].triangleCount).toBe(wholeTriangles);
    expect(whole.triangleCount).toBe(wholeTriangles);
  });

  it('keeps the live half’s colours through a partial rebuild', () => {
    // The colour stream runs through every builder in order, and a partial
    // rebuild skips most of them. If the rewind is wrong the ship repaints
    // itself every frame a sheet is moving.
    const a = buildLiveRigGeometry({ trims: AUTHORED_TRIM_RAD, hoists: FULL_HOISTS });
    const b = buildRigGeometry({ trims: AUTHORED_TRIM_RAD, hoists: FULL_HOISTS });
    for (const region of ['spar', 'rope', 'sailcloth'] as const) {
      const live = a.geometries.get(region)!.getAttribute('color').array;
      const whole = b.geometries.get(region)!.getAttribute('color').array;
      // Every colour the live half uses must appear in the whole rig's set —
      // same values, from the same points in the stream.
      const present = new Set<string>();
      for (let i = 0; i < whole.length; i += 3) {
        present.add(`${whole[i]},${whole[i + 1]},${whole[i + 2]}`);
      }
      let strangers = 0;
      for (let i = 0; i < live.length; i += 3) {
        if (!present.has(`${live[i]},${live[i + 1]},${live[i + 2]}`)) strangers++;
      }
      expect(strangers, `${region} colours not in the full build`).toBe(0);
    }
  });

  /**
   * The fault Ash found on the first furl: a mainsail that came down while its
   * gaff stayed peaked, leaving cloth hanging in mid-air off both its spars.
   *
   * Nothing caught it because every test measured the sail *against itself* —
   * its area, its corners, its belly — and never against the timber it is bent
   * to. A gaff sail is defined by its attachments: head laced to the gaff,
   * foot laced to the boom. That is the relationship to assert, at every hoist
   * and not only at the two ends.
   */
  describe('a gaff sail stays bent to its spars at every hoist', () => {
    const GAFF_SAILS = [
      { sail: 'mainsail', gaff: ['mainThroat', 'mainPeak'], boom: ['mainGooseneck', 'mainBoomEnd'] },
      { sail: 'foresail', gaff: ['foreThroat', 'forePeak'], boom: ['foreGooseneck', 'foreBoomEnd'] },
    ] as const;

    for (const { sail, gaff, boom } of GAFF_SAILS) {
      it(`${sail}: head on the gaff, foot on the boom`, () => {
        for (const hoist of [1, 0.9, 0.75, 0.55, 0.35, 0.2, 0.05, 0]) {
          const trims = { ...AUTHORED_TRIM_RAD };
          const hoists = { ...FULL_HOISTS, [sail]: hoist };
          const restore = applyRigTrim(trims, hoists);
          try {
            const corners = [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 }));
            liveSailCorners(sail, trims, corners, hoists);
            const gaffEnds = gaff.map((n) => ({ ...rigNode(n) }));
            const boomEnds = boom.map((n) => ({ ...rigNode(n) }));
            const where = `${sail} at hoist ${hoist}`;
            // corners are throat, peak, boom end, gooseneck.
            expect(toSegment(corners[0], gaffEnds[0], gaffEnds[1]), `${where}: throat`)
              .toBeLessThan(1e-9);
            expect(toSegment(corners[1], gaffEnds[0], gaffEnds[1]), `${where}: peak`)
              .toBeLessThan(1e-9);
            expect(toSegment(corners[2], boomEnds[0], boomEnds[1]), `${where}: clew`)
              .toBeLessThan(1e-9);
            expect(toSegment(corners[3], boomEnds[0], boomEnds[1]), `${where}: tack`)
              .toBeLessThan(1e-9);
          } finally {
            restore();
          }
        }
      });

      it(`${sail}: lowering it hard out does not cost clearance`, () => {
        // `boomSwingLimitRad` derives the trim limits with the gaff fully
        // peaked. That is only sound if lowering cannot foul something the
        // peaked spar clears, so measure it at the hardest sheet allowed —
        // the shrouds spread away from the hounds as they come down, and a
        // descending gaff moves *into* the widening part of that cone.
        const shrouds = STANDING_RIGGING.map((run) => ({
          a: { ...rigNode(run.from) },
          b: { ...rigNode(run.to) },
          radius: run.diameter / 2,
        }));
        const clearanceAt = (hoist: number): number => {
          const trims = {
            ...AUTHORED_TRIM_RAD,
            [sail]: RIG_TRIM_LIMITS[sail].maxDeg * (Math.PI / 180),
          };
          const restore = applyRigTrim(trims, { ...FULL_HOISTS, [sail]: hoist });
          try {
            const throat = { ...rigNode(gaff[0]) };
            const peak = { ...rigNode(gaff[1]) };
            let worst = Infinity;
            for (let i = 0; i <= 40; i++) {
              // From a fifth out — the jaws ride on the mast, where every
              // shroud converges, and that end is exempt by construction.
              const t = 0.2 + 0.8 * (i / 40);
              const p = {
                x: throat.x + (peak.x - throat.x) * t,
                y: throat.y + (peak.y - throat.y) * t,
                z: throat.z + (peak.z - throat.z) * t,
              };
              for (const s of shrouds) worst = Math.min(worst, toSegment(p, s.a, s.b) - s.radius);
            }
            return worst;
          } finally {
            restore();
          }
        };
        const peaked = clearanceAt(1);
        for (const hoist of [0.75, 0.5, 0.25, 0.05]) {
          // 0.05 m of slack: the fore gaff dips ~0.046 m below its peaked
          // clearance around three-quarter hoist as it crosses from the
          // topmast shroud to the lower one, then opens out steadily. It
          // stays clear; it is the limit's own margin that it eats into.
          expect(clearanceAt(hoist), `${sail} at hoist ${hoist}`).toBeGreaterThan(
            peaked - 0.05,
          );
        }
      });

      it(`${sail}: the gaff comes down to its boom, monotonically`, () => {
        let lastPeak = Infinity;
        let lastThroat = Infinity;
        for (const hoist of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
          const restore = applyRigTrim(AUTHORED_TRIM_RAD, {
            ...FULL_HOISTS,
            [sail]: hoist,
          });
          try {
            const peak = rigNode(gaff[1]).y;
            const throat = rigNode(gaff[0]).y;
            expect(peak, `${sail} peak at ${hoist}`).toBeLessThan(lastPeak);
            expect(throat, `${sail} throat at ${hoist}`).toBeLessThan(lastThroat);
            lastPeak = peak;
            lastThroat = throat;
            if (hoist === 0) {
              // Struck: the gaff lies along the boom, jaws at the gooseneck —
              // which is where the furled bundle is drawn, so the last of the
              // hoist and the furl are one continuous picture.
              const gooseneck = rigNode(boom[0]);
              expect(toSegment(rigNode(gaff[0]), gooseneck, rigNode(boom[1]))).toBeLessThan(1e-9);
              expect(toSegment(rigNode(gaff[1]), gooseneck, rigNode(boom[1]))).toBeLessThan(1e-9);
            }
          } finally {
            restore();
          }
        }
      });
    }
  });

  /**
   * KNOWN FAULT, PRE-DATING THE LOWERING GAFF — pinned, not fixed.
   *
   * The fore gaff passes through the spring stay (main hounds to fore hounds
   * eye) when it is sheeted a few degrees to *starboard*: 6 mm of overlap at
   * full hoist, in the rig as it has always been. `boomSwingLimitRad` cannot
   * see it, because it sweeps one side and mirrors, on the stated assumption
   * that the standing plan is symmetric — and the fore hounds eye is offset
   * 0.14 m off the centreline, which is exactly the asymmetry that assumption
   * waves through.
   *
   * Lowering deepens it to 79 mm over a narrow band around 0.9–0.98 hoist,
   * then it opens out fast; by three-quarter hoist the gaff is well clear.
   * Recorded here so the number is a measurement rather than a memory, and so
   * that fixing the stay (or unmirroring the limit) has something to move.
   */
  it('records the fore gaff’s overlap with the spring stay', () => {
    const stay = STANDING_RIGGING.find(
      (run) => run.from === 'mainHounds' && run.to === 'foreHoundsEye',
    )!;
    const a = { ...rigNode(stay.from) };
    const b = { ...rigNode(stay.to) };
    const gaffSpar = SPARS.find((s) => s.name === 'foreGaff')!;
    const radius = (gaffSpar.heelRadius + gaffSpar.headRadius) / 2 + stay.diameter / 2;
    const gapAt = (sheetDeg: number, hoist: number): number => {
      const restore = applyRigTrim(
        { ...AUTHORED_TRIM_RAD, foresail: sheetDeg * (Math.PI / 180) },
        { ...FULL_HOISTS, foresail: hoist },
      );
      try {
        const throat = { ...rigNode('foreThroat') };
        const peak = { ...rigNode('forePeak') };
        let worst = Infinity;
        for (let i = 0; i <= 60; i++) {
          const t = i / 60;
          worst = Math.min(
            worst,
            toSegment(
              {
                x: throat.x + (peak.x - throat.x) * t,
                y: throat.y + (peak.y - throat.y) * t,
                z: throat.z + (peak.z - throat.z) * t,
              },
              a,
              b,
            ) - radius,
          );
        }
        return worst;
      } finally {
        restore();
      }
    };
    // Already touching before anything in this round moved: full hoist.
    expect(gapAt(-5, 1)).toBeLessThan(0);
    expect(gapAt(-5, 1)).toBeGreaterThan(-0.02);
    // The worst of it while lowering, and how quickly it clears.
    expect(gapAt(-5, 0.95)).toBeGreaterThan(-0.1);
    expect(gapAt(-5, 0.8)).toBeGreaterThan(0);
    expect(gapAt(-5, 0.5)).toBeGreaterThan(1);
    // The port side — the one the limit sweep actually measured — is clear
    // at every hoist, which is what makes this an asymmetry and not a limit.
    for (const hoist of [1, 0.95, 0.8, 0.5]) {
      expect(gapAt(5, hoist), `starboard tack at hoist ${hoist}`).toBeGreaterThan(0);
    }
  });

  /**
   * The roll a coming-down sail makes of itself.
   *
   * It used to appear only once the sail was fully struck, at a fixed radius —
   * so the cloth vanished into thin air on the way down and a cylinder popped
   * into being at the end, sized by a formula that let the boom out through
   * the top of it at the gooseneck, where the spar is thickest. Both halves of
   * that are measured here: it grows the whole way down, and it is a sleeve.
   */
  describe('the furl roll', () => {
    const ROLLED = SAILS.filter((sail) => furlRoll(sail, 0) !== null);

    it('covers every sail that stows on a spar or a stay', () => {
      // Six of eight. The gaff topsail and the fisherman are handed and sent
      // below — they have nowhere aloft to gather, and shrink onto their tacks
      // instead. If either ever grows a stow, this list is where it shows up.
      expect(ROLLED.map((s) => s.name)).toEqual([
        'mainsail',
        'foresail',
        'foreStaysail',
        'jib',
        'flyingJib',
        'foreTopsail',
      ]);
    });

    for (const sail of ROLLED) {
      it(`${sail.name}: grows from nothing and never lets its spar out`, () => {
        let last = 0;
        for (const hoist of [1, 0.9, 0.75, 0.5, 0.25, 0.1, 0]) {
          const roll = furlRoll(sail, hoist)!;
          const where = `${sail.name} at hoist ${hoist}`;

          // Thicker every step down — this is the progress bar the eye reads.
          const thickest = Math.max(roll.radiusA, roll.radiusB);
          if (hoist < 1) expect(thickest, `${where}: grew`).toBeGreaterThan(last);
          last = thickest;

          // A sleeve, not a rod alongside: the skin clears the timber at both
          // ends even at the bottom of the sag.
          expect(roll.radiusA - roll.sagM - roll.coreA, `${where}: clear at the heel`)
            .toBeGreaterThan(0.005);
          expect(roll.radiusB - roll.sagM - roll.coreB, `${where}: clear at the head`)
            .toBeGreaterThan(0.005);
        }
        // Fully struck it is a real sausage, not a wire: the mainsail's makes
        // about 0.37 m across on an 8.6 m boom.
        const struck = furlRoll(sail, 0)!;
        expect(struck.radiusA).toBeGreaterThan(0.09);
        expect(struck.radiusA).toBeLessThan(0.30);
      });
    }

    it('is nothing at all when the sail is fully set', () => {
      for (const sail of ROLLED) {
        const roll = furlRoll(sail, 1)!;
        // Only the gaskets: the roll starts at the spar's own size, so there
        // is no step when the halyard first moves.
        expect(roll.radiusA - roll.coreA, sail.name).toBeLessThan(0.02);
      }
    });
  });

  it('draws a furled sail as a bundle without shifting other sails’ colours', () => {
    const furled = buildRigGeometry({
      trims: AUTHORED_TRIM_RAD,
      hoists: { ...FULL_HOISTS, foreStaysail: 0 },
    });
    const full = buildRigGeometry({
      trims: AUTHORED_TRIM_RAD,
      hoists: FULL_HOISTS,
    });
    // Cloth vertex count drops (one sail replaced by a small tube)…
    const clothFurled = furled.geometries.get('sailcloth')!.getAttribute('position');
    const clothFull = full.geometries.get('sailcloth')!.getAttribute('position');
    expect(clothFurled.count).toBeLessThan(clothFull.count);
    // …and every OTHER region is untouched, colours included — the PRNG
    // stream stays aligned because the bundle path consumes the same draws.
    for (const region of ['spar', 'rope', 'ironwork'] as const) {
      const a = full.geometries.get(region)!.getAttribute('color');
      const b = furled.geometries.get(region)!.getAttribute('color');
      expect(b.count, region).toBe(a.count);
      let identical = true;
      for (let i = 0; i < a.array.length; i++) {
        if (a.array[i] !== b.array[i]) {
          identical = false;
          break;
        }
      }
      expect(identical, `${region} colours`).toBe(true);
    }
  });
});

describe('rig — the budget, with ratlines built', () => {
  it('stays inside the draw-call and triangle budgets', () => {
    // docs/ship/SHIP_ROUND_HANDOVER.md section 5. Two of its three numbers are assertable
    // without a GPU; the 2 ms is a hand measurement and is not claimed here.
    const rig = buildRigGeometry();
    const hull = buildShipGeometry();
    const drawCalls = rig.geometries.size + hull.geometries.size;
    const triangles = rig.triangleCount + hull.triangleCount;
    expect(drawCalls).toBeLessThanOrEqual(120);
    expect(triangles).toBeLessThanOrEqual(200_000);
    // Ratlines are the item the handover warns about by name, so assert they are
    // actually in the count rather than assuming it.
    expect(RATLINES.length).toBeGreaterThan(60);
  });
});

// --- winding -----------------------------------------------------------------

describe('rig — vertex normals agree with face winding', () => {
  /**
   * Every triangle's supplied normal must point the same way its winding does.
   *
   * This shipped inverted on all four rig meshes and every triangle of them.
   * Sailcloth is `DoubleSide`, so three chooses which way to flip the normal
   * from `gl_FrontFacing` — which is winding — and with the winding backwards it
   * lit the face *away* from the sun and shaded the face toward it. The spars
   * and rope had the identical fault and hid it: opaque tubes with front-face
   * culling were discarding the near wall and shading the inside of the far one.
   *
   * Nothing about the geometry looked wrong, in the flat layout drawing or in
   * the lit contact sheets. It took someone noticing a sunset on the wrong side
   * of a sail. A number would have caught it on the first build.
   */
  function windingAgreement(geometry: {
    attributes: { position: { getX(i: number): number; getY(i: number): number; getZ(i: number): number }; normal: { getX(i: number): number; getY(i: number): number; getZ(i: number): number } };
    index: { count: number; getX(i: number): number } | null;
  }): { agree: number; disagree: number } {
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const idx = geometry.index!;
    let agree = 0;
    let disagree = 0;
    for (let t = 0; t < idx.count / 3; t++) {
      const i0 = idx.getX(t * 3);
      const i1 = idx.getX(t * 3 + 1);
      const i2 = idx.getX(t * 3 + 2);
      const a = { x: pos.getX(i0), y: pos.getY(i0), z: pos.getZ(i0) };
      const u = sub({ x: pos.getX(i1), y: pos.getY(i1), z: pos.getZ(i1) }, a);
      const v = sub({ x: pos.getX(i2), y: pos.getY(i2), z: pos.getZ(i2) }, a);
      const f = cross(u, v);
      const len = Math.hypot(f.x, f.y, f.z);
      if (len < 1e-9) continue;
      const n = { x: nor.getX(i0), y: nor.getY(i0), z: nor.getZ(i0) };
      const d = dot(f, n) / len;
      // Grazing faces carry no information about which side is out.
      if (Math.abs(d) < 0.25) continue;
      if (d > 0) agree++;
      else disagree++;
    }
    return { agree, disagree };
  }

  it('winds every rig face to match its normal', () => {
    const rig = buildRigGeometry();
    for (const [region, geometry] of rig.geometries) {
      const { agree, disagree } = windingAgreement(geometry as never);
      expect(agree).toBeGreaterThan(0);
      expect(`${region}: ${disagree} inverted`).toBe(`${region}: 0 inverted`);
    }
  });

  it('winds every hull face to match its normal', () => {
    // Free to check, and the hull is the reference the rig got wrong.
    const hull = buildShipGeometry();
    for (const [region, geometry] of hull.geometries) {
      const { disagree } = windingAgreement(geometry as never);
      expect(`${region}: ${disagree} inverted`).toBe(`${region}: 0 inverted`);
    }
  });
});

// --- mass --------------------------------------------------------------------

describe('rig — what the drawn spars weigh', () => {
  it('agrees with the mass model on the mainmast', () => {
    // `massModel.ts` carries 526 kg of mainmast, entered before any spar
    // existed. The drawn stick is the check on that estimate.
    const mainmast = SPARS.find((s) => s.name === 'mainmast')!;
    expect(sparLength(mainmast)).toBeGreaterThan(14);
    expect(sparLength(mainmast)).toBeLessThan(15);
  });

  it('puts the rig mass where the roll period can be re-derived from it', () => {
    const audit = rigMassAudit();
    // A sanity envelope, not a target: this is the number the hydrostatics
    // re-verification reads, and a wild value here means a spar is mis-sized.
    expect(audit.mass).toBeGreaterThan(1200);
    expect(audit.mass).toBeLessThan(2200);
    expect(audit.y).toBeGreaterThan(6);
    expect(audit.y).toBeLessThan(11);
  });
});

/**
 * Rope against timber — the check the rig round never had a category for.
 *
 * Sails were checked against `SPARS`, and the tops went unchecked because they
 * are a different list. Ropes were checked against cloth and against the hull.
 * Nothing checked a rope against a *spar*, and the first walk on deck found two
 * from ten metres away: the main halyard's fall and the fisherman's sheet fall,
 * both belayed on the wrong side of the fife rail, both passing through the main
 * boom, one through the mainmast as well.
 *
 * A rope may END on a spar — a shroud lands at the hounds, a sheet at a boom
 * end. So a contact is excused only when the nearby endpoint is itself on that
 * spar, which is measured rather than asserted. Everything else is timber the
 * rope has no business being inside.
 */
describe('rig — ropes against spars', () => {
  const ROPE_RADIUS = 0.012;

  /**
   * What is still fouled, measured.
   *
   * Three, all at a crowded masthead, all where a rope's end meets a spar fidded
   * or swinging at that same masthead, none deeper than 25 mm and none visible
   * from the deck. They are listed rather than tolerated in general: the budget
   * is per rope and per spar, so a new foul anywhere else fails, and any of
   * these getting worse fails too.
   */
  const KNOWN_FOULS: ReadonlyArray<{ rope: string; spar: string; depth: number }> = [
    // The gaff swings to port until it lies against the after shroud —
    // which is what gaff vangs are for, and why you do not sheet one past them.
    { rope: 'mainShroudPort2', spar: 'mainGaff', depth: 0.013 },
    { rope: 'forePeakHalyard', spar: 'foreTopmast', depth: 0.009 },
    { rope: 'mainTopsailSheetLead', spar: 'mainTopmast', depth: 0.025 },
  ];

  function segmentDistance(a0: RigPoint, a1: RigPoint, b0: RigPoint, b1: RigPoint) {
    const u = { x: a1.x - a0.x, y: a1.y - a0.y, z: a1.z - a0.z };
    const v = { x: b1.x - b0.x, y: b1.y - b0.y, z: b1.z - b0.z };
    const w = { x: a0.x - b0.x, y: a0.y - b0.y, z: a0.z - b0.z };
    const a = u.x * u.x + u.y * u.y + u.z * u.z;
    const b = u.x * v.x + u.y * v.y + u.z * v.z;
    const c = v.x * v.x + v.y * v.y + v.z * v.z;
    const d = u.x * w.x + u.y * w.y + u.z * w.z;
    const e = v.x * w.x + v.y * w.y + v.z * w.z;
    const denom = a * c - b * b;
    let s = denom > 1e-12 ? (b * e - c * d) / denom : 0;
    s = Math.min(Math.max(s, 0), 1);
    let t = c > 1e-12 ? (b * s + e) / c : 0;
    t = Math.min(Math.max(t, 0), 1);
    s = a > 1e-12 ? Math.min(Math.max((b * t - d) / a, 0), 1) : 0;
    const p = { x: a0.x + u.x * s, y: a0.y + u.y * s, z: a0.z + u.z * s };
    const q = { x: b0.x + v.x * t, y: b0.y + v.y * t, z: b0.z + v.z * t };
    return { distance: Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), s, t };
  }

  const radiusAt = (spar: Spar, t: number): number =>
    spar.heelRadius + (spar.headRadius - spar.heelRadius) * t;

  it('runs no rope through a spar it does not end on', () => {
    const fouls: string[] = [];
    for (const run of [...STANDING_RIGGING, ...RUNNING_RIGGING]) {
      const a = rigNode(run.from);
      const b = rigNode(run.to);
      for (const spar of SPARS) {
        const hit = segmentDistance(a, b, spar.heel, spar.head);
        const clearance = hit.distance - radiusAt(spar, hit.t) - ROPE_RADIUS;
        if (clearance >= 0) continue;

        // Excused only if the end nearest the contact is on this spar.
        const endA = segmentDistance(a, a, spar.heel, spar.head);
        const endB = segmentDistance(b, b, spar.heel, spar.head);
        const onA = endA.distance <= radiusAt(spar, endA.t) + 0.06;
        const onB = endB.distance <= radiusAt(spar, endB.t) + 0.06;
        if ((hit.s < 0.15 && onA) || (hit.s > 0.85 && onB)) continue;

        const known = KNOWN_FOULS.find((k) => k.rope === run.name && k.spar === spar.name);
        if (known && -clearance <= known.depth + 0.005) continue;
        fouls.push(
          `${run.name} through ${spar.name} by ${(-clearance * 1000).toFixed(0)} mm ` +
            `at ${(hit.s * 100).toFixed(0)}% along the rope`,
        );
      }
    }
    expect(fouls, fouls.join('\n')).toEqual([]);
  });

  it('belays the halyard falls to starboard, away from the port-swung boom', () => {
    // The comment on these pins says starboard, "the weather side, because everything
    // is sheeted to port and a fall hanging down the lee side would lie
    // inside the sails". It took a sign convention that did not mean what it
    // said to put them on the other one.
    expect(rigNode('mainFifePin').x).toBeLessThan(0);
    expect(rigNode('foreFifePin').x).toBeLessThan(0);
    expect(rigNode('mainBoomEnd').x).toBeGreaterThan(0);
  });

  it('leaves room to belay: every pin clear of its neighbours and the stanchion', () => {
    // A pin is a thing you take turns of rope around and hang a coil on. The
    // outer pin sat 60 mm from the stanchion — enough room for the pin, none for
    // the hand or the rope, which is what Ash meant by "not usable".
    const HAND = 0.12;
    for (const rail of FIFE_RAILS) {
      const xs: number[] = [];
      for (let i = 0; i < rail.pins; i++) xs.push(fifePinX(rail, i, 1));
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i] - xs[i - 1], `${rail.name} pins ${i - 1} and ${i}`).toBeGreaterThanOrEqual(HAND);
      }
      const stanchion = fifeStanchionX(rail, 1);
      expect(stanchion - xs[xs.length - 1], `${rail.name} outer pin to stanchion`).toBeGreaterThanOrEqual(HAND);
      // And the innermost is clear of its opposite number across the centreline.
      expect(xs[0] * 2, `${rail.name} across the centreline`).toBeGreaterThanOrEqual(HAND);
      // Every pin is on the board.
      expect(xs[xs.length - 1]).toBeLessThan(rail.halfSpan);
    }
  });

  it('draws each belaying pin once', () => {
    // `fifePinX` walked the index across the whole rail and the loft then
    // mirrored |x|, so every pin was drawn twice — eight meshes in four places.
    const seen = new Set<string>();
    for (const rail of FIFE_RAILS) {
      for (let i = 0; i < rail.pins; i++) {
        for (const side of [1, -1] as const) {
          const key = `${rail.name}:${fifePinX(rail, i, side).toFixed(4)}`;
          expect(seen.has(key), `two pins at ${key}`).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(FIFE_RAILS.length * FIFE_RAILS[0].pins * 2);
  });
});

/**
 * Rope against the ship herself.
 *
 * The spar check found ropes inside timber that stands on the deck. This one
 * asks the other question, the one Ash asked from the deck: does any rope pass
 * *through the side of the ship* — her planking, her bulwark, or the caprail on
 * top of it. The main sheet did. Its boom end swings 3.8 m out, well outside a
 * hull 2.3 m in half-breadth, so the sheet comes down from outboard to a horse
 * on the centreline and crosses the rail on the way in.
 *
 * The solid is asked for at each sample rather than assumed: below the deck it
 * is the moulded hull `halfBreadthAt`, above it the wall between the bulwark's
 * inner and outer faces plus the caprail's overhang, both of which tumble home
 * as they rise. `hullForm.ts` owns all of it — nothing here re-derives where the
 * ship's side is, which is the rule that round cost four reports to learn.
 */
describe('rig — no rope passes through the bulwark or the hull', () => {
  const SAMPLES = 96;

  /** How deep inside the ship's side a point is, metres. Negative is clear. */
  function depthInside(x: number, y: number, zPlaced: number): number {
    // Where the point *is* is not the station it belongs to. Abaft the shear the
    // counter carries the ship's side up to 0.79 m aft of its own station, and
    // that overhang is precisely where the main sheet crosses the rail — so a
    // test written in station coordinates has its blind spot exactly over the
    // fault.
    const z = counterStationZ(zPlaced, y);
    if (!Number.isFinite(z) || Math.abs(z) > HALF_LENGTH) return -1;
    const ax = Math.abs(x);
    const deck = walkingDeckY(z);
    if (y <= deck) {
      // Inside the moulded body: the shell is a surface, so being inboard of it
      // is only a fault if the rope has no business below deck at all — which
      // is what a sheet crossing the planking is.
      const half = halfBreadthAt(z, y);
      return half > 0 ? half - ax : -1;
    }
    const section = railSection(z);
    if (y > section.capY) return -1;
    const outer =
      y > section.topY ? section.capOuterX : bulwarkOuterHalfBeam(z, y) + 1e-6;
    const inner = y > section.topY ? section.capInnerX : outer - BULWARK_THICKNESS;
    if (ax > outer || ax < inner) return -1;
    return Math.min(outer - ax, ax - inner);
  }

  it('keeps every rope outside the planking and the rail', () => {
    const fouls: string[] = [];
    for (const run of [...STANDING_RIGGING, ...RUNNING_RIGGING]) {
      const a = rigNode(run.from);
      const b = rigNode(run.to);
      // The ROPE, not its centreline, and the rope as *drawn*, not the chord
      // between its ends. A main sheet 34 mm thick sagging 18% of its length
      // cleared the caprail on both counts and was still inside it — which is
      // the version Ash could see and this test could not.
      const radius = run.diameter / 2;
      // A rope that is MADE FAST to the ship ends in her timber: a bobstay is
      // bolted to the stem, a pin goes through a rail. Only the run between the
      // ends is the ship's business, so an end that is itself inside excuses the
      // samples nearest it.
      const startsInside = depthInside(a.x, a.y, a.z) > 0;
      const endsInside = depthInside(b.x, b.y, b.z) > 0;
      let worst = 0;
      let worstAt = '';
      for (let i = 0; i <= SAMPLES; i++) {
        const t = i / SAMPLES;
        if (startsInside && t < 0.15) continue;
        if (endsInside && t > 0.85) continue;
        const q = riggingRunPoint(run, t);
        // The deepest point of a round rope is its surface, so probe the
        // centreline and the four points a radius away from it.
        let depth = depthInside(q.x, q.y, q.z);
        for (const [dx, dy] of [
          [radius, 0],
          [-radius, 0],
          [0, radius],
          [0, -radius],
        ]) {
          depth = Math.max(depth, depthInside(q.x + dx, q.y + dy, q.z));
        }
        const x = q.x;
        const y = q.y;
        const z = q.z;
        if (depth > worst) {
          worst = depth;
          worstAt = `x ${x.toFixed(2)} y ${y.toFixed(2)} z ${z.toFixed(2)}`;
        }
      }
      // A rope that BELAYS to the rail ends in it: a pin goes through the
      // timber. Only the run between the ends is the ship's business.
      const belays = /Pin$|Fairlead$/.test(run.to) || /Pin$|Fairlead$/.test(run.from);
      if (worst > (belays ? 0.09 : 0.005)) {
        fouls.push(`${run.name} is ${(worst * 1000).toFixed(0)} mm inside the ship at ${worstAt}`);
      }
    }
    expect(fouls, fouls.join('\n')).toEqual([]);
  });
});
