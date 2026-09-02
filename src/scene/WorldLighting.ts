import * as THREE from 'three';
import {
  SH_FLOAT_COUNT,
  equirectCosineIrradiance,
  projectEquirectToSh,
  shIrradiance,
} from './sphericalHarmonics';
import {
  WORLD_SOURCE_HEIGHT,
  WORLD_SOURCE_WIDTH,
  WorldRadianceSource,
} from './WorldRadianceSource';
import type { WorldRadianceInputs } from './WorldRadianceSource';

/**
 * The world's light, published once per generation.
 *
 * One source map (`WorldRadianceSource`), two convolutions of it: an L2
 * spherical-harmonics probe for diffuse and a PMREM chain for specular. They
 * are published together or not at all — see `publish` below — because the
 * failure this replaces was precisely two indirect terms drifting apart until
 * each needed its own multiplier to look right.
 *
 * There is no environment intensity here, and no world lighting gain. The only
 * unit conversion anywhere in this path is the named sun constant in
 * `TimeOfDay`. If some surface needs an exception, the system is wrong.
 */

/** Cadence guard for the readback: never more than one in flight. */
interface PendingGeneration {
  generation: number;
  pmrem: THREE.WebGLRenderTarget;
}

export class WorldLighting {
  readonly source: WorldRadianceSource;

  /**
   * 9 RGB coefficients, band-major, in three's basis.
   *
   * True irradiance when evaluated through `shIrradiance` or three's
   * `shGetIrradianceAt`: a uniform source of radiance L gives exactly pi*L.
   */
  readonly shCoefficients = new Float32Array(SH_FLOAT_COUNT);

  /** The PMREM currently safe to sample. Null until the first swap lands. */
  environment: THREE.Texture | null = null;

  /** Generation of the published pair. Zero until the first swap. */
  publishedGeneration = 0;

  private readonly pmremGenerator: THREE.PMREMGenerator;
  /**
   * Two PMREM targets, alternated.
   *
   * A new generation must never mutate the texture the current frame is
   * sampling. PMREM generation is not instantaneous from the driver's point of
   * view, and overwriting in place produced exactly the kind of one-frame
   * flash that gets misdiagnosed as a lighting bug for a week.
   */
  private readonly pmremTargets: (THREE.WebGLRenderTarget | null)[] = [null, null];
  private pmremSlot = 0;

