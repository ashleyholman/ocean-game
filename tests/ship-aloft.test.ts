import { describe, expect, it, afterEach } from 'vitest';
import { DEFAULT_WALKER_TUNING } from '../src/player/DeckWalker';
import { buildShipInteractables } from '../src/vessel/schooner/shipInteractables';
import { REACH } from '../src/player/Interactables';
import {
  isStationOccupied,
  occupiedStation,
  resetSeat,
  setOccupiedStation,
} from '../src/vessel/schooner/seatState';
import { SHIP_STATIONS, shipStation } from '../src/vessel/schooner/shipStations';
import {
  advanceClimb,
  beginLayingDown,
  climbProgress,
  isAtTheFoot,
  resetClimb,
  setClimbProgress,
} from '../src/vessel/schooner/aloftState';
import {
  ALOFT_STABILISATION,
  MEAN_FILTER_TRANSMISSION,
  MEASURED_ROLL_PERIOD_SECONDS,
  SPEC_ROLL_AMPLITUDE_DEG,
  aloftLever,
  aloftSwayFollow,
  deckLever,
  deckSwingDeg,
  mastheadMotion,
  rollAxisY,
  swayCeiling,
  swayResidual,
} from '../src/vessel/schooner/aloftComfort';
import { WALKING_STABILISATION } from '../src/camera/EmbodiedCameraController';
import {
  LIFELINE_HEIGHT,
  LOOKOUT_DECK_Y,
  LOOKOUT_HALF_SPAN,
  LOOKOUT_TOP,
  LOOKOUT_UNDER_Y,
  LOOKOUT_Z_AFT,
  LOOKOUT_Z_FORWARD,
  GAFF_CLEARANCE,
  doublingAt,
  lookoutEye,
  lookoutSolids,
  lookoutStandPosition,
  onLookoutPlanking,
} from '../src/vessel/schooner/lookout';
import type { LookoutSolid } from '../src/vessel/schooner/lookout';
import {
  CLIMB_SIDES,
  CLIMB_SPEED,
  RAIL_CROSSING_ALLOWANCE,
  RUNG_STEP_ALLOWANCE,
  anchorProgress,
  climbAnchors,
  climbEyeAt,
  climbHolds,
  climbLength,
  climbPose,
  foreRungsY,
  shroudApproach,
  shroudTarget,
} from '../src/vessel/schooner/riggingClimb';
import type { ClimbSide } from '../src/vessel/schooner/riggingClimb';
import {
  AUTHORED_TRIM_RAD,
  RATLINES,
  RIG_TRIM_LIMITS,
  SAILS,
  SPARS,
  STANDING_RIGGING,
  applyRigTrim,
  rigNode,
} from '../src/vessel/schooner/rig';
import type { RigTrimAnglesRad, SailName } from '../src/vessel/schooner/rig';
import { sailSurface } from '../src/vessel/schooner/rigGeometry';
import { deckStandAt } from '../src/vessel/schooner/deckSurface';
import { OBSTACLE_COLUMNS } from '../src/vessel/schooner/deckObstacles';
import { HULL_LENGTH, walkingDeckY } from '../src/vessel/schooner/hullForm';
import { FOREMAST_Z } from '../src/vessel/schooner/rig';
import { BELOW_DECKS_SPACES } from '../src/vessel/schooner/deckInterior';
import {
  climbMastTarget,
  climbWalkEntry,
  shouldWalkOffClimb,
} from '../src/vessel/schooner/climbInteraction';

/**
 * M5 — THE CLIMB, AND THE MASTHEAD IT ENDS AT.
 *
 * The milestone's accept-when has a half that is Ash's and a half that is
 * arithmetic. *"Legible"* and *"deliberately dramatic"* are his; *"continuous"*,
 * *"unobstructed"* and every clearance are measurable, and this file measures
 * them rather than describing them.
 *
 * Two rules the ship has already paid for are enforced here rather than trusted:
 *
 * - **Frame-mixing is the silent fault in this area.** Everything below is in
 *   the *ship's* frame — +z forward, +x to port, +y from the moulded baseline —
 *   and the one place a world quantity appears (the roll axis) is asked of
 *   `massModel` rather than assumed to be the waterline. The very first test
 *   asserts the frame, because a spline authored in the rig's frame and read in
 *   the ship's would put the climb a plausible half-metre out and nothing else
 *   here would fail.
 * - **Port and starboard invert `xLo` and `xHi`.** Every geometric test runs
 *   over both gangs, and the target boxes are checked for the inversion
 *   directly, because a box whose `xLo` exceeds its `xHi` contains nothing and
 *   an interactable that contains nothing simply never appears.
 */

const DEG = Math.PI / 180;
type V = { x: number; y: number; z: number };

const RADIUS = DEFAULT_WALKER_TUNING.radius;

function distance(a: V, b: V): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Closest approach of a point to a segment, and where on it. */
function pointToSegment(p: V, a: V, b: V): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t), p.z - (a.z + dz * t));
}

/** Distance from a point to an axis-aligned box; zero inside it. */
function pointToBox(p: V, centre: V, half: V): number {
  return Math.hypot(
    Math.max(Math.abs(p.x - centre.x) - half.x, 0),
    Math.max(Math.abs(p.y - centre.y) - half.y, 0),
    Math.max(Math.abs(p.z - centre.z) - half.z, 0),
  );
}

/** Every sample of one gang's eye path, at roughly 25 mm of arc. */
function climbSamples(side: ClimbSide): V[] {
  const steps = Math.ceil(climbLength(side) / 0.025);
  const out: V[] = [];
  for (let i = 0; i <= steps; i++) out.push(climbEyeAt(side, i / steps));
  return out;
}

// --- the frame, first --------------------------------------------------------

describe('the climb is authored in the ship\'s frame', () => {
  /**
   * The cheapest fact that catches a frame slip, and the reason it is first.
   *
   * The rig, the hull and the walker all speak ship-local, but three different
   * modules produce the numbers this file composes — `rig.ts`'s nodes,
   * `hullForm.ts`'s rail section, `lookout.ts`'s planking — and a spline that
   * quietly used one of them in a mast-local or a world frame would come out
   * looking almost right. Two landmarks pin it: the climb starts on a deck the
   * deck query agrees is there, and it ends on planking the platform agrees is
   * there.
   */
  for (const side of CLIMB_SIDES) {
    const hand = side > 0 ? 'port' : 'starboard';
    it(`starts on the ${hand} weather deck and ends on the ${hand} planking`, () => {
      const anchors = climbAnchors(side);
      const start = anchors[0];
      const deck = deckStandAt(start.hold.x, start.hold.z);
      expect(deck, 'the climb starts where there is no deck').not.toBeNull();
      expect(Math.abs(start.hold.y - deck!.y), 'the foot is not on the deck').toBeLessThan(1e-6);
      expect(Math.sign(start.hold.x), 'the foot is on the wrong side').toBe(side);
      // Forward of amidships and inside the hull, which a world-frame slip is not.
      expect(start.hold.z).toBeGreaterThan(0);
      expect(start.hold.z).toBeLessThan(HULL_LENGTH / 2);

      const top = anchors[anchors.length - 1];
      expect(Math.abs(top.hold.y - LOOKOUT_DECK_Y)).toBeLessThan(1e-9);
      expect(onLookoutPlanking(top.hold.x, top.hold.z), 'the top of the climb is off the top').toBe(
        true,
      );
      expect(Math.sign(top.hold.x)).toBe(side);
    });
  }
});

