import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WALKER_TUNING } from '../src/player/DeckWalker';
import type { InteractableBox } from '../src/player/Interactables';
import {
  isClosureOpen,
  resetClosures,
  setClosureOpen,
} from '../src/vessel/schooner/closures';
import { belowDecksSpace } from '../src/vessel/schooner/deckInterior';
import type { SpaceName } from '../src/vessel/schooner/deckInterior';
import { HOLD_FLOOR_Y } from '../src/vessel/schooner/holdStow';
import { walkingDeckY } from '../src/vessel/schooner/hullForm';
import { roomInteractionVolume } from '../src/vessel/schooner/interactionSpaces';
import {
  LAMP_DROP,
  LAMP_HANGS,
  LAMP_REACH_HALF,
  lampHangPoint,
} from '../src/vessel/schooner/lampPlacement';
import type { LampId } from '../src/vessel/schooner/lampPlacement';
import { climbAnchors } from '../src/vessel/schooner/riggingClimb';
import { resetSeat } from '../src/vessel/schooner/seatState';
import { SHIP_CLOSURES } from '../src/vessel/schooner/shipClosures';
import { buildShipInteractables } from '../src/vessel/schooner/shipInteractables';
import { SHIP_STATIONS, shipStation } from '../src/vessel/schooner/shipStations';

type Point = { x: number; y: number; z: number };
type PickCase = { name: string; eye: Point; target: InteractableBox };

const EYE_HEIGHT = DEFAULT_WALKER_TUNING.eyeHeight;

/** A real clear standing spot the arrangement supplies for every furniture row. */
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

/** Standing spots that leave each hanging lamp visible rather than behind furniture. */
const LAMP_APPROACH: Record<LampId, { x: number; z: number }> = {
  cabin: { x: 0, z: -6.6 },
  landing: { x: 0, z: -3.7 },
  'wardroom-aft': { x: 0, z: -0.5 },
  'wardroom-fore': { x: 0, z: 1.1 },
  forecastle: { x: 0, z: 4.2 },
};

function centre(box: InteractableBox): Point {
  return {
    x: (box.xLo + box.xHi) / 2,
    y: (box.yLo + box.yHi) / 2,
    z: (box.zLo + box.zHi) / 2,
  };
}

function lampBox(id: LampId): InteractableBox {
  const hang = lampHangPoint(id);
  return {
    xLo: hang.x - LAMP_REACH_HALF,
    xHi: hang.x + LAMP_REACH_HALF,
    yLo: hang.y - LAMP_DROP - 0.18,
    yHi: hang.y,
    zLo: hang.z - LAMP_REACH_HALF,
    zHi: hang.z + LAMP_REACH_HALF,
  };
}

function contains(point: Point, box: InteractableBox): boolean {
  return (
    point.x >= box.xLo &&
    point.x <= box.xHi &&
    point.y >= box.yLo &&
    point.y <= box.yHi &&
    point.z >= box.zLo &&
    point.z <= box.zHi
  );
}

function distanceToBox(point: Point, box: InteractableBox): number {
  return Math.hypot(
    Math.max(box.xLo - point.x, 0, point.x - box.xHi),
    Math.max(box.yLo - point.y, 0, point.y - box.yHi),
    Math.max(box.zLo - point.z, 0, point.z - box.zHi),
  );
}

function fullRegistry() {
  return buildShipInteractables({
    lamps: { isLit: () => false, toggle: () => {} },
    stations: { use: () => {} },
  });
}

function pickedName(registry: ReturnType<typeof fullRegistry>, row: PickCase): string | null {
  const at = centre(row.target);
  return (
    registry.pick(row.eye, {
      x: at.x - row.eye.x,
      y: at.y - row.eye.y,
      z: at.z - row.eye.z,
    })?.interactable.name ?? null
  );
}

