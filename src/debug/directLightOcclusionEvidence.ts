import { findSeaState } from '../ocean/presets';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type DirectLightOcclusionEvidenceCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'lighting'
  | 'oceanTemporalEnabled'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'resetSimulation'
  | 'setLanternShadowing'
  | 'setOceanTemporalEnabled'
  | 'setSunShadowing'
  | 'shadowingState'
  | 'stepSimulation'
  | 'waves'
  | 'world'
>;
import type { Schooner } from '../vessel/schooner/Schooner';
import {
  buildContactSheet,
  grab,
  post,
  settleSunElevation,
  toBlob,
} from './labCapture';
import type { SheetFrame } from './labCapture';
import { aimShot } from './shipContactSheet';
import type { ShipShot } from './shipContactSheet';

/**
 * Pixel-identical direct-light A/B evidence.
 *
 * Every pair is taken back-to-back with simulation, astronomy, camera, clouds,
 * exposure and temporal history frozen. The only changed state is whether the
 * relevant light renders/samples its geometry shadow map. That makes the third
 * column a meaningful difference image rather than a motion detector.
 */

export interface DirectLightOcclusionEvidenceOptions {
  renderWidth?: number;
  renderHeight?: number;
  frameScale?: number;
  publish?: boolean;
  name?: string;
}

interface EvidenceScene {
  id: 'hull-sun' | 'rough-swell' | 'hull-lantern';
  title: string;
  shot: ShipShot;
  altitude: number;
  hideShip?: boolean;
  light: 'sun' | 'lantern';
}

const EVIDENCE_SCENES: readonly EvidenceScene[] = [
  {
    id: 'hull-sun',
    title: 'sun behind ship · hull cuts streak + daylight water',
    shot: {
      label: 'proof',
      aspect: 'broadside',
      distance: 24,
      sunElevationDeg: 8,
      sunSide: 'back',
      seaState: 'DEAD_CALM',
      settleSeconds: 8,
    },
    altitude: 5.2,
    light: 'sun',
  },
  {
    id: 'rough-swell',
    title: 'Southern Ocean rough · large swell cuts sunset streak',
    shot: {
      label: 'proof',
      aspect: 'broadside',
      distance: 42,
      sunElevationDeg: 6,
      sunSide: 'back',
      seaState: 'SOUTHERN_OCEAN_ROUGH',
      settleSeconds: 18,
    },
    altitude: 7.5,
    hideShip: true,
    light: 'sun',
  },
  {
    id: 'hull-lantern',
    title: 'lantern · real hull cuts reflected pool',
    shot: {
      label: 'proof',
      aspect: 'stern quarter',
      distance: 18,
      sunElevationDeg: -25,
      sunSide: 'front',
      seaState: 'GLASSY_LONG_SWELL',
      settleSeconds: 20,
    },
    altitude: 4.8,
    light: 'lantern',
  },
];

interface DifferenceMetrics {
  mean: number;
  rms: number;
  max: number;
  changedPercent: number;
}

function absoluteDifference(
  a: HTMLCanvasElement,
  b: HTMLCanvasElement,
  gain = 4,
): { image: HTMLCanvasElement; metrics: DifferenceMetrics } {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const aData = a.getContext('2d')!.getImageData(0, 0, width, height).data;
  const bData = b.getContext('2d')!.getImageData(0, 0, width, height).data;
  const outContext = out.getContext('2d')!;
  const image = outContext.createImageData(width, height);
  let sum = 0;
  let sumSquares = 0;
  let max = 0;
  let changed = 0;
  const pixels = width * height;

  for (let i = 0; i < aData.length; i += 4) {
    const dr = Math.abs(bData[i] - aData[i]);
    const dg = Math.abs(bData[i + 1] - aData[i + 1]);
    const db = Math.abs(bData[i + 2] - aData[i + 2]);
    const delta = (dr + dg + db) / 3;
    sum += delta;
    sumSquares += delta * delta;
    max = Math.max(max, dr, dg, db);
    if (Math.max(dr, dg, db) >= 3) changed++;

    // Warm false colour: black is identical, amber is changed. Preserve the
    // per-channel shape so the image still shows which feature was shadowed.
    image.data[i] = Math.min(255, dr * gain + delta * gain * 0.45);
    image.data[i + 1] = Math.min(255, dg * gain + delta * gain * 0.18);
    image.data[i + 2] = Math.min(255, db * gain * 0.55);
    image.data[i + 3] = 255;
  }
  outContext.putImageData(image, 0, 0);

  return {
    image: out,
    metrics: {
      mean: sum / Math.max(pixels, 1),
      rms: Math.sqrt(sumSquares / Math.max(pixels, 1)),
      max,
      changedPercent: (changed / Math.max(pixels, 1)) * 100,
    },
  };
}

