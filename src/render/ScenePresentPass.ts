import * as THREE from 'three';

import {
  GLSL_SCOTOPIC,
  SCOTOPIC_ACUITY_CLAMP,
  SCOTOPIC_LIFT_GAMMA,
  SCOTOPIC_LIFT_SCALE,
  onScotopicChange,
  rodDominance,
  scotopicLiftScale,
  scotopicPassEngaged,
  scotopicStrength,
} from '../scene/scotopic';
import {
  calibratedLiftGamma,
  onDisplayCalibrationChange,
} from '../scene/displayCalibration';

/**
 * The frame's single point of presentation.
 *
 * WHY A FULL-SCREEN PASS AND NOT A SHARED GLSL FUNCTION
 * -----------------------------------------------------
 * `NIGHT_VISIBILITY_SPEC.md` settled this before any code was written and it is
 * worth restating, because the cheaper option looks better than it is. A shared
 * function called from every material's tail costs no pass, but it has to be
 * added to the ocean, the sky, the sails, the spray, the stars and every
 * standard material on the ship, and a material that forgets it glows wrongly
 * against everything else. This codebase has paid for that exact failure once,
 * in the sky's CPU/GPU mirror. So: one buffer, one operator, nothing can
 * disagree.
 *
 * WHAT MAKES THE MIGRATION SAFE
 * -----------------------------
 * Moving inline tone mapping into a pass is the classic way to double-apply it
 * on one surface and skip it on another. Here it cannot happen, and the reason
 * is three's own rule rather than our diligence: `WebGLPrograms.getParameters`
 * forces `toneMapping = NoToneMapping` and the output colour space to the
 * working (linear) space for EVERY material whenever a non-XR render target is
 * bound. So the instant the scene is aimed at this pass's buffer, every
 * material in the scene — hand-written and built-in alike — compiles with
 * `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`
 * expanded to nothing. No material can opt out and none can be forgotten.
 *
 * Three things do NOT follow from that rule and are handled explicitly:
 *
 *   1. THE OCEAN'S 1-LSB DITHER. It is written after `colorspace_fragment`, so
 *      three's rule does not disable it; it would go on adding 1/255 to a
 *      LINEAR RADIANCE, which at night's 5.0x exposure is about 26 sRGB codes
 *      of static. The ocean now takes `uQuantiseDither`, this pass clears it
 *      while the scene is aimed offscreen, and the dither is applied here
 *      instead — at the point of quantisation, after the operator, which is
 *      where it always belonged and which now covers the sky as well.
 *   2. DIAGNOSTIC READBACKS. A debug view writes a measured quantity past the
 *      tone curve on purpose. The pass must not photograph it, so the same
 *      predicate that excludes temporal resolve excludes this.
 *   3. BLENDING AND MSAA now happen in linear HDR rather than on sRGB-encoded
 *      bytes. That is more correct and it is still a change, so the pass is
 *      only ENGAGED once the observer model has something to do — see below.
 *
 * WHY IT IS NIGHT-ONLY
 * --------------------
 * "Daylight is bit-identical" is an acceptance clause, and an HDR round trip
 * cannot honour it to the letter: half-float storage, a different MSAA resolve
 * space and a different blend space are all small, all real, and none of them
 * are zero. Rather than argue them down, the pass simply does not run when the
 * operator would do nothing. `rodDominance` is exactly 0.0 for every sun
 * elevation above -6 degrees, which is all of daylight and all of sunset, so
 * daylight is not "nearly unchanged" — it is the same code path it was before
 * this file existed. The pass also costs nothing in daylight, which is the
 * right answer to a full-screen pass in a project with an open performance
 * regression.
 *
 * The engage threshold sits slightly ABOVE the point where rod dominance leaves
 * zero, so there is always a band of twilight in which the pass is running with
 * the operator provably inert. That band is where a path-change artefact would
 * show, and it is where to look for one.
 */

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Tone map, then see, then encode, then quantise. In that order, and the order
 * is the specification: the operator is defined on display-referred values, so
 * it cannot run before the curve; the dither exists to break up quantisation
 * steps, so it cannot run before the thing that decides where they fall.
 */
