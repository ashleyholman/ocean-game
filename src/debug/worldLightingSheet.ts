import * as THREE from 'three';
import { findSeaState } from '../ocean/presets';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type WorldLightingSheetCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'lighting'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'scene'
  | 'seaStates'
  | 'setSeaState'
  | 'sky'
  | 'stepSimulation'
  | 'waves'
  | 'world'
  | 'worldLightingDiagnostics'
>;
import type { Schooner } from '../vessel/schooner/Schooner';
import { createWorldPbrMaterial } from '../scene/WorldPbrMaterial';
import {
  WORLD_DEBUG_VIEWS,
  getWorldDebugStops,
  getWorldDebugView,
  setWorldDebugStops,
  setWorldDebugView,
} from '../scene/WorldPbrMaterial';
import type { WorldDebugView } from '../scene/WorldPbrMaterial';
import {
  buildContactSheet,
  grab,
  post,
  settleSunElevation,
  toBlob,
} from './labCapture';
import type { SheetFrame } from './labCapture';

/**
 * The controlled lighting sheet: is it the source, the material, or the geometry?
 *
 * WHAT THIS IS FOR
 * ----------------
 * The palette sheet answers "which paint". The canonical contact sheet answers
 * "does she read". Neither can answer the question that has actually cost this
 * project its afternoons, which is *where in the chain* a wrong-looking hull
 * went wrong — because both of them vary the world and the hull together, and
 * a picture in which two things moved cannot tell you which one you are looking
 * at.
 *
 * So this sheet moves exactly one thing per row, under ONE frozen world
 * instant, and puts three objects of known reflectance next to her:
 *
 *   ship yaw     — camera and sun stand still, she turns. Anything that changes
 *                  here changes because a normal turned. If a plank brightens
 *                  when nothing about the light moved, that is the material.
 *   camera orbit — she and the sun stand still, the camera walks round. Under a
 *                  camera-independent source NOTHING diffuse may change here.
 *                  This is the row that catches the defect the whole world
 *                  lighting round exists to have removed, and it catches it in
 *                  a picture rather than in a checksum.
 *   sun side     — ship and camera turn together as one rigid pair, so her
 *                  aspect to the viewer is identical in all five cells and the
 *                  only difference is where the sun is. The classic
 *                  front/cross/back ladder with everything else nailed down.
 *
 * THE REFERENCE OBJECTS ARE THE INSTRUMENT
 * ----------------------------------------
 * Three spheres, 18% grey, 80% white and a near-black gloss, ride beside her at
 * a fixed offset in the camera's own frame — same screen position in every
 * single cell of the sheet. Nothing about their lighting depends on where they
 * are (the probe and the sun are global; they neither cast nor receive shadow),
 * so they are a pure readout of the light itself, with the hull's geometry and
 * paint taken out of the question:
 *
 *   grey and white together   the source's LEVEL and its neutrality. If the
 *                             80% ball is not comfortably brighter than the 18%
 *                             one, the exposure or the probe is wrong, not the
 *                             paint.
 *   dark gloss                the specular path alone. Its diffuse is near
 *                             nothing, so everything you see on it is the PMREM
 *                             plus the sun's highlight — which is precisely
 *                             what a tarred hull reads by.
 *
 * If the balls look right and the hull looks wrong, it is the hull. If the
 * balls look wrong, no amount of repainting was ever going to fix it.
 *
 * WHY DEAD CALM
 * -------------
 * A lighting sheet must not also be a seakeeping sheet. On a flat sea her
 * attitude is the same in all fifteen cells, so a plank that changes brightness
 * changed for a lighting reason. Her measured roll and pitch go in the notes
 * anyway, so the assumption is checkable rather than asserted.
 *
 *   node tools/capture-server.mjs evidence 5311
 *   open '…/?debug=schooner&capturePort=5311'
 *   schoonerViewer.lightingSheet()      the controlled sheet
 *   schoonerViewer.termSheet()          one pose, all seven term views
 */

/** Bow quarter: topsides, sheer and transom all read. Matches the palette sheet. */
const ASPECT_YAW = (48 * Math.PI) / 180;

/**
 * The frozen instant, as a solar elevation.
 *
 * 30° is where the sun is high enough that the shaded side is lit by the probe
 * rather than by nothing, and low enough that there is a real terminator on the
 * reference spheres to read. Both halves of the light are legible at once,
 * which is what a diagnostic wants and what neither noon nor dusk gives.
 */
