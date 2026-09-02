import { Interactables } from '../../player/Interactables';
import type { Interactable, InteractableBox, InteractableTarget } from '../../player/Interactables';
import { isClosureOpen, toggleClosure } from './closures';
import {
  LAMP_DROP,
  LAMP_HANGS,
  LAMP_REACH_HALF,
  lampHangPoint,
  type LampId,
} from './lampPlacement';
import { isStationOccupied } from './seatState';
import type { StationName } from './seatState';
import { SHIP_CLOSURES } from './shipClosures';
import { SHIP_STATIONS, roomVolume } from './shipStations';
import { interactionSpaceVolume } from './interactionSpaces';

/**
 * What aboard this ship can be worked by hand.
 *
 * **The closures are derived from `SHIP_CLOSURES`, not typed out beside it.**
 * That used to be a second list naming the same hatches — one row here for the
 * verb and the target, one row there for the floor and the meshes — which is
 * the shape that lets a hatch exist for the walker and not for the player's
 * hands, silently. A closure is one row now, and being workable is part of
 * being a closure.
 *
 * **Two rounds arrived here independently and found the same wall.** The
 * lanterns-below round put it plainly — *"the lamps are the one kind of
 * workable thing aboard that is NOT a closure — nothing opens"* — and solved it
 * with a `lamp:` name prefix and a switch inside the registry's single
 * `isOpen`/`toggle` window. The desk round hit it a week later with a chair,
 * and wrote the note in `Interactable.isOn` predicting exactly what the prefix
 * scheme would cost: *"the registry would have needed a second window, and then
 * a third, and a switch to pick between them."*
 *
 * The merge keeps one of them, and it is not the prefix. A row now owns its own
 * accessor and its own effect, so `lamp:main` does not have to be parsed back
 * into a `LampId` by a function that exists only because the name had to carry
 * the dispatch. The lamps keep their namespace — it is still a good name for
 * five things that come from one table — and lose the machinery under it.
 *
 * **The seat became a table too, and it is the third one.** The chair was
 * written out here by hand — one row, four fields, its accessor and its room
 * inline — which was right while it was the only place aboard a body could put
 * itself. The forms, the sea chest and the six berths made it eleven, so it is
 * `SHIP_STATIONS` now and this file iterates it exactly the way it iterates the
 * closures and the lamps. Three kinds of row, three tables, one loop each.
 *
 * The obvious next entries are the cabin door, the companion's drop boards, the
 * sea chest's lid and the chart drawers. Each is a row in the closure table and
 * nothing here changes.
 */

/**
 * Every closure aboard, as something a player can point at and work.
 *
 * Each side carries its own reach storey. A hatch may be worked from both
 * levels without letting either level aim through the planking at the other's
 * target; a shutter has one side and therefore one room.
 */
const CLOSURE_INTERACTABLES: readonly Interactable[] = SHIP_CLOSURES.map((closure) => ({
  name: closure.name,
  isOn: () => isClosureOpen(closure.name),
  verb: (open: boolean) => closure.verb(open),
  targets: (open: boolean) =>
    closure.targets(open).map(({ box, from }) => ({
      box,
      reachableFrom: [interactionSpaceVolume(from, box)],
    })),
  activate: () => {
    toggleClosure(closure.name);
  },
}));

/**
 * The `lamp:` namespace.
 *
 * Still a namespace, and no longer a dispatch. It was both: `lamp:` told the
 * registry which of two state windows to look in, so the prefix had to be
 * parsed back out by `lampIdOfInteractable` at every read and every toggle.
 * With the accessor on the row, the id is simply closed over, and the prefix
 * goes back to being what a prefix should be — a way of saying "these five
 * belong together" to a person reading the list.
 */
const LAMP_PREFIX = 'lamp:';

/** What the lamp rows need from the vessel. */
export interface LampInteractionState {
  isLit(id: LampId): boolean;
  toggle(id: LampId): void;
}