  private pending: PendingGeneration | null = null;
  private readonly readBuffer = new Uint16Array(WORLD_SOURCE_WIDTH * WORLD_SOURCE_HEIGHT * 4);
  private readonly floatBuffer = new Float32Array(WORLD_SOURCE_WIDTH * WORLD_SOURCE_HEIGHT * 4);
  private readonly stagingSh = new Float32Array(SH_FLOAT_COUNT);
  /**
   * Whether the driver accepted an async readback of a half-float target.
   *
   * `readRenderTargetPixelsAsync` throws for formats it considers
   * non-readable, and what counts as readable is implementation-defined. So we
   * try it, and on the first refusal fall back to the synchronous path for the
   * rest of the session rather than throwing once a second forever.
   */
  private asyncReadback = true;
  private readInFlight = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    skyUniforms: Record<string, THREE.IUniform>,
    skyDefines: Record<string, number | string>,
  ) {
    this.source = new WorldRadianceSource(skyUniforms, skyDefines);
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    this.pmremGenerator.compileEquirectangularShader();
  }

  /**
   * Advance the world's light.
   *
   * Cheap on the frames it does nothing, which is nearly all of them: the
   * source refreshes at most once a second and everything downstream is gated
   * on it having actually refreshed.
   */
  update(
    renderer: THREE.WebGLRenderer,
    elapsedSeconds: number,
    inputs: WorldRadianceInputs,
    force = false,
  ): void {
    if (!this.source.update(renderer, elapsedSeconds, inputs, force)) return;

    // Specular first and synchronously, then hold it back until the diffuse
    // half of the same generation is ready.
    const slot = this.pmremSlot;
    const existing = this.pmremTargets[slot];
    const produced = this.pmremGenerator.fromEquirectangular(
      this.source.texture,
      existing ?? undefined,
    );
    this.pmremTargets[slot] = produced;
    this.pmremSlot = 1 - slot;

    this.pending = { generation: this.source.generation, pmrem: produced };
    this.beginReadback(renderer);
  }

  /**
   * Rebuild and publish the world's light immediately, synchronously.
   *
   * For capture harnesses, and they genuinely need it. The contact sheet drives
   * `stepSimulation` and `renderFrame` directly in one unbroken synchronous
   * task — deliberately, because a hidden tab throttles `requestAnimationFrame`
   * to about 1 Hz and a sheet that depends on someone watching it is not a
   * measurement. But a synchronous task never yields to the microtask queue, so
   * an async readback issued inside it cannot resolve until the whole sheet is
   * finished. Every shot would then be lit by whatever generation happened to
   * be published before the capture started: ten frames at ten different sun
   * elevations, all wearing the same light, and each one individually
   * plausible.
   *
   * So this path takes the GPU stall on purpose. It is off the frame loop
   * entirely, and it makes the sheet deterministic by construction, which is
   * the property the harness is built around.
   */
  refreshNow(
    renderer: THREE.WebGLRenderer,
    elapsedSeconds: number,
    inputs: WorldRadianceInputs,
  ): void {
    this.source.update(renderer, elapsedSeconds, inputs, true);

    const slot = this.pmremSlot;
    const produced = this.pmremGenerator.fromEquirectangular(
      this.source.texture,
      this.pmremTargets[slot] ?? undefined,
    );
    this.pmremTargets[slot] = produced;
    this.pmremSlot = 1 - slot;
    this.pending = { generation: this.source.generation, pmrem: produced };

    this.readSourceSync(renderer);
    this.publish();
  }

  /**
   * Blocking readback of the source map.
   *
   * The `bindBuffer(PIXEL_PACK_BUFFER, null)` is not defensive tidying — it is
   * the fix for a real and completely silent collision.
   *
   * Three's `readRenderTargetPixelsAsync` binds a PIXEL_PACK_BUFFER, issues its
   * `readPixels` into it, and then awaits a fence WITHOUT unbinding. While that
   * await is pending, the pack buffer stays bound to the context, and WebGL2
   * routes any subsequent synchronous `readPixels(..., ArrayBufferView)` into
   * the bound pack buffer instead of the array. No error, no warning: the array
   * is simply left as it was, which for a freshly allocated buffer means zeros.
   *
   * The capture harness hits this every time. Its settle loop runs the normal
   * frame path, which starts an async read; that read can never resolve inside
   * a synchronous task; and the forced refresh that follows then reads a map
   * full of zeros and publishes a black probe. The visible result is a contact
   * sheet lit entirely by direct sun, which looks like a lighting decision
   * rather than a plumbing failure.
   *
   * Unbinding here is safe for the pending read: three re-binds its own buffer
   * after the await, before `getBufferSubData`.
   */
  private readSourceSync(renderer: THREE.WebGLRenderer): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.bindBuffer === 'function' && 'PIXEL_PACK_BUFFER' in gl) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    renderer.readRenderTargetPixels(
      this.source.target,
      0,
      0,
      WORLD_SOURCE_WIDTH,
      WORLD_SOURCE_HEIGHT,
      this.readBuffer,
    );
  }

  /**
   * Irradiance the world puts on a surface with this normal.
   *
   * The measurement instrument for the sun calibration: the design asks for the
   * noon ratio of direct sun to sky irradiance to be measured off the live
   * probe rather than guessed, and this is the sky half of that ratio.
   */
  skyIrradiance(
    normal: THREE.Vector3,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    return shIrradiance(this.shCoefficients, normal.x, normal.y, normal.z, out);
  }

  /**
   * Irradiance in a direction, integrated from the SOURCE PIXELS rather than
   * reconstructed from the SH — the portal channels' path, and the exact
   * integral the SH projection approximates. On the real sky the two agree
   * within ~2% (measured, §17.6 — the measurement that acquitted the SH of
   * the dusk-cabin complaint); the direct form is kept because it stays
   * exact in spiky regimes the L2 basis misstates.
   *
   * Returns false until the first readback has published, so the caller can
   * fall back to the SH rather than light the rooms with zeros during the
   * first second of a session.
   *
   * The cache is load-bearing for cost, not correctness: the full integral is
   * 8k texels, the callers ask for ~3 ship-attitude directions every frame,
   * and the map itself refreshes at most once a second. A direction within
   * ~0.1° of a cached one reuses the entry — the heel changes the answer far
   * more slowly than it changes the bit pattern of the normal.
   */
  sourceIrradiance(direction: THREE.Vector3, out: THREE.Vector3): boolean {
    if (this.publishedGeneration === 0) return false;
    const cache = this.irradianceCache;
    for (const entry of cache) {
      if (
        entry.generation === this.publishedGeneration &&
        entry.x * direction.x + entry.y * direction.y + entry.z * direction.z >
          IRRADIANCE_CACHE_COS
      ) {
        out.set(entry.r, entry.g, entry.b);
        return true;
      }
    }
    equirectCosineIrradiance(
      this.floatBuffer,
      WORLD_SOURCE_WIDTH,
      WORLD_SOURCE_HEIGHT,
      direction.x,
      direction.y,
      direction.z,
      this.irradianceScratch,
    );
    const slot = cache[this.irradianceCacheSlot];
    this.irradianceCacheSlot = (this.irradianceCacheSlot + 1) % cache.length;
    slot.generation = this.publishedGeneration;
    slot.x = direction.x;
    slot.y = direction.y;
    slot.z = direction.z;
    slot.r = this.irradianceScratch[0];
    slot.g = this.irradianceScratch[1];
    slot.b = this.irradianceScratch[2];
    out.set(slot.r, slot.g, slot.b);
    return true;
  }

  private readonly irradianceCache = Array.from({ length: 8 }, () => ({
    generation: 0,
    x: 0,
    y: 0,
    z: 0,
    r: 0,
    g: 0,
    b: 0,
  }));
  private irradianceCacheSlot = 0;
  private readonly irradianceScratch: [number, number, number] = [0, 0, 0];

  /** Scalar luminance of the sky's irradiance on an upward-facing surface. */
  skyIrradianceLuminance(): number {
    const e = this.skyIrradiance(UP);
    return 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
  }

  private beginReadback(renderer: THREE.WebGLRenderer): void {
    if (this.readInFlight) return;

    if (!this.asyncReadback) {
      this.readSourceSync(renderer);
      this.publish();
      return;
    }

    this.readInFlight = true;
    renderer
      .readRenderTargetPixelsAsync(
        this.source.target,
        0,
        0,
        WORLD_SOURCE_WIDTH,
        WORLD_SOURCE_HEIGHT,
        this.readBuffer,
      )
      .then(() => {
        this.readInFlight = false;
        this.publish();
      })
      .catch(() => {
        // Driver will not read this target asynchronously. Take the stall.
        this.asyncReadback = false;
        this.readInFlight = false;
      });
  }

  /**
   * Swap SH and PMREM together.
   *
   * The atomicity is the point. Half a generation — new sky in the reflection,
   * last second's sky in the fill — is a state no real sky has ever been in,
   * and it is unbounded in how wrong it can look during a fast time-of-day
   * scrub.
   */
  private publish(): void {
    const pending = this.pending;
    if (!pending) return;

    for (let i = 0; i < this.floatBuffer.length; i++) {
      this.floatBuffer[i] = THREE.DataUtils.fromHalfFloat(this.readBuffer[i]);
    }

    projectEquirectToSh(
      this.floatBuffer,
      WORLD_SOURCE_WIDTH,
      WORLD_SOURCE_HEIGHT,
      this.stagingSh,
    );

    this.shCoefficients.set(this.stagingSh);
    this.environment = pending.pmrem.texture;
    this.publishedGeneration = pending.generation;
    this.pending = null;
  }

  dispose(): void {
    this.source.dispose();
    this.pmremGenerator.dispose();
    for (const target of this.pmremTargets) target?.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** cos of ~0.1°: directions closer than this share a cache entry. */
const IRRADIANCE_CACHE_COS = 0.999998;
