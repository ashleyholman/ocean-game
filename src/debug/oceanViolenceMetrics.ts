import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type OceanViolenceMetricsCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'ocean'
  | 'renderFrame'
  | 'renderer'
  | 'scene'
  | 'setFoamStrength'
  | 'stepSimulation'
>;

/**
 * Measurements for the ocean-violence round.
 *
 * The round exists because a sea with violent physical parameters does not look
 * violent, so the one thing these metrics must not do is agree with the
 * parameters. Everything here is measured off the rendered frame.
 *
 * WHY NOT JUST COUNT WHITE PIXELS
 * -------------------------------
 * Because the sun does. At a 48-degree sun, five to ten percent of the water in
 * a Southern Ocean frame is already bright and desaturated with the whitewater
 * layer switched off entirely — that is specular glitter, and any threshold
 * that calls a bright desaturated pixel "foam" counts all of it. A whitecap
 * calibration built on that number is calibrating against the sun.
 *
 * So foam is measured by *difference*: render the frame with the whitewater
 * layer on and again with it off, and attribute to foam only what changed. The
 * glitter floor is reported alongside as `brightOffPct`, because knowing how
 * large the false-positive term is matters more than any single coverage
 * figure.
 *
 * Area is not the goal either. Six percent coverage delivered as isolated
 * flecks and the same six percent delivered as connected crest lines are the
 * difference between a sea that reads as choppy and one that reads as breaking,
 * so the foam mask is also segmented into connected components and reported by
 * how much of its area lives in large ones.
 */

/** Luminance threshold at which a foam-driven change counts as visible. */
const VISIBLE_DELTA = 0.05;
/** A foam component this many pixels or larger reads as structure, not speckle. */
const COHERENT_PX = 200;

export interface WhitewaterMetrics {
  /** Pixels the ocean drew, from the silhouette pass. */
  waterPixels: number;
  /** Share of the frame that is water. Context for every figure below. */
  waterFramePct: number;
  /** Water pixels the whitewater layer visibly changes. */
  foamAreaPct: number;
  /** Mean absolute luminance change over water, foam on minus foam off. */
  foamMeanDelta: number;
  /** Bright desaturated water with foam on. */
  brightOnPct: number;
  /** The same count with foam off: the specular-glitter false-positive floor. */
  brightOffPct: number;
  /** Connected components in the foam mask. */
  foamPatches: number;
  meanPatchPx: number;
  largestPatchPx: number;
  /** Share of foam area in components of at least COHERENT_PX pixels. */
  coherentPct: number;
}

export interface HorizonMetrics {
  /** Frame row of the flat-sea horizon, from the camera's own projection. */
  horizonRow: number;
  /** Columns whose nearest water silhouette rises above that row. */
  occludedColumnsPct: number;
  /** Mean and worst rise of the water silhouette above the flat horizon. */
  meanRiseDeg: number;
  maxRiseDeg: number;
}

export interface ViolenceMetrics extends WhitewaterMetrics, HorizonMetrics {
  width: number;
  height: number;
}

interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function luminance(d: Uint8ClampedArray, i: number): number {
  return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
}

/** Bright and colourless: the classic "is it foam?" test, false positives and all. */
function isBrightDesaturated(d: Uint8ClampedArray, i: number): boolean {
  const r = d[i] / 255;
  const g = d[i + 1] / 255;
  const b = d[i + 2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max > 0 ? (max - min) / max : 0;
  return luminance(d, i) > 0.62 && saturation < 0.22;
}

/**
 * Grab the drawing buffer.
 *
 * Must run in the same task as the render that filled it: without
 * `preserveDrawingBuffer` the browser is entitled to have cleared it by the
 * time any later task looks.
 */
function grabFrame(sim: OceanViolenceMetricsCapability, scale: number): Frame {
  const source = sim.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: canvas.width, height: canvas.height };
}

function renderAndGrab(sim: OceanViolenceMetricsCapability, scale: number): Frame {
  sim.stepSimulation(0);
  sim.renderFrame();
  return grabFrame(sim, scale);
}

/**
 * Render the ocean alone, white, on black.
 *
 * The debug view makes the ocean white but says nothing about the sky, and a
 * lit sky dome is brighter than the threshold — a mask built on "is this pixel
 * bright" then contains the whole frame, reports the water as 99.8% of it, and
 * cheerfully concludes that near crests occlude every column of the horizon.
 * So the rest of the scene is switched off for the one frame and the clear
 * colour is forced to black: the silhouette then has exactly two values.
 */
