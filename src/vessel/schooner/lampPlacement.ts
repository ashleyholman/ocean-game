import { belowDecksSpace } from './deckInterior';
import type { SpaceName } from './deckInterior';
import { deckBeamHangPoint } from './shipGeometry';

/**
 * Where the lanterns hang below decks.
 *
 * One table, two readers: the Schooner mounts the lamps here, and the
 * interactables put the Space action's reach box around the same point.
 * A position typed twice is the "two sources for one position" fault the
 * interior has now found six times, so there is exactly one.
 *
 * Each hang is a NOMINAL x and z; the real point snaps to the nearest full
 * deck beam via `deckBeamHangPoint`, so the hook lands on drawn timber and
 * a re-spaced deckhead carries every lamp with it. Snapping to a full beam
 * also keeps a lamp out of every opening by construction — interrupted
 * beams over a hatch are not offered.
 *
 * A hang is a LAMP, not a room: rooms and lamps are many-to-one (the
 * wardroom carries two — it is the longest space below and one flame left
 * its far end dark), and every lamp in a room answers to that one room's
 * daylight signal.
 *
 * The spots themselves: the cabin and landing are still first guesses (off
 * the centreline, clear of the walking lines and the ladder). The wardroom
 * pair and the forecastle are **Ash's own ray marks** (2026-08-15), taken
 * by clicking the deckhead where he wanted each hook — the numbers below
 * are his hit points, and each lands within 3 cm of a beam soffit because
 * that is what he clicked on. They sit further outboard than the guesses
 * did, which is what solves two faults at once: the wardroom's aft lamp
 * had hung dead on the bilge pump's shaft (PUMP_X 0.55, PUMP_Z −1.35 —
 * the chain ran THROUGH the pump), and the forecastle's had sat 0.5 m off
 * the foremast, whose column swallowed half that room in its own shadow.
 * A metre out from the centreline clears both, and the fore bulkhead and
 * the ship's side become bounce cards rather than the mast a shadow mask.
 */
export const LAMP_HANGS = [
  { id: 'cabin', room: 'cabin', x: 0.55, nearZ: -6.4 },
  { id: 'landing', room: 'landing', x: -0.55, nearZ: -3.9 },
  { id: 'wardroom-aft', room: 'wardroom', x: -0.9245, nearZ: -0.9133 },
  { id: 'wardroom-fore', room: 'wardroom', x: 1.0415, nearZ: 1.0979 },
  { id: 'forecastle', room: 'forecastle', x: -1.0052, nearZ: 4.1711 },
] as const;

export type LampId = (typeof LAMP_HANGS)[number]['id'];
export type LampRoomName = (typeof LAMP_HANGS)[number]['room'];

/** The rooms that carry at least one lamp, each once — the signal keys. */
export const LAMP_ROOMS: readonly LampRoomName[] = [
  ...new Set(LAMP_HANGS.map((hang) => hang.room)),
];

/** Hook seat to flame, metres — the chain is sized to fill it. */
export const LAMP_DROP = 0.42;

/** Half-extent of the Space action's reach box around the lantern body. */
export const LAMP_REACH_HALF = 0.22;

/**
 * The resolved hang point for one lamp: on the nearest full beam's
 * underside. Falls back to the nominal spot 1.7 m over the sole only if a
 * space somehow offers no beam — which would itself be a geometry fault.
 */
export function lampHangPoint(id: LampId): {
  x: number;
  y: number;
  z: number;
} {
  const hang = LAMP_HANGS.find((candidate) => candidate.id === id);
  if (!hang) throw new Error(`no lamp hang named ${id}`);
  const space = belowDecksSpace(hang.room as SpaceName);
  const beam = deckBeamHangPoint(space, hang.x, hang.nearZ);
  if (beam) return { x: hang.x, y: beam.y, z: beam.z };
  return { x: hang.x, y: space.soleY + 1.7, z: hang.nearZ };
}
