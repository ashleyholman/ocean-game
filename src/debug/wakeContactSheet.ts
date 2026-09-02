import { findSeaState } from '../ocean/presets';
import type {
  OceanDetailContactSheet,
  SimCapability,
  WakeBowFeature,
  WakeTrailFeature,
} from '../runtime/diagnostics/SimHandle';

export type WakeContactSheetCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'lighting'
  | 'originX'
  | 'originZ'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'resetSimulation'
  | 'restoreWakeDiagnosticMotion'
  | 'seaStates'
  | 'setWakeBowFeatureEnabled'
  | 'setWakeDiagnosticTow'
  | 'setWakeEffectsEnabled'
  | 'setWakeTrailFeatureEnabled'
  | 'stepSimulation'
  | 'vessel'
  | 'wakeBowFeatureEnabled'
  | 'wakeBowPolicy'
  | 'wakeDiagnosticMotionState'
  | 'wakeEffectsEnabled'
  | 'wakeTrailFeatureEnabled'
  | 'wakeTrailPolicy'
  | 'waves'
  | 'world'
>;
import { buildWakePolarReferences } from '../vessel/schooner/WakeSourcesEvidence';
import {
  buildContactSheet,
  grab,
  post,
  postText,
  settleSunElevation,
  toBlob,
  type SheetFrame,
} from './labCapture';

interface WakeContactSheetOptions {
  onProgress?: (report: string) => void;
  renderWidth?: number;
  renderHeight?: number;
  frameScale?: number;
  publish?: boolean;
  name?: string;
}

type WakeView = 'cinematic' | 'embodied-aft';

const VARIANTS: ReadonlyArray<{
  label: string;
  master: boolean;
  bubbleHaze: boolean;
  whitecapSuppression: boolean;
}> = [
  {
    label: 'A · master off',
    master: false,
    bubbleHaze: true,
    whitecapSuppression: true,
  },
  {
    label: 'B · full trail',
    master: true,
    bubbleHaze: true,
    whitecapSuppression: true,
  },
  {
    label: 'B−haze',
    master: true,
    bubbleHaze: false,
    whitecapSuppression: true,
  },
  {
    label: 'B−suppression',
    master: true,
    bubbleHaze: true,
    whitecapSuppression: false,
  },
];

const VISUAL_FEATURES: readonly WakeTrailFeature[] = [
  'bubbleHaze',
  'whitecapSuppression',
];

function applyVariant(
  sim: WakeContactSheetCapability,
  variant: (typeof VARIANTS)[number],
): void {
  sim.setWakeEffectsEnabled(variant.master);
  sim.setWakeTrailFeatureEnabled('injection', true);
  sim.setWakeTrailFeatureEnabled('bubbleHaze', variant.bubbleHaze);
  sim.setWakeTrailFeatureEnabled(
    'whitecapSuppression',
    variant.whitecapSuppression,
  );
  // Publish toggles to the ocean uniforms without advancing physics/history.
  sim.stepSimulation(0);
}

function aimView(sim: WakeContactSheetCapability, view: WakeView): void {
  if (view === 'cinematic') {
    sim.cameras.setDiagnosticMode('cinematic');
    sim.cameras.setDiagnosticView(52, 17);
    // Model forward is (sin yaw, cos yaw). This places the camera behind and
    // slightly to starboard so both the stern source and long band are visible.
    sim.cameras.cinematic.setAzimuth(-sim.vessel.group.rotation.y - 0.48);
    return;
  }
  sim.cameras.setDiagnosticMode('embodied');
  sim.cameras.embodied.reset();
  sim.cameras.look = { yaw: Math.PI, pitch: -0.12 };
}

/**
 * Deterministic WK1 visual matrix.
 *
 * Each sea is advanced twice from the same reset: once with the master off for
 * the true ambient-only A frame, then once with a real 28-second hull trail at
 * that state's freshly solved polar speed and leeway. The three B/subtraction
 * variants render the exact same frozen full field; the A run reaches the same
 * deterministic wave/ambient instant without contaminating R/G with hull foam.
 */