/** Capture and optionally publish the three direct-shadow proof pairs. */
export async function captureDirectLightOcclusionEvidence(
  sim: DirectLightOcclusionEvidenceCapability,
  ship: Schooner,
  options: DirectLightOcclusionEvidenceOptions = {},
): Promise<HTMLCanvasElement> {
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.5;
  const name = options.name ?? 'direct-light-occlusion-ab';
  const cinematic = sim.cameras.cinematic;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const clock = sim.world.state;
  const restoreRate = clock.worldSecondsPerRealSecond;
  const restoreInstant = clock.worldInstantUtcSeconds;
  const restoreShipVisible = ship.group.visible;
  const restoreLampMode = ship.lamp.mode;
  const restoreShadows = sim.shadowingState();
  const restoreTemporal = sim.oceanTemporalEnabled();
  const frames: SheetFrame[] = [];
  const notes: string[] = [
    'Only the named geometry shadow map changes within each A/B pair.',
    'No circular raft mask, analytic hull volume, ambient AO, or temporal history.',
  ];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    const aspect = renderWidth / renderHeight;
    sim.cameras.camera.aspect = aspect;
    sim.cameras.camera.updateProjectionMatrix();
    cinematic.setViewport(aspect);
  };

  pinSize();
  clock.worldSecondsPerRealSecond = 0;
  sim.setOceanTemporalEnabled(false);
  sim.cameras.setDiagnosticMode('cinematic');
  try {
    for (const scene of EVIDENCE_SCENES) {
      const state = findSeaState(scene.shot.seaState);
      sim.resetSimulation(state, 0, 0);
      const elevationDeg = settleSunElevation(sim, scene.shot.sunElevationDeg);
      const aim = aimShot(sim, ship, scene.shot);
      sim.cameras.setDiagnosticView(scene.shot.distance, scene.altitude);
      ship.lamp.mode = scene.light === 'lantern' ? 'on' : 'off';
      ship.group.visible = true;
      ship.body.reset();
      ship.snapToSurface(sim.waves, 0, 0);

      const steps = Math.max(1, Math.round(scene.shot.settleSeconds * 60));
      for (let i = 0; i < steps; i++) {
        cinematic.setAzimuth(aim.azimuth);
        sim.stepSimulation(1 / 60);
      }
      ship.group.visible = !scene.hideShip;
      sim.refreshWorldLighting();

      // Disable the unrelated map for an isolated comparison. These are direct
      // controls over caster submission and shader sampling, not image masks.
      sim.setSunShadowing(false);
      sim.setLanternShadowing(false);
      pinSize();
      sim.renderFrame();
      const off = grab(sim.canvas, frameScale);

      if (scene.light === 'sun') sim.setSunShadowing(true);
      else sim.setLanternShadowing(true);
      pinSize();
      sim.renderFrame();
      const on = grab(sim.canvas, frameScale);
      const difference = absoluteDifference(off, on, 4);

      frames.push(
        { image: off, label: `${scene.id} · A geometry shadows OFF` },
        { image: on, label: `${scene.id} · B geometry shadows ON` },
        { image: difference.image, label: `${scene.id} · |B−A| ×4` },
      );
      notes.push(
        `${scene.id} | ${scene.title} | sun ${elevationDeg.toFixed(2)}deg | ` +
          `${renderWidth}x${renderHeight} source | meanΔ ${difference.metrics.mean.toFixed(3)}/255 | ` +
          `rmsΔ ${difference.metrics.rms.toFixed(3)}/255 | maxΔ ${difference.metrics.max.toFixed(0)}/255 | ` +
          `changed>=3 ${difference.metrics.changedPercent.toFixed(2)}%`,
      );

      if (options.publish !== false) {
        await Promise.all([
          post(`${name}/${scene.id}-off.png`, await toBlob(off, 'image/png')),
          post(`${name}/${scene.id}-on.png`, await toBlob(on, 'image/png')),
          post(`${name}/${scene.id}-diff-x4.png`, await toBlob(difference.image, 'image/png')),
        ]);
      }
    }
  } finally {
    ship.group.visible = restoreShipVisible;
    ship.lamp.mode = restoreLampMode;
    sim.setSunShadowing(restoreShadows.sun);
    sim.setLanternShadowing(restoreShadows.lantern);
    clock.worldSecondsPerRealSecond = restoreRate;
    clock.worldInstantUtcSeconds = restoreInstant;
    sim.refreshLighting();
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    if (restoreTemporal) sim.setOceanTemporalEnabled(true);
  }

  const sheet = buildContactSheet(frames, {
    columns: 3,
    cellWidth: 520,
    title: 'Direct-light occlusion — geometry shadow-map A/B',
    subtitle: 'A off · B on · amplified absolute delta · same frozen pixels within every pair',
  });
  if (options.publish !== false) {
    await post(`${name}.png`, await toBlob(sheet, 'image/png'));
    await post(`${name}.txt`, new Blob([notes.join('\n')], { type: 'text/plain' }));
  }
  return sheet;
}
