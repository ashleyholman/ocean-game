import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SKY } from './shaders/lib';
import type { OceanOpticsProfile } from './oceanOptics';
import { waterBodyReflectance } from './oceanOptics';

/**
 * The world's light, as one camera-independent map.
 *
 * WHAT THIS IS
 * ------------
 * A 128x64 HDR equirect holding the radiance arriving at the ship from every
 * direction: the gas sky and its cloud shadowing above, the sea below. It is
 * the single source that both the diffuse probe and the specular PMREM are
 * convolutions of — which is the whole point. Diffuse fill and glossy
 * reflection stop being two numbers someone tuned against each other and become
 * two views of one thing.
 *
 * CAMERA-INDEPENDENT, AND WHY THAT IS A HARD RULE
 * -----------------------------------------------
 * Nothing here reads the camera. The prototype this design came from sampled
 * the sparse cloud cache, whose resident pages are chosen by where the camera
 * is looking — so turning your head changed the light on the hull. The visible
 * sky may be view-driven; global light may not. That is why the cloud gate
 * below is a coarse CPU march over a fixed directional grid rather than a
 * lookup into anything the renderer keeps for the current view.
 *
 * THE SUN IS NOT IN HERE
 * ----------------------
 * `skyRadiance()` is the gas atmosphere only: `SkyRadianceLut` documents that
 * the sun and moon discs are deliberately not part of it, and this map inherits
 * that. It is load-bearing in both directions.
 *
 *   - Out: the sun is a `DirectionalLight`. If the disc were also in this map,
 *     every lit surface would get its direct light twice — once sharp from the
 *     light and once smeared from the PMREM — and the hull's sun glint, the
 *     single strongest readability cue a dark glossy topside has, would be a
 *     doubled smudge instead of a highlight.
 *   - In: the circumsolar aureole IS here, because that is sky radiance, not
 *     sun radiance. Its brightness is exactly what made three's roughness-1
 *     "irradiance" flash the hull pale when a plank normal swung toward the
 *     sun's azimuth; convolved against an honest cosine lobe instead, it is
 *     just the bright part of a bright sky.
 *
 * Anything that later adds a disc to this map must remove it from the light
 * that draws it, in the same commit.
 *
 * NO NEW EXPENSIVE WORK
 * ---------------------
 * Texture reads and closed-form maths. No cloud marching in the shader, no
 * `evaluateWaves`, no cube-camera scene capture. The sea below is the ocean's
 * own body-and-Fresnel model evaluated against a flat surface, which is what
 * "the sea, blurred" actually looks like from twenty metres up.
 */

/** Directional resolution of the source. Blurred hard by both consumers. */
export const WORLD_SOURCE_WIDTH = 128;
export const WORLD_SOURCE_HEIGHT = 64;

/**
 * Resolution of the cloud shadowing grid.
 *
 * Much coarser than the map it modulates, on purpose. This is the low-frequency
 * cloud light — is it overcast, is there a bright gap to the south-west — and
 * not cloud silhouettes, which remain a visible-sky feature. 32x16 over the
 * upper hemisphere is 256 CPU cloud marches per refresh, at most once a second;
 * the existing per-frame hemisphere mean in `TimeOfDay` already does comparable
 * work sixty times a second.
 */
export const CLOUD_GATE_WIDTH = 32;
export const CLOUD_GATE_HEIGHT = 16;

/** Minimum wall-clock gap between refreshes, seconds. */
const REFRESH_INTERVAL = 1.0;

const VERTEX_SHADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_COMMON}
${GLSL_SKY}

varying vec2 vUv;

uniform sampler2D uSrcCloudGate;
uniform vec3  uSrcWaterRw;
uniform vec3  uSrcWaterAmbient;
uniform vec3  uSrcHemiRadiance;
uniform vec2  uSrcBodyGains;
uniform float uSrcReflectBlend;
uniform float uSrcGrazingRolloff;
uniform float uSrcSunVisible;
uniform float uSrcGlitter;
uniform float uSrcGlitterAlpha;

/**
 * THREE's equirect convention, not the sky LUT's.
 *
 * u = atan(z, x)/2pi + 0.5, v = asin(y)/pi + 0.5. PMREMGenerator assumes this,
 * and \`sphericalHarmonics.ts\` projects in it, so the diffuse and the specular
 * halves stay in register. \`SkyRadianceLut\` uses atan(x, -z) and keeps it;
 * these two maps are never sampled by the same code.
 */
vec3 srcDirection(vec2 uv) {
  float phi = (uv.x - 0.5) * 6.28318530718;
  float theta = (uv.y - 0.5) * 3.14159265359;
  float c = cos(theta);
  return vec3(c * cos(phi), sin(theta), c * sin(phi));
}