export async function captureWakeContactSheet(
  sim: WakeContactSheetCapability,
  options: WakeContactSheetOptions = {},
): Promise<OceanDetailContactSheet> {
  const progress = options.onProgress ?? (() => undefined);
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.42;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const restoreSea = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreOriginX = sim.originX();
  const restoreOriginZ = sim.originZ();
  const restoreMotion = sim.wakeDiagnosticMotionState();
  const restoreMaster = sim.wakeEffectsEnabled();
  const restoreFeatures = new Map<WakeTrailFeature, boolean>();
  for (const feature of ['injection', ...VISUAL_FEATURES] as const) {
    restoreFeatures.set(feature, sim.wakeTrailFeatureEnabled(feature));
  }
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const world = sim.world.state;
  const restoreRate = world.worldSecondsPerRealSecond;
  const restorePaused = world.paused;
  const restoreInstant = world.worldInstantUtcSeconds;
  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const notes: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };

  world.worldSecondsPerRealSecond = 0;
  world.paused = true;
  pinSize();

  try {
    const references = buildWakePolarReferences(progress);
    const fixedHeading = restoreMotion.trueHeadingRad;
    for (let stateIndex = 0; stateIndex < references.length; stateIndex++) {
      const reference = references[stateIndex];
      progress(
        `Wake A/B ${stateIndex + 1}/${references.length} · ${reference.seaStateName} trail build`,
      );
      const sea = findSeaState(reference.seaStateName);
      sim.setWakeDiagnosticTow(
        reference.speedMps,
        fixedHeading,
        (reference.leewayDeg * Math.PI) / 180,
      );
      sim.setWakeTrailFeatureEnabled('injection', true);
      for (const feature of VISUAL_FEATURES) {
        sim.setWakeTrailFeatureEnabled(feature, true);
      }

      // The master cannot retrospectively identify hull R/G once those values
      // have mixed into FoamField's ambient R/G channels. Build the A state
      // independently from the same reset so “master off” really means no hull
      // source, rather than a full field whose B appearance was merely hidden.
      sim.setWakeEffectsEnabled(false);
      sim.resetSimulation(sea, 0, 0);
      settleSunElevation(sim, 34);
      for (let frame = 0; frame < 28 * 60; frame++) {
        sim.stepSimulation(1 / 60);
      }
      sim.refreshWorldLighting();
      const masterOffFrames = new Map<WakeView, HTMLCanvasElement>();
      for (const view of ['cinematic', 'embodied-aft'] as const) {
        aimView(sim, view);
        applyVariant(sim, VARIANTS[0]);
        pinSize();
        sim.renderFrame();
        masterOffFrames.set(view, grab(sim.canvas, frameScale));
      }

      // Ambient warm-up is reset-owned and deliberately excludes the hull.
      // These ordinary steps are the only place the real trail history is made.
      sim.setWakeEffectsEnabled(true);
      sim.resetSimulation(sea, 0, 0);
      for (let frame = 0; frame < 28 * 60; frame++) {
        sim.stepSimulation(1 / 60);
      }
      sim.refreshWorldLighting();

      for (const view of ['cinematic', 'embodied-aft'] as const) {
        aimView(sim, view);
        const masterOff = VARIANTS[0];
        const masterOffImage = masterOffFrames.get(view)!;
        const masterOffLabel =
          `${reference.seaStateName} · ${view} · ${masterOff.label}`;
        frames.push({ image: masterOffImage, label: masterOffLabel });
        captures.push({
          label: masterOffLabel,
          dataUrl: masterOffImage.toDataURL('image/jpeg', 0.94),
        });

        for (const variant of VARIANTS.slice(1)) {
          applyVariant(sim, variant);
          pinSize();
          sim.renderFrame();
          const image = grab(sim.canvas, frameScale);
          const label = `${reference.seaStateName} · ${view} · ${variant.label}`;
          frames.push({ image, label });
          captures.push({
            label,
            dataUrl: image.toDataURL('image/jpeg', 0.94),
          });
        }
      }
      notes.push(
        `${reference.seaStateName} | speed ${reference.speedMps.toFixed(3)} m/s | ` +
          `leeway ${reference.leewayDeg.toFixed(3)}deg | 28 s trail | ` +
          `A rebuilt ambient-only at same deterministic instant | ` +
          `R ${sim.wakeTrailPolicy.activeFoamRatePerSecond.toFixed(3)} ` +
          `G ${sim.wakeTrailPolicy.residualFoamRatePerSecond.toFixed(3)} ` +
          `B ${sim.wakeTrailPolicy.turbulenceRatePerSecond.toFixed(3)} /s | ` +
          `tau ${sim.wakeTrailPolicy.turbulenceTauSeconds.toFixed(2)} s`,
      );
    }

    const sheet = buildContactSheet(frames, {
      columns: VARIANTS.length,
      cellWidth: 360,
      title: 'Wake WK1 — trail component A/B',
      subtitle:
        'deterministic ambient-only A · shared full field for B / minus haze / minus suppression',
    });
    if (options.publish !== false) {
      const name = options.name ?? 'wake-wk1-contact-sheet';
      const published = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
      await postText(`${name}.txt`, `${notes.join('\n')}\n`, 'text/plain');
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }
    return {
      title: 'Wake WK1 trail A/B',
      condition:
        'three reference seas at solved polar speed/leeway · cinematic and embodied-aft · deterministic ambient-only A plus shared frozen full-field B variants',
      captures,
    };
  } finally {
    sim.setWakeEffectsEnabled(restoreMaster);
    for (const [feature, enabled] of restoreFeatures) {
      sim.setWakeTrailFeatureEnabled(feature, enabled);
    }
    sim.restoreWakeDiagnosticMotion(restoreMotion);
    sim.resetSimulation(restoreSea, restoreOriginX, restoreOriginZ);
    sim.waves.setTime(restoreWaveTime);
    world.worldInstantUtcSeconds = restoreInstant;
    world.worldSecondsPerRealSecond = restoreRate;
    world.paused = restorePaused;
    sim.refreshLighting();
    sim.refreshWorldLighting();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(
      Math.max(restoreWidth, 1),
      Math.max(restoreHeight, 1),
      false,
    );
    sim.cameras.setViewport(
      Math.max(restoreWidth, 1),
      Math.max(restoreHeight, 1),
    );
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}

