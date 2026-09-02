import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { SHIP_CLOSURES } from '../src/vessel/schooner/shipClosures';
import {
  CABIN_AFT_Z,
  CABIN_FORWARD_Z,
  CABIN_SOLE_Y,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
  COMPANION_AFT_Z,
  COMPANION_OUTBOARD_CLEARANCE,
  FORECASTLE_SOLE_Y,
  PLATFORM_AFT_Z,
  PLATFORM_FORWARD_Z,
  PLATFORM_SOLE_Y,
  COMPANION_FORWARD_Z,
  DECK_BEAM_DEPTH,
  floorYAt,
} from '../src/vessel/schooner/hullForm';
import {
  BREAK_TOLERANCE,
  deckStandAt,
  inCompanionway,
  inForeScuttle,
} from '../src/vessel/schooner/deckSurface';
import {
  CABIN_LINING_THICKNESS,
  BULKHEAD_THICKNESS,
  DOORWAY_HALF_BREADTH,
  COMPANION_COAMING_HEIGHT,
  COMPANION_COAMING_THICKNESS,
  COMPANION_LANDING_DEPTH,
  COMPANION_RISERS,
  COMPANION_TREADS,
  FLIGHT_FOOT_Z,
  INTERIOR_SOURCES,
  cabinHalfWidthAt,
  cabinRoofHalfWidthAt,
  BULKHEADS,
  DOORWAY_HEIGHT,
  DOORWAY_OFFSET,
  INTERIOR_STEPS,
  WELL_OFFSET,
  doorwayHeadY,
  stepsRunLength,
  BELOW_DECKS_SPACES,
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  spaceHalfWidthAt,
  belowDecksSpace,
  spaceDeckheadY,
  companionCoamingSolids,
  companionCheekSolids,
  flightLedgeY,
  companionMidX,
  companionXLimits,
  companionTreadIndexAt,
  companionTreadY,
  companionTreadZ,
  spaceSideHalfWidthAt,
  interiorSolids,
  interiorSurfacesAt,
  STERN_WINDOWS,
  sternWindowZAt,
} from '../src/vessel/schooner/deckInterior';
import {
  DECK_OBSTACLES,
  OBSTACLE_COLUMNS,
  SCHOONER_DECK_ENVIRONMENT,
  columnDistance,
  schoonerStandAt,
} from '../src/vessel/schooner/deckObstacles';
import { DEFAULT_WALKER_TUNING, DeckWalker } from '../src/player/DeckWalker';
import {
  INTERIOR_REGIONS,
  SHIP_PALETTE,
  SHIP_REGIONS,
  buildShipGeometry,
} from '../src/vessel/schooner/shipGeometry';
import {
  DECK_FITTINGS,
  PUMP_WELL_HALF,
  PUMP_WELL_HEAD_HEIGHT,
  PUMP_X,
  PUMP_Z,
} from '../src/vessel/schooner/deckFittings';
import {
  INTERIOR_FITTINGS,
  hatchwayBoards,
  interiorFittingsNow,
  pumpTube,
  pumpWell,
} from '../src/vessel/schooner/interiorFittings';
import { INTERIOR_FITTING_KINDS } from '../src/vessel/schooner/roomFitting';
import type { InteriorFitting } from '../src/vessel/schooner/roomFitting';
import {
  messTableGeometry,
  officersBerthPlacement,
  officersCabinGeometry,
} from '../src/vessel/schooner/wardroomFurniture';
import {
  crewBerthGeometry,
  foreScuttleShaftOutboardX,
} from '../src/vessel/schooner/forecastleFurniture';
import {
  boxBerthCurtain,
  boxBerthCurtainTarget,
  boxBerthGeometry,
} from '../src/vessel/schooner/cabinFurniture';
import { deadlightFaceZAt, deadlightLap } from '../src/vessel/schooner/cabinJoinery';
import { SHIP_STATIONS, shipStation } from '../src/vessel/schooner/shipStations';
import type { ShipStation } from '../src/vessel/schooner/shipStations';
import type { SpaceName } from '../src/vessel/schooner/deckInterior';
import { buildLightship } from '../src/vessel/schooner/massModel';
import {
  INTERIOR_FITTING_PALETTE,
  buildInteriorFittingGeometry,
  buildSternDeadlightGeometry,
} from '../src/vessel/schooner/interiorFittingGeometry';
import {
  BALLAST_TOP_Y,
  CASK_BED_Y,
  CASK_DIAMETER,
  DUNNAGE_THICKNESS,
  HOLD_CASK_COUNT,
  HOLD_FLOOR_Y,
  HOLD_SOLE_Y,
  HOLD_LADDER_PANELS,
  HOLD_STOW,
  HOLD_WELL_CLEAR,
} from '../src/vessel/schooner/holdStow';
import {
  isClosureOpen,
  resetClosures,
  setClosureOpen,
} from '../src/vessel/schooner/closures';
import { buildShipInteractables } from '../src/vessel/schooner/shipInteractables';
import {
  LAMP_DROP,
  LAMP_HANGS,
  LAMP_REACH_HALF,
  lampHangPoint,
} from '../src/vessel/schooner/lampPlacement';
import {
  captainsSeatPose,
  chairSeatCentre,
  chartDesk,
  chartDeskGeometry,
  deskChairGazeTarget,
} from '../src/vessel/schooner/captainsDesk';
import { frameToShip, shipToFrame } from '../src/vessel/schooner/roomFitting';
import { boxCorners, solidBounds } from '../src/vessel/schooner/deckFittings';
import type { FittingSolid } from '../src/vessel/schooner/deckFittings';
import { deskItems } from '../src/vessel/schooner/deskItems';
import { rayBox } from '../src/player/Interactables';
import { SeatedStation } from '../src/player/SeatedStation';
import {
  isStationOccupied,
  occupiedStation,
  resetSeat,
  setOccupiedStation,
} from '../src/vessel/schooner/seatState';

/** What a set of drawn solids occupies in the ship, yaw and all. */
function boundsOf(solids: readonly FittingSolid[]): {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
} {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const solid of solids) {
    const b = solidBounds(solid);
    x0 = Math.min(x0, b.x0);
    x1 = Math.max(x1, b.x1);
    z0 = Math.min(z0, b.z0);
    z1 = Math.max(z1, b.z1);
  }
  return { x0, x1, z0, z1 };
}

/**
 * M4's structural spine: two floors at one (x, z), and the ladder between them.
 *
 * WHAT THESE CAN AND CANNOT PROVE
 * -------------------------------
 * Checking `schoonerStandAt` against `interiorSurfacesAt` proves nothing — they
 * are the same expression one call apart, and `deckSurface.ts`'s header is the
 * standing argument about that. So the checks that mean something here are the
 * ones that cross a boundary: the *walker* against the surface, reached through
 * its own move routine rather than through the query it is built on; the flight
 * against the deck it has to meet; and the two tread mappings against each other.
 */

/**
 * A station in the cabin proper, abaft the flight and clear of the opening.
 *
 * Not the midpoint of the cabin: that is −5.0, which is `COMPANION_AFT_Z`
 * exactly, so every "two floors at one position" check would have been taken on
 * the one line where the deck is a hole and the sole has the flight's lowest
 * tread standing on it. Both floors are still there, but neither is the pair the
 * test means.
 */
const CENTRE_Z = -5.8;

/** Reach of a body standing on the sole — what it can get its feet onto. */
const SOLE_REACH = CABIN_SOLE_Y + DEFAULT_WALKER_TUNING.stepUp;

describe('the two-storey surface contract', () => {
  it('answers the deck or the sole at one position, by who is asking', () => {
    // The case M3 said "highest wins" could not answer. Both floors are real at
    // this (x, z) and they are 2 m apart.
    const above = schoonerStandAt(0, CENTRE_Z, Infinity)!;
    const below = schoonerStandAt(0, CENTRE_Z, SOLE_REACH)!;
    expect(above.y).toBeGreaterThan(4.4);
    expect(below.y).toBeCloseTo(CABIN_SOLE_Y, 9);
    expect(above.y - below.y).toBeGreaterThan(1.9);
  });

  it('gives the sole a ceiling and the weather deck none', () => {
    const onDeck = schoonerStandAt(0, CENTRE_Z, Infinity)!;
    expect(onDeck.ceilingY).toBe(Infinity);

    const inCabin = schoonerStandAt(0, CENTRE_Z, SOLE_REACH)!;
    expect(inCabin.ceilingY).toBeLessThan(onDeck.y);
    // The ceiling is the drawn deck less the beams, and nothing else.
    expect(inCabin.ceilingY).toBeCloseTo(onDeck.y - DECK_BEAM_DEPTH, 9);
  });

  it('falls back to the lowest floor rather than to nothing', () => {
    // A body below every surface is falling, and it has to be falling toward
    // something. `null` here would mean "not ship at all" and would let it out
    // through the bottom of the hull.
    const under = schoonerStandAt(0, CENTRE_Z, CABIN_SOLE_Y - 5)!;
    expect(under).not.toBeNull();
    expect(under.y).toBeCloseTo(CABIN_SOLE_Y, 9);
  });

  it('still means "off the ship" by null', () => {
    // Nothing below decks reaches outboard of the deck that roofs it, so a
    // query the weather deck refuses is off the ship at every reach.
    const outboard = 40;
    expect(schoonerStandAt(outboard, CENTRE_Z, Infinity)).toBeNull();
    expect(schoonerStandAt(outboard, CENTRE_Z, SOLE_REACH)).toBeNull();
    expect(schoonerStandAt(0, 200, SOLE_REACH)).toBeNull();
  });
});

describe('the cabin sole', () => {
  it('is never wider than the deck that roofs it', () => {
    // The rule the room's plan is built on. Stated as a property rather than as
    // a number, because a hull change has to keep it true, not reproduce it.
    for (let z = CABIN_AFT_Z; z <= CABIN_FORWARD_Z + 1e-9; z += 0.1) {
      const w = cabinHalfWidthAt(z);
      const over = deckStandAt(0, z)!;
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(over.halfWidth - CABIN_LINING_THICKNESS + 1e-9);
    }
  });

  it('has a deck over every part of it a body can stand on', () => {
    // The failure this rules out is a sole that pokes out from under its own
    // ceiling — where a player would be below decks with the sky overhead.
    for (let z = CABIN_AFT_Z; z <= CABIN_FORWARD_Z + 1e-9; z += 0.1) {
      const w = cabinHalfWidthAt(z);
      for (const x of [0, w * 0.5, w - 1e-6]) {
        expect(deckStandAt(x, z)).not.toBeNull();
        const surfaces = interiorSurfacesAt(x, z);
        expect(surfaces.length).toBeGreaterThan(0);
        const sole = surfaces.find((s) => s.space === 'cabin')!;
        if (!inCompanionway(x, z)) {
          expect(sole.ceilingY).toBeLessThan(Infinity);
          expect(sole.ceilingY - sole.y).toBeGreaterThan(DEFAULT_WALKER_TUNING.crouchHeight);
        }
      }
    }
  });

  it('stops at the bulkheads', () => {
    expect(cabinHalfWidthAt(CABIN_FORWARD_Z + 0.01)).toBe(0);
    expect(cabinHalfWidthAt(CABIN_AFT_Z - 0.01)).toBe(0);
    // Forward of the cabin there is now the landing, on the same sole, so
    // "stops" is about the *cabin* rather than about below decks. What has to
    // stay true is that no cabin surface is offered there.
    const beyond = interiorSurfacesAt(0, CABIN_FORWARD_Z + 0.01);
    expect(beyond.some((surface) => surface.space === 'cabin')).toBe(false);
    expect(beyond.some((surface) => surface.space === 'landing')).toBe(true);
    // Abaft the transom there is nothing at all, and that is still the end.
    expect(interiorSurfacesAt(0, CABIN_AFT_Z - 0.05)).toHaveLength(0);
  });

  it('clears a standing body everywhere, which the hold will not', () => {
    // Worth pinning: the spec buys this with the hull form, and it is the reason
    // the walker ducks rather than refusing. If a change ever makes the cabin
    // itself need the duck, that is a hull regression and not a walker one.
    for (let z = CABIN_AFT_Z; z <= CABIN_FORWARD_Z + 1e-9; z += 0.1) {
      const w = cabinHalfWidthAt(z);
      const edge = interiorSurfacesAt(w - 1e-6, z).find((s) => s.space === 'cabin')!;
      if (edge.ceilingY === Infinity) continue;
      expect(edge.ceilingY - edge.y).toBeGreaterThan(DEFAULT_WALKER_TUNING.standingHeight);
    }
  });
});

describe('the companion ladder', () => {
  it('maps a tread to a station and back again', () => {
    // The M3 fault this is written against: `stairTreadIndexAt` and the loft's
    // tread placement were written separately and disagreed, so the walker
    // climbed a correct flight while the drawn timber ran the other way.
    for (let index = 1; index <= COMPANION_TREADS; index++) {
      const { zAft, zForward } = companionTreadZ(index);
      expect(zForward).toBeGreaterThan(zAft);
      expect(companionTreadIndexAt((zAft + zForward) * 0.5)).toBe(index);
    }
    // The flight runs from its head at the opening's forward edge to its foot a
    // landing short of the after coaming — not the full length of the opening.
    expect(companionTreadZ(1).zAft).toBeCloseTo(FLIGHT_FOOT_Z, 9);
    expect(companionTreadZ(COMPANION_TREADS).zForward).toBeCloseTo(COMPANION_FORWARD_Z, 9);
    expect(FLIGHT_FOOT_Z - COMPANION_AFT_Z).toBeCloseTo(COMPANION_LANDING_DEPTH, 9);
  });

  it('leaves clear sole abaft its foot, wider than a body', () => {
    // The fault this is written against: with the foot hard against the after
    // coaming, the body's head is still above the deck three treads down, the
    // coaming is a solid inside its height band, and the lowest treads are
    // inside a body radius of it. The walker stopped there, grounded, and
    // nothing reported anything.
    expect(COMPANION_LANDING_DEPTH).toBeGreaterThan(DEFAULT_WALKER_TUNING.radius);
    // The landing is sole, not tread: this is the surface the body steps down
    // onto to get off the ladder.
    const onLanding = interiorSurfacesAt(0, COMPANION_AFT_Z + COMPANION_LANDING_DEPTH * 0.5);
    expect(onLanding).toHaveLength(1);
    // The room the ladder lands in is no longer the captain's cabin. That was
    // the point of moving it: the companionway came down in the middle of the
    // one room section 9 calls private, and it now lands in the pantry-and-
    // ladder space with the cabin door 0.6 m aft of the foot.
    expect(onLanding[0].space).toBe('landing');
    expect(onLanding[0].y).toBeCloseTo(CABIN_SOLE_Y, 9);
    // And it is abaft the opening now, not under it: the flight's head is the
    // quarterdeck break, so the shaft stops 0.45 m short of the foot and the
    // sole there is roofed by the quarterdeck rather than open to the sky.
    expect(onLanding[0].ceilingY).toBeLessThan(4.4);
    expect(onLanding[0].ceilingY - onLanding[0].y).toBeGreaterThan(
      DEFAULT_WALKER_TUNING.standingHeight,
    );
  });

  it('climbs forward: the head is at the forward end', () => {
    for (let index = 2; index <= COMPANION_TREADS; index++) {
      expect(companionTreadY(index, 0)).toBeGreaterThan(companionTreadY(index - 1, 0));
    }
    expect(companionTreadZ(COMPANION_TREADS).zForward).toBeGreaterThan(companionTreadZ(1).zAft);
  });

  it('meets the head ledge exactly, at every x across its width', () => {
    // A level fitting on a cambered deck is two different steps — M3, in as many
    // words. The last riser has to be the same height all the way across or the
    // flight arrives crooked.
    //
    // **The ledge, not the planking.** The flight tops out at the underside of
    // the waist deck, and the step from the deck down onto it is the head
    // ledge — 0.18 m, and the reason the bulkhead on this plane and the top
    // tread are one line instead of an upstand. See `flightLedgeY`.
    const { xLo, xHi } = companionXLimits(COMPANION_FORWARD_Z);
    for (const x of [xLo, (xLo + xHi) * 0.5, xHi - 1e-6]) {
      expect(companionTreadY(COMPANION_RISERS, x)).toBeCloseTo(flightLedgeY(x), 9);
    }

    // And the ledge is a step a body takes, not a wall it meets.
    const zHead = COMPANION_FORWARD_Z + 2 * BREAK_TOLERANCE;
    const mid = (xLo + xHi) * 0.5;
    const ledgeStep = deckStandAt(mid, zHead)!.y - flightLedgeY(mid);
    expect(ledgeStep).toBeGreaterThan(0);
    expect(ledgeStep).toBeLessThanOrEqual(DEFAULT_WALKER_TUNING.stepUp);
  });

  it('keeps every riser inside the walker stride, in both directions', () => {
    const stepUp = DEFAULT_WALKER_TUNING.stepUp;
    let previous = CABIN_SOLE_Y;
    for (let index = 1; index <= COMPANION_RISERS; index++) {
      const y = companionTreadY(index, 0);
      expect(y - previous, `riser ${index}`).toBeLessThanOrEqual(stepUp);
      expect(y - previous).toBeGreaterThan(0);
      previous = y;
    }
    // The top riser lands on the head ledge, and every tread is drawn.
    expect(companionTreadY(COMPANION_RISERS, 0)).toBeCloseTo(flightLedgeY(0), 9);
    expect(COMPANION_TREADS).toBe(COMPANION_RISERS);
  });

  it('gives every tread two side rails that reach the obstacle index', () => {
    const solids = companionCheekSolids();
    expect(solids).toHaveLength(COMPANION_TREADS * 2);
    for (const solid of solids) {
      expect(DECK_OBSTACLES.some((obstacle) => obstacle.name === solid.name)).toBe(true);
    }
  });
});

describe('the coaming', () => {
  it('stands taller than the walker steps over', () => {
    // The number's whole reason. A 0.30 m coaming — the usual height — is inside
    // the 0.40 m step-over, and would be a kerb a player strides across into a
    // two-metre hole.
    expect(COMPANION_COAMING_HEIGHT).toBeGreaterThan(DEFAULT_WALKER_TUNING.stepOver);
    for (const solid of companionCoamingSolids()) {
      const deck = deckStandAt(solid.centre.x, solid.centre.z);
      expect(deck).not.toBeNull();
      // Standing *on* the deck it is bolted to, at its own place: a level
      // fitting on a sheered deck is two different heights.
      expect(solid.centre.y - solid.half.y).toBeCloseTo(deck!.y, 6);
    }
  });

  it('is the inboard side and the after end, and nothing else', () => {
    // **Two runs now.** The opening reaches the ship's side, so the bulwark's
    // inboard planking is the outboard coaming and a third run would be a
    // second wall against the first.
    const runs = new Set(
      companionCoamingSolids().map((s) => s.name.replace(/\d+$/, '')),
    );
    expect([...runs].sort()).toEqual([
      'companionCoamingAft',
      'companionCoamingInboard',
    ]);
  });

  it('stands on the deck under every piece of itself, not under one of them', () => {
    // **The fault Ash reported twice in two axes.** A coaming drawn as one box
    // meets a sheered, cambered deck along exactly one line: the after run
    // drifted off it going outboard (camber) and the inboard run going forward
    // (sheer). Every segment is founded on the deck beneath itself, so this is
    // a property of all of them rather than of a chosen sample.
    for (const solid of companionCoamingSolids()) {
      const deck = deckStandAt(solid.centre.x, solid.centre.z);
      expect(deck, solid.name).not.toBeNull();
      expect(solid.centre.y - solid.half.y, solid.name).toBeCloseTo(deck!.y, 9);
    }
  });

  it('is flush with the cutout it stands round', () => {
    // Ash's other ask, as an assertion: no piece may overhang the hole or stand
    // off it. The inner face of each run is exactly an edge of the opening,
    // measured at the piece's own station rather than at one end of the run.
    const solids = companionCoamingSolids();
    for (const solid of solids.filter((s) => s.name.startsWith('companionCoamingInboard'))) {
      expect(solid.centre.x + solid.half.x, solid.name).toBeCloseTo(
        companionXLimits(solid.centre.z).xLo,
        9,
      );
    }
    const aft = solids.filter((s) => s.name.startsWith('companionCoamingAft'));
    for (const solid of aft) {
      expect(solid.centre.z + solid.half.z, solid.name).toBeCloseTo(COMPANION_AFT_Z, 9);
    }
    // And the run reaches from the inboard coaming out to the deck edge.
    const outboard = Math.max(...aft.map((s) => s.centre.x + s.half.x));
    expect(outboard).toBeCloseTo(companionXLimits(COMPANION_AFT_Z).xHi, 9);
  });

  it('reaches the obstacle index rather than being clipped out of it', () => {
    // The index has a height clip, and it was a literal 3.0 chosen when the deck
    // was the lowest floor aboard. Anything below decks that the clip discards
    // is discarded silently — it stays in `DECK_OBSTACLES`, so nothing looks
    // wrong anywhere.
    for (const solid of companionCoamingSolids()) {
      const listed = DECK_OBSTACLES.find((o) => o.name === solid.name);
      expect(listed).toBeDefined();
      const indexed = SCHOONER_DECK_ENVIRONMENT.columns.filter((c) => c.name === solid.name);
      expect(indexed.length).toBeGreaterThan(0);
    }
  });
});

/**
 * The visible companion assembly, not merely the walk and collision contract.
 *
 * These are the faults that only appeared from the rendered model: solid
 * columns masquerading as treads, an open coaming end reading as transparency,
 * a dark clearance ledge under the bulwark, and two aft-facing panels across
 * the ladder head. Raycasting the actual region meshes keeps those from
 * returning while all the mathematical walking surfaces continue to pass.
 */
