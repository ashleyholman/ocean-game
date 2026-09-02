import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import * as rig from '../src/vessel/schooner/rig';
import { buildShipGeometry } from '../src/vessel/schooner/shipGeometry';
import {
  DECK_STAIRS,
  DECK_LEVELS,
  deckHalfWidth,
  deckLevelAt,
  deckStandAt,
  inForeScuttle,
  openingXLimits,
  levelWalkingY,
  stairEndHeights,
  stairOutboardX,
  stairTreadCount,
  stairTreadIndexAt,
  stairTreadY,
  stairTreadZ,
} from '../src/vessel/schooner/deckSurface';
import {
  DECK_OBSTACLES,
  OBSTACLE_COLUMNS,
  OBSTACLE_SOURCES,
  SCHOONER_DECK_ENVIRONMENT,
  schoonerStandAt,
} from '../src/vessel/schooner/deckObstacles';
import {
  DECK_FITTINGS,
  FITTING_KINDS,
  fittingStandAt,
  HATCH_COAMING_HEIGHT,
  foreScuttleLid,
  foreScuttleLidPanel,
  TILLER_LENGTH,
  TILLER_MAX_HELM,
  solidExtent,
  tillerAxisPoint,
  tillerRadius,
} from '../src/vessel/schooner/deckFittings';
import type { FittingSolid } from '../src/vessel/schooner/deckFittings';
import { buildDeckFittingGeometry } from '../src/vessel/schooner/deckFittingGeometry';
import { DEFAULT_WALKER_TUNING, DeckWalker } from '../src/player/DeckWalker';
import { resetClosures, setClosureOpen } from '../src/vessel/schooner/closures';
import {
  FORE_SCUTTLE_LADDER_PANELS,
  FORE_SCUTTLE_LADDER_Z_FORWARD,
  FORE_SCUTTLE_RUNG_DEPTH,
  FORE_SCUTTLE_RUNG_THICKNESS,
  foreScuttleLadder,
  foreScuttleLadderFootY,
  foreScuttleLadderHeadY,
  foreScuttleLadderRise,
} from '../src/vessel/schooner/interiorFittings';
import {
  belowDecksSpace,
  spaceHalfWidthAt,
  spacesAt,
} from '../src/vessel/schooner/deckInterior';
import {
  BULWARK_THICKNESS,
  FORECASTLE_AFT_Z,
  FORECASTLE_RISE,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
  foreScuttleOpening,
  HULL_LENGTH,
  QUARTERDECK_FORWARD_Z,
  QUARTERDECK_RISE,
  bulwarkOuterHalfBeam,
  counterStationZ,
} from '../src/vessel/schooner/hullForm';

/** Inside a ladder's footprint, where the deck is drawn under the flight. */
function onAFlight(x: number, z: number): boolean {
  const ax = Math.abs(x);
  return DECK_STAIRS.some(
    (stair) =>
      ax >= stair.xInboard - 1e-3 &&
      ax <= stairOutboardX(stair, z) + 0.05 &&
      z >= stair.zTop - 1e-3 &&
      z <= stair.zBottom + 1e-3,
  );
}

/** Within a millimetre of a deck break, where two levels legitimately meet. */
function onABreak(z: number): boolean {
  return (
    Math.abs(z - QUARTERDECK_FORWARD_Z) < 2e-3 || Math.abs(z - FORECASTLE_AFT_Z) < 2e-3
  );
}

describe('the walking surface', () => {
  /**
   * The check that means something.
   *
   * The loft samples 140 stations by 8 columns and applies the counter's rake as
   * it places each vertex; `deckStandAt` takes a position and *inverts* that rake
   * to find the station. Two different computations, one surface — so agreement
   * is a result rather than a tautology. Checking the walker against
   * `deckStandAt` instead would be the rig round's failure mode: a test that
   * derives the truth the same wrong way as the code cannot fail.
   */
  it('answers the same height the drawn deck was built at', () => {
    const deck = buildShipGeometry().geometries.get('deck');
    expect(deck).toBeDefined();
    const position = deck!.getAttribute('position');
    const normal = deck!.getAttribute('normal');

    let checked = 0;
    let worst = 0;
    let worstAt = '';
    for (let i = 0; i < position.count; i++) {
      // Upward-facing vertices only: the ladders' cheeks and the risers are
      // vertical faces, and no query about a floor is asked at them.
      if (normal.getY(i) < 0.9) continue;
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      // The loft draws the deck all the way to the stemhead, where the bulwark
      // has closed to the siding of the stem and the walkable width is zero.
      // That is a row of coincident vertices, not a floor. (No rake forward, so
      // the station is the placed z.)
      if (deckHalfWidth(z, deckLevelAt(z)) <= 1e-4) continue;

      const stand = deckStandAt(x, z);
      expect(stand, `no deck under a drawn deck vertex at x ${x} z ${z}`).not.toBeNull();
      const error = Math.abs(stand!.y - y);
      checked++;

      // On a break line the loft draws two vertices, one per level, and both
      // are real: the query answers with the higher, because that is what a
      // body standing there is standing on. Require it to be one of the two
      // rather than skipping the break, which is where the interesting faults
      // are. The rises are not exact — the upper deck is narrower, so it
      // carries slightly less camber — hence the centimetre.
      if (onAFlight(x, z)) {
        // A flight is a stack, and this vertex may belong to any face of it:
        // the planking drawn continuously underneath, a tread's top, or the top
        // corner of a riser, where the surface is a step function and legally
        // answers with the tread on the other side. So the invariant is a band:
        // the walking surface is somewhere between one step below a drawn face
        // and the whole flight above the planking. The treads' own heights are
        // checked exactly by the ladder tests below.
        const lift = stand!.y - y;
        // The flight's own riser, not the nominal one: the sheer rises over the
        // flight's run and the camber differs at its two ends, so a real step is
        // a couple of millimetres taller than 0.55/3.
        const ends = stairEndHeights(DECK_STAIRS[0], DECK_STAIRS[0].xInboard);
        const step = (ends.headY - ends.footY) / DECK_STAIRS[0].risers;
        expect(
          lift >= -step - 1e-3 && lift <= QUARTERDECK_RISE + 0.06,
          `under the ladder at x ${x.toFixed(3)} z ${z.toFixed(3)} the surface is ` +
            `${lift.toFixed(4)} m from the drawn face, which is not a tread`,
        ).toBe(true);
        continue;
      }

      if (onABreak(z)) {
        // A break line carries several drawn surfaces at once: the lower deck's
        // last row, the upper deck's first row, and — here — the top tread of a
        // ladder, which is flat where the deck it lands on is cambered. The
        // query answers with the highest, because that is what a body standing
        // there stands on. So the test is about the *set*: the surface is never
        // below a drawn one, and it is either that same surface or exactly one
        // level above it. The 0.06 is the deck's camber across a flight.
        const difference = stand!.y - y;
        const rise = z < 0 ? QUARTERDECK_RISE : FORECASTLE_RISE;
        expect(
          difference >= -1e-3 && (difference < 0.06 || Math.abs(difference - rise) < 0.06),
          `break vertex at x ${x.toFixed(3)} z ${z.toFixed(3)}: the surface is ` +
            `${difference.toFixed(4)} m from it, which is neither its own level nor the next`,
        ).toBe(true);
        continue;
      }

      if (error > worst) {
        worst = error;
        worstAt = `x ${x.toFixed(3)} z ${z.toFixed(3)}`;
      }
    }

    expect(checked).toBeGreaterThan(1000);
    expect(worst, `worst disagreement at ${worstAt}`).toBeLessThan(1e-3);
  });

  it('inverts the counter rake, so the overhang aft of the transom is deck', () => {
    // The quarterdeck is carried aft of its own parameter station by the rake.
    // A query at the taffrail is therefore outside the hull's length and must
    // still land on deck.
    const aft = deckStandAt(0, -8.0);
    expect(aft, 'the counter overhang is walkable deck').not.toBeNull();
    expect(aft!.zParam).toBeGreaterThan(-8.0);
    expect(aft!.level.name).toBe('quarterdeck');
  });

  it('is bounded by the bulwark and by the ends', () => {
    expect(deckStandAt(0, 9)).toBeNull();
    expect(deckStandAt(4, 0)).toBeNull();
    const amidships = deckStandAt(0, 0);
    expect(amidships).not.toBeNull();
    expect(deckStandAt(amidships!.halfWidth + 0.05, 0)).toBeNull();
  });

  it('crowns at the centreline and falls to the deck edge', () => {
    const crown = deckStandAt(0, 0)!;
    const edge = deckStandAt(crown.halfWidth * 0.98, 0)!;
    expect(crown.y).toBeGreaterThan(edge.y);
    // A parabola: the drop at fraction u of the half-beam is u² of the camber.
    const camber = 2 * crown.halfWidth * (1 / 50);
    expect(crown.y - edge.y).toBeCloseTo(camber * 0.98 * 0.98, 4);
  });
});

