import * as THREE from 'three';
import { DEFAULT_LOOK_CONTROL } from '../camera/CameraSystem';
import type { CameraSystem } from '../camera/CameraSystem';
import { WALKING_STABILISATION } from '../camera/EmbodiedCameraController';
import { embodiedFovReference, setEmbodiedFovReference } from '../camera/cameraTuning';
import { DEFAULT_WALKER_TUNING } from '../player/DeckWalker';
import type { DeckWalker } from '../player/DeckWalker';
import { DECK_STAIRS, deckStandAt } from '../vessel/schooner/deckSurface';
import { STATIONS } from '../vessel/schooner/stations';
import { OBSTACLE_COLUMNS } from '../vessel/schooner/deckObstacles';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';

/**
 * Developer controls for the walk.
 *
 * A hull form is judged by moving one number continuously, and so is a body: a
 * walk that is 0.1 m/s too fast or an eye 60 mm too low is not something anyone
 * can name from a screenshot, and both are obvious the moment there is a slider
 * under them. This exists for the same reason `HullPanel` does, and after the
 * same conversation — Ash asked twice for knobs rather than console calls.
 *
 * The readout is the other half. Every figure in it is read back from the body
 * *after* it moved, so a refused step, a contact with a spar or a slide down a
 * heeled deck shows up as what happened rather than as what was commanded.
 */
export interface DeckPanelHandle {
  element: HTMLElement;
  update(dt: number): void;
  dispose(): void;
}

// The "Stand at" stations live in `stations.ts` now, shared with the
// inspection harness: `stand=cabin` on a URL and the Cabin button here must
// mean the same square of sole.

