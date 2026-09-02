import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type RigLayoutCapability = SimCapability<'renderer' | 'scene'>;
import type { Schooner } from '../vessel/schooner/Schooner';
import { buildContactSheet, grab, post, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';

/**
 * The rig layout sheet — orthographic, flat, and deliberately ugly.
 *
 * A sail plan is judged the way a shipwright's drawing is judged: dead
 * broadside, no perspective, no lighting, no sea. The canonical contact sheet
 * cannot answer "does this sail plan read as a topsail schooner" because
 * everything it is good at — real light, real water, a real camera — is noise
 * for that question. Two sails a metre apart in z look adjacent in perspective,
 * and a sail in shadow looks like a different material.
 *
 * So this throws all of it away:
 *
 * - **Orthographic.** Overlap in the drawing is overlap in fact.
 * - **Flat unlit colour.** Nothing is dark because of where the sun is.
 * - **Translucent cloth.** Sails that cross each other read as a darker patch,
 *   which turns "do these intersect?" from a judgement into an observation.
 * - **No ocean, no sky.** A flat ground so the silhouette is the whole picture.
 *
 * It restores everything it touches. Debug only; nothing here ships.
 */

export interface RigLayoutOptions {
  name?: string;
  publish?: boolean;
  renderWidth?: number;
  renderHeight?: number;
  cellWidth?: number;
  /** Height of the orthographic frame, metres. */
  frameHeight?: number;
  /** Centre of the frame above the baseline, metres. */
  frameCentreY?: number;
}

/** Flat colours, chosen so every part is separable at a glance. */
const FLAT: Record<string, { color: number; opacity: number }> = {
  'rig:sailcloth': { color: 0xd8cfb4, opacity: 0.55 },
  'rig:spar': { color: 0xb07a32, opacity: 1 },
  'rig:rope': { color: 0x24211d, opacity: 1 },
  'rig:ironwork': { color: 0x4a4a4e, opacity: 1 },
};

const HULL_FLAT = 0x2f3338;
const HULL_LIGHT = 0x9aa0a6;

function flatFor(name: string): { color: number; opacity: number } {
  const rig = FLAT[name];
  if (rig) return rig;
  if (name === 'ship:deck' || name === 'ship:inboardBulwark') {
    return { color: HULL_LIGHT, opacity: 1 };
  }
  return { color: HULL_FLAT, opacity: 1 };
}

interface Swapped {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  flat: THREE.MeshBasicMaterial;
}

/**
 * Views. Broadside is the one that matters — it is the drawing every sail plan
 * in every reference is drawn in — and the others exist to catch what a single
 * profile hides, like two headsails that look separated abeam because one is
 * simply further outboard.
 */
const VIEWS: readonly { label: string; dir: THREE.Vector3 }[] = [
  { label: 'broadside (port)', dir: new THREE.Vector3(1, 0, 0) },
  { label: 'broadside (starboard)', dir: new THREE.Vector3(-1, 0, 0) },
  { label: 'bow, 30° off', dir: new THREE.Vector3(0.5, 0, 0.87) },
  { label: 'plan, from above', dir: new THREE.Vector3(0, 1, 0) },
];

export async function captureRigLayout(
  sim: RigLayoutCapability,
  ship: Schooner,
  options: RigLayoutOptions = {},
): Promise<HTMLCanvasElement> {
  const renderWidth = options.renderWidth ?? 1400;
  const renderHeight = options.renderHeight ?? 1100;
  const frameHeight = options.frameHeight ?? 27;
  const frameCentreY = options.frameCentreY ?? 11.5;

  const renderer = sim.renderer;
  const scene = sim.scene;

  // --- take the world off the stage ----------------------------------------
  const hidden: THREE.Object3D[] = [];
  for (const child of scene.children) {
    if (child === ship.group) continue;
    if (child.visible) {
      hidden.push(child);
      child.visible = false;
    }
  }
  const restoreBackground = scene.background;
  const restoreFog = scene.fog;
  const restoreEnvironment = scene.environment;
  scene.background = new THREE.Color(0xe8ebee);
  scene.fog = null;
  scene.environment = null;

  // --- flatten every material ----------------------------------------------
  const swapped: Swapped[] = [];
  ship.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const spec = flatFor(object.name);
    const flat = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: spec.opacity < 1,
      opacity: spec.opacity,
      // Translucent cloth must not occlude the cloth behind it, or an overlap
      // reads as a single sail rather than as two.
      depthWrite: spec.opacity >= 1,
      side: THREE.DoubleSide,
    });
    swapped.push({ mesh: object, original: object.material, flat });
    object.material = flat;
  });

  // --- an orthographic camera on the ship's own frame -----------------------
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
  const aspect = renderWidth / renderHeight;
  camera.top = frameHeight / 2;
  camera.bottom = -frameHeight / 2;
  camera.left = (-frameHeight * aspect) / 2;
  camera.right = (frameHeight * aspect) / 2;
  camera.updateProjectionMatrix();

  const restorePixelRatio = renderer.getPixelRatio();
  const restoreWidth = renderer.domElement.width / restorePixelRatio;
  const restoreHeight = renderer.domElement.height / restorePixelRatio;
  renderer.setPixelRatio(1);
  renderer.setSize(renderWidth, renderHeight, false);

  /**
   * Take the tone curve off as well.
   *
   * This sheet calls itself flat and unlit, and it was neither: `MeshBasicMaterial`
   * still goes through the renderer's tone mapping and exposure, so the drawing's
   * brightness tracked whatever the scene's exposure happened to be at the moment
   * of capture. Two sheets taken minutes apart, with nothing changed but the
   * world clock, came out visibly different — which makes a before/after pair
   * from this tool useless for anything but layout, and quietly invites a palette
   * verdict that is really a verdict on the time of day.
   *
   * A drawing whose ink changes shade depending on when you print it is not a
   * drawing. Pinned to `NoToneMapping` at exposure 1, so `FLAT` above means
   * exactly what it says and two sheets are comparable pixel for pixel.
   */
  const restoreToneMapping = renderer.toneMapping;
  const restoreExposure = renderer.toneMappingExposure;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;

  // Where the ship's own origin has ended up. The layout is a statement about
  // ship-local geometry, so the camera is aimed at the hull, not at the world.
  ship.group.updateMatrixWorld(true);
  const origin = new THREE.Vector3().setFromMatrixPosition(ship.group.matrixWorld);

  const frames: SheetFrame[] = [];
  for (const view of VIEWS) {
    const target = origin.clone().add(new THREE.Vector3(0, frameCentreY, 0));
    camera.position.copy(target).add(view.dir.clone().multiplyScalar(120));
    // A plan view looking straight down has no up vector in y; give it the
    // ship's own fore-and-aft axis so the drawing is not arbitrarily rotated.
    camera.up.set(0, 1, 0);
    if (Math.abs(view.dir.y) > 0.5) camera.up.set(0, 0, 1);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);

    renderer.render(scene, camera);
    frames.push({ image: grab(renderer.domElement, 0.72), label: view.label });
  }

  const sheet = buildContactSheet(frames, {
    columns: 2,
    cellWidth: options.cellWidth ?? 900,
    title: 'Rig layout — orthographic, flat, unlit',
    subtitle: `${ship.stats.drawCalls} draw calls · ${ship.stats.triangles.toLocaleString()} triangles · cloth at 55% so overlaps read as overlaps`,
  });

  // --- put everything back --------------------------------------------------
  for (const s of swapped) {
    s.mesh.material = s.original;
    s.flat.dispose();
  }
  scene.background = restoreBackground;
  scene.fog = restoreFog;
  scene.environment = restoreEnvironment;
  for (const child of hidden) child.visible = true;
  renderer.toneMapping = restoreToneMapping;
  renderer.toneMappingExposure = restoreExposure;
  renderer.setPixelRatio(restorePixelRatio);
  renderer.setSize(restoreWidth, restoreHeight, false);

  if (options.publish !== false) {
    await post(options.name ?? 'ship-rig-layout.png', await toBlob(sheet, 'image/png'));
  }
  return sheet;
}
