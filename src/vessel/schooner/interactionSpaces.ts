import type { InteractableBox } from '../../player/Interactables';
import { belowDecksSpace, spaceDeckheadY } from './deckInterior';
import type { SpaceName } from './deckInterior';
import { HOLD_FLOOR_Y, HOLD_SOLE_Y } from './holdStow';
import { HULL_LENGTH } from './hullForm';

/** A storey or room from which one side of an interaction is physically reachable. */
export type InteractionSpaceName = SpaceName | 'hold' | 'weatherDeck';

/** Wider than the vessel anywhere; rooms are separated fore-and-aft here. */
const HALF_BEAM = 10;

/**
 * A room as an eye volume.
 *
 * This used to live with the station table. Lamps, closures and furniture all
 * need the same wall veto now, so keeping it with seats would make a room a
 * property of furniture rather than of reach.
 */
export function roomInteractionVolume(name: SpaceName): InteractableBox {
  const space = belowDecksSpace(name);
  // The centreline is the crown and therefore the highest ceiling in a decked
  // room. Sample along the room because sheer changes with station. An upper
  // bound at `sole + 4` used to include the weather deck above the forecastle,
  // which is precisely the cross-storey reach this volume exists to reject.
  let deckhead = space.soleY;
  for (let i = 0; i <= 24; i++) {
    const z = space.zAft + ((space.zForward - space.zAft) * i) / 24;
    deckhead = Math.max(deckhead, spaceDeckheadY(space, 0, z) ?? space.soleY);
  }
  return {
    xLo: -HALF_BEAM,
    xHi: HALF_BEAM,
    // This is an eye volume, not a body/step volume. Half a metre below the
    // sole overlaps the storey underneath: a hold-side eye at y 1.50 was then
    // admitted to the wardroom and could work its forward lantern straight
    // through intact planking. Three centimetres matches the deckhead tolerance
    // below and covers numerical settling without annexing another storey.
    yLo: space.soleY - 0.03,
    yHi: deckhead + 0.03,
    zLo: space.zAft,
    zHi: space.zForward,
  };
}

/**
 * Resolve the side of a deck or bulkhead a target belongs to.
 *
 * The weather deck varies with sheer and crown, so its lower boundary is the
 * target's own deck face rather than a global guessed height. That is the
 * distinction which keeps a forecastle eye below the planking from working a
 * lid or a climb above it. The hold has no `BelowDecksSpace` row, but its two
 * authoritative levels are already published by `holdStow`.
 */
export function interactionSpaceVolume(
  name: InteractionSpaceName,
  target: InteractableBox,
): InteractableBox {
  if (name !== 'hold' && name !== 'weatherDeck') return roomInteractionVolume(name);
  const halfLength = HULL_LENGTH * 0.5 + 1;
  if (name === 'hold') {
    return {
      xLo: -HALF_BEAM,
      xHi: HALF_BEAM,
      yLo: HOLD_FLOOR_Y - 0.5,
      yHi: HOLD_SOLE_Y + 0.05,
      zLo: -halfLength,
      zHi: halfLength,
    };
  }
  return {
    xLo: -HALF_BEAM,
    xHi: HALF_BEAM,
    // A weather-deck eye is above the surface it is working; an eye in the room
    // below is not. The target comes from that very surface, so no second deck
    // height is invented here.
    yLo: target.yLo - 1e-6,
    yHi: target.yHi + 4,
    zLo: -halfLength,
    zHi: halfLength,
  };
}
