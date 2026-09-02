import { findSeaState } from '../ocean/presets';
import type {
  OceanDetailContactSheet,
  SimCapability,
} from '../runtime/diagnostics/SimHandle';

export type OceanViolenceContactSheetCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'clearFoam'
  | 'lighting'
  | 'ocean'
  | 'refreshLighting'
  | 'renderFrame'
  | 'renderer'
  | 'scene'
  | 'seaStates'
  | 'setFoamStrength'
  | 'setSeaState'
  | 'stepSimulation'
  | 'vessel'
  | 'warmFoam'
  | 'waves'
  | 'world'
>;
import type { LayerMask } from '../ocean/spectrum';
import type { SeaState } from '../ocean/seaState';
import { cloneSeaState, windSeaSteepnessFor } from '../ocean/seaState';
import { buildContactSheet, grab, post, postText, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';
import { formatViolenceMetrics, measureViolence } from './oceanViolenceMetrics';
import type { ViolenceMetrics } from './oceanViolenceMetrics';

/**
 * Evidence for the ocean-violence round.
 *
 * The question the round has to answer is not "how high is the sea" but "does
 * the sea look like what it is", and that cannot be settled by looking at the
 * running app: the answer changes with the sun, the wave phase, the age of the
 * foam history and which random gust happens to be passing. So every frame here
 * is pinned — fixed sun elevation, fixed wave clock, fixed render size, foam
 * warmed to steady state before the shutter — and each one is measured as well
 * as photographed.
 *
 * The layer isolations matter as much as the full compositions. A 4.4 m wind
 * sea at 9.7 s under an 18 m/s wind either reads as violent on its own or it
 * does not, and adding a 375 m swell back on top cannot rescue it. So the
 * wind-sea-only frame is in the sheet, next to a moderate sea and a glassy one,
 * and the honest test is whether a stranger could pick the storm out.
 */

const ALL_LAYERS: LayerMask = { swell: true, riders: true, windSea: true, detail: true };

interface ViolenceShot {
  label: string;
  seaState: string;
  layers: LayerMask;
}

export const VIOLENCE_SHOTS: readonly ViolenceShot[] = [
  { label: 'Southern · full', seaState: 'SOUTHERN_OCEAN_ROUGH', layers: ALL_LAYERS },
  {
    label: 'Southern · wind sea only',
    seaState: 'SOUTHERN_OCEAN_ROUGH',
    layers: { swell: false, riders: false, windSea: true, detail: false },
  },
  {
    label: 'Southern · swell only',
    seaState: 'SOUTHERN_OCEAN_ROUGH',
    layers: { swell: true, riders: false, windSea: false, detail: false },
  },
  { label: 'Moderate control', seaState: 'CURRENT_MODERATE', layers: ALL_LAYERS },
  { label: 'Glassy control', seaState: 'GLASSY_LONG_SWELL', layers: ALL_LAYERS },
];

type ViewName = 'production' | 'horizon' | 'waterline' | 'embodied';

/** Distance from the raft and altitude above mean water, as the lab expresses them. */
const CINEMATIC_VIEWS: Record<Exclude<ViewName, 'embodied'>, [number, number]> = {
  production: [34, 11],
  horizon: [34, 3.4],
  waterline: [9, 0.9],
};

const VIEWS: readonly ViewName[] = ['production', 'horizon', 'waterline', 'embodied'];

/**
 * Wave clock instants, one per shot.
 *
 * Different for each so the sheet is not five photographs of the same crest
 * pattern, and fixed so that re-running it after a change is a comparison
 * rather than a fresh roll of the dice.
 */
const WAVE_TIMES: readonly number[] = [118, 151, 184, 137, 163];

/** Bright noon. Darkness is not allowed to be the excuse. */
const SUN_ELEVATION_DEG = 48;

function setSunElevation(
  sim: OceanViolenceContactSheetCapability,
  searchBaseUtcSeconds: number,
  targetElevationDeg: number,
): number {
  const state = sim.world.state;
  let bestInstant = searchBaseUtcSeconds;
  let bestElevation = 0;
  let bestError = Infinity;
  for (let minute = 0; minute < 1440; minute += 2) {
    state.worldInstantUtcSeconds = searchBaseUtcSeconds + minute * 60;
    sim.refreshLighting();
    const y = Math.min(Math.max(sim.lighting.sunDirection.y, -1), 1);
    const elevationDeg = (Math.asin(y) * 180) / Math.PI;
    const error = Math.abs(elevationDeg - targetElevationDeg);
    if (error < bestError) {
      bestError = error;
      bestInstant = state.worldInstantUtcSeconds;
      bestElevation = elevationDeg;
    }
  }
  state.worldInstantUtcSeconds = bestInstant;
  sim.refreshLighting();
  return bestElevation;
}

/**
 * Foam coverage gains to photograph side by side.
 *
 * A ladder rather than a single answer, because the number this replaces was
 * arrived at by measurement and the measurement was wrong, and because what
 * "six percent whitecap coverage" should look like from a raft is a judgement
 * about the picture, not an arithmetic result. Each rung is measured too, so
 * whichever one is chosen arrives with its coverage attached.
 */
export const FOAM_GAIN_LADDER: readonly number[] = [0.2, 0.4, 0.8, 1.5, 3.1];

interface LadderRow {
  label: string;
  seaState: string;
  view: ViewName;
  waveTime: number;
}

const LADDER_ROWS: readonly LadderRow[] = [
  { label: 'Southern · production', seaState: 'SOUTHERN_OCEAN_ROUGH', view: 'production', waveTime: 118 },
  { label: 'Southern · embodied', seaState: 'SOUTHERN_OCEAN_ROUGH', view: 'embodied', waveTime: 151 },
  { label: 'Southern · waterline', seaState: 'SOUTHERN_OCEAN_ROUGH', view: 'waterline', waveTime: 184 },
  { label: 'Moderate · production', seaState: 'CURRENT_MODERATE', view: 'production', waveTime: 137 },
];

function applyView(sim: OceanViolenceContactSheetCapability, view: ViewName): void {
  if (view === 'embodied') {
    sim.cameras.setDiagnosticMode('embodied');
    sim.cameras.embodied.reset();
    // Out across the forward quarter: approaching faces, with the deck and the
    // side stay clear of the sightline.
    sim.cameras.look = { yaw: (140 * Math.PI) / 180, pitch: 0 };
    return;
  }
  // setDiagnosticMode, not setMode: the interactive path animates a one-second
  // travel between controllers, and this harness steps the world by zero
  // seconds, so an animated transition never arrives. Every frame after the
  // first embodied shot was then photographed from the castaway's eye while
  // claiming to be a cinematic view — including, memorably, several taken from
  // under the water.
  const [distance, altitude] = CINEMATIC_VIEWS[view];
  sim.cameras.setDiagnosticMode('cinematic');
  sim.cameras.setDiagnosticView(distance, altitude);
}

export interface ViolenceEvidenceOptions {
  onProgress?: (report: string) => void;
  renderWidth?: number;
  renderHeight?: number;
  frameScale?: number;
  publish?: boolean;
  /** Artefact stem. Use `before` and `after` for an A/B across a change. */
  name?: string;
  /** Shape ladder only: whitewater strength, 0 to photograph the water alone. */
  foamStrength?: number;
}

export interface ViolenceEvidence extends OceanDetailContactSheet {
  /** One entry per frame, in sheet order. */
  metrics: Array<{ label: string; metrics: ViolenceMetrics }>;
  report: string;
}

/**
 * Photograph and measure the whole matrix.
 *
 * Restores every piece of world state it touches, including the ones that are
 * easy to forget: the wave clock, the canonical instant, the layer mask and the
 * render size. A harness that leaves the lab in a diagnostic state is a harness
 * whose next result is a lie.
 */
export async function captureOceanViolenceEvidence(
  sim: OceanViolenceContactSheetCapability,
  options: ViolenceEvidenceOptions = {},
): Promise<ViolenceEvidence> {
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.5;
  const progress = options.onProgress ?? (() => undefined);
  const name = options.name ?? 'ocean-violence';

  const state = sim.world.state;
  const restoreRate = state.worldSecondsPerRealSecond;
  const restorePaused = state.paused;
  const restoreInstant = state.worldInstantUtcSeconds;
  const restoreSeaState = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreLayers = { ...sim.waves.layerMask };
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;

  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const metrics: ViolenceEvidence['metrics'] = [];
  const reportLines: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };

  const settleAndRender = (count: number): void => {
    for (let i = 0; i < count; i++) {
      pinSize();
      sim.stepSimulation(0);
      sim.renderFrame();
    }
  };

  state.worldSecondsPerRealSecond = 0;
  state.paused = true;
  pinSize();

  try {
    const measuredSun = setSunElevation(sim, restoreInstant, SUN_ELEVATION_DEG);
    reportLines.push(
      `ocean violence evidence · ${name}`,
      `sun ${measuredSun.toFixed(1)} deg · render ${renderWidth}x${renderHeight}`,
      '',
    );

    for (let index = 0; index < VIOLENCE_SHOTS.length; index++) {
      const shot = VIOLENCE_SHOTS[index];
      sim.setSeaState(findSeaState(shot.seaState), 0);
      sim.waves.setTime(WAVE_TIMES[index % WAVE_TIMES.length]);
      sim.waves.setLayerMask(shot.layers);
      // Put the raft back on the water. The harness steps the world by zero
      // seconds, so the buoyancy solver integrates nothing and the hull keeps
      // whatever height the *previous* sea left it at — which for a swell-only
      // isolation is metres out. Both the low waterline view and the embodied
      // eye are placed relative to the deck, so a stale hull puts the camera
      // under the surface, where a front-faced ocean is invisible and the frame
      // becomes the underside of the sky. Clearing `settled` makes the next
      // step snap the body onto the surface it is actually floating on.
      sim.vessel.body.reset();
      sim.stepSimulation(0);

      for (const view of VIEWS) {
        progress(`Violence evidence · ${shot.label} · ${view}`);
        applyView(sim, view);
        // Foam history is warmed per frame, not per shot: the camera move is
        // free but the sea state and the wave clock are not, and an unwarmed
        // field is a different ocean from the one the preset describes.
        sim.clearFoam();
        sim.warmFoam();
        settleAndRender(6);

        const label = `${shot.label} · ${view}`;
        const measured = measureViolence(sim, {
          width: renderWidth,
          height: renderHeight,
          scale: frameScale,
        });
        metrics.push({ label, metrics: measured });
        reportLines.push(formatViolenceMetrics(label, measured), '');

        // Re-pin: the measurement restores the size it found, and what it found
        // was the pinned size, but the render that follows must be the one that
        // is photographed.
        settleAndRender(2);
        const image = grab(sim.canvas, frameScale);
        frames.push({ image, label });
        captures.push({ label, dataUrl: image.toDataURL('image/jpeg', 0.94) });
      }
    }

    const sheet = buildContactSheet(frames, {
      columns: VIEWS.length,
      cellWidth: 520,
      title: `Ocean violence — ${name}`,
      subtitle: `sun ${measuredSun.toFixed(0)}° · rows: full / wind sea / swell / moderate / glassy · columns: ${VIEWS.join(' · ')}`,
    });

    const report = reportLines.join('\n');
    if (options.publish !== false) {
      const published = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
      await postText(`${name}.txt`, report, 'text/plain');
      await postText(
        `${name}.json`,
        JSON.stringify({ sun: measuredSun, frames: metrics }, null, 2),
        'application/json',
      );
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }

    return {
      title: `Ocean violence — ${name}`,
      condition: `sun ${measuredSun.toFixed(0)}° · five seas × four views · foam warmed · pinned wave clock`,
      captures,
      metrics,
      report,
    };
  } finally {
    sim.waves.setLayerMask(restoreLayers);
    sim.setSeaState(restoreSeaState, 0);
    sim.waves.setTime(restoreWaveTime);
    state.worldInstantUtcSeconds = restoreInstant;
    state.worldSecondsPerRealSecond = restoreRate;
    state.paused = restorePaused;
    sim.refreshLighting();
    sim.clearFoam();
    sim.warmFoam();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    sim.cameras.setViewport(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1));
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}

