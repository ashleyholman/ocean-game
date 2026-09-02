/**
 * One deterministic, presentation-only spatial gust field.
 *
 * The field lives in canonical ECEF space, not in the observer-centred ocean
 * disc and not in WaveField parameter history. The CPU wraps the canonical
 * origin into unit cycles before upload, then supplies the transported local
 * X/Z basis separately. Moving or rotating the render origin therefore changes
 * only a small affine basis; it never rotates a many-kilometre shader lattice.
 *
 * Four integer spatial harmonics make the field exactly periodic in each ECEF
 * coordinate, band-limited, zero-mean, and bounded to [-1, 1]. Their weights
 * sum to one. `gustExcessMps` is consequently the maximum signed departure
 * from the ten-metre mean wind, in m/s. The pattern advects downwind at one
 * dominant patch per `periodSeconds`; advection is integrated in wrapped
 * canonical cycles so a changing wind direction bends its path continuously
 * instead of multiplying a new direction by a large absolute time.
 *
 * This module owns both the CPU evaluator and the GLSL emitted into FoamField
 * and Ocean. Wave displacement, buoyancy and orbital velocity never import it.
 */

import type { CanonicalWorldState } from '../world/types';

const TAU = Math.PI * 2;

export const CATS_PAW_DEFAULT_SEED = 0x43617473; // 'Cats'

interface CatsPawHarmonic {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly weight: number;
  readonly phaseCycles: number;
}

/** Integer wave vectors preserve the unit-period wrap exactly. */
export const CATS_PAW_HARMONICS: readonly CatsPawHarmonic[] = Object.freeze([
  Object.freeze({ x: 1, y: 1, z: 0, weight: 0.40, phaseCycles: 0.083 }),
  Object.freeze({ x: -1, y: 0, z: 1, weight: 0.28, phaseCycles: 0.317 }),
  Object.freeze({ x: 0, y: 1, z: -1, weight: 0.20, phaseCycles: 0.619 }),
  Object.freeze({ x: 1, y: -2, z: 1, weight: 0.12, phaseCycles: 0.877 }),
]);

export interface CatsPawVector3 {
  x: number;
  y: number;
  z: number;
}

export interface CatsPawFieldFrame {
  /** Maximum signed local departure from the mean wind, m/s. */
  gustExcessMps: number;
  /** Dominant field scale, metres. */
  patchSizeM: number;
  /** Time for the field to advect by one dominant patch, seconds. */
  periodSeconds: number;
  /** Wrapped canonical coordinate of local render (0, 0), in field cycles. */
  readonly originCycles: CatsPawVector3;
  /** ECEF change per +1 local render X metre, in field cycles. */
  readonly axisXCyclesPerM: CatsPawVector3;
  /** ECEF change per +1 local render Z metre, in field cycles. */
  readonly axisZCyclesPerM: CatsPawVector3;
}

export interface CatsPawFieldConfig {
  readonly gustExcessMps: number;
  readonly patchSizeM: number;
  readonly periodSeconds: number;
}

export interface CatsPawWindDirection {
  /** Local render +X component. */
  readonly x: number;
  /** Local render +Z component (THREE.Vector2.y). */
  readonly y: number;
}

function vector3(): CatsPawVector3 {
  return { x: 0, y: 0, z: 0 };
}

