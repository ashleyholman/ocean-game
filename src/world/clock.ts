import { assertFiniteNumber, assertNonNegativeFinite } from './math';
import type { CanonicalWorldState } from './types';

export const WORLD_SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The single tuning point for the default shortened day. The astronomical
 * clock and the separately held voyage-time compression both initialise from
 * it, then debug astronomy controls may vary without changing the voyage.
 */
export const DEFAULT_REAL_MINUTES_PER_WORLD_DAY = 48;

export const DEFAULT_REAL_SECONDS_PER_WORLD_DAY =
  DEFAULT_REAL_MINUTES_PER_WORLD_DAY * 60;

export const DEFAULT_WORLD_SECONDS_PER_REAL_SECOND =
  WORLD_SECONDS_PER_DAY / DEFAULT_REAL_SECONDS_PER_WORLD_DAY;

/**
 * Default voyage-time compression — the rate at which the vessel moves
 * through *world coordinates*, distinct from the astronomical clock above.
 *
 * This was the astronomical 30× until terrain rendered. With no world-anchored
 * object in view the compression was invisible; the first headland made it a
 * picture: land slid across the horizon at 30× while the ship, sea, and sky
 * all read as 1×, so the island appeared to be moving on its own. Distance
 * made good is now honest by default, and any faster passage-making is an
 * explicit, visible choice through the voyage clock controls rather than a
 * silent constant. The astronomical calendar keeps its 30× day — crew-work
 * costs charged to the day (`CREW_EVOLUTION_WORLD_SECONDS`) still convert
 * against `DEFAULT_WORLD_SECONDS_PER_REAL_SECOND`, not against this.
 */
export const DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND = 1;

/**
 * Deterministic clock view over canonical state. It owns no mirrored instant.
 * It is an astronomy/calendar clock only: no method here can move a vessel or
 * alter a velocity.
 */
export class WorldClock {
  constructor(private readonly state: CanonicalWorldState) {}

  get currentUtcSeconds(): number {
    return this.state.worldInstantUtcSeconds;
  }

  get worldSecondsPerRealSecond(): number {
    return this.state.worldSecondsPerRealSecond;
  }

  get paused(): boolean {
    return this.state.paused;
  }

  worldDeltaForRealSeconds(realDeltaSeconds: number): number {
    assertNonNegativeFinite(realDeltaSeconds, 'realDeltaSeconds');
    return this.state.paused
      ? 0
      : realDeltaSeconds * this.state.worldSecondsPerRealSecond;
  }

  commitWorldDelta(worldDeltaSeconds: number): void {
    assertNonNegativeFinite(worldDeltaSeconds, 'worldDeltaSeconds');
    this.state.worldInstantUtcSeconds += worldDeltaSeconds;
  }

  setCurrentUtcSeconds(worldInstantUtcSeconds: number): void {
    assertFiniteNumber(worldInstantUtcSeconds, 'worldInstantUtcSeconds');
    this.state.worldInstantUtcSeconds = worldInstantUtcSeconds;
  }

  setWorldSecondsPerRealSecond(multiplier: number): void {
    assertNonNegativeFinite(multiplier, 'worldSecondsPerRealSecond');
    this.state.worldSecondsPerRealSecond = multiplier;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
  }
}

export class PresentationClock {
  elapsedSeconds = 0;

  advanceRealSeconds(realDeltaSeconds: number): number {
    assertNonNegativeFinite(realDeltaSeconds, 'realDeltaSeconds');
    this.elapsedSeconds += realDeltaSeconds;
    return realDeltaSeconds;
  }

  setElapsedSeconds(elapsedSeconds: number): void {
    assertNonNegativeFinite(elapsedSeconds, 'elapsedSeconds');
    this.elapsedSeconds = elapsedSeconds;
  }
}
