import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import {
  RUDDER_LIMIT_DEG,
  type SailingControls,
} from '../vessel/schooner/SailingControls';
import type { SailingCrewSensorReadout } from '../vessel/schooner/crew/CrewObservations';
import { signedAngleDifferenceDeg } from '../vessel/schooner/crew/CompassInstrument';
import type {
  SailingCrew,
  SailingCrewReadout,
} from '../vessel/schooner/crew/SailingCrew';
import { RIG_TRIM_LIMITS, SAILS } from '../vessel/schooner/rig';
import type { SailName } from '../vessel/schooner/rig';
import { VALID_SET_STATES, type SailSetState } from '../vessel/schooner/sailAero';

/**
 * The sailing panel — the plan's reserved `sailing` DevTools entry.
 *
 * S3 gave it the tiller; S4 gives it the whole control surface: a sheet or
 * brace slider per sail inside the rig's own mechanical limits, set-state
 * buttons per sail (reefs where a sail has them), and the fisherman's dip.
 * Everything commands through `SailingControls` — the same rate-limited
 * path any future input uses — so a dragged slider is an *order* and the
 * cloth follows at crew pace. The readout is read back from the physics
 * after it moved: the trim shown is where the boom actually is, the AoA is
 * what the force model computed last substep, and a sail mid-evolution
 * shows its hoist walking.
 *
 * "Release to helm" retires captive heading as the ordinary steering path
 * (S3): the tow harness stays available from the world panel as a
 * diagnostic, but the way back to free sailing lives here.
 */

export interface SailPanelSailState {
  name: SailName;
  state: SailSetState;
  aoaDeg: number;
  luffing: boolean;
  driveN: number;
}

export interface SailingPanelState {
  mode: 'free' | 'captive-tow';
  speedMps: number;
  headingTrueDeg: number;
  yawRateDegPerS: number;
  apparentWindMps: number;
  apparentAngleOffBowDeg: number | null;
  pointOfSail: string | null;
  /** Signed true-wind source angle off the bow — the point of sail proper. */
  trueWindAngleOffBowDeg: number | null;
  rudderBladeDeg: number;
  rudderInflowMps: number;
  rudderEffectiveAoaDeg: number;
  rudderStallFactor: number;
  rudderYawMomentNm: number;
  tack: string;
  driveForwardN: number;
  heelDeg: number;
  luffingCount: number;
  perSail: SailPanelSailState[];
  crew: SailingCrewReadout | null;
  crewSensors: SailingCrewSensorReadout | null;
}

export interface SailingPanelHandle {
  element: HTMLElement;
  update(dtSeconds: number): void;
  dispose(): void;
}

const SAIL_LABELS: Record<SailName, string> = {
  mainsail: 'Main',
  foresail: 'Fore',
  foreStaysail: 'Staysail',
  jib: 'Jib',
  flyingJib: 'Flying jib',
  foreTopsail: 'Topsail (brace)',
  mainTopmastStaysail: 'Fisherman',
  mainGaffTopsail: 'Gaff topsail',
};

const STATE_LABELS: Record<SailSetState, string> = {
  set: 'Set',
  reef1: 'Reef 1',
  reef2: 'Reef 2',
  furled: 'Furl',
};

const FOCUS_LABELS = {
  'looking-ahead': 'LOOKING AHEAD',
  'checking-compass': 'CHECKING COMPASS',
  'watching-response': 'WATCHING RESPONSE',
  'checking-sails-wind': 'CHECKING SAILS / WIND',
} as const;

const ORDER_PHASE_LABELS = {
  idle: 'IDLE',
  ordered: 'ORDERED',
  heard: 'HEARD',
  processing: 'PROCESSING',
  acting: 'ACTING',
  watching: 'WATCHING',
} as const;