function closureEye(name: string, from: string, target: InteractableBox): Point {
  if (from === 'hold') return { x: 0, y: HOLD_FLOOR_Y + 0.68, z: 1.4 };
  if (from === 'wardroom') {
    return { x: 0, y: belowDecksSpace('wardroom').soleY + EYE_HEIGHT, z: 0.2 };
  }
  if (from === 'forecastle') {
    return { x: -1.1, y: belowDecksSpace('forecastle').soleY + EYE_HEIGHT, z: 3.2 };
  }
  if (from === 'weatherDeck') {
    return { x: -1.1, y: target.yLo + EYE_HEIGHT, z: 2.2 };
  }
  if (name === 'sternDeadlights') {
    return { x: 0, y: belowDecksSpace('cabin').soleY + EYE_HEIGHT, z: -7 };
  }
  return { x: -0.05, y: belowDecksSpace('cabin').soleY + EYE_HEIGHT, z: -6.4 };
}

function representativeCases(): PickCase[] {
  const rows: PickCase[] = [];

  for (const station of SHIP_STATIONS) {
    const targets = station.interactionTargets?.() ?? [station.target()];
    if (station.kind === 'climb') {
      const side = station.name === 'climbPort' ? 1 : -1;
      for (const target of targets) {
        rows.push({ name: station.name, eye: climbAnchors(side)[0].eye, target });
      }
      continue;
    }
    const room = belowDecksSpace(station.room as SpaceName);
    const stand = STANDING_AT[station.name];
    for (const target of targets) {
      rows.push({
        name: station.name,
        eye: { x: stand.x, y: room.soleY + EYE_HEIGHT, z: stand.z },
        target,
      });
    }
  }

  for (const lamp of LAMP_HANGS) {
    const room = belowDecksSpace(lamp.room);
    const stand = LAMP_APPROACH[lamp.id];
    rows.push({
      name: `lamp:${lamp.id}`,
      eye: { x: stand.x, y: room.soleY + EYE_HEIGHT, z: stand.z },
      target: lampBox(lamp.id),
    });
  }

  for (const closure of SHIP_CLOSURES) {
    const target = closure.targets(isClosureOpen(closure.name))[0];
    rows.push({
      name: closure.name,
      eye: closureEye(closure.name, target.from, target.box),
      target: target.box,
    });
  }

  return rows;
}