describe('the quarterdeck ladders', () => {
  it('climb the whole break in steps a body can take', () => {
    for (const stair of DECK_STAIRS) {
      const midX = (stair.xInboard + stairOutboardX(stair, stair.zTop)) * 0.5;
      const { footY, headY } = stairEndHeights(stair, midX);
      expect(headY - footY).toBeGreaterThan(QUARTERDECK_RISE - 0.1);
      const rise = (headY - footY) / stair.risers;
      expect(rise).toBeLessThan(DEFAULT_WALKER_TUNING.stepUp);
      expect(stairTreadY(stair, stair.risers, midX)).toBeCloseTo(headY, 9);
      // The last riser is a step onto the deck, so the drawn treads stop one
      // short: a tread level with the quarterdeck, against the quarterdeck, is
      // not a step.
      expect(stairTreadCount(stair)).toBe(stair.risers - 1);
      expect(headY - stairTreadY(stair, stairTreadCount(stair), midX)).toBeCloseTo(rise, 9);
    }
  });

  it('carry one deck-timber colour around every face of each tread block', () => {
    const deck = buildShipGeometry().geometries.get('deck');
    expect(deck).toBeDefined();
    const position = deck!.getAttribute('position');
    const colour = deck!.getAttribute('color');

    for (const stair of DECK_STAIRS) {
      for (const side of stair.sides) {
        for (let index = 1; index <= stairTreadCount(stair); index++) {
          // The inboard, forward, top corner is duplicated by the tread top,
          // the riser and the cheek. Those faces used to carry two unrelated
          // palettes; at this shared point one physical timber block must now
          // answer with one exact vertex colour whichever face is sampled.
          const { zForward } = stairTreadZ(stair, index);
          const x = stair.xInboard * side;
          const y = stairTreadY(stair, index, stair.xInboard);
          const samples = new Set<string>();
          let matches = 0;
          for (let i = 0; i < position.count; i++) {
            if (Math.abs(position.getX(i) - x) > 1e-5) continue;
            if (Math.abs(position.getY(i) - y) > 1e-5) continue;
            if (Math.abs(position.getZ(i) - zForward) > 1e-5) continue;
            matches++;
            samples.add(
              [colour.getX(i), colour.getY(i), colour.getZ(i)]
                .map((channel) => channel.toFixed(7))
                .join(','),
            );
          }
          expect(matches, `stair tread ${index} shared corner`).toBeGreaterThanOrEqual(3);
          expect(samples.size, `stair tread ${index} changes timber by face`).toBe(1);
        }
      }
    }
  });

  /**
   * The two directions have to be inverses.
   *
   * `stairTreadIndexAt` maps a position to a tread and `stairTreadZ` maps a
   * tread to a position, and the loft uses the second while the walker uses the
   * first. They were written separately and disagreed: the drawn flight
   * descended toward the quarterdeck with its tallest step standing alone out
   * on the deck, while the surface the walker climbed rose correctly. Nothing
   * in the suite compared them, because the mesh-versus-surface test skipped
   * the ladder footprint — so it does not skip it any more, and this is the
   * direct statement of the same thing.
   */
  it('map position to tread and tread to position as inverses', () => {
    for (const stair of DECK_STAIRS) {
      for (let index = 1; index <= stairTreadCount(stair); index++) {
        const { zAft, zForward } = stairTreadZ(stair, index);
        expect(zAft).toBeLessThan(zForward);
        const middle = (zAft + zForward) * 0.5;
        expect(stairTreadIndexAt(stair, middle), `tread ${index} does not contain its own z`).toBe(
          index,
        );
      }
      // And the tallest step is the one against the break.
      const top = stairTreadZ(stair, stairTreadCount(stair));
      expect(Math.abs(top.zAft - stair.zTop)).toBeLessThan(1e-9);
      const bottom = stairTreadZ(stair, 1);
      expect(Math.abs(bottom.zForward - stair.zBottom)).toBeLessThan(1e-9);
      const x = (stair.xInboard + stairOutboardX(stair, stair.zTop)) * 0.5;
      expect(stairTreadY(stair, stairTreadCount(stair), x)).toBeGreaterThanOrEqual(
        stairTreadY(stair, 1, x),
      );
    }
  });

  it('leave the topmost tread one step below the deck it lands on', () => {
    for (const stair of DECK_STAIRS) {
      const x = (stair.xInboard + stairOutboardX(stair, stair.zTop)) * 0.5;
      const top = stairTreadY(stair, stairTreadCount(stair), x);
      const quarterdeck = deckStandAt(x, stair.zTop - 0.15);
      expect(quarterdeck).not.toBeNull();
      const last = quarterdeck!.y - top;
      expect(last).toBeGreaterThan(0);
      expect(last).toBeLessThan(DEFAULT_WALKER_TUNING.stepUp);
    }
  });

  it('run out to the planking, leaving no strip of deck beside them', () => {
    for (const stair of DECK_STAIRS) {
      for (const z of [stair.zTop, (stair.zTop + stair.zBottom) / 2, stair.zBottom]) {
        const edge = deckHalfWidth(z, deckLevelAt(z));
        expect(edge - stairOutboardX(stair, z)).toBeLessThan(0.05);
      }
      // And they follow the curve rather than cutting across it.
      expect(stairOutboardX(stair, stair.zTop)).not.toBeCloseTo(
        stairOutboardX(stair, stair.zBottom),
        4,
      );
    }
  });

  /**
   * The gap between the flights is bounded at both ends, and by different things.
   *
   * The old assertion was `xInboard > 0.7` and `>= mainFife.halfSpan`, which
   * justified the number it was written beside and was wrong about why. The fife
   * rail is at z = -2.52, *abaft* the break — it is not in the flight's footprint
   * at all and never constrained it. What does is the mainmast, which passes
   * through the footprint 0.5 m forward of the break.
   *
   * Below the partner collar the treads would cut through drawn timber. Above
   * the mast's collider plus a body's radius there is a channel a player can
   * walk into and not climb, which is what Ash reported getting stuck in. The
   * flight sits between the two, so squeezing past the mast puts you on it.
   */
  it('leaves the flights too narrow a gap to be walked into', () => {
    const mast = OBSTACLE_COLUMNS.find((c) => c.name === 'mainmast')!;
    const partner = DECK_FITTINGS.find((f) => f.name === 'mainPartner')!.solids[0];
    expect(partner.kind).toBe('bar');
    const collar = partner.kind === 'bar' ? Math.max(partner.radiusA, partner.radiusB) : 0;

    for (const stair of DECK_STAIRS) {
      expect(
        stair.xInboard,
        'the flight cuts through the mast partner',
      ).toBeGreaterThanOrEqual(collar);
      expect(
        stair.xInboard,
        'a body fits between the mast and the flight, which is a gap to fall into',
      ).toBeLessThanOrEqual(mast.radius + DEFAULT_WALKER_TUNING.radius);
    }
  });

  /**
   * The centreline route aft ends at the mainmast cluster, and goes round it.
   *
   * This used to walk a body into the *mast* off-centre and assert that the
   * push-out carried it onto a flight rather than leaving it in a channel
   * between the two — the shape of what Ash reported in M3. That channel is
   * closed by construction, and the test above is what holds it closed.
   *
   * The approach changed when the main fife rail moved. It now stands 0.30 m
   * forward of the mainmast (see `rig.fifeRailFor` — abaft it was on the
   * quarterdeck, sealing the companionway), so a body walking aft up the
   * centreline meets the rail first and never reaches the mast: clearing the
   * rail's end needs |x| >= 0.77 and the mast's own reach is 0.40, so the two
   * no longer overlap.
   *
   * What is worth asserting is therefore the whole route rather than the
   * deflection: **stopped in the open, free to go round, and up onto the
   * quarterdeck.** That is stronger than the old assertion, and being stopped
   * by a fife rail you can walk round is what a fife rail is for.
   */
  it('stops a body at the mainmast cluster and lets it round onto a flight', () => {
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(0.25, DECK_STAIRS[0].zBottom + 0.7)).toBe(true);
    const startY = w.y;
    const dt = 1 / 120;
    const drive = (input: { forward: number; right: number }, seconds: number): void => {
      for (let t = 0; t < seconds; t += dt) w.step(dt, { ...input, yaw: 0 });
    };

    drive({ forward: 1, right: 0 }, 2.0);
    expect(w.lastContact, 'nothing stopped the body on the centreline').not.toBeNull();
    expect(w.y - startY, 'the centreline is not a way onto the quarterdeck').toBeLessThan(
      QUARTERDECK_RISE * 0.5,
    );

    // Round it, and aft again. A body that cannot do this is wedged, which is
    // the fault this test exists for — the fitting is allowed to stop you, it
    // is not allowed to trap you.
    const pinned = { x: w.x, z: w.z };
    drive({ forward: 0, right: -1 }, 1.0);
    expect(
      Math.hypot(w.x - pinned.x, w.z - pinned.z),
      'the body could not get out from under the rail',
    ).toBeGreaterThan(0.5);
    drive({ forward: 1, right: 0 }, 3.0);
    expect(w.y - startY, 'the body never climbed').toBeGreaterThan(QUARTERDECK_RISE * 0.5);
  });
});

