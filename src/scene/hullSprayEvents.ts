import type { WakeSources } from '../vessel/WakeSources';
import {
  SPRAY_TEAR_MAX_SECONDS,
  createWakeSprayBurstSizing,
  createWakeSprayPolicyResult,
  resolveWakeSprayPolicy,
  sizeWakeSprayBurst,
  type WakeSprayBurstSizing,
  type WakeSprayPolicyInput,
  type WakeSprayPolicyResult,
} from './wakePolicy';

/**
 * WK3's bow-entry event detector.
 *
 * WHAT AN EVENT IS
 * ----------------
 * A **tear**, in exactly `CrestSpray`'s sense of the word. It opens the moment
 * the bow's *entry drive* crosses a threshold — one identifiable instant when
 * she drove her nose into a wave hard enough to throw water — then sheds
 * continuously for as long as she is still going in, and closes when the drive
 * falls back. It is not a per-frame emission field, and it is not a one-shot
 * burst either.
 *
 * The one-shot was the tempting design and it is the one the crest-spray round
 * already paid for: "the second version emitted each sheet as one instantaneous
 * burst. That reads as popcorn — discrete puffs going off at random with no
 * relationship to anything, all with the same duration because they all had the
 * same parameters." A bow entry is a moving source with a duration, so it is
 * built as one, and the shedding rate is re-derived every frame from the live
 * drive rather than from an envelope. Nothing here has a scripted fade.
 *
 * WHAT DRIVES IT
 * --------------
 * The drive is a power (see `wakePolicy.SPRAY_ENTRY_POWER_REFERENCE_W`): the
 * rate at which the bow third is displacing water, times the square of the
 * speed it is displacing it at, gated by way through the water. All three facts
 * are kept separate on purpose. WK0-F1 established that entry speed alone fires
 * at anchor; this round measured that entry *power* alone does too — the
 * anchored moderate case's p95 is 5 860 W against the moderate reach's 20 206 W,
 * 29% of it, and its maximum exceeds the reach's p95. Only way through the water
 * separates "she is driving her bow in" from "she is bobbing".
 *
 * WHY IT LIVES HERE AND NOT IN `WakeSources`
 * ------------------------------------------
 * Because it needs yesterday. The immersion rate is a difference between two
 * frames and the tear is a memory of what is already open. `WakeSources` is a
 * condensation step that owns no history and must keep owning none, so the
 * history lives in this class and the arithmetic lives in `wakePolicy`, where
 * it can be tested without either.
 *
 * ONE-WAY, LIKE EVERYTHING ELSE IN THIS THREAD
 * --------------------------------------------
 * This reads `WakeSources` and writes a burst description. It holds no
 * reference to the body, the wave field or canonical state, and it exposes no
 * method that could write to one.
 */

/** Water leaving the hull this frame, in render/world coordinates. */
export interface HullSprayBurst {
  /** False on every frame with no tear open, which is nearly all of them. */
  active: boolean;
  /** Midpoint of the stem's resolved waterline cut — where the sheet leaves. */
  originX: number;
  originY: number;
  originZ: number;
  /**
   * Half the stem's waterline cut, starboard-to-port.
   *
   * Droplets are spread along ±this from the origin, so one tear is the sheet
   * off *both* bows rather than a jet from a point. It also carries the side
   * identity: a droplet placed at +spread is to port and its outboard push is
   * +spread. The sign therefore comes from `WakeSources`' already-tested
   * port/starboard classification and is never reasoned about here.
   */
  spreadX: number;
  spreadY: number;
  spreadZ: number;
  /** Unit direction the sheet is thrown along — the hull's way through water. */
  alongX: number;
  alongY: number;
  alongZ: number;
  /** Unit outward water-surface normal at the entry: the lift direction. */
  liftX: number;
  liftY: number;
  liftZ: number;
  throwSpeedMps: number;
  liftSpeedMps: number;
  /** Outboard speed at the ends of the spread, m/s. Zero on the centreline. */
  outboardSpeedMps: number;
  /** Whole droplets to shed this frame. Carries the fraction between frames. */
  dropletCount: number;
  /** 0..1 droplet-size bias: 0 spume, 1 heavy drops. */
  coarseness: number;
  /** Per-droplet opacity weight. */
  opacity: number;
  /** 0..1 live strength of the tear this frame. Diagnostic. */
  strength: number;
}

