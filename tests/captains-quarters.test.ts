import { describe, expect, it } from 'vitest';
import { DEFAULT_WALKER_TUNING } from '../src/player/DeckWalker';
import {
  CABIN_LINING_THICKNESS,
  STERN_WINDOWS,
  belowDecksSpace,
  spaceDeckheadY,
  spaceSideHalfWidthAt,
  sternLiningHalfWidthAt,
  sternLiningZAt,
} from '../src/vessel/schooner/deckInterior';
import { chartDesk } from '../src/vessel/schooner/captainsDesk';
import {
  addCabinFloorcloth,
  cabinFloorclothPlan,
} from '../src/vessel/schooner/cabinJoinery';
import {
  bookShelf,
  boxBerth,
  boxBerthGeometry,
  cabinTellTaleCompass,
  captainSeaChest,
  hangingLocker,
  sternLockerFrontZ,
  sternLockerPort,
  sternLockerStarboard,
  washstand,
} from '../src/vessel/schooner/cabinFurniture';
import { deskItems } from '../src/vessel/schooner/deskItems';
import { boxCorners } from '../src/vessel/schooner/deckFittings';
import type { FittingSolid } from '../src/vessel/schooner/deckFittings';
import type { InteriorFitting } from '../src/vessel/schooner/roomFitting';
import { buildInteriorFittingGeometry } from '../src/vessel/schooner/interiorFittingGeometry';
import { SurfaceBuilder } from '../src/vessel/schooner/shipwright';

/**
 * The captain's quarters: the berth, the stern lockers, the washstand, the
 * press, the shelf — and the two rules a room full of built-in joinery has to
 * keep that a room with one desk in it did not.
 *
 * **The two faults this file exists to catch are both invisible in a render.**
 *
 * The first is joinery that has quietly gone through the ship. Every piece in
 * here is fitted against a side that leans and tapers, and the honest way to fit
 * one is to ask the hull for its own width — but a piece that spans two stations
 * has *two* answers, and taking the wrong one puts timber inside the planking.
 * The berth did exactly that while it was being built: its bunk bottom ran the
 * full length at the wider bay's width and stood 92 mm outboard of the frames at
 * the head. It looked perfect from inside the room, because the part that was
 * wrong was behind the mattress and inside the lining.
 *
 * The second is a claim in a comment. `INTERIOR_FITTING_KINDS` now carries nine
 * paragraphs of reasoning about what collides and why, and every one of them is
 * a statement about a number — "above the step-over", "inside the other's
 * shadow". Those go stale silently. The suite that checks them is worth more
 * than the prose is.
 */

const cabin = belowDecksSpace('cabin');
const t = DEFAULT_WALKER_TUNING;

/**
 * Every corner a solid occupies **in the ship**, boxes and bars alike.
 *
 * **Through `boxCorners`, which knows about the yaw.** This file first unpacked
 * a box by hand as centre ± half, which was correct for exactly as long as the
 * cabin's furniture was square with the keel. Turning the berth made every
 * assertion in here quietly understate where its timber was — and understate it
 * in the direction that passes. `FittingSolid`'s own note says it: no reader
 * unpacks a box by hand, because a reader that forgets the yaw has to have
 * written the trigonometry itself.
 */
function cornersOf(solid: FittingSolid): Array<{ x: number; y: number; z: number }> {
  if (solid.kind === 'box') return boxCorners(solid);
  const dx = solid.b.x - solid.a.x;
  const dy = solid.b.y - solid.a.y;
  const dz = solid.b.z - solid.a.z;
  const length = Math.hypot(dx, dy, dz);
  const unit = length > 1e-9 ? { x: dx / length, y: dy / length, z: dz / length } : null;
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (const [end, radius] of [
    [solid.a, solid.radiusA],
    [solid.b, solid.radiusB],
  ] as const) {
    // A tube's cap is perpendicular to its axis. Expanding every coordinate by
    // the full radius treats a vertical compass case as a sphere and puts its
    // top one radius through the deckhead; project the cap onto each ship axis
    // instead. A zero-length bar is the one case that really is sphere-like.
    const extent = unit
      ? {
          x: radius * Math.sqrt(Math.max(0, 1 - unit.x * unit.x)),
          y: radius * Math.sqrt(Math.max(0, 1 - unit.y * unit.y)),
          z: radius * Math.sqrt(Math.max(0, 1 - unit.z * unit.z)),
        }
      : { x: radius, y: radius, z: radius };
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          points.push({
            x: end.x + sx * extent.x,
            y: end.y + sy * extent.y,
            z: end.z + sz * extent.z,
          });
        }
      }
    }
  }
  return points;
}