export function createSailingPanel(
  controls: SailingControls,
  read: () => SailingPanelState,
  releaseToHelm: () => void,
  crew?: SailingCrew,
): SailingPanelHandle {
  ensurePanelStyle();

  const root = document.createElement('aside');
  root.className = 'devpanel';
  root.style.top = '12px';
  root.style.right = '12px';

  const title = document.createElement('h2');
  title.textContent = 'Drift · sailing';
  root.appendChild(title);

  const group = new ControlGroup(root);

  group.section('Helm');
  group.slider({
    label: 'Tiller (rudder order)',
    min: -RUDDER_LIMIT_DEG,
    max: RUDDER_LIMIT_DEG,
    step: 1,
    value: controls.rudderTargetDeg,
    format: (v) =>
      v === 0 ? 'midships' : `${Math.abs(v).toFixed(0)}° ${v > 0 ? 'port' : 'stbd'}`,
    onChange: (v) => {
      crew?.setDirectHelmTakeover(true);
      controls.commandRudderDeg(v);
    },
    onCommit: () => crew?.setDirectHelmTakeover(false),
    read: () => controls.rudderTargetDeg,
  });
  group.buttons([
    {
      label: 'Midships',
      onClick: () => {
        crew?.setDirectHelmTakeover(true);
        controls.commandRudderDeg(0);
        crew?.setDirectHelmTakeover(false);
      },
      title: 'Centre the helm',
    },
    {
      label: 'Release to helm',
      onClick: releaseToHelm,
      title:
        'Leave the captive tow: free dynamics under sail, steered by the tiller',
    },
  ]);

  if (crew) {
    const opening = read();
    let courseOrderDeg =
      opening.crew?.helmsman.orderedCourseDeg ?? opening.headingTrueDeg;
    group.slider({
      label: 'Spoken compass course',
      min: 0,
      max: 359,
      step: 1,
      value: courseOrderDeg,
      format: (v) => `${Math.round(v).toString().padStart(3, '0')}°`,
      onChange: (v) => {
        courseOrderDeg = v;
      },
      onCommit: (v) => {
        courseOrderDeg = v;
        crew.orderCompassCourse(v);
      },
      read: () => courseOrderDeg,
    });
    group.buttons([
      {
        label: 'Steer current',
        onClick: () => {
          courseOrderDeg = read().headingTrueDeg;
          crew.orderCompassCourse(courseOrderDeg);
        },
        title: 'Speak an order to hold the compass course currently under the bow',
      },
      {
        label: 'Stand down helm',
        onClick: () => crew.standDownHelm(),
        title: 'A spoken stand-down order; it carries ordinary response delay',
      },
    ]);

    let windAngleOrderDeg =
      opening.crew?.helmsman.orderedWindAngleDeg ?? 60;
    group.slider({
      label: 'Spoken wind angle',
      min: 20,
      max: 170,
      step: 5,
      value: windAngleOrderDeg,
      format: (v) => `${Math.round(v)}° off the bow`,
      onChange: (v) => {
        windAngleOrderDeg = v;
      },
      onCommit: (v) => {
        windAngleOrderDeg = v;
        crew.orderApparentWindAngle(v);
      },
      read: () => windAngleOrderDeg,
    });

    group.section('Sheets');
    group.buttons([
      {
        label: 'Trim to draw',
        onClick: () => crew.orderTrimToDraw(),
        title:
          'One spoken order to every sheet station. Each hand hears it in his ' +
          'own time and then works his own sail by eye',
      },
      {
        label: 'Stand down sheets',
        onClick: () => crew.standDownTrim(),
        title: 'The hands leave the sheets where they are',
      },
    ]);
  }

  const crewHud = crew ? createSailingCrewHud(root) : null;

  const formatTrim = (v: number): string =>
    v === 0 ? 'amidships' : `${Math.abs(v).toFixed(0)}° ${v > 0 ? 'port' : 'stbd'}`;

  group.section('Sails');
  for (const sail of SAILS) {
    const name = sail.name;
    if (name === 'mainGaffTopsail') {
      // Slaved to the mainsail sheet (design §5.1) — no trim of its own.
      group.buttons(
        VALID_SET_STATES[name].map((state) => ({
          label: `${SAIL_LABELS[name]}: ${STATE_LABELS[state]}`,
          onClick: () => controls.commandSetState(name, state),
          title: 'Trim follows the mainsail sheet',
        })),
      );
      continue;
    }
    if (name === 'mainTopmastStaysail') {
      group.buttons([
        ...VALID_SET_STATES[name].map((state) => ({
          label: `${SAIL_LABELS[name]}: ${STATE_LABELS[state]}`,
          onClick: () => controls.commandSetState(name, state),
        })),
        {
          label: 'Dip port',
          onClick: () => controls.commandFishermanSide('port'),
          title: 'Work the fisherman around to the port side',
        },
        {
          label: 'Dip stbd',
          onClick: () => controls.commandFishermanSide('starboard'),
          title: 'Work the fisherman around to the starboard side',
        },
      ]);
      continue;
    }
    const limits = RIG_TRIM_LIMITS[name];
    group.slider({
      label: `${SAIL_LABELS[name]} sheet`,
      min: Math.ceil(limits.minDeg),
      max: Math.floor(limits.maxDeg),
      step: 1,
      value: controls.trimDeg(name),
      format: formatTrim,
      onChange: (v) => controls.commandTrimDeg(name, v),
      read: () => controls.trimDeg(name),
    });
    if (VALID_SET_STATES[name].length > 1) {
      group.buttons(
        VALID_SET_STATES[name].map((state) => ({
          label: `${SAIL_LABELS[name]}: ${STATE_LABELS[state]}`,
          onClick: () => controls.commandSetState(name, state),
        })),
      );
    }
  }

  const readout = group.readout();

  const formatSide = (deg: number): string =>
    deg === 0 ? '0°' : `${Math.abs(deg).toFixed(1)}° ${deg > 0 ? 'port' : 'stbd'}`;

  return {
    element: root,
    update: () => {
      const s = read();
      group.sync();
      crewHud?.update(s);
      const apparent =
        s.apparentAngleOffBowDeg === null
          ? `${s.apparentWindMps.toFixed(1)} m/s`
          : `${s.apparentWindMps.toFixed(1)} m/s · ${Math.abs(s.apparentAngleOffBowDeg).toFixed(0)}° ` +
            `(${s.apparentAngleOffBowDeg >= 0 ? 'port' : 'stbd'})` +
            (s.pointOfSail ? ` · ${s.pointOfSail}` : '');
      const sailLines = s.perSail.map((sail) => {
        const hoist = controls.hoistFraction(sail.name);
        const target = controls.targetSetState(sail.name);
        const settled = controls.settledSetState(sail.name);
        const waiting = controls.waitingOn(sail.name);
        const stateWord =
          settled === target
            ? settled
            : waiting
              ? `${settled}→${target} after ${SAIL_LABELS[waiting].toLowerCase()}`
              : `${settled}→${target} ${(hoist * 100).toFixed(0)}%`;
        const trim = controls.trimDeg(sail.name);
        return (
          `${SAIL_LABELS[sail.name].padEnd(12)} ${stateWord.padEnd(14)} ` +
          `${formatSide(trim).padEnd(11)}` +
          (hoist > 0.02
            ? ` AoA ${sail.aoaDeg >= 0 ? '+' : ''}${sail.aoaDeg.toFixed(0)}°` +
              (sail.luffing ? ' LUFF' : ` ${sail.driveN >= 0 ? '+' : ''}${sail.driveN.toFixed(0)} N`)
            : '')
        );
      });
      const crewLines = s.crew && s.crewSensors
        ? formatCrewLines(s.crew, s.crewSensors)
        : [];
      readout.textContent = [
        `mode     ${s.mode === 'free' ? 'free · helm steers' : 'CAPTIVE TOW · release to steer'}`,
        `ship     ${s.speedMps.toFixed(2)} m/s · hdg ${s.headingTrueDeg.toFixed(1)}° · ` +
          `turn ${s.yawRateDegPerS >= 0 ? 'port' : 'stbd'} ${Math.abs(s.yawRateDegPerS).toFixed(2)}°/s`,
        `wind     ${apparent}`,
        `blade    ${formatSide(s.rudderBladeDeg)} (order ${formatSide(controls.rudderTargetDeg)})`,
        `inflow   ${s.rudderInflowMps.toFixed(2)} m/s · AoA ${s.rudderEffectiveAoaDeg.toFixed(1)}°` +
          (s.rudderStallFactor < 1 ? ` · STALL ×${s.rudderStallFactor.toFixed(2)}` : ''),
        `moment   ${(s.rudderYawMomentNm / 1000).toFixed(1)} kNm ` +
          `${s.rudderYawMomentNm >= 0 ? '(bow to port)' : '(bow to stbd)'}`,
        `sails    ${s.tack} tack · drive ${s.driveForwardN.toFixed(0)} N · ` +
          `heel ${s.heelDeg.toFixed(1)}°` +
          (s.luffingCount > 0 ? ` · ${s.luffingCount} luffing` : ''),
        ...crewLines,
        '',
        ...sailLines,
      ].join('\n');
    },
    dispose: () => {
      root.remove();
    },
  };
}