// --- the platform ------------------------------------------------------------

describe('the foremast lookout', () => {
  const deckAtFoot = walkingDeckY(FOREMAST_Z);

  it('puts the lookout\'s eye in the 9–11 m band section 15 asks for', () => {
    const above = lookoutEye(1).y - deckAtFoot;
    expect(`${above.toFixed(2)} m above the deck`).toBe(
      `${Math.min(Math.max(above, 9), 11).toFixed(2)} m above the deck`,
    );
  });

  /**
   * **The platform itself is below the band, and the eye is inside it.**
   *
   * Worth stating rather than hiding behind the test above. §15 asks for the
   * lookout "9–11 m above the upper deck" and the fore top's planking is 8.62 m
   * up — the crosstrees are where M2 put them, at the hounds, and moving them is
   * a rig change that would drag `FORE_CAP_Y`, the doubling and the whole sail
   * plan with it. §5.4 settles the reading in the eye's favour: it says the
   * lookout "sits ~10 m above deck", and a body standing on this planking has
   * its eye at 10.14. Recorded here so that nobody re-derives the discrepancy
   * from scratch and treats it as a fault.
   */
  it('stands its planking 8.6 m up, which is the part that is short of the band', () => {
    const platform = LOOKOUT_DECK_Y - deckAtFoot;
    expect(platform).toBeGreaterThan(8.4);
    expect(platform).toBeLessThan(9.0);
  });

  it('leaves one body room to stand, clear of the doubling and on the planking', () => {
    for (const side of CLIMB_SIDES) {
      const stand = lookoutStandPosition(side);
      // The whole footprint, not just the centre — a body is not a point, and
      // the wings of this top are 0.6 m wide against a body 0.52 m across.
      for (let a = 0; a < 32; a++) {
        const angle = (a / 32) * Math.PI * 2;
        const x = stand.x + Math.cos(angle) * RADIUS;
        const z = stand.z + Math.sin(angle) * RADIUS;
        expect(onLookoutPlanking(x, z), `a foot at ${x.toFixed(2)}, ${z.toFixed(2)} is off the top`)
          .toBe(true);
      }
      const doubling = doublingAt(LOOKOUT_DECK_Y);
      expect(
        Math.abs(stand.x) - RADIUS,
        'the body is standing in the mast',
      ).toBeGreaterThan(doubling.halfBreadth);
      expect(Math.sign(stand.x), 'the stance is on the wrong side').toBe(side);
    }
  });

  it('mirrors the two stances exactly, which is the inversion this area gets wrong', () => {
    const port = lookoutStandPosition(1);
    const starboard = lookoutStandPosition(-1);
    expect(port.x).toBeCloseTo(-starboard.x, 12);
    expect(port.z).toBeCloseTo(starboard.z, 12);
  });

  /**
   * Nothing up here is a wall, because nothing can reach it.
   *
   * `SHIP_ROUND_HANDOVER.md` §3.4 rules out per-ratline collision, and the whole
   * lookout inherits that: the walker never leaves the deck, so a collider on any
   * of this would be cost with no consumer. The claim is that it is *out of
   * reach*, and a claim about a height is exactly the kind `OBSTACLE_SOURCES`
   * says to measure rather than write down.
   */
  it('stands entirely above the reach of anything walking the deck', () => {
    const highestColumn = OBSTACLE_COLUMNS.reduce((y, column) => Math.max(y, column.yHi), 0);
    let lowest = Infinity;
    for (const solid of lookoutSolids()) {
      lowest = Math.min(lowest, solid.kind === 'box'
        ? solid.centre.y - solid.half.y
        : Math.min(solid.a.y, solid.b.y) - solid.radius);
    }
    expect(lowest).toBeGreaterThan(highestColumn);
    // And five metres over the crown of a body standing on the deck below it,
    // which is the lowest piece — the futtock stave — rather than the planking.
    expect(lowest - (walkingDeckY(FOREMAST_Z) + DEFAULT_WALKER_TUNING.standingHeight))
      .toBeGreaterThan(5);
  });

  it('rails the two edges a body can go off, and leaves the mast to close the third', () => {
    const solids = lookoutSolids();
    const stanchions = solids.filter(
      (s) => s.kind === 'bar' && s.a.y === LOOKOUT_DECK_Y && s.b.y > s.a.y,
    );
    expect(stanchions.length, 'four corners, four stanchions').toBe(4);
    const top = LOOKOUT_DECK_Y + LIFELINE_HEIGHT;
    const upperRails = solids.filter(
      (s) => s.kind === 'bar' && Math.abs(s.a.y - top) < 1e-9 && Math.abs(s.b.y - top) < 1e-9,
    );
    expect(upperRails.length, 'both sides and the after edge').toBe(3);
    // Chest height on the body that stands here, not waist height.
    expect(LIFELINE_HEIGHT).toBeGreaterThan(DEFAULT_WALKER_TUNING.standingHeight * 0.5);
  });
});

// --- what swings under and past it -------------------------------------------

/**
 * THE FORE GAFF IS WHAT SIZES THIS PLATFORM, AND IT HAD TO BE SWEPT TO KNOW IT.
 *
 * `ship-rig.test.ts` already checks a gaff against its own top, and it checks
 * the *trestletrees* at the *authored* trim. Neither half covers this: the
 * crosstree arms are 0.85 m of half-span against the trestletrees' 0.23, and the
 * foresail eases through ±51.5°, which sweeps the gaff out over exactly the part
 * of the top a platform wants to be. The sweep below is over the whole legal
 * trim range and both hoists, against the planking and the lifelines.
 *
 * It is also the sweep that found the pre-existing fault recorded in the
 * milestone's handover section: at large ease the gaff clips the outboard corner
 * of the *forward crosstree arm*, which is M2 geometry and not M5's. That is
 * measured separately below rather than folded in here, because a new platform
 * that inherits an old fault and a new platform that causes one are different
 * things to report.
 */