/** The furthest inboard any of a fitting's timber reaches, in the ship. */
function inboardReach(fitting: InteriorFitting, hand: 'port' | 'starboard'): number {
  const xs = fitting.solids.flatMap((s) => cornersOf(s).map((p) => p.x));
  return hand === 'port' ? Math.min(...xs) : Math.max(...xs);
}

const QUARTERS: readonly InteriorFitting[] = [
  sternLockerPort(),
  sternLockerStarboard(),
  boxBerth(),
  washstand(),
  hangingLocker(),
  captainSeaChest(),
  cabinTellTaleCompass(),
  bookShelf(),
];

describe('the captain\'s painted floorcloth', () => {
  it('is one worn red canvas field, not an alternating chequer', () => {
    const builder = new SurfaceBuilder();
    addCabinFloorcloth(builder, () => 0.5);
    const geometry = builder.toGeometry();
    const position = geometry.getAttribute('position');
    const colour = geometry.getAttribute('color');
    const plan = cabinFloorclothPlan();
    const reds: number[] = [];

    // Sample the interior grid only. Hems, seam and tack heads are deliberately
    // dark construction details; the field inside them is the painted canvas
    // whose hue must not lapse back into the old light/dark checkerboard.
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      if (
        Math.abs(y - plan.y) > 1e-5 ||
        x <= plan.xLo + 0.01 ||
        x >= plan.xHi - 0.01
      ) {
        continue;
      }
      const r = colour.getX(i);
      const g = colour.getY(i);
      const b = colour.getZ(i);
      expect(r).toBeGreaterThan(g * 2);
      expect(r).toBeGreaterThan(b * 2.5);
      reds.push(r);
    }

    expect(reds).toHaveLength(24);
    // The central walking track is browner than the edges, so this is canvas
    // worn by boots rather than a perfectly flat red rectangle.
    expect(Math.max(...reds) - Math.min(...reds)).toBeGreaterThan(0.002);
    geometry.dispose();
  });
});