describe('the complete ship interaction selection matrix', () => {
  afterEach(() => {
    resetClosures();
    resetSeat();
  });

  it('selects every player-facing row from its representative authored approach', () => {
    resetClosures();
    const rows = representativeCases();
    const expectedNames = [
      ...SHIP_CLOSURES.map((closure) => closure.name),
      ...LAMP_HANGS.map((lamp) => `lamp:${lamp.id}`),
      ...SHIP_STATIONS.map((station) => station.name),
    ].sort();
    expect([...new Set(rows.map((row) => row.name))].sort()).toEqual(expectedNames);

    const registry = fullRegistry();
    for (const row of rows) {
      expect(pickedName(registry, row), `${row.name} lost its explicit gaze`).toBe(row.name);
    }
  });

  it('keeps every closure face selectable in both states, including both hatch storeys', () => {
    const registry = fullRegistry();
    for (const closure of SHIP_CLOSURES) {
      for (const open of [false, true]) {
        setClosureOpen(closure.name, open);
        for (const target of closure.targets(open)) {
          const row = {
            name: closure.name,
            eye: closureEye(closure.name, target.from, target.box),
            target: target.box,
          };
          expect(
            pickedName(registry, row),
            `${closure.name} ${open ? 'open' : 'shut'} from ${target.from}`,
          ).toBe(closure.name);

          // A lower-side target is now the face a player looks at, not the
          // whole ladder shaft their eye occupies while approaching it.
          if (target.from === 'hold' || target.from === 'forecastle') {
            expect(target.box.yHi - target.box.yLo).toBeLessThan(0.25);
            expect(contains(row.eye, target.box)).toBe(false);
          }
        }
      }
    }
  });

  it('lets exact looks beat every remaining occupied target in a real standing lane', () => {
    const registry = fullRegistry();

    // The mate's doorway eye is inside the forward wardroom lamp target.
    const mateEye = {
      x: 0.95,
      y: belowDecksSpace('wardroom').soleY + EYE_HEIGHT,
      z: 1.15,
    };
    expect(contains(mateEye, lampBox('wardroom-fore'))).toBe(true);
    expect(
      pickedName(registry, {
        name: 'matesBerth',
        eye: mateEye,
        target: shipStation('matesBerth').target(),
      }),
    ).toBe('matesBerth');

    // The same overlap exists under the forecastle lamp. Both tier centres are
    // within reach from this spot; neither may lose merely because the eye is
    // already inside the lamp's generous hand volume.
    const forecastleEye = {
      x: -1,
      y: belowDecksSpace('forecastle').soleY + EYE_HEIGHT,
      z: 4.05,
    };
    expect(contains(forecastleEye, lampBox('forecastle'))).toBe(true);
    for (const name of ['crewBerthPortLower', 'crewBerthPortUpper'] as const) {
      const target = shipStation(name).target();
      expect(distanceToBox(forecastleEye, target)).toBeLessThan(2.2);
      expect(pickedName(registry, { name, eye: forecastleEye, target })).toBe(name);
    }
  });

  it('rejects adjacent rooms and vertical storeys even when the target is within reach', () => {
    const registry = fullRegistry();

    // The room veto starts at its sole. The previous half-metre tolerance
    // admitted this hold-side eye to the wardroom and let it work a lamp
    // through intact planking.
    const wardroom = belowDecksSpace('wardroom');
    const belowSole = { x: 1, y: wardroom.soleY - 0.3, z: 1.4 };
    const wardLamp = lampBox('wardroom-fore');
    expect(distanceToBox(belowSole, wardLamp)).toBeLessThan(2.2);
    expect(roomInteractionVolume('wardroom').yLo).toBeGreaterThan(belowSole.y);
    expect(
      pickedName(registry, { name: 'lamp:wardroom-fore', eye: belowSole, target: wardLamp }),
    ).not.toBe('lamp:wardroom-fore');

    // The same direct vertical look from the weather deck must not reach into
    // either room below it. Range alone deliberately cannot prove this: both
    // lanterns are less than a bend-and-reach away.
    for (const id of ['wardroom-fore', 'forecastle'] as const) {
      const target = lampBox(id);
      const at = centre(target);
      const weatherEye = { x: at.x, y: walkingDeckY(at.z) + EYE_HEIGHT, z: at.z };
      expect(distanceToBox(weatherEye, target), `${id} was not actually within reach`).toBeLessThan(
        2.2,
      );
      expect(
        pickedName(registry, { name: `lamp:${id}`, eye: weatherEye, target }),
      ).not.toBe(`lamp:${id}`);
    }

    // The historical scuttle leak: the surgeon's cabin is close enough to the
    // lid for a ray and REACH to say yes, but it is on neither legitimate side.
    const scuttle = SHIP_CLOSURES.find((closure) => closure.name === 'foreScuttleLid')!;
    const lid = scuttle.targets(false)[0].box;
    const surgeonEye = {
      x: -1.5,
      y: wardroom.soleY + EYE_HEIGHT,
      z: 2.05,
    };
    expect(distanceToBox(surgeonEye, lid)).toBeLessThan(2.2);
    expect(
      pickedName(registry, { name: 'foreScuttleLid', eye: surgeonEye, target: lid }),
    ).not.toBe('foreScuttleLid');

    // And a cabin lamp remains a cabin object from just across its bulkhead.
    const cabinLamp = lampBox('cabin');
    const landing = belowDecksSpace('landing');
    const landingEye = { x: 0, y: landing.soleY + EYE_HEIGHT, z: landing.zAft + 0.1 };
    expect(distanceToBox(landingEye, cabinLamp)).toBeLessThan(2.2);
    expect(
      pickedName(registry, { name: 'lamp:cabin', eye: landingEye, target: cabinLamp }),
    ).not.toBe('lamp:cabin');
  });
});