/**
 * Photograph the foam coverage gain ladder.
 *
 * One row per condition, one column per gain, every cell measured. This is the
 * sheet the round's whitewater decision gets made from: the registration fix
 * turns a system back on that has effectively been off, and the number that
 * scales it was calibrated while it was off, so it cannot be inherited and it
 * cannot be derived from the picture by arithmetic either.
 */
export async function captureFoamGainLadder(
  sim: OceanViolenceContactSheetCapability,
  options: ViolenceEvidenceOptions = {},
): Promise<ViolenceEvidence> {
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.5;
  const progress = options.onProgress ?? (() => undefined);
  const name = options.name ?? 'ocean-violence-gain-ladder';

  const state = sim.world.state;
  const restoreRate = state.worldSecondsPerRealSecond;
  const restorePaused = state.paused;
  const restoreInstant = state.worldInstantUtcSeconds;
  const restoreSeaState = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const restoreGain = sim.ocean.foamCoverageGain;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;

  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const metrics: ViolenceEvidence['metrics'] = [];
  const reportLines: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };
  const settleAndRender = (count: number): void => {
    for (let i = 0; i < count; i++) {
      pinSize();
      sim.stepSimulation(0);
      sim.renderFrame();
    }
  };

  state.worldSecondsPerRealSecond = 0;
  state.paused = true;
  pinSize();

  try {
    const measuredSun = setSunElevation(sim, restoreInstant, SUN_ELEVATION_DEG);
    reportLines.push(
      `foam coverage gain ladder · sun ${measuredSun.toFixed(1)} deg`,
      `gains: ${FOAM_GAIN_LADDER.join(', ')}`,
      '',
    );

    for (const row of LADDER_ROWS) {
      sim.setSeaState(findSeaState(row.seaState), 0);
      sim.waves.setTime(row.waveTime);
      sim.vessel.body.reset();
      sim.stepSimulation(0);
      applyView(sim, row.view);
      // Warmed once per row, not per rung: the gain scales the field's output,
      // it does not change the field, so re-warming between rungs would only
      // add a different random history to each column and make the comparison
      // about that instead.
      sim.clearFoam();
      sim.warmFoam();
      settleAndRender(6);

      for (const gain of FOAM_GAIN_LADDER) {
        progress(`Gain ladder · ${row.label} · ${gain}`);
        sim.ocean.setFoamCoverageGain(gain);
        settleAndRender(2);

        const label = `${row.label} · gain ${gain}`;
        const measured = measureViolence(sim, {
          width: renderWidth,
          height: renderHeight,
          scale: frameScale,
        });
        metrics.push({ label, metrics: measured });
        reportLines.push(formatViolenceMetrics(label, measured), '');

        settleAndRender(2);
        const image = grab(sim.canvas, frameScale);
        frames.push({
          image,
          label: `${row.label} · gain ${gain} · foam ${measured.foamAreaPct}%`,
        });
        captures.push({ label, dataUrl: image.toDataURL('image/jpeg', 0.94) });
      }
    }

    const sheet = buildContactSheet(frames, {
      columns: FOAM_GAIN_LADDER.length,
      cellWidth: 460,
      title: 'Ocean violence — foam coverage gain ladder',
      subtitle: `sun ${measuredSun.toFixed(0)}° · columns are gain ${FOAM_GAIN_LADDER.join(' / ')} · 3.1 is the inherited value`,
    });

    const report = reportLines.join('\n');
    if (options.publish !== false) {
      const published = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
      await postText(`${name}.txt`, report, 'text/plain');
      await postText(
        `${name}.json`,
        JSON.stringify({ sun: measuredSun, gains: FOAM_GAIN_LADDER, frames: metrics }, null, 2),
        'application/json',
      );
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }

    return {
      title: 'Ocean violence — foam coverage gain ladder',
      condition: `sun ${measuredSun.toFixed(0)}° · four conditions × five gains · foam warmed per row`,
      captures,
      metrics,
      report,
    };
  } finally {
    sim.ocean.setFoamCoverageGain(restoreGain);
    sim.setSeaState(restoreSeaState, 0);
    sim.waves.setTime(restoreWaveTime);
    state.worldInstantUtcSeconds = restoreInstant;
    state.worldSecondsPerRealSecond = restoreRate;
    state.paused = restorePaused;
    sim.refreshLighting();
    sim.clearFoam();
    sim.warmFoam();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    sim.cameras.setViewport(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1));
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}