describe('the collision model', () => {
  /**
   * The structural guard the rig round paid for.
   *
   * Sails were checked against `SPARS`, so the tops — a different list — went
   * unchecked, and a whole category of solid object sat outside the coverage.
   * This enumerates `rig.ts` itself: every exported collection is either
   * collidable or explicitly not, and adding a new one fails here until someone
   * has decided which.
   */
  it('classifies every geometry-producing list in rig.ts', () => {
    const collections = Object.entries(rig)
      .filter(([name, value]) => /^[A-Z][A-Z0-9_]+$/.test(name) && Array.isArray(value))
      .map(([name]) => name);

    expect(collections.length).toBeGreaterThan(6);
    const unclassified = collections.filter((name) => !(name in OBSTACLE_SOURCES));
    expect(
      unclassified,
      'a new list in rig.ts must be classified in OBSTACLE_SOURCES — can a walker hit it?',
    ).toEqual([]);
  });

  it('gives every classification a reason', () => {
    for (const [name, entry] of Object.entries(OBSTACLE_SOURCES)) {
      expect(entry.reason.length, `${name} has no reason`).toBeGreaterThan(20);
    }
  });

  it('has a column for both masts, both booms and both fife rails', () => {
    const named = (fragment: string): boolean =>
      OBSTACLE_COLUMNS.some((column) => column.name.toLowerCase().includes(fragment));
    for (const fragment of ['mainmast', 'foremast', 'mainboom', 'foreboom', 'mainfife', 'forefife']) {
      expect(named(fragment), `${fragment} is not in the walker's index`).toBe(true);
    }
  });

  it('leaves the gaffs and topmasts out of the index, because they are aloft', () => {
    for (const column of OBSTACLE_COLUMNS) {
      expect(column.name).not.toMatch(/Gaff|Topmast/);
    }
    // They are still described — the index is clipped, the model is not.
    expect(DECK_OBSTACLES.some((o) => o.name === 'mainGaff')).toBe(true);
  });

  it('keeps the booms at head height over the deck, where they were measured', () => {
    const boom = DECK_OBSTACLES.find((o) => o.name === 'mainBoom')!;
    expect(boom.shape.kind).toBe('capsule');
    if (boom.shape.kind !== 'capsule') return;
    // At the break, the underside of the boom over the quarterdeck.
    const quarterdeck = deckStandAt(0, QUARTERDECK_FORWARD_Z - 0.1)!;
    const t =
      (QUARTERDECK_FORWARD_Z - boom.shape.a.z) / (boom.shape.b.z - boom.shape.a.z);
    const boomY = boom.shape.a.y + (boom.shape.b.y - boom.shape.a.y) * t;
    const clearance = boomY - boom.shape.radius - quarterdeck.y;
    expect(clearance).toBeGreaterThan(1.2);
    expect(clearance).toBeLessThan(DEFAULT_WALKER_TUNING.standingHeight);
  });
});

describe('the walk', () => {
  function walker(x: number, z: number): DeckWalker {
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(x, z)).toBe(true);
    return w;
  }

  /** Drive one direction for a while, in steps small enough not to tunnel. */
  function drive(w: DeckWalker, dirX: number, dirZ: number, seconds: number): void {
    const dt = 1 / 120;
    const yaw = Math.atan2(-dirX, -dirZ);
    for (let t = 0; t < seconds; t += dt) {
      w.step(dt, { forward: 1, right: 0, yaw });
    }
  }

  /**
   * Budgeted rather than left on the default, because this is one of the three
   * the night-sky round found failing on the clock under parallel load
   * (`NIGHT_SKY_ROUND_REPORT.md`, "Not closed"). The other two — hydrostatics
   * and response — were given explicit budgets by later rounds; this one was
   * moved behind the `slow` tag instead, which keeps it out of `npm test` but
   * does nothing for `npm run test:slow`, where the same contention applies.
   * The quiet cost is a few seconds; 120 s is the convention this suite already
   * uses for a long physics run, and is headroom rather than a target.
   */
  it('never walks off the deck, from anywhere, in any direction', {
    tags: ['slow', 'rig-geometry'],
    timeout: 120_000,
  }, () => {
    const starts: Array<[number, number]> = [
      [0, 5.4],
      [0, 1.4],
      [1.2, -1.0],
      [1.25, -2.0],
      [0, -5.0],
      [-1.4, 2.5],
    ];
    for (const [x, z] of starts) {
      for (let i = 0; i < 16; i++) {
        const angle = (i / 16) * Math.PI * 2;
        const w = walker(x, z);
        drive(w, Math.sin(angle), Math.cos(angle), 8);
        const stand = deckStandAt(w.x, w.z);
        expect(
          stand,
          `walked off the deck heading ${((angle * 180) / Math.PI).toFixed(0)}° from ${x},${z}`,
        ).not.toBeNull();
        // And still inside the rail by a body radius, not balanced on the edge.
        expect(Math.abs(w.x)).toBeLessThanOrEqual(stand!.halfWidth + 1e-6);
      }
    }
  });

  it('never ends up inside anything solid', () => {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const w = walker(0, 1.4);
      drive(w, Math.sin(angle), Math.cos(angle), 8);
      for (const column of OBSTACLE_COLUMNS) {
        if (column.yHi <= w.y + w.tuning.stepOver) continue;
        if (column.yLo >= w.y + w.tuning.standingHeight) continue;
        const dx = column.x1 - column.x0;
        const dz = column.z1 - column.z0;
        const lengthSq = dx * dx + dz * dz;
        let t = 0;
        if (lengthSq > 1e-12) {
          t = ((w.x - column.x0) * dx + (w.z - column.z0) * dz) / lengthSq;
          t = Math.min(Math.max(t, 0), 1);
        }
        const distance = Math.hypot(
          w.x - (column.x0 + dx * t),
          w.z - (column.z0 + dz * t),
        );
        expect(
          distance,
          `body is inside ${column.name} after heading ${((angle * 180) / Math.PI).toFixed(0)}°`,
        ).toBeGreaterThan(column.radius + w.tuning.radius - 1e-3);
      }
    }
  });

  it('walks up the ladder onto the quarterdeck, and cannot climb the break itself', () => {
    const stair = DECK_STAIRS[0];
    // **On the hand the flight actually stands on.** It used to stand on both,
    // and this took the port one by taking `xInboard` at face value. The port
    // side of the break is the companionway now — see `DeckStair.sides` — so a
    // body placed there walks down rather than up.
    const hand = stair.sides[0];
    const onLadder = walker(
      hand * (stair.xInboard + stairOutboardX(stair, stair.zBottom)) * 0.5,
      stair.zBottom + 0.4,
    );
    drive(onLadder, 0, -1, 4);
    expect(onLadder.z).toBeLessThan(stair.zTop);
    const quarterdeckY = levelWalkingY(-3.5, DECK_LEVELS[0]);
    expect(onLadder.y).toBeGreaterThan(quarterdeckY - 0.15);

    // The same walk on the centreline meets a 0.55 m wall and stops forward of it.
    const atBreak = walker(0, -1.2);
    drive(atBreak, 0, -1, 4);
    expect(atBreak.z).toBeGreaterThan(QUARTERDECK_FORWARD_Z);
  });

  it('reaches the forecastle, the waist and the quarterdeck from one another', () => {
    // A flood fill over the deck, driven through the walker's own move routine,
    // so an impassable pinch shows up as unreachability rather than as a feeling.
    const STEP = 0.2;
    const probe = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    const key = (ix: number, iz: number): string => `${ix},${iz}`;
    const startX = 0;
    const startZ = 1.4;
    const seen = new Set<string>([key(0, 0)]);
    const queue: Array<[number, number]> = [[0, 0]];
    const reached: Array<[number, number]> = [];

    while (queue.length > 0) {
      const [ix, iz] = queue.shift()!;
      const x = startX + ix * STEP;
      const z = startZ + iz * STEP;
      reached.push([x, z]);
      if (reached.length > 20000) break;
      for (const [dx, dz] of [
        [STEP, 0],
        [-STEP, 0],
        [0, STEP],
        [0, -STEP],
      ]) {
        const nx = ix + Math.sign(dx);
        const nz = iz + Math.sign(dz);
        if (seen.has(key(nx, nz))) continue;
        seen.add(key(nx, nz));
        if (!probe.placeAt(x, z)) continue;
        if (probe.attemptMove(dx, dz)) queue.push([nx, nz]);
      }
    }

    const reachedNear = (x: number, z: number): boolean =>
      reached.some(([rx, rz]) => Math.hypot(rx - x, rz - z) < STEP);

    expect(reachedNear(0, 5.6), 'the forecastle is not reachable from the waist').toBe(true);
    expect(reachedNear(0, -4.0), 'the quarterdeck is not reachable from the waist').toBe(true);
    expect(reachedNear(0, -6.8), 'the helm is not reachable from the waist').toBe(true);
    expect(reachedNear(1.5, 0), 'the port gangway is not reachable').toBe(true);
    expect(reachedNear(-1.5, 0), 'the starboard gangway is not reachable').toBe(true);
  });
});

// --- the deck's furniture ------------------------------------------------------

/** Sample points along a fitting's solid, in ship-local placed coordinates. */
function solidSamples(solid: FittingSolid): Array<{ x: number; y: number; z: number }> {
  if (solid.kind === 'box') {
    const { centre, half } = solid;
    const out: Array<{ x: number; y: number; z: number }> = [];
    for (const sx of [-1, 0, 1]) {
      for (const sz of [-1, 0, 1]) {
        for (const sy of [-1, 1]) {
          out.push({
            x: centre.x + sx * half.x,
            y: centre.y + sy * half.y,
            z: centre.z + sz * half.z,
          });
        }
      }
    }
    return out;
  }
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    out.push({
      x: solid.a.x + (solid.b.x - solid.a.x) * t,
      y: solid.a.y + (solid.b.y - solid.a.y) * t,
      z: solid.a.z + (solid.b.z - solid.a.z) * t,
    });
  }
  return out;
}