type WakeWk2View = 'embodied-bow' | 'cinematic-bow-quarter';

const WK2_VARIANTS: ReadonlyArray<{
  label: string;
  collar: boolean;
  wetHull: boolean;
  bowMound: boolean;
}> = [
  {
    label: 'A · WK1 only',
    collar: false,
    wetHull: false,
    bowMound: false,
  },
  {
    label: 'B · full WK2',
    collar: true,
    wetHull: true,
    bowMound: true,
  },
  {
    label: 'B−collar',
    collar: false,
    wetHull: true,
    bowMound: true,
  },
  {
    label: 'B−wet hull',
    collar: true,
    wetHull: false,
    bowMound: true,
  },
  {
    label: 'B−mound',
    collar: true,
    wetHull: true,
    bowMound: false,
  },
];

const WK2_FEATURES: readonly WakeBowFeature[] = [
  'collar',
  'wetHull',
  'bowMound',
];

function applyWk2Variant(
  sim: WakeContactSheetCapability,
  variant: (typeof WK2_VARIANTS)[number],
): void {
  sim.setWakeEffectsEnabled(true);
  sim.setWakeTrailFeatureEnabled('injection', true);
  for (const feature of VISUAL_FEATURES) {
    sim.setWakeTrailFeatureEnabled(feature, true);
  }
  sim.setWakeBowFeatureEnabled('collar', variant.collar);
  sim.setWakeBowFeatureEnabled('wetHull', variant.wetHull);
  sim.setWakeBowFeatureEnabled('bowMound', variant.bowMound);
  sim.stepSimulation(0);
}

function aimWk2View(sim: WakeContactSheetCapability, view: WakeWk2View): void {
  if (view === 'embodied-bow') {
    sim.cameras.setDiagnosticMode('embodied');
    sim.cameras.embodied.reset();
    sim.cameras.look = { yaw: 0, pitch: -0.24 };
    return;
  }
  sim.cameras.setDiagnosticMode('cinematic');
  sim.cameras.setDiagnosticView(30, 9);
  // Opposite the WK1 stern-quarter azimuth: ahead and slightly to starboard,
  // close enough to read the waterline sheen and the collar together.
  sim.cameras.cinematic.setAzimuth(
    -sim.vessel.group.rotation.y + Math.PI - 0.52,
  );
}

/**
 * Deterministic WK2 visual matrix, led by the embodied bow view.
 *
 * Every column is rebuilt from the same reset. Hull R/G shares FoamField's
 * ambient channels and cannot be removed retrospectively, so a subtraction
 * frame that merely disabled its uniform would be a photograph of the wrong
 * history. The A column keeps all of WK1 enabled and removes only WK2.
 */
