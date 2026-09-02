import * as THREE from 'three';

import type { Ocean } from '../scene/Ocean';
import { GLSL_WAVES } from '../scene/shaders/lib';
import { MAX_WAVES } from '../scene/Waves';
import {
  clampOceanTemporalStability,
  OCEAN_TEMPORAL_DEFAULT_STABILITY,
  OCEAN_TEMPORAL_MOTION_RANGE_PX,
  oceanTemporalHistoryWeight,
  oceanTemporalJitter,
} from './oceanTemporalMath';

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Re-render only the ocean geometry into a compact motion/visibility target.
 *
 * The current position is bit-for-bit the production Gerstner vertex path.
 * The previous position evaluates the same parameter-space water parcel with
 * the previous component table, phase, amplitude, LOD centre and camera. This
 * is deforming-surface motion, not camera-only motion.
 */
const MOTION_VERTEX = /* glsl */ `
precision highp float;

${GLSL_WAVES}

uniform vec4 uPreviousWaveA[NUM_WAVES];
uniform vec4 uPreviousWaveB[NUM_WAVES];
uniform float uPreviousWaveAmp;
uniform vec2 uPreviousWaveOrigin;
uniform mat4 uPreviousViewProjection;
uniform vec2 uResolution;

varying highp vec2 vTemporalParam;
varying highp vec2 vMotionPixels;

vec3 previousWaveDisplacement(vec2 parameterPosition, float lodRadius) {
  vec3 displacement = vec3(0.0);
  for (int i = 0; i < NUM_VERTEX_WAVES; i++) {
    vec2 direction = uPreviousWaveA[i].xy;
    float waveNumber = uPreviousWaveA[i].w;
    float steepness = uPreviousWaveB[i].x;
    float lod = 1.0 - smoothstep(
      uPreviousWaveB[i].z,
      uPreviousWaveB[i].w,
      lodRadius
    );
    float amplitude = uPreviousWaveA[i].z * uPreviousWaveAmp * lod;
    if (amplitude <= 0.0) continue;

    float phase = waveNumber * dot(direction, parameterPosition)
      + uPreviousWaveB[i].y;
    displacement.xz += steepness * amplitude * direction * cos(phase);
    displacement.y += amplitude * sin(phase);
  }
  return displacement;
}

void main() {
  vec2 localParameter = position.xz;
  float currentLodRadius = length(localParameter);
  vec2 parameterPosition = localParameter + uWaveOrigin;

  WaveResult currentWave = evaluateWaves(parameterPosition, currentLodRadius);
  vec3 currentLocal = vec3(
    localParameter.x + currentWave.displacement.x,
    currentWave.displacement.y,
    localParameter.y + currentWave.displacement.z
  );
  vec4 currentWorld = modelMatrix * vec4(currentLocal, 1.0);
  vec4 currentClip = projectionMatrix * viewMatrix * currentWorld;

  // The disc follows the observer, but history follows water. Re-evaluate the
  // CURRENT parameter-space parcel using the previous frame's LOD centre; do
  // not follow vertex identity when the radial disc recentres underneath it.
  float previousLodRadius = length(parameterPosition - uPreviousWaveOrigin);
  vec3 previousDisplacement = previousWaveDisplacement(
    parameterPosition,
    previousLodRadius
  );
  vec4 previousWorld = vec4(
    parameterPosition.x + previousDisplacement.x,
    previousDisplacement.y,
    parameterPosition.y + previousDisplacement.z,
    1.0
  );
  vec4 previousClip = uPreviousViewProjection * previousWorld;

  vec2 currentNdc = currentClip.xy / max(currentClip.w, 1e-6);
  vec2 previousNdc = previousClip.xy / max(previousClip.w, 1e-6);
  vMotionPixels = (currentNdc - previousNdc) * (0.5 * uResolution);
  vTemporalParam = parameterPosition;
  gl_Position = currentClip;
}
`;

/**
 * R/G: signed motion encoded over +/- uMotionRangePixels.
 * B: currently visible ocean mask.
 * A: strength of the still-resolvable procedural detail band.
 */
const MOTION_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uMotionRangePixels;
uniform float uDetailFrequency;
uniform float uDetailAmplitude;
uniform float uDetailEnabled;

varying highp vec2 vTemporalParam;
varying highp vec2 vMotionPixels;

