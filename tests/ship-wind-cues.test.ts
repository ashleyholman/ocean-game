import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  RATLINES,
  RUNNING_RIGGING,
  SAILS,
  SPARS,
  STANDING_RIGGING,
  rigNode,
} from '../src/vessel/schooner/rig';
import type { Spar } from '../src/vessel/schooner/rig';
import { buildRigGeometry, riggingRunPoint, sailSurface } from '../src/vessel/schooner/rigGeometry';
import { buildShipGeometry } from '../src/vessel/schooner/shipGeometry';
import {
  WIND_CUES,
  WIND_CUE_KINDS,
  windCueBasis,
  windCueClothPoint,
  windCueDroopRad,
  windCueSweptPoint,
} from '../src/vessel/schooner/windCues';
import type { WindCue, WindCueKind } from '../src/vessel/schooner/windCues';
import { buildWindCueGeometry } from '../src/vessel/schooner/windCueGeometry';
import { WindCueSet } from '../src/vessel/schooner/windCueSet';
import { deckStandAt } from '../src/vessel/schooner/deckSurface';
import { DEFAULT_WALKER_TUNING } from '../src/player/DeckWalker';
import {
  CAPRAIL_OVERHANG,
  CAPRAIL_THICKNESS,
  HALF_LENGTH,
  bulwarkOuterHalfBeam,
  bulwarkTopY,
  counterStationZ,
} from '../src/vessel/schooner/hullForm';

/**
 * The wind cues' acceptance tests.
 *
 * THE SWEEP IS THE POINT
 * ----------------------
 * Every other object on this ship is somewhere. A wind cue is *everywhere on a
 * disc*: it points wherever the wind does and it droops toward the deck as the
 * wind drops, so its placement is a swept volume rather than a position, and a
 * clearance measured at one wind direction says nothing about the other 359.
 * This file sweeps all of them, and the sweep is what chose every number in
 * `windCues.ts` — the ensign staff's height, the pig stick's length, the
 * pennant's droop bound. `docs/ship/SHIP_RIG_HANDOVER.md`'s trim-envelope doctrine, with
 * wind direction as the continuous dimension instead of trim.
 *
 * It measures the cloth **that is drawn** — `windCueClothPoint`, the same
 * function the loft builds its vertices from — and not the idealised line from
 * the hoist to the fly. `docs/ship/SHIP_DECK_HANDOVER.md` §2: a main sheet was cleared by
 * measuring the straight line between its ends while the drawn rope sagged 18%
 * and lay 31 mm inside the caprail.
 */

type V = { x: number; y: number; z: number };

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: V): number => Math.hypot(a.x, a.y, a.z);

function pointToSegment(pt: V, a: V, b: V): number {
  const ab = sub(b, a);
  const ap = sub(pt, a);
  const d = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const t = d < 1e-12 ? 0 : Math.min(Math.max((ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / d, 0), 1);
  return len(sub(pt, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t }));
}

/** Closest distance from a point to a triangle, by projection then edges. */
function pointToTriangle(p: V, a: V, b: V, c: V): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const area = len(n);
  if (area < 1e-12) {
    return Math.min(
      pointToSegment(p, a, b),
      pointToSegment(p, b, c),
      pointToSegment(p, a, c),
    );
  }
  const unit = { x: n.x / area, y: n.y / area, z: n.z / area };
  const ap = sub(p, a);
  const height = ap.x * unit.x + ap.y * unit.y + ap.z * unit.z;
  const projected = {
    x: p.x - unit.x * height,
    y: p.y - unit.y * height,
    z: p.z - unit.z * height,
  };
  // Barycentric, by the areas of the three sub-triangles.
  const inside = (u: V, v: V, w: V): boolean => {
    const e = sub(v, u);
    const f = sub(w, u);
    const cross = {
      x: e.y * f.z - e.z * f.y,
      y: e.z * f.x - e.x * f.z,
      z: e.x * f.y - e.y * f.x,
    };
    return cross.x * unit.x + cross.y * unit.y + cross.z * unit.z >= -1e-9;
  };
  if (inside(a, b, projected) && inside(b, c, projected) && inside(c, a, projected)) {
    return Math.abs(height);
  }
  return Math.min(
    pointToSegment(p, a, b),
    pointToSegment(p, b, c),
    pointToSegment(p, a, c),
  );
}

interface Obstacle {
  readonly name: string;
  /** A bounding sphere, so the sweep can drop what it cannot possibly reach. */
  readonly centre: V;
  readonly bound: number;
  distance(p: V): number;
}

function boundOf(points: readonly V[], pad: number): { centre: V; bound: number } {
  const centre = { x: 0, y: 0, z: 0 };
  for (const p of points) {
    centre.x += p.x / points.length;
    centre.y += p.y / points.length;
    centre.z += p.z / points.length;
  }
  let bound = 0;
  for (const p of points) bound = Math.max(bound, len(sub(p, centre)));
  return { centre, bound: bound + pad };
}

/**
 * Everything the rig carries, as a distance field.
 *
 * Spars take their larger radius over their whole length and sails are sampled
 * on the bellied surface rather than as flat quads, both of which err toward
 * reporting a foul that is not there. That is the direction to err in: a cue
 * that has to be moved because the test was pessimistic costs nothing, and one
 * that ships inside a stay costs Ash's eye.
 */
