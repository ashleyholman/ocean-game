import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type HullSealAuditCapability = SimCapability<'renderer' | 'canvas'>;
import type { Schooner } from '../vessel/schooner/Schooner';
import { buildContactSheet, grab, post, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';

/**
 * A deliberately unflattering hull inspection.
 *
 * The production sea and sky are excellent at hiding a small opening: daylight
 * through a seam can be the same colour as a reflection, and water hides the
 * entire underside.  This pass renders the real ship meshes as neutral clay,
 * alone against white, from every boundary-sensitive direction.  It is evidence
 * for the topology test, not a replacement for it.
 */

export interface HullSealAuditOptions {
  renderWidth?: number;
  renderHeight?: number;
  frameScale?: number;
  publish?: boolean;
  publishFrames?: boolean;
  name?: string;
  preset?: HullSealAuditPreset;
}

interface AuditView {
  label: string;
  eye: [number, number, number];
  up?: [number, number, number];
  target?: [number, number, number];
  fov?: number;
}

export type HullSealAuditPreset = 'standard' | 'keel-bow-closeup' | 'underside-quarters';

const AUDIT_VIEWS: readonly AuditView[] = [
  { label: 'port broadside', eye: [15, 3.2, 0] },
  { label: 'starboard broadside', eye: [-15, 3.2, 0] },
  { label: 'bow-on', eye: [0, 2.8, 15] },
  { label: 'stern-on', eye: [0, 2.8, -15] },
  { label: 'bow underside', eye: [0, -9, 12] },
  { label: 'stern underside', eye: [0, -9, -12] },
  { label: 'deck / top', eye: [0, 18, 0.01], up: [0, 0, 1] },
  { label: 'keel / bottom', eye: [0, -18, 0.01], up: [0, 0, -1] },
];

const KEEL_BOW_CLOSEUP_VIEWS: readonly AuditView[] = [
  {
    label: 'bow end is at image bottom — keel / forefoot close-up',
    eye: [0, -10, 5.65],
    target: [0, 0.4, 5.65],
    up: [0, 0, -1],
    fov: 27,
  },
];

const UNDERSIDE_QUARTER_VIEWS: readonly AuditView[] = [
  { label: 'port bow quarter — 45° underside', eye: [10, -7, 10] },
  { label: 'starboard bow quarter — 45° underside', eye: [-10, -7, 10] },
  { label: 'port stern quarter — 45° underside', eye: [10, -7, -10] },
  { label: 'starboard stern quarter — 45° underside', eye: [-10, -7, -10] },
];

function presetViews(preset: HullSealAuditPreset): readonly AuditView[] {
  if (preset === 'keel-bow-closeup') return KEEL_BOW_CLOSEUP_VIEWS;
  if (preset === 'underside-quarters') return UNDERSIDE_QUARTER_VIEWS;
  return AUDIT_VIEWS;
}

function safeFrameName(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function captureHullSealAudit(
  sim: HullSealAuditCapability,
  ship: Schooner,
  options: HullSealAuditOptions = {},
): Promise<HTMLCanvasElement> {
  const renderer = sim.renderer;
  const preset = options.preset ?? 'standard';
  const views = presetViews(preset);
  const detailed = preset !== 'standard';
  const renderWidth = options.renderWidth ?? (detailed ? 1600 : 960);
  const renderHeight = options.renderHeight ?? (detailed ? 1100 : 720);
  const frameScale = options.frameScale ?? (detailed ? 1 : 0.5);
  const auditScene = new THREE.Scene();
  auditScene.background = new THREE.Color(0xf5f5f2);

  // Broad, nearly shadowless lighting makes white background visible through a
  // crack while retaining enough modelling to read which surface owns the edge.
  auditScene.add(new THREE.HemisphereLight(0xffffff, 0xb8c0c8, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(8, 12, 10);
  auditScene.add(key);
  const fill = new THREE.DirectionalLight(0xd9e8ff, 1.8);
  fill.position.set(-10, 5, -8);
  auditScene.add(fill);

  const camera = new THREE.PerspectiveCamera(38, renderWidth / renderHeight, 0.1, 100);
  const target = new THREE.Vector3(0, 2.35, 0);
  const clay = new THREE.MeshStandardMaterial({
    color: 0x7d8992,
    roughness: 0.82,
    metalness: 0,
    side: THREE.FrontSide,
  });

  const restoreParent = ship.group.parent;
  const restorePosition = ship.group.position.clone();
  const restoreQuaternion = ship.group.quaternion.clone();
  const restoreScale = ship.group.scale.clone();
  const restorePixelRatio = renderer.getPixelRatio();
  const restoreWidth = renderer.domElement.width / restorePixelRatio;
  const restoreHeight = renderer.domElement.height / restorePixelRatio;
  const restoreClear = renderer.getClearColor(new THREE.Color()).clone();
  const restoreClearAlpha = renderer.getClearAlpha();
  const restoreExposure = renderer.toneMappingExposure;
  const materials: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];

  ship.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    materials.push({ mesh: object, material: object.material });
    object.material = clay;
  });

  const frames: SheetFrame[] = [];
  try {
    auditScene.add(ship.group);
    ship.group.position.set(0, 0, 0);
    ship.group.quaternion.identity();
    ship.group.scale.set(1, 1, 1);
    ship.group.updateMatrixWorld(true);

    renderer.setPixelRatio(1);
    renderer.setSize(renderWidth, renderHeight, false);
    renderer.setClearColor(0xf5f5f2, 1);
    renderer.toneMappingExposure = 1.15;

    for (const view of views) {
      camera.position.set(...view.eye);
      camera.up.set(...(view.up ?? [0, 1, 0]));
      camera.fov = view.fov ?? 38;
      camera.updateProjectionMatrix();
      camera.lookAt(view.target ? new THREE.Vector3(...view.target) : target);
      camera.updateMatrixWorld(true);
      renderer.render(auditScene, camera);
      frames.push({ image: grab(sim.canvas, frameScale), label: view.label });
    }
  } finally {
    for (const item of materials) item.mesh.material = item.material;
    restoreParent?.add(ship.group);
    ship.group.position.copy(restorePosition);
    ship.group.quaternion.copy(restoreQuaternion);
    ship.group.scale.copy(restoreScale);
    ship.group.updateMatrixWorld(true);
    renderer.setPixelRatio(restorePixelRatio);
    renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    renderer.setClearColor(restoreClear, restoreClearAlpha);
    renderer.toneMappingExposure = restoreExposure;
    clay.dispose();
  }

  const title =
    preset === 'keel-bow-closeup'
      ? 'Bow forefoot / keel close-up — isolated clay render'
      : preset === 'underside-quarters'
        ? 'Hull underside quarters — isolated clay render'
        : 'Hull seal audit — isolated clay render';
  const sheet = buildContactSheet(frames, {
    columns: preset === 'keel-bow-closeup' ? 1 : preset === 'underside-quarters' ? 2 : 4,
    cellWidth: detailed ? 1600 : 420,
    title,
    subtitle:
      preset === 'standard'
        ? 'white background · front faces only · 8 boundary-sensitive views'
        : 'white background · front faces only · native frames 1600 × 1100',
  });

  if (options.publish !== false) {
    const name = options.name ?? 'hull-seal-audit';
    await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    if (options.publishFrames) {
      await Promise.all(
        frames.map(async (frame) =>
          post(`${name}/${safeFrameName(frame.label)}.png`, await toBlob(frame.image, 'image/png')),
        ),
      );
    }
  }
  return sheet;
}
