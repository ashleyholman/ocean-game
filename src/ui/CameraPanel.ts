import type { CameraSystem } from '../camera/CameraSystem';
import { DEFAULT_LOOK_CONTROL } from '../camera/CameraSystem';
import { DEFAULT_STABILISATION } from '../camera/EmbodiedCameraController';
import { CINEMATIC_KNOTS } from '../camera/cameraTuning';
import { ControlGroup, ensurePanelStyle } from './controls';

/**
 * Developer controls and telemetry for the camera.
 *
 * A panel inside the shared developer-tools shell, dynamically imported so none
 * of it exists until it is opened. It replaces the old 22-60 m distance slider,
 * which is no longer a meaningful control: distance is now one output of a
 * curve, alongside altitude and framing, and a slider that set it directly
 * would silently contradict the altitude the composition depends on.
 *
 * TWO KINDS OF ROW
 * ----------------
 * Sliders drive the model. The readout *measures* it — every number below is
 * read back from the state the controllers actually produced this frame, so a
 * clamp, a transition or a water-clearance solve shows up here instead of being
 * hidden behind the value that was asked for.
 */
export function createCameraPanel(cameras: CameraSystem): {
  element: HTMLElement;
  update(dt: number): void;
  dispose(): void;
} {
  ensurePanelStyle();

  const root = document.createElement('aside');
  root.className = 'devpanel';
  root.style.top = '12px';
  root.style.right = '12px';

  const title = document.createElement('h2');
  title.textContent = 'Drift · camera';
  root.appendChild(title);

  const controls = new ControlGroup(root);
  const range = cameras.range;

  controls.section('Mode');
  controls.select(
    'Active mode',
    [
      { value: 'cinematic', label: 'Cinematic (external)' },
      { value: 'embodied', label: 'Embodied (on vessel)' },
    ],
    cameras.modeName,
    (value) => cameras.setMode(value === 'embodied' ? 'embodied' : 'cinematic'),
    () => cameras.modeName,
  );
  controls.slider({
    label: 'Transition duration',
    min: 0.25,
    max: 3,
    step: 0.05,
    value: 1,
    format: (v) => `${v.toFixed(2)}× solved`,
    onChange: (v) => {
      cameras.transition.durationScale = v;
    },
    read: () => cameras.transition.durationScale,
  });

  controls.section('Cinematic scale');
  controls.slider({
    label: 'Cinematic scale',
    min: 0,
    max: 1,
    step: 0.001,
    value: cameras.cinematicScale,
    format: (v) => v.toFixed(3),
    onChange: (v) => cameras.cinematic.setScale(v),
    read: () => cameras.cinematicScale,
  });
  // Kept because it is the number a reviewer asks for by name. It sets the
  // scale that *produces* that distance rather than overriding it, so altitude
  // and framing follow instead of being left behind.
  controls.slider({
    label: 'Camera distance',
    min: Math.round(range.minDistance),
    max: Math.round(range.maxDistance),
    step: 0.5,
    value: 36,
    format: (v) => `${v.toFixed(1)} m`,
    onChange: (v) => cameras.setDistance(v),
    read: () => cameras.cinematic.distance,
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
  controls.checkbox(
    'Invert look (both axes)',
    cameras.lookControl.invert,
    (on) => {
      cameras.lookControl.invert = on;
    },
    () => cameras.lookControl.invert,
  );

  controls.section('Head stabilisation');
  const stabilisation = cameras.stabilisation;
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
  controls.slider({
    // The M5 term, and the only one that is not 1 anywhere but the masthead.
    // `vessel/schooner/aloftComfort.ts` derives what it is aloft and why the
    // answer is 0.87 rather than something braver; this is the dial that lets
    // the next person disagree with it from inside the view, which is how the
    // roll and pitch fractions were settled in the first place.
    label: 'Sway follow',
    min: 0,
    max: 1,
    step: 0.01,
    value: stabilisation.swayFollow,
    format: (v) => `${(v * 100).toFixed(0)} %`,
    onChange: (v) => {
      stabilisation.swayFollow = v;
    },
    read: () => stabilisation.swayFollow,
  });
  controls.slider({
    label: 'Stabilisation smoothing',
    min: 0.02,
    max: 1.5,
    step: 0.01,
    value: stabilisation.smoothingSeconds,
    format: (v) => `${v.toFixed(2)} s`,
    onChange: (v) => {
      stabilisation.smoothingSeconds = v;
    },
    read: () => stabilisation.smoothingSeconds,
  });

  controls.section('Reset');
  controls.buttons([
    {
      label: 'Cinematic',
      title: 'Back to the authored default composition',
      onClick: () => cameras.resetCinematic(),
    },
    {
      label: 'Embodied look',
      title: 'Face the way the castaway faces',
      onClick: () => cameras.resetEmbodiedLook(),
    },
    {
      label: 'Head follow',
      title: 'Restore the shipped stabilisation model',
      onClick: () => {
        Object.assign(stabilisation, DEFAULT_STABILISATION);
      },
    },
    {
      label: 'Look',
      title: 'Restore the shipped look sensitivity and direction',
      onClick: () => {
        Object.assign(cameras.lookControl, DEFAULT_LOOK_CONTROL);
      },
    },
  ]);

  controls.section('Measured');
  const readout = controls.readout();

  let accumulated = 0;

  return {
    element: root,
    update(dt: number): void {
      accumulated += dt;
      if (accumulated < 0.1) return;
      accumulated = 0;
      controls.sync();

      const t = cameras.telemetry();
      readout.textContent = [
        `mode       ${t.mode}${t.transitioning ? ` · moving ${(t.transitionProgress * 100).toFixed(0)}%` : ''}`,
        `scale      ${t.cinematicScale.toFixed(4)}`,
        '',
        `distance   ${t.distance.toFixed(1)} m slant`,
        `horizontal ${t.horizontalDistance.toFixed(1)} m`,
        `altitude   ${t.altitude.toFixed(1)} m above vessel waterline`,
        `elevation  ${t.orbitElevationDeg.toFixed(2)}° orbit`,
        `pitch      ${t.opticalPitchDeg.toFixed(2)}° optical, down`,
        `horizon    ${(t.horizonFromTop * 100).toFixed(1)}% from top`,
        `tripod     ${t.tripodLocked ? 'locked' : `Y ${t.verticalCorrection >= 0 ? '+' : ''}${t.verticalCorrection.toFixed(2)} m`}`,
        `ship frame x ${(t.vesselFrameLeft * 100).toFixed(1)}–${(t.vesselFrameRight * 100).toFixed(1)}% · y ${(t.vesselFrameTop * 100).toFixed(1)}–${(t.vesselFrameBottom * 100).toFixed(1)}%`,
        `waterline  ${(t.waterlineFramePosition * 100).toFixed(1)}% from top`,
        `fov        ${t.fovDeg.toFixed(2)}° vertical`,
        `near       ${t.nearPlane.toFixed(3)} m`,
        '',
        `look yaw   ${t.lookYawDeg.toFixed(1)}° vessel-relative`,
        `look pitch ${t.lookPitchDeg.toFixed(1)}°`,
        '',
        `range      ${cameras.range.minDistance.toFixed(1)}–${cameras.range.maxDistance.toFixed(0)} m`,
        `           ${cameras.range.minAltitude.toFixed(1)}–${cameras.range.maxAltitude.toFixed(0)} m altitude`,
        `knots      ${CINEMATIC_KNOTS.length} authored compositions`,
      ].join('\n');
    },
    dispose(): void {
      root.remove();
    },
  };
}