const SUN_ELEVATION_DEG = 30;

const SEA_STATE = 'DEAD_CALM';
const DISTANCE = 30;

/** Frames stepped per cell, so every cell gets identical treatment. */
const CELL_SETTLE_STEPS = 45;

interface ReferenceSwatch {
  label: string;
  /** Linear reflectance. Set through `LinearSRGBColorSpace`, so it means this. */
  reflectance: number;
  roughness: number;
}

const REFERENCE_SWATCHES: readonly ReferenceSwatch[] = [
  { label: '18% grey', reflectance: 0.18, roughness: 0.85 },
  { label: '80% white', reflectance: 0.8, roughness: 0.85 },
  // Not a mirror: a dielectric at 0.08 roughness holds a recognisable but
  // blurred sky, which is the same regime the topsides are in at 0.52 and is
  // therefore the useful control for them. A true mirror would answer a
  // question about the PMREM's top mip that nothing in this scene asks.
  { label: 'dark gloss', reflectance: 0.02, roughness: 0.08 },
];

/** Metres in front of the camera, to its right, and above mean water. */
const RIG_RANGE = 13;
const RIG_LATERAL = 5.6;
const RIG_HEIGHT = 2.2;
const RIG_RADIUS = 0.85;
const RIG_SPACING = 1.95;

/**
 * The three reference spheres, and the arithmetic that keeps them in the same
 * corner of every frame.
 *
 * Position follows the camera; orientation is meaningless for a sphere. That
 * combination is what makes the row comparisons work — the balls occupy the
 * same pixels in all fifteen cells, so any difference between two cells is a
 * difference in the light and nothing else.
 */
class ReferenceRig {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.SphereGeometry(RIG_RADIUS, 48, 32);
  private readonly meshes: THREE.Mesh[] = [];
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();

  constructor() {
    this.group.name = 'world-lighting-reference-rig';
    REFERENCE_SWATCHES.forEach((swatch, index) => {
      const material = createWorldPbrMaterial({
        // Linear, explicitly. A hex literal would be read as sRGB and an "18%
        // grey" that is actually 2.7% reflectance is a reference object that
        // lies about the one number it exists to state.
        color: new THREE.Color().setRGB(
          swatch.reflectance,
          swatch.reflectance,
          swatch.reflectance,
          THREE.LinearSRGBColorSpace,
        ),
        roughness: swatch.roughness,
        metalness: 0,
        name: `reference:${swatch.label}`,
      });
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.name = `reference:${swatch.label}`;
      // Neither casts nor receives: a reference object measures the light that
      // arrives, and an occluded reference measures the occluder instead.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.index = index;
      this.meshes.push(mesh);
      this.group.add(mesh);
    });
  }

  /** Park the rig in the camera's frame, at a fixed height over the water. */
  place(camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) this.forward.set(0, 0, -1);
    this.forward.normalize();
    // forward x up, so it points along the camera's right in the ground plane.
    this.right.set(-this.forward.z, 0, this.forward.x);

    this.centre
      .copy(camera.position)
      .addScaledVector(this.forward, RIG_RANGE)
      .addScaledVector(this.right, RIG_LATERAL);
    // Height is absolute rather than camera-relative: the one way these could
    // stop being a readout is by sinking into the sea, and the sea is at zero.
    this.centre.y = RIG_HEIGHT;

    this.meshes.forEach((mesh, index) => {
      mesh.position
        .copy(this.centre)
        .addScaledVector(this.right, (index - 1) * RIG_SPACING);
    });
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.geometry.dispose();
    for (const mesh of this.meshes) (mesh.material as THREE.Material).dispose();
    this.group.clear();
  }
}

export interface WorldLightingSheetOptions {
  name?: string;
  publish?: boolean;
  /**
   * Photograph every cell through one term view instead of the beauty path.
   *
   * The two halves of the design's verification section meeting in one place:
   * a controlled row is worth much more when the thing being held constant is a
   * single named term. `lightingSheet({ view: 'indirect-diffuse' })` under a
   * camera orbit is the sharpest form of the camera-invariance question there
   * is — that row must be flat.
   */
  view?: WorldDebugView;
  /** Stops of gain, `linear` view only. Exactly invertible; printed on the sheet. */
  stops?: number;
}

interface Cell {
  row: string;
  label: string;
  /** Absolute camera bearing, radians. */
  azimuth: number;
  yaw: number;
}