/** Horizontal distance from a point to a column's segment. */
function columnDistanceTo(
  column: (typeof OBSTACLE_COLUMNS)[number],
  x: number,
  z: number,
): number {
  const dx = column.x1 - column.x0;
  const dz = column.z1 - column.z0;
  const lengthSq = dx * dx + dz * dz;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((x - column.x0) * dx + (z - column.z0) * dz) / lengthSq;
    t = Math.min(Math.max(t, 0), 1);
  }
  return Math.hypot(x - (column.x0 + dx * t), z - (column.z0 + dz * t));
}

describe('the deck fittings', () => {
  /**
   * The same structural guard `OBSTACLE_SOURCES` holds for the rig, held here for
   * the furniture — and it has to be held separately, because that guard
   * enumerates `rig.ts` and would go on passing forever while a whole second
   * module of solid objects grew beside it. That is precisely the failure it
   * exists to prevent, one level up: a completeness check is only complete about
   * the thing it enumerates.
   */
  it('classifies every kind of fitting, with a reason', () => {
    const kinds = new Set(DECK_FITTINGS.map((f) => f.kind));
    for (const kind of kinds) {
      expect(kind in FITTING_KINDS, `${kind} is not classified in FITTING_KINDS`).toBe(true);
    }
    for (const [kind, entry] of Object.entries(FITTING_KINDS)) {
      expect(entry.reason.length, `${kind} has no reason`).toBeGreaterThan(20);
      expect(kinds.has(kind as never), `${kind} is classified but nothing uses it`).toBe(true);
    }
  });

  it('stands every fitting on the deck, inboard of the bulwarks', () => {
    for (const fitting of DECK_FITTINGS) {
      for (const solid of fitting.solids) {
        for (const p of solidSamples(solid)) {
          expect(
            deckStandAt(p.x, p.z),
            `${fitting.name} reaches x=${p.x.toFixed(2)}, z=${p.z.toFixed(2)}, which is not deck`,
          ).not.toBeNull();
        }
      }
    }
  });

  /**
   * A fitting is bolted to the ship, not floating over her.
   *
   * Per fitting rather than per solid, because a windlass barrel is carried by
   * its bitts and a tiller is socketed in its rudder head — neither touches the
   * planking and neither is wrong. What would be wrong is a whole fitting whose
   * lowest timber never reaches the deck, which is what a mistyped height looks
   * like and is invisible from any angle but a low one.
   */
  it('lands every fitting on the planking it stands on', () => {
    for (const fitting of DECK_FITTINGS) {
      let lowest = Infinity;
      let deckUnder = -Infinity;
      for (const solid of fitting.solids) {
        lowest = Math.min(lowest, solidExtent(solid).yLo);
        for (const p of solidSamples(solid)) {
          const stand = deckStandAt(p.x, p.z);
          if (stand) deckUnder = Math.max(deckUnder, stand.y);
        }
      }
      expect(lowest, `${fitting.name} floats above the deck`).toBeLessThanOrEqual(deckUnder);
    }
  });

  /**
   * The drawn timber and the collider are the same timber.
   *
   * Sampled off `DECK_FITTINGS` — the one description — so what this proves is
   * that the derivation in `deckObstacles.ts` dropped nothing: every piece that
   * says it is solid has a column standing where it stands. The mesh side is
   * covered by the loft test below, which checks the triangles against the same
   * data from the other direction.
   */
  it('gives every solid piece a column the walker can meet', () => {
    for (const fitting of DECK_FITTINGS) {
      for (const [index, solid] of fitting.solids.entries()) {
        if (!solid.collides) continue;
        const name = `${fitting.name}[${index}]`;
        const columns = OBSTACLE_COLUMNS.filter((c) => c.name === name);
        const extent = solidExtent(solid);
        // Only pieces reaching into the walker's band are indexed; the index is
        // clipped to 3.0–7.4 and everything here is well inside it.
        expect(columns.length, `${name} has no column`).toBeGreaterThan(0);
        for (const p of solidSamples(solid)) {
          const covered = columns.some(
            (c) =>
              columnDistanceTo(c, p.x, p.z) <= c.radius + 1e-6 &&
              p.y >= c.yLo - 1e-6 &&
              p.y <= c.yHi + 1e-6,
          );
          expect(covered, `${name} is drawn outside its own collider`).toBe(true);
        }
        expect(extent.yHi).toBeGreaterThan(extent.yLo);
      }
    }
  });

  /**
   * The loft draws the data and nothing else.
   *
   * `deckFittingGeometry.ts` is a second computation over the same list — it
   * sweeps tubes and boxes where the list says pieces are — so agreement is a
   * result rather than a tautology, in the way the mesh-versus-surface test at
   * the head of this file is.
   */
  it('draws no triangle outside the fittings it was given', () => {
    const built = buildDeckFittingGeometry();
    const boxes = DECK_FITTINGS.flatMap((f) =>
      f.solids.map((solid) => {
        if (solid.kind === 'box') {
          return {
            x0: solid.centre.x - solid.half.x,
            x1: solid.centre.x + solid.half.x,
            y0: solid.centre.y - solid.half.y,
            y1: solid.centre.y + solid.half.y,
            z0: solid.centre.z - solid.half.z,
            z1: solid.centre.z + solid.half.z,
          };
        }
        const r = Math.max(solid.radiusA, solid.radiusB);
        return {
          x0: Math.min(solid.a.x, solid.b.x) - r,
          x1: Math.max(solid.a.x, solid.b.x) + r,
          y0: Math.min(solid.a.y, solid.b.y) - r,
          y1: Math.max(solid.a.y, solid.b.y) + r,
          z0: Math.min(solid.a.z, solid.b.z) - r,
          z1: Math.max(solid.a.z, solid.b.z) + r,
        };
      }),
    );

    let vertices = 0;
    for (const geometry of built.geometries.values()) {
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        vertices++;
        const inside = boxes.some(
          (b) =>
            x >= b.x0 - 2e-3 &&
            x <= b.x1 + 2e-3 &&
            y >= b.y0 - 2e-3 &&
            y <= b.y1 + 2e-3 &&
            z >= b.z0 - 2e-3 &&
            z <= b.z1 + 2e-3,
        );
        expect(
          inside,
          `a fitting vertex at ${x.toFixed(3)}, ${y.toFixed(3)}, ${z.toFixed(3)} belongs to no fitting`,
        ).toBe(true);
      }
    }
    expect(vertices).toBeGreaterThan(500);
  });

  /**
   * Where a fitting is allowed to be inside a spar, and nowhere else.
   *
   * Three overlaps are the point of the fitting: a mast partner is the collar the
   * mast passes through, and the bowsprit's chocks and bolster are what hold the
   * sprit. Listed with their measured depths, the way the rig round listed the
   * three masthead fouls it chose to keep, so a fourth cannot appear quietly.
   */
  it('touches a spar only where the fitting exists to hold one', () => {
    const spars = OBSTACLE_COLUMNS.filter((c) => c.source === 'spar');
    const allowed = new Set(['mainPartner', 'forePartner', 'bowspritHeel']);
    const found = new Set<string>();
    for (const fitting of DECK_FITTINGS) {
      for (const solid of fitting.solids) {
        for (const p of solidSamples(solid)) {
          for (const column of spars) {
            if (p.y < column.yLo || p.y > column.yHi) continue;
            if (columnDistanceTo(column, p.x, p.z) >= column.radius) continue;
            found.add(`${fitting.name} in ${column.name}`);
            expect(
              allowed.has(fitting.name),
              `${fitting.name} runs through ${column.name}`,
            ).toBe(true);
          }
        }
      }
    }
    expect([...found].sort()).toEqual([
      'bowspritHeel in bowsprit',
      'forePartner in foremast',
      'mainPartner in mainmast',
    ]);
  });
});