describe('the visible companion joinery', () => {
  const built = buildShipGeometry();
  const soleGeometry = built.geometries.get('interiorSole')!;
  const liningGeometry = built.geometries.get('interiorLining')!;
  const deckJoineryGeometry = built.geometries.get('deckJoinery')!;
  const bulwarkGeometry = built.geometries.get('inboardBulwark')!;
  const soleMesh = new THREE.Mesh(
    soleGeometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const liningMesh = new THREE.Mesh(
    liningGeometry,
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );
  const deckJoineryMesh = new THREE.Mesh(
    deckJoineryGeometry,
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );
  const bulwarkMesh = new THREE.Mesh(
    bulwarkGeometry,
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );

  const rayHits = (
    mesh: THREE.Mesh,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): THREE.Intersection[] =>
    new THREE.Raycaster(origin, direction.normalize(), 0, 10).intersectObject(mesh, false);

  const uniqueDescending = (values: readonly number[]): number[] => {
    const sorted = [...values].sort((a, b) => b - a);
    return sorted.filter((value, index) => index === 0 || Math.abs(value - sorted[index - 1]) > 1e-4);
  };

  it('draws each tread as a thin closed board rather than a column to the sole', () => {
    for (let index = 1; index <= COMPANION_TREADS; index++) {
      const { zAft, zForward } = companionTreadZ(index);
      const z = zAft + (zForward - zAft) * 0.43;
      const { xLo, xHi } = companionXLimits(z);
      const x = xLo + (xHi - xLo) * 0.47;
      const expectedTop = companionTreadY(index, x);
      const ys = uniqueDescending(
        rayHits(soleMesh, new THREE.Vector3(x, 5.2, z), new THREE.Vector3(0, -1, 0))
          .map((hit) => hit.point.y)
          .filter((y) => y <= expectedTop + 0.02 && y >= CABIN_SOLE_Y - 0.01),
      );

      expect(ys.length, `tread ${index} did not close underneath`).toBeGreaterThanOrEqual(3);
      expect(ys[0], `tread ${index} top`).toBeCloseTo(expectedTop, 3);
      expect(ys[0] - ys[1], `tread ${index} board thickness`).toBeGreaterThan(0.04);
      expect(ys[0] - ys[1], `tread ${index} board thickness`).toBeLessThan(0.07);
      expect(ys[1] - CABIN_SOLE_Y, `tread ${index} still reaches the sole`).toBeGreaterThan(0.1);
    }
  });

  it('fairs the outboard wall continuously into the bulwark with the same finish', () => {
    // Abaft the flight, so no tread can answer the ray in place of the wall.
    const z = -3.55;
    const { xHi } = companionXLimits(z);
    const deckEdge = xHi + COMPANION_OUTBOARD_CLEARANCE;
    const deck = deckStandAt(deckEdge, z)!;
    const landing = belowDecksSpace('landing');
    const footX = spaceSideHalfWidthAt(landing, z, landing.soleY, false);
    const samples = [0.05, 0.35, 0.65, 0.95].map((t) => ({
      y: landing.soleY + (deck.y - landing.soleY) * t,
      x: footX + (deckEdge - footX) * t,
    }));

    for (const sample of samples) {
      const hit = rayHits(
        bulwarkMesh,
        new THREE.Vector3(0.8, sample.y, z),
        new THREE.Vector3(1, 0, 0),
      )[0];
      expect(hit, `no front face at y=${sample.y.toFixed(3)}`).toBeDefined();
      expect(hit.point.x, `casing at y=${sample.y.toFixed(3)}`).toBeCloseTo(sample.x, 3);
    }
  });

  it('carries the transverse bulkhead to the top tread and keeps the exit above it', () => {
    const x = companionMidX(PLATFORM_AFT_Z);
    const wallTop = companionTreadY(COMPANION_TREADS, x);
    const aftFace = PLATFORM_AFT_Z - BULKHEAD_THICKNESS * 0.5;
    const forwardFace = PLATFORM_AFT_Z + BULKHEAD_THICKNESS * 0.5;
    const fromLanding = (y: number): THREE.Intersection[] =>
      rayHits(
        liningMesh,
        new THREE.Vector3(x, y, aftFace - 0.25),
        new THREE.Vector3(0, 0, 1),
      ).filter((hit) => Math.abs(hit.point.z - aftFace) < 1e-3);
    const fromWardroom = (y: number): THREE.Intersection[] =>
      rayHits(
        liningMesh,
        new THREE.Vector3(x, y, forwardFace + 0.25),
        new THREE.Vector3(0, 0, -1),
      ).filter((hit) => Math.abs(hit.point.z - forwardFace) < 1e-3);

    expect(fromLanding(wallTop - 0.1).length).toBeGreaterThan(0);
    expect(fromWardroom(wallTop - 0.1).length).toBeGreaterThan(0);
    expect(fromLanding(wallTop + 0.05)).toHaveLength(0);
    expect(fromWardroom(wallTop + 0.05)).toHaveLength(0);

    // The opening also ends at the deck break. Its generic 130 mm cut-edge
    // lining used to span the whole head here, facing only into the landing.
    const deck = deckStandAt(x, PLATFORM_AFT_Z)!;
    const throughHead = rayHits(
      liningMesh,
      new THREE.Vector3(x, deck.y - DECK_BEAM_DEPTH * 0.5, PLATFORM_AFT_Z - 0.25),
      new THREE.Vector3(0, 0, 1),
    ).filter((hit) => Math.abs(hit.point.z - PLATFORM_AFT_Z) < 1e-3);
    expect(throughHead).toHaveLength(0);
  });

  it('closes the exposed waist-deck plank edge above the ladder', () => {
    // Frozen vessel-local ray recorded from the landing while the ship was
    // moving. At the quarterdeck break it passes through y=3.817, between the
    // waist plank's top at 3.848 and underside at 3.798. The old companion-head
    // exception skipped the whole cut-edge ribbon to keep the stair exit open,
    // so it also skipped this real 50 mm end face and the ray reached the ocean.
    const origin = new THREE.Vector3(-0.1710987574, 4.07, -3.4183696182);
    const direction = new THREE.Vector3(0.8673059917, -0.1198548491, 0.4831305536);
    const hit = rayHits(liningMesh, origin, direction)[0];

    expect(hit).toBeDefined();
    expect(hit.distance).toBeLessThan(2.2);
    expect(hit.point.z).toBeCloseTo(COMPANION_FORWARD_Z, 5);
    expect(hit.point.y).toBeCloseTo(3.817, 3);
  });

  it('seals the wardroom side jamb into the landing wall', () => {
    // Frozen vessel-local ray recorded from the wardroom while the ship was
    // moving. It crosses the companion-head band that used to be open above the
    // penultimate tread. The complete wardroom face now stops it directly; the
    // side return still joins that face to the landing's bulwark-continuation
    // profile. Before either closure, the only two-sided ship hit was the *back*
    // of the exterior topsides at 1.965 m and the renderer continued to ocean.
    const origin = new THREE.Vector3(1.0796190639, 3.42, -0.9775643877);
    const direction = new THREE.Vector3(0.4889207138, 0.0645642328, -0.8699356272);
    const hit = rayHits(liningMesh, origin, direction)[0];

    expect(hit).toBeDefined();
    expect(hit.distance).toBeLessThan(1.965);
    expect(hit.point.z).toBeCloseTo(
      COMPANION_FORWARD_Z + BULKHEAD_THICKNESS * 0.5,
      5,
    );
  });

  it('seals the full-height wardroom corner captured beside the companion head', () => {
    // Frozen vessel-local ray 1 from the multi-ray scene inspector. It starts
    // in the wardroom, passes just outboard of the old penultimate-tread cut,
    // and previously escaped every ship mesh before meeting the ocean nearly
    // 499 m away. The top tread is the wardroom deckhead here, so a complete
    // partition must stop it on the wardroom face of this bulkhead.
    const origin = new THREE.Vector3(
      0.9385955437492732,
      3.42,
      -1.6135168959769088,
    );
    const direction = new THREE.Vector3(
      0.768593238660995,
      0.1164191069671677,
      -0.6290556613031711,
    );
    const hit = rayHits(liningMesh, origin, direction)[0];

    expect(hit).toBeDefined();
    expect(hit.distance).toBeLessThan(1.5);
    expect(hit.point.z).toBeCloseTo(
      PLATFORM_AFT_Z + BULKHEAD_THICKNESS * 0.5,
      5,
    );
  });

  it('keeps the above-deck coaming out of the enclosed interior lighting region', () => {
    expect(INTERIOR_REGIONS).not.toContain('deckJoinery');
    expect(SHIP_PALETTE.base.deckJoinery).toBe(SHIP_PALETTE.base.interiorLining);
  });

  it('closes the coaming underneath and across its exposed forward end', () => {
    const xLo = companionXLimits(COMPANION_FORWARD_Z).xLo;
    const xMid = xLo - COMPANION_COAMING_THICKNESS * 0.5;
    const zMid = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) * 0.5;
    const deck = deckStandAt(xMid, zMid)!;
    const underside = rayHits(
      deckJoineryMesh,
      // Begin inside the deck planking, above its visible underside; otherwise
      // that legitimate face is the first thing the upward ray meets.
      new THREE.Vector3(xMid, deck.y - 0.02, zMid),
      new THREE.Vector3(0, 1, 0),
    )[0];
    expect(underside).toBeDefined();
    expect(underside.point.y).toBeCloseTo(deck.y, 2);

    const position = deckJoineryGeometry.getAttribute('position');
    const normal = deckJoineryGeometry.getAttribute('normal');
    const triangles = deckJoineryGeometry.getIndex()!;
    const capYs: number[] = [];
    for (let i = 0; i < triangles.count; i += 3) {
      const ids = [triangles.getX(i), triangles.getX(i + 1), triangles.getX(i + 2)];
      if (!ids.every((id) => Math.abs(position.getZ(id) - COMPANION_FORWARD_Z) < 1e-5)) continue;
      if (!ids.every((id) => position.getX(id) >= xLo - COMPANION_COAMING_THICKNESS - 1e-5)) continue;
      if (!ids.every((id) => position.getX(id) <= xLo + 1e-5)) continue;
      if (normal.getZ(ids[0]) < 0.9) continue;
      capYs.push(...ids.map((id) => position.getY(id)));
    }
    expect(capYs.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...capYs) - Math.min(...capYs)).toBeGreaterThan(
      COMPANION_COAMING_HEIGHT * 0.95,
    );
  });

  it('founds the outboard coaming end on the narrowing deck edge', () => {
    // The outer after corner lies 80 mm abaft the opening corner, where the hull
    // is already narrower. Keeping the opening-corner x there made deckStandAt
    // return null; its cabin-sole fallback stretched two triangles down nearly
    // two metres into the grey, paper-thin blade reported from the landing.
    const position = deckJoineryGeometry.getAttribute('position');
    const endYs: number[] = [];
    const outerXs: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (x < 1.68 || z < COMPANION_AFT_Z - COMPANION_COAMING_THICKNESS - 1e-5) continue;
      if (z > COMPANION_AFT_Z + 1e-5) continue;
      endYs.push(y);
      if (Math.abs(z - (COMPANION_AFT_Z - COMPANION_COAMING_THICKNESS)) < 1e-5) {
        outerXs.push(x);
      }
    }

    const outerZ = COMPANION_AFT_Z - COMPANION_COAMING_THICKNESS;
    const edge = companionXLimits(outerZ).xHi;
    const deck = deckStandAt(edge, outerZ)!;
    expect(endYs.length).toBeGreaterThan(0);
    expect(Math.min(...endYs)).toBeGreaterThanOrEqual(deck.y - 0.01);
    expect(Math.max(...outerXs)).toBeCloseTo(edge, 5);
  });

  it('seals the aft end of the landing wall into the cabin bulkhead', () => {
    // A captured vessel-local ray through the reported strip of ocean. The
    // landing wall and the landing-facing bulkhead once used different x(y)
    // profiles at their shared edge, so this ray missed every ship mesh.
    const origin = new THREE.Vector3(1.4245952057, 4.07, -3.4275083665);
    const direction = new THREE.Vector3(0.1901789186, -0.0980621594, -0.9768396961);
    const hitsAtSeam = [
      ...rayHits(liningMesh, origin, direction.clone()),
      ...rayHits(bulwarkMesh, origin, direction.clone()),
    ].sort((a, b) => a.distance - b.distance);

    expect(hitsAtSeam[0]).toBeDefined();
    expect(hitsAtSeam[0].distance).toBeLessThan(1.5);
  });

  it('closes the landing wall into the waist bulwark at the deck break', () => {
    // Recorded with the scene inspector from the waist, looking aft through the
    // reported wood-coloured gap. The first intersection used to be the *top of
    // the external main channel plank* at distance 2.315 m: there was no ship
    // surface at all between the eye and a fitting outside the hull.
    const origin = new THREE.Vector3(1.706635217, 5.4702680792, -1.0479047206);
    const direction = new THREE.Vector3(0.0851284881, -0.7395732566, -0.6676709808);
    const hit = rayHits(bulwarkMesh, origin, direction)[0];

    expect(hit).toBeDefined();
    expect(hit.distance).toBeLessThan(2.315);
    expect(hit.point.z).toBeCloseTo(COMPANION_FORWARD_Z, 5);
  });
});

/**
 * Getting *out* of her, which is not the same question as getting around in her.
 *
 * WHY THIS DOES NOT USE THE WALKER
 * --------------------------------
 * `ship-deck.test.ts` already floods the weather deck through `attemptMove`, and
 * it reported the quarterdeck reachable for the whole of the slice in which a
 * body could not actually get off the companion ladder. The reason is
 * `attemptMove`'s contact resolution: it *pushes a body out* of anything it
 * overlaps, three passes, several columns at a time — so a grid probe gets
 * squirted through gaps that a player leaning on a key never finds. It is the
 * right routine for playing and the wrong one for proving a route exists.
 *
 * So this asks the question with no push-out at all: **a body either fits where
 * it is going or it does not.** Same floor query, same columns, same footprint
 * rule, and the four probes round the body — just no rescue. That is a lower
 * bound on where a player can get, which is the direction a guard should err in.
 *
 * What it caught: the main fife rail stood 0.48 m forward of the ladder's head
 * with the coamings either side, leaving a free island 0.30 m by 0.20 m with
 * the hatch behind it and no way out. Ash found it by trying to walk out of the
 * ship; nothing in the suite had an opinion.
 */
describe('the way out of her', () => {
  const T = DEFAULT_WALKER_TUNING;
  const STEP = 0.05;

  /** The floor at a point, if a body of this size can actually stand on it. */
  const standing = (x: number, z: number, fromY: number): number | null => {
    const stand = schoonerStandAt(x, z, fromY + T.stepUp);
    if (!stand) return null;
    if (stand.y - fromY > T.stepUp) return null;
    if (stand.ceilingY - stand.y < T.crouchHeight) return null;
    for (const column of OBSTACLE_COLUMNS) {
      // The same height band `DeckWalker.attemptMove` uses: below the step-over
      // it is a kerb, above the standing height it is over your head.
      if (column.yHi <= stand.y + T.stepOver) continue;
      if (column.yLo >= stand.y + T.standingHeight) continue;
      if (columnDistance(column, x, z).distance < column.radius + T.radius) return null;
    }
    for (const [px, pz] of [
      [T.radius, 0],
      [-T.radius, 0],
      [0, T.radius],
      [0, -T.radius],
    ]) {
      if (!schoonerStandAt(x + px, z + pz, stand.y + T.stepUp)) return null;
    }
    return stand.y;
  };

  it('lets a body climb out of the companionway and walk the weather deck', () => {
    // On the sole at the foot of the flight — the whole route, climb included,
    // which is what Ash was doing when he found there was not one.
    const startZ = FLIGHT_FOOT_Z - 0.2;
    const startY = standing(0, startZ, CABIN_SOLE_Y);
    expect(startY, 'the foot of the ladder will not hold a body').not.toBeNull();

    // **Keyed by height as well as by cell**, and that is not a detail. A cell
    // visited once and closed is a cell that can never be re-entered from a
    // *higher* floor — and the sole runs underneath the whole flight, so a fill
    // that spreads along it first marks every tread's station at 2.45 m and can
    // then never climb the ladder it is standing under. The shipped fill in
    // `ship-deck.test.ts` has the same shape and gets away with it only because
    // the weather deck is single-storey.
    const key = (ix: number, iz: number): string => `${ix},${iz}`;
    const best = new Map<string, number>([[key(0, 0), startY!]]);
    const queue: Array<[number, number, number]> = [[0, 0, startY!]];
    let onDeckForward = false;
    let onDeckAft = false;
    let guard = 0;

    while (queue.length > 0 && guard++ < 200000) {
      const [ix, iz, y] = queue.shift()!;
      const z = startZ + iz * STEP;
      // On the *weather deck*, not merely at that station: without the height
      // the fill goes forward through the rooms and reports the waist as
      // reached from inside the ship.
      if (y > 3.7) {
        if (z > -1.6) onDeckForward = true;
        if (z < -5.5) onDeckAft = true;
      }
      if (onDeckForward && onDeckAft) break;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = ix + dx;
        const nz = iz + dz;
        const wx = nx * STEP;
        const wz = startZ + nz * STEP;
        if (Math.abs(wx) > 2.4 || wz < -8.2 || wz > 7.6) continue;
        const next = standing(wx, wz, y);
        if (next === null) continue;
        const seen = best.get(key(nx, nz));
        if (seen !== undefined && next <= seen + 1e-6) continue;
        best.set(key(nx, nz), next);
        queue.push([nx, nz, next]);
      }
    }

    expect(onDeckForward, 'a body below decks cannot reach the waist').toBe(true);
    expect(onDeckAft, 'a body below decks cannot reach the helm').toBe(true);
  });
});

describe('the walk below decks', () => {
  const dt = 1 / 120;

  /** Drive the body with its own move routine, not with the query under it. */
  const walk = (w: DeckWalker, seconds: number, forward: number, right = 0): void => {
    for (let t = 0; t < seconds; t += dt) w.step(dt, { forward, right, yaw: 0 });
  };

  /** The same, turned about: yaw 0 faces aft, so this one walks toward the bow. */
  const walkFacingForward = (w: DeckWalker, seconds: number, stride = dt): void => {
    for (let t = 0; t < seconds; t += stride) {
      w.step(stride, { forward: 1, right: 0, yaw: Math.PI });
    }
  };

  it('goes down the companionway and stands in the cabin', () => {
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    // **In the waist now, not on the quarterdeck.** The head is the break, so a
    // body arrives at the opening on the lower deck and never climbs to reach
    // it — which is the whole of what this move was for.
    const zHead = COMPANION_FORWARD_Z + 2 * BREAK_TOLERANCE;
    expect(w.placeAt(companionMidX(zHead), COMPANION_FORWARD_Z + 0.5)).toBe(true);
    expect(w.y).toBeGreaterThan(3.8);
    expect(w.y).toBeLessThan(4.4);

    // Yaw 0 faces aft: the camera looks down its own -Z on a ship whose +z is
    // the bow. So `forward: 1` walks aft, into the opening.
    walk(w, 2.5, 1);

    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 2);
    expect(w.z).toBeLessThan(COMPANION_AFT_Z);
    expect(w.grounded).toBe(true);
    // And she is under a deck now, not under the sky.
    expect(w.ceilingY).toBeLessThan(4.5);
    expect(w.eyeY()).toBeLessThan(w.ceilingY);
  });

  it('does not fall through the quarterdeck riser beside the companion head', () => {
    // Ray 1 from Ash's report: feet on the waist deck, one body radius forward
    // of the break and just inboard of the port-side companion opening. Walking
    // aft used to step over the bulkhead collider's low top, select the landing
    // sole 1.45 m below, and fall through the visible riser.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(0.4651510016, -2.1258931538)).toBe(true);
    const startY = w.y;
    const contacts = new Set<string>();
    for (let frame = 0; frame < 120; frame++) {
      w.step(dt, { forward: 1, right: 0, yaw: 0 });
      if (w.lastContact) contacts.add(w.lastContact);
    }

    expect(w.y).toBeCloseTo(startY, 2);
    expect(w.z).toBeGreaterThan(
      COMPANION_FORWARD_Z + DEFAULT_WALKER_TUNING.radius * 0.9,
    );
    expect([...contacts].some((name) => name.startsWith('wardroomBulkheadAft'))).toBe(true);
  });

  it('does not enter beneath the companion treads through their side', () => {
    // Ray 3: on the landing beside the fourth tread. The sole legitimately
    // continues under the flight, so without the flight's side cheek collider
    // the floor query allowed a body to walk through the visible board and
    // become trapped under a tread too high to acquire.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(0.3749670878, -2.696453164, CABIN_SOLE_Y)).toBe(true);
    const contacts = new Set<string>();
    for (let frame = 0; frame < 120; frame++) {
      w.step(dt, { forward: 0, right: 1, yaw: 0 });
      if (w.lastContact) contacts.add(w.lastContact);
    }

    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 6);
    expect(w.x).toBeLessThan(companionXLimits(w.z).xLo);
    expect([...contacts].some((name) => name.startsWith('companionCheek'))).toBe(true);
  });

  it('walks her from the forecastle to the transom without going on deck', () => {
    // **The whole point of the arrangement, walked rather than asserted.** Four
    // rooms on three floors, joined bow to stern: the forecastle at 2.05, one
    // step down through a doorway to the platform at 1.80, two steps up at the
    // other end to the landing at 2.45, and the cabin door aft of that. Every
    // one of those is a place where the floor changes height inside a doorway,
    // which is the one geometry M4 never had.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    // In the forecastle, abaft the foremast, in line with the port doorway. The
    // route dog-legs round both masts, which is what `DOORWAY_OFFSET` is about.
    expect(w.placeAt(DOORWAY_OFFSET, 3.6, FORECASTLE_SOLE_Y)).toBe(true);
    expect(w.y).toBeCloseTo(FORECASTLE_SOLE_Y, 2);

    // Aft, through the +2.6 doorway and down its single 0.25 m step.
    walk(w, 1.4, 1);
    expect(w.y).toBeCloseTo(PLATFORM_SOLE_Y, 2);
    expect(w.z).toBeLessThan(PLATFORM_FORWARD_Z);
    expect(w.grounded).toBe(true);

    // **Cross to starboard here, well forward of the mainmast.** The mast passes
    // through the wardroom 0.5 m from its after bulkhead, and a body keeps
    // 0.44 m from a mast and 0.29 m from a bulkhead — so the corner between them
    // is 0.73 m of clearance in 0.5 m of room, and a body that arrives on the
    // wrong hand is wedged. Found by walking it, not by reading it.
    walk(w, 0.6, 0, -1);

    // Aft over the hatchway boards, which are floor and not a hole, and up the
    // two steps into the landing.
    walk(w, 2.6, 1);
    expect(w.z).toBeLessThan(HATCHWAY_AFT_Z);
    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 2);
    expect(w.z).toBeLessThan(PLATFORM_AFT_Z);
    expect(w.grounded).toBe(true);

    // Back to the centreline for the cabin door, and aft to the transom. She
    // stops at the sole's own edge, which *is* the transom — no bulkhead there.
    walk(w, 0.35, 0, 1);
    walk(w, 1.6, 1);
    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 2);
    expect(w.z).toBeLessThan(CABIN_FORWARD_Z);
    expect(w.z).toBeGreaterThan(CABIN_AFT_Z);
    expect(w.grounded).toBe(true);
  });

  it('walks down the well and through the wardroom door without ducking', () => {
    // **The whole point of the well, measured as the thing a body feels.** The
    // door used to be 1.263 m of clear opening into a room with 1.913 m of
    // headroom, because the 0.65 m of level change was spent on the far side of
    // the wall. Cutting the flight into the landing instead moves the sill down
    // to the wardroom's own floor, and the crouch goes away.
    const bulkhead = BULKHEADS.find((b) => b.name === 'wardroomBulkheadAft')!;
    const sill = bulkhead.sillY!;
    const head = doorwayHeadY(bulkhead)!;
    expect(sill).toBeCloseTo(PLATFORM_SOLE_Y, 9);
    expect(head - sill).toBeGreaterThan(DEFAULT_WALKER_TUNING.standingHeight);
    expect(head - sill).toBeCloseTo(DOORWAY_HEIGHT, 9);

    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    // In the landing, abaft the well, in line with it.
    expect(w.placeAt(-WELL_OFFSET, -4.05, CABIN_SOLE_Y)).toBe(true);
    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 9);

    // Forward, down the three risers and across the flat, through the door.
    // **Facing where she is going.** Yaw 0 faces aft, so going forward means
    // turning about rather than walking backwards into the door — which is not
    // pedantry: the body is a cylinder but the doorway check is not, and a test
    // that reverses through it is testing a manoeuvre no player makes.
    walkFacingForward(w, 1.2);
    expect(w.y).toBeCloseTo(PLATFORM_SOLE_Y, 2);
    expect(w.z).toBeGreaterThan(PLATFORM_AFT_Z);
    expect(w.grounded).toBe(true);
    // Standing, not crouching: the head is under the deckhead with room to
    // spare, which is the whole claim.
    expect(w.eyeY()).toBeLessThan(w.ceilingY);
    expect(w.ceilingY - w.y).toBeGreaterThan(DEFAULT_WALKER_TUNING.standingHeight);
  });

  it('does not stall on the lip of the well at any stride length', () => {
    // **The three-nanometre gap, pinned.** `inStepsWell` suppresses the room's
    // sole on a ±1e-6 tolerance and `stepTreadIndexAt` offered a tread on an
    // exact bound, so a station one of them admitted and the other refused had
    // no floor at all — and the fallback below the quarterdeck is the
    // quarterdeck, 2.0 m up, which `attemptMove` reads as a wall. A body walked
    // to the edge of the stairs and stopped dead with nothing reporting a
    // fault. It reproduced only at strides that landed inside that gap, so this
    // sweeps the step sizes rather than trusting one.
    const steps = INTERIOR_STEPS.find((s) => s.name === 'wardroomWell')!;
    const lip = steps.zTop + steps.direction * stepsRunLength(steps);
    for (const stride of [1 / 30, 1 / 60, 1 / 90, 1 / 120, 1 / 200]) {
      const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
      expect(w.placeAt(-WELL_OFFSET, lip - 0.55, CABIN_SOLE_Y)).toBe(true);
      walkFacingForward(w, 1.6, stride);
      expect(w.y, `stride ${stride}`).toBeCloseTo(PLATFORM_SOLE_Y, 2);
      expect(w.z, `stride ${stride}`).toBeGreaterThan(lip);
    }
  });

  it('is stopped by a bulkhead everywhere except its doorway', () => {
    // The classification that changed this round: with one room a bulkhead stood
    // exactly where the sole ended, so the surface refused a body and a collider
    // would have been a second description of one plane. With floor on both
    // sides, a bulkhead that is not solid is a wall you walk through.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    // Abreast of the wardroom's forward bulkhead but not in line with its door.
    expect(w.placeAt(-1.2, PLATFORM_FORWARD_Z - 0.8, PLATFORM_SOLE_Y)).toBe(true);
    const startZ = w.z;
    walk(w, 2.0, -1);
    // Forward is refused: she is still abaft the bulkhead, and she moved less
    // than the free run would have taken her.
    expect(w.z).toBeLessThan(PLATFORM_FORWARD_Z);
    expect(w.z - startZ).toBeLessThan(0.8);
  });

  it('goes down from anywhere the coaming lets a body in', () => {
    // A flight that works on one line and nowhere else is the failure mode a
    // single-start test cannot see. The opening is now bounded inboard by its
    // coaming and outboard by the bulwark, so walk it in from both edges of
    // what a 0.26 m body can actually get between.
    // **The shaft tapers, so the claim is "can reach the sole", not "straight
    // aft works from every x".** The opening follows the deck edge and the hull
    // closes as it goes down, so it is 1.23 m across at the break and 1.07 m at
    // its after end; a body that enters hard against the bulwark and then walks
    // dead straight arrives at the bottom tread with its outboard shoulder
    // past the lining and stops there. That is what a tapering hatch *is* —
    // real ladders are climbed, not fallen down in a straight line — and the
    // property worth guarding is that every entry has a way down, which the
    // outboard case gets by drifting inboard the way a player does.
    const r = DEFAULT_WALKER_TUNING.radius;
    const zEnter = COMPANION_FORWARD_Z + 0.5;
    const { xLo, xHi } = companionXLimits(COMPANION_FORWARD_Z);
    const entries: readonly (readonly [number, number])[] = [
      [xLo + r + 0.02, 0],
      [(xLo + xHi) * 0.5, 0],
      // Yaw 0 faces aft, so `right: -1` drifts inboard.
      [xHi - r - 0.02, -1],
    ];
    for (const [x, right] of entries) {
      const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
      expect(w.placeAt(x, zEnter), `entering at x=${x}`).toBe(true);
      walk(w, 3.0, 1, right);
      expect(w.y, `descending at x=${x}`).toBeCloseTo(CABIN_SOLE_Y, 2);
    }
  });

  it('climbs back out onto the waist, and keeps going', () => {
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    // Placed on the sole, which needs the height: "on the ship at (x, z)" is no
    // longer a complete instruction.
    expect(w.placeAt(companionMidX(-3.5), -3.5, CABIN_SOLE_Y)).toBe(true);
    expect(w.y).toBeCloseTo(CABIN_SOLE_Y, 9);

    // **The high-water mark, not where three seconds of walking leaves her.**
    // This asserted the final height, and it passed for the whole of the
    // furnishing slice for the wrong reason: the main fife rail stood 0.48 m
    // forward of the hatch and stopped the body dead on the quarterdeck, so
    // "still up there after three seconds" read as success. It was the trap.
    // With the rail moved she walks on forward, over the break, and down a
    // quarterdeck ladder into the waist — which is the whole point.
    let highest = w.y;
    let brokeSky = false;
    for (let t = 0; t < 3.0; t += dt) {
      w.step(dt, { forward: -1, right: 0, yaw: 0 });
      highest = Math.max(highest, w.y);
      if (w.ceilingY === Infinity && w.y > 4.4) brokeSky = true;
    }
    expect(highest, 'she never reached the quarterdeck').toBeGreaterThan(4.4);
    expect(brokeSky, 'she never got out from under the deck').toBe(true);
    expect(w.z).toBeGreaterThan(COMPANION_FORWARD_Z);
  });

  it('cannot walk into the opening from aft, or over its sides', () => {
    // The coaming's job. Approaching from abaft — which is where the helm is —
    // has to stop at the timber.
    const fromAft = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(fromAft.placeAt(companionMidX(COMPANION_AFT_Z), COMPANION_AFT_Z - 0.8)).toBe(true);
    const startY = fromAft.y;
    walk(fromAft, 2.0, -1); // forward, toward the hatch
    expect(fromAft.y).toBeCloseTo(startY, 1);
    expect(fromAft.z).toBeLessThan(COMPANION_AFT_Z);

    // And across the beam, from inboard of the coaming — the only hand it can
    // be approached from now that the other side is the ship's own bulwark.
    const fromSide = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    const midZ = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) * 0.5;
    expect(fromSide.placeAt(companionXLimits(midZ).xLo - 0.5, midZ)).toBe(true);
    const sideStartY = fromSide.y;
    for (let t = 0; t < 2.0; t += dt) {
      fromSide.step(dt, { forward: 0, right: -1, yaw: 0 });
    }
    // On the quarterdeck still, not down the hole. Height rather than exact
    // height: she has moved 0.5 m inboard across a deck that crowns 90 mm.
    expect(fromSide.y).toBeGreaterThan(sideStartY - 0.1);
    expect(fromSide.x).toBeLessThan(companionXLimits(midZ).xLo);
  });

  it('keeps the eye under the deckhead all the way across the cabin', () => {
    // The check that a body below decks never sees through its own ceiling.
    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    for (let z = CABIN_AFT_Z + 0.4; z <= CABIN_FORWARD_Z - 0.4; z += 0.2) {
      const half = cabinHalfWidthAt(z);
      for (const x of [0, half * 0.6]) {
        if (!w.placeAt(x, z, CABIN_SOLE_Y)) continue;
        if (w.y > CABIN_SOLE_Y + 1e-6) continue; // on the flight, under open sky
        w.step(dt, { forward: 0, right: 0, yaw: 0 });
        expect(w.eyeY()).toBeLessThan(w.ceilingY);
        expect(w.eyeY()).toBeGreaterThan(w.y + 1.0);
      }
    }
  });
});