function grabSilhouette(sim: OceanViolenceMetricsCapability, scale: number): Frame {
  const hidden: THREE.Object3D[] = [];
  for (const child of sim.scene.children) {
    if (child === sim.ocean.mesh || !child.visible) continue;
    child.visible = false;
    hidden.push(child);
  }
  const previousClear = new THREE.Color();
  sim.renderer.getClearColor(previousClear);
  const previousAlpha = sim.renderer.getClearAlpha();
  sim.renderer.setClearColor(0x000000, 1);
  sim.ocean.setDebugView(1);
  try {
    return renderAndGrab(sim, scale);
  } finally {
    sim.ocean.setDebugView(0);
    sim.renderer.setClearColor(previousClear, previousAlpha);
    for (const child of hidden) child.visible = true;
  }
}

/**
 * Connected-component sizes of a boolean mask, four-connected.
 *
 * An explicit stack rather than recursion: a foam sheet across a 1280-wide
 * frame is tens of thousands of pixels deep and would exhaust the call stack.
 */
function componentSizes(mask: Uint8Array, width: number, height: number): number[] {
  const seen = new Uint8Array(mask.length);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      size++;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && mask[index - 1] && !seen[index - 1]) { seen[index - 1] = 1; stack.push(index - 1); }
      if (x + 1 < width && mask[index + 1] && !seen[index + 1]) { seen[index + 1] = 1; stack.push(index + 1); }
      if (y > 0 && mask[index - width] && !seen[index - width]) { seen[index - width] = 1; stack.push(index - width); }
      if (y + 1 < height && mask[index + width] && !seen[index + width]) { seen[index + width] = 1; stack.push(index + width); }
    }
    sizes.push(size);
  }
  return sizes;
}

/**
 * Frame row of the horizon over a flat sea.
 *
 * Projected from the live camera rather than assumed to be the frame centre,
 * because every diagnostic view in this round looks at a different elevation
 * and the whole occlusion question is "how far above this line does near water
 * reach". Earth curvature is ignored: it puts the true horizon 0.1 degrees low
 * at an 11 m eye, which is a fifth of a pixel.
 */
function flatHorizonRow(sim: OceanViolenceMetricsCapability, height: number): number {
  const camera = sim.cameras.camera as THREE.PerspectiveCamera;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-12) return height * 0.5;
  forward.normalize();
  const far = new THREE.Vector3(
    camera.position.x + forward.x * 1e6,
    0,
    camera.position.z + forward.z * 1e6,
  );
  const ndc = far.project(camera);
  return ((1 - ndc.y) * 0.5) * height;
}

/** Degrees of pitch per frame row at the centre of the view. */
function degreesPerRow(sim: OceanViolenceMetricsCapability, height: number): number {
  const camera = sim.cameras.camera as THREE.PerspectiveCamera;
  const fov = camera.isPerspectiveCamera ? camera.fov : 45;
  return fov / height;
}

export interface ViolenceMetricOptions {
  /** Fraction of the drawing buffer to measure at. Halving is plenty. */
  scale?: number;
  /**
   * Render size to pin for the measurement.
   *
   * Not optional in spirit. The drawing buffer follows the window, a hidden or
   * backgrounded tab collapses it to a couple of pixels, and every figure below
   * is then computed from a 1x1 frame that still reports itself as 100% water.
   * Pinning also makes two runs comparable, which is the whole point of a
   * measurement.
   */
  width?: number;
  height?: number;
}

/**
 * Measure the current view.
 *
 * Leaves the ocean exactly as it found it — debug view, foam strength — so a
 * caller can measure between capture frames without the measurement becoming
 * part of the evidence.
 */