export function createHullSprayBurst(): HullSprayBurst {
  return {
    active: false,
    originX: 0,
    originY: 0,
    originZ: 0,
    spreadX: 0,
    spreadY: 0,
    spreadZ: 0,
    alongX: 0,
    alongY: 0,
    alongZ: 1,
    liftX: 0,
    liftY: 1,
    liftZ: 0,
    throwSpeedMps: 0,
    liftSpeedMps: 0,
    outboardSpeedMps: 0,
    dropletCount: 0,
    coarseness: 0,
    opacity: 0,
    strength: 0,
  };
}

export interface HullSprayEventInput {
  dtSeconds: number;
  speedThroughWaterMps: number;
  ambientWhitecapCoverage: number;
  /** Lab multiplier on shed density. Production and evidence both use 1. */
  densityScale: number;
  /** Master and feature gates, already combined by the caller. */
  enabled: boolean;
}

export class HullSprayEventDetector {
  readonly policy: WakeSprayPolicyResult = createWakeSprayPolicyResult();
  readonly sizing: WakeSprayBurstSizing = createWakeSprayBurstSizing();
  readonly burst: HullSprayBurst = createHullSprayBurst();

  /** Tears opened since construction or the last `reset()`. */
  eventCount = 0;
  /** Bow immersion rate resolved this frame, m³/s. Diagnostic and evidence. */
  bowImmersionRateM3PerSec = 0;
  /** Seconds the current tear has been open; zero when none is. */
  tearAgeSeconds = 0;

  private previousBowVolumeM3: number | undefined;
  private tearOpen = false;
  private refractorySeconds = 0;
  private dropletCarry = 0;

  private readonly policyInput: WakeSprayPolicyInput = {
    speedThroughWaterMps: 0,
    ambientWhitecapCoverage: 0,
    bowImmersionRateM3PerSec: 0,
    bowPeakEntrySpeedMps: 0,
  };

  /** Forget the previous frame. A reset ship has no entry in progress. */
  reset(): void {
    this.previousBowVolumeM3 = undefined;
    this.tearOpen = false;
    this.refractorySeconds = 0;
    this.dropletCarry = 0;
    this.tearAgeSeconds = 0;
    this.bowImmersionRateM3PerSec = 0;
    this.burst.active = false;
    this.eventCount = 0;
  }

  /** True on the frame a tear opened. The rate this bounds is the event rate. */
  get tearIsOpen(): boolean {
    return this.tearOpen;
  }