function wrapUnit(value: number): number {
  const wrapped = value - Math.floor(value);
  return wrapped === 1 ? 0 : wrapped;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive, got ${value}`);
  }
}

function seedCycles(seed: number, out: CatsPawVector3): void {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  out.x = next();
  out.y = next();
  out.z = next();
}

/**
 * Mutable publisher retained by the production runtime. Consumers retain this
 * one frame object; no per-frame weather allocation is required.
 */
export class CatsPawField {
  readonly frame: CatsPawFieldFrame = {
    gustExcessMps: 0,
    patchSizeM: 100,
    periodSeconds: 40,
    originCycles: vector3(),
    axisXCyclesPerM: vector3(),
    axisZCyclesPerM: vector3(),
  };

  private readonly seedOffset = vector3();
  private readonly advectionCycles = vector3();
  private previousElapsedSeconds: number | undefined;

  constructor(readonly seed = CATS_PAW_DEFAULT_SEED) {
    seedCycles(seed, this.seedOffset);
  }

  /** Reset the advected phase; the next update is a deterministic replay. */
  reset(): void {
    this.advectionCycles.x = 0;
    this.advectionCycles.y = 0;
    this.advectionCycles.z = 0;
    this.previousElapsedSeconds = undefined;
  }

  /**
   * Advance the presentation field and publish its local affine frame.
   *
   * `elapsedSeconds` is ordinary presentation time. A backwards clock is a
   * reset, which makes capture/restart deterministic without another reset
   * authority. The transported ECEF frame maps local +X directly to right and
   * local +Z to negative forward, matching the Three.js render convention.
   */
  update(
    elapsedSeconds: number,
    world: Readonly<CanonicalWorldState>,
    windDirection: Readonly<CatsPawWindDirection>,
    config: Readonly<CatsPawFieldConfig>,
  ): Readonly<CatsPawFieldFrame> {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError(
        `cat's-paw elapsed time must be finite and non-negative, got ${elapsedSeconds}`,
      );
    }
    if (!Number.isFinite(config.gustExcessMps) || config.gustExcessMps < 0) {
      throw new RangeError(
        `cat's-paw gust excess must be finite and non-negative, got ${config.gustExcessMps}`,
      );
    }
    assertPositiveFinite(config.patchSizeM, "cat's-paw patch size");
    assertPositiveFinite(config.periodSeconds, "cat's-paw period");

    if (
      this.previousElapsedSeconds !== undefined &&
      elapsedSeconds < this.previousElapsedSeconds
    ) {
      this.reset();
    }
    const deltaSeconds =
      this.previousElapsedSeconds === undefined
        ? elapsedSeconds
        : elapsedSeconds - this.previousElapsedSeconds;
    this.previousElapsedSeconds = elapsedSeconds;

    const windLength = Math.hypot(windDirection.x, windDirection.y);
    if (deltaSeconds > 0 && windLength > 1e-9) {
      const localX = windDirection.x / windLength;
      const localZ = windDirection.y / windLength;
      const frame = world.surfaceFrameEcef;
      // local +Z maps to ECEF -forward.
      const ecefX = frame.right.x * localX - frame.forward.x * localZ;
      const ecefY = frame.right.y * localX - frame.forward.y * localZ;
      const ecefZ = frame.right.z * localX - frame.forward.z * localZ;
      const deltaCycles = deltaSeconds / config.periodSeconds;
      this.advectionCycles.x = wrapUnit(
        this.advectionCycles.x + ecefX * deltaCycles,
      );
      this.advectionCycles.y = wrapUnit(
        this.advectionCycles.y + ecefY * deltaCycles,
      );
      this.advectionCycles.z = wrapUnit(
        this.advectionCycles.z + ecefZ * deltaCycles,
      );
    }

    const inversePatch = 1 / config.patchSizeM;
    const localFrame = world.surfaceFrameEcef;
    const origin = this.frame.originCycles;
    origin.x = wrapUnit(
      world.positionEcefM.x * inversePatch -
        this.advectionCycles.x +
        this.seedOffset.x,
    );
    origin.y = wrapUnit(
      world.positionEcefM.y * inversePatch -
        this.advectionCycles.y +
        this.seedOffset.y,
    );
    origin.z = wrapUnit(
      world.positionEcefM.z * inversePatch -
        this.advectionCycles.z +
        this.seedOffset.z,
    );

    const axisX = this.frame.axisXCyclesPerM;
    axisX.x = localFrame.right.x * inversePatch;
    axisX.y = localFrame.right.y * inversePatch;
    axisX.z = localFrame.right.z * inversePatch;

    const axisZ = this.frame.axisZCyclesPerM;
    axisZ.x = -localFrame.forward.x * inversePatch;
    axisZ.y = -localFrame.forward.y * inversePatch;
    axisZ.z = -localFrame.forward.z * inversePatch;

    this.frame.gustExcessMps = config.gustExcessMps;
    this.frame.patchSizeM = config.patchSizeM;
    this.frame.periodSeconds = config.periodSeconds;
    return this.frame;
  }
}