export function measureViolence(
  sim: OceanViolenceMetricsCapability,
  options: ViolenceMetricOptions = {},
): ViolenceMetrics {
  const scale = options.scale ?? 0.5;
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const restoreDebug = sim.ocean.debugView;
  const restoreFoam = sim.ocean.material.uniforms.uFoamStrength.value as number;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreSize = new THREE.Vector2();
  sim.renderer.getSize(restoreSize);

  const pin = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(width, height, false);
    sim.cameras.setViewport(width, height);
  };
  pin();

  try {
    // 1. Exact water mask, straight out of the shader.
    const silhouette = grabSilhouette(sim, scale);

    const { width, height } = silhouette;
    const count = width * height;
    const water = new Uint8Array(count);
    let waterPixels = 0;
    for (let i = 0; i < count; i++) {
      // Two values only, white on black: anything above half is ocean, even
      // after the canvas copy and its resampling.
      if (silhouette.data[i * 4] > 128) {
        water[i] = 1;
        waterPixels++;
      }
    }

    // 2. The whitewater layer's actual contribution, by difference.
    sim.ocean.setDebugView(0);
    sim.setFoamStrength(restoreFoam > 0 ? restoreFoam : 1);
    const on = renderAndGrab(sim, scale);
    sim.setFoamStrength(0);
    const off = renderAndGrab(sim, scale);
    sim.setFoamStrength(restoreFoam);

    const foamMask = new Uint8Array(count);
    let visible = 0;
    let deltaSum = 0;
    let brightOn = 0;
    let brightOff = 0;
    for (let i = 0; i < count; i++) {
      if (!water[i]) continue;
      const p = i * 4;
      const delta = Math.abs(luminance(on.data, p) - luminance(off.data, p));
      deltaSum += delta;
      if (delta > VISIBLE_DELTA) {
        foamMask[i] = 1;
        visible++;
      }
      if (isBrightDesaturated(on.data, p)) brightOn++;
      if (isBrightDesaturated(off.data, p)) brightOff++;
    }

    const sizes = componentSizes(foamMask, width, height);
    const foamArea = sizes.reduce((a, b) => a + b, 0);
    const coherent = sizes.filter((s) => s >= COHERENT_PX).reduce((a, b) => a + b, 0);
    const safeWater = Math.max(waterPixels, 1);

    // 3. How much of the far sea nearer water is standing in front of.
    const horizonRow = flatHorizonRow(sim, height);
    const perRow = degreesPerRow(sim, height);
    let columnsWithWater = 0;
    let occluded = 0;
    let riseSum = 0;
    let maxRise = 0;
    for (let x = 0; x < width; x++) {
      let top = -1;
      for (let y = 0; y < height; y++) {
        if (water[y * width + x]) { top = y; break; }
      }
      if (top < 0) continue;
      columnsWithWater++;
      const rise = (horizonRow - top) * perRow;
      if (rise > 0) {
        occluded++;
        riseSum += rise;
        if (rise > maxRise) maxRise = rise;
      }
    }

    const round = (v: number, places = 2): number => Number(v.toFixed(places));
    return {
      width,
      height,
      waterPixels,
      waterFramePct: round((100 * waterPixels) / count),
      foamAreaPct: round((100 * visible) / safeWater),
      foamMeanDelta: round(deltaSum / safeWater, 4),
      brightOnPct: round((100 * brightOn) / safeWater),
      brightOffPct: round((100 * brightOff) / safeWater),
      foamPatches: sizes.length,
      meanPatchPx: round(sizes.length ? foamArea / sizes.length : 0, 1),
      largestPatchPx: sizes.length ? Math.max(...sizes) : 0,
      coherentPct: round(foamArea ? (100 * coherent) / foamArea : 0),
      horizonRow: round(horizonRow, 1),
      occludedColumnsPct: round(columnsWithWater ? (100 * occluded) / columnsWithWater : 0),
      meanRiseDeg: round(occluded ? riseSum / occluded : 0, 3),
      maxRiseDeg: round(maxRise, 3),
    };
  } finally {
    sim.ocean.setDebugView(restoreDebug);
    sim.setFoamStrength(restoreFoam);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreSize.x, 1), Math.max(restoreSize.y, 1), false);
    sim.cameras.setViewport(Math.max(restoreSize.x, 1), Math.max(restoreSize.y, 1));
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}

/** One line per metric, for a report or a capture-server text artefact. */
export function formatViolenceMetrics(label: string, m: ViolenceMetrics): string {
  return [
    `${label}`,
    `  frame            ${m.width}x${m.height}, water ${m.waterFramePct}% of frame`,
    `  foam area        ${m.foamAreaPct}% of water   (mean dL ${m.foamMeanDelta})`,
    `  bright+desat     ${m.brightOnPct}% foam on / ${m.brightOffPct}% foam off (glitter floor)`,
    `  foam structure   ${m.foamPatches} patches, mean ${m.meanPatchPx}px, largest ${m.largestPatchPx}px`,
    `  coherent share   ${m.coherentPct}% of foam area in patches >= ${COHERENT_PX}px`,
    `  horizon row      ${m.horizonRow}`,
    `  crest occlusion  ${m.occludedColumnsPct}% of columns, mean ${m.meanRiseDeg} deg, max ${m.maxRiseDeg} deg`,
  ].join('\n');
}