function buildRigObstacles(): Obstacle[] {
  const out: Obstacle[] = [];

  for (const spar of SPARS) {
    const radius = Math.max(spar.heelRadius, spar.headRadius);
    out.push({
      name: `spar:${spar.name}`,
      ...boundOf([spar.heel, spar.head], radius),
      distance: (p) => pointToSegment(p, spar.heel, spar.head) - radius,
    });
  }

  const runs = [...STANDING_RIGGING, ...RUNNING_RIGGING];
  for (const run of runs) {
    const pts: V[] = [];
    for (let i = 0; i <= 20; i++) pts.push(riggingRunPoint(run, i / 20));
    out.push({
      name: `rope:${run.name}`,
      ...boundOf(pts, run.diameter / 2),
      distance: (p) => {
        let best = Infinity;
        for (let i = 0; i < pts.length - 1; i++) {
          best = Math.min(best, pointToSegment(p, pts[i], pts[i + 1]) - run.diameter / 2);
        }
        return best;
      },
    });
  }

  for (const sail of SAILS) {
    const surface = sailSurface(sail);
    const pts: V[] = [];
    const n = 14;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) pts.push(surface(i / n, j / n));
    out.push({
      name: `sail:${sail.name}`,
      ...boundOf(pts, 0),
      distance: (p) => {
        let best = Infinity;
        for (const q of pts) best = Math.min(best, len(sub(p, q)));
        return best;
      },
    });
  }

  // Ratlines are rungs between named shrouds at a height, so they are found on
  // the shroud runs rather than described a second time here.
  //
  // A rung names the *node* its ends land on, not the run — `mainChannelPort0`,
  // which is a chain-plate seat, against a run called `mainShroud10`. Looking
  // them up by run name silently found nothing and left the ratlines out of the
  // sweep entirely, which is why the count is asserted below rather than
  // trusted: an obstacle set that quietly contains 86 fewer objects than it
  // claims is the shape of every fault this ship's tests have caught.
  const shroudPointAtY = (node: string, y: number): V | null => {
    const run = runs.find((r) => r.to === node || r.from === node);
    if (!run) return null;
    let best: V | null = null;
    let bestErr = Infinity;
    for (let i = 0; i <= 60; i++) {
      const p = riggingRunPoint(run, i / 60);
      const err = Math.abs(p.y - y);
      if (err < bestErr) {
        bestErr = err;
        best = p;
      }
    }
    return bestErr < 0.5 ? best : null;
  };
  const rungs: [V, V][] = [];
  for (const rung of RATLINES) {
    const a = shroudPointAtY(rung.fromShroud, rung.y);
    const b = shroudPointAtY(rung.toShroud, rung.y);
    if (a && b) rungs.push([a, b]);
  }
  expect(rungs.length, 'every ratline rung was located on its shrouds').toBe(RATLINES.length);
  out.push({
    name: 'ratlines',
    ...boundOf(rungs.flat(), 0.02),
    distance: (p) => {
      let best = Infinity;
      for (const [a, b] of rungs) best = Math.min(best, pointToSegment(p, a, b) - 0.02);
      return best;
    },
  });

  return out;
}

/**
 * The obstacles a cue could conceivably reach, by bounding sphere.
 *
 * A broad phase, and it is worth the twenty lines: the sweep evaluates order
 * 10⁵ points per cue and the ship carries ninety-odd objects, almost all of them
 * tens of metres away from any one cue. It is a filter on *distance* alone, so
 * it cannot hide a foul — an obstacle it drops is one the cloth cannot touch,
 * and the margin below is generous.
 */
function reachableBy(cue: WindCue, obstacles: readonly Obstacle[]): Obstacle[] {
  const reach = cue.standoff + cue.fly + Math.max(cue.hoistDepth, cue.flyDepth) + 0.5;
  return obstacles.filter(
    (o) => len(sub(o.centre, cue.staff.head)) <= o.bound + reach,
  );
}

/**
 * The staffs, as obstacles to *each other's* cloth.
 *
 * A cue is allowed to hang against its own staff — that is what a halyard does
 * — but the three of them must not reach one another, and none of them may
 * reach a staff it is not bent to.
 */
function staffObstacles(exclude: WindCue): Obstacle[] {
  return WIND_CUES.filter((cue) => cue !== exclude).map((cue) => ({
    name: `staff:${cue.name}`,
    ...boundOf(
      [cue.staff.foot, cue.staff.head],
      Math.max(cue.staff.footRadius, cue.staff.headRadius),
    ),
    distance: (p: V) =>
      pointToSegment(p, cue.staff.foot, cue.staff.head) -
      Math.max(cue.staff.footRadius, cue.staff.headRadius),
  }));
}

/**
 * Is this point inside the hull's own envelope — the deck, the bulwark, the
 * caprail — rather than in clear air outboard or abaft her?
 *
 * `counterStationZ` is the one inversion on this ship that turns *where a thing
 * is* into *which station it belongs to*, and it is used here because the ensign
 * staff stands exactly where it matters: abaft the counter's shear, where a
 * placed z and a station z differ by up to 0.79 m. `docs/ship/SHIP_DECK_HANDOVER.md`
 * counted seven separate faults from reading one as the other.
 */