interface SailingCrewHudTracePoint {
  timeSeconds: number;
  orderedCourseDeg: number | null;
  truthHeadingDeg: number;
  indicatedHeadingDeg: number;
  perceivedCompassDeg: number | null;
  requestedRudderDeg: number;
  actualRudderDeg: number;
  intervention: boolean;
}

interface SailingCrewHud {
  update(state: SailingPanelState): void;
}

let sailingCrewHudStyleInstalled = false;

function ensureSailingCrewHudStyle(): void {
  if (sailingCrewHudStyleInstalled) return;
  sailingCrewHudStyleInstalled = true;
  const style = document.createElement('style');
  style.textContent = `
.s5-crew-hud { margin-top: 9px; }
.s5-crew-hud .s5-title {
  margin: 13px 0 6px; padding-top: 7px;
  border-top: 1px solid rgba(255,255,255,.09);
  color: #6d8ba6; font-size: 9.5px; letter-spacing: .13em;
  text-transform: uppercase;
}
.s5-crew-hud canvas {
  display: block; width: 100%; height: auto; margin: 5px 0;
  border: 1px solid rgba(255,255,255,.09); border-radius: 5px;
  background: rgba(2,8,14,.52);
}
.s5-intervention {
  min-height: 18px; margin: 4px 0 2px; color: #7893a9;
  font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase;
}
.s5-intervention.is-live { color: #f0bd72; animation: s5-pulse 900ms ease-out; }
@keyframes s5-pulse {
  0% { background: rgba(240,189,114,.35); box-shadow: 0 0 12px rgba(240,189,114,.45); }
  100% { background: transparent; box-shadow: none; }
}`;
  document.head.appendChild(style);
}