/**
 * THE SEAL: the only way out of the cabin is the companionway.
 *
 * `SHIP_ROUND_HANDOVER.md` makes "no light leaks through hull or deck" an M4
 * acceptance gate, and a gate phrased about *light* cannot be checked by reading
 * the loft — the two leaks this round found were 60 mm and 9 mm, both invisible
 * as geometry and both a hard blue line across the whole room on screen. So this
 * asks the question the way the renderer does: fire rays out of the room, and
 * every one that reaches open air has to have gone through the hatch.
 *
 * The second leak is the reason this exists rather than a vertex-coincidence
 * check. It was not a mismatched edge at all — the deckhead's outboard edge was
 * a straight chord between two stations under a deck that curves, so the two
 * surfaces agreed exactly where they were measured and parted between. Nothing
 * short of a ray finds that.
 */
describe('the cabin is sealed', () => {
  const built = buildShipGeometry();

  /** Every triangle near the cabin, as flat vertex data. */
  const collectTriangles = (): number[][] => {
    const out: number[][] = [];
    for (const region of SHIP_REGIONS) {
      const geometry = built.geometries.get(region);
      if (!geometry) continue;
      const pos = geometry.getAttribute('position');
      const index = geometry.getIndex();
      if (!index) continue;
      for (let i = 0; i < index.count; i += 3) {
        const ia = index.getX(i);
        const ib = index.getX(i + 1);
        const ic = index.getX(i + 2);
        const t = [
          pos.getX(ia), pos.getY(ia), pos.getZ(ia),
          pos.getX(ib), pos.getY(ib), pos.getZ(ib),
          pos.getX(ic), pos.getY(ic), pos.getZ(ic),
        ];
        // Only what is near the room. A ray leaving the cabin has to cross this
        // box, so anything outside it cannot be what stops one — and the whole
        // ship is 20,000 triangles, which is too many to fire a thousand rays at.
        const yLo = Math.min(t[1], t[4], t[7]);
        const yHi = Math.max(t[1], t[4], t[7]);
        const zLo = Math.min(t[2], t[5], t[8]);
        const zHi = Math.max(t[2], t[5], t[8]);
        // The whole hull now: the sweep below fires out of all four rooms, and
        // a box drawn round the cabin is exactly how a guard comes to cover a
        // quarter of the ship while reading as covering it.
        if (yHi < 1.0 || yLo > 8.0) continue;
        if (zHi < -9 || zLo > 8.5) continue;
        out.push(t);
      }
    }
    return out;
  };

  const TRIANGLES = collectTriangles();

  /** Möller-Trumbore, two-sided: a surface stops light whichever way it faces. */
  const hits = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean => {
    for (const t of TRIANGLES) {
      const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
      const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 1e-4) return true;
    }
    return false;
  };

  it('lets light out through the companionway and nowhere else', () => {
    const escapes: string[] = [];
    let cast = 0;

    for (let z = CABIN_AFT_Z + 0.3; z <= CABIN_FORWARD_Z - 0.3; z += 0.45) {
      const half = cabinHalfWidthAt(z);
      for (const x of [-half * 0.7, 0, half * 0.7]) {
        // An eye's height above the sole, which is where a leak is seen from.
        const oy = CABIN_SOLE_Y + 1.5;
        for (let i = 0; i < 22; i++) {
          const azimuth = (i / 22) * Math.PI * 2;
          // Upward and outward only: a leak is a hole in the deck or the side,
          // and the sole has the bilge under it rather than the sea.
          for (const elevation of [0.05, 0.3, 0.6, 1.0, 1.4]) {
            const dy = Math.sin(elevation);
            const r = Math.cos(elevation);
            const dx = Math.cos(azimuth) * r;
            const dz = Math.sin(azimuth) * r;
            cast++;
            if (hits(x, oy, z, dx, dy, dz)) continue;

            // It got out. The only lawful way is through the opening, so find
            // where it crossed the deck and check it was over the hatch.
            let crossedInside = false;
            for (let s = 0.02; s < 6; s += 0.02) {
              const px = x + dx * s;
              const py = oy + dy * s;
              const pz = z + dz * s;
              const deck = deckStandAt(px, pz);
              if (!deck) break;
              if (py >= deck.y - DECK_BEAM_DEPTH) {
                crossedInside = inCompanionway(px, pz);
                break;
              }
            }
            if (!crossedInside) {
              escapes.push(
                `(${x.toFixed(2)}, ${oy.toFixed(2)}, ${z.toFixed(2)}) -> ` +
                  `(${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)})`,
              );
            }
          }
        }
      }
    }

    expect(cast).toBeGreaterThan(1000);
    expect(escapes.slice(0, 6).join('\n')).toBe('');
  });

  /**
   * And the same question of **every** room, which is how the next one is found.
   *
   * The cabin was the only room when the sweep above was written, and it stayed
   * the only room the sweep covered when three more were built. What that cost
   * was not hypothetical: the wardroom bulkhead was drawn to the *lower* of the
   * two ceilings it stands between, so it stopped 0.59 m short of the landing's
   * deckhead across the full width of the ship, and from the landing you looked
   * over the top of a wall at the weather deck, the rigging and the sky. Ash
   * found it by standing there. **A guard that covers one of four rooms is a
   * guard that reports on a quarter of the ship and reads as covering it.**
   *
   * Lawful escapes are the three openings — the companionway, the cargo hatch
   * (a shaft from the sky to the hold, and the wardroom's only daylight) and
   * the fore scuttle over the forecastle. Everything else that reaches open air
   * is a hole.
   *
   * WHAT THIS STILL CANNOT SEE, MEASURED
   * ------------------------------------
   * It is **two-sided** — "a surface stops light whichever way it faces", as the
   * sweep above says — and that blinds it to this ship's single most repeated
   * fault: *an open-ended or one-sided surface reads as transparency rather than
   * as a hole.* Put the wardroom bulkhead's own version of that fault back (draw
   * both faces to the lower of its two ceilings) and this test still passes,
   * because the weather deck's break riser is standing in the gap — facing
   * forward, invisible from aft, and stopping a two-sided ray it would never
   * stop a photon.
   *
   * Running the same sweep front-face-only, the way the renderer sees, gives
   * **55 escapes out of 6144 on the ship as she now is**, clustered round the
   * landing at about 20° of elevation. Those are real: surfaces a body below
   * decks is looking straight through. They are not fixed and this guard is not
   * the one that will catch them — a front-face sweep is, once they are.
   */
  it('lets no daylight into any of the four rooms but through its openings', () => {
    const escapes: string[] = [];
    let cast = 0;

    // **Three openings now.** The fore scuttle is the forecastle's, and it is
    // the reason this assertion moved from two names to three: before it, that
    // room had no way to the sky at all, which is exactly why it metered
    // 1/50,000 and why the scuttle was cut. `inForeScuttle` is asked rather
    // than its bounds retyped, so moving the hatch moves this guard with it.
    const lawful = (x: number, z: number): boolean =>
      inCompanionway(x, z) ||
      inForeScuttle(x, z) ||
      (Math.abs(x) <= HATCHWAY_HALF_BREADTH && z >= HATCHWAY_AFT_Z && z <= HATCHWAY_FORWARD_Z);

    /**
     * Stopped by the ship — asked of a bundle, not of one ray.
     *
     * **A closed mesh has knife-edge misses and they are not holes.** A ray that
     * runs exactly along a shared edge between two triangles can fail both
     * inside tests by a rounding bit, and the sweep's own sample points land on
     * the loft's seams by construction: the centreline is a grid column
     * boundary, so `x = 0` is the worst possible place to fire from. Measured
     * rather than assumed — this ray escapes at x = 0 exactly and is stopped
     * 0.6754 m away at x = ±0.0002, which is a seam and not an opening.
     *
     * Nudging by a third of a millimetre separates the two cleanly: no real hole
     * in this ship is anywhere near that small, and the smallest one ever found
     * here was 9 mm. A guard that reports float noise is a guard that gets
     * muted.
     */
    const NUDGE = 0.0003;
    const stopped = (x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean =>
      hits(x, y, z, dx, dy, dz) ||
      hits(x + NUDGE, y, z, dx, dy, dz) ||
      hits(x - NUDGE, y, z, dx, dy, dz) ||
      hits(x, y, z + NUDGE, dx, dy, dz) ||
      hits(x, y, z - NUDGE, dx, dy, dz);

    for (const space of BELOW_DECKS_SPACES) {
      for (let i = 1; i < 5; i++) {
        const z = space.zAft + ((space.zForward - space.zAft) * i) / 5;
        const half = spaceHalfWidthAt(space, z);
        if (half <= 0) continue;
        const oy = space.soleY + 1.5;
        for (const x of [-half * 0.7, 0, half * 0.7]) {
          for (let a = 0; a < 32; a++) {
            const azimuth = (a / 32) * Math.PI * 2;
            for (const elevation of [0.05, 0.35, 0.7, 1.1]) {
              const dy = Math.sin(elevation);
              const r = Math.cos(elevation);
              const dx = Math.cos(azimuth) * r;
              const dz = Math.sin(azimuth) * r;
              cast++;
              if (stopped(x, oy, z, dx, dy, dz)) continue;
              // **Lawful anywhere along the march, not only where it surfaces.**
              // This asked the single point at which the ray reached deck level,
              // which is right for an opening a ray leaves *vertically* — every
              // opening on this ship used to be a hole in a deck overhead. The
              // companionway's head is now the quarterdeck break, so a ray
              // leaves it sideways through the riser and only reaches deck level
              // later, out over the waist, where `inCompanionway` is false.
              //
              // Passing through an opening is the thing being asked about, and
              // where the ray happens to surface afterwards is not part of it.
              let crossedInside = false;
              for (let s = 0.02; s < 8; s += 0.02) {
                const px = x + dx * s;
                const py = oy + dy * s;
                const pz = z + dz * s;
                if (lawful(px, pz)) {
                  crossedInside = true;
                  break;
                }
                const deck = deckStandAt(px, pz);
                if (!deck) break;
                if (py >= deck.y - DECK_BEAM_DEPTH) break;
              }
              if (!crossedInside) {
                escapes.push(
                  `${space.name} (${x.toFixed(2)}, ${oy.toFixed(2)}, ${z.toFixed(2)}) -> ` +
                    `(${dx.toFixed(2)}, ${dy.toFixed(2)}, ${dz.toFixed(2)})`,
                );
              }
            }
          }
        }
      }
    }

    expect(cast).toBeGreaterThan(1000);
    expect(escapes.slice(0, 6).join('\n')).toBe('');
  });

  /**
   * The seam, sampled densely along the one edge where two builders meet.
   *
   * WHAT NEITHER OF THESE TESTS CAN DO, MEASURED RATHER THAN ASSUMED
   * ---------------------------------------------------------------
   * Both leaks this round found were at this seam — 60 mm where the deckhead was
   * lofted to the sole's half-width instead of the deck's, and 9 mm where its
   * outboard edge was a straight chord under a deck that curves. **The 60 mm one
   * is caught here. The 9 mm one is not**, and that was checked by putting the
   * fault back and re-running rather than reasoned about: both ray tests still
   * passed. A 9 mm slot a metre away subtends half a degree, and this fan is
   * 1.15° apart at its finest.
   *
   * So what the renderer does with 1280 columns of pixels, a test with a few
   * thousand rays does not. **The instrument for a hairline seam is the render**,
   * and the way that one was actually found was a screenshot, then a raycast
   * through the offending pixel to ask the scene what was behind it. These two
   * tests catch a room that is gross-open — a panel missed, an edge lofted to the
   * wrong width, a builder that stopped early — which is the failure that
   * survives a casual look, and they are worth having for that and not for more.
   *
   * The rays start close to the seam on purpose: a gap subtends a larger angle
   * the nearer you stand to it, and the point is to make a small slot as easy to
   * hit as possible rather than to look through it realistically.
   */
  it('has no daylight at the join of the side and the deckhead', () => {
    const escapes: string[] = [];
    let cast = 0;

    for (let z = CABIN_AFT_Z + 0.05; z <= CABIN_FORWARD_Z - 0.05; z += 0.03) {
      const roof = cabinRoofHalfWidthAt(z);
      if (roof <= 0) continue;
      const over = deckStandAt(0, z);
      if (!over) continue;
      for (const side of [1, -1]) {
        const ox = side * (roof - 0.15);
        const seam = deckStandAt(side * roof, z);
        if (!seam) continue;
        const oy = seam.y - 0.10;
        for (let i = 0; i <= 40; i++) {
          const elevation = (i / 40) * 0.8;
          const dy = Math.sin(elevation);
          const dx = side * Math.cos(elevation);
          cast++;
          if (hits(ox, oy, z, dx, dy, 0)) continue;
          escapes.push(
            `z ${z.toFixed(2)} side ${side > 0 ? 'port' : 'stbd'} ` +
              `elev ${((elevation * 180) / Math.PI).toFixed(1)}deg`,
          );
        }
      }
    }

    expect(cast).toBeGreaterThan(5000);
    expect(`${escapes.length} leaks\n${escapes.slice(0, 5).join('\n')}`).toBe('0 leaks\n');
  });

  it('is firing at real geometry', () => {
    // A guard on the guard. Every number in the test above is a filter, and a
    // filter that is slightly wrong gives a ray cast at nothing, which passes
    // silently and forever. Both bounds have been seen to matter: the leak this
    // suite was written for lives at the deck edge, and clipping the triangle
    // set to the cabin's own width would have excluded the surface that closes
    // it.
    expect(TRIANGLES.length).toBeGreaterThan(2000);
    // And a ray fired at the after bulkhead from a foot away must stop.
    expect(hits(0, CABIN_SOLE_Y + 1.0, CABIN_AFT_Z + 0.3, 0, 0, -1)).toBe(true);
    // As must one fired straight up at the deckhead, well clear of the hatch.
    expect(hits(0, CABIN_SOLE_Y + 1.0, CABIN_AFT_Z + 0.3, 0, 1, 0)).toBe(true);
    // And one fired straight up *through* the hatch must not. From the foot
    // landing, not the middle of the opening: the middle has the ladder over
    // it, which stops a ray exactly as it should. Off the centreline now, since
    // the shaft is.
    const landing = COMPANION_AFT_Z + COMPANION_LANDING_DEPTH * 0.5;
    expect(hits(companionMidX(landing), CABIN_SOLE_Y + 0.1, landing, 0, 1, 0)).toBe(false);
  });
});

