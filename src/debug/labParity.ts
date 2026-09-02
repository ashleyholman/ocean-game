import * as THREE from 'three';
import { GLSL_WAVES } from '../scene/shaders/lib';
import { MAX_WAVES } from '../scene/Waves';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type LabParityCapability = SimCapability<
  'ocean' | 'renderer' | 'scene' | 'waves'
>;

/**
 * Direct CPU-versus-GPU parity measurement.
 *
 * The ocean is re-rendered through a top-down orthographic camera with a
 * fragment shader that packs the surface height into RGBA8 instead of shading
 * it. Reading those pixels back gives the height of the surface the GPU
 * actually drew, at a known world position — which is compared against
 * `WaveField.sampleHeight()` at the same position and the same instant.
 *
 * This is a measurement of the *rendered* surface, not of the shader's
 * arithmetic, so it includes the mesh's linear-interpolation error between
 * vertices. That is deliberate: what has to agree with the raft is the water
 * the player can see.
 */

const VERTEX = /* glsl */ `
precision highp float;
${GLSL_WAVES}
varying float vSurfaceY;
void main() {
  vec2 p = position.xz;
  float lodRadius = length(p);
  WaveResult w = evaluateWaves(p + uWaveOrigin, lodRadius);
  vec3 local = vec3(p.x + w.displacement.x, w.displacement.y, p.y + w.displacement.z);
  vec4 world = modelMatrix * vec4(local, 1.0);
  vSurfaceY = world.y;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform float uRange;
varying float vSurfaceY;
void main() {
  float v = clamp(vSurfaceY / (2.0 * uRange) + 0.5, 0.0, 1.0);
  vec4 enc = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);
  enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  gl_FragColor = enc;
}
`;

const RANGE = 16.0;

export interface ParityResult {
  /** Half-width of the sampled square, metres. */
  span: number;
  samples: number;
  maxError: number;
  meanAbsError: number;
  p99Error: number;
  /** World position of the worst disagreement. */
  worstX: number;
  worstZ: number;
  cpuAtWorst: number;
  gpuAtWorst: number;
}

export class ParityProbe {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 400);
  private readonly buffer: Uint8Array;
  private readonly resolution: number;

  constructor(private readonly sim: LabParityCapability, resolution = 96) {
    this.resolution = resolution;
    this.target = new THREE.WebGLRenderTarget(resolution, resolution, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      colorSpace: THREE.NoColorSpace,
      type: THREE.UnsignedByteType,
    });
    this.buffer = new Uint8Array(resolution * resolution * 4);

    const oceanUniforms = sim.ocean.material.uniforms;
    this.material = new THREE.ShaderMaterial({
      // Share the *same* uniform objects as the ocean, so there is no chance of
      // measuring a stale or separately-updated wave field.
      uniforms: {
        uWaveA: oceanUniforms.uWaveA,
        uWaveB: oceanUniforms.uWaveB,
        uWaveAmp: oceanUniforms.uWaveAmp,
        uWaveOrigin: oceanUniforms.uWaveOrigin,
        // Declared by GLSL_WAVES. The probe never calls the residual term, but
        // sharing the object keeps this material a true mirror of the ocean's.
        uResidualMaxK: oceanUniforms.uResidualMaxK,
        uRange: { value: RANGE },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      defines: { NUM_WAVES: MAX_WAVES },
      side: THREE.FrontSide,
      fog: false,
    });

    this.camera.up.set(0, 0, -1);
  }

  /** Measure over a square of side `2 * span` centred on the raft. */
  measure(span = 3.0): ParityResult {
    const { sim } = this;
    // The renderer is raft-centred: the raft's nominal local position is the
    // render origin, and the wave field's presentation origin is folded into
    // the phase rather than into these coordinates.
    const cx = 0;
    const cz = 0;

    this.camera.left = -span;
    this.camera.right = span;
    this.camera.top = span;
    this.camera.bottom = -span;
    this.camera.near = 0.1;
    this.camera.far = 400;
    this.camera.position.set(cx, 200, cz);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(cx, 0, cz);
    this.camera.updateProjectionMatrix();

    const mesh = sim.ocean.mesh;
    const originalMaterial = mesh.material;
    const visibility: Array<[THREE.Object3D, boolean]> = [];
    for (const child of sim.scene.children) {
      if (child !== mesh) {
        visibility.push([child, child.visible]);
        child.visible = false;
      }
    }
    mesh.material = this.material;

    const previousTarget = sim.renderer.getRenderTarget();
    sim.renderer.setRenderTarget(this.target);
    sim.renderer.setClearColor(0x000000, 0);
    sim.renderer.clear(true, true, false);
    sim.renderer.render(sim.scene, this.camera);
    sim.renderer.readRenderTargetPixels(this.target, 0, 0, this.resolution, this.resolution, this.buffer);
    sim.renderer.setRenderTarget(previousTarget);
    sim.renderer.setClearColor(0x0a1420, 1);

    mesh.material = originalMaterial;
    for (const [child, wasVisible] of visibility) child.visible = wasVisible;

    // Camera +X is world +X and camera +Y is world −Z, and readback rows start
    // at the bottom of the image.
    const n = this.resolution;
    const errors: number[] = [];
    let maxError = 0;
    let sumAbs = 0;
    let worstX = 0;
    let worstZ = 0;
    let cpuAtWorst = 0;
    let gpuAtWorst = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4;
        const r = this.buffer[o] / 255;
        const g = this.buffer[o + 1] / 255;
        const b = this.buffer[o + 2] / 255;
        const a = this.buffer[o + 3] / 255;
        if (r === 0 && g === 0 && b === 0 && a === 0) continue;
        const v = r + g / 255 + b / 65025 + a / 16581375;
        const gpuY = (v - 0.5) * 2 * RANGE;

        const camX = -span + ((i + 0.5) / n) * 2 * span;
        const camY = -span + ((j + 0.5) / n) * 2 * span;
        const worldX = cx + camX;
        const worldZ = cz - camY;

        const cpuY = sim.waves.sampleHeight(worldX, worldZ);
        const error = Math.abs(cpuY - gpuY);
        errors.push(error);
        sumAbs += error;
        if (error > maxError) {
          maxError = error;
          worstX = worldX;
          worstZ = worldZ;
          cpuAtWorst = cpuY;
          gpuAtWorst = gpuY;
        }
      }
    }

    errors.sort((p, q) => p - q);
    const p99 = errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.99))] : 0;

    return {
      span,
      samples: errors.length,
      maxError,
      meanAbsError: errors.length ? sumAbs / errors.length : 0,
      p99Error: p99,
      worstX,
      worstZ,
      cpuAtWorst,
      gpuAtWorst,
    };
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