describe('the captain’s quarters are inside the ship', () => {
  it('keeps every piece of furniture within the lining and under the beams', () => {
    // **The one that caught the berth.** Sampled at the corners, because a
    // corner is where a straight piece against a curved side goes through it —
    // the middle of the same board is comfortably clear, which is exactly why
    // this is invisible from inside the room.
    //
    // The tolerance is 5 mm, and it is a tolerance rather than zero for one
    // reason: `sideLimitOver` resolves a piece's width by sampling a 9 × 9 grid
    // over its footprint, so a piece fitted to a curve can miss the true minimum
    // by a fraction of a millimetre between samples. Five is far inside
    // `CABIN_LINING_THICKNESS`, so anything that passes here is buried in the
    // lining rather than showing through the planking.
    const slack = 0.005;
    for (const fitting of QUARTERS) {
      for (let i = 0; i < fitting.solids.length; i++) {
        for (const p of cornersOf(fitting.solids[i])) {
          const where = `${fitting.name}[${i}]`;
          expect(p.y, `${where} is below the sole`).toBeGreaterThanOrEqual(cabin.soleY - 1e-6);

          // The after lining rakes, so a piece may legitimately stand abaft the
          // sole's own edge — the stern lockers' lids do, to roof the wedge the
          // rake opens behind them.
          //
          // **The line it may not cross is the moulded transom, not the lining**,
          // and the difference is a lesson this round learned by writing the
          // test the other way first. A square-cut edge scribed to a leaning
          // wall is buried at one end of that edge and gapped at the other;
          // buried is the right choice and the whole ship is built that way, so
          // a check against the lining's own face fails every correctly-fitted
          // piece on this wall. What actually matters is the 60 mm of lining
          // behind it: inside that, timber is hidden; outside it, timber is
          // through the planking and in the sea.
          const zAftLimit = Math.min(cabin.zAft, sternLiningZAt(p.y)) - CABIN_LINING_THICKNESS;
          expect(p.z, `${where} is through the transom`).toBeGreaterThanOrEqual(
            zAftLimit - slack,
          );
          expect(p.z, `${where} is forward of the room`).toBeLessThanOrEqual(
            cabin.zForward + slack,
          );

          const z = Math.min(Math.max(p.z, cabin.zAft), cabin.zForward);
          const half =
            p.z < cabin.zAft
              ? sternLiningHalfWidthAt(p.y)
              : spaceSideHalfWidthAt(cabin, z, p.y, false);
          expect(Math.abs(p.x), `${where} is outboard of the lining`).toBeLessThanOrEqual(
            half + slack,
          );

          const head = spaceDeckheadY(cabin, Math.sign(p.x) * Math.min(Math.abs(p.x), half), z);
          if (head !== null) {
            expect(p.y, `${where} is through the deckhead`).toBeLessThanOrEqual(head + slack);
          }
        }
      }
    }
  });

  it('leaves a lane down the middle wider than the body that has to use it', () => {
    // §4.1's whole argument for this arrangement is that the centreline is the
    // route from the door to the stern windows and is kept clear. Furniture is
    // added a piece at a time and each piece is individually reasonable; the
    // room getting impassable is what happens between two of them, and nothing
    // in either piece's own placement can see it.
    // **Measured in the ship, off the drawn timber, and not off the published
    // faces.** `chartDeskGeometry().xInboard` and `boxBerthGeometry().xInboard`
    // are each true in their *own* piece's frame, and since the round that
    // turned the furniture those are two different frames — subtracting one from
    // the other is an answer to no question at all. What a body has to get
    // through is the gap between the nearest actual timber on each hand.
    const deskInboard = inboardReach(chartDesk(), 'port');
    const berthInboard = inboardReach(boxBerth(), 'starboard');
    expect(deskInboard - berthInboard).toBeGreaterThan(t.radius * 2 + 0.2);

    // And the same question at the forward end, where the press faces the
    // washstand across the room.
    const pressInboard = inboardReach(hangingLocker(), 'port');
    const standInboard = inboardReach(washstand(), 'starboard');
    expect(pressInboard - standInboard).toBeGreaterThan(t.radius * 2 + 0.2);
  });

  it('draws the wash basin as an open concave bowl, not a capped pale solid', () => {
    const stand = washstand();
    const basin = stand.solids.find(
      (solid) => solid.kind === 'bar' && solid.profile === 'open-bowl',
    );
    expect(basin, 'washstand has no open-bowl basin').toBeDefined();
    if (!basin || basin.kind !== 'bar') return;
    expect(basin.collides).toBe(false);

    const geometry = buildInteriorFittingGeometry().geometries.get('paper');
    expect(geometry, 'paper fitting geometry is absent').toBeDefined();
    if (!geometry) return;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const centreX = basin.a.x;
    const centreZ = basin.a.z;
    const bottomY = Math.min(basin.a.y, basin.b.y);
    const rimY = Math.max(basin.a.y, basin.b.y);

    let nearestAtMouth = Infinity;
    let inwardFacingCavityVertices = 0;
    for (let i = 0; i < position.count; i++) {
      const dx = position.getX(i) - centreX;
      const dz = position.getZ(i) - centreZ;
      const radius = Math.hypot(dx, dz);
      const y = position.getY(i);
      if (radius > basin.radiusB + 0.01) continue;
      if (y > rimY - 0.008) nearestAtMouth = Math.min(nearestAtMouth, radius);
      if (
        radius > 0.03 &&
        radius < basin.radiusB - 0.01 &&
        y > bottomY + 0.018 &&
        y < rimY - 0.008
      ) {
        const radialDot =
          (normal.getX(i) * dx + normal.getZ(i) * dz) / radius;
        if (radialDot < -0.2 && normal.getY(i) > 0.05) {
          inwardFacingCavityVertices++;
        }
      }
    }
    // A capped tube has vertices/triangles across the whole mouth. The bowl's
    // nearest top vertex is its inner lip, leaving most of the mouth empty.
    expect(nearestAtMouth).toBeGreaterThan(basin.radiusB * 0.82);
    expect(inwardFacingCavityVertices).toBeGreaterThan(8);
  });

  it('does not let two pieces stand in the same place', () => {
    // Every piece here is placed off a *different* datum — the lockers off the
    // after lining, the berth off the lockers, the shelf off the berth, the
    // press and the stand off the forward bulkhead — which is the doctrine, and
    // which means no one of them can see the others. This is the check that they
    // add up.
    const boxes = QUARTERS.map((fitting) => {
      const points = fitting.solids.flatMap(cornersOf);
      return {
        name: fitting.name,
        xLo: Math.min(...points.map((p) => p.x)),
        xHi: Math.max(...points.map((p) => p.x)),
        yLo: Math.min(...points.map((p) => p.y)),
        yHi: Math.max(...points.map((p) => p.y)),
        zLo: Math.min(...points.map((p) => p.z)),
        zHi: Math.max(...points.map((p) => p.z)),
      };
    });
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        // The shelf hangs over the berth on purpose, and is the one pair that
        // is *meant* to share a footprint. It is excused by name rather than by
        // a tolerance, so a second overlap cannot hide behind the first.
        if (a.name === 'bookShelf' || b.name === 'bookShelf') continue;
        const overlaps =
          a.xLo < b.xHi - 1e-6 &&
          b.xLo < a.xHi - 1e-6 &&
          a.yLo < b.yHi - 1e-6 &&
          b.yLo < a.yHi - 1e-6 &&
          a.zLo < b.zHi - 1e-6 &&
          b.zLo < a.zHi - 1e-6;
        expect(overlaps, `${a.name} and ${b.name} occupy the same space`).toBe(false);
      }
    }
  });
});