/**
 * Hold the world still, and give it back afterwards.
 *
 * Both clocks, not just the world's: `sky.timeRate` drives the cloud field, and
 * a sheet whose fifteen cells each saw a different cloud is not taken at one
 * instant however frozen the sun is. That is the difference between this sheet
 * and the two that came before it.
 */
function freezeWorld(sim: WorldLightingSheetCapability): () => void {
  const clock = sim.world.state;
  const restoreRate = clock.worldSecondsPerRealSecond;
  const restoreInstant = clock.worldInstantUtcSeconds;
  const restoreSkyRate = sim.sky.timeRate;
  const restoreSea = sim.seaStates.state;

  clock.worldSecondsPerRealSecond = 0;
  sim.sky.timeRate = 0;

  return () => {
    clock.worldSecondsPerRealSecond = restoreRate;
    clock.worldInstantUtcSeconds = restoreInstant;
    sim.sky.timeRate = restoreSkyRate;
    sim.setSeaState(restoreSea, 0);
    sim.refreshLighting();
  };
}

/** Pin the framebuffer for the capture; re-asserted before every grab. */
function framePinner(sim: WorldLightingSheetCapability, width: number, height: number): () => void {
  return () => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(width, height, false);
    const aspect = width / height;
    sim.cameras.camera.aspect = aspect;
    sim.cameras.camera.updateProjectionMatrix();
    sim.cameras.cinematic.setViewport(aspect);
  };
}

/** The sun's bearing expressed as the camera azimuth that puts it behind you. */
function frontAzimuth(sim: WorldLightingSheetCapability): number {
  const sun = sim.lighting.sunDirection;
  const horizontal = Math.hypot(sun.x, sun.z) || 1e-6;
  return Math.atan2(sun.x / horizontal, -sun.z / horizontal);
}

function viewLabel(view: WorldDebugView): string {
  return WORLD_DEBUG_VIEWS.find((entry) => entry.view === view)?.label ?? view;
}

function viewMeaning(view: WorldDebugView): string {
  return WORLD_DEBUG_VIEWS.find((entry) => entry.view === view)?.meaning ?? '';
}

/**
 * Drive one cell to its final state and photograph it.
 *
 * The order is load-bearing. The settle is what lets the camera controller
 * actually reach the requested bearing; the snap that follows re-derives her
 * attitude from the sea as it is at that moment; the rig is placed from the
 * camera's finished pose; and `refreshWorldLighting` runs last, because the
 * capture is one unbroken synchronous task and the probe's ordinary async
 * readback can never resolve inside it — without this every cell wears whatever
 * light happened to be published before the sheet began. See
 * `WorldLighting.refreshNow`.
 */
function shoot(
  sim: WorldLightingSheetCapability,
  ship: Schooner,
  rig: ReferenceRig,
  cell: Cell,
  pin: () => void,
): void {
  ship.yaw = cell.yaw;
  sim.cameras.cinematic.setDistance(DISTANCE);
  for (let i = 0; i < CELL_SETTLE_STEPS; i++) {
    // Re-asserted every step: the controller's own inertia would otherwise walk
    // the camera off the authored bearing during the settle.
    sim.cameras.cinematic.setAzimuth(cell.azimuth);
    sim.stepSimulation(1 / 60);
  }
  ship.body.reset();
  ship.snapToSurface(sim.waves, 0, 0);
  rig.place(sim.cameras.camera);
  sim.refreshWorldLighting();
  pin();
  sim.renderFrame();
}

function cellNote(sim: WorldLightingSheetCapability, ship: Schooner, cell: Cell): string {
  const d = sim.worldLightingDiagnostics();
  const deg = (radians: number): string => (((radians * 180) / Math.PI) % 360).toFixed(1);
  return (
    `${cell.row} | ${cell.label} | az ${deg(cell.azimuth)}deg yaw ${deg(cell.yaw)}deg` +
    ` | roll ${((ship.body.roll * 180) / Math.PI).toFixed(2)}deg` +
    ` pitch ${((ship.body.pitch * 180) / Math.PI).toFixed(2)}deg` +
    ` | gen ${d.generation} probe up ${d.up.toFixed(4)} side ${d.side.toFixed(4)}` +
    ` down ${d.down.toFixed(4)} | sunI ${d.sun.toFixed(4)} exposure ${d.exposure.toFixed(4)}`
  );
}

/**
 * The controlled sheet: three rows, five cells, one instant.
 */