function insideHullEnvelope(p: V): boolean {
  const station = counterStationZ(p.z, p.y);
  if (!Number.isFinite(station)) return false;
  if (station > HALF_LENGTH || station < -HALF_LENGTH) return false;
  const capTop = bulwarkTopY(station) + CAPRAIL_THICKNESS;
  if (p.y > capTop) return false;
  const halfBeam = bulwarkOuterHalfBeam(station, Math.min(p.y, capTop)) + CAPRAIL_OVERHANG;
  return Math.abs(p.x) <= halfBeam;
}

interface SweepResult {
  distance: number;
  obstacle: string;
  headingDeg: number;
  droopDeg: number;
}

/**
 * The worst clearance over every wind direction and every droop up to `maxDroop`.
 *
 * Headings at 5°, droop at 2.5°, and the cloth on a 17 × 5 grid: fine enough
 * that the binding configuration is found rather than stepped over, which is the
 * failure mode of a coarse sweep and the reason the first pass of this round
 * reported an ensign placement as clear when it was 71 mm inside its own gaff.
 */
function sweepCue(cue: WindCue, obstacles: Obstacle[], maxDroopRad: number): SweepResult {
  let worst: SweepResult = {
    distance: Infinity,
    obstacle: '',
    headingDeg: 0,
    droopDeg: 0,
  };
  const droopSteps = Math.max(1, Math.round((maxDroopRad * 180) / Math.PI / 2.5));
  for (let h = 0; h < 360; h += 5) {
    const heading = (h * Math.PI) / 180;
    for (let d = 0; d <= droopSteps; d++) {
      const droop = (maxDroopRad * d) / droopSteps;
      for (let i = 0; i <= 16; i++) {
        for (let j = 0; j <= 4; j++) {
          const p = windCueSweptPoint(cue, heading, droop, i / 16, j / 4);
          for (const obstacle of obstacles) {
            const distance = obstacle.distance(p);
            if (distance < worst.distance) {
              worst = {
                distance,
                obstacle: obstacle.name,
                headingDeg: h,
                droopDeg: (droop * 180) / Math.PI,
              };
            }
          }
        }
      }
    }
  }
  return worst;
}

describe('wind cues — the swept cloth clears the ship at every wind direction', () => {
  const rigObstacles = buildRigObstacles();

  /**
   * The margins each cue was placed to hold. They are recorded rather than
   * asserted loosely, so that a rig change which eats one shows up as a number
   * that moved and not as a test that still passes with 2 mm in hand.
   */
  const REQUIRED_MARGIN: Record<WindCueKind, number> = {
    // Nearest to the main sheet, which drops from the boom to the horse abaft
    // the rudder head, straight through the airspace over the taffrail. That
    // rope is what set the staff's height: at 1.86 m of staff the cloth was
    // inside it.
    ensign: 0.35,
    // Nearest to the topsail braces, which end at the masthead the pennant is
    // hoisted at. That pair is what set the pig stick's length and the droop
    // bound both.
    pennant: 0.25,
    // Nothing is near it. There is the better part of a metre of clear air all
    // round the quarter rail, which is why the dogvane's numbers were free to be
    // chosen for legibility from the helm instead.
    dogvane: 0.8,
  };

  for (const cue of WIND_CUES) {
    it(`sweeps the ${cue.name} clear of every spar, rope, sail and ratline`, {
      tags: ['slow', 'rig-geometry'],
      timeout: 120_000,
    }, () => {
      const worst = sweepCue(
        cue,
        reachableBy(cue, [...rigObstacles, ...staffObstacles(cue)]),
        cue.maxDroopRad,
      );
      expect(
        worst.distance,
        `${cue.name} comes within ${worst.distance.toFixed(3)} m of ${worst.obstacle} ` +
          `at heading ${worst.headingDeg}°, droop ${worst.droopDeg.toFixed(1)}°`,
      ).toBeGreaterThan(REQUIRED_MARGIN[cue.kind]);
    });
  }

  it('keeps every cue out of the hull, the bulwark and the caprail', () => {
    for (const cue of WIND_CUES) {
      const droopSteps = 12;
      for (let h = 0; h < 360; h += 10) {
        const heading = (h * Math.PI) / 180;
        for (let d = 0; d <= droopSteps; d++) {
          const droop = (cue.maxDroopRad * d) / droopSteps;
          for (let i = 0; i <= 8; i++) {
            for (let j = 0; j <= 4; j++) {
              const p = windCueSweptPoint(cue, heading, droop, i / 8, j / 4);
              expect(
                insideHullEnvelope(p),
                `${cue.name} reaches inside the hull envelope at ` +
                  `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}), ` +
                  `heading ${h}°`,
              ).toBe(false);
            }
          }
        }
      }
    }
  }, 60_000);
});

