import * as THREE from 'three';
import { CloudDome } from './CloudDome';
import type { GpuPassProfiler } from '../render/GpuProfiler';
import {
  GLSL_CLOUD_CACHE_LOOKUP,
  GLSL_COMMON,
  GLSL_SKY,
} from './shaders/lib';
import {
  onColourPipelineChange,
  skyProjection,
  skySaturation,
} from './colourPipeline';
import type { Mat3d } from '../astronomy/AstronomyProvider';
import {
  GLSL_MILKY_WAY,
  MILKY_WAY_CHROMA,
  MILKY_WAY_GAIN,
  createMilkyWayTextures,
  renderToGalactic,
  visibilityFromLimitingMagnitude,
} from './MilkyWay';
import type { MilkyWayTextures } from './MilkyWay';
import { SH_COEFFICIENTS } from './skyHarmonics';
import { SkyRadianceLut } from './SkyRadianceLut';
import type { TimeOfDay } from './TimeOfDay';
import {
  MOON_DISC_EDGE_FEATHER_RAD,
  MOON_EARTHSHINE_FLOOR,
  MOON_PRESENTATION_RADIUS_RAD,
  MOON_REGOLITH_RESPONSE_EXPONENT,
  MOON_TERMINATOR_HALF_WIDTH,
} from './moonPresentation';

/**
 * A world-space sky dome.
 *
 * The sunset genuinely sits in the west and the night genuinely rises in the
 * east; nothing is projected into screen space, so orbiting the raft reveals
 * the contrast rather than dragging a painted backdrop along.
 *
 * The dome and the water share one `skyRadiance()` implementation and one
 * uniform block, so the sea can never reflect a sky that is not there.
 */

const DOME_RADIUS = 500;

const DEG = Math.PI / 180;

/**
 * Cloud seconds per WALL-CLOCK second, during normal play.
 *
 * One, and one is the whole point: clouds are weather now, not timelapse.
 * The sea set the precedent — weather runs at ordinary presentation/physics
 * rate however fast the astronomical clock spins. The cloud deck therefore
 * drifts at the speed the current weather actually implies, while only the
 * sun, moon and stars keep the accelerated astronomical time that makes a day
 * watchable. (The predecessor constant, CLOUD_TIME_RATE,
 * multiplied WORLD seconds by 0.2 — a 14.4x timelapse that Ash read exactly
 * as one: "they look a bit ridiculous".)
 *
 * There is deliberately no astronomical instant, rate or pause input here.
 * Freezing a lighting condition must not freeze weather, and dragging the Sun
 * across six hours must not teleport the cloud deck.
 */
const CLOUD_WALL_RATE = 1.0;

/**
 * Wind aloft, as a veer and a gain on the surface wind.
 *
 * Friction slows and turns the wind near the sea; above the boundary layer it
 * strengthens and turns back toward the geostrophic flow. The magnitudes are
 * the textbook maritime Ekman figures — about 20 degrees and 1.8x by cloud
 * base, more of both by the tropopause.
 *
 * The SENSE of the turn is hemispheric, which is why `veerSign` below reads the
 * observer's latitude rather than being folded into these constants. Clockwise
 * seen from above in the north, anticlockwise in the south — and the raft
 * starts at 35 degrees SOUTH, so hard-coding the northern sense would have been
 * wrong for the only place anyone has sailed.
 *
 * The deck therefore does not drift along the swell, which is what a sky drawn
 * without the veer looks like: wind and water moving as one thing.
 */
const CUMULUS_WIND_VEER_DEG = 22;
const CUMULUS_WIND_GAIN = 1.85;

/**
 * Which way the wind turns with height here, and how strongly, from latitude.
 *
 * It vanishes at the equator rather than flipping across it. That is not
 * smoothing for its own sake: the Ekman spiral is driven by the Coriolis
 * parameter, which goes to zero there, and the layer it describes has no
 * defined depth within a few degrees of the line. A ramp over five degrees is
 * about as much honesty as a one-scenario sky needs, and it keeps a teleport
 * across the equator from reversing the whole cloud field in one frame.
 */