export async function captureWakeWk2ContactSheet(
  sim: WakeContactSheetCapability,
  options: WakeContactSheetOptions = {},
): Promise<OceanDetailContactSheet> {
  const progress = options.onProgress ?? (() => undefined);
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.42;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const restoreSea = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreOriginX = sim.originX();
  const restoreOriginZ = sim.originZ();
  const restoreMotion = sim.wakeDiagnosticMotionState();
  const restoreMaster = sim.wakeEffectsEnabled();
  const restoreTrailFeatures = new Map<WakeTrailFeature, boolean>();
  for (const feature of ['injection', ...VISUAL_FEATURES] as const) {
    restoreTrailFeatures.set(feature, sim.wakeTrailFeatureEnabled(feature));
  }
  const restoreBowFeatures = new Map<WakeBowFeature, boolean>();
  for (const feature of WK2_FEATURES) {
    restoreBowFeatures.set(feature, sim.wakeBowFeatureEnabled(feature));
  }
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const world = sim.world.state;
  const restoreRate = world.worldSecondsPerRealSecond;
  const restorePaused = world.paused;
  const restoreInstant = world.worldInstantUtcSeconds;
  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const notes: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };

  world.worldSecondsPerRealSecond = 0;
  world.paused = true;
  pinSize();

  try {
    const references = buildWakePolarReferences(progress);
    const fixedHeading = restoreMotion.trueHeadingRad;
    for (let stateIndex = 0; stateIndex < references.length; stateIndex++) {
      const reference = references[stateIndex];
      const sea = findSeaState(reference.seaStateName);
      sim.setWakeDiagnosticTow(
        reference.speedMps,
        fixedHeading,
        (reference.leewayDeg * Math.PI) / 180,
      );
      const stateFrames = new Map<string, HTMLCanvasElement>();

      for (
        let variantIndex = 0;
        variantIndex < WK2_VARIANTS.length;
        variantIndex++
      ) {
        const variant = WK2_VARIANTS[variantIndex];
        progress(
          `Wake WK2 ${stateIndex + 1}/${references.length} · ` +
            `${variantIndex + 1}/${WK2_VARIANTS.length} · ${reference.seaStateName} ${variant.label}`,
        );
        applyWk2Variant(sim, variant);
        sim.resetSimulation(sea, 0, 0);
        settleSunElevation(sim, 34);
        // The collar is local and its active channel settles quickly; eighteen
        // seconds also gives its small B contribution a representative worked
        // patch without paying WK1's long astern-history build for every cell.
        for (let frame = 0; frame < 18 * 60; frame++) {
          sim.stepSimulation(1 / 60);
        }
        sim.refreshWorldLighting();

        for (const view of [
          'embodied-bow',
          'cinematic-bow-quarter',
        ] as const) {
          aimWk2View(sim, view);
          pinSize();
          sim.renderFrame();
          stateFrames.set(
            `${view}:${variant.label}`,
            grab(sim.canvas, frameScale),
          );
        }
      }

      for (const view of [
        'embodied-bow',
        'cinematic-bow-quarter',
      ] as const) {
        for (const variant of WK2_VARIANTS) {
          const image = stateFrames.get(`${view}:${variant.label}`)!;
          const label = `${reference.seaStateName} · ${view} · ${variant.label}`;
          frames.push({ image, label });
          captures.push({
            label,
            dataUrl: image.toDataURL('image/jpeg', 0.94),
          });
        }
      }
      notes.push(
        `${reference.seaStateName} | speed ${reference.speedMps.toFixed(3)} m/s | ` +
          `leeway ${reference.leewayDeg.toFixed(3)}deg | independent 18 s histories | ` +
          `collar drive ${sim.wakeBowPolicy.collarDrive.toFixed(3)} | ` +
          `R ${sim.wakeBowPolicy.activeFoamRatePerSecond.toFixed(3)} ` +
          `G ${sim.wakeBowPolicy.residualFoamRatePerSecond.toFixed(3)} ` +
          `B ${sim.wakeBowPolicy.turbulenceRatePerSecond.toFixed(3)} /s | ` +
          `wet ${sim.wakeBowPolicy.wetBandHeightM.toFixed(3)} m | ` +
          `mound ${sim.wakeBowPolicy.moundNormalStrength.toFixed(4)}`,
      );
    }

    const sheet = buildContactSheet(frames, {
      columns: WK2_VARIANTS.length,
      cellWidth: 360,
      title: 'Wake WK2 — bow collar and resolved wet hull A/B',
      subtitle:
        'A keeps WK1 · independent deterministic histories · embodied bow leads · full / minus collar / minus wet hull / minus mound',
    });
    if (options.publish !== false) {
      const name = options.name ?? 'wake-wk2-contact-sheet';
      const published = await post(
        `${name}.png`,
        await toBlob(sheet, 'image/png'),
      );
      await postText(`${name}.txt`, `${notes.join('\n')}\n`, 'text/plain');
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }
    return {
      title: 'Wake WK2 bow / wet hull A/B',
      condition:
        'three reference seas at solved polar speed/leeway · embodied-bow and cinematic bow-quarter · independent WK1-only/full/component histories',
      captures,
    };
  } finally {
    sim.setWakeEffectsEnabled(restoreMaster);
    for (const [feature, enabled] of restoreTrailFeatures) {
      sim.setWakeTrailFeatureEnabled(feature, enabled);
    }
    for (const [feature, enabled] of restoreBowFeatures) {
      sim.setWakeBowFeatureEnabled(feature, enabled);
    }
    sim.restoreWakeDiagnosticMotion(restoreMotion);
    sim.resetSimulation(restoreSea, restoreOriginX, restoreOriginZ);
    sim.waves.setTime(restoreWaveTime);
    world.worldInstantUtcSeconds = restoreInstant;
    world.worldSecondsPerRealSecond = restoreRate;
    world.paused = restorePaused;
    sim.refreshLighting();
    sim.refreshWorldLighting();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(
      Math.max(restoreWidth, 1),
      Math.max(restoreHeight, 1),
      false,
    );
    sim.cameras.setViewport(
      Math.max(restoreWidth, 1),
      Math.max(restoreHeight, 1),
    );
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}