/**
 * Would a body standing on the cabin sole actually be stopped by this?
 *
 * **`DeckWalker.step`'s own predicate, not a paraphrase of it.** The walker
 * discards a column whose top is within its step-over of its feet, and one whose
 * bottom is above its head; anything left is a wall. Writing that out here
 * rather than asserting "the top is above 0.40" matters, because the intuitive
 * version of this test — *the collider must reach the floor* — is simply false
 * and it took a failing assertion to notice. The berth's carcase starts 75 mm up
 * at the top of its plinth, exactly as the chart desk's does, and it stops a
 * body perfectly well: a walker is a 1.75 m cylinder standing on the sole, so
 * anything overlapping that cylinder blocks it, floor contact or no.
 */
function stopsABody(fitting: InteriorFitting): boolean {
  const feet = cabin.soleY;
  return fitting.solids
    .filter((s) => s.collides)
    .some((s) => {
      const ys = cornersOf(s).map((p) => p.y);
      const yLo = Math.min(...ys);
      const yHi = Math.max(...ys);
      return yHi > feet + t.stepOver && yLo < feet + t.standingHeight;
    });
}

describe('the quarters hold the claims their reasons make', () => {
  it('makes the stern lockers a wall rather than a kerb', () => {
    // `INTERIOR_FITTING_KINDS.sternLocker` claims the lid is over the walker's
    // step-over, so a body meets the lockers instead of striding onto them. It
    // is 0.48 against 0.40 — 80 mm of margin, which is exactly the sort of
    // number that gets lowered by somebody adjusting a seat height.
    for (const locker of [sternLockerPort(), sternLockerStarboard()]) {
      expect(locker.solids.some((s) => s.collides)).toBe(true);
      expect(stopsABody(locker), `${locker.name} can be walked through`).toBe(true);
      expect(locker.standable).toBeNull();
    }
  });

  it('makes the berth something a body meets rather than climbs', () => {
    const berth = boxBerth();
    expect(stopsABody(berth)).toBe(true);
    // Nothing above the bunk boards is a collider: the bedding, the curtain and
    // its rail are all inside the carcase's shadow, and a collider there would
    // be a mattress you bounce off.
    const berthGeometry = boxBerthGeometry();
    for (const solid of berth.solids.filter((s) => s.collides)) {
      const top = Math.max(...cornersOf(solid).map((p) => p.y));
      expect(top).toBeLessThanOrEqual(berthGeometry.shelfY + BERTH_LEE_BOARD_MAX + 1e-6);
    }
    expect(berth.standable).toBeNull();
  });

  it('makes the sea chest secured furniture rather than a convenient stair', () => {
    const chest = captainSeaChest();
    expect(stopsABody(chest)).toBe(true);
    expect(chest.standable).toBeNull();
    expect(chest.solids.some((solid) => solid.material === 'leather')).toBe(true);
    expect(chest.solids.some((solid) => solid.material === 'brass')).toBe(true);
  });

  it('keeps the tell-tale compass above a standing head', () => {
    const compass = cabinTellTaleCompass();
    const lowest = Math.min(...compass.solids.flatMap((solid) => cornersOf(solid).map((p) => p.y)));
    expect(lowest).toBeGreaterThan(cabin.soleY + t.standingHeight);
    expect(compass.solids.every((solid) => !solid.collides)).toBe(true);
    expect(compass.standable).toBeNull();
  });

  it('puts the bookshelf out of reach rather than out of the way', () => {
    // `INTERIOR_FITTING_KINDS.bookShelf` claims the shelf needs no collider
    // because the berth stops a body long before it. The claim is about *reach*,
    // and the first version of that comment got it wrong by talking about
    // footprints — the shelf is 9 mm wider than the berth. This is the arithmetic
    // the reason actually rests on.
    const shelf = bookShelf();
    for (const solid of shelf.solids) {
      expect(solid.collides).toBe(false);
    }
    // Both in the ship, both off the drawn timber. A body cannot bring its
    // centre within its own radius of the bunk front, and the shelf is a good
    // deal further outboard than that again.
    const bunkFront = inboardReach(boxBerth(), 'starboard');
    const nearest = inboardReach(shelf, 'starboard');
    const closestBodyCentre = bunkFront + t.radius;
    expect(closestBodyCentre - nearest).toBeGreaterThan(t.radius);
  });

  it('hangs the shelf over the berth’s foot, not over the pillow', () => {
    // The head is aft, which is where the pillow is; the shelf's underside is
    // half a metre over the mattress and a man sitting up is taller than that.
    // So it is a fact about which end it is over, and that fact is load-bearing.
    const berth = boxBerthGeometry();
    const shelf = bookShelf();
    const aftmost = Math.min(...shelf.solids.flatMap((s) => cornersOf(s).map((p) => p.z)));
    // The berth's pivot is the middle of its footprint in the ship, which is the
    // one station of the bed that means the same thing in both frames.
    expect(aftmost).toBeGreaterThan(berth.frame.pivotZ);
  });
});