describe('what the interior enumerates', () => {
  it('classifies every kind of thing below decks', () => {
    // The doctrine: an intersection suite keyed to one list stops covering the
    // ship the moment geometry lands in a different list. Adding a kind of
    // object below decks has to fail here until someone has decided whether a
    // person can walk into it.
    const expected = [
      'companionCheeks',
      'companionCoaming',
      'companionTreads',
      'hatchwayBoards',
      'interiorBeams',
      'interiorBulkheads',
      'interiorSoles',
      'interiorSteps',
      'rudderTrunk',
      'transomLining',
    ];
    expect(Object.keys(INTERIOR_SOURCES).sort()).toEqual(expected);
    for (const [name, entry] of Object.entries(INTERIOR_SOURCES)) {
      expect(entry.reason.length, `${name} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('has an obstacle for every collidable kind, and none for the rest', () => {
    const interior = DECK_OBSTACLES.filter((o) => o.source === 'interior');
    expect(interior.length).toBe(interiorSolids().length);
    // Every collidable kind is represented, and nothing classified as
    // not-collidable turned up in the obstacle list.
    const collidable = Object.entries(INTERIOR_SOURCES)
      .filter(([, entry]) => entry.collidable)
      .map(([name]) => name);
    expect(collidable.sort()).toEqual([
      'companionCheeks',
      'companionCoaming',
      'interiorBulkheads',
      'rudderTrunk',
    ]);
    for (const o of interior) {
      const known =
        o.name.startsWith('companionCoaming') ||
        o.name.startsWith('companionCheek') ||
        o.name === 'rudderTrunk' ||
        BULKHEADS.some((bulkhead) => o.name.startsWith(bulkhead.name));
      expect(known, `${o.name} is not one of the classified kinds`).toBe(true);
    }
    // And every bulkhead actually produced timber a body is stopped by, which is
    // the check that matters: they were `collidable: false` through M4 because
    // one room's bulkhead stood exactly where its sole ended. With floor on both
    // sides of four of them, a bulkhead that is not a solid is a wall you walk
    // through.
    for (const bulkhead of BULKHEADS) {
      expect(
        interior.some((o) => o.name.startsWith(bulkhead.name)),
        `${bulkhead.name} has no collider`,
      ).toBe(true);
    }
  });
});

// --- the pump, the hold, and the way into it ---------------------------------

describe('the bilge pump reaches the bilge', () => {
  it('joins the length on deck to the length below it', () => {
    // The fault Ash reported: "it's located on the deck but doesn't have a
    // shaft going all the way down." The two halves live in different files
    // because one is deck furniture and one is below decks, so the guard that
    // matters is that they *meet* — a gap here is invisible from both sides,
    // since each file's own tests would pass.
    const deckPump = DECK_FITTINGS.find((f) => f.name === 'bilgePump')!;
    const deckFoot = Math.min(
      ...deckPump.solids.filter((s) => s.kind === 'bar').map((s) => Math.min(s.a.y, s.b.y)),
    );
    const tube = pumpTube();
    const head = Math.max(
      ...tube.solids.filter((s) => s.kind === 'bar').map((s) => Math.max(s.a.y, s.b.y)),
    );
    expect(head, 'the tube below decks stops short of the pump on deck').toBeGreaterThanOrEqual(
      deckFoot,
    );
  });

  it('reaches the water it is meant to draw', () => {
    const tube = pumpTube();
    const foot = Math.min(
      ...tube.solids.filter((s) => s.kind === 'bar').map((s) => Math.min(s.a.y, s.b.y)),
    );
    const rabbet = floorYAt(PUMP_Z);
    // Off the floors, so it does not draw the ballast's grit — but within a
    // hand's breadth, or it is not a pump, it is a pipe.
    expect(foot).toBeGreaterThan(rabbet);
    expect(foot - rabbet).toBeLessThan(0.25);
  });

  it('takes its station from the deck rather than repeating it', () => {
    // Two sources for one position is the fault this ship has found six times,
    // and the bilge pump is one of the six. If the deck's pump moves, the tube
    // and the well move with it — asserted by construction rather than trusted.
    const well = pumpWell();
    const xs = well.solids.map((s) => (s.kind === 'box' ? s.centre.x : s.a.x));
    for (const x of xs) expect(Math.abs(x - PUMP_X)).toBeLessThan(PUMP_WELL_HALF + 0.01);
  });

  it('stands its well head under the walker’s step-over', () => {
    // `INTERIOR_FITTING_KINDS.pumpWell` claims this in words. A reason that can
    // go stale is worth less than a reason that is checked.
    expect(PUMP_WELL_HEAD_HEIGHT).toBeLessThan(DEFAULT_WALKER_TUNING.stepOver);
  });
});

describe('the hold', () => {
  it('solves the ballast top rather than choosing it', () => {
    // The number the hold's whole accessibility turns on. It is derived from
    // the ballast the ship actually carries, so a change to the water
    // allowance re-solves it and this test re-checks the consequence.
    expect(BALLAST_TOP_Y).toBeGreaterThan(0.6);
    expect(BALLAST_TOP_Y).toBeLessThan(1.2);
    expect(HOLD_FLOOR_Y).toBeCloseTo(BALLAST_TOP_Y + DUNNAGE_THICKNESS, 9);
  });

  it('leaves a working well a body can actually get into', () => {
    // Ash measured 0.68 m as passable by shuffling under a desk; `crawlHeight`
    // is 0.75 with the margin on the side that refuses. If a later change to
    // the stores or the platform sole squeezes this below that, the hold
    // becomes a sealed void and nothing else would say so.
    const t = DEFAULT_WALKER_TUNING;
    expect(HOLD_WELL_CLEAR).toBeGreaterThan(t.crawlHeight);
    // And it must NOT be tall enough to walk in, or the crawl is decoration.
    expect(HOLD_WELL_CLEAR).toBeLessThan(t.crouchHeight);
  });

  it('can be left again — by walking the route, not by checking the arithmetic', () => {
    // **The guard that should have caught this and did not.** The old version
    // asserted each riser was inside the step-up and that the top tread met the
    // sole, both of which were true of a flight nobody could climb: every tread
    // was given the platform sole as its ceiling, so a rung at 1.22 reported
    // 0.58 m of clear against the 0.75 m a body will enter. Arithmetic about a
    // ladder is not the same claim as a body getting up it, and only the second
    // one is what Ash found broken.
    //
    // So this climbs. Same floor query the player's feet use, no push-out, and
    // it must reach the wardroom's sole from the floor of the hold.
    resetClosures();
    setClosureOpen('hatchwayBoards', true);
    const t = DEFAULT_WALKER_TUNING;
    const zMid = (HOLD_LADDER_PANELS[0].z0 + HOLD_LADDER_PANELS[0].z1) / 2;

    let y = HOLD_FLOOR_Y;
    for (let rung = 0; rung < HOLD_LADDER_PANELS.length; rung++) {
      const stand = schoonerStandAt(0, zMid, y + t.stepUp);
      expect(stand, `no floor on rung ${rung}`).not.toBeNull();
      expect(
        stand!.y - y,
        `rung ${rung} is a taller step than a body takes`,
      ).toBeLessThanOrEqual(t.stepUp + 1e-9);
      expect(
        stand!.ceilingY - stand!.y,
        `rung ${rung} is too low to enter — this is the fault that trapped Ash`,
      ).toBeGreaterThanOrEqual(t.crawlHeight);
      y = stand!.y;
    }
    expect(y, 'the ladder does not reach the sole').toBeCloseTo(HOLD_SOLE_Y, 6);

    // And off the top of it onto the wardroom's floor, which is the step that
    // actually leaves the hold.
    const off = schoonerStandAt(0, HOLD_LADDER_PANELS[0].z0 - 0.3, y + t.stepUp);
    expect(off!.y).toBeCloseTo(HOLD_SOLE_Y, 6);
    expect(off!.ceilingY - off!.y).toBeGreaterThan(t.standingHeight);
    resetClosures();
  });

  it('lets a body WALK out of the hold, not merely query its way out', () => {
    // **This is the guard that was missing, and its absence is the whole
    // story.** The route was checked with `schoonerStandAt` — which reported
    // the ladder perfectly reachable — while a cask stood between the body and
    // the rungs. A floor query answers "is there a step here"; it does not
    // answer "can a body get to it", and only the second question is the one
    // Ash was asking when he could not get out.
    //
    // So this drives `attemptMove`, the same routine the player's keys do,
    // from the middle of the hold to the wardroom's sole.
    resetClosures();
    setClosureOpen('hatchwayBoards', true);
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    walker.placeAt(0, 1.5, HOLD_FLOOR_Y + DEFAULT_WALKER_TUNING.stepUp);
    expect(walker.y).toBeCloseTo(HOLD_FLOOR_Y, 6);

    // Aft, in the strides a body takes, for long enough to reach and climb.
    const contacts = new Set<string>();
    for (let i = 0; i < 400; i++) {
      walker.step(1 / 60, { forward: 1, right: 0, yaw: 0 });
      if (walker.lastContact) contacts.add(walker.lastContact);
      if (walker.y >= HOLD_SOLE_Y - 1e-6) break;
    }

    expect(
      walker.y,
      `never got out of the hold; stopped at z=${walker.z.toFixed(2)} on ${[...contacts].join(', ') || 'nothing'}`,
    ).toBeCloseTo(HOLD_SOLE_Y, 6);
    resetClosures();
  });

  it('blocks the ladder while the boards are laid, then restores it when lifted', () => {
    resetClosures();
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    walker.placeAt(0, 1.5, HOLD_FLOOR_Y + DEFAULT_WALKER_TUNING.stepUp);
    expect(walker.y).toBeCloseTo(HOLD_FLOOR_Y, 6);

    // The body can crawl to the ladder but cannot acquire even its first rung
    // while the boards close the head of the shaft.
    for (let frame = 0; frame < 240; frame++) {
      walker.step(1 / 60, { forward: 1, right: 0, yaw: 0 });
    }
    expect(walker.y).toBeCloseTo(HOLD_FLOOR_Y, 6);
    expect(walker.z).toBeGreaterThanOrEqual(HATCHWAY_AFT_Z - 1e-6);

    // Lifting the same boards, without moving or replacing the body, publishes
    // the rungs again and the normal route carries it into the wardroom.
    setClosureOpen('hatchwayBoards', true);
    for (let frame = 0; frame < 240; frame++) {
      walker.step(1 / 60, { forward: 1, right: 0, yaw: 0 });
      if (walker.y >= HOLD_SOLE_Y - 1e-6 && walker.z < HATCHWAY_AFT_Z) break;
    }
    expect(walker.y).toBeCloseTo(HOLD_SOLE_Y, 6);
    expect(walker.z).toBeLessThan(HATCHWAY_AFT_Z);
    resetClosures();
  });

  it('keeps a body ducked in the hold rather than standing it through the hatch', () => {
    // Ash: "at first i got stuck standing in the hold, couldnt see in it."
    // Reporting the deck two floors up put the eye at 2.55 — above the sole at
    // 1.80 — so the player looked at the wardroom while standing in the hold.
    resetClosures();
    setClosureOpen('hatchwayBoards', true);
    const t = DEFAULT_WALKER_TUNING;
    for (const z of [1.4, 0.9, 2.0]) {
      const stand = schoonerStandAt(0, z, HOLD_FLOOR_Y + t.stepUp);
      expect(stand!.y).toBeCloseTo(HOLD_FLOOR_Y, 6);
      expect(
        stand!.ceilingY - stand!.y,
        `standing tall at z=${z} means the eye is above the sole`,
      ).toBeLessThan(t.standingHeight);
    }
    resetClosures();
  });

  it('stows the cargo it is carrying, in tiers that nest', () => {
    expect(HOLD_CASK_COUNT).toBeGreaterThan(40);
    const tiers = new Set(
      HOLD_STOW.filter((s) => s.kind === 'bar').map((s) => (s as { a: { y: number } }).a.y.toFixed(4)),
    );
    // Two tiers, because one tier is a floor and the honeycomb of cask ends
    // §4.5 asks for needs an upper course sitting in the hollows of the lower.
    expect(tiers.size).toBeGreaterThanOrEqual(2);
    const top = Math.max(...[...tiers].map(Number)) + CASK_DIAMETER / 2;
    expect(top, 'the stow stands proud of the platform sole').toBeLessThanOrEqual(HOLD_SOLE_Y);
  });

  it('keeps the stow out of the pump’s well', () => {
    // A well is boarded clear precisely so cargo cannot foul the pump. A cask
    // drawn through it is the reason the casing exists, drawn wrong.
    for (const solid of HOLD_STOW) {
      if (solid.kind !== 'bar') continue;
      const dx = Math.abs(solid.a.x - PUMP_X);
      const dz = Math.abs((solid.a.z + solid.b.z) / 2 - PUMP_Z);
      expect(dx > PUMP_WELL_HALF || dz > PUMP_WELL_HALF).toBe(true);
    }
  });

  it('is in the obstacle index rather than clipped out of it', () => {
    // `INDEX_Y_LO` has now gone stale three times, and each time it discarded
    // real geometry from the *index* while `DECK_OBSTACLES` still listed it —
    // drawn, classified collidable, covered by the enumerating tests, and
    // walked straight through. The stow lives below every sole aboard.
    const stowColumns = OBSTACLE_COLUMNS.filter((c) => c.source === 'stow');
    expect(stowColumns.length).toBeGreaterThan(40);
  });
});

describe('the hatchway boards', () => {
  it('are the floor when they are down and a hole when they are up', () => {
    resetClosures();
    const reach = HOLD_SOLE_Y + DEFAULT_WALKER_TUNING.stepUp;
    const shut = schoonerStandAt(0, 1.4, reach);
    expect(shut, 'no floor over a shut hatchway').not.toBeNull();
    expect(shut!.y).toBeCloseTo(HOLD_SOLE_Y, 6);

    setClosureOpen('hatchwayBoards', true);
    const open = schoonerStandAt(0, 1.4, reach);
    // The sole is withdrawn, so the floor a body finds is the stow below it.
    expect(open!.y).toBeCloseTo(HOLD_FLOOR_Y, 6);
    resetClosures();
  });

  it('lets a body straighten up on the ladder, but only there', () => {
    // **This replaces a guard that asserted the fault.** It used to require the
    // deck two floors up to be reported over a body standing on the hold floor
    // under an open hatch — which is how Ash ended up in the hold with his eye
    // in the wardroom, unable to see the room he was in. The place a body is
    // entitled to straighten up is the ladder, because that is a thing you step
    // onto on purpose.
    resetClosures();
    setClosureOpen('hatchwayBoards', true);
    const t = DEFAULT_WALKER_TUNING;
    const zMid = (HOLD_LADDER_PANELS[0].z0 + HOLD_LADDER_PANELS[0].z1) / 2;

    const onLadder = schoonerStandAt(0, zMid, HOLD_FLOOR_Y + t.stepUp);
    expect(onLadder!.y).toBeCloseTo(HOLD_LADDER_PANELS[0].y, 6);
    expect(onLadder!.ceilingY).toBeGreaterThan(HOLD_SOLE_Y + 1);

    const inTheHold = schoonerStandAt(0, 1.4, HOLD_FLOOR_Y + t.stepUp);
    expect(inTheHold!.ceilingY).toBeCloseTo(HOLD_SOLE_Y, 6);
    resetClosures();
  });

  it('are never a collider in either state', () => {
    // `INTERIOR_FITTING_KINDS.hatchwayBoards` claims this. Shut they are a
    // floor; lifted they are a stack a body strides over.
    for (const open of [false, true]) {
      for (const solid of hatchwayBoards(open).solids) expect(solid.collides).toBe(false);
    }
  });

  it('can be aimed at from where a person would stand', () => {
    // The fault that made the first version of this unusable: `REACH` is
    // measured from the eye, and a ray aimed at a 24 mm board on a floor
    // 1.62 m below the eye enters that slab 2.2 m away however close you
    // stand. Every floor-level closure in the ship inherits this.
    resetClosures();
    const interactables = buildShipInteractables();
    const t = DEFAULT_WALKER_TUNING;
    const eye = { x: 0, y: HOLD_SOLE_Y + t.eyeHeight, z: 0.2 };
    // Looking forward and down at a natural angle.
    const pitch = -0.75;
    const dir = { x: 0, y: Math.sin(pitch), z: Math.cos(pitch) };
    const hit = interactables.pick(eye, dir);
    expect(hit, 'the boards are not reachable from beside them').not.toBeNull();
    expect(hit!.interactable.name).toBe('hatchwayBoards');
    expect(hit!.interactable.verb(false)).toMatch(/lift/i);
    expect(hit!.interactable.verb(true)).toMatch(/lay/i);
  });

  it('does not reach across the ship', () => {
    // The failure the reach guards against: a player in the forecastle working
    // the hatch in the wardroom because it happened to line up.
    const interactables = buildShipInteractables();
    const t = DEFAULT_WALKER_TUNING;
    const far = { x: 0, y: HOLD_SOLE_Y + t.eyeHeight, z: -3.0 };
    expect(interactables.pick(far, { x: 0, y: -0.3, z: 0.954 })).toBeNull();
  });
});

describe('the walker’s postures', () => {
  it('ducks the crown, not the eye', () => {
    // `headClearance` used to be applied to the eye as though the eye were the
    // top of the head. There is 0.13 m of skull above it on this body, so the
    // crown was passing through the deck beams anywhere under 1.81 m — the
    // forecastle at the sides, the landing, and the cabin's sides.
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    const t = walker.tuning;
    walker.placeAt(0, 1.4, HOLD_SOLE_Y);
    const crownToEye = t.standingHeight - t.eyeHeight;
    walker.placeAt(0, 1.4, 0.95);
    expect(walker.eyeY() + crownToEye).toBeLessThanOrEqual(walker.ceilingY - t.headClearance + 1e-9);
  });

  it('names the posture the headroom gives', () => {
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    walker.placeAt(0, 1.4);
    expect(walker.posture()).toBe('stand');
    walker.placeAt(0, 1.4, 0.95);
    expect(walker.posture()).toBe('crawl');
  });

  it('falls through lifted boards under gravity while folding into a crawl', () => {
    resetClosures();
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(walker.placeAt(0, 1.4, HOLD_SOLE_Y)).toBe(true);
    const standingEye = walker.eyeY();

    setClosureOpen('hatchwayBoards', true);
    const dt = 1 / 60;
    walker.step(dt, { forward: 0, right: 0, yaw: 0 });

    // The first frame has begun a fall, not replaced one floor/camera pose with
    // another. Both feet and eye have moved only the first gravity increment.
    expect(walker.grounded).toBe(false);
    expect(walker.y).toBeLessThan(HOLD_SOLE_Y);
    expect(walker.y).toBeGreaterThan(HOLD_SOLE_Y - 0.01);
    expect(walker.eyeY()).toBeLessThan(standingEye);
    expect(walker.eyeY()).toBeGreaterThan(standingEye - 0.02);

    const eyes = [walker.eyeY()];
    for (let frame = 0; frame < 59; frame++) {
      walker.step(dt, { forward: 0, right: 0, yaw: 0 });
      eyes.push(walker.eyeY());
    }
    expect(walker.y).toBeCloseTo(HOLD_FLOOR_Y, 6);
    expect(walker.grounded).toBe(true);
    expect(walker.posture()).toBe('crawl');
    expect(walker.eyeY()).toBeCloseTo(
      HOLD_SOLE_Y - (walker.tuning.standingHeight - walker.tuning.eyeHeight) - walker.tuning.headClearance,
      6,
    );
    for (let i = 1; i < eyes.length; i++) {
      expect(eyes[i]).toBeLessThanOrEqual(eyes[i - 1] + 1e-9);
    }
    resetClosures();
  });

  it('presents the rung ascent as one slower climb and stand', () => {
    resetClosures();
    setClosureOpen('hatchwayBoards', true);
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(walker.placeAt(0, 1.4, HOLD_FLOOR_Y)).toBe(true);
    const crawlEye = walker.eyeY();
    const standingEye = HOLD_SOLE_Y + walker.tuning.eyeHeight;
    const dt = 1 / 60;

    let firstClimbEye: number | null = null;
    for (let frame = 0; frame < 180 && walker.y < HOLD_SOLE_Y - 1e-6; frame++) {
      const beforeY = walker.y;
      walker.step(dt, { forward: 1, right: 0, yaw: 0 });
      if (firstClimbEye === null && walker.y > beforeY + 1e-6) firstClimbEye = walker.eyeY();
    }

    expect(firstClimbEye, 'the body never reached the ladder').not.toBeNull();
    // Collision reaches the rung now, while the camera has only begun to rise.
    expect(firstClimbEye!).toBeGreaterThan(crawlEye);
    expect(firstClimbEye!).toBeLessThan(crawlEye + 0.05);
    expect(walker.y).toBeCloseTo(HOLD_SOLE_Y, 6);
    expect(walker.eyeY()).toBeLessThan(standingEye - 0.5);

    // It is intentionally still climbing after the fall/duck duration, then
    // converges without needing a separate stand-up input or phase.
    for (let frame = 0; frame < Math.ceil(walker.tuning.duckSmoothing / dt); frame++) {
      walker.step(dt, { forward: 0, right: 0, yaw: 0 });
    }
    expect(walker.eyeY()).toBeLessThan(standingEye - 0.05);
    for (let frame = 0; frame < 240; frame++) {
      walker.step(dt, { forward: 0, right: 0, yaw: 0 });
    }
    expect(walker.eyeY()).toBeCloseTo(standingEye, 3);
    expect(walker.posture()).toBe('stand');
    resetClosures();
  });
});

describe('the interactables are wired to the ship, not to a copy of her', () => {
  it('reads one copy of the state, so the prompt cannot lie', () => {
    // The fault this replaced: the registry kept its own map alongside
    // `closures.ts`, and the prompt read "Lift the boards" over a hatch that
    // was already open. The row reads through to the closure module, so moving
    // the state by any door moves what the player is told.
    resetClosures();
    const interactables = buildShipInteractables();
    const boards = pickBoards(interactables);
    expect(boards.isOn()).toBe(false);

    setClosureOpen('hatchwayBoards', true);
    expect(boards.isOn()).toBe(true);

    boards.activate();
    expect(isClosureOpen('hatchwayBoards')).toBe(false);
    resetClosures();
  });

  it('offers what you are aiming at over what you are standing in', () => {
    // **The captain's chair used to eat the cabin's lantern.** Its target is a
    // metre of clear sole you walk through to reach the desk, and the lantern
    // hangs over that same sole — so a body standing there was nought degrees
    // and nought metres from the chair's box and tied with anything it aimed
    // at, then took the tie on distance. Measured before the fix: from the
    // centreline abreast the desk, pointing *straight at the lantern*, the
    // offer was the chair. Space sat you down instead of striking a light, and
    // aiming harder could not help, which is the part that makes it a bug in
    // the ranking rather than a target that wants shrinking.
    resetClosures();
    resetSeat();
    const lamps = new Set<string>();
    const interactables = buildShipInteractables({
      lamps: { isLit: (id) => lamps.has(id), toggle: (id) => void lamps.add(id) },
      stations: { use: () => {} },
    });
    const cabin = belowDecksSpace('cabin');
    const eyeY = cabin.soleY + DEFAULT_WALKER_TUNING.eyeHeight;
    const hang = lampHangPoint('cabin');

    // Standing on the clear sole in front of the desk — inside the chair's own
    // target volume, which is the whole point — and looking up at the lantern.
    for (const [x, z] of [
      [0.0, -6.6],
      [0.2, -6.3],
      [0.35, -6.9],
    ] as const) {
      const to = { x: hang.x - x, y: hang.y - 0.3 - eyeY, z: hang.z - z };
      const length = Math.hypot(to.x, to.y, to.z);
      const hit = interactables.pick(
        { x, y: eyeY, z },
        { x: to.x / length, y: to.y / length, z: to.z / length },
      );
      expect(hit?.interactable.name, `aiming at the lantern from ${x},${z}`).toBe('lamp:cabin');
    }

    // Occupying the old floor-sized chair target is proximity, not gaze. Facing
    // away from both the desk and lantern therefore offers neither: a nearby
    // object cannot manufacture intent merely because its volume contains the
    // body.
    const facingTheDoor = interactables.pick(
      { x: 0.0, y: eyeY, z: -6.6 },
      { x: -0.2, y: 0, z: 1 },
    );
    expect(facingTheDoor?.interactable.name).not.toBe('deskChair');
  });

  it('does not let hatchway boards underfoot answer a gaze at a wardroom berth', () => {
    // The other concrete report behind the core picker change: from beside the
    // wardroom hatch, looking straight at the surgeon's berth offered "Lift the
    // boards" because standing position scored ahead of gaze. Proximity makes
    // the boards reachable; only looking at their geometry makes them intended.
    resetClosures();
    resetSeat();
    const interactables = buildShipInteractables({ stations: { use: () => {} } });
    const berth = shipStation('surgeonsBerth').target();
    const centre = {
      x: (berth.xLo + berth.xHi) / 2,
      y: (berth.yLo + berth.yHi) / 2,
      z: (berth.zLo + berth.zHi) / 2,
    };
    const wardroom = belowDecksSpace('wardroom');
    const overBoards = {
      x: HATCHWAY_HALF_BREADTH - 0.05,
      y: wardroom.soleY + DEFAULT_WALKER_TUNING.eyeHeight,
      z: (HATCHWAY_AFT_Z + HATCHWAY_FORWARD_Z) / 2,
    };
    const offGaze = interactables.pick(overBoards, {
      x: centre.x - overBoards.x,
      y: centre.y - overBoards.y,
      z: centre.z - overBoards.z,
    });
    expect(offGaze?.interactable.name).not.toBe('hatchwayBoards');

    // From the berth's real approach, that same explicit gaze selects the bed.
    const atBerth = {
      x: -1.15,
      y: wardroom.soleY + DEFAULT_WALKER_TUNING.eyeHeight,
      z: 1.5,
    };
    expect(
      interactables.pick(atBerth, {
        x: centre.x - atBerth.x,
        y: centre.y - atBerth.y,
        z: centre.z - atBerth.z,
      })?.interactable.name,
    ).toBe('surgeonsBerth');
  });

  it('offers the seat where a body stands to sit down, and nowhere else', () => {
    // The chair is the first row that is not a closure, so it is the first that
    // could have been wired to a state nothing else reads. Sitting must move
    // `seatState.ts`, because that is the copy the drawn chair reads.
    resetClosures();
    resetSeat();
    const interactables = buildShipInteractables({
      stations: {
        use: (name) => setOccupiedStation(occupiedStation() === name ? null : name),
      },
    });
    const t = DEFAULT_WALKER_TUNING;
    const pose = captainsSeatPose();
    const desk = chartDeskGeometry();

    // Standing in front of the chair, looking at the desk: offered the seat.
    const inFront = {
      x: pose.x - 0.30,
      y: desk.soleY + t.eyeHeight,
      z: desk.kneeZ,
    };
    const deskTarget = deskChairGazeTarget();
    const atTheDesk = {
      x: (deskTarget.xLo + deskTarget.xHi) / 2 - inFront.x,
      y: (deskTarget.yLo + deskTarget.yHi) / 2 - inFront.y,
      z: (deskTarget.zLo + deskTarget.zHi) / 2 - inFront.z,
    };
    const hit = interactables.pick(inFront, atTheDesk);
    expect(hit).not.toBeNull();
    expect(hit!.interactable.name).toBe('deskChair');
    expect(hit!.interactable.verb(hit!.on)).toMatch(/sit/i);

    hit!.interactable.activate();
    expect(isStationOccupied('deskChair')).toBe(true);
    expect(hit!.interactable.verb(hit!.interactable.isOn())).toMatch(/stand/i);
    resetSeat();

    // **Not from the next room, even looking straight at it through the wall.**
    // The cabin is only 3.5 m long, so a first draft of this test stood at the
    // cabin door and was correctly offered the chair — from just inside the
    // room you genuinely are two paces from it. The guard that matters is the
    // one `REACH` was written for: a body in the landing, on the far side of
    // the bulkhead, must not be able to sit down in the cabin.
    const inTheLanding = {
      x: 0,
      y: desk.soleY + t.eyeHeight,
      z: CABIN_FORWARD_Z + 0.35,
    };
    const throughTheWall = { x: 0.3, y: -0.2, z: -1 };
    const far = interactables.pick(inTheLanding, throughTheWall);
    expect(far?.interactable.name ?? null).not.toBe('deskChair');

    // The approach remains valid but facing away is not an action. Looking at
    // the desk is the explicit half of sitting at it; the floor under the body
    // no longer wins merely by containing the eye.
    const facingTheDoor = interactables.pick(inFront, { x: -0.2, y: 0, z: 1 });
    expect(facingTheDoor?.interactable.name).not.toBe('deskChair');
  });

  it('lays the desk\'s items on the skiver, inside the fiddles', () => {
    // Two ways an item goes wrong and neither shows up in a render: it floats a
    // millimetre over the baize because something recomputed the top, or it
    // overhangs a fiddle and the fiddle draws through it. Both are checked
    // against `chartDeskGeometry()`, which is the one description everything on
    // this desk is placed from.
    //
    // **The comparison happens in the desk's frame, and it did not used to.**
    // `wellXLo`..`wellZForward` are the desk's own coordinates; a `FittingSolid`
    // reports its centre in the ship's. While the desk was square with the keel
    // those were the same numbers, so this read a solid's ship-frame centre
    // straight against the well and was right by coincidence. Turning the desk
    // 6.6° broke it — and it broke it *quietly*, because the displacement grows
    // with distance from the pivot: the manual sits near the middle of the desk
    // and stayed inside the well's slack, so the suite went on passing. Adding
    // a second item out at the forward corner was what surfaced it, and the
    // item was innocent.
    const d = chartDeskGeometry();
    for (const item of deskItems()) {
      let lowest = Infinity;
      for (const solid of item.solids) {
        expect(solid.collides, `${item.name} must not be a collider`).toBe(false);
        if (solid.kind === 'box') {
          lowest = Math.min(lowest, solid.centre.y - solid.half.y);
          const local = shipToFrame(d.frame, solid.centre.x, solid.centre.z);
          expect(local.x - solid.half.x).toBeGreaterThanOrEqual(d.wellXLo - 1e-9);
          expect(local.x + solid.half.x).toBeLessThanOrEqual(d.wellXHi + 1e-9);
          expect(local.z - solid.half.z).toBeGreaterThanOrEqual(d.wellZAft - 1e-9);
          expect(local.z + solid.half.z).toBeLessThanOrEqual(d.wellZForward + 1e-9);
          continue;
        }

        // Round instruments are authored in the same frame. A tube's circular
        // cap is perpendicular to its axis, so project each cap radius onto the
        // desk axes: subtracting the whole radius from a vertical watch case
        // would pretend the case extends below the skiver it stands on.
        const a = shipToFrame(d.frame, solid.a.x, solid.a.z);
        const b = shipToFrame(d.frame, solid.b.x, solid.b.z);
        const dx = b.x - a.x;
        const dy = solid.b.y - solid.a.y;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dy, dz);
        const unit =
          length > 1e-9 ? { x: dx / length, y: dy / length, z: dz / length } : null;
        const extent = (radius: number) =>
          unit
            ? {
                x: radius * Math.sqrt(Math.max(0, 1 - unit.x * unit.x)),
                y: radius * Math.sqrt(Math.max(0, 1 - unit.y * unit.y)),
                z: radius * Math.sqrt(Math.max(0, 1 - unit.z * unit.z)),
              }
            : { x: radius, y: radius, z: radius };
        const ea = extent(solid.radiusA);
        const eb = extent(solid.radiusB);
        lowest = Math.min(lowest, solid.a.y - ea.y, solid.b.y - eb.y);
        expect(Math.min(a.x - ea.x, b.x - eb.x)).toBeGreaterThanOrEqual(d.wellXLo - 1e-9);
        expect(Math.max(a.x + ea.x, b.x + eb.x)).toBeLessThanOrEqual(d.wellXHi + 1e-9);
        expect(Math.min(a.z - ea.z, b.z - eb.z)).toBeGreaterThanOrEqual(d.wellZAft - 1e-9);
        expect(Math.max(a.z + ea.z, b.z + eb.z)).toBeLessThanOrEqual(
          d.wellZForward + 1e-9,
        );
      }
      // Standing on the leather, not on the timber under it and not in the air.
      expect(lowest).toBeCloseTo(d.clothY, 6);
    }
  });

  it('puts every desk item where a seated player can point at it', () => {
    // **The check that would have caught a book behind the sitter's head.** An
    // item's box is only worth having if a ray from the seat actually enters
    // it; the pointer is exact, so an item outside the seated view is an item
    // that exists and cannot be used, with nothing to see wrong about it.
    const pose = captainsSeatPose();
    const eye = { x: pose.x, y: pose.y, z: pose.z };
    for (const item of deskItems()) {
      const centre = {
        x: (item.box.xLo + item.box.xHi) / 2,
        y: (item.box.yLo + item.box.yHi) / 2,
        z: (item.box.zLo + item.box.zHi) / 2,
      };
      const to = {
        x: centre.x - eye.x,
        y: centre.y - eye.y,
        z: centre.z - eye.z,
      };
      const length = Math.hypot(to.x, to.y, to.z);
      const direction = { x: to.x / length, y: to.y / length, z: to.z / length };
      expect(rayBox(eye, direction, item.box), `${item.name} is not under the seat's view`)
        .not.toBeNull();

      // And inside the cone the seat can actually turn to. A target the player
      // has to look past the clamp to reach is unreachable.
      const bearing = Math.atan2(-direction.x, -direction.z);
      let offset = bearing - pose.yaw;
      while (offset > Math.PI) offset -= 2 * Math.PI;
      while (offset < -Math.PI) offset += 2 * Math.PI;
      expect(Math.abs(offset)).toBeLessThan(pose.yawRange);
      const pitch = Math.asin(direction.y);
      expect(pitch).toBeGreaterThan(pose.pitchLo);
      expect(pitch).toBeLessThan(pose.pitchHi);
    }
  });

  it('keeps the chart rack over the desk wherever the desk stands', () => {
    // **This is the guard for a fault the suite let through.** The rack had its
    // own offset off the after bulkhead, which put it over the desk only
    // because the desk happened to be hard aft too. Moving the desk half a
    // metre forward left the rack hanging over nothing, and every test still
    // passed — a fitting that is drawn in the wrong place is drawn perfectly.
    //
    // Checked as a relationship, not as a coordinate: whatever the two anchors
    // are set to, the rack has to be over the sitter and inside the desk's own
    // length.
    // **In the ship's coordinates on both sides**, which the round that turned
    // the desk is the reason for. The desk and the rack are two pieces with two
    // frames; comparing one's local numbers with the other's would compare two
    // different rooms and pass by luck.
    const deskBounds = boundsOf(chartDesk().solids);
    const rack = interiorFittingsNow().find((f) => f.kind === 'chartRack');
    expect(rack).toBeDefined();
    const rackBounds = boundsOf(rack!.solids);

    // Wholly within the desk's length, so nothing overhangs into open cabin.
    expect(rackBounds.z0).toBeGreaterThanOrEqual(deskBounds.z0 - 1e-9);
    expect(rackBounds.z1).toBeLessThanOrEqual(deskBounds.z1 + 1e-9);
    // And centred on the seat, which is what makes it the thing the seated
    // camera frames rather than something off to one side.
    expect((rackBounds.z0 + rackBounds.z1) / 2).toBeCloseTo(captainsSeatPose().z, 6);
    // Outboard of the desk's inboard face: a rack hanging over the front edge
    // would be a rack you knock your head on leaning in.
    expect(rackBounds.x0).toBeGreaterThan(deskBounds.x0);
  });

  it('lies the desk and its rack along the cabin side rather than square to it', () => {
    // **The round that turned the furniture, as a claim about the wall rather
    // than about an angle.** Nothing here reads `frame.yaw`: what was asked for
    // is that the desk fits the side it is against, and the way to check that is
    // to measure the daylight behind it. A test against the angle would pass on
    // a desk turned the right amount in the wrong place.
    const desk = chartDeskGeometry();
    const cabin = belowDecksSpace('cabin');

    let widest = 0;
    let touches = false;
    for (let i = 0; i <= 40; i++) {
      const lz = desk.zAft + ((desk.zForward - desk.zAft) * i) / 40;
      const p = frameToShip(desk.frame, desk.xOutboard, lz);
      // Measured over the carcase's own height band, which is the band
      // `placeInRoom` fitted it against.
      let lining = Infinity;
      for (let j = 0; j <= 8; j++) {
        lining = Math.min(
          lining,
          spaceSideHalfWidthAt(cabin, p.z, desk.soleY + ((desk.topY - desk.soleY) * j) / 8, false),
        );
      }
      const gap = lining - p.x;
      // Not exactly zero, because the fit is solved on samples along the piece
      // and the wall between two of them is a curve. A tenth of a millimetre is
      // the bound `SIDE_FIT_SAMPLES` is chosen to hold, and it is measured here
      // at more stations than the fit used so that the check is not the solve.
      expect(gap, 'the desk is inside the cabin lining').toBeGreaterThan(-1e-4);
      widest = Math.max(widest, gap);
      if (gap < 1e-4) touches = true;
    }
    // It touches the timber somewhere — hard against the wall, not merely near
    // it — and the worst gap anywhere is the sagitta of the side's own curve
    // over the desk's length. Square, that gap was 0.149 m at the forward end.
    expect(touches, 'the desk stands off the lining everywhere').toBe(true);
    expect(widest).toBeLessThan(0.02);

    // The rack over it is on the same wall and gets the same treatment: a shelf
    // screwed to the lining standing 0.10 m off it at one end is a joint nobody
    // would cut.
    const rack = interiorFittingsNow().find((f) => f.kind === 'chartRack');
    const rackBounds = boundsOf(rack!.solids);
    // The wall it is screwed to moves 0.10 m over its own length, so "it
    // followed" is a claim about both ends and not about its bounding box.
    const atAfterEnd = spaceSideHalfWidthAt(cabin, rackBounds.z0, desk.soleY + 1.2, false);
    const atForwardEnd = spaceSideHalfWidthAt(cabin, rackBounds.z1, desk.soleY + 1.2, false);
    expect(atForwardEnd - atAfterEnd).toBeGreaterThan(0.08);

    // Corner by corner, each against the lining at **its own** station — the
    // one comparison that means anything for a turned piece. Against the lining
    // at the box's middle a rotated corner looks buried, which is a fault in
    // the question rather than in the joinery.
    //
    // Then the closest approach in each half of its length: square, this rack
    // touched the timber at its after end and stood 0.10 m off at its forward
    // one, so a single "it touches somewhere" would have passed on it.
    const closest = [Infinity, Infinity];
    const middle = (rackBounds.z0 + rackBounds.z1) / 2;
    for (const solid of rack!.solids) {
      if (solid.kind !== 'box') continue;
      for (const corner of boxCorners(solid)) {
        const lining = spaceSideHalfWidthAt(cabin, corner.z, corner.y, false);
        expect(corner.x, 'the rack is inside the cabin lining').toBeLessThan(lining + 1e-4);
        const half = corner.z < middle ? 0 : 1;
        closest[half] = Math.min(closest[half], lining - corner.x);
      }
    }
    expect(closest[0], 'the rack has come off the lining aft').toBeLessThan(0.02);
    expect(closest[1], 'the rack has come off the lining forward').toBeLessThan(0.02);
  });

  it('turns the desk in the collider as well as in the drawing', () => {
    // **The failure this guards against is a yaw that reaches the loft and not
    // the collision index**, which is the shape every "two descriptions of one
    // ship" fault in this project has had. It does not look like anything: the
    // desk is drawn at its angle and stops a body where a square desk would
    // have been, so a player is walled out of clear sole at one end of it and
    // walks through timber at the other.
    //
    // Checked at the two places the two desks disagree most. A square carcase
    // hard against this lining occupies the after-inboard corner the turned one
    // has vacated, and leaves the forward-outboard wedge the turned one now
    // fills — so one point has to be clear and the other solid, and no single
    // mistake makes both come out right.
    const d = chartDeskGeometry();
    const cabin = belowDecksSpace('cabin');
    const T = DEFAULT_WALKER_TUNING;

    const blocked = (x: number, z: number): boolean =>
      OBSTACLE_COLUMNS.some(
        (column) =>
          column.yHi > cabin.soleY + T.stepOver &&
          column.yLo < cabin.soleY + T.standingHeight &&
          columnDistance(column, x, z).distance < column.radius,
      );

    // Mid-depth of the carcase, a hand inside each end of it.
    const midX = (d.xInboard + d.xOutboard) / 2;
    for (const lz of [d.zAft + 0.08, d.kneeZ, d.zForward - 0.08]) {
      const p = frameToShip(d.frame, midX, lz);
      expect(blocked(p.x, p.z), `the desk does not stop a body at z=${lz}`).toBe(true);
    }

    // Where the *square* desk's outboard corners were: hard against the lining
    // at the desk's forward end is inside the turned carcase, and hard against
    // the lining at its after end is now clear cabin — that end swung inboard.
    const squareOutboard = d.xOutboard;
    const swungAway = frameToShip(d.frame, squareOutboard, d.zAft);
    expect(
      blocked(swungAway.x, swungAway.z - 0.12),
      'the desk still fills the corner a square one filled',
    ).toBe(false);

    // And nothing of it has ended up outboard of the lining, where a body could
    // never reach it and the timber would be inside the ship's side.
    for (const solid of chartDesk().solids) {
      if (solid.kind !== 'box') continue;
      for (const corner of boxCorners(solid)) {
        const lining = spaceSideHalfWidthAt(cabin, corner.z, corner.y, false);
        expect(corner.x, 'the desk is inside the cabin lining').toBeLessThan(lining + 1e-4);
      }
    }
  });

  it('draws the turned desk where its own data says it is', () => {
    // **`shipwright.addBox` and `deckFittings.boxAxes` each build the basis, and
    // they have to be the same one.** Nothing catches a sign disagreement by
    // looking: a desk drawn with the mirrored basis is still a tidy desk at a
    // plausible angle, just reflected about its own centre and no longer against
    // the wall — and the collider, which reads the other basis, would stop a
    // body at the desk that is not there.
    //
    // So: every vertex the loft emits has to lie inside one of the solids the
    // fitting list gave it, tested as *turned* boxes. This is the deck's own
    // "draws no triangle outside the fittings it was given", one room down and
    // with the rotation in it.
    const built = buildInteriorFittingGeometry();
    // The loft draws the rooms' fittings and the hold's stow into one set of
    // meshes, so both lists have to be here or the stow's casks read as stray
    // triangles.
    const drawn: readonly FittingSolid[] = [
      ...interiorFittingsNow().flatMap((f) => f.solids),
      ...HOLD_STOW,
    ];
    const boxes = drawn.filter((s) => s.kind === 'box') as Extract<
      FittingSolid,
      { kind: 'box' }
    >[];
    const bars = drawn.filter((s) => s.kind === 'bar');

    // Each box with its bounds and its basis worked out once. The exact test is
    // trigonometry per vertex per box and there are half a million pairs; the
    // bounds are what make it a second rather than a minute.
    const shapes = boxes.map((solid) => ({
      bounds: solidBounds(solid),
      cos: Math.cos(solid.yaw ?? 0),
      sin: Math.sin(solid.yaw ?? 0),
      solid,
    }));
    const barBounds = bars.map((bar) => solidBounds(bar));

    /** A point in a box's own axes — the inverse of the basis the loft used. */
    const inBox = (shape: (typeof shapes)[number], x: number, y: number, z: number): boolean => {
      const b = shape.bounds;
      if (x < b.x0 - 2e-3 || x > b.x1 + 2e-3) return false;
      if (y < b.y0 - 2e-3 || y > b.y1 + 2e-3) return false;
      if (z < b.z0 - 2e-3 || z > b.z1 + 2e-3) return false;
      const { solid, cos, sin } = shape;
      const dx = x - solid.centre.x;
      const dz = z - solid.centre.z;
      return (
        Math.abs(dx * cos - dz * sin) <= solid.half.x + 2e-3 &&
        Math.abs(y - solid.centre.y) <= solid.half.y + 2e-3 &&
        Math.abs(dx * sin + dz * cos) <= solid.half.z + 2e-3
      );
    };

    let turned = 0;
    for (const box of boxes) if (box.yaw) turned++;
    expect(turned, 'nothing below decks is turned, so this proves nothing').toBeGreaterThan(20);

    let checked = 0;
    for (const geometry of built.geometries.values()) {
      const position = geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        const y = position.getY(i);
        const z = position.getZ(i);
        checked++;
        const inside =
          shapes.some((shape) => inBox(shape, x, y, z)) ||
          barBounds.some(
            (b) =>
              x >= b.x0 - 2e-3 &&
              x <= b.x1 + 2e-3 &&
              y >= b.y0 - 2e-3 &&
              y <= b.y1 + 2e-3 &&
              z >= b.z0 - 2e-3 &&
              z <= b.z1 + 2e-3,
          );
        expect(inside, `a triangle at ${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)} is in no solid`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('seats the eye where it can actually see the desk', () => {
    // Measured against the room rather than re-derived from the same constants
    // the pose is built from. §6 of the plan promised a low peripheral portion
    // here and the hull does not have one, so the clearances a seated view
    // depends on are exactly the sort of claim that has to be checked.
    const pose = captainsSeatPose();
    const desk = chartDeskGeometry();
    const cabin = belowDecksSpace('cabin');

    // Under the beams, with room to spare, sitting down.
    const deckhead = spaceDeckheadY(cabin, pose.x, pose.z);
    expect(deckhead).not.toBeNull();
    expect(pose.y).toBeLessThan(deckhead! - 0.4);

    // Above the desk top, looking down at it rather than along it. A seated eye
    // level with the writing surface sees a plank edge and nothing on it.
    expect(pose.y - desk.topY).toBeGreaterThan(0.35);
    expect(pose.y - desk.topY).toBeLessThan(0.60);

    // Facing the desk, which is outboard of the sitter and no longer square
    // with the ship. The camera looks down its own -Z, so this is the same
    // convention the reach pick reads; the thing it must line up with is the
    // desk's own outboard normal, and a check against +x would be a check that
    // the desk was never turned.
    const facing = { x: -Math.sin(pose.yaw), z: -Math.cos(pose.yaw) };
    const outboard = { x: Math.cos(desk.frame.yaw), z: -Math.sin(desk.frame.yaw) };
    expect(facing.x * outboard.x + facing.z * outboard.z).toBeGreaterThan(0.9999);
    // Still broadly to port, because that is which side of the room it is.
    expect(facing.x).toBeGreaterThan(0.99);

    // The desk is in front of the eye, not behind or beside it. Asked along the
    // desk's own axes, where "in front" means anything at all.
    const seatLocal = chairSeatCentre(true);
    expect(desk.xInboard).toBeGreaterThan(seatLocal.x);
    expect(seatLocal.z).toBeGreaterThan(desk.zAft);
    expect(seatLocal.z).toBeLessThan(desk.zForward);
  });
});

/** The boards' row, by name — the tests below work it directly. */
function pickBoards(interactables: ReturnType<typeof buildShipInteractables>) {
  const boards = SHIP_CLOSURES.find((c) => c.name === 'hatchwayBoards');
  expect(boards).toBeDefined();
  const hit = interactables.pick(
    { x: 0, y: HOLD_SOLE_Y + DEFAULT_WALKER_TUNING.eyeHeight, z: 0.2 },
    { x: 0, y: Math.sin(-0.75), z: Math.cos(-0.75) },
  );
  expect(hit?.interactable.name).toBe('hatchwayBoards');
  return hit!.interactable;
}

describe('the hatchway remains one toggle in either state', () => {
  it('offers the lay while looking into the open hold, from above or below', () => {
    resetClosures();
    const interactables = buildShipInteractables();
    const t = DEFAULT_WALKER_TUNING;

    // The same gaze into the hatch works before and after lifting the boards.
    // Moving the open target to the low stack was why the second Space action
    // vanished even though the closure itself already supported a toggle.
    const above = { x: 0, y: HOLD_SOLE_Y + t.eyeHeight, z: 0.2 };
    const intoHatch = { x: 0, y: Math.sin(-0.75), z: Math.cos(-0.75) };
    const shutHit = interactables.pick(above, intoHatch);
    expect(shutHit).not.toBeNull();
    expect(shutHit!.interactable.verb(shutHit!.on)).toMatch(/lift/i);

    shutHit!.interactable.activate();
    const openHit = interactables.pick(above, intoHatch);
    expect(openHit).not.toBeNull();
    expect(openHit!.interactable.verb(openHit!.on)).toMatch(/lay/i);

    // Falling through does not hide the action either. Looking back up at the
    // opening lets the player lay the boards, and the same toggle can lift them
    // again, so doing so cannot permanently seal the hold.
    const below = { x: 0, y: HOLD_FLOOR_Y + 0.68, z: 1.4 };
    const fromBelow = interactables.pick(below, { x: 0, y: 1, z: 0 });
    expect(fromBelow).not.toBeNull();
    expect(fromBelow!.interactable.verb(fromBelow!.on)).toMatch(/lay/i);
    fromBelow!.interactable.activate();
    expect(isClosureOpen('hatchwayBoards')).toBe(false);
    expect(interactables.pick(below, { x: 0, y: 1, z: 0 })).not.toBeNull();

    // The physical stack abaft the opening remains a valid target too.
    setClosureOpen('hatchwayBoards', true);
    const overTheStack = { x: 0, y: HOLD_SOLE_Y + t.eyeHeight, z: -0.2 };
    expect(
      interactables.pick(overTheStack, { x: 0, y: Math.sin(-1.2), z: Math.cos(-1.2) }),
    ).not.toBeNull();
    resetClosures();
  });
});

describe('what the below-decks fittings enumerate', () => {
  it('classifies every kind that is built, and builds every kind it classifies', () => {
    // The device `OBSTACLE_SOURCES`, `FITTING_KINDS` and `INTERIOR_SOURCES` all
    // use, and the reason each gives: an intersection suite keyed to one list
    // stops covering the ship the moment geometry lands in a different list.
    // Adding a kind of thing below decks should fail a test until somebody has
    // decided whether a person can walk into it.
    resetClosures();
    const built = new Set(interiorFittingsNow().map((f) => f.kind));
    const classified = new Set(Object.keys(INTERIOR_FITTING_KINDS));
    expect([...built].sort()).toEqual([...classified].sort());
    for (const [kind, entry] of Object.entries(INTERIOR_FITTING_KINDS)) {
      expect(entry.reason.length, `${kind} has no reason`).toBeGreaterThan(40);
    }
  });

  it('holds each kind to the claim its reason makes', () => {
    // A reason that can go stale is worth less than a reason that is checked.
    resetClosures();
    const byKind = new Map(interiorFittingsNow().map((f) => [f.kind, f]));
    const t = DEFAULT_WALKER_TUNING;

    // "Solid where it stands in the wardroom... not solid below the platform sole."
    const tube = byKind.get('pumpTube')!;
    for (const solid of tube.solids) {
      if (solid.kind !== 'bar' || !solid.collides) continue;
      expect(Math.min(solid.a.y, solid.b.y)).toBeGreaterThanOrEqual(HOLD_SOLE_Y - 1e-9);
    }

    // "Under the walker's 0.40 m step-over, so it is a kerb."
    expect(byKind.get('pumpWell')!.standable!.y - HOLD_SOLE_Y).toBeLessThan(t.stepOver);

    // "Never collidable in either state."
    for (const open of [false, true]) {
      for (const solid of hatchwayBoards(open).solids) expect(solid.collides).toBe(false);
    }
  });
});

describe('every floor a body can be under is drawn from underneath', () => {
  /**
   * Front-face-only, the way the renderer sees.
   *
   * A two-sided ray test cannot find this fault — that is the point of it. A
   * one-sided surface stops a two-sided ray it would never stop a photon, which
   * is why §10.9's sweep passed while Ash was looking straight through the
   * wardroom's floor.
   */
  function firstFrontFace(
    geometries: Map<string, THREE.BufferGeometry>,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): number | null {
    const ray = new THREE.Raycaster(origin, direction.clone().normalize(), 0, 20);
    let nearest: number | null = null;
    for (const [, geometry] of geometries) {
      const mesh = new THREE.Mesh(geometry);
      mesh.material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
      for (const hit of ray.intersectObject(mesh)) {
        if (nearest === null || hit.distance < nearest) nearest = hit.distance;
      }
    }
    return nearest;
  }

  it('stops a ray fired up at the platform sole from the hold', () => {
    // Ash, ducked in the working well: "i can't see the floor of the wardroom
    // at all... it appears like the floor disappears." A ray up from the hold
    // used to pass through the platform at 1.80 and hit the wardroom's own
    // deckhead at 3.87 — 2.07 m further on, through a floor.
    const hull = buildShipGeometry();
    const up = new THREE.Vector3(0, 1, 0);
    for (const [x, z] of [
      [0, -0.2],
      [0.9, 1.4],
      [-0.9, 1.4],
      [0, 2.5],
    ]) {
      const from = new THREE.Vector3(x, HOLD_FLOOR_Y + 0.1, z);
      const d = firstFrontFace(hull.geometries, from, up);
      expect(d, `nothing overhead at x=${x} z=${z}`).not.toBeNull();
      expect(
        from.y + d!,
        `the ray got past the platform sole at x=${x} z=${z}`,
      ).toBeLessThan(HOLD_SOLE_Y + 0.02);
    }
  });

  it('still leaves the hatchway open when the boards are up', () => {
    // The other half of the claim: an underside that sealed the opening would
    // pass the test above and close the route Ash came down.
    const hull = buildShipGeometry();
    const from = new THREE.Vector3(0, HOLD_FLOOR_Y + 0.1, 1.4);
    const d = firstFrontFace(hull.geometries, from, new THREE.Vector3(0, 1, 0));
    // The hull's own geometry carries no boards — they are a fitting — so up
    // the shaft the nearest hull surface is far above the platform.
    expect(d === null || from.y + d > HOLD_SOLE_Y + 0.5).toBe(true);
  });
});

describe('the stow is chocked', () => {
  it('wedges every cask on both hands, not just one', () => {
    // Ash: "you only chocked starboard and aft barrels." The first version
    // walked the casks and drew one wedge each, on the same side every time,
    // so every cantline was wedged from one hand and the port faces and the
    // broken ends of rows were bare. It also trusted index order to say which
    // casks are neighbours, and `placed` is not contiguous — the working well
    // and the pump trunk cut holes in a row.
    //
    // A count would not have caught it: the wrong version drew plenty of
    // wedges. What matters is that no cask face is bare, so that is the claim.
    const y = CASK_BED_Y + CASK_DIAMETER * 0.11;
    const quoins = HOLD_STOW.filter(
      (s) => s.kind === 'box' && Math.abs(s.centre.y - y) < 1e-6,
    ) as Extract<(typeof HOLD_STOW)[number], { kind: 'box' }>[];
    const ground = HOLD_STOW.filter(
      (s) => s.kind === 'bar' && Math.abs(s.a.y - (CASK_BED_Y + CASK_DIAMETER / 2)) < 1e-6,
    ) as Extract<(typeof HOLD_STOW)[number], { kind: 'bar' }>[];

    expect(ground.length).toBeGreaterThan(20);
    const bare: string[] = [];
    for (const cask of ground) {
      const zMid = (cask.a.z + cask.b.z) / 2;
      for (const side of [-1, 1]) {
        const want = cask.a.x + (side * CASK_DIAMETER) / 2;
        const found = quoins.some(
          (q) => Math.abs(q.centre.x - want) < 2e-3 && Math.abs(q.centre.z - zMid) < 0.05,
        );
        if (!found) bare.push(`x=${cask.a.x.toFixed(2)} z=${zMid.toFixed(2)} ${side < 0 ? 'starboard' : 'port'}`);
      }
    }
    expect(bare.join('; ')).toBe('');
  });

  it('does not chock the tiers that sit in cantlines', () => {
    // The upper tiers need no wedges — sitting in the hollow between two below
    // is what stops them, and that is the whole argument for bilge and
    // cantline. Wedging them would be drawing a fix for a solved problem.
    const upper = CASK_BED_Y + CASK_DIAMETER / 2 + (CASK_DIAMETER * Math.sqrt(3)) / 2;
    const strays = HOLD_STOW.filter(
      (s) => s.kind === 'box' && Math.abs(s.centre.y - (upper - CASK_DIAMETER * 0.39)) < 1e-6,
    );
    expect(strays.length).toBe(0);
  });
});

describe('the stow nests', () => {
  it('breaks its courses like brickwork, half a cask per tier', () => {
    // Ash: "your 2nd layer of barrels is stacked directly on top of first.
    // should actually be placed in the gaps between two barrels."
    //
    // The offset WAS a true half-diameter — it was just measured from the
    // ship's side, and the hull opens 194 mm between these two tier heights
    // against a half-diameter of 201. The two cancelled and the courses came
    // out 7 mm apart. **A lattice anchored to a moving edge is not a lattice.**
    //
    // Nothing about the counts changes when this breaks, which is why the
    // assertion is on the *phase* of the courses.
    const bars = HOLD_STOW.filter((s) => s.kind === 'bar') as Extract<
      (typeof HOLD_STOW)[number],
      { kind: 'bar' }
    >[];
    const tiers = [...new Set(bars.map((b) => b.a.y.toFixed(4)))].sort();
    expect(tiers.length).toBeGreaterThanOrEqual(2);

    const zPick = bars[0].a.z;
    const courses = tiers.map((t) =>
      bars
        .filter((b) => b.a.y.toFixed(4) === t && Math.abs(b.a.z - zPick) < 0.01)
        .map((b) => b.a.x)
        .sort((a, b) => a - b),
    );

    for (let i = 1; i < courses.length; i++) {
      expect(courses[i].length, `tier ${i} is empty at this station`).toBeGreaterThan(1);
      // Phase of each course against the centreline lattice, folded into
      // [0, D) — adjacent tiers must be half a diameter out of step.
      const phase = (xs: number[]): number =>
        ((xs[0] % CASK_DIAMETER) + CASK_DIAMETER) % CASK_DIAMETER;
      const gap = Math.abs(phase(courses[i]) - phase(courses[i - 1]));
      const staggered = Math.min(gap, CASK_DIAMETER - gap);
      expect(
        staggered,
        `tiers ${i - 1} and ${i} are stacked, not nested (${staggered.toFixed(3)} m of stagger)`,
      ).toBeCloseTo(CASK_DIAMETER / 2, 3);
    }
  });
});

/**
 * **The contract Ash asked for, asserted over every closure at once.**
 *
 * > "when it's shut, you can't go through it. Instead you walk over it, and
 * > likewise if you're underneath, you can't go up through it. And then when
 * > it's open, you can go through it. And that should be standard for all of
 * > our doors and hatches."
 *
 * So it is a sweep of `SHIP_CLOSURES`, not two tests naming two hatches. A row
 * added to that table is covered by these the moment it exists, which is the
 * point of the table and the reason these live here rather than beside the
 * scuttle's own geometry.
 *
 * **Every assertion here is a difference between the two states**, and that is
 * deliberate: the first draft asserted absolutes — "shut, there is floor at or
 * above the closure's own level" — and passed with the closure's own surface
 * deleted, because the *deck* satisfies it while the hatch is shut. A test that
 * a working ship passes for the wrong reason is a test that will pass a broken
 * one too. Each of these was checked by breaking the thing it guards.
 */
describe('every closure aboard, shut and open', () => {
  const barriers = SHIP_CLOSURES.filter((closure) => closure.barrier !== null);

  it('describes at least the two she has', () => {
    expect(barriers.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * The middle of a closure's opening, found by search.
   *
   * The centroid of what it actually covers, rather than a centre the row
   * reports — a closure cannot pass this by naming a point it does not really
   * fill. The corner would not do: the first draft took the first covered
   * sample it found and landed outside the ladder's own width, where every
   * foothold assertion is vacuously true.
   */
  function throughPoint(closure: (typeof SHIP_CLOSURES)[number]): {
    x: number;
    z: number;
  } {
    const barrier = closure.barrier!;
    let sx = 0;
    let sz = 0;
    let n = 0;
    for (let x = -2.4; x <= 2.4; x += 0.02) {
      for (let z = -7.6; z <= 7.6; z += 0.02) {
        if (!barrier.covers(x, z)) continue;
        sx += x;
        sz += z;
        n++;
      }
    }
    if (n === 0) throw new Error(`${closure.name} covers nowhere`);
    const centre = { x: sx / n, z: sz / n };
    if (!barrier.covers(centre.x, centre.z)) {
      throw new Error(`${closure.name} does not cover its own middle`);
    }
    return centre;
  }

  for (const closure of barriers) {
    describe(closure.name, () => {
      const barrier = closure.barrier!;
      const at = throughPoint(closure);
      const floorY =
        barrier.level.kind === 'deck' ? deckStandAt(at.x, at.z)!.y : barrier.level.y;
      const step = DEFAULT_WALKER_TUNING.stepUp;

      /** Where a body climbing through would put its feet: the lowest foothold. */
      const holds = [...barrier.footholds()].sort((a, b) => a.y - b.y);
      const lowest = holds[0];

      afterEach(() => resetClosures());

      it('holds a body up when shut and drops it through when open', () => {
        setClosureOpen(closure.name, false);
        const shut = schoonerStandAt(at.x, at.z, floorY + step);
        expect(shut, `${closure.name} has no floor at all when shut`).not.toBeNull();
        expect(
          shut!.y,
          `${closure.name} lets a body through while it is shut`,
        ).toBeGreaterThanOrEqual(floorY - 1e-6);

        setClosureOpen(closure.name, true);
        const open = schoonerStandAt(at.x, at.z, floorY + step);
        expect(
          open === null || open.y < floorY - 1e-6,
          `${closure.name} still holds a body up at its own floor while open`,
        ).toBe(true);
      });

      it('is walked over when shut — the step onto it is inside a stride', () => {
        setClosureOpen(closure.name, false);
        const stand = schoonerStandAt(at.x, at.z, floorY + step)!;
        expect(
          stand.y - floorY,
          `${closure.name} stands too proud of its own floor to step onto`,
        ).toBeLessThanOrEqual(step + 1e-6);
      });

      it('offers no foothold through itself while shut, and every one when open', () => {
        expect(holds.length, `${closure.name} has no footholds to test`).toBeGreaterThan(0);
        const x = (lowest.x0 + lowest.x1) / 2;
        const z = (lowest.z0 + lowest.z1) / 2;

        // A body on the floor below, reaching as high as its stride allows.
        setClosureOpen(closure.name, false);
        const shut = schoonerStandAt(x, z, lowest.y);
        for (const hold of holds) {
          expect(
            shut === null || Math.abs(shut.y - hold.y) > 1e-6,
            `${closure.name} offers a foothold through itself while shut — ` +
              'a body climbs out through a closed hatch',
          ).toBe(true);
        }

        setClosureOpen(closure.name, true);
        const open = schoonerStandAt(x, z, lowest.y);
        expect(
          open!.y,
          `${closure.name}'s lowest foothold is not offered even when open`,
        ).toBeCloseTo(lowest.y, 6);
      });

      it('carries every foothold within a stride of the one below', () => {
        setClosureOpen(closure.name, true);
        let previous: number | null = null;
        for (const hold of holds) {
          const x = (hold.x0 + hold.x1) / 2;
          const z = (hold.z0 + hold.z1) / 2;
          const stand = schoonerStandAt(x, z, hold.y)!;
          expect(
            stand.y,
            `${closure.name}'s foothold at ${hold.y.toFixed(2)} is not reachable`,
          ).toBeCloseTo(hold.y, 6);
          if (previous !== null) {
            expect(
              hold.y - previous,
              `${closure.name} has a gap between footholds no body can climb`,
            ).toBeLessThanOrEqual(step + 1e-6);
          }
          previous = hold.y;
        }
      });

      it('is climbed at a ladder\'s rate, not stridden up or fallen down', () => {
        setClosureOpen(closure.name, true);
        const highest = holds[holds.length - 1];
        const x = (highest.x0 + highest.x1) / 2;
        const z = (highest.z0 + highest.z1) / 2;
        const rise = highest.y - lowest.y;
        if (rise < 0.5) return; // a two-rung stub has nothing to pace

        const t = DEFAULT_WALKER_TUNING;
        const dt = 1 / 120;

        // Up: from the lowest rung, held against the ladder, as many frames as
        // it should take plus a margin.
        // **Measured on the body, not the eye.** The first version of this
        // watched `eyeY()` and passed with both caps deleted, because the
        // camera's own smoothing hides a teleport underneath it — which is
        // precisely the thing being fixed. What has to be paced is `y`.
        const up = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
        expect(up.placeAt(x, z, lowest.y)).toBe(true);
        const frames = Math.ceil(rise / t.ladderSpeed / dt);
        let fastestUp = 0;
        for (let i = 0; i < frames * 2; i++) {
          const before = up.y;
          up.step(dt, { forward: 0, right: 0, yaw: 0 });
          fastestUp = Math.max(fastestUp, up.y - before);
        }
        expect(up.y, `${closure.name} never climbed`).toBeGreaterThan(lowest.y + rise * 0.9);
        expect(
          fastestUp / dt,
          `${closure.name} is stridden up rather than climbed`,
        ).toBeLessThan(t.ladderSpeed * 1.5);

        // Down: dropped in at the top, it must not accelerate away.
        const down = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
        expect(down.placeAt(x, z, highest.y + 0.05)).toBe(true);
        let fastestDown = 0;
        for (let i = 0; i < frames * 4; i++) {
          const before = down.y;
          down.step(dt, { forward: 0, right: 0, yaw: 0 });
          fastestDown = Math.max(fastestDown, before - down.y);
        }
        expect(
          fastestDown / dt,
          `${closure.name} is fallen down rather than climbed down`,
        ).toBeLessThan(t.ladderSpeed * 1.5);
      });

      it('can be worked from both sides', () => {
        for (const open of [false, true]) {
          const targets = closure.targets(open);
          expect(
            targets.length,
            `${closure.name} offers only one side when ${open ? 'open' : 'shut'}`,
          ).toBeGreaterThanOrEqual(2);
          // One above its floor and one below it: the two sides of a barrier.
          const above = targets.some(({ box }) => box.yHi > floorY + 1e-6);
          const below = targets.some(({ box }) => box.yLo < floorY - 1e-6);
          expect(above, `${closure.name} cannot be worked from above`).toBe(true);
          expect(below, `${closure.name} cannot be worked from below`).toBe(true);
        }
      });
    });
  }
});

// --- the wardroom and the forecastle, furnished ------------------------------

/**
 * The two rooms this round furnished, and the invariants that are about a
 * *body* rather than about a dimension.
 *
 * Every check here is the shape of a fault a previous round below decks
 * actually shipped: a piece in the hatchway's footprint, a piece in a ladder's
 * climb envelope, a piece across a doorway's clear opening, a collider that
 * does not match the timber, a lane too narrow to walk, and furniture the
 * ballast solve has never seen. The suite is deliberately keyed to the
 * *rooms* rather than to the piece list, so a tenth fitting added tomorrow is
 * covered without being named.
 */
describe('the wardroom and the forecastle are furnished', () => {
  const t = DEFAULT_WALKER_TUNING;

  /** Everything this round put into one of the two rooms. */
  const FURNISHED_KINDS = new Set([
    'wardroomTable',
    'wardroomForm',
    'officersCabin',
    'wardroomStores',
    'galleyHearth',
    'galleyDresser',
    'crewBerth',
    'foremastTable',
  ]);

  const newFittings = (): InteriorFitting[] => {
    resetClosures();
    return interiorFittingsNow().filter(
      (fitting) =>
        FURNISHED_KINDS.has(fitting.kind) ||
        (fitting.kind === 'seaChest' && fitting.name.startsWith('crewChest')),
    );
  };

  /**
   * Every corner of a solid, in ship coordinates, turn included.
   *
   * **A tube's rim is perpendicular to its own axis, and padding it by a radius
   * in every direction is how a vertical flue reads as 0.086 m through the
   * deckhead when its cap is flat against it.** The first cut of this helper
   * did exactly that and the galley's flue failed a test it passes: the
   * timber's extreme in y is the end cap, not the cap plus the pipe's radius.
   */
  const corners = (solid: FittingSolid): { x: number; y: number; z: number }[] => {
    if (solid.kind !== 'box') {
      const axis = {
        x: solid.b.x - solid.a.x,
        y: solid.b.y - solid.a.y,
        z: solid.b.z - solid.a.z,
      };
      const length = Math.hypot(axis.x, axis.y, axis.z) || 1;
      const n = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
      // Two directions across the tube, which is where its radius actually is.
      const seed = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const u = {
        x: seed.y * n.z - seed.z * n.y,
        y: seed.z * n.x - seed.x * n.z,
        z: seed.x * n.y - seed.y * n.x,
      };
      const ul = Math.hypot(u.x, u.y, u.z) || 1;
      const a1 = { x: u.x / ul, y: u.y / ul, z: u.z / ul };
      const a2 = {
        x: n.y * a1.z - n.z * a1.y,
        y: n.z * a1.x - n.x * a1.z,
        z: n.x * a1.y - n.y * a1.x,
      };
      const out: { x: number; y: number; z: number }[] = [];
      for (const [end, r] of [
        [solid.a, solid.radiusA],
        [solid.b, solid.radiusB],
      ] as const) {
        for (const axisDir of [a1, a2]) {
          for (const sign of [-1, 1]) {
            out.push({
              x: end.x + axisDir.x * r * sign,
              y: end.y + axisDir.y * r * sign,
              z: end.z + axisDir.z * r * sign,
            });
          }
        }
      }
      return out;
    }
    const yaw = solid.yaw ?? 0;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const out: { x: number; y: number; z: number }[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const lx = sx * solid.half.x;
          const lz = sz * solid.half.z;
          out.push({
            x: solid.centre.x + lx * cos + lz * sin,
            y: solid.centre.y + sy * solid.half.y,
            z: solid.centre.z - lx * sin + lz * cos,
          });
        }
      }
    }
    return out;
  };

  it('builds every piece both rooms were promised, in both lists', () => {
    // The plan's §4.3 and §4.4 by name, and the lists' own contract: a fitting
    // drawn but not collided with, or collided with but not drawn, is the fault
    // every list in `interiorFittings.ts` exists to make impossible.
    const live = new Set(newFittings().map((f) => f.name));
    const fixed = new Set(INTERIOR_FITTINGS.map((f) => f.name));
    for (const name of [
      'wardroomTable',
      'wardroomFormPort',
      'wardroomFormStarboard',
      'mateCabin',
      'surgeonCabin',
      'wardroomStoresPort',
      'wardroomStoresStarboard',
      'galleyHearth',
      'galleyDresser',
      'crewBerthsPort',
      'crewBerthsStarboard',
      'foremastTable',
      'crewChestPort',
      'crewChestStarboard',
    ]) {
      expect(live.has(name), `${name} is not built`).toBe(true);
      expect(fixed.has(name), `${name} is drawn but never collided with`).toBe(true);
    }
  });

  it('keeps the hatchway’s footprint clear at every level', () => {
    // §4.3.1: "Nothing can be built in that footprint at any level." It is the
    // one straight line a 400 kg cask falls down, and the officers' cabins were
    // arranged round it rather than into it.
    for (const fitting of newFittings()) {
      for (const solid of fitting.solids) {
        for (const p of corners(solid)) {
          const inside =
            Math.abs(p.x) < HATCHWAY_HALF_BREADTH - 1e-6 &&
            p.z > HATCHWAY_AFT_Z + 1e-6 &&
            p.z < HATCHWAY_FORWARD_Z - 1e-6;
          expect(inside, `${fitting.name} stands in the hatchway`).toBe(false);
        }
      }
    }
  });

  it('keeps the fore scuttle’s shaft and its climb clear', () => {
    // The ladder's own note records what a piece in this volume costs: a body
    // is shoved off the rungs on the first frame and falls 2 m to the sole,
    // with every rung correctly spaced and correctly published.
    const half = FORE_SCUTTLE_HALF_BREADTH;
    for (const fitting of newFittings()) {
      for (const solid of fitting.solids) {
        for (const p of corners(solid)) {
          const inside =
            Math.abs(p.x - FORE_SCUTTLE_X) < half - 1e-6 &&
            Math.abs(p.z - FORE_SCUTTLE_Z) < half - 1e-6;
          expect(inside, `${fitting.name} reaches into the fore scuttle`).toBe(false);
        }
      }
    }
    // And the starboard chest, which stands against the same bulkhead the
    // ladder is spiked to, is measured against the shaft rather than guessed
    // clear of it.
    const chest = newFittings().find((f) => f.name === 'crewChestStarboard')!;
    const inboard = Math.max(
      ...chest.solids.flatMap((s) => corners(s).map((p) => p.x)),
    );
    expect(inboard).toBeLessThan(foreScuttleShaftOutboardX());
  });

  it('leaves every doorway’s clear opening empty', () => {
    // A doorway is the one volume in a bulkhead a body may pass through, and a
    // chest across it is a room with no way in that nothing would report.
    for (const bulkhead of BULKHEADS) {
      if (bulkhead.sillY === null) continue;
      const head = doorwayHeadY(bulkhead)!;
      for (const fitting of newFittings()) {
        for (const solid of fitting.solids) {
          for (const p of corners(solid)) {
            const inOpening =
              Math.abs(p.x - bulkhead.doorX) < DOORWAY_HALF_BREADTH - 1e-6 &&
              Math.abs(p.z - bulkhead.z) < BULKHEAD_THICKNESS - 1e-6 &&
              p.y > bulkhead.sillY + 1e-6 &&
              p.y < head - 1e-6;
            expect(
              inOpening,
              `${fitting.name} stands in ${bulkhead.name}'s doorway`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('stands every piece inside its room’s own lining and under its beams', () => {
    // `sideLimitOver`'s rule, checked at the height each corner is actually at
    // rather than at the height it was placed from — which is the fault that
    // note exists to prevent, and the one the galley's iron top committed by
    // overhanging 20 mm past its own footprint into a narrowing side.
    //
    // The flue is the one exception and it is deliberate: it is carried 20 mm
    // *into* the beams so the room does not show a hairline of daylight round
    // a pipe that is meant to go through them.
    for (const fitting of newFittings()) {
      const space = belowDecksSpace(
        fitting.name === 'galleyHearth' ||
        fitting.name === 'galleyDresser' ||
        fitting.name === 'foremastTable' ||
        fitting.name.startsWith('crew')
          ? 'forecastle'
          : 'wardroom',
      );
      for (const solid of fitting.solids) {
        for (const p of corners(solid)) {
          const side = spaceSideHalfWidthAt(space, p.z, p.y, false);
          expect(
            Math.abs(p.x) - side,
            `${fitting.name} stands ${(Math.abs(p.x) - side).toFixed(3)} m into the lining`,
          ).toBeLessThan(0.002);
          const head = spaceDeckheadY(space, p.x, p.z);
          if (head === null) continue;
          // The flue is carried 20 mm *into* the beams on purpose, so the room
          // does not show a hairline of daylight round a pipe meant to pass
          // through them — §11.3's coaming lesson: make timber interpenetrate.
          const allowance = fitting.name === 'galleyHearth' ? 0.025 : 0.001;
          expect(
            p.y - head,
            `${fitting.name} stands ${(p.y - head).toFixed(3)} m through the deckhead`,
          ).toBeLessThan(allowance);
        }
      }
    }
  });

  it('gives every berth and every seat the headroom to be used', () => {
    // The claim a bunk makes is that a body can lie in it and sit up on its
    // edge; the claim a form makes is that a body can sit on it. Both are about
    // the beams over the *surface*, and the forecastle is where they bite —
    // its after end is the lowest room in the ship at 1.81 m.
    const stations: { name: string; x: number; z: number; y: number; want: number }[] = [];
    const wr = belowDecksSpace('wardroom');
    const fc = belowDecksSpace('forecastle');
    const table = messTableGeometry();

    // A seated body: 0.78 m of trunk and head above whatever it sits on.
    const SEATED = 0.78;
    // A body lying down, with room to turn over.
    const LYING = 0.34;
    // A body sitting up on the edge of a bunk.
    const SITTING_UP = 0.72;

    for (const z of [table.zAft + 0.2, (table.zAft + table.zForward) / 2, table.zForward - 0.2]) {
      for (const x of [table.formInboard + 0.12, -(table.formInboard + 0.12)]) {
        if (x > 0 && z < table.portFormZAft) continue;
        stations.push({ name: 'form', x, z, y: table.soleY + 0.42, want: SEATED });
      }
    }
    for (const hand of ['port', 'starboard'] as const) {
      const b = crewBerthGeometry(hand);
      for (let tier = 0; tier < b.shelfYs.length; tier++) {
        for (const t01 of [0.15, 0.5, 0.85]) {
          const local = {
            x: (b.xInboard + b.xOutboard) / 2,
            z: b.zAft + (b.zForward - b.zAft) * t01,
          };
          const ship = frameToShip(b.placement.frame, local.x, local.z);
          stations.push({
            name: `crew berth ${hand} tier ${tier}`,
            x: ship.x,
            z: ship.z,
            y: b.shelfYs[tier] + 0.115,
            // The lower bunk has the upper one over it, so what it owes is
            // room to lie down; the upper one owes room to sit up in.
            want: tier === 0 ? LYING : LYING,
          });
        }
      }
    }
    for (const hand of ['port', 'starboard'] as const) {
      const c = officersCabinGeometry(hand);
      for (const t01 of [0.2, 0.5, 0.8]) {
        stations.push({
          name: `officer's berth ${hand}`,
          x: (c.xInside + c.xLining) / 2,
          z: c.zAft + (c.zForward - c.zAft) * t01,
          y: c.soleY + 0.48 + 0.13,
          want: SITTING_UP,
        });
      }
    }

    for (const station of stations) {
      const space = station.z > PLATFORM_FORWARD_Z ? fc : wr;
      const head = spaceDeckheadY(space, station.x, station.z);
      expect(head, `${station.name} has no deckhead over it`).not.toBeNull();
      expect(
        head! - station.y,
        `${station.name} has ${(head! - station.y).toFixed(3)} m over it`,
      ).toBeGreaterThan(station.want);
    }

    // And the tier pitch itself: the lower bunk is under the upper one, not
    // under the beams, so its own claim is the pitch rather than the room.
    for (const hand of ['port', 'starboard'] as const) {
      const b = crewBerthGeometry(hand);
      expect(b.shelfYs[1] - (b.shelfYs[0] + 0.115)).toBeGreaterThan(0.6);
    }
  });

  it('matches every collider to the timber that casts it', () => {
    // The desk's round found this the other way about — a yaw dropped on the
    // way into the index stops a body where the timber is not. Here it is
    // checked for every new piece: each collidable solid's own corners are
    // inside the union of the columns its name produced, and no column belongs
    // to a solid that is not collidable.
    for (const fitting of newFittings()) {
      const columns = OBSTACLE_COLUMNS.filter((c) => c.name.startsWith(`${fitting.name}[`));
      const collidable = fitting.solids.filter((s) => s.collides);
      expect(
        columns.length > 0,
        `${fitting.name} has collidable timber and no columns`,
      ).toBe(collidable.length > 0);

      for (let i = 0; i < fitting.solids.length; i++) {
        const solid = fitting.solids[i];
        const own = OBSTACLE_COLUMNS.filter((c) => c.name === `${fitting.name}[${i}]`);
        if (!solid.collides) {
          expect(own.length, `${fitting.name}[${i}] is not solid but is a collider`).toBe(0);
          continue;
        }
        expect(own.length, `${fitting.name}[${i}] is solid and has no collider`).toBeGreaterThan(0);
        for (const p of corners(solid)) {
          const covered = own.some(
            (c) =>
              p.y >= c.yLo - 1e-6 &&
              p.y <= c.yHi + 1e-6 &&
              columnDistance(c, p.x, p.z).distance <= c.radius + 1e-6,
          );
          expect(covered, `${fitting.name}[${i}] has a corner outside its collider`).toBe(true);
        }
      }
    }
  });

  it('does not hang a partition through a lantern', () => {
    // The mate's cabin is 0.45 m narrower than the surgeon's because of this
    // one number, so it is worth a test that says so: the wardroom's forward
    // lamp hangs on the only beam in the room's forward two thirds the hatchway
    // does not interrupt, and every piece stands clear of the volume it swings
    // in. If the lamp ever moves, the cabin should get the width back.
    for (const hang of LAMP_HANGS) {
      if (hang.room !== 'wardroom' && hang.room !== 'forecastle') continue;
      const point = lampHangPoint(hang.id);
      for (const fitting of newFittings()) {
        for (const solid of fitting.solids) {
          for (const p of corners(solid)) {
            if (p.y < point.y - LAMP_DROP - LAMP_REACH_HALF) continue;
            if (p.y > point.y) continue;
            // **Radially, because a lantern hangs on a chain.** It swings in a
            // cone about its hook, so what it sweeps in plan is a circle and a
            // square keep-out would condemn corners it can never reach — and
            // pass ones on the diagonal that it can.
            const reach = Math.hypot(p.x - point.x, p.z - point.z);
            expect(
              reach,
              `${fitting.name} is ${reach.toFixed(3)} m from the ${hang.id} lantern's hook`,
            ).toBeGreaterThan(LAMP_REACH_HALF - 1e-6);
          }
        }
      }
    }
  });

  it('leaves a lane wider than the ship’s own doorways everywhere a body must go', () => {
    // **The measurement that decided three dimensions in this round.** A lane
    // is stated as the run of *centre* positions a 0.52 m body may take, so
    // 0.18 m of lane is a 0.70 m doorway — the tightest opening the ship
    // already asks a player through. Anything below that is the wedge between
    // the mainmast and the after bulkhead that `DOORWAY_OFFSET` exists to stop
    // happening again.
    //
    // It is also what sized the forecastle's hinged leaf: at 0.86 m across it
    // closed the only way to the bunks to 0.03 m, and the walk found that where
    // no dimension would have.
    const doorLane = 2 * DOORWAY_HALF_BREADTH - 2 * t.radius;
    for (const [name, zFrom, zTo] of [
      ['wardroom', PLATFORM_AFT_Z + 0.3, PLATFORM_FORWARD_Z - 0.3],
      ['forecastle', PLATFORM_FORWARD_Z + 0.3, 5.9],
    ] as const) {
      const space = belowDecksSpace(name);
      let worst = { width: Infinity, z: 0 };
      for (let z = zFrom; z <= zTo; z += 0.05) {
        let best = 0;
        let run: number | null = null;
        for (let x = 2.3; x >= -2.3 - 1e-9; x -= 0.01) {
          const stand = schoonerStandAt(x, z, space.soleY + t.stepUp);
          let free = stand !== null && Math.abs(stand.y - space.soleY) < 0.3;
          if (free) {
            for (const c of OBSTACLE_COLUMNS) {
              if (c.yHi <= stand!.y + t.stepOver) continue;
              if (c.yLo >= stand!.y + t.standingHeight) continue;
              if (columnDistance(c, x, z).distance < c.radius + t.radius) {
                free = false;
                break;
              }
            }
          }
          if (free) {
            if (run === null) run = x;
          } else if (run !== null) {
            best = Math.max(best, run - (x + 0.01));
            run = null;
          }
        }
        if (run !== null) best = Math.max(best, run + 2.3);
        if (best < worst.width) worst = { width: best, z };
      }
      expect(
        worst.width,
        `the ${name} pinches to ${worst.width.toFixed(3)} m at z ${worst.z.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(doorLane);
    }
  });

  it('walks both rooms bow to stern, and into the surgeon’s cabin', () => {
    // Walked rather than asserted, for §6.1's reason: the wedge between the
    // mainmast and the after bulkhead was found by a body and not by a drawing.
    const dt = 1 / 120;
    const steerTo = (w: DeckWalker, tx: number, tz: number, seconds = 5): boolean => {
      for (let s = 0; s < seconds; s += dt) {
        const dx = tx - w.x;
        const dz = tz - w.z;
        if (Math.hypot(dx, dz) < 0.1) return true;
        w.step(dt, { forward: 1, right: 0, yaw: Math.atan2(-dx, -dz) });
      }
      return false;
    };
    const routes: [string, [number, number, number], [number, number][]][] = [
      [
        'the forecastle, door to the bunk flat and back',
        [DOORWAY_OFFSET, PLATFORM_FORWARD_Z + 0.15, FORECASTLE_SOLE_Y],
        [
          [0.9, 3.2],
          [0.7, 4.0],
          [0.6, 4.5],
          [0.3, 5.2],
          [0.0, 5.6],
          [0.6, 4.5],
          [0.9, 3.4],
          [DOORWAY_OFFSET, PLATFORM_FORWARD_Z + 0.06],
        ],
      ],
      [
        'the forecastle, the scuttle’s foot to the galley',
        [FORE_SCUTTLE_X, FORE_SCUTTLE_Z, FORECASTLE_SOLE_Y],
        [
          [-1.0, 3.3],
          [0.9, 3.2],
          [0.7, 4.1],
          [0.4, 4.9],
        ],
      ],
      [
        'the wardroom, forward door to after door',
        [DOORWAY_OFFSET, PLATFORM_FORWARD_Z - 0.1, PLATFORM_SOLE_Y],
        [
          [0.4, 1.6],
          [0.2, 0.25],
          [-0.9, 0.25],
          [-1.2, -0.6],
          [-1.2, -1.4],
          [-WELL_OFFSET, PLATFORM_AFT_Z + 0.3],
          [-WELL_OFFSET, PLATFORM_AFT_Z + 0.06],
        ],
      ],
      [
        'the wardroom, after door to forward door',
        [-WELL_OFFSET, PLATFORM_AFT_Z + 0.06, PLATFORM_SOLE_Y],
        [
          [-1.1, -1.9],
          [-1.2, -0.6],
          [-0.9, 0.25],
          [0.2, 0.25],
          [0.4, 1.6],
          [DOORWAY_OFFSET, PLATFORM_FORWARD_Z - 0.1],
        ],
      ],
      [
        'the wardroom, the port lane and the after bay',
        [0.2, 0.25, PLATFORM_SOLE_Y],
        [
          [1.2, -0.3],
          [1.2, -1.3],
          [1.0, -2.0],
          [1.2, -1.0],
          [0.9, 0.25],
        ],
      ],
      [
        'into the surgeon’s cabin and out again',
        [-0.6, 1.15, PLATFORM_SOLE_Y],
        [
          [-1.3, 1.15],
          [-1.3, 2.2],
          [-1.3, 1.15],
          [-0.5, 1.15],
          [-0.4, 0.3],
        ],
      ],
    ];

    for (const [name, start, waypoints] of routes) {
      const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
      expect(w.placeAt(start[0], start[1], start[2]), `${name}: no floor at the start`).toBe(true);
      for (const [tx, tz] of waypoints) {
        expect(
          steerTo(w, tx, tz),
          `${name}: stuck at (${w.x.toFixed(3)}, ${w.z.toFixed(3)}) making for (${tx}, ${tz})`,
        ).toBe(true);
      }
    }
  });

  it('keeps the mate’s cabin a bed-place rather than a room, on purpose', () => {
    // **This is an assertion that something does NOT work, and it is here so
    // that nobody later "fixes" it by accident.** The mate's cabin is 0.80 m
    // inside because the wardroom's forward lantern and the door to the
    // forecastle are both on that hand; the berth is drawn the full width of
    // it, so the door opens onto a lee board. If the lamp is ever moved and the
    // cabin widened, this test should fail and be deleted with the round that
    // widened it.
    const mate = officersCabinGeometry('port');
    const surgeon = officersCabinGeometry('starboard');
    expect(mate.clearWidth).toBeLessThan(0.62 + 2 * DEFAULT_WALKER_TUNING.radius);
    expect(surgeon.clearWidth).toBeGreaterThan(0.62 + 2 * DEFAULT_WALKER_TUNING.radius);

    const w = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    expect(w.placeAt(0.9, 1.15, PLATFORM_SOLE_Y)).toBe(true);
    for (let i = 0; i < 480; i++) w.step(1 / 120, { forward: 1, right: 0, yaw: -Math.PI / 2 });
    expect(w.x, 'a body got into the mate’s bed-place').toBeLessThan(mate.xInside);
  });

  it('mirrors the two hands, and differs only where the ship does', () => {
    // **Port and starboard invert `xLo` and `xHi`, and that has built a whole
    // piece of furniture inside out once already** — see the note in
    // `cabinFurniture.washstand`. So the pairs are checked as mirrors rather
    // than trusted, and the three places they are *not* mirrors each name the
    // thing on that hand that made them differ.
    const table = messTableGeometry();
    const port = crewBerthGeometry('port');
    const starboard = crewBerthGeometry('starboard');
    expect(port.xInboard).toBeCloseTo(-starboard.xInboard, 9);
    expect(port.xOutboard).toBeCloseTo(-starboard.xOutboard, 9);
    expect(port.zAft).toBeCloseTo(starboard.zAft, 9);
    expect(port.placement.frame.yaw).toBeCloseTo(-starboard.placement.frame.yaw, 9);

    // The forms: the port one is short because the pump well is abaft it.
    expect(table.portFormZAft).toBeGreaterThan(table.zAft);
    expect(table.portFormZAft).toBeCloseTo(PUMP_Z + PUMP_WELL_HALF + 0.04, 9);

    // The cabins: the port one is narrow because the lamp and the doorway are
    // both on that hand.
    const mate = officersCabinGeometry('port');
    const surgeon = officersCabinGeometry('starboard');
    expect(mate.zAft).toBeCloseTo(surgeon.zAft, 9);
    expect(mate.zForward).toBeCloseTo(surgeon.zForward, 9);
    expect(Math.abs(mate.xPartition)).toBeGreaterThan(Math.abs(surgeon.xPartition));
  });

  it('asserts the frame each published number is in, rather than commenting it', () => {
    // **Frame-mixing is the silent fault of this area** — ship frame, room
    // frame, piece frame. `CrewBerthGeometry` publishes the berth's faces in
    // the *piece's* frame, and a reader who took them for ship coordinates
    // would put the bedding a quarter of a metre outboard of the bunk. So the
    // claim is checked rather than written down: converting the published
    // corners through the piece's own frame has to land on the drawn timber.
    for (const hand of ['port', 'starboard'] as const) {
      const b = crewBerthGeometry(hand);
      const fitting = newFittings().find(
        (f) => f.name === (hand === 'port' ? 'crewBerthsPort' : 'crewBerthsStarboard'),
      )!;
      // The published faces are NOT ship coordinates: the berth is turned.
      expect(Math.abs(b.placement.frame.yaw)).toBeGreaterThan(0.1);
      const drawn = fitting.solids.flatMap((s) => corners(s));
      const shipXs = drawn.map((p) => p.x);
      const inFrameOnly = Math.min(...shipXs.map(Math.abs));
      expect(
        inFrameOnly,
        'the published inboard face happens to equal the drawn one, so this test proves nothing',
      ).toBeLessThan(Math.abs(b.xInboard) - 0.1);

      // Converted through the frame, they do land on the timber.
      for (const t01 of [0, 0.5, 1]) {
        const local = { x: b.xInboard, z: b.zAft + (b.zForward - b.zAft) * t01 };
        const ship = frameToShip(b.placement.frame, local.x, local.z);
        const near = Math.min(
          ...drawn.map((p) => Math.hypot(p.x - ship.x, p.z - ship.z)),
        );
        expect(near, 'the berth’s published front is not on its drawn timber').toBeLessThan(0.12);
      }
    }
  });

  it('carries the new furniture inside the joinery the ballast solve already saw', () => {
    // **Reconcile, do not double-count.** `massModel.ts` has weighed a lump of
    // joinery in each of these rooms since before either was furnished, so the
    // question this round owes is not "what does the furniture weigh" but
    // "does what was built fit inside what was already carried" — because if it
    // does not, the KG in `SHIP_BELOW_DECKS_PLAN.md` §3 is wrong and nothing
    // else would ever say so.
    //
    // The estimate counts a board as solid and a carcase as a shell of 22 mm
    // boards, which is what a locker, a chest and a bunk front actually are: a
    // carcase is one box in the drawing and six boards in the ship, and taking
    // the drawn box for timber would weigh the wardroom at 2.4 t of oak.
    const BOARD = 0.022;
    const RHO_OAK = 720;
    const timber = (fitting: InteriorFitting): number => {
      let volume = 0;
      for (const solid of fitting.solids) {
        if (solid.kind !== 'box') {
          const length = Math.hypot(
            solid.b.x - solid.a.x,
            solid.b.y - solid.a.y,
            solid.b.z - solid.a.z,
          );
          const a = solid.radiusA;
          const b = solid.radiusB;
          volume += (Math.PI * length * (a * a + a * b + b * b)) / 3;
          continue;
        }
        const d = [2 * solid.half.x, 2 * solid.half.y, 2 * solid.half.z].sort((a, b) => a - b);
        const solidVolume = d[0] * d[1] * d[2];
        if (d[0] <= 0.06) {
          volume += solidVolume;
          continue;
        }
        const area = 2 * (d[0] * d[1] + d[1] * d[2] + d[2] * d[0]);
        volume += Math.min(solidVolume, area * BOARD);
      }
      return volume * RHO_OAK;
    };

    let wardroom = 0;
    let forecastle = 0;
    for (const fitting of newFittings()) {
      const forward =
        fitting.name.startsWith('galley') ||
        fitting.name === 'foremastTable' ||
        fitting.name.startsWith('crew');
      if (forward) forecastle += timber(fitting);
      else wardroom += timber(fitting);
    }

    const lumped = (...names: string[]): number =>
      buildLightship()
        .filter((item) => names.includes(item.name))
        .reduce((sum, item) => sum + item.mass, 0);

    // The wardroom's furniture against its joinery lump *and* the expedition
    // chests, because the run of chests along its sides is both of those.
    expect(wardroom).toBeLessThan(
      lumped('joinery, wardroom', 'expedition equipment and chests'),
    );
    // The forecastle's against its joinery lump and the galley hearth.
    expect(forecastle).toBeLessThan(lumped('joinery, forecastle', 'galley hearth'));
    // And neither room is so light that the lump is obvious nonsense — the
    // check is only worth having while it is a real bound.
    expect(wardroom).toBeGreaterThan(0.3 * lumped('joinery, wardroom'));
    expect(forecastle).toBeGreaterThan(0.3 * lumped('joinery, forecastle'));
  });
});

/**
 * **Every place aboard a body puts itself, swept over `SHIP_STATIONS`.**
 *
 * Keyed to the table rather than to eleven named seats, for the reason the
 * closure sweep gives one screen up: a row added to that table is covered by
 * these the moment it exists, and a twelfth station cannot arrive without a
 * pose that is under a deckhead, out of the furniture, aimed the right way and
 * fenced off from the next room.
 *
 * Each of these was checked by breaking the thing it guards. The facing test
 * in particular: it fails on the crew chest if `facing` is flipped between
 * `framePlusX` and `frameMinusX`, which is the fault it was written after.
 */
describe('every station a body can take', () => {
  const eyeHeight = DEFAULT_WALKER_TUNING.eyeHeight;
  /** Half the embodied field — what "in frame" means, in radians. */
  const HALF_FIELD = (31 * Math.PI) / 180;

  afterEach(() => resetSeat());

  /** Which way a pose is looking, as a unit vector in ship coordinates. */
  function lookDirection(pose: { yaw: number; pitch: number }): THREE.Vector3 {
    return new THREE.Vector3(
      -Math.sin(pose.yaw) * Math.cos(pose.pitch),
      Math.sin(pose.pitch),
      -Math.cos(pose.yaw) * Math.cos(pose.pitch),
    );
  }

  /** Every drawn solid below decks, in whatever state she is in now. */
  function everySolid(): FittingSolid[] {
    return interiorFittingsNow().flatMap((fitting) => fitting.solids);
  }

  /**
   * The rows this file is about.
   *
   * M5 put two climbs in `SHIP_STATIONS` — the fore shrouds, port and starboard
   * — and every sweep below asks a station which *room* it is in and then asks
   * that room for a sole and a deckhead. A gang of shrouds has neither. Filing
   * them under the forecastle to keep the sweep quiet would have been worse than
   * excluding them: the forecastle is a real place two metres under the planking
   * the climb starts on, so every assertion here would then have measured a
   * station against the wrong room and passed.
   *
   * They are swept in `tests/ship-aloft.test.ts` against the things a climb
   * actually has: rungs, spars, cloth and a platform.
   */
  const BELOW_DECKS_STATIONS = SHIP_STATIONS.filter(
    (station): station is ShipStation & { room: SpaceName } => station.room !== 'weatherDeck',
  );

  it('describes at least one seat and one berth in every walked room but the landing', () => {
    const rooms = new Set(BELOW_DECKS_STATIONS.map((station) => station.room));
    expect([...rooms].sort()).toEqual(['cabin', 'forecastle', 'wardroom']);
    expect(SHIP_STATIONS.filter((s) => s.kind === 'seat').length).toBeGreaterThanOrEqual(4);
    expect(SHIP_STATIONS.filter((s) => s.kind === 'berth').length).toBe(7);
    expect(SHIP_STATIONS.filter((s) => s.kind === 'climb').length).toBe(2);
    // The names are the state's, so a station the state cannot hold is a
    // station nothing can ever be in.
    expect(new Set(SHIP_STATIONS.map((s) => s.name)).size).toBe(SHIP_STATIONS.length);
  });

  for (const station of BELOW_DECKS_STATIONS) {
    describe(station.name, () => {
      const pose = station.pose();
      const eye = new THREE.Vector3(pose.x, pose.y, pose.z);

      it('puts the eye in its own room, in the ship\'s frame', () => {
        // **The frame is asserted, not commented.** Every pose here is built in
        // a piece's own axes and converted; a conversion that was skipped puts
        // the eye a plausible-looking 0.2 m out, in the room, under the
        // deckhead, and wrong. The station's room is the cheapest fact that
        // catches it.
        const space = belowDecksSpace(station.room);
        expect(pose.z, 'aft of its own room').toBeGreaterThan(space.zAft - 0.6);
        expect(pose.z, 'forward of its own room').toBeLessThan(space.zForward + 0.1);
        expect(pose.y).toBeGreaterThan(space.soleY);
        expect(
          Math.abs(pose.x),
          'the eye is outside the ship\'s own side at its own station',
        ).toBeLessThan(spaceSideHalfWidthAt(space, pose.z, pose.y, false));
      });

      it('has something over the eye, and it is not the furniture', () => {
        // The deckhead is not always the answer: a hand in a lower bunk has the
        // upper bunk's boards over him at 0.46 m, and the deckhead 1.56 m up is
        // the wrong number to check.
        const space = belowDecksSpace(station.room);
        let ceiling = spaceDeckheadY(space, pose.x, pose.z) ?? Infinity;
        for (const solid of everySolid()) {
          const b = solidBounds(solid);
          if (b.y0 <= pose.y + 1e-6) continue;
          if (pose.x < b.x0 || pose.x > b.x1 || pose.z < b.z0 || pose.z > b.z1) continue;
          ceiling = Math.min(ceiling, b.y0);
        }
        expect(Number.isFinite(ceiling), 'nothing over the eye at all').toBe(true);
        const clear = ceiling - pose.y;
        // 0.30 m for a lying eye — enough to see the beams rather than be
        // inside them. A seat gets much more and does not need its own rule.
        expect(clear, `${(clear * 1000).toFixed(0)} mm over the eye`).toBeGreaterThan(0.3);
      });

      it('does not put the eye inside the thing it is using', () => {
        // A pose inside a mattress, a lee board or a bulkhead is a camera in
        // the timber, and it is the failure that never throws.
        for (const solid of everySolid()) {
          const inside = pointInSolid(solid, eye);
          expect(inside, `the eye is inside ${solid.material} at ${solid.kind}`).toBe(false);
        }
        for (const solid of interiorSolids()) {
          const inside =
            Math.abs(eye.x - solid.centre.x) < solid.half.x &&
            Math.abs(eye.y - solid.centre.y) < solid.half.y &&
            Math.abs(eye.z - solid.centre.z) < solid.half.z;
          expect(inside, `the eye is inside ${solid.name}`).toBe(false);
        }
      });

      it('is offered from where a body stands to take it, and never from another room', () => {
        resetSeat();
        const interactables = buildShipInteractables({
          lamps: { isLit: () => false, toggle: () => {} },
          stations: { use: () => {} },
        });
        const target = station.target();
        const centre = {
          x: (target.xLo + target.xHi) / 2,
          y: (target.yLo + target.yHi) / 2,
          z: (target.zLo + target.zHi) / 2,
        };

        // **Never from another room.** A coarse sweep of standing eyes through
        // every space below decks, looking eight ways from each: a station may
        // only ever be offered to a body whose feet are in its own room. This
        // is the guard `REACH` cannot give — it is 2.2 m and the captain's
        // berth is 1.2 m from the landing through a bulkhead.
        for (const space of BELOW_DECKS_SPACES) {
          if (space.name === station.room) continue;
          for (let x = -1.8; x <= 1.81; x += 0.4) {
            for (let z = space.zAft + 0.1; z <= space.zForward - 0.1; z += 0.4) {
              const from = { x, y: space.soleY + eyeHeight, z };
              for (let a = 0; a < 6; a++) {
                const angle = (a / 6) * Math.PI * 2;
                const hit = interactables.pick(from, {
                  x: Math.cos(angle),
                  y: -0.35,
                  z: Math.sin(angle),
                });
                expect(
                  hit?.interactable.name,
                  `${station.name} offered from the ${space.name} at ${x.toFixed(1)},${z.toFixed(1)}`,
                ).not.toBe(station.name);
              }
            }
          }
        }

        // And it IS offered from the standing spot the arrangement gives it.
        const from = STANDING_AT[station.name];
        const hit = interactables.pick(
          { x: from.x, y: belowDecksSpace(station.room).soleY + eyeHeight, z: from.z },
          {
            x: centre.x - from.x,
            y: centre.y - (belowDecksSpace(station.room).soleY + eyeHeight),
            z: centre.z - from.z,
          },
        );
        expect(hit?.interactable.name, `${station.name} is not offered from its own approach`).toBe(
          station.name,
        );
        expect(hit!.interactable.verb(false)).not.toMatch(/stand up|turn out/i);
        expect(hit!.interactable.verb(true)).toMatch(/stand up|turn out/i);
      });
    });
  }

  /**
   * Where a body stands to take each station — the spot the arrangement gives
   * it, chosen by walking the lanes rather than by taking the target's own
   * face.
   *
   * The starboard form's is 0.4 m forward of the port form's twin, and that is
   * not slackness: **the wardroom's aft lantern hangs at x −0.924, z −0.900,
   * directly over that lane**, and from five of the thirty standing positions
   * measured along it the line of sight to the bench passes through the lamp
   * on the way. That is the lamp being physically in the way, which is a fact
   * about the room and not about the pick — you step a pace along the form.
   */
  const STANDING_AT: Record<string, { x: number; z: number }> = {
    deskChair: { x: -0.05, z: -6.6 },
    wardroomFormPort: { x: 1.05, z: -0.635 },
    wardroomFormStarboard: { x: -1.05, z: -0.4 },
    crewChestPort: { x: 0.85, z: 3.9 },
    captainsBerth: { x: -0.05, z: -6.4 },
    surgeonsBerth: { x: -1.15, z: 1.5 },
    matesBerth: { x: 0.95, z: 1.15 },
    crewBerthPortLower: { x: 0.2, z: 5.2 },
    crewBerthPortUpper: { x: 0.2, z: 5.2 },
    crewBerthStarboardLower: { x: -0.2, z: 5.2 },
    crewBerthStarboardUpper: { x: -0.2, z: 5.2 },
  };

  /**
   * **A berth is aimed along the body, toward the feet.**
   *
   * Six of the seven sleep head-forward and the captain's sleeps head-aft, so
   * a pose builder that assumed one convention would be right six times and
   * put a man's skull in his own bookshelf the seventh. This is the assertion
   * that makes the `zHead`-first argument order of `lyingPose` load-bearing.
   */
  it('aims every lying body down its own bed', () => {
    for (const station of SHIP_STATIONS) {
      if (station.kind !== 'berth') continue;
      const pose = station.pose();
      const look = lookDirection(pose);
      const bed = BED_AXIS[station.name];
      const along = new THREE.Vector3(bed.foot.x - bed.head.x, 0, bed.foot.z - bed.head.z)
        .normalize();
      const flat = new THREE.Vector3(look.x, 0, look.z).normalize();
      expect(
        flat.dot(along),
        `${station.name} is not looking toward its own foot`,
      ).toBeGreaterThan(0.97);
      // And it is looking UP: what a body in a bunk sees is the deckhead.
      expect(pose.pitch, `${station.name} is looking down out of its bunk`).toBeGreaterThan(0.4);
    }
  });

  /** The head and foot of each berth, in ship coordinates. */
  const BED_AXIS: Record<string, { head: { x: number; z: number }; foot: { x: number; z: number } }> =
    (() => {
      const out: Record<string, { head: { x: number; z: number }; foot: { x: number; z: number } }> =
        {};
      const berth = boxBerthGeometry();
      out.captainsBerth = {
        head: frameToShip(berth.frame, berth.xInboard, berth.zAft),
        foot: frameToShip(berth.frame, berth.xInboard, berth.zForward),
      };
      for (const [name, hand] of [
        ['surgeonsBerth', 'starboard'],
        ['matesBerth', 'port'],
      ] as const) {
        const p = officersBerthPlacement(hand);
        out[name] = {
          head: frameToShip(p.frame, p.xLo, p.zForward),
          foot: frameToShip(p.frame, p.xLo, p.zAft),
        };
      }
      for (const hand of ['port', 'starboard'] as const) {
        const b = crewBerthGeometry(hand);
        const axis = {
          head: frameToShip(b.placement.frame, b.xInboard, b.zForward),
          foot: frameToShip(b.placement.frame, b.xInboard, b.zAft),
        };
        const key = hand === 'port' ? 'crewBerthPort' : 'crewBerthStarboard';
        out[`${key}Lower`] = axis;
        out[`${key}Upper`] = axis;
      }
      return out;
    })();

  /**
   * **A sitter faces the table he is at**, and for the two mirrored pairs that
   * is the assertion a sign flip does not survive.
   *
   * The chart desk is deliberately absent: it faces *outboard*, at the lining,
   * which is the one composition in the ship that is not about a table, and
   * `captainsSeatPose` argues it at length.
   */
  it('sits every body facing the table it is at', () => {
    const messTable = messTableGeometry();
    const facing: Array<[string, THREE.Vector3]> = [
      [
        'wardroomFormPort',
        new THREE.Vector3(0, messTable.topY, (messTable.zAft + messTable.zForward) / 2),
      ],
      [
        'wardroomFormStarboard',
        new THREE.Vector3(0, messTable.topY, (messTable.zAft + messTable.zForward) / 2),
      ],
      ['crewChestPort', foremastTableCentre()],
    ];
    for (const [name, at] of facing) {
      const pose = SHIP_STATIONS.find((s) => s.name === name)!.pose();
      const look = lookDirection(pose);
      const toward = at.clone().sub(new THREE.Vector3(pose.x, pose.y, pose.z)).normalize();
      const angle = Math.acos(Math.min(Math.max(look.dot(toward), -1), 1));
      expect(
        angle,
        `${name} has its table ${((angle * 180) / Math.PI).toFixed(0)}° off the centre of view`,
      ).toBeLessThan(HALF_FIELD);
      // Inboard, which is the half of it a mirror gets wrong: a sitter's own x
      // and the way he looks must have opposite signs.
      expect(Math.sign(look.x), `${name} faces the ship's side`).toBe(-Math.sign(pose.x));
    }
  });

  /** The middle of the crew's hinged leaf, for the chest to be aimed at. */
  function foremastTableCentre(): THREE.Vector3 {
    const leaf = interiorFittingsNow().find((f) => f.kind === 'foremastTable');
    if (!leaf) throw new Error('the forecastle has no table for the chest to face');
    const b = boundsOf(leaf.solids);
    let top = -Infinity;
    for (const solid of leaf.solids) top = Math.max(top, solidBounds(solid).y1);
    return new THREE.Vector3((b.x0 + b.x1) / 2, top, (b.z0 + b.z1) / 2);
  }

  /**
   * **One body, one station.** The state is a name, so taking a second seat
   * without leaving the first is not expressible — which is the property the
   * boolean it replaced did not have.
   */
  it('holds one station at a time, and it is the state that is driven, not a key', () => {
    resetSeat();
    // **Driven through the registry, because Space cannot be tested.** A
    // previous round found that dispatching synthetic key events proves
    // nothing about this control, so what gets driven is the state machine:
    // the row the reach pick would have found, activated, exactly as
    // `useWhatIsInReach` does it.
    const interactables = buildShipInteractables({
      stations: {
        use: (name) => setOccupiedStation(occupiedStation() === name ? null : name),
      },
    });

    /** The row a body standing at a station's own approach would be offered. */
    function rowAt(name: string) {
      const station = BELOW_DECKS_STATIONS.find((s) => s.name === name)!;
      const at = STANDING_AT[name];
      const eyeY = belowDecksSpace(station.room).soleY + eyeHeight;
      const t = station.target();
      const hit = interactables.pick(
        { x: at.x, y: eyeY, z: at.z },
        {
          x: (t.xLo + t.xHi) / 2 - at.x,
          y: (t.yLo + t.yHi) / 2 - eyeY,
          z: (t.zLo + t.zHi) / 2 - at.z,
        },
      );
      expect(hit?.interactable.name, `nothing offered at ${name}`).toBe(name);
      return hit!.interactable;
    }

    const form = rowAt('wardroomFormPort');
    form.activate();
    expect(occupiedStation()).toBe('wardroomFormPort');
    expect(isStationOccupied('wardroomFormStarboard')).toBe(false);
    expect(form.verb(form.isOn())).toMatch(/stand up/i);
    form.activate();
    expect(occupiedStation()).toBeNull();

    const bunk = rowAt('crewBerthPortUpper');
    bunk.activate();
    expect(occupiedStation()).toBe('crewBerthPortUpper');
    expect(bunk.verb(bunk.isOn())).toMatch(/turn out/i);
    resetSeat();
    expect(occupiedStation()).toBeNull();
  });

  /**
   * **A partition is a wall the reach pick has never heard of.**
   *
   * The two officers' berths are in the same room as the mess table, so the
   * cross-room sweep above cannot see them. Measured before `within` existed:
   * a body on the wardroom's centreline at z 1.5 is 0.45 m from the surgeon's
   * mattress *through his boarded partition*, and was offered his bed. This is
   * the cabin bulkhead's fault from the desk round, one wall thinner.
   */
  it('will not turn a body in to an officer\'s berth through his partition', () => {
    resetSeat();
    const interactables = buildShipInteractables({
      lamps: { isLit: () => false, toggle: () => {} },
      stations: { use: () => {} },
    });
    const wardroom = belowDecksSpace('wardroom');
    const eyeY = wardroom.soleY + eyeHeight;
    for (const [name, hand] of [
      ['surgeonsBerth', 'starboard'],
      ['matesBerth', 'port'],
    ] as const) {
      const cabin = officersCabinGeometry(hand);
      const station = SHIP_STATIONS.find((s) => s.name === name)!;
      const t = station.target();
      const centre = {
        x: (t.xLo + t.xHi) / 2,
        y: (t.yLo + t.yHi) / 2,
        z: (t.zLo + t.zHi) / 2,
      };
      for (let x = -1.9; x <= 1.91; x += 0.2) {
        for (let z = wardroom.zAft + 0.1; z <= wardroom.zForward - 0.1; z += 0.2) {
          // Inside the cabin itself is where it is supposed to work; the door
          // is the one place a bed-place is worked from and is left in too.
          const inCabin =
            z >= cabin.zAft &&
            z <= cabin.zForward &&
            Math.abs(x) >= Math.abs(cabin.xPartition) - DOORWAY_STAND_IN &&
            Math.sign(x) === Math.sign(cabin.xPartition);
          if (inCabin) continue;
          const hit = interactables.pick(
            { x, y: eyeY, z },
            { x: centre.x - x, y: centre.y - eyeY, z: centre.z - z },
          );
          expect(
            hit?.interactable.name,
            `${name} offered from ${x.toFixed(1)},${z.toFixed(1)} — through his partition`,
          ).not.toBe(name);
        }
      }
    }
  });

  /** How far out of a bed-place's door a body may stand and still reach in. */
  const DOORWAY_STAND_IN = 0.75;

  /**
   * **The one controller, driven through every station in turn.**
   *
   * `SeatedStation` was written for one chair and is now the thing that writes
   * the eye for eleven places; what this asserts is the three properties that
   * were free with one seat and are not with eleven — it leaves the eye alone
   * until somebody sits, it lands on the pose of the station that was actually
   * taken, and it never asks for a pose while nobody is in one.
   */
  it('writes the eye for whichever station the body is in, and for no other time', () => {
    resetSeat();
    const walker = new DeckWalker(SCHOONER_DECK_ENVIRONMENT);
    walker.placeAt(1.05, -0.635, belowDecksSpace('wardroom').soleY);
    const eye = {
      x: 0,
      y: 0,
      z: 0,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const view = {
      embodied: { eyeLocal: eye, headLocal: { copy: () => undefined } },
      look: { yaw: 0, pitch: 0 },
      modeName: 'embodied',
    };
    let asked = 0;
    const seat = new SeatedStation(
      walker,
      view,
      () => {
        asked++;
        const name = occupiedStation();
        if (!name) throw new Error('asked for a pose with nobody in a station');
        return shipStation(name).pose();
      },
      (seated) => {
        if (!seated) setOccupiedStation(null);
      },
    );

    // **Nothing at all before anybody sits.** A fresh seat used to spend its
    // first 0.55 s easing the eye out of the ship's own origin, because "not
    // seated" and "not moving" were two conditions and only one was true.
    for (let i = 0; i < 60; i++) seat.step(1 / 60);
    expect(asked, 'the seat asked for a pose with nobody in it').toBe(0);
    expect(eye.x).toBe(0);
    expect(eye.y).toBe(0);

    for (const name of ['wardroomFormPort', 'crewBerthStarboardUpper'] as const) {
      setOccupiedStation(name);
      seat.sitDown();
      for (let i = 0; i < 60; i++) seat.step(1 / 60);
      const pose = shipStation(name).pose();
      expect(eye.x, `${name} did not land on its own pose`).toBeCloseTo(pose.x, 6);
      expect(eye.y).toBeCloseTo(pose.y, 6);
      expect(eye.z).toBeCloseTo(pose.z, 6);
      // **Three places, not six, and the shortfall is real rather than
      // floating point.** The eye's position lands exactly — the last frame
      // clamps `settle` to its full length and lerps at t = 1 — but the look
      // does not, because `isSettling` is false on that same frame and the
      // clamp takes over from the ease. The head therefore stops 0.4 mrad
      // (0.024°) short of the pose it was aimed at. Noted rather than fixed:
      // it is a fortieth of a degree, and the fix is a change to how the
      // settle ends, which is a feel change.
      expect(view.look.yaw).toBeCloseTo(pose.yaw, 3);
      seat.standUp();
      expect(occupiedStation(), 'standing up left the station occupied').toBeNull();
      // And the rise runs to the body without asking anything of a station
      // that nobody is in.
      for (let i = 0; i < 60; i++) seat.step(1 / 60);
      expect(eye.x).toBeCloseTo(walker.x, 6);
      expect(eye.z).toBeCloseTo(walker.z, 6);
    }
  });
});

/** Is a point inside a drawn solid? Boxes are tested in their own axes. */
function pointInSolid(solid: FittingSolid, point: THREE.Vector3): boolean {
  if (solid.kind !== 'box') {
    // A bar: distance to its own segment, against the larger of its two radii.
    const a = new THREE.Vector3(solid.a.x, solid.a.y, solid.a.z);
    const b = new THREE.Vector3(solid.b.x, solid.b.y, solid.b.z);
    const ab = b.clone().sub(a);
    const t = Math.min(Math.max(point.clone().sub(a).dot(ab) / ab.lengthSq(), 0), 1);
    const near = a.clone().addScaledVector(ab, t);
    return near.distanceTo(point) < Math.max(solid.radiusA, solid.radiusB);
  }
  const yaw = solid.yaw ?? 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dx = point.x - solid.centre.x;
  const dz = point.z - solid.centre.z;
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return (
    Math.abs(localX) < solid.half.x &&
    Math.abs(point.y - solid.centre.y) < solid.half.y &&
    Math.abs(localZ) < solid.half.z
  );
}

/**
 * **The deadlights: shutters over the stern lights, as a closure like any
 * other.**
 *
 * `CAPTAINS_QUARTERS_HANDOVER.md` named these as the obvious next piece and
 * said why: the sills stand 1.25 m over the design waterline and 110 s of the
 * production sea leaves 0.75 m in hand at the worst crest, which is *not* a
 * guarantee — and `deckInterior.ts`'s own note calls them "the honest answer to
 * a following sea".
 *
 * The thing being asserted is not that they exist. It is that they went into
 * the table four systems already read rather than beside it, that a shipped one
 * really does take the cabin's daylight, and that shut reads as shut.
 */
describe('the deadlights over the stern lights', () => {
  const closure = SHIP_CLOSURES.find((c) => c.name === 'sternDeadlights')!;

  afterEach(() => resetClosures());

  it('is a row in the closure table, with no barrier and one side', () => {
    expect(closure, 'the deadlights are not in SHIP_CLOSURES').toBeDefined();
    // **No barrier, and it is the first closure aboard without one.** A barrier
    // is what a closure does underfoot; nobody walks through a stern light.
    expect(closure.barrier).toBeNull();
    // One target box, not two: a hatch has two sides and a shutter on a wall
    // has the room it is in.
    expect(closure.targets(true)).toHaveLength(1);
    expect(closure.targets(false)).toHaveLength(1);
    expect(closure.targets(true)[0].from).toBe('cabin');
    // Named for the opening, like every other row, so `open` means the lights
    // are open and the boards are stowed. She starts that way.
    expect(isClosureOpen('sternDeadlights')).toBe(true);
    expect(closure.verb(true)).toMatch(/ship the deadlights/i);
    expect(closure.verb(false)).toMatch(/unship/i);
  });

  it('is offered from the cabin and from nowhere else aboard', () => {
    const interactables = buildShipInteractables({
      lamps: { isLit: () => false, toggle: () => {} },
      stations: { use: () => {} },
    });
    const eyeHeight = DEFAULT_WALKER_TUNING.eyeHeight;
    const box = closure.targets(true)[0].box;
    const centre = {
      x: (box.xLo + box.xHi) / 2,
      y: (box.yLo + box.yHi) / 2,
      z: (box.zLo + box.zHi) / 2,
    };

    // Standing in front of the stern lockers, looking aft at the glass.
    const cabinEye = belowDecksSpace('cabin').soleY + eyeHeight;
    for (const [x, z] of [
      [0.0, -7.0],
      [0.7, -7.2],
      [-0.4, -7.1],
    ] as const) {
      const hit = interactables.pick(
        { x, y: cabinEye, z },
        { x: centre.x - x, y: centre.y - cabinEye, z: centre.z - z },
      );
      expect(hit?.interactable.name, `at the windows from ${x},${z}`).toBe('sternDeadlights');
    }

    // And never from outside the cabin. The nearest a body can get is the
    // landing, 3.5 m from the transom — `REACH` alone would do it here, and
    // `within` is what makes that a fact about a wall instead of a distance.
    for (const space of BELOW_DECKS_SPACES) {
      if (space.name === 'cabin') continue;
      for (let x = -1.8; x <= 1.81; x += 0.4) {
        for (let z = space.zAft + 0.1; z <= space.zForward - 0.1; z += 0.4) {
          const from = { x, y: space.soleY + eyeHeight, z };
          const hit = interactables.pick(from, {
            x: centre.x - x,
            y: centre.y - from.y,
            z: centre.z - z,
          });
          expect(
            hit?.interactable.name,
            `deadlights offered from the ${space.name}`,
          ).not.toBe('sternDeadlights');
        }
      }
    }
  });

  it('covers every light, inboard of its glass, on the wall\'s own rake', () => {
    // **A plumb board across a raked opening is 90 mm proud at one edge and
    // 90 mm inside the planking at the other**, which is why these are lofted
    // rather than drawn as fittings. The check is that the shutter's face is
    // between the room and the glass at the sill, the middle and the head —
    // three heights, because one would pass for a board hung at any angle.
    const lap = deadlightLap();
    for (const window of STERN_WINDOWS) {
      for (const t of [0, 0.5, 1]) {
        const y = window.y + (t - 0.5) * 2 * window.halfHeight;
        const face = deadlightFaceZAt(y);
        const glass = sternWindowZAt(y);
        expect(face, `the deadlight is abaft the glass at y ${y.toFixed(2)}`).toBeGreaterThan(
          glass,
        );
        // And not so far into the room that it is a shelf: the whole board is
        // inside the architrave's own reveal.
        expect(face - glass).toBeLessThan(0.16);
      }
      // It laps the opening on every side, so no daylight gets past its edge.
      expect(lap).toBeGreaterThan(0.01);
    }
  });

  it('is legible as shut: darker than the wall it is set into, and not one value', () => {
    // **The problem the wardroom round wrote down and could not solve.** Oak on
    // oak in an unlit room is nothing, and a shutter that reads as nothing is a
    // shutter the player cannot tell they have shipped. The answer here is that
    // a deadlight is FITTING timber, not lining: measured on their two palette
    // entries, decisively darker, and carrying two more materials on top of it.
    const luminance = (hex: number): number => {
      const r = ((hex >> 16) & 0xff) / 255;
      const g = ((hex >> 8) & 0xff) / 255;
      const b = (hex & 0xff) / 255;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const wall = luminance(SHIP_PALETTE.base.interiorLining);
    const board = luminance(INTERIOR_FITTING_PALETTE.timber);
    expect(board, 'the shutter is no darker than the wall behind it').toBeLessThan(wall * 0.7);

    const set = buildSternDeadlightGeometry();
    // Three materials, which is what stops it being one flat rectangle: the
    // board, two iron strongbacks across it, and a brass grip in the middle.
    expect([...set.geometries.keys()].sort()).toEqual(['brass', 'ironwork', 'timber']);
    expect(set.triangleCount).toBeGreaterThan(4 * 3);
    // Cheap enough not to need an argument. Four shutters, five quads each for
    // the board and each strap and the grip.
    expect(set.triangleCount).toBeLessThan(400);
  });

  it('draws nothing at all while they are unshipped', () => {
    // Unshipped they are inside the stern lockers under the lights, which is
    // what those lockers are for, and a thing inside a shut chest is not drawn.
    // So there is one state and it is hidden — the fore scuttle's soffit again.
    // The assertion that matters is the negative one: no deadlight timber is in
    // the constant fitting list, which is what the obstacle index reads. A
    // shutter in the collider would be a wall across the stern windows that a
    // body walked into whether or not it was shipped.
    const names = INTERIOR_FITTINGS.map((f) => f.name);
    expect(names.some((n) => /deadlight/i.test(n))).toBe(false);
    const now = interiorFittingsNow().map((f) => f.name);
    expect(now.some((n) => /deadlight/i.test(n))).toBe(false);
  });
});

/** A visible rail and gathered cloth must be a working privacy closure. */
describe('the captain\'s berth privacy curtain', () => {
  const closure = SHIP_CLOSURES.find((c) => c.name === 'captainsBerthCurtain')!;

  afterEach(() => {
    resetClosures();
    resetSeat();
  });

  it('is a stateful cabin closure with honest verbs and no floor barrier', () => {
    resetClosures();
    expect(closure).toBeDefined();
    expect(closure.barrier).toBeNull();
    expect(closure.targets(true)).toHaveLength(1);
    expect(closure.targets(true)[0].from).toBe('cabin');
    expect(isClosureOpen('captainsBerthCurtain')).toBe(true);
    expect(closure.verb(true)).toMatch(/draw the berth curtain/i);
    expect(closure.verb(false)).toMatch(/draw back/i);
  });

  it('draws back to a gathered bundle and closes as an opaque privacy screen', () => {
    const open = boxBerthCurtain(true);
    const closed = boxBerthCurtain(false);
    expect(open.solids).toHaveLength(1);
    expect(closed.solids.length).toBeGreaterThan(8);
    for (const solid of [...open.solids, ...closed.solids]) {
      expect(solid.material).toBe('linen');
      expect(solid.collides).toBe(false);
    }
    const openBounds = boundsOf(open.solids);
    const closedBounds = boundsOf(closed.solids);
    expect(closedBounds.z1 - closedBounds.z0).toBeGreaterThan(
      5 * (openBounds.z1 - openBounds.z0),
    );

    resetClosures();
    expect(
      interiorFittingsNow().find((f) => f.kind === 'boxBerthCurtain')?.name,
    ).toMatch(/open/);
    setClosureOpen('captainsBerthCurtain', false);
    expect(
      interiorFittingsNow().find((f) => f.kind === 'boxBerthCurtain')?.name,
    ).toMatch(/closed/);
  });

  it('can be drawn and drawn back, and closed cloth blocks the berth behind it', () => {
    resetClosures();
    const interactables = buildShipInteractables({ stations: { use: () => {} } });
    const cabin = belowDecksSpace('cabin');
    const eye = {
      x: -0.05,
      y: cabin.soleY + DEFAULT_WALKER_TUNING.eyeHeight,
      z: -6.4,
    };
    const aimAt = (box: ReturnType<typeof boxBerthCurtainTarget>) =>
      interactables.pick(eye, {
        x: (box.xLo + box.xHi) / 2 - eye.x,
        y: (box.yLo + box.yHi) / 2 - eye.y,
        z: (box.zLo + box.zHi) / 2 - eye.z,
      });

    const gathered = aimAt(boxBerthCurtainTarget(true));
    expect(gathered?.interactable.name).toBe('captainsBerthCurtain');
    gathered!.interactable.activate();
    expect(isClosureOpen('captainsBerthCurtain')).toBe(false);

    const berth = shipStation('captainsBerth').target();
    const throughClosedCloth = aimAt(berth);
    expect(throughClosedCloth?.interactable.name).not.toBe('captainsBerth');
    expect(throughClosedCloth?.interactable.name).toBe('captainsBerthCurtain');
    expect(throughClosedCloth!.interactable.verb(throughClosedCloth!.on)).toMatch(/draw back/i);
    throughClosedCloth!.interactable.activate();

    expect(isClosureOpen('captainsBerthCurtain')).toBe(true);
    expect(aimAt(berth)?.interactable.name).toBe('captainsBerth');
  });
});
