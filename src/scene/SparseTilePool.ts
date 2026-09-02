/**
 * Logical cloud tiles mapped onto a fixed pool of physical texture slots.
 *
 * The mapping is shared by front and staging: a logical tile always occupies
 * the same slot in both render targets, while the targets themselves continue
 * to swap atomically. Reconciliation drops tiles outside the current guard
 * before allocating new ones, so guard order is also overflow priority.
 */

export interface SparseTilePoolDelta {
  allocated: number[];
  evicted: number[];
  unmapped: number[];
}

export interface SparseAtlasLayout {
  capacity: number;
  columns: number;
  rows: number;
  gutter: number;
  tileWidth: number;
  tileHeight: number;
  slotWidth: number;
  slotHeight: number;
  width: number;
  height: number;
}

export class SparseTilePool {
  readonly logicalToSlot: Int16Array;
  readonly slotToLogical: Int16Array;

  constructor(
    readonly logicalTileCount: number,
    readonly capacity: number,
  ) {
    if (
      !Number.isInteger(logicalTileCount) ||
      logicalTileCount <= 0 ||
      !Number.isInteger(capacity) ||
      capacity <= 0 ||
      capacity > logicalTileCount ||
      capacity > 254
    ) {
      throw new RangeError(
        'Sparse tile counts must be positive, capacity-limited bytes',
      );
    }
    this.logicalToSlot = new Int16Array(logicalTileCount);
    this.logicalToSlot.fill(-1);
    this.slotToLogical = new Int16Array(capacity);
    this.slotToLogical.fill(-1);
  }

  /**
   * Drop every residency, returning the pool to its constructed state.
   *
   * Which logical tile owns which physical slot is history-dependent — it
   * follows the guard order the camera has walked through — so a restart that
   * leaves it alone hands the next scene a mapping the next scene did not
   * earn.
   */
  reset(): void {
    this.logicalToSlot.fill(-1);
    this.slotToLogical.fill(-1);
  }

  get residentCount(): number {
    let count = 0;
    for (const logical of this.slotToLogical) {
      if (logical >= 0) count++;
    }
    return count;
  }

  slotFor(logicalTile: number): number {
    this.assertLogical(logicalTile);
    return this.logicalToSlot[logicalTile];
  }

  /**
   * Retain exactly the ordered required set, allocating in the caller's
   * priority order. Entries beyond capacity are reported as unmapped.
   */
  reconcile(requiredInPriorityOrder: readonly number[]): SparseTilePoolDelta {
    const seen = new Uint8Array(this.logicalTileCount);
    const ordered: number[] = [];
    for (const logical of requiredInPriorityOrder) {
      this.assertLogical(logical);
      if (seen[logical]) continue;
      seen[logical] = 1;
      ordered.push(logical);
    }

    const retained = new Uint8Array(this.logicalTileCount);
    for (let index = 0; index < Math.min(ordered.length, this.capacity); index++) {
      retained[ordered[index]] = 1;
    }

    const evicted: number[] = [];
    for (let logical = 0; logical < this.logicalTileCount; logical++) {
      const slot = this.logicalToSlot[logical];
      if (slot < 0 || retained[logical]) continue;
      this.logicalToSlot[logical] = -1;
      this.slotToLogical[slot] = -1;
      evicted.push(logical);
    }

    const freeSlots: number[] = [];
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.slotToLogical[slot] < 0) freeSlots.push(slot);
    }

    const allocated: number[] = [];
    const unmapped = ordered.slice(this.capacity);
    let freeCursor = 0;
    for (let index = 0; index < Math.min(ordered.length, this.capacity); index++) {
      const logical = ordered[index];
      if (this.logicalToSlot[logical] >= 0) continue;
      const slot = freeSlots[freeCursor++];
      if (slot === undefined) throw new Error('Sparse tile pool lost a free slot');
      this.logicalToSlot[logical] = slot;
      this.slotToLogical[slot] = logical;
      allocated.push(logical);
    }

    return { allocated, evicted, unmapped };
  }

  private assertLogical(logicalTile: number): void {
    if (
      !Number.isInteger(logicalTile) ||
      logicalTile < 0 ||
      logicalTile >= this.logicalTileCount
    ) {
      throw new RangeError(
        `Logical tile ${logicalTile} is outside 0..${this.logicalTileCount - 1}`,
      );
    }
  }
}

/**
 * Pack fixed-size slots into the smallest practical 2D render target.
 *
 * Minimising the longest edge avoids unnecessary MAX_TEXTURE_SIZE pressure;
 * texel count is the tie-breaker when a non-factor capacity leaves spare cells.
 */
export function createSparseAtlasLayout(
  capacity: number,
  tileWidth: number,
  tileHeight: number,
  gutter = 1,
): SparseAtlasLayout {
  if (
    !Number.isInteger(capacity) ||
    capacity <= 0 ||
    !Number.isInteger(tileWidth) ||
    tileWidth <= 0 ||
    !Number.isInteger(tileHeight) ||
    tileHeight <= 0 ||
    !Number.isInteger(gutter) ||
    gutter < 0
  ) {
    throw new RangeError('Sparse atlas dimensions must be non-negative integers');
  }

  const slotWidth = tileWidth + gutter * 2;
  const slotHeight = tileHeight + gutter * 2;
  let bestColumns = 1;
  let bestRows = capacity;
  let bestLongestEdge = Math.max(slotWidth, bestRows * slotHeight);
  let bestTexels = slotWidth * bestRows * slotHeight;

  for (let columns = 2; columns <= capacity; columns++) {
    const rows = Math.ceil(capacity / columns);
    const width = columns * slotWidth;
    const height = rows * slotHeight;
    const longestEdge = Math.max(width, height);
    const texels = width * height;
    if (
      longestEdge < bestLongestEdge ||
      (longestEdge === bestLongestEdge && texels < bestTexels)
    ) {
      bestColumns = columns;
      bestRows = rows;
      bestLongestEdge = longestEdge;
      bestTexels = texels;
    }
  }

  return {
    capacity,
    columns: bestColumns,
    rows: bestRows,
    gutter,
    tileWidth,
    tileHeight,
    slotWidth,
    slotHeight,
    width: bestColumns * slotWidth,
    height: bestRows * slotHeight,
  };
}