/**
 * One lever of the ocean's shape, and the values to photograph it at.
 *
 * The whitewater round's first result was that the sea reads as rolling hills
 * with whitecaps on it, which is what it is: the registration fix repaired how
 * breaking is *presented* and changed nothing about the shape of the water
 * being presented. These are the levers that could, ordered by how much of the
 * ocean they touch, and the point of photographing them side by side is to find
 * out which one is actually load-bearing before committing to the expensive one.
 */
interface ShapeLever {
  label: string;
  /** What each rung means, for the cell caption. */
  format: (value: number) => string;
  values: readonly number[];
  apply: (state: SeaState, value: number) => void;
}

/** Southern's own values, so the ladder always contains its own baseline. */
const SHAPE_LEVERS: readonly ShapeLever[] = [
  {
    // Already 0.795 of a 0..1 range in the preset, and the composite is clamped
    // at sum(QAk) = 1.25 regardless, so the top of this sweep may be a no-op.
    // Worth knowing either way.
    label: 'wind-sea steepness',
    format: (v) => v.toFixed(2),
    values: [0.5, 0.65, 0.795, 0.9, 1.0],
    apply: (s, v) => {
      (s as { windSeaSteepness: number }).windSeaSteepness = v;
    },
  },
  {
    // The glitter wash. At noon this is a bright sheet over crest, face and
    // trough alike, and the handover's charge is that it flattens the height
    // read rather than supporting it.
    label: 'detail gain',
    format: (v) => `×${v.toFixed(2)}`,
    values: [0, 0.3, 0.6, 0.9, 1.3],
    apply: (s, v) => {
      s.roughness.detailStrength = v;
    },
  },
  {
    // How far real displaced geometry runs below the 3.5 m resolution floor.
    // The one lever here that adds silhouette rather than shading.
    label: 'micro chop',
    format: (v) => v.toFixed(2),
    values: [0, 0.25, 0.5, 0.75, 1.0],
    apply: (s, v) => {
      s.roughness.microChop = v;
    },
  },
  {
    // Fetch. A younger sea is shorter and steeper for the same wind, which is
    // the physical form of "make the waves closer together". Steepness moves
    // with it, because in a preset the two are written as one decision.
    label: 'wind-sea maturity',
    format: (v) => `${(v * 100).toFixed(0)}%`,
    values: [0.4, 0.6, 0.8, 0.9, 0.95],
    apply: (s, v) => {
      s.generatingWind.maturity = v;
      (s as { windSeaSteepness: number }).windSeaSteepness = windSeaSteepnessFor(v);
    },
  },
  {
    // The 375 m hill. Nothing else in the preset is anywhere near this scale,
    // and it is the single largest reason the sea reads as rolling rather than
    // as chaos. Zero disables the primary swell outright.
    label: 'primary swell period',
    format: (v) => (v <= 0 ? 'swell off' : `${v.toFixed(1)} s · L ${(1.56 * v * v).toFixed(0)} m`),
    values: [15.5, 11, 9, 7, 0],
    apply: (s, v) => {
      if (v <= 0) {
        (s.primary as { enabled: boolean }).enabled = false;
        return;
      }
      (s.primary as { peakPeriod: number }).peakPeriod = v;
    },
  },
];