export function createDeckPanel(
  walker: DeckWalker,
  cameras: CameraSystem,
  shipGroup: THREE.Group,
): DeckPanelHandle {
  ensurePanelStyle();

  const root = document.createElement('aside');
  root.className = 'devpanel';
  root.style.top = '12px';
  root.style.right = '12px';

  const title = document.createElement('h2');
  title.textContent = 'Drift · deck';
  root.appendChild(title);

  const controls = new ControlGroup(root);
  const tuning = walker.tuning;
  const stabilisation = cameras.stabilisation;

  controls.section('Body');
  controls.slider({
    label: 'Eye height',
    min: 1.2,
    max: 1.85,
    step: 0.01,
    value: tuning.eyeHeight,
    format: (v) => `${v.toFixed(2)} m`,
    onChange: (v) => {
      tuning.eyeHeight = v;
    },
    read: () => tuning.eyeHeight,
  });
  controls.slider({
    label: 'Standing height',
    min: 1.4,
    max: 2,
    step: 0.01,
    value: tuning.standingHeight,
    format: (v) => `${v.toFixed(2)} m`,
    onChange: (v) => {
      tuning.standingHeight = v;
    },
    read: () => tuning.standingHeight,
  });
  controls.slider({
    label: 'Body radius',
    min: 0.15,
    max: 0.45,
    step: 0.01,
    value: tuning.radius,
    format: (v) => `${v.toFixed(2)} m`,
    onChange: (v) => {
      tuning.radius = v;
    },
    read: () => tuning.radius,
  });

  controls.section('Walk');
  controls.slider({
    label: 'Walk speed',
    min: 0.4,
    max: 8,
    step: 0.05,
    value: tuning.walkSpeed,
    format: (v) => `${v.toFixed(2)} m/s`,
    onChange: (v) => {
      tuning.walkSpeed = v;
    },
    read: () => tuning.walkSpeed,
  });
  controls.slider({
    label: 'Response',
    min: 0,
    max: 0.6,
    step: 0.01,
    value: tuning.responseTau,
    format: (v) => (v <= 0 ? 'instant' : `${v.toFixed(2)} s`),
    onChange: (v) => {
      tuning.responseTau = v;
    },
    read: () => tuning.responseTau,
  });
  controls.slider({
    label: 'Step smoothing',
    min: 0,
    max: 0.4,
    step: 0.01,
    value: tuning.stepSmoothing,
    format: (v) => (v <= 0 ? 'none' : `${v.toFixed(2)} s`),
    onChange: (v) => {
      tuning.stepSmoothing = v;
    },
    read: () => tuning.stepSmoothing,
  });
  controls.slider({
    label: 'Step up',
    min: 0.1,
    max: 0.6,
    step: 0.01,
    value: tuning.stepUp,
    format: (v) => `${v.toFixed(2)} m`,
    onChange: (v) => {
      tuning.stepUp = v;
    },
    read: () => tuning.stepUp,
  });
  controls.slider({
    label: 'Step over',
    min: 0.1,
    max: 0.7,
    step: 0.01,
    value: tuning.stepOver,
    format: (v) => `${v.toFixed(2)} m`,
    onChange: (v) => {
      tuning.stepOver = v;
    },
    read: () => tuning.stepOver,
  });
  controls.slider({
    label: 'Heel slip',
    min: 0,
    max: 1,
    step: 0.01,
    value: tuning.slip,
    format: (v) => `${(v * 100).toFixed(0)} % of gravity`,
    onChange: (v) => {
      tuning.slip = v;
    },
    read: () => tuning.slip,
  });


  controls.section('Look');
  controls.slider({
    label: 'Look sensitivity',
    min: 0.5,
    max: 6,
    step: 0.05,
    value: cameras.lookControl.gain,
    format: (v) => `${v.toFixed(2)}× · ${(1 / v).toFixed(2)} screens per turn`,
    onChange: (v) => {
      cameras.lookControl.gain = v;
    },
    read: () => cameras.lookControl.gain,
  });
  controls.slider({
    label: 'Field of view',
    min: 70,
    max: 120,
    step: 1,
    value: embodiedFovReference() / (Math.PI / 180),
    // Both numbers, because the horizontal is what you ask for and the vertical
    // is what you get: the aspect decides between them, and a bound on the
    // vertical is exactly the thing that made this control look broken.
    format: (v) => `${v.toFixed(0)}° across · ${cameras.embodied.pose.fov.toFixed(0)}° up`,
    onChange: (v) => setEmbodiedFovReference((v * Math.PI) / 180),
    read: () => embodiedFovReference() / (Math.PI / 180),
  });
  controls.checkbox(
    'Invert look (both axes)',
    cameras.lookControl.invert,
    (on) => {
      cameras.lookControl.invert = on;
    },
    () => cameras.lookControl.invert,
  );

  controls.section('Head, walking');
  controls.slider({
    label: 'Roll follow',
    min: 0,
    max: 1,
    step: 0.01,
    value: stabilisation.rollFollow,
    format: (v) => `${(v * 100).toFixed(0)} %`,
    onChange: (v) => {
      stabilisation.rollFollow = v;
    },
    read: () => stabilisation.rollFollow,
  });
  controls.slider({
    label: 'Pitch follow',
    min: 0,
    max: 1,
    step: 0.01,
    value: stabilisation.pitchFollow,
    format: (v) => `${(v * 100).toFixed(0)} %`,
    onChange: (v) => {
      stabilisation.pitchFollow = v;
    },
    read: () => stabilisation.pitchFollow,
  });
  controls.slider({
    label: 'Heave follow',
    min: 0,
    max: 1,
    step: 0.01,
    value: stabilisation.heaveFollow,
    format: (v) => `${(v * 100).toFixed(0)} %`,
    onChange: (v) => {
      stabilisation.heaveFollow = v;
    },
    read: () => stabilisation.heaveFollow,
  });

  controls.section('Show');
  const overlay = buildOverlay();
  overlay.visible = false;
  shipGroup.add(overlay);
  controls.checkbox('Collision volumes', false, (on) => {
    overlay.visible = on;
  });

  controls.section('Stand at');
  controls.buttons(
    STATIONS.map((station) => ({
      label: station.label,
      title: station.title,
      onClick: () => {
        if (!walker.placeAt(station.x, station.z, station.fromY)) {
          walker.placeAt(0, 1.4);
        }
        if (cameras.modeName !== 'embodied') cameras.setMode('embodied');
      },
    })),
  );
  controls.buttons([
    {
      label: 'Reset body',
      title: 'Restore the shipped walk',
      onClick: () => {
        Object.assign(tuning, DEFAULT_WALKER_TUNING);
      },
    },
    {
      label: 'Reset head',
      title: 'Restore the shipped stabilisation model',
      onClick: () => {
        Object.assign(stabilisation, WALKING_STABILISATION);
      },
    },
    {
      label: 'Reset look',
      title: 'Restore the shipped look sensitivity and direction',
      onClick: () => {
        Object.assign(cameras.lookControl, DEFAULT_LOOK_CONTROL);
      },
    },
  ]);

  controls.section('Measured');
  const readout = controls.readout();

  let accumulated = 0;
  const eyeWorld = new THREE.Vector3();

  return {
    element: root,
    update(dt: number): void {
      accumulated += dt;
      if (accumulated < 0.1) return;
      accumulated = 0;
      controls.sync();

      const stand = deckStandAt(walker.x, walker.z);
      eyeWorld.set(walker.x, walker.eyeY(), walker.z).applyMatrix4(shipGroup.matrixWorld);
      const speed = Math.hypot(walker.vx, walker.vz);

      readout.textContent = [
        `position   x ${walker.x.toFixed(2)}  z ${walker.z.toFixed(2)}  feet ${walker.y.toFixed(3)}`,
        `eye        ${walker.eyeY().toFixed(3)} ship-local · ${eyeWorld.y.toFixed(2)} m world`,
        `deck       ${stand ? stand.level.name : 'off deck'}${stand?.stair ? ' · on the ladder' : ''}`,
        // The dimension M4 is about. Under the sky it is meaningless, so it says
        // so rather than printing a number with no referent.
        `headroom   ${
          walker.ceilingY === Infinity
            ? 'open sky'
            : `${(walker.ceilingY - walker.y).toFixed(3)} m clear · deckhead ${walker.ceilingY.toFixed(2)}`
        }`,
        `half-beam  ${stand ? `${stand.halfWidth.toFixed(2)} m · ${(Math.abs(stand.u) * 100).toFixed(0)}% out` : '—'}`,
        `speed      ${speed.toFixed(2)} m/s${walker.grounded ? '' : ' · airborne'}`,
        `contact    ${walker.lastContact ?? 'clear'}`,
        '',
        `solids     ${OBSTACLE_COLUMNS.length} columns indexed`,
        `ladders    ${DECK_STAIRS.length} × 2 flights`,
      ].join('\n');
    },
    dispose(): void {
      overlay.removeFromParent();
      disposeOverlay(overlay);
      root.remove();
    },
  };
}