void main() {
  float footprint = max(
    fwidth(vTemporalParam.x),
    fwidth(vTemporalParam.y)
  );
  float baseCell = 1.0 / max(uDetailFrequency, 1e-5);
  float detailLive = 1.0 - smoothstep(
    0.20 * baseCell,
    0.50 * baseCell,
    footprint
  );
  detailLive *= smoothstep(0.001, 0.02, uDetailAmplitude) * uDetailEnabled;

  float largestMotion = max(abs(vMotionPixels.x), abs(vMotionPixels.y));
  float motionValid = 1.0 - step(uMotionRangePixels, largestMotion);
  vec2 encodedMotion = clamp(
    vMotionPixels / (2.0 * uMotionRangePixels) + 0.5,
    0.0,
    1.0
  );
  gl_FragColor = vec4(encodedMotion, 1.0, detailLive * motionValid);
}
`;

/** Conservative foreground mask drawn over the ocean metadata depth. */
const OCCLUDER_VERTEX = /* glsl */ `
precision highp float;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Points such as spray and spindrift use the same conservative mask material.
  gl_PointSize = 4.0;
}
`;

const OCCLUDER_FRAGMENT = /* glsl */ `
precision highp float;

void main() {
  gl_FragColor = vec4(0.0);
}
`;

/**
 * Resolve linear-HDR values from the antialiased current-frame target.
 * Non-detail pixels stay current; only marked ocean detail enters history.
 */
const RESOLVE_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uCurrentColor;
uniform sampler2D uMotionMetadata;
uniform sampler2D uHistoryColor;
uniform vec2 uInvResolution;
uniform float uMotionRangePixels;
uniform float uHistoryValid;
uniform float uMaxHistoryWeight;

varying vec2 vUv;

float temporalLuminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec4 current = texture2D(uCurrentColor, vUv);
  vec4 metadata = texture2D(uMotionMetadata, vUv);
  float oceanVisible = metadata.b;
  float detailStrength = metadata.a;

  if (uHistoryValid < 0.5 || detailStrength <= 0.001) {
    gl_FragColor = vec4(current.rgb, oceanVisible);
    return;
  }

  vec2 motionPixels = (metadata.rg - 0.5) * (2.0 * uMotionRangePixels);
  vec2 previousUv = vUv - motionPixels * uInvResolution;
  if (
    previousUv.x <= 0.0 || previousUv.x >= 1.0 ||
    previousUv.y <= 0.0 || previousUv.y >= 1.0
  ) {
    gl_FragColor = vec4(current.rgb, oceanVisible);
    return;
  }

  vec4 history = texture2D(uHistoryColor, previousUv);
  if (history.a < 0.5) {
    gl_FragColor = vec4(current.rgb, oceanVisible);
    return;
  }

  // A five-tap current-frame neighbourhood clips obsolete highlights without
  // smearing them across an unrelated colour. The proportional pad preserves
  // a sub-pixel glint long enough for neighbouring jitter samples to converge.
  vec3 east = texture2D(
    uCurrentColor,
    vUv + vec2(uInvResolution.x, 0.0)
  ).rgb;
  vec3 west = texture2D(
    uCurrentColor,
    vUv - vec2(uInvResolution.x, 0.0)
  ).rgb;
  vec3 north = texture2D(
    uCurrentColor,
    vUv + vec2(0.0, uInvResolution.y)
  ).rgb;
  vec3 south = texture2D(
    uCurrentColor,
    vUv - vec2(0.0, uInvResolution.y)
  ).rgb;
  vec3 neighbourhoodMin = min(
    min(min(current.rgb, east), min(west, north)),
    south
  );
  vec3 neighbourhoodMax = max(
    max(max(current.rgb, east), max(west, north)),
    south
  );
  vec3 historyPad = max(
    (neighbourhoodMax - neighbourhoodMin) * 0.35,
    vec3(0.002) + 0.05 * max(current.rgb, neighbourhoodMax)
  );
  vec3 clippedHistory = clamp(
    history.rgb,
    neighbourhoodMin - historyPad,
    neighbourhoodMax + historyPad
  );

  float currentLum = temporalLuminance(current.rgb);
  float historyLum = temporalLuminance(clippedHistory);
  float relativeChange = abs(currentLum - historyLum)
    / max(max(currentLum, historyLum), 0.04);
  float reactive = smoothstep(0.20, 1.20, relativeChange);
  float motionMagnitude = length(motionPixels);
  float motionConfidence = 1.0 - smoothstep(8.0, 30.0, motionMagnitude);

  // The default is deliberately short enough to yield when a real glint or
  // crest changes radiance. The graphics panel can tune the ceiling, while the
  // reactive and motion terms still reject obsolete history at every setting.
  float historyWeight = uMaxHistoryWeight
    * detailStrength
    * motionConfidence
    * mix(1.0, 0.25, reactive);
  gl_FragColor = vec4(
    mix(current.rgb, clippedHistory, historyWeight),
    oceanVisible
  );
}
`;

