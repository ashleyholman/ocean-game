export interface RuntimeFrameDeltas {
  /** Full monotonic wall delta; canonical astronomy consumes this value. */
  readonly rawRealSeconds: number;
  readonly rawRealMilliseconds: number;
  /** Bounded delta used by interactive physics and presentation. */
  readonly presentationSeconds: number;
}

interface MutableRuntimeFrameDeltas {
  rawRealSeconds: number;
  rawRealMilliseconds: number;
  presentationSeconds: number;
}

/**
 * Owns the conversion from browser callback time into named domain deltas.
 * The returned record is reused so sampling the frame clock allocates nothing.
 */
export class RuntimeFrameClock {
  private previousTimeMs: number;
  private readonly deltas: MutableRuntimeFrameDeltas = {
    rawRealSeconds: 0,
    rawRealMilliseconds: 0,
    presentationSeconds: 0,
  };

  constructor(
    initialTimeMs: number,
    private readonly maximumPresentationDeltaSeconds = 1 / 20,
  ) {
    this.previousTimeMs = initialTimeMs;
  }

  sample(nowMs: number): RuntimeFrameDeltas {
    const rawRealMilliseconds = Math.max(0, nowMs - this.previousTimeMs);
    this.previousTimeMs = nowMs;
    const rawRealSeconds = rawRealMilliseconds / 1000;
    this.deltas.rawRealMilliseconds = rawRealMilliseconds;
    this.deltas.rawRealSeconds = rawRealSeconds;
    this.deltas.presentationSeconds = Math.min(
      rawRealSeconds,
      this.maximumPresentationDeltaSeconds,
    );
    return this.deltas;
  }
}
