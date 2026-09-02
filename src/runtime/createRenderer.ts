import * as THREE from 'three';
import { installToneCurve } from '../scene/toneMapping';
import type { RuntimeDepthMode } from './RuntimeOptions';

export interface RuntimeRendererOptions {
  canvas: HTMLCanvasElement;
  depthMode: RuntimeDepthMode;
  depthModeWasRequested: boolean;
  /** Capture harnesses retain the default framebuffer; production does not. */
  preserveDrawingBuffer: boolean;
}

interface SortableRenderItem {
  groupOrder: number;
  renderOrder: number;
  material: { id: number };
  z: number;
  id: number;
}

/** Construct and configure the application's Three.js renderer. */
export function createRuntimeRenderer(
  options: RuntimeRendererOptions,
): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: options.canvas,
    antialias: true,
    alpha: false,
    // On, and it buys one thing: the sea stopping at the ship's skin. Her
    // interior marks a stencil where it is the nearest surface and the ocean
    // refuses to draw over the mark, which is what keeps waves out of the
    // captain's cabin — the sole is 0.15 m above the design waterline and the
    // hold's floor will be below it. See `scene/interiorStencil.ts`.
    //
    // The alternative was a cutout in the ocean's own shader, and it is the more
    // expensive one: `discard` is a static property of a shader, so it defeats
    // hidden-surface removal for the whole draw whether or not any fragment
    // discards. A stencil test is fixed-function and runs before shading.
    stencil: true,
    powerPreference: 'high-performance',
    // Only capture harnesses retain the default framebuffer. Ocean TAA uses its
    // own linear-HDR targets, so its disabled path keeps the original fast canvas.
    preserveDrawingBuffer: options.preserveDrawingBuffer,
    logarithmicDepthBuffer: options.depthMode === 'log',
    reversedDepthBuffer: options.depthMode === 'reversed',
  });

  if (options.depthMode !== 'conventional' || options.depthModeWasRequested) {
    // TERR-113 capability matrix: what was asked for, what the context actually
    // granted, and the raw facts a fallback decision needs. One line so a
    // harness capture can lift it verbatim into evidence.
    const gl = renderer.getContext();
    console.info(
      `[depth] requested=${options.depthMode}` +
        ` active=log:${renderer.capabilities.logarithmicDepthBuffer}` +
        `,reversed:${renderer.capabilities.reversedDepthBuffer}` +
        ` EXT_clip_control=${gl.getExtension('EXT_clip_control') !== null}` +
        ` depthBits=${gl.getParameter(gl.DEPTH_BITS)}`,
    );
  }

  if (renderer.capabilities.reversedDepthBuffer) {
    // three r185 bug (WebGLRenderList.sort): reversed-depth ordering is done by
    // a wholesale list.reverse() AFTER the painter sort, which flips renderOrder
    // semantics along with z. The sky dome's renderOrder -1000 ("draw first,
    // everything else covers me") became "draw last" and painted sky over the
    // finished frame — the whole scene was there, underneath. Three's own
    // scene.background path bypasses the render lists, so upstream never trips
    // on it. These comparators emit the exact OPPOSITE of the order we want so
    // that the trailing reverse() lands every list back in painter order, with
    // the z direction reversed-depth actually calls for (larger z = nearer).
    renderer.setOpaqueSort((a: SortableRenderItem, b: SortableRenderItem) =>
      // Desired: groupOrder/renderOrder/material asc, then z DESC (front-first).
      b.groupOrder - a.groupOrder ||
      b.renderOrder - a.renderOrder ||
      b.material.id - a.material.id ||
      a.z - b.z ||
      b.id - a.id,
    );
    renderer.setTransparentSort((a: SortableRenderItem, b: SortableRenderItem) =>
      // Desired: groupOrder/renderOrder asc, then z ASC (back-to-front).
      b.groupOrder - a.groupOrder ||
      b.renderOrder - a.renderOrder ||
      b.z - a.z ||
      b.id - a.id,
    );
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  installToneCurve(renderer);
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x0a1420, 1);
  // Direct shadows are explicit consumers in this scene: the directional map
  // contains vessel + displaced ocean, while the lantern's cube cameras see a
  // vessel-only layer. Both have live switches and a reproducible GPU bracket.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  return renderer;
}