describe('the cargo hatch', () => {
  /**
   * The coaming's height is not a free number: it is bounded by the body.
   *
   * Taller than `stepUp` and the hatch becomes an island in the middle of the
   * working deck — a floor the player can see, can walk to the edge of, and
   * cannot get onto. Asserted against the walker's own tuning rather than against
   * 0.32 written out a second time, so lowering the step raises this failure
   * instead of quietly stranding the lid.
   */
  it('keeps its coaming inside the step a body can take', () => {
    expect(HATCH_COAMING_HEIGHT).toBeLessThan(DEFAULT_WALKER_TUNING.stepUp);
    expect(HATCH_COAMING_HEIGHT).toBeGreaterThan(0.2);
  });

  /**
   * A level hatch on a sheered deck stands at two different heights.
   *
   * She rises 85 mm over the hatch's own 1.98 m, so the coaming is 0.28 m proud
   * at its after end and 0.195 m at its forward end. Both are steps a body takes,
   * and the sunk foot covers the difference — but the step is not one number, and
   * an assertion that treated it as one failed here first.
   */
  it('stands one level lid on a deck that rises 85 mm under it', () => {
    const panel = DECK_FITTINGS.find((f) => f.name === 'cargoHatch')!.standable!;
    const aft = deckStandAt(0, panel.z0 - 0.05)!;
    const forward = deckStandAt(0, panel.z1 + 0.05)!;
    expect(forward.y - aft.y).toBeGreaterThan(0.05);
    for (const deck of [aft, forward]) {
      const step = panel.y - deck.y;
      expect(step, 'the lid is below the deck beside it').toBeGreaterThan(0.1);
      expect(step, 'the lid is a wall, not a step').toBeLessThan(DEFAULT_WALKER_TUNING.stepUp);
    }
  });

  /**
   * Steppable from every point of its own edge, not from the two I happened to
   * try.
   *
   * The first version of this hatch was level from the crown at its middle, and
   * the deck is neither level nor flat: she rises 85 mm over its length and falls
   * 18 mm across its breadth to the camber, so the after outboard corners stood
   * 0.334 m below the lid against a 0.32 m step. Two corners of four were
   * unreachable, which is precisely how Ash described it — "only seems to allow
   * step-up from certain parts of its border".
   *
   * A test that walks on from fore and aft cannot see that. This walks the whole
   * perimeter.
   */
  it('is a step a body can take from anywhere on its edge', () => {
    const panel = DECK_FITTINGS.find((f) => f.name === 'cargoHatch')!.standable!;
    const margin = DEFAULT_WALKER_TUNING.radius * 0.5;
    let worst = 0;
    let worstAt = '';
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const x = panel.x0 + (panel.x1 - panel.x0) * t;
      const z = panel.z0 + (panel.z1 - panel.z0) * t;
      for (const [px, pz] of [
        [x, panel.z0 - margin],
        [x, panel.z1 + margin],
        [panel.x0 - margin, z],
        [panel.x1 + margin, z],
      ]) {
        const deck = deckStandAt(px, pz);
        expect(deck, `no deck beside the hatch at ${px.toFixed(2)}, ${pz.toFixed(2)}`).not.toBeNull();
        const step = panel.y - deck!.y;
        if (step > worst) {
          worst = step;
          worstAt = `x ${px.toFixed(2)} z ${pz.toFixed(2)}`;
        }
      }
    }
    expect(worst, `tallest step onto the hatch is at ${worstAt}`).toBeLessThanOrEqual(
      DEFAULT_WALKER_TUNING.stepUp,
    );
  });

  it('lets a body walk onto it from every heading', () => {
    const panel = DECK_FITTINGS.find((f) => f.name === 'cargoHatch')!.standable!;
    const midX = (panel.x0 + panel.x1) * 0.5;
    const midZ = (panel.z0 + panel.z1) * 0.5;
    const dt = 1 / 120;
    const failed: string[] = [];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      // Start 1.4 m out from the middle on this bearing, and walk straight at it.
      const sx = midX + Math.sin(angle) * 1.4;
      const sz = midZ + Math.cos(angle) * 1.4;
      const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
      if (!w.placeAt(sx, sz)) continue;
      // The walker's forward is (-sin yaw, -cos yaw), and the bearing from the
      // start point back to the middle is (-sin angle, -cos angle). So the yaw
      // that walks at the hatch is the bearing itself.
      const yaw = angle;
      // Whether it ever *got* on, not where it finished: at 3 m/s a body crosses
      // the whole hatch and keeps going, and asking where it stopped tests the
      // length of the walk rather than the height of the step.
      let reached = false;
      for (let t = 0; t < 1.6 && !reached; t += dt) {
        w.step(dt, { forward: 1, right: 0, yaw });
        if (Math.abs(w.y - panel.y) < 1e-3) reached = true;
      }
      if (!reached) failed.push(`${((angle * 180) / Math.PI).toFixed(0)}°`);
    }
    expect(failed, 'headings from which the body could not get onto the hatch').toEqual([]);
  });

  /**
   * A hatch is a floor 0.28 m up, and headroom is measured from what you stand
   * on.
   *
   * `ship-rig.test.ts` measures both booms against the *deck*, which was the only
   * floor there was until this round. Standing on the grating puts a body's head
   * 0.28 m higher into a fore boom that is already low, and no existing check
   * could see that — the surface it measures from did not exist when it was
   * written.
   *
   * Recorded rather than fixed. Ash's rule from the helm applies in reverse here:
   * ducking is fine where a body can accommodate it, and nobody has to stand on a
   * cargo hatch while she goes about — you step off. The number is held so it
   * cannot quietly become a crawl.
   */
  it('keeps a duck of headroom for a body standing on the grating', () => {
    const panel = DECK_FITTINGS.find((f) => f.name === 'cargoHatch')!.standable!;
    const boom = rig.SPARS.find((s) => s.name === 'foreBoom')!;
    const rise = boom.head.y - boom.heel.y;
    const length = Math.hypot(
      boom.head.x - boom.heel.x,
      rise,
      boom.head.z - boom.heel.z,
    );
    const run = Math.sqrt(length * length - rise * rise);

    let worst = Infinity;
    for (let z = panel.z0; z <= panel.z1; z += 0.05) {
      const f = (boom.heel.z - z) / run;
      if (f < 0 || f > 1) continue;
      const under =
        boom.heel.y + rise * f - (boom.heelRadius + (boom.headRadius - boom.heelRadius) * f);
      worst = Math.min(worst, under - panel.y);
    }
    expect(`fore boom over the grating: ${worst.toFixed(2)} m`).toBe(
      `fore boom over the grating: ${Math.max(worst, 1.25).toFixed(2)} m`,
    );
    // And the deck beside it keeps more, which is the point of stepping off.
    // `Infinity` reach: this is a question about the topmost surface, which is
    // what a body on the weather deck finds.
    const beside = schoonerStandAt(0, panel.z0 - 0.4, Infinity)!;
    expect(panel.y).toBeGreaterThan(beside.y);
  });

  it('raises the walker onto its grating and puts them down the other side', () => {
    const panel = DECK_FITTINGS.find((f) => f.name === 'cargoHatch')!.standable!;
    const midZ = (panel.z0 + panel.z1) * 0.5;
    expect(schoonerStandAt(0, midZ, Infinity)!.y).toBeCloseTo(panel.y, 6);
    expect(schoonerStandAt(0, panel.z0 - 0.3, Infinity)!.y).toBeLessThan(panel.y);

    // And the body actually gets up there and off again, through its own move
    // routine rather than through the query it is built on.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(0, panel.z1 + 0.7)).toBe(true);
    const dt = 1 / 120;
    // Aft: the camera looks down its own -Z, so yaw 0 faces aft on a ship whose
    // +z is the bow.
    const walkAft = (seconds: number): void => {
      for (let t = 0; t < seconds; t += dt) w.step(dt, { forward: 1, right: 0, yaw: 0 });
    };

    walkAft(0.5);
    expect(w.z, 'the walker did not reach the hatch').toBeLessThan(panel.z1);
    expect(w.z).toBeGreaterThan(panel.z0);
    expect(w.y, 'the walker walked through the hatch instead of onto it').toBeCloseTo(
      panel.y,
      3,
    );

    walkAft(0.9);
    expect(w.z, 'the walker never got off the hatch').toBeLessThan(panel.z0);
    expect(w.y, 'the walker stayed at hatch height after leaving it').toBeLessThan(
      panel.y - 0.1,
    );
    expect(w.y).toBeCloseTo(deckStandAt(w.x, w.z)!.y, 3);
  });
});