/**
 * The lanterns — the same table the Schooner hangs them from
 * (`lampPlacement`, one entry per LAMP, rooms may carry two), so the reach box
 * is around the drawn lantern and a moved hang moves its target with it.
 *
 * For a lamp, "on" is "wanted lit": the verb is the state, and the state
 * includes the routine's own intent — a lamp the evening strike is about to
 * light still reads "Light the lantern" until it does.
 */
function lampInteractables(lamps: LampInteractionState): readonly Interactable[] {
  return LAMP_HANGS.map(({ id, room }) => {
    const hang = lampHangPoint(id);
    // The reach box brackets the lantern body at the chain's foot, not the
    // hook: what the hand works is the lamp, and the swing is small enough
    // that a static box stays honest.
    //
    // ONE box, where a closure has two: a hatch is worked from either side of
    // the deck it sits in, but a hanging lamp is worked from the room it hangs
    // in — there is no other side to reach it from.
    const box: InteractableBox = {
      xLo: hang.x - LAMP_REACH_HALF,
      xHi: hang.x + LAMP_REACH_HALF,
      yLo: hang.y - LAMP_DROP - 0.18,
      yHi: hang.y,
      zLo: hang.z - LAMP_REACH_HALF,
      zHi: hang.z + LAMP_REACH_HALF,
    };
    return {
      name: `${LAMP_PREFIX}${id}`,
      isOn: () => lamps.isLit(id),
      verb: (lit: boolean) => (lit ? 'Put out the lantern' : 'Light the lantern'),
      targets: (): readonly InteractableTarget[] => [
        { box, reachableFrom: [roomVolume(room)] },
      ],
      // **The room it hangs in, and the sentence above always said so.** "There
      // is no other side to reach it from" was written as an argument for one
      // box and never enforced, and `REACH` does not enforce it: the cabin's
      // lamp hangs 1.86 m from a body standing just inside the landing, so it
      // could be lit and put out through the bulkhead. That is the fault
      // `deskChairTarget` found on the same wall with the same measurement, and
      // it is the same fix.
      activate: () => lamps.toggle(id),
    };
  });
}

/** What a station needs from whoever owns the player's body. */
export interface StationControl {
  /** Take this station, or leave it if the body is already in it. */
  use(name: StationName): void;
}

/**
 * The places a body puts itself, as things a player can point at and take.
 *
 * The lamps' shape, one table over. Each row closes over its own station name,
 * so nothing here has to parse a name back into a piece of furniture — which is
 * the mistake the `lamp:` prefix made and this file's head records.
 *
 * **One box, unlike a hatch's two.** A hatch has two sides; a seat has the side
 * you approach it from, and you do not climb over a desk or through a ship's
 * side to reach a bunk.
 */
function stationInteractables(control: StationControl): readonly Interactable[] {
  return SHIP_STATIONS.map((station) => ({
    name: station.name,
    isOn: () => isStationOccupied(station.name),
    // The occupied verb is only ever seen through the pick for the rows whose
    // target is the furniture rather than the floor — you can stand beside a
    // bunk you are lying in and be offered "Turn out", which is right. The
    // action bar shows the same verb from the seated view, where the pick is
    // not what offers it.
    verb: (occupied: boolean) => station.verb(occupied),
    targets: () =>
      (station.interactionTargets?.() ?? [station.target()]).map((box) => ({
        box,
        reachableFrom: [station.within()],
      })),
    activate: () => control.use(station.name),
  }));
}

/**
 * The registry, wired to the ship's own state.
 *
 * A function rather than a constant because two of the three kinds of row have
 * to reach a *runtime* object — the vessel that owns the lamps, and the thing
 * that holds the walker and writes the eye — and neither exists at module load.
 * The closures do not care, which is why they are still a module constant.
 */
export function buildShipInteractables(options: {
  lamps?: LampInteractionState;
  stations?: StationControl;
} = {}): Interactables {
  const rows: Interactable[] = [...CLOSURE_INTERACTABLES];
  if (options.lamps) rows.push(...lampInteractables(options.lamps));
  if (options.stations) rows.push(...stationInteractables(options.stations));
  return new Interactables(rows);
}