/**
 * Photograph the shape ladder.
 *
 * One row per lever, one column per rung, the preset's own value somewhere in
 * every row. Captioned with the sea each rung actually resolves to rather than
 * with the slider position, because "0.8 maturity" means nothing at a glance
 * and "Hs 6.4 m, Tp 15.5 s" means everything.
 */
export async function captureShapeLadder(
  sim: OceanViolenceContactSheetCapability,
  options: ViolenceEvidenceOptions = {},
): Promise<ViolenceEvidence> {
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.5;
  const progress = options.onProgress ?? (() => undefined);
  const name = options.name ?? 'ocean-shape-ladder';
  /** Low and wide: close enough to feel the sea, wide enough to see its spacing. */
  const VIEW: ViewName = 'horizon';
  const WAVE_TIME = 151;
  /**
   * Whitewater off by default.
   *
   * This ladder is about the shape of the water, and at the shipping coverage
   * gain the whitecaps cover enough of a Southern frame to bury exactly the
   * differences it exists to show — the first run of it was five rows of milk.
   * Foam is the round's subject but it is this sheet's confound.
   */
  const foamStrength = options.foamStrength ?? 0;
  const restoreFoamStrength = sim.ocean.material.uniforms.uFoamStrength.value as number;

  const state = sim.world.state;
  const restoreRate = state.worldSecondsPerRealSecond;
  const restorePaused = state.paused;
  const restoreInstant = state.worldInstantUtcSeconds;
  const restoreSeaState = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;

  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const metrics: ViolenceEvidence['metrics'] = [];
  const reportLines: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };
  const settleAndRender = (count: number): void => {
    for (let i = 0; i < count; i++) {
      pinSize();
      sim.stepSimulation(0);
      sim.renderFrame();
    }
  };

  state.worldSecondsPerRealSecond = 0;
  state.paused = true;
  pinSize();

  try {
    const measuredSun = setSunElevation(sim, restoreInstant, SUN_ELEVATION_DEG);
    const southern = findSeaState('SOUTHERN_OCEAN_ROUGH');
    reportLines.push(
      `ocean shape ladder · sun ${measuredSun.toFixed(1)} deg · ${VIEW} view`,
      `base sea SOUTHERN_OCEAN_ROUGH · wave clock ${WAVE_TIME} s`,
      '',
    );

    for (const lever of SHAPE_LEVERS) {
      for (const value of lever.values) {
        progress(`Shape ladder · ${lever.label} ${lever.format(value)}`);
        const draft = cloneSeaState(southern);
        lever.apply(draft, value);
        sim.setSeaState(draft, 0);
        sim.waves.setTime(WAVE_TIME);
        sim.vessel.body.reset();
        sim.stepSimulation(0);
        applyView(sim, VIEW);
        sim.clearFoam();
        sim.warmFoam();
        sim.setFoamStrength(foamStrength);
        settleAndRender(6);

        const resolved =
          `Hs ${sim.waves.significantHeight.toFixed(2)} m · Tp ${sim.waves.dominantPeriod.toFixed(1)} s` +
          ` · QAk ${sim.waves.steepnessSum.toFixed(2)}`;
        const label = `${lever.label} ${lever.format(value)}`;
        const measured = measureViolence(sim, {
          width: renderWidth,
          height: renderHeight,
          scale: frameScale,
        });
        metrics.push({ label, metrics: measured });
        reportLines.push(`${label}\n  ${resolved}`, formatViolenceMetrics('', measured), '');

        settleAndRender(2);
        const image = grab(sim.canvas, frameScale);
        frames.push({ image, label: `${label} · ${resolved}` });
        captures.push({ label, dataUrl: image.toDataURL('image/jpeg', 0.94) });
      }
    }

    const sheet = buildContactSheet(frames, {
      columns: 5,
      cellWidth: 460,
      title: 'Ocean violence — shape ladder',
      subtitle: `Southern Ocean rough · ${VIEW} view · sun ${measuredSun.toFixed(0)}° · whitewater ${foamStrength > 0 ? 'on' : 'OFF, to show the water'} · rows: ${SHAPE_LEVERS.map((l) => l.label).join(' / ')}`,
    });

    const report = reportLines.join('\n');
    if (options.publish !== false) {
      const published = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
      await postText(`${name}.txt`, report, 'text/plain');
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }

    return {
      title: 'Ocean violence — shape ladder',
      condition: `${SHAPE_LEVERS.length} levers × 5 rungs · ${VIEW} view · sun ${measuredSun.toFixed(0)}°`,
      captures,
      metrics,
      report,
    };
  } finally {
    sim.setFoamStrength(restoreFoamStrength);
    sim.setSeaState(restoreSeaState, 0);
    sim.waves.setTime(restoreWaveTime);
    state.worldInstantUtcSeconds = restoreInstant;
    state.worldSecondsPerRealSecond = restoreRate;
    state.paused = restorePaused;
    sim.refreshLighting();
    sim.clearFoam();
    sim.warmFoam();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    sim.cameras.setViewport(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1));
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}