describe('the tiller', () => {
  /** Every helm angle the stops allow, sampled across the whole bar. */
  function sweepPoints(): Array<{ x: number; y: number; z: number; radius: number }> {
    const out: Array<{ x: number; y: number; z: number; radius: number }> = [];
    for (let h = -16; h <= 16; h++) {
      const helm = (h / 16) * TILLER_MAX_HELM;
      for (let i = 1; i <= 20; i++) {
        const t = i / 20;
        const p = tillerAxisPoint(helm, t);
        out.push({ ...p, radius: tillerRadius(t) });
      }
    }
    return out;
  }

  /**
   * `docs/ship/SHIP_SPEC.md` section 8: the tiller "must sweep a mechanically plausible arc
   * and occupy real working space" — it is not a prop. That sentence is the
   * requirement this test is, and it is why the main sheet horse moved abaft the
   * rudder head rather than the tiller being shortened around it.
   */
  it('sweeps its full helm without meeting anything solid', () => {
    const fouls: string[] = [];
    for (const p of sweepPoints()) {
      for (const column of OBSTACLE_COLUMNS) {
        if (column.name.startsWith('tiller')) continue;
        if (p.y < column.yLo || p.y > column.yHi) continue;
        const gap = columnDistanceTo(column, p.x, p.z) - column.radius - p.radius;
        if (gap < 0) fouls.push(`${column.name} by ${(-gap * 1000).toFixed(0)} mm`);
      }
    }
    expect([...new Set(fouls)].sort()).toEqual([]);
  });

  it('stays inboard of the bulwark at its own height, not the deck edge', () => {
    for (const p of sweepPoints()) {
      const zParam = counterStationZ(p.z, p.y);
      const inner = bulwarkOuterHalfBeam(zParam, p.y) - BULWARK_THICKNESS;
      expect(
        Math.abs(p.x) + p.radius,
        `the tiller reaches the planking at z=${p.z.toFixed(2)}`,
      ).toBeLessThan(inner);
    }
  });

  /**
   * The length is solved, so the useful assertion is that the solve *bound* —
   * that the tiller is as long as the deck permits and not simply as long as its
   * own upper limit, which is what the first version silently returned.
   */
  it('is limited by the counter, not by its own upper bound', () => {
    expect(TILLER_LENGTH).toBeLessThan(HULL_LENGTH / 6 - 0.05);
    expect(TILLER_LENGTH).toBeGreaterThan(1.6);
    const tip = tillerAxisPoint(TILLER_MAX_HELM, 1);
    const zParam = counterStationZ(tip.z, tip.y);
    const inner = bulwarkOuterHalfBeam(zParam, tip.y) - BULWARK_THICKNESS;
    // The binding case: at full helm the tip is within a hand's width of the
    // clearance the solve was asked for.
    expect(inner - Math.abs(tip.x) - tillerRadius(1)).toBeLessThan(0.16);
  });

  /**
   * The helm is workable with the boom amidships. This is the requirement Ash
   * set: "you need to fix the sail plan to make manning the helm possible while
   * that boom swings."
   *
   * WHY THE HELM IS DIFFERENT FROM THE REST OF THE DECK
   * ---------------------------------------------------
   * Everywhere else on this ship, ducking under a boom is period-true and fine:
   * you see it coming, you bend, you carry on walking. The helm is the one
   * station where a body cannot step aside — the thing he is holding is the
   * reason he is there — and the boom crosses *over him* every time she goes
   * about. At 1.38 m he was not ducking, he was kneeling, and the collision model
   * would simply have refused to let him stand there once M6 lets the boom come
   * in.
   *
   * The boom is measured **amidships**, which is where it is at the moment of the
   * tack and is not where she is drawn. Derived from the drawn spar rather than
   * from the rig's constants: length and rise are invariant under the swing, so
   * un-swinging the spar that is lofted is a second computation over the same
   * timber. `SHEET_MAIN` could change tomorrow and this would still be asking
   * about the boom that exists.
   */
  it('can be manned with the main boom amidships', () => {
    const boom = rig.SPARS.find((s) => s.name === 'mainBoom')!;
    const rise = boom.head.y - boom.heel.y;
    const length = Math.hypot(
      boom.head.x - boom.heel.x,
      boom.head.y - boom.heel.y,
      boom.head.z - boom.heel.z,
    );
    const run = Math.sqrt(length * length - rise * rise);

    /** Underside of the boom on the centreline at a placed z, swung amidships. */
    const boomUnderside = (z: number): number | null => {
      const f = (boom.heel.z - z) / run;
      if (f < 0 || f > 1) return null;
      return (
        boom.heel.y + rise * f - (boom.heelRadius + (boom.headRadius - boom.heelRadius) * f)
      );
    };

    // The station: everywhere a body must be able to stand to hold the tiller
    // through its whole sweep, plus a stride abaft the tip to lean into it.
    const tip = tillerAxisPoint(0, 1);
    const socket = tillerAxisPoint(0, 0);
    let worst = Infinity;
    let worstAt = 0;
    for (let z = socket.z + 0.3; z <= tip.z + 0.5; z += 0.1) {
      const stand = deckStandAt(0, z);
      const under = boomUnderside(z);
      if (!stand || under === null) continue;
      const headroom = under - stand.y;
      if (headroom < worst) {
        worst = headroom;
        worstAt = z;
      }
    }

    expect(
      worst,
      `only ${worst.toFixed(2)} m over the helm at z ${worstAt.toFixed(1)} — a body is ` +
        `${DEFAULT_WALKER_TUNING.standingHeight} m and cannot step aside from a tiller`,
    ).toBeGreaterThan(DEFAULT_WALKER_TUNING.standingHeight);
  });

  it('leaves the helmsman standing room abaft its forward end', () => {
    const tip = tillerAxisPoint(0, 1);
    const stand = deckStandAt(0, tip.z + 0.4);
    expect(stand).not.toBeNull();
    expect(stand!.halfWidth).toBeGreaterThan(DEFAULT_WALKER_TUNING.radius * 2);
    // Hand height: the whole point of the bar's rise.
    expect(tip.y - deckStandAt(0, tip.z)!.y).toBeGreaterThan(0.8);
    expect(tip.y - deckStandAt(0, tip.z)!.y).toBeLessThan(1.1);
  });
});

describe('the forecastle, with the windlass on it', () => {
  /**
   * The centreline forward is deliberately closed, and this records it.
   *
   * There is one place a windlass can go on this ship and the hull chose it: the
   * forecastle break is at z = 4.6, the bowsprit's heel is at z = 5.15, and from
   * the heel forward the sprit's underside runs 0.12–0.34 m over the planking the
   * whole way, so nothing stands under it. That leaves 0.55 m, the windlass fills
   * it, and she is crossed forward by the gangways outboard of its bitt heads.
   *
   * The reachability fill in `the walk` proves the forecastle is still reachable.
   * This measures what it costs.
   */
  it('closes the centreline and keeps a gangway either side', () => {
    const windlass = DECK_FITTINGS.find((f) => f.name === 'windlass')!;
    const barrel = windlass.solids[0];
    expect(barrel.kind).toBe('bar');
    if (barrel.kind !== 'bar') return;

    const deck = deckStandAt(0, barrel.a.z)!;
    const topAboveDeck = barrel.a.y + barrel.radiusA - deck.y;
    expect(
      topAboveDeck,
      'the barrel is low enough to step over, so the centreline is not closed after all',
    ).toBeGreaterThan(DEFAULT_WALKER_TUNING.stepOver);

    // Outboard of the bitt heads, to the planking.
    const bitts = windlass.solids.filter((s) => s.kind === 'box');
    const outermost = Math.max(
      ...bitts.map((s) => (s.kind === 'box' ? Math.abs(s.centre.x) + s.half.x : 0)),
    );
    const gangway = deck.halfWidth - outermost;
    expect(gangway, `only ${gangway.toFixed(2)} m of gangway past the windlass`).toBeGreaterThan(
      0.45,
    );
  });

  /**
   * Forward of the heel the sprit is bolstered down to the planking and every
   * one of those blocks is a step. Abaft it, the step the heel butts into is a
   * solid you go round — a bowsprit is in compression and something has to take
   * it. The two are told apart by which side of the heel they are on, not by a
   * name, so a block that drifts across the heel fails here.
   */
  it('bolsters the sprit in steps and butts its heel against a solid', () => {
    const heel = DECK_FITTINGS.find((f) => f.name === 'bowspritHeel')!;
    const heelZ = rig.SPARS.find((s) => s.name === 'bowsprit')!.heel.z;
    const onCentreline = heel.solids.filter(
      (s) => s.kind === 'box' && s.collides && Math.abs(s.centre.x) < 0.2,
    );

    const bolsters = onCentreline.filter((s) => s.kind === 'box' && s.centre.z > heelZ);
    const steps = onCentreline.filter((s) => s.kind === 'box' && s.centre.z <= heelZ);
    expect(bolsters.length, 'the sprit is not bolstered down to the deck').toBeGreaterThan(2);
    expect(steps.length, 'the sprit heel butts against nothing').toBe(1);

    for (const solid of bolsters) {
      if (solid.kind !== 'box') continue;
      const deck = deckStandAt(solid.centre.x, solid.centre.z);
      if (!deck) continue;
      const top = solid.centre.y + solid.half.y - deck.y;
      expect(
        top,
        `the bowsprit bolster stands ${top.toFixed(2)} m up and is a wall, not a step`,
      ).toBeLessThan(DEFAULT_WALKER_TUNING.stepOver);
    }

    // The step actually reaches the heel, and over the top of it.
    const step = steps[0];
    if (step.kind !== 'box') return;
    expect(step.centre.z + step.half.z).toBeGreaterThanOrEqual(heelZ);
    const at = rig.SPARS.find((s) => s.name === 'bowsprit')!;
    expect(step.centre.y + step.half.y).toBeGreaterThan(at.heel.y + at.heelRadius);
  });

  it('reaches the head, past the windlass and over the sprit', () => {
    const probe = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(probe.placeAt(0.9, 5.4), 'no deck beside the bowsprit heel').toBe(true);
    expect(probe.placeAt(0.7, 6.4), 'no deck at the head').toBe(true);
  });
});