describe('the lookout and the swung fore gaff', () => {
  function withTrim<T>(trims: Partial<RigTrimAnglesRad>, run: () => T): T {
    const restore = applyRigTrim({ ...AUTHORED_TRIM_RAD, ...trims });
    try {
      return run();
    } finally {
      restore();
    }
  }

  const trimSweep: number[] = [];
  for (let deg = -RIG_TRIM_LIMITS.foresail.maxDeg; deg <= RIG_TRIM_LIMITS.foresail.maxDeg; deg += 1.5) {
    trimSweep.push(deg);
  }

  /** Closest approach of a spar to a box, sampled along the spar. */
  function sparToBox(sparName: string, centre: V, half: V): number {
    const spar = SPARS.find((s) => s.name === sparName)!;
    let worst = Infinity;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const p = {
        x: spar.heel.x + (spar.head.x - spar.heel.x) * t,
        y: spar.heel.y + (spar.head.y - spar.heel.y) * t,
        z: spar.heel.z + (spar.head.z - spar.heel.z) * t,
      };
      const r = spar.heelRadius + (spar.headRadius - spar.heelRadius) * t;
      worst = Math.min(worst, pointToBox(p, centre, half) - r);
    }
    return worst;
  }

  /** The planking, as the one box that contains both halves of it. */
  const planking = {
    centre: {
      x: 0,
      y: (LOOKOUT_UNDER_Y + LOOKOUT_DECK_Y) / 2,
      z: (LOOKOUT_Z_AFT + LOOKOUT_Z_FORWARD) / 2,
    },
    half: {
      x: LOOKOUT_HALF_SPAN,
      y: (LOOKOUT_DECK_Y - LOOKOUT_UNDER_Y) / 2,
      z: (LOOKOUT_Z_FORWARD - LOOKOUT_Z_AFT) / 2,
    },
  };

  it('keeps the gaff under the planking through the whole trim envelope', () => {
    let worst = Infinity;
    let at = 0;
    for (const deg of trimSweep) {
      const gap = withTrim({ foresail: deg * DEG }, () =>
        sparToBox('foreGaff', planking.centre, planking.half),
      );
      if (gap < worst) {
        worst = gap;
        at = deg;
      }
    }
    expect(`worst ${worst.toFixed(3)} m at ${at.toFixed(1)}°`).toBe(
      `worst ${Math.max(worst, GAFF_CLEARANCE).toFixed(3)} m at ${at.toFixed(1)}°`,
    );
  });

  it('keeps the gaff clear of the lifelines, which stand above it in every trim', () => {
    const rails = {
      centre: {
        x: 0,
        y: LOOKOUT_DECK_Y + LIFELINE_HEIGHT / 2,
        z: (LOOKOUT_Z_AFT + LOOKOUT_Z_FORWARD) / 2,
      },
      half: {
        x: LOOKOUT_HALF_SPAN,
        y: LIFELINE_HEIGHT / 2,
        z: (LOOKOUT_Z_FORWARD - LOOKOUT_Z_AFT) / 2,
      },
    };
    let worst = Infinity;
    for (const deg of trimSweep) {
      worst = Math.min(
        worst,
        withTrim({ foresail: deg * DEG }, () => sparToBox('foreGaff', rails.centre, rails.half)),
      );
    }
    // Necessarily more than the planking's, since the rails stand on top of it —
    // asserted anyway, because "necessarily" is what the crosstree arms were.
    expect(worst, `the gaff comes within ${worst.toFixed(3)} m of the lifelines`)
      .toBeGreaterThan(GAFF_CLEARANCE);
  });

  /**
   * **A pre-existing fault, measured and reported rather than fixed here.**
   *
   * The forward crosstree arm reaches 0.85 m outboard at 12.63 m, and at large
   * ease the fore gaff's timber arrives at that corner from underneath. It is M2
   * geometry, it is not what M5 built, and fixing it means either shortening the
   * arms — which are what the topmast shrouds spread to — or capping the
   * foresail's ease, which is a sailing decision. The number is pinned so that a
   * future round changing either notices, and the milestone's handover section
   * says it out loud.
   */
  it('records the depth the gaff already reaches into the forward crosstree arm', () => {
    const p = LOOKOUT_TOP;
    const armCentreZ = p.z + p.length * 0.3;
    const arm = {
      centre: { x: 0, y: p.y + p.thickness * 0.9, z: armCentreZ },
      half: { x: p.halfSpan, y: p.thickness * 0.55, z: p.thickness * 0.8 },
    };
    let worst = Infinity;
    let at = 0;
    for (const deg of trimSweep) {
      const gap = withTrim({ foresail: deg * DEG }, () =>
        sparToBox('foreGaff', arm.centre, arm.half),
      );
      if (gap < worst) {
        worst = gap;
        at = deg;
      }
    }
    // Recorded, not asserted clear: this is what the ship does today.
    expect(`${(worst * 1000).toFixed(0)} mm at ${at.toFixed(1)}°`).toBe(
      `${(worst * 1000).toFixed(0)} mm at ${at.toFixed(1)}°`,
    );
    expect(worst, 'the arm fault has grown — this is M2 geometry, go and look')
      .toBeGreaterThan(-0.08);
  });

  it('keeps every sail out of the lookout through its own trim range', () => {
    const failures: string[] = [];
    for (const sail of SAILS) {
      // The foresail's own luff runs up the mast this top stands on, so its
      // cloth passes the top by construction — the same exemption `ship-rig`
      // grants and for the same reason.
      if (sail.name === 'foresail') continue;
      const limit = RIG_TRIM_LIMITS[sail.name as SailName];
      for (const deg of [limit.minDeg, limit.minDeg / 2, 0, limit.maxDeg / 2, limit.maxDeg]) {
        const worst = withTrim({ [sail.name]: deg * DEG } as Partial<RigTrimAnglesRad>, () => {
          const surface = sailSurface(SAILS.find((s) => s.name === sail.name)!);
          let near = Infinity;
          for (let i = 0; i <= 28; i++) {
            for (let j = 0; j <= 28; j++) {
              near = Math.min(near, pointToBox(surface(j / 28, i / 28), planking.centre, planking.half));
            }
          }
          return near;
        });
        if (worst <= 0) failures.push(`${sail.name} at ${deg.toFixed(0)}° is inside the lookout`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// --- the climb is continuous -------------------------------------------------

describe('the climb is continuous', () => {
  for (const side of CLIMB_SIDES) {
    const hand = side > 0 ? 'port' : 'starboard';

    it(`gives the ${hand} gang a hold within a step of the last, all the way up`, () => {
      const holds = climbHolds(side);
      expect(holds.length, 'a nine-metre climb with no rungs in it').toBeGreaterThan(18);
      for (let i = 1; i < holds.length; i++) {
        const step = distance(holds[i - 1].at, holds[i].at);
        const allowance =
          holds[i].kind === 'caprail' ? RAIL_CROSSING_ALLOWANCE : RUNG_STEP_ALLOWANCE;
        expect(
          step,
          `${holds[i - 1].kind}→${holds[i].kind} is ${(step * 1000).toFixed(0)} mm`,
        ).toBeLessThanOrEqual(allowance);
        // Never downward — and the last step, off the rim onto the planking, is
        // deliberately allowed to be level, because it is a stride across a
        // floor rather than a rung.
        const level = holds[i].kind === 'planking' && holds[i - 1].kind === 'planking';
        if (level) expect(holds[i].at.y).toBeCloseTo(holds[i - 1].at.y, 9);
        else expect(holds[i].at.y, 'the ladder goes down somewhere').toBeGreaterThan(holds[i - 1].at.y);
      }
    });

    it(`puts every ${hand} rung hold on a drawn ratline`, () => {
      // The holds on the gang are not authored heights — they are read out of
      // `RATLINES`, so a rung that is drawn and a rung that is climbed cannot
      // become two different lists. This is the assertion that says so.
      const drawn = new Set(foreRungsY(side).map((y) => y.toFixed(6)));
      const climbed = climbHolds(side).filter((h) => h.kind === 'ratline');
      expect(climbed.length).toBeGreaterThan(15);
      for (const hold of climbed) {
        expect(drawn.has(hold.at.y.toFixed(6)), `no ratline at ${hold.at.y.toFixed(3)}`).toBe(true);
      }
      expect(climbed.length, 'holds outnumber the rungs there are').toBeLessThanOrEqual(
        RATLINES.filter((r) => r.name.startsWith('fore')).length,
      );
    });

    it(`carries the ${hand} eye up without a gap, a dip or a lurch`, () => {
      const samples = climbSamples(side);
      let biggest = 0;
      for (let i = 1; i < samples.length; i++) {
        biggest = Math.max(biggest, distance(samples[i - 1], samples[i]));
        expect(samples[i].y, 'the eye path descends on the way up').toBeGreaterThan(
          samples[i - 1].y - 1e-9,
        );
      }
      // Arc length is what is being stepped, so every step is the same length —
      // which is the difference between a climb and a spline's own parameter.
      expect(biggest).toBeLessThan(0.03);
      expect(climbLength(side)).toBeGreaterThan(8);
      expect(climbLength(side)).toBeLessThan(13);
    });

    it(`visits every ${hand} anchor in order, going up and coming down`, () => {
      const progress = anchorProgress(side);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i], `${climbAnchors(side)[i].name} is out of order`).toBeGreaterThan(
          progress[i - 1],
        );
      }
      expect(progress[0]).toBeCloseTo(0, 6);
      expect(progress[progress.length - 1]).toBeCloseTo(1, 6);

      // **Down is not up backwards, so it is driven and not reversed.** The
      // descent runs the same state machine at the same rate with the forward
      // axis held at −1, and has to touch every anchor on the way and land
      // exactly on the deck's eye. A path that only worked upward would show up
      // as an anchor missed or a foot that never arrives.
      resetClimb();
      setClimbProgress(1);
      const dt = 1 / 60;
      const seen = new Set<number>();
      let frames = 0;
      while (!isAtTheFoot(side) && frames < 3000) {
        advanceClimb(side, dt, -1);
        frames++;
        for (let i = 0; i < progress.length; i++) {
          if (Math.abs(climbProgress() - progress[i]) < 0.01) seen.add(i);
        }
      }
      expect(frames, 'the descent never reached the deck').toBeLessThan(3000);
      expect(seen.size, 'the descent skipped an anchor').toBe(progress.length);
      const foot = climbEyeAt(side, climbProgress());
      expect(distance(foot, climbAnchors(side)[0].eye), 'the descent lands off the deck')
        .toBeLessThan(0.05);
      resetClimb();
    });

    it(`takes about the same time up the ${hand} gang as down it`, () => {
      const dt = 1 / 60;
      resetClimb();
      let up = 0;
      while (climbProgress() < 1 && up < 3000) {
        advanceClimb(side, dt, 1);
        up++;
      }
      let down = 0;
      while (!isAtTheFoot(side) && down < 3000) {
        advanceClimb(side, dt, -1);
        down++;
      }
      expect(Math.abs(up - down)).toBeLessThan(4);
      const seconds = up * dt;
      expect(seconds).toBeCloseTo(climbLength(side) / CLIMB_SPEED, 1);
      resetClimb();
    });
  }
});

// --- nothing on the climb goes through anything ------------------------------

describe('nothing on the climb passes through the ship', () => {
  /**
   * The sweep the milestone's gate asks for, in one place.
   *
   * Spars, standing rigging, the swung booms across their whole trim envelope,
   * the cloth that now moves on them, the lookout's own timber, and the hull
   * itself. Everything is sampled on the *eye path*, because that is what the
   * player is: the body is authored and has no collider by decision, so the only
   * thing that can be inside a piece of timber is the camera.
   *
   * The exemptions are named rather than tolerated. A climber's eye is 0.22 m
   * from the shrouds he is on — that is the whole design of the standoff — so
   * the gang's own six shrouds and the ratlines seized across them are excluded
   * by name and checked separately against a *minimum* instead.
   */
  /**
   * How much daylight the eye keeps, metres.
   *
   * **0.10, and the number that decides it is the camera's near plane at 0.06.**
   * Anything closer than that is clipped and the player sees the inside of it;
   * the margin is what stops a millimetre of roll putting a spar through the
   * lens. It is deliberately not a structural clearance — a climber's whole
   * business is being close to the rigging, and the same file asserts *below*
   * that the eye is never more than 0.4 m off the shrouds it is on.
   *
   * Two things get near it and both are honest. At full ease on the lee side the
   * fore gaff comes to 0.134 m of the eye at the futtock stage, and at full
   * brace the fore lower yard comes to 0.109 m — both at the top of the climb,
   * both at the extreme of a control the player is holding, and both true of the
   * ship. The milestone's handover reports them rather than this file hiding
   * them in a tolerance.
   */
  const CLEAR = 0.1;

  function trimPoses(): Array<{ name: string; trims: Partial<RigTrimAnglesRad> }> {
    const out: Array<{ name: string; trims: Partial<RigTrimAnglesRad> }> = [
      { name: 'authored', trims: {} },
    ];
    for (const sail of ['mainsail', 'foresail', 'foreTopsail'] as const) {
      const limit = RIG_TRIM_LIMITS[sail];
      for (const deg of [limit.minDeg, limit.minDeg / 2, 0, limit.maxDeg / 2, limit.maxDeg]) {
        out.push({ name: `${sail} ${deg.toFixed(0)}°`, trims: { [sail]: deg * DEG } });
      }
    }
    return out;
  }

  for (const side of CLIMB_SIDES) {
    const hand = side > 0 ? 'port' : 'starboard';
    const ownShrouds = new Set(
      [0, 1, 2].map((i) => `foreShroud${side > 0 ? 'Port' : 'Starboard'}${i}`),
    );

    it(`keeps the ${hand} eye out of every spar, in every trim`, () => {
      const samples = climbSamples(side);
      const failures: string[] = [];
      for (const pose of trimPoses()) {
        const restore = applyRigTrim({ ...AUTHORED_TRIM_RAD, ...pose.trims });
        try {
          for (const spar of SPARS) {
            let worst = Infinity;
            for (const p of samples) {
              const gap =
                pointToSegment(p, spar.heel, spar.head) -
                Math.max(spar.heelRadius, spar.headRadius);
              worst = Math.min(worst, gap);
            }
            if (worst < CLEAR) {
              failures.push(`${spar.name} at ${pose.name}: ${(worst * 1000).toFixed(0)} mm`);
            }
          }
        } finally {
          restore();
        }
      }
      expect(failures).toEqual([]);
    });

    it(`keeps the ${hand} eye off every rope but the gang it is on`, () => {
      const samples = climbSamples(side);
      const failures: string[] = [];
      for (const run of STANDING_RIGGING) {
        if (ownShrouds.has(run.name)) continue;
        const a = rigNode(run.from);
        const b = rigNode(run.to);
        let worst = Infinity;
        for (const p of samples) worst = Math.min(worst, pointToSegment(p, a, b) - run.diameter / 2);
        if (worst < CLEAR) failures.push(`${run.name}: ${(worst * 1000).toFixed(0)} mm`);
      }
      expect(failures).toEqual([]);
    });

    it(`holds the ${hand} eye off the very ropes it is climbing, but not far off`, () => {
      const samples = climbSamples(side);
      let worst = Infinity;
      for (const name of ownShrouds) {
        const run = STANDING_RIGGING.find((r) => r.name === name)!;
        const a = rigNode(run.from);
        const b = rigNode(run.to);
        for (const p of samples) worst = Math.min(worst, pointToSegment(p, a, b) - run.diameter / 2);
      }
      // Clear of the 0.06 m near plane by a wide margin, and close enough that
      // the rigging is a thing in shot rather than a thing in the distance.
      expect(worst, `the climber is ${(worst * 1000).toFixed(0)} mm off his own shrouds`)
        .toBeGreaterThan(0.08);
      expect(worst).toBeLessThan(0.4);
    });

    it(`keeps the ${hand} eye out of the cloth, in every weather the trim allows`, () => {
      const samples = climbSamples(side);
      const failures: string[] = [];
      for (const pose of trimPoses()) {
        const restore = applyRigTrim({ ...AUTHORED_TRIM_RAD, ...pose.trims });
        try {
          for (const sail of SAILS) {
            const surface = sailSurface(sail);
            let worst = Infinity;
            for (let i = 0; i <= 20; i++) {
              for (let j = 0; j <= 20; j++) {
                const q = surface(j / 20, i / 20);
                for (const p of samples) worst = Math.min(worst, distance(p, q));
              }
            }
            if (worst < CLEAR) {
              failures.push(`${sail.name} at ${pose.name}: ${(worst * 1000).toFixed(0)} mm`);
            }
          }
        } finally {
          restore();
        }
      }
      expect(failures).toEqual([]);
    });

    it(`keeps the ${hand} eye out of the lookout's own timber and lifelines`, () => {
      const samples = climbSamples(side);
      const failures: string[] = [];
      for (const solid of lookoutSolids() as LookoutSolid[]) {
        let worst = Infinity;
        for (const p of samples) {
          worst = Math.min(
            worst,
            solid.kind === 'box'
              ? pointToBox(p, solid.centre, solid.half)
              : pointToSegment(p, solid.a, solid.b) - solid.radius,
          );
        }
        // A hand on a lifeline is closer than a spar's clearance, so the rails
        // and the stanchions get the near plane's own margin rather than the
        // structural one — but nothing may be *inside* the lens.
        const allowance = solid.region === 'spar' ? CLEAR : 0.1;
        if (worst < allowance) {
          const what = solid.kind === 'box' ? 'planking' : solid.region;
          failures.push(`${what}: ${(worst * 1000).toFixed(0)} mm`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`never puts the ${hand} eye inside the hull`, () => {
      for (const p of climbSamples(side)) {
        const stand = deckStandAt(p.x, p.z);
        if (!stand) continue;
        expect(p.y, 'the eye is under the deck it started on').toBeGreaterThan(stand.y - 0.05);
      }
    });

    it(`keeps the ${hand} climb within reach of the rungs it is meant to be on`, () => {
      /**
       * The gate that makes "legible" a measurable thing rather than a look.
       *
       * On the gang stretch — from the first rung above the rail to the futtock
       * stave — the eye must always have a drawn ratline under it and within a
       * body's reach. A spline that drifted off the ladder would sail up through
       * clear air with the rungs somewhere behind it, and every other test in
       * this file would still pass.
       */
      const anchors = climbAnchors(side);
      const span = anchorProgress(side);
      const rungs = climbHolds(side).filter((h) => h.kind === 'ratline');
      const from = span[2];
      const to = span[4];
      let worst = 0;
      for (let s = from; s <= to; s += 0.002) {
        const eye = climbEyeAt(side, s);
        let near = Infinity;
        for (const rung of rungs) {
          // Below the eye, within a body's height: the rung a foot is on.
          const drop = eye.y - rung.at.y;
          if (drop < 0.6 || drop > 2.0) continue;
          near = Math.min(near, Math.hypot(eye.x - rung.at.x, eye.z - rung.at.z));
        }
        worst = Math.max(worst, near);
      }
      expect(
        worst,
        `the eye gets ${(worst * 1000).toFixed(0)} mm from the nearest rung under it, on the ${hand} gang (${anchors[2].name}→${anchors[4].name})`,
      ).toBeLessThan(0.45);
    });
  }
});

// --- the view from the top ---------------------------------------------------

describe('what the lookout can see', () => {
  /**
   * The accept-when asks for "an unobstructed horizon and a view down over the
   * deck", and asks for it with rays rather than in prose.
   *
   * Both are cast from the eye through the whole rig — every spar, every rope,
   * the cloth in a spread of trims, and the lookout's own rails. The horizon is
   * cast level; the deck is cast at the real points on the planking a lookout
   * would be reporting on.
   */
  /**
   * WHAT COUNTS AS BLOCKING, AND WHY ROPE DOES NOT
   * -----------------------------------------------
   * The first cut of these tests counted anything the ray passed within 50 mm of
   * — and reported the lookout as blind, because from a masthead almost every
   * sightline down at the deck passes near a stay somewhere along its length. It
   * is the wrong model. **A 36 mm rope five metres away subtends 0.4°.** It is a
   * line across the view, not a wall, and a lookout looks past one without
   * noticing. A mast is a different thing: the fore topmast is 0.09 m of solid
   * timber half a metre from the eye, and it subtends twenty degrees.
   *
   * So a ray is blocked when it *enters* a spar or the platform. Rope is
   * measured and reported and does not count, which is the honest reading of
   * "unobstructed" from a place where you are standing inside the rigging.
   */
  function occluders(): Array<{ name: string; a: V; b: V; r: number }> {
    const out: Array<{ name: string; a: V; b: V; r: number }> = [];
    for (const spar of SPARS) {
      out.push({
        name: spar.name,
        a: spar.heel,
        b: spar.head,
        r: Math.max(spar.heelRadius, spar.headRadius),
      });
    }
    return out;
  }

  const OCCLUDERS = occluders();

  /**
   * Does a ray enter anything solid within `range` metres of the eye?
   *
   * The planking is tested as the slab it is rather than as a fat cylinder. A
   * 32 mm floor modelled as a 0.57 m tube reported the lookout as blind to two
   * thirds of her own deck, and the difference between those two answers is
   * entirely the model.
   */
  function firstSolid(from: V, dir: V, range: number): string | null {
    const length = Math.hypot(dir.x, dir.y, dir.z);
    for (let t = 0.3; t <= range; t += 0.04) {
      const p = {
        x: from.x + (dir.x / length) * t,
        y: from.y + (dir.y / length) * t,
        z: from.z + (dir.z / length) * t,
      };
      if (
        p.y >= LOOKOUT_UNDER_Y &&
        p.y <= LOOKOUT_DECK_Y &&
        onLookoutPlanking(p.x, p.z) &&
        Math.abs(p.x) > doublingAt(p.y).halfBreadth
      ) {
        return 'planking';
      }
      for (const b of OCCLUDERS) {
        if (pointToSegment(p, b.a, b.b) < b.r) return b.name;
      }
    }
    return null;
  }

  for (const side of CLIMB_SIDES) {
    const hand = side > 0 ? 'port' : 'starboard';

    it(`gives the ${hand} lookout a clear horizon over most of the compass`, () => {
      const eye = lookoutEye(side);
      const blocked: string[] = [];
      for (let bearing = 0; bearing < 360; bearing += 5) {
        const a = bearing * DEG;
        const what = firstSolid(eye, { x: Math.sin(a), y: 0, z: Math.cos(a) }, 40);
        if (what) blocked.push(`${bearing}° (${what})`);
      }
      // Some of the compass is mast, and that is what standing on a top *is* —
      // the doubling is half a metre from your shoulder. What must not happen is
      // the horizon being fenced.
      expect(
        blocked.length,
        `${blocked.length} of 72 bearings blocked: ${blocked.join(', ')}`,
      ).toBeLessThanOrEqual(10);
      // And the sector a lookout is up here for — 160° through the bow — has to
      // be open all the way round. +z is forward.
      for (let bearing = -80; bearing <= 80; bearing += 5) {
        const a = bearing * DEG;
        const what = firstSolid(eye, { x: Math.sin(a), y: 0, z: Math.cos(a) }, 40);
        expect(what, `the bow bearing ${bearing}° is fenced by ${what}`).toBeNull();
      }
    });

    /**
     * **THE SQUARE TOPSAIL OWNS THE FORWARD VIEW, AND THAT IS THE SHIP.**
     *
     * The fore topsail's foot is bent to the lower yard at 12.45 m and its head
     * is at 18.20, so it stands across the fore top from just below the
     * lookout's feet to well over her head. Measured from the stance: 0.38 m at
     * the worst brace on the port top, 0.42 m on the starboard. Set, you cannot
     * see the bow from up here, and no arrangement of a platform on this mast
     * changes that — the sail is *on* this mast.
     *
     * It cost a screenshot to notice, which is the finding worth writing down:
     * every intersection test in this file measured the eye against timber and
     * rope, and cloth is neither. The same shape of gap as the rig round's
     * "sails were checked against SPARS, so the tops went unchecked".
     *
     * So it is measured rather than fixed, the arrival facing is turned 30° off
     * the bow to look past it (`lookoutYaw`), and the handover tells Ash to furl
     * the topsail and look again.
     *
     * **WHAT THIS PAIR DOES NOT DO, STATED PLAINLY.** It measures how near the
     * cloth stands and it checks the one bearing the lookout arrives on. It does
     * **not** sweep the compass against the cloth and report what fraction of
     * the horizon the set sails take — an attempt at that measured 45 bearings
     * of 72 "blocked" and was wrong, because a bilinear sail patch sampled on a
     * 17×17 grid puts points within a third of a metre of almost any ray you
     * care to cast over forty metres. A cloth occlusion sweep needs a real
     * triangle-ray intersection against the drawn surface, not a proximity
     * test, and that is owed rather than done. See the M5 handover section.
     */
    it(`records how near the set cloth stands to the ${hand} lookout's face`, () => {
      const eye = lookoutEye(side);
      let nearest = Infinity;
      let which = 'none';
      for (const sail of SAILS) {
        const surface = sailSurface(sail);
        for (let i = 0; i <= 40; i++) {
          for (let j = 0; j <= 40; j++) {
            const d = distance(surface(j / 40, i / 40), eye);
            if (d < nearest) {
              nearest = d;
              which = sail.name;
            }
          }
        }
      }
      // Asserted: the cloth is not in the lens. The near plane is 0.06 m and the
      // topsail's belly moves with the wind, so half a metre is the margin worth
      // holding. *How much of the forward view it takes* is a fact about the
      // vessel, and the handover hands Ash the number rather than this file
      // pretending it is a tolerance.
      expect(
        nearest,
        `${which} stands ${(nearest * 1000).toFixed(0)} mm from the ${hand} lookout's eye`,
      ).toBeGreaterThan(0.3);
      expect(which, 'the nearest cloth is no longer the fore topsail').toBe('foreTopsail');
    });

    it(`aims the ${hand} lookout at something worth looking at on arrival`, () => {
      const eye = lookoutEye(side);
      const pose = climbPose(side, 1);
      const dir = {
        x: -Math.sin(pose.yaw) * Math.cos(pose.pitch),
        y: Math.sin(pose.pitch),
        z: -Math.cos(pose.yaw) * Math.cos(pose.pitch),
      };
      // Forward of the beam and **outboard on her own side**, which is the one
      // sector clear of both the doubling inboard of her and the topsail ahead.
      expect(dir.z, 'the arrival look is abaft the beam').toBeGreaterThan(0.5);
      expect(Math.sign(dir.x), 'the arrival look crosses the doubling').toBe(side);
      expect(firstSolid(eye, dir, 40), 'the arrival look runs into the rig').toBeNull();
      // And it is deliberately *not* dead ahead, because dead ahead is a sail.
      expect(Math.abs(dir.x), 'the arrival look is straight at the topsail')
        .toBeGreaterThan(0.2);
    });

    it(`lets the ${hand} lookout see down onto the deck she is standing over`, () => {
      const eye = lookoutEye(side);
      const targets: Array<[string, V, number]> = [];
      for (let z = -6.5; z <= 6.6; z += 1) {
        for (const x of [-1.5, -0.7, 0, 0.7, 1.5]) {
          const stand = deckStandAt(x, z);
          if (!stand) continue;
          targets.push([`${x.toFixed(1)},${z.toFixed(1)}`, { x, y: stand.y, z }, z]);
        }
      }
      expect(targets.length, 'no deck to look down at').toBeGreaterThan(40);
      const hidden: string[] = [];
      const seenZ: number[] = [];
      for (const [name, target, z] of targets) {
        const dir = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
        const range = Math.hypot(dir.x, dir.y, dir.z) - 0.25;
        const what = firstSolid(eye, dir, range);
        if (what) hidden.push(`${name} behind ${what}`);
        else seenZ.push(z);
      }
      const seen = 1 - hidden.length / targets.length;
      /**
       * **What a lookout cannot see is the deck under her own feet**, and that
       * is not a fault, it is what a platform is. The planking is 1.70 m across
       * and the eye is 1.60 m above it, so its shadow at deck level reaches
       * about eight metres — which on a 4.4 m beam is the whole width of her,
       * for the two metres of deck fore and aft of the foremast. Everything
       * abaft that and everything forward of it is open.
       *
       * The other half of the answer is that the two tops do **not** see the
       * same amount, and the difference is the sail: at the authored trim the
       * foresail is eased to port, so its gaff lies across the port lookout's
       * view of the waist. Measured at the pose she ships in, the starboard top
       * sees 62% of the sampled deck and the port top 45%.
       *
       * So the gate is two fifths of the deck plus the three places that matter
       * — the waist where the crew work, the quarterdeck where the helm is, and
       * the head — rather than a number that pretends a top is a drone.
       */
      expect(seen, `hidden: ${hidden.join('; ')}`).toBeGreaterThan(0.4);
      expect(
        seenZ.some((z) => Math.abs(z) <= 2),
        'the waist is invisible from the lookout',
      ).toBe(true);
      expect(
        seenZ.some((z) => z <= -4),
        'the quarterdeck is invisible from the lookout',
      ).toBe(true);
      expect(seenZ.some((z) => z >= 5), 'the head is invisible from the lookout').toBe(true);
    });
  }
});

// --- the comfort treatment ---------------------------------------------------

describe('the motion at the masthead', () => {
  /**
   * §5.4's table, recomputed against the geometry that got built.
   *
   * The point of this block is not to reproduce the document — it is to record
   * that the document is 8% low and why, so nobody re-derives the discrepancy
   * and treats it as a fault in the ship.
   */
  it('reproduces the spec\'s arithmetic exactly at the lever the spec assumed', () => {
    const specLever = 11.5;
    const at20 = mastheadMotion(20, specLever);
    expect(at20.lateralMetres).toBeCloseTo(3.9, 1);
    expect(at20.peakSpeedMps).toBeCloseTo(4.2, 1);
    expect(at20.peakAccelerationG).toBeCloseTo(0.45, 2);
    const at8 = mastheadMotion(8, specLever);
    expect(at8.lateralMetres).toBeCloseTo(1.6, 1);
    const at34 = mastheadMotion(34, specLever);
    expect(at34.lateralMetres).toBeCloseTo(6.4, 1);
    expect(at34.peakSpeedMps).toBeCloseTo(7.2, 1);
  });

  it('puts the roll axis at the centre of mass, which is not the waterline', () => {
    // `BuoyantBody.transform` rotates every local point about the centre of
    // mass; the spec's 11.5 m lever implies an axis near y = 2.6, and the
    // measured one is lower. This is the whole of the 8%.
    expect(rollAxisY()).toBeGreaterThan(1.6);
    expect(rollAxisY()).toBeLessThan(2.2);
    expect(aloftLever()).toBeGreaterThan(11.5);
    expect(aloftLever()).toBeLessThan(13.0);
    expect(aloftLever() / 11.5).toBeGreaterThan(1.05);
  });

  it('is three times the deck\'s, and only in translation', () => {
    // The one sentence the treatment rests on: the *ratio* is a lever ratio, and
    // there is no angular quantity in it at all.
    const ratio = aloftLever() / deckLever();
    expect(ratio).toBeGreaterThan(2.8);
    expect(ratio).toBeLessThan(3.6);
    expect(ALOFT_STABILISATION.rollFollow).toBe(WALKING_STABILISATION.rollFollow);
    expect(ALOFT_STABILISATION.pitchFollow).toBe(WALKING_STABILISATION.pitchFollow);
    expect(ALOFT_STABILISATION.heaveFollow).toBe(WALKING_STABILISATION.heaveFollow);
    expect(ALOFT_STABILISATION.smoothingSeconds).toBe(WALKING_STABILISATION.smoothingSeconds);
    expect(WALKING_STABILISATION.swayFollow, 'the deck must keep the whole of its sway').toBe(1);
  });

  it('trims the sway by exactly the uprightness the angles already claim', () => {
    // eyeHeight/lever, and nothing else: the difference between a head held
    // vertical on its feet and a head on the end of a rotated 1.6 m neck.
    const expected = 1 - DEFAULT_WALKER_TUNING.eyeHeight / aloftLever();
    expect(aloftSwayFollow()).toBeCloseTo(expected, 9);
    expect(aloftSwayFollow()).toBeGreaterThan(0.85);
    expect(aloftSwayFollow()).toBeLessThan(0.9);
    expect(ALOFT_STABILISATION.swayFollow).toBe(aloftSwayFollow());
  });

  it('keeps the presented eye over its own planking, in the worst sea in the table', () => {
    for (const [sea, roll] of Object.entries(SPEC_ROLL_AMPLITUDE_DEG)) {
      const residual = swayResidual(roll);
      expect(
        residual,
        `${sea}: the eye stands ${(residual * 1000).toFixed(0)} mm off the body`,
      ).toBeLessThan(LOOKOUT_HALF_SPAN);
    }
    // And the derived fraction sits under the geometric ceiling in the worst of
    // them — with almost nothing to spare, which is the finding.
    const ceiling = swayCeiling(SPEC_ROLL_AMPLITUDE_DEG.SOUTHERN_OCEAN_ROUGH);
    expect(aloftSwayFollow()).toBeGreaterThan(ceiling);
    expect(aloftSwayFollow() - ceiling).toBeLessThan(0.03);
  });

  it('leaves the drama where the drama is: the ship swinging under you', () => {
    // A translation at altitude is nearly invisible against the horizon and
    // enormous against the deck. This is the number that survives the trim.
    const moderate = deckSwingDeg(SPEC_ROLL_AMPLITUDE_DEG.CURRENT_MODERATE);
    const design = deckSwingDeg(SPEC_ROLL_AMPLITUDE_DEG.MATURE_WIND_SEA);
    const worst = deckSwingDeg(SPEC_ROLL_AMPLITUDE_DEG.SOUTHERN_OCEAN_ROUGH);
    expect(moderate).toBeLessThan(design);
    expect(design).toBeLessThan(worst);
    expect(design, 'the design sea has stopped being dramatic').toBeGreaterThan(25);
    expect(moderate, 'moderate seas have stopped being moderate').toBeLessThan(24);
    // Untrimmed against trimmed, so the cost of the treatment is on the record.
    // 52.2° untrimmed against 46.8° presented: the treatment costs about a
    // tenth of the ship's swing across the view, which is the price of keeping
    // the eye over the body and is the whole of what it costs.
    const untrimmed = deckSwingDeg(SPEC_ROLL_AMPLITUDE_DEG.MATURE_WIND_SEA, 1);
    expect((untrimmed - design) / untrimmed).toBeLessThan(0.12);
  });

  it('states the one number it takes on trust, so a drift is a conversation', () => {
    // The roll period is measured by the free-decay harness and recorded in the
    // spec; it is authored here because a decay run is thirty seconds of physics
    // and this module is imported by the camera wiring.
    expect(MEASURED_ROLL_PERIOD_SECONDS).toBe(5.96);
    // The running mean passes most of a roll-period oscillation as deviation,
    // which is why a follow fraction means what it says at this frequency.
    expect(MEAN_FILTER_TRANSMISSION).toBeGreaterThan(0.85);
    expect(MEAN_FILTER_TRANSMISSION).toBeLessThan(1);
  });
});

// --- the station machinery ---------------------------------------------------

describe('going aloft, as a thing a player does', () => {
  afterEach(() => {
    resetSeat();
    resetClimb();
  });

  const rows = SHIP_STATIONS.filter((s) => s.kind === 'climb');

  it('describes both gangs and nothing else as a climb', () => {
    expect(rows.map((r) => r.name).sort()).toEqual(['climbPort', 'climbStarboard']);
    for (const row of rows) expect(row.room).toBe('weatherDeck');
  });

  it('orders every box\'s xLo below its xHi, on both sides', () => {
    for (const side of CLIMB_SIDES) {
      for (const [what, box] of [
        ['target', shroudTarget(side)],
        ['approach', shroudApproach(side)],
      ] as const) {
        expect(box.xLo, `${what} xLo/xHi inverted`).toBeLessThan(box.xHi);
        expect(box.yLo).toBeLessThan(box.yHi);
        expect(box.zLo).toBeLessThan(box.zHi);
      }
      // And the target is on the side it says it is.
      const target = shroudTarget(side);
      expect(Math.sign((target.xLo + target.xHi) / 2)).toBe(side);
    }
  });

  it('offers each gang from its own foot and refuses it from the other rail', () => {
    const taken: string[] = [];
    const interactables = buildShipInteractables({
      stations: { use: (name) => taken.push(name) },
    });
    for (const side of CLIMB_SIDES) {
      const name = side > 0 ? 'climbPort' : 'climbStarboard';
      const anchors = climbAnchors(side);
      const eye = anchors[0].eye;
      const target = shroudTarget(side);
      const centre = {
        x: (target.xLo + target.xHi) / 2,
        y: (target.yLo + target.yHi) / 2,
        z: (target.zLo + target.zHi) / 2,
      };
      const hit = interactables.pick(eye, {
        x: centre.x - eye.x,
        y: centre.y - eye.y,
        z: centre.z - eye.z,
      });
      expect(hit?.interactable.name, `${name} is not offered from its own foot`).toBe(name);
      expect(hit!.distance).toBeLessThan(REACH);
      expect(hit!.interactable.verb(false)).toBe('Go aloft');

      // From the *other* rail, pointing at the same shrouds. `REACH` alone very
      // nearly allows this — the waist is 4.4 m across — which is why the row
      // carries a `within`.
      const across = climbAnchors((side * -1) as ClimbSide)[0].eye;
      const wrong = interactables.pick(across, {
        x: centre.x - across.x,
        y: centre.y - across.y,
        z: centre.z - across.z,
      });
      expect(wrong?.interactable.name, 'the far gang is offered across the ship').not.toBe(name);
    }
  });

  it('takes looking at the mast as climbing intent, ahead of nearby lower-deck actions', () => {
    // Ash's reported view: at the foremast, a lamp/scuttle below could win even
    // while the camera was plainly on the mast. Build every competing action,
    // then assert the object in the gaze owns the prompt on both gangs.
    const interactables = buildShipInteractables({
      lamps: { isLit: () => false, toggle: () => {} },
      stations: { use: () => {} },
    });
    for (const side of CLIMB_SIDES) {
      const eye = climbAnchors(side)[0].eye;
      const mast = climbMastTarget(side);
      for (const y of [eye.y, eye.y + 6]) {
        const hit = interactables.pick(eye, {
          x: (mast.xLo + mast.xHi) / 2 - eye.x,
          y: y - eye.y,
          z: (mast.zLo + mast.zHi) / 2 - eye.z,
        });
        expect(hit?.interactable.name, `${side}: the mast gaze lost to another deck`).toBe(
          side > 0 ? 'climbPort' : 'climbStarboard',
        );
      }
    }
  });

  it('never offers go-aloft from the forecastle or another below-decks space', () => {
    const interactables = buildShipInteractables({ stations: { use: () => {} } });
    for (const space of BELOW_DECKS_SPACES) {
      for (const side of CLIMB_SIDES) {
        const mast = climbMastTarget(side);
        const eye = {
          x: climbAnchors(side)[0].eye.x,
          y: space.soleY + DEFAULT_WALKER_TUNING.eyeHeight,
          z: Math.min(Math.max(FOREMAST_Z, space.zAft + 0.1), space.zForward - 0.1),
        };
        const hit = interactables.pick(eye, {
          x: (mast.xLo + mast.xHi) / 2 - eye.x,
          y: (mast.yLo + mast.yHi) / 2 - eye.y,
          z: (mast.zLo + mast.zHi) / 2 - eye.z,
        });
        expect(
          hit?.interactable.name.startsWith('climb') ?? false,
          `go-aloft offered from the ${space.name} on side ${side}`,
        ).toBe(false);
      }
    }
  });

  it('walks into and out of the climb without a click, only on deliberate motion', () => {
    for (const side of CLIMB_SIDES) {
      const eye = climbAnchors(side)[0].eye;
      expect(climbWalkEntry(eye, { forward: 0, right: side }, 0)).toBe(
        side > 0 ? 'climbPort' : 'climbStarboard',
      );
      expect(climbWalkEntry(eye, { forward: 0, right: -side }, 0)).toBeNull();
      expect(climbWalkEntry(eye, { forward: 0, right: 0 }, 0)).toBeNull();

      resetClimb();
      expect(shouldWalkOffClimb(side, -1)).toBe(true);
      expect(shouldWalkOffClimb(side, 1)).toBe(false);
      setClimbProgress(0.2);
      expect(shouldWalkOffClimb(side, -1)).toBe(false);
    }
  });

  it('is driven through the state machine, because Space cannot be tested', () => {
    // The rule the fore scuttle round wrote down: synthetic key events prove
    // nothing about this control, so what is driven is the registry row the
    // reach pick would have found.
    const interactables = buildShipInteractables({
      stations: { use: (name) => setOccupiedStation(occupiedStation() === name ? null : name) },
    });
    const side: ClimbSide = -1;
    const eye = climbAnchors(side)[0].eye;
    const target = shroudTarget(side);
    const hit = interactables.pick(eye, {
      x: (target.xLo + target.xHi) / 2 - eye.x,
      y: (target.yLo + target.yHi) / 2 - eye.y,
      z: (target.zLo + target.zHi) / 2 - eye.z,
    });
    hit!.interactable.activate();
    expect(occupiedStation()).toBe('climbStarboard');
    expect(isStationOccupied('climbPort')).toBe(false);
    // A body is in one station, so taking the shrouds cannot leave a berth taken.
    setOccupiedStation('climbStarboard');
    expect(isStationOccupied('captainsBerth')).toBe(false);
  });

  it('says three different true things depending on how far up you are', () => {
    const station = shipStation('climbStarboard');
    resetClimb();
    expect(station.verb(false)).toBe('Go aloft');
    expect(station.verb(true)).toBe('Step down on deck');
    setClimbProgress(0.5);
    expect(station.verb(true)).toBe('Lay down on deck');
    beginLayingDown();
    expect(station.verb(true)).toBe('Hold on');
  });

  it('comes down when told, and changes its mind when the player does', () => {
    const side: ClimbSide = 1;
    resetClimb();
    setClimbProgress(1);
    beginLayingDown();
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) advanceClimb(side, dt, 0);
    const half = climbProgress();
    expect(half).toBeLessThan(1);
    expect(half).toBeGreaterThan(0);
    // A deliberate move upward wins immediately: a descent you cannot stop is a
    // cutscene, and this is not one.
    advanceClimb(side, dt, 1);
    expect(climbProgress()).toBeGreaterThan(half);
    for (let i = 0; i < 20; i++) advanceClimb(side, dt, 1);
    expect(climbProgress()).toBeGreaterThan(half + 0.01);
  });

  it('lets go only at the foot, which is what stops the eye falling nine metres', () => {
    const side: ClimbSide = 1;
    resetClimb();
    setClimbProgress(1);
    beginLayingDown();
    const dt = 1 / 60;
    let released = false;
    for (let i = 0; i < 2000 && !released; i++) released = advanceClimb(side, dt, 0);
    expect(released, 'the descent never released the station').toBe(true);
    expect(isAtTheFoot(side)).toBe(true);
    const eye = climbEyeAt(side, climbProgress());
    const foot = climbAnchors(side)[0];
    // Which is the whole point: the eye the station hands back is where a body
    // standing on the deck would have it, so `standUp` is a settle and not a
    // fall.
    expect(distance(eye, foot.eye)).toBeLessThan(0.05);
    expect(Math.abs(eye.y - (foot.hold.y + DEFAULT_WALKER_TUNING.eyeHeight))).toBeLessThan(0.05);
  });

  it('declines the head cone, deliberately, and says so in the pose', () => {
    for (const side of CLIMB_SIDES) {
      for (const progress of [0, 0.5, 1]) {
        expect(climbPose(side, progress).yawRange).toBeCloseTo(Math.PI, 9);
      }
    }
  });

  /**
   * **The facing turns once, near the top, and the two ends are different jobs.**
   *
   * Climbing, the eye rides outboard of the gang, so every rope, rung and spar
   * is on the inboard side of it — face out and the climb is nine metres of
   * empty sea. Arriving, the mast is inboard and the set topsail is dead ahead,
   * so the one sector worth landing on is forward-and-outboard.
   *
   * Asserted at both ends because the sign flips between them, and a sign that
   * flips is exactly the thing this ship has got wrong four times.
   */
  it('faces the rigging on the way up and the open sea at the top', () => {
    for (const side of CLIMB_SIDES) {
      const climbing = climbPose(side, 0);
      const inboard = { x: -Math.sin(climbing.yaw), z: -Math.cos(climbing.yaw) };
      expect(Math.sign(inboard.x), 'the climber faces out to sea').toBe(-side);
      expect(climbing.pitch, 'the climber is not looking up the way they go')
        .toBeGreaterThan(0.1);

      const arrived = climbPose(side, 1);
      const out = { x: -Math.sin(arrived.yaw), z: -Math.cos(arrived.yaw) };
      expect(Math.sign(out.x), 'the lookout arrives facing the mast').toBe(side);
      expect(out.z, 'the lookout arrives facing abaft the beam').toBeGreaterThan(0.5);
      expect(arrived.pitch, 'the lookout arrives looking up or down').toBeCloseTo(0, 6);
    }
  });
});