const COPY_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uResolvedColor;
varying vec2 vUv;

float copyHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  gl_FragColor = vec4(texture2D(uResolvedColor, vUv).rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // The ocean's own 1-LSB dither is switched off while it draws into this
  // path's linear-HDR target, because there it would land on a raw radiance
  // rather than on a quantisation step. This is where quantisation actually
  // happens, so this is where it goes.
  gl_FragColor.rgb += (copyHash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
}
`;

function configureTexture(
  texture: THREE.Texture,
  filter: THREE.MagnificationTextureFilter,
): void {
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
}

function createHistoryTarget(name: string): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.name = name;
  configureTexture(target.texture, THREE.LinearFilter);
  return target;
}

function createCurrentColorTarget(): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
  });
  target.texture.name = 'ocean-temporal-current-linear-hdr';
  configureTexture(target.texture, THREE.LinearFilter);
  return target;
}

function createMetadataTarget(): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.texture.name = 'ocean-temporal-motion';
  configureTexture(target.texture, THREE.NearestFilter);
  return target;
}

/**
 * Whatever owns the frame's display transform. When one is supplied, this class
 * hands it the resolved linear-HDR colour instead of presenting the frame
 * itself, so the observer model and the dither are applied exactly once and in
 * one place whichever render path the frame took.
 */
export interface TemporalPresenter {
  /** True when this presenter wants the frame; false to fall back to the copy. */
  readonly active: boolean;
  present(source: THREE.Texture): void;
  /**
   * Draw the whole frame through the presenter's own buffer. Used on the days
   * this class declines to resolve at all — a calm sea has no live detail
   * octave to accumulate — so that the display transform does not depend on
   * whether the water happens to be rough.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): boolean;
}

/**
 * Ocean-only temporal supersampling and reprojection.
 *
 * The ordinary antialiased scene render is captured in a linear-HDR target. A
 * cheap ocean draw writes deforming-surface motion and an occluder
 * pass erases foreground coverage. The full-screen resolve then reuses history
 * only where the procedural detail octave is still explicitly drawn. Every
 * other pixel is copied from the current frame unchanged.
 */
export class OceanTemporalResolve {
  private readonly currentColorTarget = createCurrentColorTarget();
  private readonly metadataTarget = createMetadataTarget();
  private readonly historyTargets = [
    createHistoryTarget('ocean-temporal-history-a'),
    createHistoryTarget('ocean-temporal-history-b'),
  ] as const;

  private readonly motionMaterial: THREE.ShaderMaterial;
  private readonly occluderMaterial: THREE.ShaderMaterial;
  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly motionScene = new THREE.Scene();
  private readonly motionMesh: THREE.Mesh;
  private readonly fullscreenScene = new THREE.Scene();
  private readonly fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenMesh: THREE.Mesh;

  private readonly previousWaveA = new Float32Array(MAX_WAVES * 4);
  private readonly previousWaveB = new Float32Array(MAX_WAVES * 4);
  private readonly previousWaveOrigin = new THREE.Vector2();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly currentViewProjection = new THREE.Matrix4();
  private readonly drawingBufferSize = new THREE.Vector2();
  private readonly savedClearColor = new THREE.Color();
  private readonly nonOccludingVisibility: boolean[];

  private previousWaveAmplitude = 1;
  private previousVertexSlots = MAX_WAVES;
  private historyReadIndex = 0;
  private historyValid = false;
  private frameIndex = 0;
  private width = 0;
  private height = 0;
  private temporalEnabled: boolean;
  private temporalStability = OCEAN_TEMPORAL_DEFAULT_STABILITY;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly ocean: Ocean,
    enabled = true,
    private readonly background: THREE.Object3D | null = null,
    private readonly nonOccludingObjects: readonly THREE.Object3D[] = [],
    private readonly presenter: TemporalPresenter | null = null,
    /**
     * Clears every inline 1-LSB dither while the scene is aimed at this path's
     * linear-HDR target. Defaults to the ocean's alone, which is all this class
     * can reach on its own; production passes one that also silences the sky
     * dome's. See `uQuantiseDither` in Ocean.ts and SkySystem.ts.
     */
    private readonly setInlineQuantisationDither: (enabled: boolean) => void = (
      enabled,
    ) => ocean.setQuantisationDither(enabled),
  ) {
    this.temporalEnabled = enabled;
    this.nonOccludingVisibility = nonOccludingObjects.map(() => true);

    const oceanUniforms = ocean.material.uniforms;
    this.motionMaterial = new THREE.ShaderMaterial({
      name: 'OceanTemporalMotionMaterial',
      defines: {
        NUM_WAVES: MAX_WAVES,
        NUM_VERTEX_WAVES: ocean.profileSettings.vertexWaveSlots,
      },
      uniforms: {
        uWaveA: { value: oceanUniforms.uWaveA.value },
        uWaveB: { value: oceanUniforms.uWaveB.value },
        uWaveAmp: { value: oceanUniforms.uWaveAmp.value },
        uWaveOrigin: { value: new THREE.Vector2() },
        uResidualMaxK: { value: oceanUniforms.uResidualMaxK.value },
        uPreviousWaveA: { value: this.previousWaveA },
        uPreviousWaveB: { value: this.previousWaveB },
        uPreviousWaveAmp: { value: this.previousWaveAmplitude },
        uPreviousWaveOrigin: { value: this.previousWaveOrigin },
        uPreviousViewProjection: { value: this.previousViewProjection },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uMotionRangePixels: { value: OCEAN_TEMPORAL_MOTION_RANGE_PX },
        uDetailFrequency: { value: oceanUniforms.uDetailFreq.value },
        uDetailAmplitude: { value: oceanUniforms.uDetailAmp.value },
        uDetailEnabled: { value: 1 },
      },
      vertexShader: MOTION_VERTEX,
      fragmentShader: MOTION_FRAGMENT,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.occluderMaterial = new THREE.ShaderMaterial({
      name: 'OceanTemporalOccluderMaterial',
      vertexShader: OCCLUDER_VERTEX,
      fragmentShader: OCCLUDER_FRAGMENT,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'OceanTemporalResolveMaterial',
      uniforms: {
        uCurrentColor: { value: this.currentColorTarget.texture },
        uMotionMetadata: { value: this.metadataTarget.texture },
        uHistoryColor: { value: this.historyTargets[0].texture },
        uInvResolution: { value: new THREE.Vector2(1, 1) },
        uMotionRangePixels: { value: OCEAN_TEMPORAL_MOTION_RANGE_PX },
        uHistoryValid: { value: 0 },
        uMaxHistoryWeight: {
          value: oceanTemporalHistoryWeight(this.temporalStability),
        },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });

    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'OceanTemporalCopyMaterial',
      uniforms: {
        uResolvedColor: { value: this.historyTargets[0].texture },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: true,
    });

    this.motionMesh = new THREE.Mesh(ocean.mesh.geometry, this.motionMaterial);
    this.motionMesh.name = 'ocean-temporal-motion';
    this.motionMesh.frustumCulled = false;
    this.motionMesh.matrixAutoUpdate = false;
    this.motionScene.add(this.motionMesh);

    this.fullscreenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.resolveMaterial,
    );
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenMesh);
  }

  /** Drop accumulated colour after a cut, resize or discontinuous sea change. */
  invalidate(): void {
    this.historyValid = false;
    this.frameIndex = 0;
  }

  /** Runtime presentation switch used by the graphics panel for exact A/Bs. */
  get enabled(): boolean {
    return this.temporalEnabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.temporalEnabled) return;
    this.temporalEnabled = enabled;
    // Neither side of an A/B should inherit samples gathered on the other.
    this.invalidate();
  }

  /** Friendly 0..100 stability dial; the shader receives its nonlinear weight. */
  get stability(): number {
    return this.temporalStability;
  }

  setStability(stability: number): void {
    const next = clampOceanTemporalStability(stability);
    if (next === this.temporalStability) return;
    this.temporalStability = next;
    this.resolveMaterial.uniforms.uMaxHistoryWeight.value =
      oceanTemporalHistoryWeight(next);
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.currentColorTarget.setSize(width, height);
    this.metadataTarget.setSize(width, height);
    this.historyTargets[0].setSize(width, height);
    this.historyTargets[1].setSize(width, height);
    (this.motionMaterial.uniforms.uResolution.value as THREE.Vector2).set(width, height);
    (this.resolveMaterial.uniforms.uInvResolution.value as THREE.Vector2).set(
      1 / width,
      1 / height,
    );
    this.invalidate();
  }

  private updateCurrentState(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.currentViewProjection.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );

    const source = this.ocean.material.uniforms;
    const slots = this.ocean.profileSettings.vertexWaveSlots;
    if (slots !== this.previousVertexSlots) {
      this.motionMaterial.defines.NUM_VERTEX_WAVES = slots;
      this.motionMaterial.needsUpdate = true;
      this.previousVertexSlots = slots;
      this.invalidate();
    }
    this.motionMaterial.uniforms.uWaveA.value = source.uWaveA.value;
    this.motionMaterial.uniforms.uWaveB.value = source.uWaveB.value;
    this.motionMaterial.uniforms.uWaveAmp.value = source.uWaveAmp.value;
    (this.motionMaterial.uniforms.uWaveOrigin.value as THREE.Vector2).copy(
      source.uWaveOrigin.value as THREE.Vector2,
    );
    this.motionMaterial.uniforms.uResidualMaxK.value = source.uResidualMaxK.value;
    this.motionMaterial.uniforms.uDetailFrequency.value = source.uDetailFreq.value;
    this.motionMaterial.uniforms.uDetailAmplitude.value = source.uDetailAmp.value;
    this.motionMaterial.uniforms.uDetailEnabled.value =
      this.ocean.profileSettings.detailOctaves > 0 ? 1 : 0;
    this.motionMaterial.uniforms.uPreviousWaveAmp.value = this.previousWaveAmplitude;
  }

  private capturePreviousState(): void {
    const source = this.ocean.material.uniforms;
    this.previousWaveA.set(source.uWaveA.value as Float32Array);
    this.previousWaveB.set(source.uWaveB.value as Float32Array);
    this.previousWaveAmplitude = source.uWaveAmp.value as number;
    this.previousWaveOrigin.copy(source.uWaveOrigin.value as THREE.Vector2);
    this.previousViewProjection.copy(this.currentViewProjection);
    this.motionMaterial.uniforms.uPreviousWaveAmp.value = this.previousWaveAmplitude;
  }

  private seedPreviousState(camera: THREE.Camera): void {
    this.updateCurrentState(camera);
    this.capturePreviousState();
  }

  /**
   * Render the scene, temporally resolving only the ocean's live detail band.
   * Passing false is the exact direct-render path used by structural probes.
   */
  render(scene: THREE.Scene, camera: THREE.Camera, enabled = true): void {
    const detailActive =
      this.ocean.profileSettings.detailOctaves > 0 &&
      (this.ocean.material.uniforms.uDetailAmp.value as number) > 1e-5;
    // Temporal presentation owns the default framebuffer, so nested diagnostic
    // targets retain their exact direct-render behaviour.
    if (
      !this.temporalEnabled ||
      !enabled ||
      !detailActive ||
      this.renderer.getRenderTarget() !== null
    ) {
      this.ocean.setTemporalDetailJitter(0, 0);
      this.invalidate();
      // Still offer the frame to the presenter. Otherwise a calm sea under
      // ?oceanTaa=1 would silently lose the observer model at night, purely
      // because there was no detail octave left to temporally resolve.
      if (this.presenter?.render(scene, camera) !== true) {
        this.renderer.render(scene, camera);
      }
      return;
    }

    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const width = Math.max(1, Math.round(this.drawingBufferSize.x));
    const height = Math.max(1, Math.round(this.drawingBufferSize.y));
    this.resize(width, height);
    if (!this.historyValid) this.seedPreviousState(camera);
    this.updateCurrentState(camera);

    const jitter = oceanTemporalJitter(this.frameIndex);
    const previousTarget = this.renderer.getRenderTarget();
    const previousAutoClear = this.renderer.autoClear;
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    const previousShadowAuto = this.renderer.shadowMap.autoUpdate;
    const previousOverrideMaterial = scene.overrideMaterial;
    const previousOceanVisible = this.ocean.mesh.visible;
    const previousBackgroundVisible = this.background?.visible;
    for (let index = 0; index < this.nonOccludingObjects.length; index++) {
      this.nonOccludingVisibility[index] = this.nonOccludingObjects[index].visible;
    }

    const historyRead = this.historyTargets[this.historyReadIndex];
    const historyWriteIndex = 1 - this.historyReadIndex;
    const historyWrite = this.historyTargets[historyWriteIndex];
    this.resolveMaterial.uniforms.uCurrentColor.value =
      this.currentColorTarget.texture;
    this.resolveMaterial.uniforms.uMotionMetadata.value = this.metadataTarget.texture;
    this.resolveMaterial.uniforms.uHistoryColor.value = historyRead.texture;
    this.resolveMaterial.uniforms.uHistoryValid.value = this.historyValid ? 1 : 0;

    try {
      this.ocean.setTemporalDetailJitter(jitter[0], jitter[1]);
      // Three compiles tone mapping and the sRGB encode out of every material
      // aimed at a render target, but not the ocean's dither — it is written
      // past `colorspace_fragment`. Left on, it adds 1/255 of a LINEAR
      // radiance, which at night's ~5x exposure is about 26 sRGB codes of
      // static. Quantisation happens at the present, so the dither goes there.
      this.setInlineQuantisationDither(false);

      // Capture linear scene radiance before output tone mapping. This target is
      // private to the opt-in path; the ordinary default framebuffer remains
      // discardable when temporal rendering is disabled.
      this.renderer.setRenderTarget(this.currentColorTarget);
      this.renderer.render(scene, camera);
      this.renderer.autoClear = false;

      // Ocean motion writes depth first. The conservative override pass then
      // paints zero metadata wherever foreground geometry is actually closer,
      // so raft, ship, spray and future scene objects never enter history.
      this.motionMesh.matrix.copy(this.ocean.mesh.matrixWorld);
      this.motionMesh.matrixWorld.copy(this.ocean.mesh.matrixWorld);
      this.renderer.setRenderTarget(this.metadataTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, false);
      this.renderer.render(this.motionScene, camera);

      this.renderer.shadowMap.autoUpdate = false;
      scene.overrideMaterial = this.occluderMaterial;
      this.ocean.mesh.visible = false;
      if (this.background) this.background.visible = false;
      for (let index = 0; index < this.nonOccludingObjects.length; index++) {
        this.nonOccludingObjects[index].visible = false;
      }
      this.renderer.render(scene, camera);

      // Reproject and accumulate into the next ping-pong history target.
      this.fullscreenMesh.material = this.resolveMaterial;
      this.renderer.setRenderTarget(historyWrite);
      this.renderer.render(this.fullscreenScene, this.fullscreenCamera);

      // Apply the display transform exactly once while presenting the resolved
      // linear-HDR colour to the canvas. When a presenter owns the transform —
      // the scotopic pass does, whenever the observer is dark-adapted — hand it
      // the same texture rather than running a second, disagreeing copy.
      this.renderer.setRenderTarget(previousTarget);
      if (this.presenter !== null && this.presenter.active) {
        this.presenter.present(historyWrite.texture);
      } else {
        this.copyMaterial.uniforms.uResolvedColor.value = historyWrite.texture;
        this.fullscreenMesh.material = this.copyMaterial;
        this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
      }
    } finally {
      this.ocean.setTemporalDetailJitter(0, 0);
      this.setInlineQuantisationDither(true);
      scene.overrideMaterial = previousOverrideMaterial;
      this.ocean.mesh.visible = previousOceanVisible;
      if (this.background && previousBackgroundVisible !== undefined) {
        this.background.visible = previousBackgroundVisible;
      }
      for (let index = 0; index < this.nonOccludingObjects.length; index++) {
        this.nonOccludingObjects[index].visible = this.nonOccludingVisibility[index];
      }
      this.renderer.shadowMap.autoUpdate = previousShadowAuto;
      this.renderer.setClearColor(this.savedClearColor, previousClearAlpha);
      this.renderer.autoClear = previousAutoClear;
      this.renderer.setRenderTarget(previousTarget);
    }

    this.capturePreviousState();
    this.historyReadIndex = historyWriteIndex;
    this.historyValid = true;
    this.frameIndex++;
  }

  dispose(): void {
    this.currentColorTarget.dispose();
    this.metadataTarget.dispose();
    this.historyTargets[0].dispose();
    this.historyTargets[1].dispose();
    this.motionMaterial.dispose();
    this.occluderMaterial.dispose();
    this.resolveMaterial.dispose();
    this.copyMaterial.dispose();
    this.fullscreenMesh.geometry.dispose();
  }
}