function veerSign(latitudeRad: number): number {
  return Math.max(-1, Math.min(1, latitudeRad / (5 * DEG)));
}

/**
 * How fast each deck's field EVOLVES, as a fraction of how fast it is advected.
 *
 * Expressed as a ratio rather than an absolute rate because the same shear that
 * carries a cloud is what tears it apart: a stiff wind means a shorter-lived
 * cloud, not merely a faster one. 1/14 puts a fair-weather cumulus through
 * roughly one cell of the evolution axis every fourteen cells it travels —
 * about twenty-five minutes of cloud time, which is a real cumulus lifetime.
 */
const CUMULUS_EVOLVE_RATIO = 1 / 14;

/**
 * Modulus on the accumulated drift, metres.
 *
 * The noise is not periodic, so this is a discontinuity, not a wrap — the whole
 * sky changes in one frame when it fires. It exists only to bound float32
 * error: the shader adds this offset to a view-ray intercept of order 1e4 m and
 * then takes screen derivatives of the sum, and at 4e6 the quantum is 0.25 m
 * (0.0002 noise cells) against a per-pixel step near the zenith of about 0.005
 * cells, which is the margin that keeps fwidth meaningful.
 *
 * At the default time rate and a moderate wind it takes about seven hours of
 * continuous play to reach. The value it replaces was 20000 m, which fired
 * every seventy minutes.
 */
const DRIFT_WRAP_M = 4_000_000;

function wrapDrift(metres: number): number {
  return metres % DRIFT_WRAP_M;
}

/** Rotate a horizontal direction clockwise by `deg` as seen from above. */
function veer(dir: THREE.Vector2, deg: number, out: THREE.Vector2): void {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  out.set(dir.x * c - dir.y * s, dir.x * s + dir.y * c);
}

/**
 * The cloud clock, as the CPU mirror in `TimeOfDay` needs it: the deck's drift
 * and its evolution coordinate. The mirror lights the scene from these clouds,
 * so it has to be looking at the same ones.
 */
export interface CloudFieldState {
  offsetX: number;
  offsetZ: number;
  evolve: number;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_COMMON}
${GLSL_SKY}

varying vec3 vDir;

${GLSL_CLOUD_CACHE_LOOKUP}
${GLSL_MILKY_WAY}

uniform mat3 uRenderToGalactic;

/**
 * 1.0 when this draw ends at the 8-bit canvas, 0.0 when it ends in a
 * linear-HDR buffer that something else will present. See the dither at the
 * tail of this shader, and render/ScenePresentPass.ts for why it cannot simply
 * be left on: aimed offscreen, three compiles tone mapping and the sRGB encode
 * out of this shader, but a write placed AFTER colorspace_fragment survives and
 * lands on a raw radiance instead of on a display code.
 */
uniform float uQuantiseDither;