/** The normalised, zero-mean field value at a local render-space point. */
export function sampleCatsPawField(
  frame: Readonly<CatsPawFieldFrame>,
  localX: number,
  localZ: number,
): number {
  const qx = wrapUnit(
    frame.originCycles.x +
      frame.axisXCyclesPerM.x * localX +
      frame.axisZCyclesPerM.x * localZ,
  );
  const qy = wrapUnit(
    frame.originCycles.y +
      frame.axisXCyclesPerM.y * localX +
      frame.axisZCyclesPerM.y * localZ,
  );
  const qz = wrapUnit(
    frame.originCycles.z +
      frame.axisXCyclesPerM.z * localX +
      frame.axisZCyclesPerM.z * localZ,
  );
  let value = 0;
  for (const harmonic of CATS_PAW_HARMONICS) {
    const phase = wrapUnit(
      qx * harmonic.x +
        qy * harmonic.y +
        qz * harmonic.z +
        harmonic.phaseCycles,
    );
    value += harmonic.weight * Math.sin(TAU * phase);
  }
  return value;
}

/**
 * Float32 evaluation of the same arithmetic used by the highp GLSL path.
 * Tests compare this with the double-precision CPU decision path at shared
 * points; the accepted tolerance is the shader's float rounding, not tuning.
 */
export function sampleCatsPawFieldGpuMirror(
  frame: Readonly<CatsPawFieldFrame>,
  localX: number,
  localZ: number,
): number {
  const f = Math.fround;
  const x = f(localX);
  const z = f(localZ);
  const coordinate = (
    origin: number,
    axisX: number,
    axisZ: number,
  ): number =>
    wrapUnit(f(f(origin) + f(f(axisX) * x) + f(f(axisZ) * z)));
  const qx = coordinate(
    frame.originCycles.x,
    frame.axisXCyclesPerM.x,
    frame.axisZCyclesPerM.x,
  );
  const qy = coordinate(
    frame.originCycles.y,
    frame.axisXCyclesPerM.y,
    frame.axisZCyclesPerM.y,
  );
  const qz = coordinate(
    frame.originCycles.z,
    frame.axisXCyclesPerM.z,
    frame.axisZCyclesPerM.z,
  );
  let value = f(0);
  for (const harmonic of CATS_PAW_HARMONICS) {
    const dot = f(
      f(f(qx) * f(harmonic.x)) +
        f(f(qy) * f(harmonic.y)) +
        f(f(qz) * f(harmonic.z)),
    );
    const phase = wrapUnit(f(dot + f(harmonic.phaseCycles)));
    value = f(
      value + f(f(harmonic.weight) * f(Math.sin(f(TAU) * f(phase)))),
    );
  }
  return value;
}

/** Local wind speed after the bounded signed spatial departure. */
export function catsPawLocalWindSpeedMps(
  meanWindSpeedMps: number,
  gustExcessMps: number,
  fieldValue: number,
): number {
  return Math.max(meanWindSpeedMps + gustExcessMps * fieldValue, 0);
}

const glslHarmonics = CATS_PAW_HARMONICS.map(
  (harmonic) =>
    `  value += ${harmonic.weight.toFixed(8)} * sin(CATS_PAW_TAU * fract(` +
    `dot(q, vec3(${harmonic.x.toFixed(1)}, ${harmonic.y.toFixed(1)}, ${harmonic.z.toFixed(1)})) + ` +
    `${harmonic.phaseCycles.toFixed(8)}));`,
).join('\n');

/** Shared GPU implementation injected verbatim into both ocean consumers. */
export const GLSL_CATS_PAW = /* glsl */ `
uniform float uCatsPawGustExcessMps;
uniform vec3  uCatsPawOriginCycles;
uniform vec3  uCatsPawAxisXCyclesPerM;
uniform vec3  uCatsPawAxisZCyclesPerM;

const float CATS_PAW_TAU = 6.283185307179586;

float catsPawField(vec2 localPosition) {
  vec3 q = fract(
    uCatsPawOriginCycles +
    uCatsPawAxisXCyclesPerM * localPosition.x +
    uCatsPawAxisZCyclesPerM * localPosition.y
  );
  float value = 0.0;
${glslHarmonics}
  return value;
}

float catsPawLocalWindSpeed(vec2 localPosition, float meanWindSpeedMps) {
  return max(
    meanWindSpeedMps + uCatsPawGustExcessMps * catsPawField(localPosition),
    0.0
  );
}
`;