export async function captureWorldLightingSheet(
  sim: WorldLightingSheetCapability,
  ship: Schooner,
  options: WorldLightingSheetOptions = {},
): Promise<HTMLCanvasElement> {
  const view = options.view ?? 'off';
  const renderWidth = 1280;
  const renderHeight = 720;

  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const restoreView = getWorldDebugView();
  const restoreStops = getWorldDebugStops();

  const pin = framePinner(sim, renderWidth, renderHeight);
  pin();
  const thaw = freezeWorld(sim);

  const rig = new ReferenceRig();
  sim.scene.add(rig.group);

  const frames: SheetFrame[] = [];
  const notes: string[] = [];

  try {
    sim.setSeaState(findSeaState(SEA_STATE), 0);
    const elevationDeg = settleSunElevation(sim, SUN_ELEVATION_DEG);
    const front = frontAzimuth(sim);

    // Cross-lit is the base for the two invariance rows: half of her is in the
    // probe's light and half in the sun's, so both halves of the system are on
    // screen at once and either one going wrong is visible.
    const baseAzimuth = front + Math.PI / 2;
    const beamOn = (azimuth: number): number => Math.PI / 2 - azimuth + ASPECT_YAW;

    const sweep = [0, 72, 144, 216, 288].map((d) => (d * Math.PI) / 180);
    const cells: Cell[] = [];

    for (const turn of sweep) {
      cells.push({
        row: 'ship yaw',
        label: `yaw +${Math.round((turn * 180) / Math.PI)}°`,
        azimuth: baseAzimuth,
        yaw: beamOn(baseAzimuth) + turn,
      });
    }
    for (const turn of sweep) {
      cells.push({
        row: 'camera orbit',
        label: `cam +${Math.round((turn * 180) / Math.PI)}°`,
        azimuth: baseAzimuth + turn,
        yaw: beamOn(baseAzimuth),
      });
    }
    const sunSides: Array<[string, number]> = [
      ['sun front', 0],
      ['sun front-quarter', Math.PI / 4],
      ['sun cross', Math.PI / 2],
      ['sun back-quarter', (3 * Math.PI) / 4],
      ['sun back', Math.PI],
    ];
    for (const [label, delta] of sunSides) {
      const azimuth = front + delta;
      // Camera and ship turn together, so her aspect to the viewer is identical
      // in all five and the sun is the only thing that moved.
      cells.push({ row: 'sun side', label, azimuth, yaw: beamOn(azimuth) });
    }

    setWorldDebugView(view);
    setWorldDebugStops(options.stops ?? 0);

    notes.push(
      `world lighting sheet | view ${viewLabel(view)} (${viewMeaning(view)})` +
        ` | sun ${elevationDeg.toFixed(2)}deg | sea ${SEA_STATE} | distance ${DISTANCE} m` +
        ` | world clock and sky clock both frozen`,
    );
    notes.push(
      'reference spheres, camera-left to camera-right: ' +
        REFERENCE_SWATCHES.map(
          (s) => `${s.label} (linear ${s.reflectance.toFixed(2)}, roughness ${s.roughness})`,
        ).join(' | ') +
        ' — no shadow cast or received',
    );
    notes.push(
      'the probe and exposure columns below must be IDENTICAL in all 15 rows;' +
        ' anything else means the world moved during the sheet',
    );

    for (const cell of cells) {
      shoot(sim, ship, rig, cell, pin);
      frames.push({ image: grab(sim.canvas, 0.5), label: `${cell.row} · ${cell.label}` });
      notes.push(cellNote(sim, ship, cell));
    }
  } finally {
    setWorldDebugView(restoreView);
    setWorldDebugStops(restoreStops);
    sim.scene.remove(rig.group);
    rig.dispose();
    thaw();
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
  }

  const sheet = buildContactSheet(frames, {
    columns: 5,
    cellWidth: 460,
    title:
      view === 'off'
        ? 'World lighting — controlled sheet'
        : `World lighting — controlled sheet · ${viewLabel(view)}`,
    subtitle:
      'One frozen instant, flat sea, 18% / 80% / dark-gloss references beside her. ' +
      'Row 1 turns only the ship. Row 2 turns only the camera — her lit side must stay where ' +
      'the sun put it rather than follow you. Row 3 turns both together, so only the sun moves.',
  });

  if (options.publish !== false) {
    const name = options.name ?? (view === 'off' ? 'world-lighting-sheet' : `world-lighting-sheet-${view}`);
    const ok = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    if (!ok) {
      const link = document.createElement('a');
      link.href = sheet.toDataURL('image/png');
      link.download = `${name}.png`;
      link.click();
    }
    await post(`${name}.txt`, new Blob([notes.join('\n')], { type: 'text/plain' }));
  }

  return sheet;
}