void main() {
  vec3 dir = normalize(vDir);

  // Sky and clouds composited by hand rather than through skyWithClouds(),
  // so the cloud alpha stays in scope: the luminous discs below must sit
  // BEHIND the layer. Drawn on top — as they were — the sun burned through
  // an overcast sky while the water's direct light was correctly occluded,
  // which is a sky the scene's own lighting contradicts. Per-pixel alpha
  // rather than the CPU's single transmittance, so the disc genuinely peers
  // through gaps and hides behind tufts as they drift.
  vec3 base = skyRadiance(dir);

  // The galaxy joins the sky BEFORE the cloud composite, which is the whole
  // reason it is here rather than in its own pass. Everything the deck does to
  // the sky it now does to the band: a cloud crossing the Sagittarius region
  // hides it, the moon's aureole washes it out, and the twilight gradient
  // swallows it from the bottom up — none of which needed a line of code,
  // because the band is simply part of base by the time the over happens.
  if (uMilkyWay > 0.0001) {
    base += milkyWayRadiance(uRenderToGalactic * dir, dir.y);
  }
#ifdef CLOUD_LIVE_MARCH
  // The reference path: the full per-pixel march, kept compilable for
  // A/B verification against the cache. setLiveMarch() flips this.
  vec4 cl = cloudLayer(dir, base);
#else
  // The cached deck, advected to THIS frame's drift and relit with THIS
  // frame's sun — see cloudBake / cloudLayerCached / cloudCumulusUv in
  // shaders/lib.ts and the scheduler in CloudDome.ts. ONE sparse-atlas
  // translation now serves both packs: with the high deck gone there is no
  // second wind to slide a second sample along.
  vec2 uvLow = cloudCumulusUv(dir);
  vec3 addressLow = cloudCacheAddress(uvLow);
  vec4 packA = vec4(0.0);
  vec2 packB = vec2(0.0);
  if (addressLow.z > 0.5) {
    packA = texture2D(uCloudPackA, addressLow.xy);
    packB = texture2D(uCloudPackB, addressLow.xy).xy;
  }
  vec4 cl = cloudLayerCached(dir, base, packA, packB);
#endif
  // Premultiplied radiance either way, so this is an over, not a mix.
  vec3 color = base * (1.0 - cl.a) + cl.rgb;
  float clearView = 1.0 - cl.a;

  // --- sun --------------------------------------------------------------
  float muSun = dot(dir, uSunDir);
  vec3 sunRadiance = uSunTint * lightTransmittance(uSunDir) * uSunPower;
  float sunDisc = smoothstep(cos(0.0092), cos(0.0050), muSun);
  color += sunRadiance * sunDisc * 2.4 * clearView;
  // Tight core plus a modest forward-scatter aureole. Cheaper and far more
  // restrained than a bloom pass, and it cannot smear the horizon line.
  // The skirt sits INSIDE the Mie glow (g=0.94, ~6 degrees), not around it:
  // a pow-30 skirt held a 12-degree white plateau against the deepened sky,
  // which read as a haze ring around the afternoon sun.
  color += sunRadiance * (pow(max(muSun, 0.0), 360.0) * 0.45 + pow(max(muSun, 0.0), 110.0) * 0.008) * clearView;

  // --- moon -------------------------------------------------------------
  float muMoon = dot(dir, uMoonDir);
  float moonVis = smoothstep(-0.02, 0.05, uMoonDir.y) * uNight;
  if (moonVis > 0.002) {
    // Deliberately larger than life size: the physical disc was six or seven
    // pixels across in an embodied view, which read as a white shader fleck.
    // Only this silhouette is enlarged; light, fill, glitter and phase retain
    // their shared physical authority.
    float moonDisc = smoothstep(
      cos(${(MOON_PRESENTATION_RADIUS_RAD + MOON_DISC_EDGE_FEATHER_RAD).toFixed(6)}),
      cos(${(MOON_PRESENTATION_RADIUS_RAD - MOON_DISC_EDGE_FEATHER_RAD).toFixed(6)}),
      muMoon
    );
    if (moonDisc > 0.0) {
      vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
      vec3 t2 = cross(uMoonDir, t1);
      vec2 uv = vec2(dot(dir, t1), dot(dir, t2)) / ${MOON_PRESENTATION_RADIUS_RAD.toFixed(6)};
      float rr = clamp(length(uv), 0.0, 1.0);
      float limb = 0.74 + 0.26 * sqrt(max(1.0 - rr * rr, 0.0));
      float mare = 0.84 + 0.16 * vnoise(uv * 2.1 + 4.0);
      // Phase from the real geometry: the lit hemisphere faces the sun, and
      // the terminator falls out of the billboard sphere normal. The sun is
      // 400x further away than the moon, so its direction seen from the moon
      // is the same uSunDir the rest of the sky uses.
      vec3 sphereN = normalize(uv.x * t1 + uv.y * t2 - sqrt(max(1.0 - rr * rr, 0.0)) * uMoonDir);
      float nDotL = dot(sphereN, uSunDir);
      float direct = pow(max(nDotL, 0.0), ${MOON_REGOLITH_RESPONSE_EXPONENT.toFixed(2)});
      float terminator = smoothstep(
        -${MOON_TERMINATOR_HALF_WIDTH.toFixed(2)},
        ${MOON_TERMINATOR_HALF_WIDTH.toFixed(2)},
        nDotL
      );
      // Earthshine keeps the dark limb barely present instead of amputated.
      // Continuous rough-sphere lighting replaces the former softened binary
      // phase mask: the bright hemisphere now rolls through real gradients to
      // the terminator instead of looking cut out by a geometric stencil.
      float phaseMask = ${MOON_EARTHSHINE_FLOOR.toFixed(3)} + ${(1 - MOON_EARTHSHINE_FLOOR).toFixed(3)} * direct * terminator;
      color += vec3(0.95, 0.95, 0.92) * moonDisc * limb * mare * phaseMask * 2.3 * moonVis * clearView;
    }
    // Clear-sky aureole only: tight core glow plus a small forward-scatter
    // skirt, both scaled by the disc's actual phase brightness. The old wide
    // pow-14 halo washed a quarter of the sky on every clear full moon; a
    // future weather system is what should enlarge this, not the default.
    color += uMoonTint * pow(max(muMoon, 0.0), 1400.0) * 0.45 * uMoonHalo * moonVis * clearView;
    color += uMoonTint * pow(max(muMoon, 0.0), 90.0) * 0.020 * uMoonHalo * moonVis * clearView;
  }

  gl_FragColor = vec4(color, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // One-LSB screen-space dither at the single point of quantisation. The
  // deep-blue palette lives where adjacent 8-bit codes are visibly far
  // apart; without this the smooth water and sky gradients posterise into
  // flat steps, and any sub-pixel shading noise flickers between exactly two
  // codes at each step's boundary — the "8-bit palette" static. A static
  // hash, not a temporal one: the cure for banding must not shimmer.
  gl_FragColor.rgb += (hash21(gl_FragCoord.xy) - 0.5) * (uQuantiseDither / 255.0);
}
`;

export class SkySystem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /** Shared with the ocean material so both read one sky definition. */
  readonly uniforms: Record<string, THREE.IUniform>;
  /**
   * Compile-time sky configuration, shared with every consumer of `uniforms`.
   *
   * A shader that spreads the uniform block but compiles against different
   * defines is reading the same state through a different atmosphere — which is
   * precisely the kind of near-agreement that is harder to find than a plain
   * disagreement. `WorldRadianceSource` takes both together.
   */
  readonly defines: Record<string, number | string>;
  /** Public for the lab: the bake scheduler is the thing worth watching. */
  readonly cloudDome: CloudDome;
  /** Gas-sky cache consumed by the ocean reflection and haze paths. */
  readonly radianceLut: SkyRadianceLut;
  readonly milkyWay: MilkyWayTextures;

  private gpuProfiler: GpuPassProfiler | undefined;
  private readonly cloudOffset = new THREE.Vector2();
  /** A/B scaffolding; goes with scene/colourPipeline.ts. */
  private readonly unsubscribeColourPipeline: () => void;
  /** Cloud/weather state, integrated from bounded presentation seconds. */
  private cloudEvolve = 0;
  private readonly scratchWind = new THREE.Vector2();
  /**
   * The same numbers, in the shape the CPU mirror wants. One object, mutated
   * in place: this is read every frame from the presentation-lighting path,
   * which does not allocate.
   */
  readonly cloudField: CloudFieldState = {
    offsetX: 0,
    offsetZ: 0,
    evolve: 0,
  };
  /**
   * The authored opacity, so the diagnostic kill-switch can restore it.
   *
   * One, now that the march produces honest opacity from the field itself.
   * The old 0.85 was a global dimmer on a layer that could never reach
   * optical thickness; against thick cores it is a flat 15 % of blue sky
   * shining through the middle of every cumulus, which reads as a wash and
   * — measurably — keeps a heavy overcast bluer than a broken sky.
   */
  private readonly cloudOpacity = 1.0;
  /**
   * Cloud seconds per wall-clock second, live.
   *
   * A field rather than the constant directly, because CLOUD_WALL_RATE is a
   * judgement about how fast a sky should look and that is a thing to sit and
   * watch rather than to reason about — the graphics panel drives this, and it
   * cannot jump the field when it moves, because the clock integrates.
   */
  timeRate = CLOUD_WALL_RATE;

  constructor(
    cloudOctaves: number,
    cloudMarch: number,
    cloudShapeOctaves = 5,
    cloudSunSteps = 5,
    /**
     * Cache size, angular texels. The defaults put ~17 texels per degree of
     * azimuth and — through the elevation warp — ~26 near the horizon, about
     * three quarters of what a 2560-wide screen resolves. The logical map is
     * sparse: cloudSlotCapacity fixes the compact physical atlas rather than
     * allocating every logical texel. The desktop default commits 122.8 MiB
     * across both packs and generations, versus 240.0 MiB for two full maps.
     */
    domeWidth = 6144,
    domeHeight = 1280,
    cloudSlotCapacity = 120,
  ) {
    this.uniforms = {
      // 1.0 while this dome owns the frame's quantisation; cleared by any
      // presenter that renders it into a linear-HDR buffer of its own.
      uQuantiseDither: { value: 1 },
      // A/B scaffolding: the sky's spectral projection and the pre-round
      // chroma trim, live-switchable from the graphics panel. Constants of the
      // world in every other sense — see scene/colourPipeline.ts.
      uSkyProj: { value: new THREE.Vector3(...skyProjection()) },
      // The sky's order-2 harmonic projection, RGB interleaved per
      // coefficient. Published by TimeOfDay each frame; consumed by the ocean's
      // rough reflection. See scene/skyHarmonics.ts.
      uSkySh: { value: new Float32Array(SH_COEFFICIENTS * 3) },
      uSkySaturation: { value: skySaturation() },
      // Live daylight/sunset sky-radiance trim; 1 is the model unmodified.
      // 0.6 ships: it gives the sky headroom below display white so the
      // daylight exposure lift can raise sunlit surfaces without bleaching
      // it. GLSL_SKY phases this trim back to 1 through uNight, because the
      // headroom bargain does not apply once the daylight lift is absent.
      // Paired with DEFAULT_DAYLIGHT_EXPOSURE_LIFT — see its note.
      uSkyGainTrim: { value: 0.6 },
      uSunDir: { value: new THREE.Vector3(0, 0.1, -1) },
      uMoonDir: { value: new THREE.Vector3(0, -0.1, 1) },
      uSunTint: { value: new THREE.Vector3(1.0, 0.985, 0.955) },
      uMoonTint: { value: new THREE.Vector3(0.72, 0.80, 1.0) },
      uSunPower: { value: 21 },
      uMoonPower: { value: 0 },
      uMoonHalo: { value: 0 },
      uNight: { value: 0 },
      // The peak the band would reach in a perfectly dark sky, and what this
      // frame's sky actually earns of it. Split so the panel can walk the
      // former while the night model keeps deciding the latter.
      uMilkyWayGain: { value: MILKY_WAY_GAIN },
      uMilkyWay: { value: 0 },
      uMilkyWayChroma01: { value: MILKY_WAY_CHROMA },
      uRenderToGalactic: { value: new THREE.Matrix3() },
      uTime: { value: 0 },
      // Threshold on the weather field, so HIGHER means LESS cloud. 0.70 puts
      // about 14% of the sky under cumulus.
      //
      // 0.62 — about 41% — was costing the sea most of its colour. Nothing was
      // wrong with the clouds (their mean radiance measures at 0.74x the
      // Lambertian ceiling for their albedo, and the only part that exceeds it
      // is forward scatter inside 45 degrees of the sun), and nothing was wrong
      // with reflecting them: a sea that covers 41% of its own sky in white
      // cloud reflects white cloud, and the water's saturation fell from 0.685
      // to 0.588 near, 0.616 to 0.499 mid, 0.534 to 0.416 far. It was simply a
      // cloudier day than this world wants as its baseline. Almost all of the
      // colour comes back between 41% and 14%; clearing the last few percent
      // buys nearly nothing and costs the sky everything worth looking at.
      uCloudCover: { value: 0.70 },
      uCloudOpacity: { value: this.cloudOpacity },
      uCloudOffset: { value: this.cloudOffset },
      uCloudEvolve: { value: 0 },
      // Published atomically with each synchronized front/staging swap.
      uCloudDriftBase: { value: new THREE.Vector2() },
    };

    const defines = {
      CLOUD_OCTAVES: cloudOctaves + 1,
      CLOUD_MARCH: cloudMarch,
      CLOUD_SHAPE_OCTAVES: cloudShapeOctaves,
      CLOUD_SUN_STEPS: cloudSunSteps,
    };
    this.defines = defines;

    // The cache bakes with the dome's own defines and a snapshot of the
    // dome's own uniforms — one cloud definition, one evaluation site. Its
    // pack textures join the shared uniform block before the material is
    // built, so a future consumer (the ocean's haze, a reflection probe)
    // can reach the same sky by spreading the same block.
    this.cloudDome = new CloudDome(
      this.uniforms,
      defines,
      domeWidth,
      domeHeight,
      cloudSlotCapacity,
    );
    this.uniforms.uCloudPackA = { value: this.cloudDome.textureA };
    this.uniforms.uCloudPackB = { value: this.cloudDome.textureB };
    this.milkyWay = createMilkyWayTextures();
    this.uniforms.uMilkyWayLum = { value: this.milkyWay.luminance };
    this.uniforms.uMilkyWayChroma = { value: this.milkyWay.chroma };
    this.unsubscribeColourPipeline = onColourPipelineChange(() => {
      this.publishColourPipeline();
    });

    this.radianceLut = new SkyRadianceLut(this.uniforms, defines);
    this.uniforms.uSkyRadianceLut = { value: this.radianceLut.texture };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      defines,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;

    // The dome about to draw is the one moment that knows both the renderer
    // and the actual camera, whichever loop is driving — the main frame, the
    // buoyancy lab, or a parity probe.
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      this.gpuProfiler?.beginPass('cloudCacheBake');
      this.cloudDome.update(renderer, camera);
      this.gpuProfiler?.endPass('cloudCacheBake');
      this.gpuProfiler?.beginPass('skyAndCloudDraw');
      // Count the small shared atmosphere bake beside the sky draw rather than
      // hiding it in "other". In the analytic A/B mode update() is a no-op.
      this.radianceLut.update(renderer);
    };
    this.mesh.onAfterRender = () =>
      this.gpuProfiler?.endPass('skyAndCloudDraw');
  }

  setGpuProfiler(profiler: GpuPassProfiler | undefined): void {
    this.gpuProfiler = profiler;
  }

  setRadianceLutEnabled(enabled: boolean): void {
    this.radianceLut.setEnabled(enabled);
  }

  /**
   * Commit a discontinuous clock edit into the visible cloud cache.
   *
   * Live cache advection deliberately has a finite displacement limit; beyond
   * it, reprojecting an old cloud field would stretch the horizon into a smear.
   * A slider release therefore asks the cache to bake the current guard region
   * coherently on the next render, after this frame's cloud clock has advanced.
   */
  requestCloudCacheRebase(): void {
    this.cloudDome.requestDisplayRebase();
  }

  /**
   * Return the sky to the state a freshly loaded page has: clouds at the start
   * of their drift, cache empty, nothing held.
   *
   * TWO KINDS OF STATE, AND THE SECOND ONE HID BEHIND THE FIRST
   * ------------------------------------------------------------
   * The cloud CACHE is amortized, so it carries a position in its own work
   * queue — see `CloudDome.reset`, which is the largest single term in
   * re-stage non-determinism.
   *
   * The cloud CLOCK is the quieter one and it took a live probe to find. The
   * deck's drift and evolution are integrated frame by frame in
   * `advanceCloudPresentation`, from presentation seconds, with no reference
   * to the astronomical clock — so pausing the world does not stop the clouds,
   * and two stagings of one scene looked at cloud fields at different phases.
   * That is a different sky: measured on a live page it moved the ambient fill
   * by 9% and the auto-exposure by 0.7%, which is an order of magnitude more
   * than the exposure meter's own creep. `tools/ab-sheet.mjs` named "advection
   * phase" in passing years before anyone chased it.
   *
   * The radiance LUT is a pure function of the live uniforms and holds nothing.
   */
  reset(): void {
    this.cloudOffset.set(0, 0);
    this.cloudEvolve = 0;
    this.uniforms.uCloudEvolve.value = 0;
    this.cloudField.offsetX = 0;
    this.cloudField.offsetZ = 0;
    this.cloudField.evolve = 0;
    this.cloudDome.reset();
  }

  /**
   * Re-publish the A/B colour constants into the shared sky uniforms.
   *
   * One object reaches the dome, the cloud cache, the radiance LUT and the
   * water surface, because they are all handed this same uniform record by
   * reference — so a switch is one write, not four.
   */
  publishColourPipeline(): void {
    (this.uniforms.uSkyProj.value as THREE.Vector3).set(...skyProjection());
    this.uniforms.uSkySaturation.value = skySaturation();
  }

  /**
   * Teleport the cloud deck to a chosen point in its own field.
   *
   * Diagnostic only, and the reason it exists is that "the sun is behind a
   * cloud" is not a setting — it is wherever the deck happens to be. Judging a
   * lighting change needs the ability to put the sun in clear air on purpose,
   * so the picture being compared is the picture that was asked for.
   */
  jumpCloudField(offsetX: number, offsetZ: number): void {
    this.cloudOffset.set(offsetX, offsetZ);
    this.cloudField.offsetX = offsetX;
    this.cloudField.offsetZ = offsetZ;
    this.requestCloudCacheRebase();
  }

  /**
   * A/B switch for verification: recompile the dome onto the reference
   * per-pixel march (true) or the cache composite (false). Costs a shader
   * compile; diagnostic only.
   */
  setLiveMarch(enabled: boolean): void {
    const has = 'CLOUD_LIVE_MARCH' in this.material.defines;
    if (enabled === has) return;
    if (enabled) this.material.defines.CLOUD_LIVE_MARCH = '';
    else delete this.material.defines.CLOUD_LIVE_MARCH;
    this.material.needsUpdate = true;
  }

  /**
   * Advance cloud/weather state by ordinary bounded presentation time.
   *
   * The caller updates this before deriving ambient light, so the dome, ocean
   * reflection and CPU lighting mirror all consume this frame's same clouds.
   * Astronomical time has no route into this method.
   */
  advanceCloudPresentation(
    presentationDeltaSeconds: number,
    surfaceWindDir: THREE.Vector2,
    surfaceWindSpeedMps: number,
    latitudeRad: number,
  ): void {
    if (
      !Number.isFinite(presentationDeltaSeconds) ||
      presentationDeltaSeconds < 0
    ) {
      throw new RangeError(
        `presentationDeltaSeconds must be finite and non-negative, got ${presentationDeltaSeconds}`,
      );
    }
    const cloudSeconds = presentationDeltaSeconds * this.timeRate;
    if (cloudSeconds === 0) return;

    // Veering is a rotation of the horizontal wind vector. Render axes put +x
    // east and -z north, which makes the compass sense of a clockwise turn the
    // ordinary positive rotation of (x, z); the sign is hemispheric.
    const turn = veerSign(latitudeRad);
    veer(surfaceWindDir, CUMULUS_WIND_VEER_DEG * turn, this.scratchWind);
    const cumulusSpeed = surfaceWindSpeedMps * CUMULUS_WIND_GAIN;
    this.cloudOffset.set(
      wrapDrift(this.cloudOffset.x + this.scratchWind.x * cumulusSpeed * cloudSeconds),
      wrapDrift(this.cloudOffset.y + this.scratchWind.y * cumulusSpeed * cloudSeconds),
    );

    this.cloudEvolve = wrapDrift(
      this.cloudEvolve + cumulusSpeed * CUMULUS_EVOLVE_RATIO * cloudSeconds,
    );

    this.uniforms.uCloudEvolve.value = this.cloudEvolve;

    const f = this.cloudField;
    f.offsetX = this.cloudOffset.x;
    f.offsetZ = this.cloudOffset.y;
    f.evolve = this.cloudEvolve;
  }

  update(
    time: TimeOfDay,
    elapsed: number,
    cameraPosition: THREE.Vector3,
  ): void {
    this.mesh.position.copy(cameraPosition);

    const u = this.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(time.sunDirection);
    (u.uMoonDir.value as THREE.Vector3).copy(time.moonDirection);
    (u.uSunTint.value as THREE.Vector3).set(time.sunTint.r, time.sunTint.g, time.sunTint.b);
    (u.uMoonTint.value as THREE.Vector3).set(time.moonTint.r, time.moonTint.g, time.moonTint.b);
    u.uSunPower.value = time.sunPower;
    u.uMoonPower.value = time.moonPower;
    u.uMoonHalo.value = time.moonPhaseBright;
    u.uNight.value = time.nightFactor;
    u.uMilkyWay.value =
      (u.uMilkyWayGain.value as number) *
      visibilityFromLimitingMagnitude(time.limitingMagnitude);
    u.uTime.value = elapsed % 3600;
  }

  /**
   * Publish this frame's celestial orientation for the galaxy.
   *
   * Separate from `update()` because it comes from a different authority —
   * `WorldRenderAdapter`, the same matrix `StarField` orients its points with
   * — and taking it as one more argument to a lighting update would blur which
   * of the two owns the sky's rotation. They must agree exactly: a band that
   * precesses independently of the stars standing in it is worse than no band.
   */
  setCelestialOrientation(celestialToRender: Mat3d): void {
    renderToGalactic(
      celestialToRender,
      this.uniforms.uRenderToGalactic.value as THREE.Matrix3,
    );
  }

  /**
   * Diagnostic kill-switch. Zeroing the opacity takes the cloud layer out of
   * everything in one move — the dome, the water's reflection and the haze all
   * reach clouds through cloudLayer(), which early-outs on it. The uniform
   * block is shared with the ocean, so sky and sea cannot disagree.
   */
  setCloudsEnabled(enabled: boolean): void {
    this.uniforms.uCloudOpacity.value = enabled ? this.cloudOpacity : 0;
  }

  /**
   * Whether this draw ends at the 8-bit canvas and therefore owns the frame's
   * quantisation. The sky and the sea each carry their own 1-LSB dither and
   * each must be told; a presenter that cleared only one would dither half the
   * picture twice and half of it into a linear radiance.
   */
  setQuantisationDither(enabled: boolean): void {
    this.uniforms.uQuantiseDither.value = enabled ? 1 : 0;
  }

  dispose(): void {
    this.unsubscribeColourPipeline();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.cloudDome.dispose();
    this.radianceLut.dispose();
    this.milkyWay.luminance.dispose();
    this.milkyWay.chroma.dispose();
  }
}
