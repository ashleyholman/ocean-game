import { INTERIOR_RENDER_ORDER, SHIP_RENDER_ORDER } from '../scene/interiorStencil';

/**
 * Where terrain sits in the opaque draw order, and why it is a switch (TERR-131).
 *
 * WHAT IT WAS DOING, WHICH NOBODY HAD WRITTEN DOWN
 * -----------------------------------------------
 * Terrain shipped at the default `renderOrder` of 0 — the same number the
 * ocean carries. Three then breaks that tie by projected origin depth, front
 * to back, and the ocean disc is centred ON the camera while land is
 * kilometres away. So the sea has always drawn FIRST and the land second, and
 * every ocean fragment hidden behind a headland was shaded in full and then
 * overwritten. That was never a decision; it fell out of two objects sharing a
 * number and one of them following the eye.
 *
 * WHAT THE SWITCH IS FOR
 * ----------------------
 * `before` gives terrain a lower render order than the sea, so land writes
 * depth first and the ocean — the most expensive shader in the frame, and the
 * one covering most of the screen — is rejected behind it by fixed-function
 * depth testing. That is the whole of TERR-131's "where beneficial", and the
 * benefit is a GPU number this round is not allowed to take. So the flip
 * exists, is live, is registered as an A/B switch, and DEFAULTS TO THE ORDER
 * THAT ALREADY SHIPPED.
 *
 * WHY IT IS NOT SIMPLY TURNED ON
 * ------------------------------
 * Both surfaces are opaque and both write depth, so the resolved image should
 * be identical either way. "Should" is doing real work in that sentence: the
 * depth function is LESS, not LEQUAL, so at the waterline — where the sea
 * surface and the shore meet within a depth quantum — a tie goes to whichever
 * drew first, and the flip changes which one that is. DEPTH-01's dashed
 * coastline is shoreline rendering, and this is the one change that could move
 * it. That question is answered with a pixel diff on a quiet machine
 * (`node tools/ab-sheet.mjs --switch terrainOrder --diff 8`), not with an
 * argument.
 *
 * THE NUMBERS
 * -----------
 * Both arms are explicit rather than defaulted, because a tie broken by the
 * ocean's origin is not an order — it is a coincidence that holds until
 * someone moves the sea disc. The ship's exterior and its interior keep the
 * two slots they need for the stencil mark (see `interiorStencil.ts`), and
 * terrain never takes either of them.
 */
export type TerrainDrawOrder = 'before' | 'after';

export const TERRAIN_DRAW_ORDERS: readonly TerrainDrawOrder[] = [
  'before',
  'after',
];

/** The order that ships: land after the sea, as the untouched tie resolved it. */
export const DEFAULT_TERRAIN_DRAW_ORDER: TerrainDrawOrder = 'after';

/** The ocean's own slot. Terrain is placed half a step either side of it. */
export const OCEAN_RENDER_ORDER = 0;

/**
 * Half-steps, because the integer slots around the sea are spoken for: the
 * hull at {@link SHIP_RENDER_ORDER} and the interior at
 * {@link INTERIOR_RENDER_ORDER} must stay adjacent and in that order or the
 * interior stencil marks through the planking.
 */
export const TERRAIN_RENDER_ORDER_BEFORE = OCEAN_RENDER_ORDER - 0.5;
export const TERRAIN_RENDER_ORDER_AFTER = OCEAN_RENDER_ORDER + 0.5;

export function terrainRenderOrderFor(order: TerrainDrawOrder): number {
  return order === 'before'
    ? TERRAIN_RENDER_ORDER_BEFORE
    : TERRAIN_RENDER_ORDER_AFTER;
}

/** Parse a URL arm. Throws rather than guessing, following `?terrain=`. */
export function parseTerrainDrawOrder(raw: string | null): TerrainDrawOrder {
  if (raw === null || raw.trim() === '') return DEFAULT_TERRAIN_DRAW_ORDER;
  const value = raw.trim();
  if (value === 'before' || value === 'after') return value;
  throw new Error(
    `[terrain] unknown ?terrainOrder=${raw} — use ${TERRAIN_DRAW_ORDERS.join(' | ')}`,
  );
}

let current: TerrainDrawOrder = DEFAULT_TERRAIN_DRAW_ORDER;
const listeners = new Set<(order: TerrainDrawOrder) => void>();

export function getTerrainDrawOrder(): TerrainDrawOrder {
  return current;
}

/**
 * Move the live order. Idempotent, so an A/B pass that re-applies the arm it
 * is already on does not churn every tile's render order.
 */
export function setTerrainDrawOrder(order: TerrainDrawOrder): void {
  if (order !== 'before' && order !== 'after') {
    throw new Error(`[terrain] unknown draw order '${order}'`);
  }
  if (order === current) return;
  current = order;
  for (const listener of listeners) listener(current);
}

/** Subscribe; the callback fires immediately with the current order. */
export function onTerrainDrawOrderChange(
  listener: (order: TerrainDrawOrder) => void,
): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Tests only: return the module to its shipped arm. */
export function resetTerrainDrawOrder(): void {
  setTerrainDrawOrder(DEFAULT_TERRAIN_DRAW_ORDER);
}