vec2 srcUv(vec3 d) {
  return vec2(
    atan(d.z, d.x) * 0.15915494309 + 0.5,
    asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5
  );
}

/**
 * Sky radiance with the cloud deck composited over it.
 *
 * The gas sky keeps its full 128x64 angular detail — the circumsolar aureole
 * and the horizon gradient both matter and neither survives a coarse grid. The
 * cloud layer arrives premultiplied from the CPU at low resolution, which is
 * all it needs: this is the low-frequency cloud LIGHT, not cloud silhouettes,
 * and silhouettes remain a visible-sky feature.
 *
 * The composite is an over, term for term the same as skyWithClouds() in
 * GLSL_SKY and its CPU mirror. Not a multiply — see TimeOfDay.cloudLayer for
 * why treating cloud as an absorber renders an overcast noon as night.
 */
vec3 gatedSky(vec3 dir, vec2 uv) {
  vec4 cloud = texture2D(uSrcCloudGate, uv);
  return skyRadiance(dir) * (1.0 - cloud.a) + cloud.rgb;
}

void main() {
  vec3 dir = srcDirection(vUv);

  if (dir.y >= 0.0) {
    gl_FragColor = vec4(gatedSky(dir, vUv), 1.0);
    return;
  }

  // --- the sea, seen from above ----------------------------------------
  // Flat surface: N is up, the view vector is -dir, and the mirror direction
  // is dir with its vertical component flipped. This is the ocean's own model
  // from Ocean.ts with the wave normal replaced by the mean surface — which is
  // the correct simplification, not a lazy one. A probe consumed at roughness
  // 0.38 and above cannot resolve an individual wave facet; what it needs right
  // is how much light comes up from below and what colour it is.
  vec3 mirrored = vec3(dir.x, -dir.y, dir.z);
  vec3 skySpec = gatedSky(mirrored, srcUv(mirrored));

  // A wind-roughened sea scatters the reflected sky toward the hemispheric
  // mean. Same blend the ocean applies, driven by the same aggregate slope
  // statistics, so the hull and the water it floats on agree about how glassy
  // the day is.
  vec3 reflection = mix(skySpec, uSrcHemiRadiance, uSrcReflectBlend);

  float NdV = -dir.y;
  // Roughness-limited grazing Fresnel: a real sea never reaches mirror
  // reflectance at grazing angles, and without the cap the horizon ring of this
  // map turns into a bright band that the SH then spreads over the whole hull.
  float f90 = 1.0 - uSrcGrazingRolloff * clamp(uSrcReflectBlend * 2.4, 0.0, 0.7);
  float fresnel = 0.0204 + (f90 - 0.0204) * pow(1.0 - NdV, 5.0);

  vec3 sunRadiance = uSunTint * lightTransmittance(uSunDir) * uSunPower;

  // Upwelling column radiance: Rw times downwelling irradiance, diffuse sky and
  // direct sun entering separately. Cobalt under a high sun, collapsing warm and
  // dark at sunset through the sun term's own elevation factor.
  vec3 bodyIrradiance = uSrcWaterAmbient * uSrcBodyGains.x
    + sunRadiance * max(uSunDir.y, 0.0) * uSrcBodyGains.y * uSrcSunVisible;
  vec3 radiance = mix(uSrcWaterRw * bodyIrradiance, reflection, fresnel);

  // --- sun glitter, behind a toggle ------------------------------------
  // Light thrown up off the sea onto the hull is a real and characteristic
  // thing to see on a boat, and it is also the term most likely to dump more
  // energy into the probe than the sea really returns — a statistical glitter
  // lobe integrated over a whole hemisphere is not the same object as a
  // glitter lobe rasterised per pixel. Default off, so the baseline this round
  // is judged against is the conservative one and the toggle is a comparison
  // rather than an unexamined default.
  if (uSrcGlitter > 0.5) {
    vec3 V = -dir;
    vec3 H = normalize(V + uSunDir);
    float fresnelSun = 0.0204 + 0.9796 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
    radiance += sunRadiance
      * ggxSpecular(vec3(0.0, 1.0, 0.0), V, uSunDir, uSrcGlitterAlpha)
      * fresnelSun * uSrcSunVisible;
  }

  gl_FragColor = vec4(radiance, 1.0);
}
`;

/**
 * How far the sea's reflection of the sky has blurred toward the hemisphere
 * mean, from the sea's own slope statistics.
 *
 * `meanSquareSlope + unresolvedSlopeVariance` is the Cox–Munk total for this
 * wind: everything the wave geometry resolves plus the nine octaves of capillary
 * slope below the resolution floor that no component can ever carry. The chain
 * after it — the glitter alpha, the lobe ratio, the 1.6 and the 0.55 ceiling —
 * is the ocean shader's own, reproduced here against the aggregate instead of
 * per pixel.
 *
 * That is the whole trick to the lower hemisphere. A glassy day and a gale
 * reflect the same sky with completely different coherence, and the difference
 * is a statistic the wave field already publishes. No wave is evaluated.
 */
export function reflectionLobeBlend(
  meanSquareSlope: number,
  unresolvedSlopeVariance: number,
  optics: OceanOpticsProfile,
): number {
  const sigma2 = Math.max(meanSquareSlope + unresolvedSlopeVariance, 0);
  const alphaGlitter = Math.min(
    Math.max(Math.sqrt(2 * sigma2) * optics.roughnessScale, 0.06),
    0.45,
  );
  const alphaReflect = Math.min(Math.max(alphaGlitter * optics.reflectLobeRatio, 0.04), 0.28);
  return Math.min(Math.max(alphaReflect * 1.6, 0), 0.55);
}

/** Everything the source needs from the rest of the world, per refresh. */
export interface WorldRadianceInputs {
  /**
   * The cloud deck toward a direction — `TimeOfDay.cloudLayer`. Premultiplied
   * radiance into `out`, opacity returned.
   */
  cloudLayer(dir: THREE.Vector3, out: [number, number, number]): number;
  /** Diffuse downwelling on the water, in the ocean's own units. */
  waterAmbient: THREE.Vector3;
  /** Cosine-weighted hemisphere mean the rough reflection blends toward. */
  hemisphericRadiance: THREE.Vector3;
  /** Aggregate reflection-lobe blend, 0 glassy .. 1 fully diffuse. */
  reflectBlend: number;
  /** Direct-sun gate: below-horizon fade times cloud transmittance. */
  sunVisible: number;
  optics: OceanOpticsProfile;
}

export class WorldRadianceSource {
  /** The map. Equirect, half float, ready for PMREM and for readback. */
  readonly texture: THREE.Texture;

  /**
   * Bumped on every refresh.
   *
   * The camera-invariance check watches this: with the world frozen, orbiting
   * the camera must leave it alone. Consumers use it to know when their derived
   * data is stale.
   */
  generation = 0;

  readonly target: THREE.WebGLRenderTarget;

  private readonly scene = new THREE.Scene();
  // Orthographic, not bare Camera: see CloudDome — three's reversed-depth
  // path needs updateProjectionMatrix() on every rendering camera.
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material: THREE.ShaderMaterial;
  private readonly gateTexture: THREE.DataTexture;
  private readonly gateData: Uint16Array;
  private readonly gateColour: [number, number, number] = [0, 0, 0];
  private readonly gateDir = new THREE.Vector3();
  private lastRefreshSeconds = Number.NEGATIVE_INFINITY;

  constructor(skyUniforms: Record<string, THREE.IUniform>, skyDefines: Record<string, number | string>) {
    this.target = new THREE.WebGLRenderTarget(WORLD_SOURCE_WIDTH, WORLD_SOURCE_HEIGHT, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.texture = this.target.texture;
    this.texture.name = 'World radiance source';
    // PMREMGenerator dispatches on this. Without it, `fromEquirectangular`
    // refuses the texture outright.
    this.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;

    // RGBA half float: premultiplied cloud radiance in RGB, opacity in A.
    //
    // Half rather than full float because R32F/RGBA32F are not linearly
    // filterable without OES_texture_float_linear, and a sampler that cannot
    // filter its format reads as ZERO rather than failing — which cost this
    // round an hour of looking at a source map whose sky was pure black while
    // the water below it, the one term not passing through this texture,
    // rendered perfectly. Half-float linear filtering is core in WebGL2.
    //
    // The radiance is HDR (a sunlit cloud top is far above 1), so 8-bit is not
    // an option here even though the opacity alone would fit comfortably.
    this.gateData = new Uint16Array(CLOUD_GATE_WIDTH * CLOUD_GATE_HEIGHT * 4);
    this.gateTexture = new THREE.DataTexture(
      this.gateData,
      CLOUD_GATE_WIDTH,
      CLOUD_GATE_HEIGHT,
      THREE.RGBAFormat,
      THREE.HalfFloatType,
    );
    this.gateTexture.name = 'World cloud gate';
    this.gateTexture.minFilter = THREE.LinearFilter;
    this.gateTexture.magFilter = THREE.LinearFilter;
    this.gateTexture.wrapS = THREE.RepeatWrapping;
    this.gateTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.gateTexture.colorSpace = THREE.NoColorSpace;
    this.gateTexture.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      // Spread, not copy: the values are the sky's own Uniform objects, so this
      // map sees exactly the atmosphere the dome and the ocean see with no
      // second synchronisation path to fall out of step. The sky block was
      // written anticipating this ("a future consumer — the ocean's haze, a
      // reflection probe — can reach the same sky by spreading the same block").
      uniforms: {
        ...skyUniforms,
        uSrcCloudGate: { value: this.gateTexture },
        uSrcWaterRw: { value: new THREE.Vector3() },
        uSrcWaterAmbient: { value: new THREE.Vector3() },
        uSrcHemiRadiance: { value: new THREE.Vector3() },
        uSrcBodyGains: { value: new THREE.Vector2(0.32, 0.3) },
        uSrcReflectBlend: { value: 0.25 },
        uSrcGrazingRolloff: { value: 0.55 },
        uSrcSunVisible: { value: 1 },
        uSrcGlitter: { value: 0 },
        uSrcGlitterAlpha: { value: 0.12 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      defines: skyDefines,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** Include the analytic sea glitter lobe in the probe. Diagnostic. */
  setGlitterEnabled(enabled: boolean): void {
    this.material.uniforms.uSrcGlitter.value = enabled ? 1 : 0;
  }

  /**
   * Refresh if it is time, or if `force` says the world just jumped.
   *
   * `force` exists for hard edits — teleporting the clock, switching sea state
   * from a debug panel, capturing a contact sheet. A one-second cadence is
   * right for a sky that drifts and wrong for a sky that was just replaced, and
   * the capture harness would otherwise photograph the previous instant's
   * light.
   *
   * Returns true when the map was rebuilt.
   */
  update(
    renderer: THREE.WebGLRenderer,
    elapsedSeconds: number,
    inputs: WorldRadianceInputs,
    force = false,
  ): boolean {
    if (!force && elapsedSeconds - this.lastRefreshSeconds < REFRESH_INTERVAL) return false;
    this.lastRefreshSeconds = elapsedSeconds;

    this.refreshCloudGate(inputs);

    const u = this.material.uniforms;
    const rw = waterBodyReflectance(inputs.optics);
    (u.uSrcWaterRw.value as THREE.Vector3).set(rw[0], rw[1], rw[2]);
    (u.uSrcWaterAmbient.value as THREE.Vector3).copy(inputs.waterAmbient);
    (u.uSrcHemiRadiance.value as THREE.Vector3).copy(inputs.hemisphericRadiance);
    (u.uSrcBodyGains.value as THREE.Vector2).set(
      inputs.optics.bodySkyGain,
      inputs.optics.bodySunGain,
    );
    u.uSrcReflectBlend.value = inputs.reflectBlend;
    u.uSrcGrazingRolloff.value = inputs.optics.grazingRolloff;
    u.uSrcSunVisible.value = inputs.sunVisible;

    const previousTarget = renderer.getRenderTarget();
    const previousShadowAuto = renderer.shadowMap.autoUpdate;
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(this.target);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.shadowMap.autoUpdate = previousShadowAuto;
    }

    this.generation++;
    return true;
  }

  /**
   * March the cloud deck over a fixed directional grid.
   *
   * Fixed, and in world space: the grid does not know the camera exists. Only
   * the upper hemisphere is marched — the lower half is water, and clouds are
   * not below it — so those rows stay fully transparent and the sea's own
   * mirror lookup picks the cloud up when it reads back into the sky.
   */
  private refreshCloudGate(inputs: WorldRadianceInputs): void {
    const half = THREE.DataUtils.toHalfFloat;
    for (let j = 0; j < CLOUD_GATE_HEIGHT; j++) {
      const v = (j + 0.5) / CLOUD_GATE_HEIGHT;
      const theta = (v - 0.5) * Math.PI;
      const y = Math.sin(theta);
      const c = Math.cos(theta);
      for (let i = 0; i < CLOUD_GATE_WIDTH; i++) {
        const p = (j * CLOUD_GATE_WIDTH + i) * 4;
        if (y <= 0) {
          this.gateData[p] = 0;
          this.gateData[p + 1] = 0;
          this.gateData[p + 2] = 0;
          this.gateData[p + 3] = 0;
          continue;
        }
        const phi = ((i + 0.5) / CLOUD_GATE_WIDTH - 0.5) * 2 * Math.PI;
        this.gateDir.set(c * Math.cos(phi), y, c * Math.sin(phi));
        const alpha = inputs.cloudLayer(this.gateDir, this.gateColour);
        this.gateData[p] = half(this.gateColour[0]);
        this.gateData[p + 1] = half(this.gateColour[1]);
        this.gateData[p + 2] = half(this.gateColour[2]);
        this.gateData[p + 3] = half(Math.min(Math.max(alpha, 0), 1));
      }
    }
    this.gateTexture.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.gateTexture.dispose();
    this.target.dispose();
  }
}