function createSailingCrewHud(root: HTMLElement): SailingCrewHud {
  ensureSailingCrewHudStyle();
  const hud = document.createElement('section');
  hud.className = 's5-crew-hud';
  const title = document.createElement('div');
  title.className = 's5-title';
  title.textContent = 'Human helm · S5 checkpoint';
  const compass = document.createElement('canvas');
  compass.width = 340;
  compass.height = 164;
  compass.setAttribute('aria-label', 'Physical compass card and helm markers');
  const rudder = document.createElement('canvas');
  rudder.width = 340;
  rudder.height = 54;
  rudder.setAttribute('aria-label', 'Requested and actual rudder gauge');
  const tiller = document.createElement('canvas');
  tiller.width = 340;
  tiller.height = 54;
  tiller.setAttribute('aria-label', 'Perceived signed tiller load gauge');
  const intervention = document.createElement('div');
  intervention.className = 's5-intervention';
  intervention.textContent = 'No rudder intervention decided yet';
  const trace = document.createElement('canvas');
  trace.width = 340;
  trace.height = 176;
  trace.setAttribute('aria-label', 'Sixty-second compass and rudder trace');
  hud.append(title, compass, rudder, tiller, intervention, trace);
  root.appendChild(hud);

  const tracePoints: SailingCrewHudTracePoint[] = [];
  let lastTraceTime = -Infinity;
  let lastInterventionSequence = 0;

  return {
    update: (state) => {
      const crew = state.crew?.helmsman;
      const sensors = state.crewSensors;
      if (!crew || !sensors) return;
      const time = sensors.elapsedSeconds;
      if (time < lastTraceTime) {
        tracePoints.length = 0;
        lastTraceTime = -Infinity;
        lastInterventionSequence = 0;
        intervention.textContent = 'No rudder intervention decided yet';
        intervention.classList.remove('is-live');
      }
      const latest = crew.latestIntervention;
      const newIntervention =
        latest !== null && latest.sequenceId > lastInterventionSequence;
      if (newIntervention) {
        lastInterventionSequence = latest.sequenceId;
        const direction =
          latest.requestedRudderDeg === 0
            ? 'EASE MIDSHIPS'
            : `${Math.abs(latest.requestedRudderDeg).toFixed(0)}° ` +
              (latest.requestedRudderDeg > 0 ? 'PORT HELM' : 'STBD HELM');
        intervention.textContent =
          `INTERVENTION ${latest.sequenceId} · ${direction} · ` +
          latest.reason.replaceAll('-', ' ');
        intervention.classList.remove('is-live');
        // Restart the visible decision pulse even when two events share text.
        void intervention.offsetWidth;
        intervention.classList.add('is-live');
      }
      // Never drop an event marker merely because its decision happened
      // between the regular 0.2-second trace samples.
      if (newIntervention || time - lastTraceTime >= 0.2) {
        tracePoints.push({
          timeSeconds: time,
          orderedCourseDeg: crew.orderedCourseDeg,
          truthHeadingDeg: sensors.devTruth.headingDeg,
          indicatedHeadingDeg: sensors.compass.indicatedHeadingDeg,
          perceivedCompassDeg: sensors.helmObservation.compass.readingDeg,
          requestedRudderDeg: sensors.devTruth.rudderTargetDeg,
          actualRudderDeg: sensors.devTruth.rudderActualDeg,
          intervention: newIntervention,
        });
        lastTraceTime = time;
        while (
          tracePoints.length > 0 &&
          tracePoints[0].timeSeconds < time - 60
        ) {
          tracePoints.shift();
        }
      }
      drawCompassCard(compass, state, crew, sensors);
      drawRudderGauge(rudder, sensors);
      drawTillerGauge(tiller, sensors);
      drawCrewTrace(trace, tracePoints);
    },
  };
}