describe('wind cues — the droop bound is a solve, not a guess', () => {
  const rigObstacles = buildRigObstacles();

  /**
   * A bound that no longer binds is a number nobody owns.
   *
   * `docs/ship/SHIP_DECK_HANDOVER.md` §9: the ladder-gap test "asserted a bound about a
   * fife rail that was never in the flight" — it justified the number written
   * beside it and was wrong about why. So for every cue whose droop is limited
   * by geometry, this asserts the limit is *real*: go past it and the cloth
   * fouls. The ensign is exempt and says so, because nothing binds it — its
   * bound is a right angle, which is a flag hanging down its own staff.
   */
  const BOUND_BY_GEOMETRY: Record<WindCueKind, boolean> = {
    ensign: false,
    pennant: true,
    dogvane: false,
  };

  for (const cue of WIND_CUES) {
    if (!BOUND_BY_GEOMETRY[cue.kind]) {
      it(`records that nothing binds the ${cue.name}'s droop`, {
        tags: ['slow', 'rig-geometry'],
        timeout: 120_000,
      }, () => {
        const beyond = sweepCue(
          cue,
          reachableBy(cue, [...rigObstacles, ...staffObstacles(cue)]),
          Math.min(cue.maxDroopRad + (15 * Math.PI) / 180, Math.PI / 2),
        );
        expect(
          beyond.distance,
          `${cue.name} is documented as unbound but fouls ${beyond.obstacle} past its bound`,
        ).toBeGreaterThan(0);
      });
      continue;
    }

    it(`fouls past the ${cue.name}'s droop bound, which is what makes it a bound`, {
      tags: ['slow', 'rig-geometry'],
      timeout: 120_000,
    }, () => {
      const beyond = sweepCue(
        cue,
        reachableBy(cue, [...rigObstacles, ...staffObstacles(cue)]),
        cue.maxDroopRad + (15 * Math.PI) / 180,
      );
      expect(
        beyond.distance,
        `${cue.name} still clears 15° past its stated bound — the bound is stale ` +
          'or the rig moved away from it',
      ).toBeLessThan(0.05);
    });
  }
});

describe('wind cues — droop follows the wind, and the physics is the shape of it', () => {
  it('stands at 45 degrees at its own limp speed, for every cue', () => {
    for (const cue of WIND_CUES) {
      const droop = windCueDroopRad(cue, cue.limpSpeedMps);
      // Unless the clamp is below 45°, in which case the clamp is the answer.
      const expected = Math.min(Math.PI / 4, cue.maxDroopRad);
      expect(droop, cue.name).toBeCloseTo(expected, 6);
    }
  });

  it('droops monotonically as the wind drops, and never past its bound', () => {
    for (const cue of WIND_CUES) {
      let previous = -Infinity;
      for (let v = 20; v >= 0; v -= 0.25) {
        const droop = windCueDroopRad(cue, v);
        expect(droop, `${cue.name} at ${v} m/s`).toBeGreaterThanOrEqual(previous - 1e-12);
        expect(droop).toBeLessThanOrEqual(cue.maxDroopRad + 1e-12);
        previous = droop;
      }
      expect(windCueDroopRad(cue, 0), `${cue.name} in a flat calm`).toBeCloseTo(
        cue.maxDroopRad,
        9,
      );
    }
  });

  it('stands the pennant nearly out in a working breeze', () => {
    // CURRENT_MODERATE is 6 m/s. A pennant that still hangs at a third of a
    // right angle in that reads as a becalmed ship under way.
    const pennant = WIND_CUES.find((c) => c.kind === 'pennant')!;
    expect((windCueDroopRad(pennant, 6) * 180) / Math.PI).toBeLessThan(10);
  });
});

describe('wind cues — the direction convention, pinned', () => {
  /**
   * Signs are set by test, not by reasoning. `docs/sailing/SAILING_PROJECT_PLAN.md`'s rule 6,
   * after this codebase burned a full round on each of two sign conventions.
   *
   * The claim: for a wind blowing *toward* heading h, the cloth's fly points
   * along `(sin h, 0, −cos h)` — the same vector `WorldWind.windRenderVector`
   * builds from a compass bearing. A flag streams downwind, so the fly and the
   * wind are the same direction, and the flag's own body is upwind of its fly.
   */
  it('lays the fly down the wind, in the axes every wind quantity here uses', () => {
    for (const headingDeg of [0, 45, 90, 180, 270, 315]) {
      const heading = (headingDeg * Math.PI) / 180;
      const basis = windCueBasis(heading, 0);
      expect(basis.x.x).toBeCloseTo(Math.sin(heading), 9);
      expect(basis.x.y).toBeCloseTo(0, 9);
      expect(basis.x.z).toBeCloseTo(-Math.cos(heading), 9);
      // A flag at rest hangs its drop straight down, whatever way it points.
      expect(basis.y.x).toBeCloseTo(0, 9);
      expect(basis.y.y).toBeCloseTo(1, 9);
    }
  });

  it('tips the fly below the horizontal as it droops, and only below', () => {
    for (const droopDeg of [0, 15, 40, 88]) {
      const droop = (droopDeg * Math.PI) / 180;
      const basis = windCueBasis(Math.PI / 3, droop);
      expect(basis.x.y).toBeCloseTo(-Math.sin(droop), 9);
    }
  });

  /**
   * The basis is a shear, and the shear is the fix for the fault Ash saw first:
   * a flag whose luff had left its own staff. So this asserts the shear rather
   * than orthogonality — the luff is vertical at every droop, the axes are unit
   * length, the normal is perpendicular to both, and the two in-plane axes are
   * out of square by exactly the droop.
   */
  it('shears rather than rotates, so the luff stays on the halyard', () => {
    const dot = (p: V, q: V) => p.x * q.x + p.y * q.y + p.z * q.z;
    for (const headingDeg of [0, 37, 128, 249]) {
      for (const droopDeg of [0, 22, 61]) {
        const droop = (droopDeg * Math.PI) / 180;
        const b = windCueBasis((headingDeg * Math.PI) / 180, droop);
        expect(dot(b.x, b.x)).toBeCloseTo(1, 9);
        expect(dot(b.z, b.z)).toBeCloseTo(1, 9);
        // The luff does not move. This is the whole of the fix.
        expect(b.y.x).toBeCloseTo(0, 12);
        expect(b.y.y).toBeCloseTo(1, 12);
        expect(b.y.z).toBeCloseTo(0, 12);
        // Out of square by the droop, which is what makes it a shear.
        expect(dot(b.x, b.y)).toBeCloseTo(-Math.sin(droop), 9);
        // And the normal is still honest.
        expect(dot(b.z, b.x)).toBeCloseTo(0, 9);
        expect(dot(b.z, b.y)).toBeCloseTo(0, 9);
      }
    }
  });

  /**
   * The regression for what a rotation did: at 24° of droop the bottom of the
   * ensign's luff stood 0.28 m off its own staff, and a flag detached from the
   * thing it is bent to is the first thing an eye finds. Measured on the swept
   * cloth, at every droop each cue can reach.
   */
  it('holds every cue’s luff against its own staff, at every droop', () => {
    for (const cue of WIND_CUES) {
      for (let h = 0; h < 360; h += 30) {
        const heading = (h * Math.PI) / 180;
        for (let d = 0; d <= 8; d++) {
          const droop = (cue.maxDroopRad * d) / 8;
          for (let v = 0; v <= 1; v += 0.25) {
            const p = windCueSweptPoint(cue, heading, droop, 0, v);
            const off = pointToSegment(p, cue.staff.foot, cue.staff.head);
            expect(
              off,
              `${cue.name}'s luff is ${off.toFixed(3)} m off its staff at ` +
                `${((droop * 180) / Math.PI).toFixed(0)}° of droop`,
            ).toBeLessThan(cue.standoff + 0.02);
          }
        }
      }
    }
  });
});