export interface WorldTermSheetOptions {
  name?: string;
  publish?: boolean;
  /** Stops of gain on the `linear` cell only. */
  stops?: number;
  /** Which sun relationship to photograph the decomposition under. */
  sunSide?: 'front' | 'cross' | 'back';
}

/**
 * One pose, one instant, every term.
 *
 * The companion to the selector in the graphics panel, and the reason the
 * selector is worth having: the beauty frame and the four accumulators that add
 * up to it, side by side at the same exposure, plus the three raw views that
 * say what the geometry, the paint and the curve each contributed. A hull that
 * reads wrong here reads wrong in exactly one of these eight cells, and that
 * cell has an owner.
 */
export async function captureWorldTermSheet(
  sim: WorldLightingSheetCapability,
  ship: Schooner,
  options: WorldTermSheetOptions = {},
): Promise<HTMLCanvasElement> {
  const renderWidth = 1280;
  const renderHeight = 720;

  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const restoreView = getWorldDebugView();
  const restoreStops = getWorldDebugStops();

  const pin = framePinner(sim, renderWidth, renderHeight);
  pin();
  const thaw = freezeWorld(sim);

  const rig = new ReferenceRig();
  sim.scene.add(rig.group);

  const frames: SheetFrame[] = [];
  const notes: string[] = [];
  const stops = options.stops ?? 0;

  try {
    sim.setSeaState(findSeaState(SEA_STATE), 0);
    const elevationDeg = settleSunElevation(sim, SUN_ELEVATION_DEG);
    const front = frontAzimuth(sim);
    const side = options.sunSide ?? 'cross';
    const azimuth =
      side === 'front' ? front : side === 'back' ? front + Math.PI : front + Math.PI / 2;
    const cell: Cell = {
      row: 'terms',
      label: `sun ${side}`,
      azimuth,
      yaw: Math.PI / 2 - azimuth + ASPECT_YAW,
    };

    setWorldDebugStops(stops);
    notes.push(
      `world term sheet | sun ${elevationDeg.toFixed(2)}deg ${side} | sea ${SEA_STATE}` +
        ` | distance ${DISTANCE} m | linear view stops ${stops} (x${Math.pow(2, stops)})`,
    );
    notes.push(
      'reference spheres, camera-left to camera-right: ' +
        REFERENCE_SWATCHES.map(
          (s) => `${s.label} (linear ${s.reflectance.toFixed(2)}, roughness ${s.roughness})`,
        ).join(' | '),
    );

    for (const entry of WORLD_DEBUG_VIEWS) {
      setWorldDebugView(entry.view);
      // Re-shot rather than re-rendered from one settle: switching the view
      // recompiles the world materials on the off/on transition, and a frame
      // grabbed while a program is still linking is a frame of whatever three
      // substituted in the meantime.
      shoot(sim, ship, rig, cell, pin);
      frames.push({ image: grab(sim.canvas, 0.5), label: entry.label });
      notes.push(`${entry.label} — ${entry.meaning}`);
    }
    notes.push(cellNote(sim, ship, cell));
  } finally {
    setWorldDebugView(restoreView);
    setWorldDebugStops(restoreStops);
    sim.scene.remove(rig.group);
    rig.dispose();
    thaw();
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
  }

  const sheet = buildContactSheet(frames, {
    columns: 4,
    cellWidth: 460,
    title: 'World lighting — term decomposition',
    subtitle:
      'One pose, one instant. Views 1-4 are the four ReflectedLight accumulators through the ' +
      'ordinary exposure and tone curve, so they are comparable with the beauty frame; ' +
      'views 5-7 are written past the curve, so code/255 is the number.',
  });

  if (options.publish !== false) {
    const name = options.name ?? 'world-term-sheet';
    const ok = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    if (!ok) {
      const link = document.createElement('a');
      link.href = sheet.toDataURL('image/png');
      link.download = `${name}.png`;
      link.click();
    }
    await post(`${name}.txt`, new Blob([notes.join('\n')], { type: 'text/plain' }));
  }

  return sheet;
}