describe('the fittings — vertex normals agree with face winding', () => {
  /**
   * The rig has this test because the whole rig shipped inverted once. The
   * fittings have it because a primitive they share got it wrong again the
   * moment it grew end caps: `addTube` drew none, so every round object aboard
   * was an open pipe that read as *transparent* under front-face culling, and
   * the first capped build had all 488 of its discs wound backwards.
   *
   * A cap is the worst case for this fault, too. A backwards wall is visible
   * because you see the inside of the far one; a backwards disc on a solid is
   * invisible from outside and only shows as the hole it was meant to close.
   */
  function windingAgreement(geometry: THREE.BufferGeometry): {
    agree: number;
    disagree: number;
  } {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const idx = geometry.getIndex()!;
    let agree = 0;
    let disagree = 0;
    for (let t = 0; t < idx.count / 3; t++) {
      const [i, j, k] = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
      const ax = pos.getX(i);
      const ay = pos.getY(i);
      const az = pos.getZ(i);
      const ux = pos.getX(j) - ax;
      const uy = pos.getY(j) - ay;
      const uz = pos.getZ(j) - az;
      const vx = pos.getX(k) - ax;
      const vy = pos.getY(k) - ay;
      const vz = pos.getZ(k) - az;
      const fx = uy * vz - uz * vy;
      const fy = uz * vx - ux * vz;
      const fz = ux * vy - uy * vx;
      const dot = fx * nor.getX(i) + fy * nor.getY(i) + fz * nor.getZ(i);
      if (dot > 0) agree++;
      else disagree++;
    }
    return { agree, disagree };
  }

  it('winds every fitting triangle the way its normal points', () => {
    const built = buildDeckFittingGeometry();
    for (const [region, geometry] of built.geometries) {
      const { agree, disagree } = windingAgreement(geometry);
      expect(agree).toBeGreaterThan(0);
      expect(`${region}: ${disagree} inverted`).toBe(`${region}: 0 inverted`);
    }
  });

  /**
   * Closed, not merely wound correctly.
   *
   * An open tube end is a ring of edges belonging to **one** triangle, which is
   * the shape of the fault Ash reported on the bowsprit, the tiller, the pump
   * and the mast partners — stated as a property rather than as a screenshot.
   *
   * The property is "no edge used an odd number of times", not "every edge used
   * exactly twice". A fitting is a *union* of closed solids and they are allowed
   * to touch: the hatch coaming is four boxes butting at its corners, and its
   * four vertical corner edges are each used by two triangles from each of two
   * boxes. Four is two solids meeting. One is a hole.
   */
  it('closes every fitting, so no solid has an open end', () => {
    const built = buildDeckFittingGeometry();
    for (const [region, geometry] of built.geometries) {
      const pos = geometry.getAttribute('position');
      const idx = geometry.getIndex()!;
      // Weld by position: the loft emits a fresh vertex per face, so identity is
      // where a corner *is*, not which index it happens to have.
      const key = (i: number): string =>
        `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
      const edges = new Map<string, number>();
      for (let t = 0; t < idx.count / 3; t++) {
        const v = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)].map(key);
        for (let e = 0; e < 3; e++) {
          const pair = [v[e], v[(e + 1) % 3]].sort().join('|');
          edges.set(pair, (edges.get(pair) ?? 0) + 1);
        }
      }
      const open = [...edges.values()].filter((n) => n % 2 === 1).length;
      expect(`${region}: ${open} open edges`).toBe(`${region}: 0 open edges`);
    }
  });
});

describe('the fore scuttle', () => {
  const scuttle = foreScuttleOpening();

  /**
   * Where it is, checked against what was standing there — not against the
   * numbers that were chosen to fit.
   *
   * The whole argument for putting a hatch here is that this patch of deck is
   * empty, and "empty" is a claim about the *other* objects. So this asks the
   * obstacle index, which is derived from the authored rig and fitting lists,
   * rather than re-stating the four stations the placement was reasoned from.
   * Move the fife rail and this fails; move it in the comment and it does not.
   */
  it('stands clear of everything else on the foredeck', () => {
    const { xLo, xHi } = openingXLimits(scuttle, FORE_SCUTTLE_Z);
    // Generous: the rebate frame stands outside the hole, and a fitting that
    // merely touched the coaming would still be wrong.
    const margin = 0.06;

    for (const column of OBSTACLE_COLUMNS) {
      // **Things standing on the planking, and only those.** Rigging nine
      // metres up is not in the way of a hatch, and neither is the forecastle's
      // own after bulkhead — which reaches up to the deckhead at 3.86 and stops
      // there, 0.16 m *under* the deck this hole is cut in. The first version of
      // this filter took anything whose extent came within half a metre of the
      // planking and duly reported the bulkhead the ladder is spiked to.
      const deck = deckStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z)!;
      if (column.yLo > deck.y + DEFAULT_WALKER_TUNING.standingHeight) continue;
      if (column.yHi < deck.y + 0.02) continue;

      // Closest approach of the column's own segment to the opening's rectangle.
      const nearX = Math.min(Math.max(column.x0, xLo - margin), xHi + margin);
      const nearZ = Math.min(
        Math.max(column.z0, scuttle.zAft - margin),
        scuttle.zForward + margin,
      );
      const insideX =
        Math.min(column.x0, column.x1) < xHi + margin &&
        Math.max(column.x0, column.x1) > xLo - margin;
      const insideZ =
        Math.min(column.z0, column.z1) < scuttle.zForward + margin &&
        Math.max(column.z0, column.z1) > scuttle.zAft - margin;
      expect(
        insideX && insideZ,
        `${column.name} stands in the fore scuttle (near ${nearX.toFixed(2)}, ${nearZ.toFixed(2)})`,
      ).toBe(false);
    }
  });

  /** The hole is over the forecastle and nothing else — not the wardroom. */
  it('opens into the forecastle over its whole footprint', () => {
    const forecastle = belowDecksSpace('forecastle');
    expect(scuttle.zAft).toBeGreaterThan(forecastle.zAft);
    expect(scuttle.zForward).toBeLessThan(forecastle.zForward);
    const { xLo, xHi } = openingXLimits(scuttle, FORE_SCUTTLE_Z);
    for (const z of [scuttle.zAft, FORE_SCUTTLE_Z, scuttle.zForward]) {
      for (const x of [xLo, FORE_SCUTTLE_X, xHi]) {
        expect(spacesAt(z).map((s) => s.name)).toContain('forecastle');
        // And inside the room's own width, not hanging over the ship's side.
        expect(Math.abs(x)).toBeLessThan(spaceHalfWidthAt(belowDecksSpace('forecastle'), z));
      }
    }
  });

  /**
   * **THE RULE THE COAMING COST US, WRITTEN DOWN AS A TEST.**
   *
   * A body standing on a raised lid is that much taller than the deck says it
   * is, and the walker's step-over test is measured from its feet. So a lid
   * near the bulwark turns the ship's own rail into a kerb: standing on it, the
   * headsail pin rail came under the step-over height, and the walker strode
   * over the rail and came down outboard of it. The walk sweep caught it as a
   * body 0.145 m inside `headsailPinRailStarboard[4]` on one heading of
   * sixteen — a symptom that names the rail and says nothing about the hatch.
   *
   * The general rule is **any raised standable surface within a stride of the
   * bulwark does this**, and the defence is not a height, it is a *distance*:
   * no point of the lid may be within reach of anything the walker would
   * otherwise be stopped by. That is what moved `FORE_SCUTTLE_X` inboard, and
   * it is what this asserts directly — the walk sweep proves the behaviour,
   * this one says why, so the next fitting placed near a rail has something to
   * fail against.
   */
  it('keeps the lid out of a body’s reach of the ship’s rail', () => {
    const lid = foreScuttleLidPanel();
    const reach = DEFAULT_WALKER_TUNING.radius;
    const midX = (c: (typeof OBSTACLE_COLUMNS)[number]): number => (c.x0 + c.x1) / 2;
    const midZ = (c: (typeof OBSTACLE_COLUMNS)[number]): number => (c.z0 + c.z1) / 2;

    // **An obstacle's height is the whole obstacle's, not one column's.** The
    // index splits a tall capsule into stacked columns, so a fife-rail
    // stanchion 1.1 m high appears as several segments and the lowest of them
    // looks steppable on its own. It is not: the segments above it are still a
    // wall, and a body cannot pass. Judging a segment in isolation reported the
    // stanchion as a hazard at 13 mm inside the bound, which is a false alarm
    // about the one obstacle here that genuinely cannot be climbed.
    const topOf = new Map<string, number>();
    for (const column of OBSTACLE_COLUMNS) {
      topOf.set(column.name, Math.max(topOf.get(column.name) ?? -Infinity, column.yHi));
    }

    for (const column of OBSTACLE_COLUMNS) {
      const top = topOf.get(column.name)!;
      // Only what a body standing on the lid could be stopped by: things that
      // rise above the lid's own surface and start below its head.
      if (top <= lid.y) continue;
      if (column.yLo >= lid.y + DEFAULT_WALKER_TUNING.standingHeight) continue;
      // And only what the lid could make climbable — an obstacle whose top is
      // out of step-over range from the lid is still a wall and is not at risk.
      if (top > lid.y + DEFAULT_WALKER_TUNING.stepOver) continue;
      // **A barrier with a floor behind it is not a hazard, it is a step.**
      // The cargo hatch's coaming is 0.165 m from the lid and its top is within
      // a stride of it, so it reads as "climbable" on the arithmetic alone —
      // and stepping over it lands a body on the grating, which is a standable
      // panel at almost exactly the lid's own height. What makes the pin rail
      // different is that there is nothing behind it but the sea.
      if (fittingStandAt(midX(column), midZ(column)) !== null) continue;

      // Closest approach between the lid's rectangle and the column's segment.
      let nearest = Infinity;
      for (let t = 0; t <= 1; t += 0.05) {
        const cx = column.x0 + (column.x1 - column.x0) * t;
        const cz = column.z0 + (column.z1 - column.z0) * t;
        const dx = Math.max(lid.x0 - cx, 0, cx - lid.x1);
        const dz = Math.max(lid.z0 - cz, 0, cz - lid.z1);
        nearest = Math.min(nearest, Math.hypot(dx, dz) - column.radius);
      }
      expect(
        nearest,
        `a body standing on the fore scuttle's lid can reach ${column.name}, ` +
          'which its own height has just turned into a kerb',
      ).toBeGreaterThan(reach);
    }
  });

  /**
   * The coaming has to clear the deck's own fall, or the lid lands in a hollow.
   *
   * **0.090 m across this footprint**, measured: 53 mm of sheer along its
   * length and 39 mm of camber across its breadth, adding on a diagonal. That
   * number is the whole reason this hatch has a coaming at all — a flat cover
   * over a deck with no level rim is flush at one corner and 90 mm wrong at the
   * far one, which two earlier attempts each found from a different side.
   *
   * And the step onto it is bounded from every point of its border, which is
   * the cargo hatch's lesson: measure the height from the LOWEST point of the
   * perimeter, or some corners are further below the lid than a body can step.
   */
  it('stands its coaming clear of the deck all round, and inside a stride', () => {
    const lid = foreScuttleLidPanel();
    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      for (const [x, z] of [
        [lid.x0 + (lid.x1 - lid.x0) * t, lid.z0],
        [lid.x0 + (lid.x1 - lid.x0) * t, lid.z1],
        [lid.x0, lid.z0 + (lid.z1 - lid.z0) * t],
        [lid.x1, lid.z0 + (lid.z1 - lid.z0) * t],
      ]) {
        const deck = deckStandAt(x, z)!;
        lowest = Math.min(lowest, deck.y);
        highest = Math.max(highest, deck.y);
      }
    }
    // The fall this shape exists to cope with. Pinned, because if the deck ever
    // flattens here the coaming stops being necessary and someone should know.
    expect(highest - lowest).toBeGreaterThan(0.05);
    // Proud of the planking everywhere: no corner of the lid is in a hollow.
    expect(lid.y).toBeGreaterThan(highest);
    // And reachable from every point of its border.
    expect(
      lid.y - lowest,
      'the tallest step onto the lid is beyond the walker’s stride',
    ).toBeLessThanOrEqual(DEFAULT_WALKER_TUNING.stepUp);
  });

  /**
   * Shut, the gangway is whole; open, the planking is gone and what is under
   * you is the ladder.
   *
   * **Asserted as "what kind of surface", not "how far down".** It used to say
   * the open surface was 0.2 m below the shut one, which was true while the
   * ladder stood hard against the after bulkhead and its top rung was well
   * below the deck. Giving the ladder its toe room moved the rungs under the
   * scuttle's centre, where the top one is level with the planking by
   * construction — so the height gap vanished and a passing test failed for a
   * reason that had nothing to do with what it was guarding. The claim that
   * survives a ladder moving is that the thing underfoot changed from a lid to
   * a rung.
   */
  it('withdraws the deck only when the lid is up', () => {
    const reach = deckStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z)!.y + 1;

    resetClosures();
    expect(inForeScuttle(FORE_SCUTTLE_X, FORE_SCUTTLE_Z)).toBe(true);
    const shut = schoonerStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z, reach)!;
    expect(shut.y).toBeCloseTo(foreScuttleLidPanel().y, 6);
    expect(shut.climbable ?? false, 'a shut lid is not something you climb').toBe(false);

    setClosureOpen('foreScuttleLid', true);
    const open = schoonerStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z, reach)!;
    expect(open.y).toBeLessThan(shut.y - 1e-6);
    expect(open.climbable, 'an open scuttle puts a rung underfoot').toBe(true);
    // And the sky over it, which is what makes it a scuttle rather than a
    // hatchway between two decks.
    expect(open.ceilingY).toBe(Infinity);
    resetClosures();
  });

  /**
   * The standing lid is the one part of this that is meant to be in the way.
   *
   * Ash asked whether it sticks up like a door, and it does. What that has to
   * mean mechanically is that it is over the step-over height — otherwise it is
   * a decoration the player walks through, and "shut it if you want to get
   * past" stops being a real choice.
   */
  it('stands the open lid up as a real obstacle, hinged forward', () => {
    const open = foreScuttleLid(true).solids.filter((s) => s.material === 'timber');
    expect(open).toHaveLength(1);
    const panel = open[0];
    expect(panel.kind).toBe('box');
    if (panel.kind !== 'box') return;

    const deck = deckStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z)!;
    expect(panel.centre.y + panel.half.y - deck.y).toBeGreaterThan(
      DEFAULT_WALKER_TUNING.stepOver,
    );
    expect(panel.collides).toBe(true);
    // Hinged on the forward edge: a sea over the bow shuts it rather than
    // taking it off. So the standing panel is over the forward coaming, which
    // is outboard of the hole's own forward edge by the coaming's thickness.
    expect(panel.centre.z).toBeGreaterThan(scuttle.zForward);
    expect(panel.centre.z - scuttle.zForward).toBeLessThan(0.1);
    // Thin in z, tall in y — it is on end, not lying down.
    expect(panel.half.z).toBeLessThan(panel.half.y);
  });

  /** Every rung reachable from the one below it, and from the sole. */
  it('gives the forecastle a ladder a body can actually climb', () => {
    const rise = foreScuttleLadderRise();
    expect(rise).toBeGreaterThan(0.2);
    expect(
      rise,
      'a rung out of reach of the one below it is a ladder only the top of which works',
    ).toBeLessThanOrEqual(DEFAULT_WALKER_TUNING.stepUp);

    // It spans the whole drop: foot on the sole, head at the planking.
    expect(foreScuttleLadderFootY()).toBeCloseTo(belowDecksSpace('forecastle').soleY, 6);
    const head = foreScuttleLadderHeadY();
    expect(head).toBeCloseTo(deckStandAt(FORE_SCUTTLE_X, FORE_SCUTTLE_LADDER_Z_FORWARD)!.y, 1);

    // And the rungs are inside the hole they serve, not under solid planking.
    for (const rung of FORE_SCUTTLE_LADDER_PANELS) {
      expect(rung.z0).toBeGreaterThanOrEqual(scuttle.zAft - 1e-9);
      expect(rung.z1).toBeLessThanOrEqual(scuttle.zForward + 1e-9);
      expect(inForeScuttle((rung.x0 + rung.x1) / 2, (rung.z0 + rung.z1) / 2)).toBe(true);
    }
  });

  it('draws compact rungs inside a forgiving climb envelope', () => {
    const fitting = foreScuttleLadder();
    const rungs = fitting.solids.filter(
      (solid) =>
        solid.kind === 'box' &&
        Math.abs(solid.half.y * 2 - FORE_SCUTTLE_RUNG_THICKNESS) < 1e-9,
    );
    expect(rungs).toHaveLength(FORE_SCUTTLE_LADDER_PANELS.length);
    for (const rung of rungs) {
      if (rung.kind !== 'box') continue;
      expect(rung.half.z * 2).toBeCloseTo(FORE_SCUTTLE_RUNG_DEPTH, 9);
      expect(rung.half.z * 2).toBeLessThan(0.1);
      expect(rung.half.y * 2).toBeLessThan(0.05);
    }

    // Collision acquisition stays broad enough for a 0.52 m body even though
    // the timber no longer looks like a stack of 0.32 m-deep shelves.
    const lower = FORE_SCUTTLE_LADDER_PANELS[0];
    expect(lower.z1 - lower.z0).toBeGreaterThan(FORE_SCUTTLE_RUNG_DEPTH * 4);
  });

  it('lets a held-forward climb leave the scuttle onto deck', () => {
    setClosureOpen('foreScuttleLid', true);
    try {
      const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
      const forecastle = belowDecksSpace('forecastle');
      expect(
        walker.placeAt(FORE_SCUTTLE_X, FORE_SCUTTLE_Z + 0.3, forecastle.soleY),
      ).toBe(true);

      let reachedDeck = false;
      let lowestAfterDeck = Infinity;
      for (let frame = 0; frame < 360; frame++) {
        walker.step(1 / 120, { forward: 1, right: 0, yaw: 0 });
        if (walker.y > 3.8) reachedDeck = true;
        if (reachedDeck) lowestAfterDeck = Math.min(lowestAfterDeck, walker.y);
      }

      expect(reachedDeck, 'the body never got out of the scuttle').toBe(true);
      expect(lowestAfterDeck, 'the body fell back through the open scuttle').toBeGreaterThan(3.7);
      expect(walker.y).toBeGreaterThan(3.8);
      expect(walker.z).toBeLessThan(FORE_SCUTTLE_Z - FORE_SCUTTLE_HALF_BREADTH);

      // The top rung's non-visual transfer zone reaches the deck edge; without
      // it forward input leaves the ladder just before the deck is reachable.
      const top = FORE_SCUTTLE_LADDER_PANELS[FORE_SCUTTLE_LADDER_PANELS.length - 1];
      expect(top.z0).toBeCloseTo(FORE_SCUTTLE_Z - FORE_SCUTTLE_HALF_BREADTH, 9);
    } finally {
      resetClosures();
    }
  });

  /**
   * **A ladder published through a shut lid is a body climbing out through
   * 50 mm of oak.** The hold's ladder learned this one the hard way; this is
   * the same guard for the second one.
   */
  it('publishes no rung while the lid is down', () => {
    const rung = FORE_SCUTTLE_LADDER_PANELS[0];
    const x = (rung.x0 + rung.x1) / 2;
    const z = (rung.z0 + rung.z1) / 2;

    resetClosures();
    const shut = schoonerStandAt(x, z, rung.y + 0.1);
    expect(shut!.y).not.toBeCloseTo(rung.y, 6);

    setClosureOpen('foreScuttleLid', true);
    const open = schoonerStandAt(x, z, rung.y + 0.1);
    expect(open!.y).toBeCloseTo(rung.y, 6);
    resetClosures();
  });

  /**
   * A body on this ladder has open sky over it, which is what makes it a
   * scuttle rather than a hatchway between two decks. The hold's ladder carries
   * the shaft's ceiling for the opposite reason and it is worth not confusing
   * the two: the walker straightens up as it climbs out of the forecastle, and
   * stays ducked climbing out of the hold.
   */
  it('gives the ladder open sky, so the walker stands up as it climbs', () => {
    setClosureOpen('foreScuttleLid', true);
    for (const rung of FORE_SCUTTLE_LADDER_PANELS) {
      const stand = schoonerStandAt(
        (rung.x0 + rung.x1) / 2,
        (rung.z0 + rung.z1) / 2,
        rung.y + 0.1,
      )!;
      if (Math.abs(stand.y - rung.y) > 1e-6) continue;
      expect(stand.ceilingY).toBe(Infinity);
    }
    resetClosures();
  });
});