describe('wind cues — every staff lands on the thing it is socketed in', () => {
  /**
   * Measured against the **drawn** ship and the **drawn** rig, not against the
   * constants they were derived from.
   *
   * That is the mesh-against-surface argument from `docs/ship/SHIP_DECK_HANDOVER.md` §3:
   * checking a staff foot against the same expression that placed it proves
   * nothing, because they are the same expression. The hull loft applies the
   * counter's rake as it places each vertex; `windCues.ts` inverts it. Two
   * different computations, one rail, so agreement is a result.
   */
  const ship = buildShipGeometry();
  const rig = buildRigGeometry();

  /**
   * Distance to the nearest drawn *surface*, not the nearest drawn vertex.
   *
   * The first version of this measured vertices and reported the ensign staff as
   * standing 1.002 m off the taffrail it is in fact bang on the middle of. The
   * transom's caprail is emitted as one quad the full width of the stern, so its
   * only vertices are its four corners and the centreline is a metre from all of
   * them. **A vertex is not the surface**, and on a loft that emits large flat
   * panels the difference is the width of the panel.
   */
  function distanceToSurface(geometry: THREE.BufferGeometry | undefined, p: V): number {
    if (!geometry) return Infinity;
    const position = geometry.getAttribute('position');
    const index = geometry.index!;
    let best = Infinity;
    const at = (i: number): V => ({
      x: position.getX(i),
      y: position.getY(i),
      z: position.getZ(i),
    });
    for (let t = 0; t < index.count / 3; t++) {
      const a = at(index.getX(t * 3));
      const b = at(index.getX(t * 3 + 1));
      const c = at(index.getX(t * 3 + 2));
      best = Math.min(best, pointToTriangle(p, a, b, c));
      if (best < 1e-4) return best;
    }
    return best;
  }

  it('steps the ensign staff on the drawn taffrail', () => {
    const cue = WIND_CUES.find((c) => c.kind === 'ensign')!;
    const distance = distanceToSurface(ship.geometries.get('trim'), cue.staff.foot);
    expect(
      distance,
      `the ensign staff's foot is ${distance.toFixed(3)} m off the drawn rail`,
    ).toBeLessThan(0.01);
  });

  it('clamps the dogvane’s bracket to the drawn quarter caprail', () => {
    const cue = WIND_CUES.find((c) => c.kind === 'dogvane')!;
    const distance = distanceToSurface(ship.geometries.get('trim'), cue.bracket!.from);
    expect(distance, `the dogvane's bracket is ${distance.toFixed(3)} m off the drawn rail`)
      .toBeLessThan(0.01);
    // And the spindle stands on the bracket's end rather than in mid-air beside
    // it — the bowsprit heel's lesson, which ended in nothing until Ash asked.
    expect(
      len(sub(cue.staff.foot, cue.bracket!.to)),
      'the dogvane’s spindle does not stand on its own bracket',
    ).toBeLessThan(1e-9);
  });

  it('steps the pig stick on the drawn main truck', () => {
    const cue = WIND_CUES.find((c) => c.kind === 'pennant')!;
    const distance = distanceToSurface(rig.geometries.get('spar'), cue.staff.foot);
    expect(distance, `the pig stick's foot is ${distance.toFixed(3)} m off the drawn truck`)
      .toBeLessThan(0.02);
    // And it is the *main* truck, which is the highest stick she has. A pennant
    // at the fore truck would be a pennant on the wrong mast.
    const truck = rigNode('mainTopmastHead');
    const highest = SPARS.reduce(
      (best: Spar, spar) => (spar.head.y > best.head.y ? spar : best),
      SPARS[0],
    );
    expect(highest.head.y).toBeCloseTo(truck.y, 6);
  });

  it('stands every staff on its foot and not through it', () => {
    for (const cue of WIND_CUES) {
      expect(cue.staff.head.y, `${cue.name} staff rises`).toBeGreaterThan(cue.staff.foot.y);
      expect(cue.staff.headRadius).toBeLessThan(cue.staff.footRadius);
    }
  });
});