/** The lee board is the highest collidable timber on the berth: 0.24 m of it. */
const BERTH_LEE_BOARD_MAX = 0.24;

describe('the after bulkhead is joinery rather than bare hull', () => {
  it('leaves the panelled band between the lockers and the lights', () => {
    // The band is asked of the lockers at the bottom and of the windows at the
    // top. Both ends have moved once already this round; what this asserts is
    // that they are still asked rather than remembered — a dado that starts
    // below the locker lids is panelling nobody can see, and one that runs up
    // past the sills is panelling through a window.
    const lockerTop = Math.max(
      ...sternLockerPort()
        .solids.filter((s) => s.collides)
        .flatMap((s) => cornersOf(s).map((p) => p.y)),
    );
    const sill = STERN_WINDOWS[0].y - STERN_WINDOWS[0].halfHeight;
    expect(sill).toBeGreaterThan(lockerTop + 0.2);
  });

  it('keeps the lockers clear of the rudder trunk and clear of the berth', () => {
    // Three things meet in the after corner of this room and none of them knows
    // about the other two: the trunk comes up where the rudder stock is, the
    // lockers are fitted either side of it, and the berth starts forward of
    // them. This is where that arithmetic is checked.
    const port = sternLockerPort();
    const inboard = Math.min(...port.solids.flatMap((s) => cornersOf(s).map((p) => p.x)));
    expect(inboard).toBeGreaterThan(RUDDER_TRUNK_HALF + 1e-6);

    const berth = boxBerthGeometry();
    const lockerFront = Math.max(
      ...port.solids.flatMap((s) => cornersOf(s).map((p) => p.z)),
    );
    expect(berth.zAft).toBeGreaterThanOrEqual(lockerFront - 1e-6);
    expect(sternLockerFrontZ()).toBeLessThan(berth.zAft);
  });
});

const RUDDER_TRUNK_HALF = 0.15;

describe('the chronometer', () => {
  it('is on the desk, openable, and made of what the desk can place', () => {
    const item = deskItems().find((entry) => entry.name === 'chronometer');
    expect(item, 'the chronometer is not on the desk').toBeTruthy();
    expect(item!.view).toBe('chronometer');
    // This vessel predates the standard three-tier boxed chronometer. The
    // instrument is a Kendall-like large round watch in a shallow fitted case:
    // boxes make the case, vertical bars make the capped watch and enamel dial.
    expect(item!.solids.some((solid) => solid.kind === 'box')).toBe(true);
    expect(item!.solids.some((solid) => solid.kind === 'bar')).toBe(true);
    // The pale face and metal pair-case are the whole reason the instrument is
    // visible against a dark case and desk.
    expect(item!.solids.some((s) => s.material === 'paper')).toBe(true);
    expect(item!.solids.some((s) => s.material === 'brass')).toBe(true);
    expect(item!.label).toMatch(/timekeeper/i);
  });
});