const PRESENT_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uScene;
uniform vec2 uInvResolution;
uniform float uRodDominance;
uniform float uDitherAmplitude;

varying vec2 vUv;

float presentHash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

${GLSL_SCOTOPIC}

vec3 displayAt(vec2 uv) {
  vec3 c = texture2D(uScene, uv).rgb;
  #if defined( TONE_MAPPING )
    c = toneMapping(c);
  #endif
  return c;
}

void main() {
  vec3 centre = displayAt(vUv);

  vec3 seen = centre;
  if (uRodDominance > 0.0) {
    // Four-tap cross at one device pixel, each tap clamped so it cannot exceed
    // the centre by more than SCOTOPIC_ACUITY_CLAMP. Without the clamp this is
    // a bleed rather than a blur: a star, a spark of moon glitter or the rim of
    // the lantern is a bright pixel in a dark neighbourhood, and it would smear
    // into the sea exactly where the spec says those things must stay put.
    float ceilingY = scotopicLuma(centre) + ${SCOTOPIC_ACUITY_CLAMP.toFixed(6)};
    vec3 sum = vec3(0.0);
    vec2 offsets[4];
    offsets[0] = vec2( uInvResolution.x, 0.0);
    offsets[1] = vec2(-uInvResolution.x, 0.0);
    offsets[2] = vec2(0.0,  uInvResolution.y);
    offsets[3] = vec2(0.0, -uInvResolution.y);
    for (int i = 0; i < 4; i++) {
      vec3 tap = displayAt(vUv + offsets[i]);
      float tapY = scotopicLuma(tap);
      sum += tap * min(1.0, ceilingY / max(tapY, 1e-7));
    }
    seen = scotopicVision(centre, sum * 0.25, uRodDominance);
  }

  gl_FragColor = vec4(seen, 1.0);

  #include <colorspace_fragment>

  // One-LSB screen-space dither at the single point of quantisation, moved here
  // from the ocean's own tail so that it lands after the operator rather than
  // before it, and so that the sky's gradients get it too. A static hash, not a
  // temporal one: the cure for banding must not shimmer.
  gl_FragColor.rgb += (presentHash21(gl_FragCoord.xy) - 0.5) * uDitherAmplitude;
}
`;

/**
 * Time constant for rod dominance, seconds.
 *
 * Real dark adaptation is minutes, not seconds, and modelling that faithfully
 * would mean a player who looks at the lantern loses the sea for ten minutes.
 * This is the exposure meter's own 4 s, for the same reason it uses it: long
 * enough that nothing steps, short enough that nobody waits.
 */
const ROD_ADAPT_SECONDS = 4.0;
/** Past this, the world has jumped rather than moved; snap instead of gliding. */
const ROD_SNAP_SECONDS = 1.0;

export interface ScenePresentPassOptions {
  /**
   * `TimeOfDay.retinalLuminance` — what the observer's eye is adapted to, in
   * real cd/m2. NOT the exposure meter's input, which reads the rendered sky in
   * this renderer's compressed units; see the block comment in scene/scotopic.ts
   * for the measurement that forced them apart.
   */
  adaptationLuminance: () => number;
  /**
   * Cleared while the scene is aimed at the offscreen buffer, restored after.
   *
   * The inline 1-LSB dithers are the one thing three's render-target rule does
   * not switch off for us, because they are written PAST
   * `colorspace_fragment`. There are two of them — the ocean's and the sky
   * dome's — and both must be told: a presenter that cleared only one would
   * dither half the picture at quantisation and the other half into a raw
   * radiance, which at night's ~5x exposure is not a dither at all.
   */
  setInlineQuantisationDither: (enabled: boolean) => void;
}

export class ScenePresentPass {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly fullscreenScene = new THREE.Scene();
  private readonly fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenMesh: THREE.Mesh;
  private readonly drawingBufferSize = new THREE.Vector2();

  private width = 0;
  private height = 0;
  private rod = 0;
  private rodInitialised = false;
  private engaged = false;
  private warmed = false;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCalibration: () => void;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly options: ScenePresentPassOptions,
  ) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      // The canvas is created with a stencil, and the interior mask uses it to
      // keep the sea out of the cabin. A buffer without one would flood the
      // captain's quarters the moment the lamp was lit, which is the only hour
      // this pass runs. See scene/interiorStencil.ts.
      stencilBuffer: true,
      samples: 4,
    });
    this.target.texture.name = 'scene-present-linear-hdr';
    this.target.texture.colorSpace = THREE.NoColorSpace;

    this.material = new THREE.ShaderMaterial({
      name: 'ScenePresentMaterial',
      uniforms: {
        uScene: { value: this.target.texture },
        uInvResolution: { value: new THREE.Vector2(1, 1) },
        uRodDominance: { value: 0 },
        // The uncalibrated opt-in value. Shipping strength is zero, so this is
        // never sampled until the explicit opt-in callback publishes any
        // stored display measurement over it.
        uScotopicLift: {
          value: new THREE.Vector2(SCOTOPIC_LIFT_GAMMA, SCOTOPIC_LIFT_SCALE),
        },
        uDitherAmplitude: { value: 1 / 255 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: PRESENT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: true,
    });

    this.fullscreenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.material,
    );
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenMesh);

    // A strength flip must land in the frame it is made, not four seconds
    // later: an A/B you have to wait out is an A/B you cannot see.
    this.unsubscribe = onScotopicChange(() => {
      this.rodInitialised = false;
      if (scotopicStrength() <= 0) {
        this.rod = 0;
        this.engaged = false;
        this.material.uniforms.uRodDominance.value = 0;
      }
      // Do not read a stored/URL display measurement for the shipping-off
      // path. Turning the lab arm on publishes it synchronously, before the
      // next frame can engage the pass.
      this.publishLift();
    });
    // A calibration must land the moment it is taken: the player has just been
    // staring at a black screen answering a question about it, and the whole
    // point is that they see the answer applied.
    this.publishLift();
    this.unsubscribeCalibration = onDisplayCalibrationChange(() =>
      this.publishLift(),
    );
  }

  /** Re-read opt-in display calibration and republish the lift it implies. */
  private publishLift(): void {
    if (scotopicStrength() <= 0) return;
    const gamma = calibratedLiftGamma();
    (this.material.uniforms.uScotopicLift.value as THREE.Vector2).set(
      gamma,
      scotopicLiftScale(gamma),
    );
  }

  /** Rod dominance actually applied this frame, for the panel and for tests. */
  get rodDominance(): number {
    return this.rod;
  }

  get active(): boolean {
    return this.engaged;
  }

  /**
   * Forget the rod's accumulated adaptation, so the next frame snaps.
   *
   * `rod` is a four-second low pass over the whole session. A capture that
   * restarts the simulation and then settles at 1/60 s per frame can never
   * wash it out — 72 frames is 1.2 seconds — so without this a night scene
   * staged after a day scene renders through the day scene's cones. Same
   * mechanism, and the same fix, as the sky's exposure meter.
   */
  resetAdaptation(): void {
    this.rodInitialised = false;
    this.engaged = false;
  }

  /**
   * Advance the observer's adaptation and decide whether the buffer is needed.
   * Called once per frame before the render, whichever path renders.
   *
   * `compatible` is false while the frame is a measurement rather than a
   * picture — a debug view, a category probe, a term sheet. Those write past
   * the tone curve on purpose so the readback gets the shader's number, and a
   * pass that re-photographs the frame would turn every one of them into a
   * photograph of a number.
   */
  update(presentationDtSeconds: number, compatible = true): void {
    if (!compatible) {
      this.engaged = false;
      // Do not let a diagnostic detour advance the observer's adaptation: the
      // frames it renders are not frames anybody looked at.
      return;
    }
    const strength = scotopicStrength();
    if (strength <= 0) {
      // Ash's shipped 0% verdict is a real bypass: no retinal sampling,
      // low-pass, drawing-buffer query or alternate presentation state
      // advances. Keep the uniform truthful for diagnostics and leave the next
      // opt-in frame unlatched so it snaps to the current night.
      this.rod = 0;
      this.rodInitialised = false;
      this.engaged = false;
      this.material.uniforms.uRodDominance.value = 0;
      return;
    }
    const luminance = this.options.adaptationLuminance();
    const target = rodDominance(luminance) * strength;
    if (!this.rodInitialised || presentationDtSeconds >= ROD_SNAP_SECONDS) {
      this.rod = target;
      this.rodInitialised = true;
    } else {
      this.rod +=
        (1 - Math.exp(-Math.max(0, presentationDtSeconds) / ROD_ADAPT_SECONDS)) *
        (target - this.rod);
    }
    this.material.uniforms.uRodDominance.value = this.rod;
    // Every frame, not only the frames this class renders: the temporal resolve
    // presents through the same material, and the acuity taps step by one
    // device pixel. Adaptive resolution walks the drawing buffer as the frame
    // budget moves, so a stale reciprocal is a blur at the wrong scale.
    this.syncResolution();

    this.engaged = scotopicPassEngaged({
      adaptationLuminance: luminance,
      strength,
      rod: this.rod,
      engaged: this.engaged,
    });
  }

  /**
   * Compile the offscreen variant of every material in the scene, once, at a
   * moment of our choosing.
   *
   * Three keys its program cache on the tone-mapping and output-colour-space
   * decisions, which the render target changes for every material at once. So
   * the first frame the pass engages would otherwise compile the whole scene a
   * second time — a stall, landing exactly at dusk. One 1x1 render pays it
   * early and in the daylight, where a dropped frame costs nothing. The cache
   * holds both variants afterwards, so it never happens again.
   */
  private warm(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.warmed || this.renderer.getRenderTarget() !== null) return;
    this.warmed = true;
    const previousTarget = this.renderer.getRenderTarget();
    const warmTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: true,
    });
    this.options.setInlineQuantisationDither(false);
    try {
      this.renderer.setRenderTarget(warmTarget);
      this.renderer.render(scene, camera);
    } finally {
      this.options.setInlineQuantisationDither(true);
      this.renderer.setRenderTarget(previousTarget);
      warmTarget.dispose();
    }
  }

  /** Follow the drawing buffer, which adaptive resolution moves under us. */
  private syncResolution(): void {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const width = Math.max(1, Math.round(this.drawingBufferSize.x));
    const height = Math.max(1, Math.round(this.drawingBufferSize.y));
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    (this.material.uniforms.uInvResolution.value as THREE.Vector2).set(
      1 / width,
      1 / height,
    );
    // Allocation is deferred to the frame that actually renders through the
    // buffer, so a daylight session never pays for one.
    if (this.engaged) this.target.setSize(width, height);
  }

  /** Draw the fullscreen present of whatever linear-HDR texture is supplied. */
  present(source: THREE.Texture): void {
    const previous = this.material.uniforms.uScene.value;
    this.material.uniforms.uScene.value = source;
    this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
    this.material.uniforms.uScene.value = previous;
  }

  /**
   * Render the scene through the buffer. Returns false when the pass declined,
   * in which case the caller must render as it always did — the original
   * direct-to-canvas call, unchanged, which is what makes daylight identical
   * rather than merely close.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): boolean {
    // A nested target means a probe, a shadow map or a diagnostic readback owns
    // the framebuffer. Presentation never interposes on a measurement.
    if (this.renderer.getRenderTarget() !== null) return false;
    if (!this.engaged) {
      // The rejected default must not compile a second variant of the whole
      // scene merely to keep an opt-in experiment warm. An enabled session
      // still pays this once in daylight, before its first dusk.
      if (scotopicStrength() > 0) this.warm(scene, camera);
      return false;
    }
    this.syncResolution();
    this.target.setSize(Math.max(1, this.width), Math.max(1, this.height));

    const previousTarget = this.renderer.getRenderTarget();
    this.options.setInlineQuantisationDither(false);
    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.render(scene, camera);
      this.renderer.setRenderTarget(previousTarget);
      this.present(this.target.texture);
    } finally {
      this.options.setInlineQuantisationDither(true);
      this.renderer.setRenderTarget(previousTarget);
    }
    this.warmed = true;
    return true;
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeCalibration();
    this.target.dispose();
    this.material.dispose();
    this.fullscreenMesh.geometry.dispose();
  }
}
