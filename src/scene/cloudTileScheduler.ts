/**
 * Pure scheduler for a synchronized cloud-cache generation.
 *
 * Tiles are marched into a staging target over sixty rendered frames, but
 * none become visible early. At the generation boundary CloudDome publishes
 * the staging target atomically, so every cloud-shape/shadow update still
 * reads as one coherent tick.
 */

export const CLOUD_TILE_REFRESH_FRAMES = 60;

export interface CloudTileSchedule {
  indices: number[];
  /** Normal round-robin tiles selected inside the fixed steady budget. */
  steadyCount: number;
  /** Missing required tiles added on the final frame before the atomic swap. */
  catchUpCount: number;
  steadyBudget: number;
}

export class CloudTileScheduler {
  private cursor = 0;

  constructor(readonly tileCount: number) {}

  /**
   * Return the round robin to the position a freshly built scheduler is in.
   *
   * The cursor is the whole reason "stage this scene, then stage it again"
   * did not reproduce. It is ordinary object state that survives a
   * `resetSimulation`, so two stagings of one scene entered the amortized
   * generation at different points in the tile order, froze different subsets
   * of the cache, and drew a slightly different sky — measured at mean
   * 1.37/255 against 0.14 with the warm frames removed. Restarting the
   * simulation has to restart this too, or the cache remembers a scene the
   * rest of the world has forgotten.
   */
  reset(): void {
    this.cursor = 0;
  }

  /** Where the round robin will begin its next scan. Diagnostics only. */
  get nextIndex(): number {
    return this.cursor;
  }

  select(
    generation: number,
    readyGeneration: Int32Array,
    required: ReadonlySet<number>,
    frameInGeneration: number,
    finishGeneration: boolean,
  ): CloudTileSchedule {
    if (readyGeneration.length !== this.tileCount) {
      throw new RangeError('Cloud readiness array does not match the tile grid');
    }
    for (const index of required) this.assertIndex(index);
    if (
      !Number.isInteger(frameInGeneration) ||
      frameInGeneration < 0 ||
      frameInGeneration >= CLOUD_TILE_REFRESH_FRAMES
    ) {
      throw new RangeError('Cloud generation frame must be inside the refresh cycle');
    }

    // Fractional distribution over exactly sixty frames. For 66 tiles this is
    // one tile on 54 frames and two on six frames, not 2x33 then 0x27.
    const desiredReady = Math.ceil(
      (required.size * (frameInGeneration + 1)) /
        CLOUD_TILE_REFRESH_FRAMES,
    );
    const previousDesired = Math.ceil(
      (required.size * frameInGeneration) /
        CLOUD_TILE_REFRESH_FRAMES,
    );
    const steadyBudget = desiredReady - previousDesired;
    const indices: number[] = [];
    const selected = new Set<number>();
    let steadyCount = 0;
    let scanned = 0;

    // Global-index round robin: a small camera move changes membership without
    // throwing away the cursor's progress through the existing guard band.
    while (
      steadyCount < steadyBudget &&
      scanned < this.tileCount &&
      this.tileCount > 0
    ) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % this.tileCount;
      scanned++;
      if (
        !required.has(index) ||
        readyGeneration[index] === generation
      ) {
        continue;
      }
      indices.push(index);
      selected.add(index);
      steadyCount++;
    }

    // On the swap frame, camera movement is allowed to cost extra work, but
    // the new front target may not expose a tile from an older generation.
    let catchUpCount = 0;
    if (finishGeneration) {
      for (const index of required) {
        if (
          readyGeneration[index] === generation ||
          selected.has(index)
        ) {
          continue;
        }
        indices.push(index);
        selected.add(index);
        catchUpCount++;
      }
    }

    return {
      indices,
      steadyCount,
      catchUpCount,
      steadyBudget,
    };
  }

  markReady(
    generation: number,
    readyGeneration: Int32Array,
    indices: readonly number[],
  ): void {
    if (readyGeneration.length !== this.tileCount) {
      throw new RangeError('Cloud readiness array does not match the tile grid');
    }
    for (const index of indices) {
      this.assertIndex(index);
      readyGeneration[index] = generation;
    }
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.tileCount) {
      throw new RangeError(
        `Cloud tile index ${index} is outside 0..${this.tileCount - 1}`,
      );
    }
  }
}
