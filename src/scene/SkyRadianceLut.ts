import * as THREE from 'three';
import { GLSL_COMMON, GLSL_SKY } from './shaders/lib';

/**
 * Directional resolution of the gas-sky radiance cache.
 *
 * This is deliberately small: the gas atmosphere is angularly smooth, and the
 * ocean already blends under-resolved reflection structure towards its
 * hemispheric mean. The sun and moon discs are not part of skyRadiance(), so
 * they do not need to survive this grid.
 */
export const SKY_RADIANCE_LUT_WIDTH = 256;
export const SKY_RADIANCE_LUT_HEIGHT = 128;

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

vec3 skyLutDirection(vec2 uv) {
  float azimuth = (uv.x - 0.5) * 6.28318530718;
  float elevation = (uv.y - 0.5) * 3.14159265359;
  float horizontal = cos(elevation);
  return vec3(
    sin(azimuth) * horizontal,
    sin(elevation),
    -cos(azimuth) * horizontal
  );
}

void main() {
  gl_FragColor = vec4(skyRadiance(skyLutDirection(vUv)), 1.0);
}
`;

/**
 * One equirectangular evaluation of the analytic gas sky, shared by all ocean
 * pixels for the current frame.
 *
 * Rebuilding every frame is intentional for the first performance/quality
 * comparison: it makes the cache exact in time while still replacing millions
 * of duplicate atmosphere evaluations with 32,768 evaluations and two texture
 * reads per ocean fragment. A lower update cadence only becomes relevant if
 * this small pass measures as material.
 */
export class SkyRadianceLut {
  readonly texture: THREE.Texture;
  readonly width = SKY_RADIANCE_LUT_WIDTH;
  readonly height = SKY_RADIANCE_LUT_HEIGHT;

  private readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  // Orthographic, not bare Camera: see CloudDome — three's reversed-depth
  // path needs updateProjectionMatrix() on every rendering camera.
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material: THREE.ShaderMaterial;
  private enabledValue = true;

  constructor(
    liveUniforms: Record<string, THREE.IUniform>,
    defines: Record<string, number | string>,
  ) {
    this.target = new THREE.WebGLRenderTarget(
      SKY_RADIANCE_LUT_WIDTH,
      SKY_RADIANCE_LUT_HEIGHT,
      {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      },
    );
    this.texture = this.target.texture;
    this.texture.name = 'Gas sky radiance LUT';
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;

    this.material = new THREE.ShaderMaterial({
      // The sky owns these Uniform objects and mutates their values before
      // every render. Sharing the objects makes the LUT see exactly the state
      // the dome and ocean see without a second synchronization path.
      uniforms: liveUniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      defines,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  update(renderer: THREE.WebGLRenderer): void {
    if (!this.enabledValue) return;

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
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.target.dispose();
  }
}