  /**
   * Advance one presentation frame.
   *
   * Returns true when a burst is published this frame, which is any frame with
   * a tear open and droplets to shed. `burst.active` carries the same answer
   * for consumers that read the stable graph instead.
   */
  update(
    sources: Readonly<WakeSources>,
    input: Readonly<HullSprayEventInput>,
  ): boolean {
    const burst = this.burst;
    burst.active = false;
    burst.dropletCount = 0;

    const dt = input.dtSeconds;
    if (!Number.isFinite(dt) || dt <= 0) return false;
    if (!Number.isFinite(input.densityScale) || input.densityScale < 0) {
      throw new RangeError(
        `hull spray density scale must be finite and non-negative, got ${input.densityScale}`,
      );
    }
    this.refractorySeconds = Math.max(0, this.refractorySeconds - dt);

    const bow = sources.regions.bow;
    const volume = bow.immersedVolumeM3;
    const previous = this.previousBowVolumeM3;
    this.previousBowVolumeM3 = volume;
    // The first frame after construction or a reset has no previous volume, so
    // it has no rate. Counting the whole immersed bow as one frame's worth of
    // entry would open a tear on the frame the ship appears.
    const rate = previous === undefined ? 0 : (volume - previous) / dt;
    this.bowImmersionRateM3PerSec = rate;

    this.policyInput.speedThroughWaterMps = input.speedThroughWaterMps;
    this.policyInput.ambientWhitecapCoverage = input.ambientWhitecapCoverage;
    this.policyInput.bowImmersionRateM3PerSec = rate;
    this.policyInput.bowPeakEntrySpeedMps = bow.peakEntrySpeedMps;
    const policy = resolveWakeSprayPolicy(this.policyInput, this.policy);
    const drive = policy.entryDrive;

    if (!input.enabled) {
      this.closeTear();
      return false;
    }

    // TWO STATES AND TWO RULES, AND THE SECOND ONE WAS A BUG FIRST
    // ------------------------------------------------------------
    // An earlier draft carried a separate `armed` flag that only cleared when
    // the drive fell back below the release. The adversarial gate — the drive
    // pinned at forty times the threshold for a minute — found what that
    // costs: the duration cap closed the first tear, the drive never fell, the
    // flag never cleared, and the cue died silently for the rest of the run
    // while she was still burying her bow.
    //
    // The flag was also redundant. Chatter protection is entirely the release
    // threshold's job (a tear simply stays open through a dip that does not
    // reach it), and rate protection is entirely the refractory's. So there is
    // one boolean, and both ways out of a tear leave the detector ready.
    if (this.tearOpen) {
      this.tearAgeSeconds += dt;
      // Closed by the sea, not by a schedule — the drive fell away on its own.
      // The duration cap is the other way out, and it is a bound rather than a
      // plan: the release normally gets there first, and when it does not, she
      // is genuinely still going in and the refractory decides when the next
      // tear may open.
      if (
        drive < policy.releaseThreshold ||
        this.tearAgeSeconds >= SPRAY_TEAR_MAX_SECONDS
      ) {
        this.closeTear();
        return false;
      }
    } else if (
      this.refractorySeconds === 0 &&
      drive >= policy.armThreshold
    ) {
      this.tearOpen = true;
      this.tearAgeSeconds = 0;
      this.dropletCarry = 0;
      this.refractorySeconds = policy.minimumIntervalSeconds;
      this.eventCount++;
    } else {
      return false;
    }

    const stem = sources.bowStemWaterline;
    const entry = sources.bowEntry;
    // No resolved stem cut is no place to put the sheet. This is a real state:
    // a bow completely clear of the water at the top of a pitch has no
    // two-sided waterline intersection at all. The tear stays open — she is
    // still in the middle of the plunge — but it sheds nothing this frame.
    if (!stem.active || !entry.active) return false;

    const flowX = entry.relativeFlow.x;
    const flowZ = entry.relativeFlow.z;
    const flowSpeed = Math.hypot(flowX, flowZ);
    if (flowSpeed <= 1e-4) return false;

    // Re-derived every frame from the *live* drive, so the tear sheds hardest
    // at the bottom of the plunge and thins as she comes out, with no envelope
    // anywhere. This is the whole shedding schedule.
    const sizing = sizeWakeSprayBurst(
      {
        entryDrive: drive,
        armThreshold: policy.armThreshold,
        entrySpeedMps: entry.entrySpeedMps,
        relativeFlowMps: flowSpeed,
        seaMask: policy.seaMask,
      },
      this.sizing,
    );

    this.dropletCarry += sizing.dropletsPerSecond * input.densityScale * dt;
    const shed = Math.floor(this.dropletCarry);
    this.dropletCarry -= shed;
    if (shed <= 0) return false;

    burst.active = true;
    burst.dropletCount = shed;
    burst.originX = (stem.port.x + stem.starboard.x) * 0.5;
    burst.originY = (stem.port.y + stem.starboard.y) * 0.5;
    burst.originZ = (stem.port.z + stem.starboard.z) * 0.5;
    // Half the cut, starboard toward port. `spread` is therefore the port
    // direction by construction and a droplet drawn at -spread is to starboard:
    // no sign is chosen here, it is read off contact data that already has a
    // test on its sides.
    burst.spreadX = (stem.port.x - stem.starboard.x) * 0.5;
    burst.spreadY = (stem.port.y - stem.starboard.y) * 0.5;
    burst.spreadZ = (stem.port.z - stem.starboard.z) * 0.5;

    // The hull's way through the water is minus the flow it meets. Horizontal
    // only: the vertical part of the throw is the lift term, which has the
    // surface normal to point it and no business being mixed in here.
    burst.alongX = -flowX / flowSpeed;
    burst.alongY = 0;
    burst.alongZ = -flowZ / flowSpeed;

    const nx = entry.surfaceNormal.x;
    const ny = entry.surfaceNormal.y;
    const nz = entry.surfaceNormal.z;
    const nLength = Math.hypot(nx, ny, nz) || 1;
    burst.liftX = nx / nLength;
    burst.liftY = ny / nLength;
    burst.liftZ = nz / nLength;

    burst.throwSpeedMps = sizing.throwSpeedMps;
    burst.liftSpeedMps = sizing.liftSpeedMps;
    burst.outboardSpeedMps = sizing.throwSpeedMps * sizing.outboardFraction;
    burst.coarseness = sizing.coarseness;
    burst.opacity = sizing.opacity;
    burst.strength = sizing.strength;
    return true;
  }

  private closeTear(): void {
    this.tearOpen = false;
    this.tearAgeSeconds = 0;
    this.dropletCarry = 0;
    this.burst.active = false;
    this.burst.dropletCount = 0;
  }
}
