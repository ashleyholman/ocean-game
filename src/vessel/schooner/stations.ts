import {
  CABIN_SOLE_Y,
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  FORECASTLE_SOLE_Y,
  PLATFORM_SOLE_Y,
} from './hullForm';

/**
 * Places worth standing, for judging the ship without walking the length of
 * her. Shared data: the deck panel's "Stand at" buttons and the inspection
 * harness's `stand=<name>` parameter must mean the same place, or a fault
 * reported from one cannot be reproduced by the other.
 *
 * `fromY` is what picks the storey. A station without one lands on the topmost
 * surface, which is the weather deck — and that is a *choice* rather than the
 * only possible answer, because the cabin sole is under the quarterdeck at the
 * same (x, z) as the helm.
 */
export interface ShipStation {
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly title: string;
  readonly fromY?: number;
}

export const STATIONS: readonly ShipStation[] = [
  // Off the centreline: the tiller is on it, and a station that drops the body
  // inside a solid is one the first step has to push it out of.
  { label: 'Helm', x: 0.6, z: -6.0, title: 'Beside the tiller, where the helm is stood' },
  {
    label: 'Companion',
    x: 0,
    z: COMPANION_FORWARD_Z + 0.45,
    title: 'On deck at the head of the companion ladder, facing aft',
  },
  {
    label: 'Cabin',
    x: 0,
    z: -6.0,
    title: 'Below decks, in the captain’s cabin, looking aft',
    fromY: CABIN_SOLE_Y,
  },
  {
    label: 'Ladder foot',
    x: 0,
    z: COMPANION_AFT_Z + 0.2,
    title: 'On the sole at the foot of the companion ladder, cabin door aft',
    fromY: CABIN_SOLE_Y,
  },
  {
    label: 'Wardroom',
    x: 0,
    z: -1.0,
    title: 'On the platform deck, abaft the hatchway, looking forward',
    fromY: PLATFORM_SOLE_Y,
  },
  {
    label: 'Hatchway',
    x: 0,
    z: 1.4,
    title: 'On the hatchway boards, under the cargo hatch — the shaft',
    fromY: PLATFORM_SOLE_Y,
  },
  {
    label: 'Forecastle',
    x: 0,
    z: 4.4,
    title: 'Forward, in the crew’s quarters, under the raised forecastle',
    fromY: FORECASTLE_SOLE_Y,
  },
  // Side words follow W1: model +x is PORT.
  { label: 'Break', x: 1.25, z: -2.0, title: 'Foot of the port ladder' },
  { label: 'Hatch', x: 0, z: 1.4, title: 'Standing on the cargo hatch grating' },
  { label: 'Waist', x: 1.3, z: 0.6, title: 'Port gangway, abreast the hatch' },
  { label: 'Fore', x: 0.85, z: 5.0, title: 'Forecastle, outboard of the windlass' },
  { label: 'Stem', x: 0, z: 6.9, title: 'Right forward, where the deck narrows' },
];

/** Case-insensitive station lookup for URL parameters and console callers. */
export function findStation(name: string): ShipStation | undefined {
  const wanted = name.trim().toLowerCase();
  return STATIONS.find((station) => station.label.toLowerCase() === wanted);
}