function drawCompassCard(
  canvas: HTMLCanvasElement,
  state: SailingPanelState,
  crew: SailingCrewReadout['helmsman'],
  sensors: SailingCrewSensorReadout,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = 73;
  const radius = 58;
  const indicated = sensors.compass.indicatedHeadingDeg;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(185,210,229,.38)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radius + 4, 0, Math.PI * 2);
  ctx.stroke();
  for (let heading = 0; heading < 360; heading += 10) {
    const angle = ((heading - indicated - 90) * Math.PI) / 180;
    const major = heading % 30 === 0;
    const inner = radius - (major ? 9 : 5);
    ctx.strokeStyle = major
      ? 'rgba(222,234,243,.82)'
      : 'rgba(175,199,217,.40)';
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    ctx.stroke();
    if (major) {
      const label =
        heading === 0
          ? 'N'
          : heading === 90
            ? 'E'
            : heading === 180
              ? 'S'
              : heading === 270
                ? 'W'
                : String(heading / 10);
      ctx.fillStyle = heading === 0 ? '#df8d78' : '#a9bdcd';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        label,
        Math.cos(angle) * (radius - 17),
        Math.sin(angle) * (radius - 17),
      );
    }
  }
  drawCompassMarker(ctx, crew.orderedCourseDeg, indicated, radius + 1, '#efb45f', 'diamond');
  drawCompassMarker(
    ctx,
    sensors.helmObservation.compass.readingDeg,
    indicated,
    radius - 25,
    '#75d2a4',
    'dot',
  );
  drawCompassMarker(
    ctx,
    state.headingTrueDeg,
    indicated,
    radius + 8,
    'rgba(190,198,207,.38)',
    'tick',
  );
  ctx.restore();

  // Fixed lubber line: the card moves underneath this mark.
  ctx.fillStyle = '#f2e6c8';
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius - 8);
  ctx.lineTo(cx - 5, cy - radius - 17);
  ctx.lineTo(cx + 5, cy - radius - 17);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(242,230,200,.75)';
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius + 1);
  ctx.lineTo(cx, cy - radius + 16);
  ctx.stroke();
  ctx.fillStyle = '#dce8f1';
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${formatHeading(indicated)} CARD`, cx, 145);
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#efb45f';
  ctx.fillText('◆ ORDER', 8, 158);
  ctx.fillStyle = '#75d2a4';
  ctx.fillText('● PERCEIVED', 85, 158);
  ctx.fillStyle = 'rgba(190,198,207,.58)';
  ctx.fillText('│ DEV TRUTH', 190, 158);
}

function drawCompassMarker(
  ctx: CanvasRenderingContext2D,
  headingDeg: number | null,
  indicatedDeg: number,
  radius: number,
  color: string,
  shape: 'diamond' | 'dot' | 'tick',
): void {
  if (headingDeg === null) return;
  const angle = ((headingDeg - indicatedDeg - 90) * Math.PI) / 180;
  const x = Math.cos(angle) * radius;
  const y = Math.sin(angle) * radius;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + Math.PI / 2);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (shape === 'diamond') {
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(4, 0);
    ctx.lineTo(0, 5);
    ctx.lineTo(-4, 0);
    ctx.closePath();
    ctx.fill();
  } else if (shape === 'dot') {
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(0, 4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRudderGauge(
  canvas: HTMLCanvasElement,
  sensors: SailingCrewSensorReadout,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const left = 18;
  const right = canvas.width - 18;
  const centre = (left + right) / 2;
  const y = 26;
  ctx.strokeStyle = 'rgba(170,198,219,.35)';
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(220,232,241,.55)';
  ctx.beginPath();
  ctx.moveTo(centre, y - 8);
  ctx.lineTo(centre, y + 8);
  ctx.stroke();
  const map = (value: number) =>
    centre + (clamp(value, -RUDDER_LIMIT_DEG, RUDDER_LIMIT_DEG) / RUDDER_LIMIT_DEG) *
      (right - centre);
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#6ea9d2';
  ctx.beginPath();
  ctx.moveTo(centre, y);
  ctx.lineTo(map(sensors.devTruth.rudderActualDeg), y);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#efb45f';
  const targetX = map(sensors.devTruth.rudderTargetDeg);
  ctx.beginPath();
  ctx.moveTo(targetX, y - 10);
  ctx.lineTo(targetX, y + 10);
  ctx.stroke();
  ctx.fillStyle = '#9eb5c8';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('STBD', left, 48);
  ctx.textAlign = 'right';
  ctx.fillText('PORT', right, 48);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c9d8e4';
  ctx.fillText(
    `RUDDER actual ${signed(sensors.devTruth.rudderActualDeg, 1)}° · target ${signed(sensors.devTruth.rudderTargetDeg, 0)}°`,
    centre,
    11,
  );
}

function drawTillerGauge(
  canvas: HTMLCanvasElement,
  sensors: SailingCrewSensorReadout,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cue = sensors.helmObservation.tillerLoad;
  const left = 18;
  const right = canvas.width - 18;
  const centre = (left + right) / 2;
  const y = 27;
  const maximum = 100;
  ctx.strokeStyle = 'rgba(170,198,219,.35)';
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(220,232,241,.55)';
  ctx.beginPath();
  ctx.moveTo(centre, y - 7);
  ctx.lineTo(centre, y + 7);
  ctx.stroke();
  const x =
    centre +
    (clamp(cue.signedHandForceN, -maximum, maximum) / maximum) *
      (right - centre);
  ctx.lineWidth = 5;
  ctx.strokeStyle = cue.weight === 'heavy' ? '#df806f' : '#75d2a4';
  ctx.beginPath();
  ctx.moveTo(centre, y);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.fillStyle = '#c9d8e4';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    `TILLER LOAD ${signed(cue.signedHandForceN, 0)} N · ${cue.weight} · ${cue.trend}`.toUpperCase(),
    centre,
    11,
  );
  ctx.fillStyle = '#829cb1';
  ctx.textAlign = 'left';
  ctx.fillText('STBD HELM', left, 49);
  ctx.textAlign = 'right';
  ctx.fillText('PORT HELM', right, 49);
}

function drawCrewTrace(
  canvas: HTMLCanvasElement,
  points: readonly SailingCrewHudTracePoint[],
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#718a9e';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('60 S TRACE · COURSE', 8, 11);
  ctx.fillText('RUDDER', 8, 113);
  if (points.length < 2) return;
  const latest = points[points.length - 1];
  const startTime = Math.max(latest.timeSeconds - 60, points[0].timeSeconds);
  const span = Math.max(latest.timeSeconds - startTime, 1);
  const xAt = (time: number) =>
    8 + ((time - startTime) / span) * (canvas.width - 16);
  const courseCentre =
    latest.orderedCourseDeg ?? latest.truthHeadingDeg;
  const headingY = (heading: number) =>
    61 -
    (clamp(signedAngleDifferenceDeg(heading, courseCentre), -10, 10) / 10) *
      42;
  const rudderY = (degrees: number) =>
    143 - (clamp(degrees, -RUDDER_LIMIT_DEG, RUDDER_LIMIT_DEG) / RUDDER_LIMIT_DEG) * 24;

  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  ctx.beginPath();
  ctx.moveTo(8, 61);
  ctx.lineTo(canvas.width - 8, 61);
  ctx.moveTo(8, 143);
  ctx.lineTo(canvas.width - 8, 143);
  ctx.stroke();
  for (const point of points) {
    if (!point.intervention || point.timeSeconds < startTime) continue;
    const x = xAt(point.timeSeconds);
    ctx.strokeStyle = 'rgba(240,180,95,.45)';
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x, 168);
    ctx.stroke();
  }
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.orderedCourseDeg, headingY, '#efb45f');
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.truthHeadingDeg, headingY, 'rgba(190,198,207,.48)');
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.indicatedHeadingDeg, headingY, '#6ea9d2');
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.perceivedCompassDeg, headingY, '#75d2a4');
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.requestedRudderDeg, rudderY, '#efb45f');
  drawTraceLine(ctx, points, startTime, xAt, (p) => p.actualRudderDeg, rudderY, '#6ea9d2');
  ctx.fillStyle = '#6ea9d2';
  ctx.fillText('CARD / ACTUAL', 183, 11);
  ctx.fillStyle = '#75d2a4';
  ctx.fillText('PERCEIVED', 273, 11);
}

function drawTraceLine(
  ctx: CanvasRenderingContext2D,
  points: readonly SailingCrewHudTracePoint[],
  startTime: number,
  xAt: (time: number) => number,
  valueAt: (point: SailingCrewHudTracePoint) => number | null,
  yAt: (value: number) => number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  let drawing = false;
  for (const point of points) {
    if (point.timeSeconds < startTime) continue;
    const value = valueAt(point);
    if (value === null) {
      drawing = false;
      continue;
    }
    const x = xAt(point.timeSeconds);
    const y = yAt(value);
    if (drawing) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      drawing = true;
    }
  }
  ctx.stroke();
}

function formatCrewLines(
  crew: SailingCrewReadout,
  sensors: SailingCrewSensorReadout,
): string[] {
  const helm = crew.helmsman;
  const response = helm.orderResponse;
  const phase =
    response?.order.kind === 'stand-down-helm' && helm.orderPhase !== 'watching'
      ? `STANDING DOWN · ${ORDER_PHASE_LABELS[helm.orderPhase]}`
      : ORDER_PHASE_LABELS[helm.orderPhase];
  const course =
    helm.orderedWindAngleDeg !== null
      ? `${Math.round(helm.orderedWindAngleDeg)}° off the bow ordered`
      : helm.orderedCourseDeg === null
        ? 'no standing course'
        : `${formatHeading(helm.orderedCourseDeg)} ordered`;
  const timing = response
    ? `say ${response.order.utteranceDurationSeconds.toFixed(2)}s · ` +
      `recognise ${response.timing.recognitionDelaySeconds.toFixed(2)}s · ` +
      `process ${response.timing.processingDelaySeconds.toFixed(2)}s · ` +
      `motor ${response.timing.motorInitiationDelaySeconds.toFixed(2)}s`
    : 'no spoken order in the station pipeline';
  const wind = sensors.helmObservation.windAndSails;
  const perceived = sensors.helmObservation.compass.readingDeg;
  const compassAge = sensors.helmObservation.compass.ageSeconds;
  const latest = helm.latestIntervention;
  return [
    `human    ${course} · ${phase}`,
    `focus    ${FOCUS_LABELS[helm.focus]} · ${helm.actionPhase.toUpperCase()}` +
      (helm.directTakeover ? ' · PLAYER HAS TILLER' : '') +
      (helm.reacquiring ? ' · REACQUIRING' : ''),
    `order    ${timing}`,
    `compass  card ${formatHeading(sensors.compass.indicatedHeadingDeg)} · ` +
      `seen ${perceived === null ? '---' : formatHeading(perceived)} · ` +
      `memory ${Number.isFinite(compassAge) ? `${compassAge.toFixed(1)}s` : 'unacquired'}`,
    `body     bow ${sensors.helmObservation.shipHead.swing} ` +
      `${sensors.helmObservation.shipHead.strength} · ` +
      `load ${signed(sensors.helmObservation.tillerLoad.signedHandForceN, 0)} N ` +
      sensors.helmObservation.tillerLoad.trend,
    latest
      ? `decision #${latest.sequenceId} ${signed(latest.requestedRudderDeg, 0)}° · ` +
        `${latest.reason.replaceAll('-', ' ')} · by ${latest.reference} · ` +
        `motor at ${latest.executeAtSeconds.toFixed(2)}s`
      : 'decision none yet',
    `vane     ${
      wind.angleOffBowDeg === null
        ? 'not looked at'
        : `${Math.round(wind.angleOffBowDeg)}° off the bow, ${wind.side} · ` +
          `seen ${wind.angleAgeSeconds.toFixed(1)}s ago`
    } · cloth ${wind.cloth}`,
    ...crew.trimmers.stations.map((station) => {
      const adjustment = station.latestAdjustment;
      const what = !station.standing
        ? 'no standing order'
        : station.cannotDraw
          ? 'REPORTS SHE WILL NOT DRAW'
          : station.directTakeover
            ? 'PLAYER HAS THIS SHEET'
            : `${ORDER_PHASE_LABELS[station.orderPhase]} · ${station.lastDecision}`;
      const last = adjustment
        ? ` · ${adjustment.decision} ${adjustment.previousTrimDeg.toFixed(0)}°` +
          `→${adjustment.requestedTrimDeg.toFixed(0)}° at ` +
          `${adjustment.executeAtSeconds.toFixed(1)}s, saw ${adjustment.cloth}`
        : '';
      return `  ${station.station.padEnd(15)}${what}${last}`;
    }),
  ];
}

function formatHeading(value: number): string {
  const wrapped = ((value % 360) + 360) % 360;
  return `${Math.round(wrapped).toString().padStart(3, '0')}°`;
}

function signed(value: number, digits: number): string {
  const rounded = value.toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