describe('wind cues — nobody can walk into one', () => {
  /**
   * All three are declared not collidable, and each reason is a claim about
   * reach. This is the claim, measured: no standable point on the deck puts a
   * body's footprint within reach of a staff.
   */
  /**
   * A body stands where its whole *footprint* is deck, not where its centre is.
   *
   * The first version of this measured to the nearest standable point and put
   * the ensign staff 0.220 m from one — inside a 0.26 m body — which would have
   * meant the classification above was false. It is not: the deck's after edge
   * is the inboard face of the transom bulwark, and `ship-deck.test.ts` holds
   * the walker "inside the rail by a body radius, not balanced on the edge", so
   * a body's centre never gets within a radius of that edge. Measuring to the
   * edge of the floor rather than to the last place a body can stand understates
   * the gap by exactly one radius, which was the whole margin.
   */
  function occupiable(x: number, z: number): boolean {
    if (!deckStandAt(x, z)) return false;
    const r = DEFAULT_WALKER_TUNING.radius;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (!deckStandAt(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false;
    }
    return true;
  }

  it('keeps every staff out of a walking body’s reach', () => {
    const reach = DEFAULT_WALKER_TUNING.radius;
    for (const cue of WIND_CUES) {
      const staffRadius = Math.max(cue.staff.footRadius, cue.staff.headRadius);
      // The whole assembly, not just the staff: a bracket is solid too.
      const parts: { a: V; b: V }[] = [{ a: cue.staff.foot, b: cue.staff.head }];
      if (cue.bracket) parts.push({ a: cue.bracket.from, b: cue.bracket.to });
      const lowest = Math.min(...parts.map((p) => Math.min(p.a.y, p.b.y)));
      let closest = Infinity;
      for (let x = -3.0; x <= 3.0; x += 0.05) {
        for (let z = -9.0; z <= 8.0; z += 0.05) {
          if (!occupiable(x, z)) continue;
          const stand = deckStandAt(x, z)!;
          // Only the part of the assembly a standing body could occupy at all.
          if (lowest > stand.y + DEFAULT_WALKER_TUNING.standingHeight) continue;
          for (const part of parts) {
            closest = Math.min(
              closest,
              pointToSegment(
                { x, y: 0, z },
                { x: part.a.x, y: 0, z: part.a.z },
                { x: part.b.x, y: 0, z: part.b.z },
              ),
            );
          }
        }
      }
      if (closest === Infinity) continue; // Nothing standable is at its height.
      expect(
        closest,
        `${cue.name}'s staff is ${closest.toFixed(3)} m from where a body can stand`,
      ).toBeGreaterThan(reach + staffRadius);
    }
  });

  it('classifies every kind of cue, and uses every classification', () => {
    for (const cue of WIND_CUES) {
      expect(cue.kind in WIND_CUE_KINDS, `${cue.kind} is not in WIND_CUE_KINDS`).toBe(true);
    }
    for (const [kind, entry] of Object.entries(WIND_CUE_KINDS)) {
      expect(
        WIND_CUES.some((cue) => cue.kind === kind),
        `WIND_CUE_KINDS classifies ${kind}, which no cue is`,
      ).toBe(true);
      expect(entry.reason.length, `${kind} is classified without a reason`).toBeGreaterThan(40);
    }
  });
});

describe('wind cues — the geometry is the shape the data describes', () => {
  const built = buildWindCueGeometry();

  function windingAgreement(geometry: THREE.BufferGeometry): {
    agree: number;
    disagree: number;
  } {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const idx = geometry.index!;
    let agree = 0;
    let disagree = 0;
    for (let t = 0; t < idx.count / 3; t++) {
      const ia = idx.getX(t * 3);
      const ib = idx.getX(t * 3 + 1);
      const ic = idx.getX(t * 3 + 2);
      const a = { x: pos.getX(ia), y: pos.getY(ia), z: pos.getZ(ia) };
      const b = { x: pos.getX(ib), y: pos.getY(ib), z: pos.getZ(ib) };
      const c = { x: pos.getX(ic), y: pos.getY(ic), z: pos.getZ(ic) };
      const u = sub(b, a);
      const v = sub(c, a);
      const face = {
        x: u.y * v.z - u.z * v.y,
        y: u.z * v.x - u.x * v.z,
        z: u.x * v.y - u.y * v.x,
      };
      const supplied = {
        x: (nor.getX(ia) + nor.getX(ib) + nor.getX(ic)) / 3,
        y: (nor.getY(ia) + nor.getY(ib) + nor.getY(ic)) / 3,
        z: (nor.getZ(ia) + nor.getZ(ib) + nor.getZ(ic)) / 3,
      };
      const dot = face.x * supplied.x + face.y * supplied.y + face.z * supplied.z;
      if (dot > 0) agree++;
      else disagree++;
    }
    return { agree, disagree };
  }

  /**
   * The third time this exact check has been written on this ship, and the third
   * kind of object it covers. Cap discs came out inverted on all 488 of them
   * from an argument that sounded right; cloth is `DoubleSide`, which is the
   * case where an inverted winding lights the face away from the sun.
   */
  it('winds every cloth triangle to agree with its supplied normal', () => {
    for (const [name, geometry] of built.cloths) {
      const { agree, disagree } = windingAgreement(geometry);
      expect(agree, `${name} has no triangles`).toBeGreaterThan(0);
      expect(disagree, `${name}: ${disagree} inverted triangles`).toBe(0);
    }
  });

  it('winds every staff triangle to agree with its supplied normal', () => {
    const { agree, disagree } = windingAgreement(built.staffs);
    expect(agree).toBeGreaterThan(0);
    expect(disagree, `staffs: ${disagree} inverted triangles`).toBe(0);
  });

  /**
   * The staffs are closed solids and the cloth is not, and both halves matter.
   *
   * An open tube end does not read as a hole, it reads as *transparency* —
   * `shipwright.ts`'s note, found on every round object aboard in M3. A flag has
   * no inside to see into, so it is deliberately an open sheet, and this states
   * that so nobody closes it and doubles its triangles.
   */
  function openEdgeCount(geometry: THREE.BufferGeometry): number {
    const idx = geometry.index!;
    const pos = geometry.getAttribute('position');
    const key = (i: number): string =>
      `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    const uses = new Map<string, number>();
    for (let t = 0; t < idx.count / 3; t++) {
      const ids = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
      for (let e = 0; e < 3; e++) {
        const edge = [key(ids[e]), key(ids[(e + 1) % 3])].sort().join('|');
        uses.set(edge, (uses.get(edge) ?? 0) + 1);
      }
    }
    let open = 0;
    for (const count of uses.values()) if (count % 2 === 1) open++;
    return open;
  }

  it('closes every staff', () => {
    expect(openEdgeCount(built.staffs), 'a staff has an open end').toBe(0);
  });

  it('leaves every piece of cloth open, deliberately', () => {
    for (const [name, geometry] of built.cloths) {
      expect(openEdgeCount(geometry), `${name} was closed into a solid`).toBeGreaterThan(0);
    }
  });

  it('draws no cloth outside the fly and drop the data describes', () => {
    for (const cue of WIND_CUES) {
      const geometry = built.cloths.get(cue.name)!;
      const pos = geometry.getAttribute('position');
      const maxDepth = Math.max(cue.hoistDepth, cue.flyDepth);
      for (let i = 0; i < pos.count; i++) {
        expect(pos.getX(i), `${cue.name} x`).toBeGreaterThanOrEqual(-1e-6);
        expect(pos.getX(i)).toBeLessThanOrEqual(cue.fly + 1e-6);
        expect(pos.getY(i), `${cue.name} y`).toBeLessThanOrEqual(1e-6);
        expect(pos.getY(i)).toBeGreaterThanOrEqual(-maxDepth - 1e-6);
        expect(Math.abs(pos.getZ(i)), `${cue.name} z`).toBeLessThanOrEqual(
          cue.waveAmplitude + 1e-6,
        );
      }
    }
  });

  it('holds the luff straight, so the cloth reads as bent to something', () => {
    for (const cue of WIND_CUES) {
      for (let v = 0; v <= 1; v += 0.25) {
        expect(Math.abs(windCueClothPoint(cue, 0, v).z), cue.name).toBeLessThan(1e-9);
      }
    }
  });
});

describe('wind cues — aimed, in the frame each one actually lives in', () => {
  const IDENTITY = new THREE.Quaternion();

  /**
   * The cloth's local +x is the fly, taken back out to the world through the
   * ship's rotation — what an observer sees.
   *
   * Read off the mesh's *matrix*, not its quaternion: the attitude is a shear
   * and is written straight into the matrix, so the quaternion is not the
   * transform and reading it would silently test a stale identity.
   */
  function flyDirection(mesh: THREE.Object3D, parent: THREE.Quaternion): THREE.Vector3 {
    const e = mesh.matrix.elements;
    return new THREE.Vector3(e[0], e[1], e[2]).normalize().applyQuaternion(parent);
  }

  function hoistPosition(mesh: THREE.Object3D): THREE.Vector3 {
    const e = mesh.matrix.elements;
    return new THREE.Vector3(e[12], e[13], e[14]);
  }

  /** Step to steady state, so the settling lag is not what is being measured. */
  function settle(
    cues: WindCueSet,
    apparentX: number,
    apparentZ: number,
    yaw: number,
    ship: THREE.Quaternion,
  ): void {
    for (let i = 0; i < 400; i++) cues.update(0.05, apparentX, apparentZ, yaw, ship);
  }

  it('points the ensign down the true apparent wind, not down the sheeting', () => {
    const cues = new WindCueSet();
    // A wind blowing toward the east: (sin 90°, −cos 90°) = (1, 0).
    settle(cues, 9, 0, 0, IDENTITY);
    const ensign = cues.group.children.find((c) => c.name === 'cue:ensign')!;
    const fly = flyDirection(ensign, IDENTITY);
    expect(fly.x).toBeGreaterThan(0.97);
    expect(Math.abs(fly.z)).toBeLessThan(0.05);

    // And it follows the wind round rather than holding a set angle — the whole
    // reason this round exists. The sails do not move; this does.
    settle(cues, 0, -9, 0, IDENTITY);
    const turned = flyDirection(ensign, IDENTITY);
    expect(turned.z).toBeLessThan(-0.97);
    cues.dispose();
  });

  it('leaves a free-flying cue level when she heels, and heels the dogvane with her', () => {
    const cues = new WindCueSet();
    const upright = new THREE.Quaternion();
    const heeled = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, 0, (20 * Math.PI) / 180, 'YXZ'),
    );

    settle(cues, 9, 0, 0, upright);
    const pennant = cues.group.children.find((c) => c.name === 'cue:mastheadPennant')!;
    const dogvane = cues.group.children.find((c) => c.name === 'cue:dogvane')!;
    const pennantUpright = flyDirection(pennant, upright).clone();
    const dogvaneUpright = flyDirection(dogvane, upright).clone();

    settle(cues, 9, 0, 0, heeled);
    const pennantHeeled = flyDirection(pennant, heeled);
    const dogvaneHeeled = flyDirection(dogvane, heeled);

    // The pennant hangs from a halyard: gravity and the wind set it, so 20° of
    // heel moves it not at all in the world.
    expect(pennantHeeled.angleTo(pennantUpright)).toBeLessThan(1e-6);
    // The dogvane is a vane on a spindle seized to the rail. The spindle tilts,
    // so the vane tilts — that is the difference between the two mounts, and it
    // is the reason `attitude` exists as a field.
    expect(dogvaneHeeled.angleTo(dogvaneUpright)).toBeGreaterThan(0.05);
    cues.dispose();
  });

  it('turns with the ship for a spindle cue and not for a free one', () => {
    const cues = new WindCueSet();
    // Same world wind; only the hull's yaw differs. The dogvane's *local* pose
    // must change by the yaw, because its spindle turned under it.
    settle(cues, 9, 0, 0, IDENTITY);
    const dogvane = cues.group.children.find((c) => c.name === 'cue:dogvane')!;
    const localBefore = flyDirection(dogvane, IDENTITY).clone();
    settle(cues, 9, 0, Math.PI / 2, IDENTITY);
    expect(flyDirection(dogvane, IDENTITY).angleTo(localBefore)).toBeGreaterThan(1.0);
    cues.dispose();
  });

  it('settles at the same place however the time is chopped up', () => {
    // The lag is inertia, and inertia does not depend on the frame rate.
    const fine = new WindCueSet();
    const coarse = new WindCueSet();
    fine.update(0.016, 3, 0, 0, IDENTITY);
    coarse.update(0.016, 3, 0, 0, IDENTITY);
    for (let i = 0; i < 100; i++) fine.update(0.01, 0, -3, 0, IDENTITY);
    for (let i = 0; i < 10; i++) coarse.update(0.1, 0, -3, 0, IDENTITY);

    for (const name of ['cue:ensign', 'cue:mastheadPennant', 'cue:dogvane']) {
      const a = fine.group.children.find((c) => c.name === name)!;
      const b = coarse.group.children.find((c) => c.name === name)!;
      expect(flyDirection(a, IDENTITY).angleTo(flyDirection(b, IDENTITY)), name)
        .toBeLessThan(0.02);
      expect(hoistPosition(a).distanceTo(hoistPosition(b)), name).toBeLessThan(0.005);
    }
    fine.dispose();
    coarse.dispose();
  });

  it('holds its last set in a flat calm rather than inventing a wind', () => {
    // FLAT and FROZEN_SINGLE carry 0 m/s. A cue that snapped to a default
    // heading there would be showing a wind that does not exist.
    const cues = new WindCueSet();
    settle(cues, 0, -7, 0, IDENTITY);
    const ensign = cues.group.children.find((c) => c.name === 'cue:ensign')!;
    const set = flyDirection(ensign, IDENTITY).clone();
    for (let i = 0; i < 200; i++) cues.update(0.05, 0, 0, 0, IDENTITY);
    const calm = flyDirection(ensign, IDENTITY);
    // Same bearing in plan; hanging much further down.
    expect(Math.atan2(calm.x, -calm.z)).toBeCloseTo(Math.atan2(set.x, -set.z), 3);
    expect(calm.y).toBeLessThan(set.y - 0.5);
    cues.dispose();
  });

  it('swings the hoist round the staff, so the luff is never inside it', () => {
    const cues = new WindCueSet();
    const ensignCue = WIND_CUES.find((c) => c.kind === 'ensign')!;
    for (const [x, z] of [
      [5, 0],
      [0, 5],
      [-5, 0],
      [0, -5],
    ]) {
      settle(cues, x, z, 0, IDENTITY);
      const ensign = cues.group.children.find((c) => c.name === 'cue:ensign')!;
      const offset = hoistPosition(ensign).sub(
        new THREE.Vector3(
          ensignCue.staff.head.x,
          ensignCue.staff.head.y,
          ensignCue.staff.head.z,
        ),
      );
      expect(offset.length()).toBeCloseTo(ensignCue.standoff, 4);
      // Downwind of the staff, which is the side a flag hangs on.
      const wind = new THREE.Vector3(x, 0, z).normalize();
      expect(offset.clone().normalize().dot(wind)).toBeGreaterThan(0.99);
    }
    cues.dispose();
  });
});