/**
 * The collision model, drawn.
 *
 * Not the meshes — the columns the walk actually tests against. A collision
 * overlay that draws the geometry it was *derived from* would agree with itself
 * and prove nothing; this one shows the approximation, so a spar that is fatter
 * or thinner than the timber under it is visible as exactly that.
 */
function buildOverlay(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'deckCollisionOverlay';
  const material = new THREE.MeshBasicMaterial({
    color: 0x6fd3a0,
    wireframe: true,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
  });
  group.renderOrder = 900;

  for (const column of OBSTACLE_COLUMNS) {
    const length = Math.hypot(column.x1 - column.x0, column.z1 - column.z0);
    const height = Math.max(column.yHi - column.yLo, 0.01);
    const geometry = new THREE.CylinderGeometry(column.radius, column.radius, height, 8, 1, true);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      (column.x0 + column.x1) * 0.5,
      (column.yLo + column.yHi) * 0.5,
      (column.z0 + column.z1) * 0.5,
    );
    group.add(mesh);

    if (length > 1e-3) {
      // A horizontal run — the horse bar, a boom, the pin rails — needs its own
      // sleeve, because the column above only marks its ends.
      const sleeve = new THREE.Mesh(
        new THREE.CylinderGeometry(column.radius, column.radius, length, 6, 1, true),
        material,
      );
      sleeve.position.copy(mesh.position);
      sleeve.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(column.x1 - column.x0, 0, column.z1 - column.z0).normalize(),
      );
      group.add(sleeve);
    }
  }
  return group;
}

function disposeOverlay(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  });
}
