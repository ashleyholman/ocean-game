/**
 * Cross-revision GPU benchmark scenarios.
 *
 * The historical clock offsets and render size come from OCEAN_PERF_HANDOVER.
 * Every camera is explicit so later camera tuning cannot silently change what
 * a revision benchmark sees.
 */

export const BASE_WORLD_UTC_SECONDS = 1_768_532_100;

export const RENDER_SURFACE = Object.freeze({
  cssWidth: 1280,
  cssHeight: 720,
  dpr: 2,
  backingWidth: 2560,
  backingHeight: 1440,
});

export const HISTORICAL_REFERENCES = Object.freeze({
  // Accepted 2026-08-03 standalone-Metal results for 513fe5a. These replace
  // the earlier agent-browser-pane figures that did not reproduce under the
  // final measurement contract.
  'day-production-medium': 24.675,
  'sunset-production-medium': 38.644,
  'night-production-medium': 24.606,
  'day-calm-medium': 23.606,
  'day-rough-medium': 33.212,
  'day-production-close': 19.962,
  'day-production-high': 16.725,
  'afternoon-rough-medium': 28.256,
});

const TIMES = Object.freeze({
  day: { label: 'Day', offsetHours: 21.6 },
  // Four hours after the historical "day" instant: mid-afternoon local time
  // at the opening longitude of the time, on the fixed canonical date.
  afternoon: { label: 'Afternoon', offsetHours: 25.6 },
  sunset: { label: 'Sunset', offsetHours: 17 },
  night: { label: 'Night', offsetHours: 10 },
});

const SEAS = Object.freeze({
  calm: { label: 'Dead calm', preset: 'DEAD_CALM' },
  production: { label: 'Production', preset: 'CURRENT_MODERATE' },
  rough: { label: 'Southern Ocean rough', preset: 'SOUTHERN_OCEAN_ROUGH' },
});

/**
 * Cameras come in two kinds, and the second one is new.
 *
 * `orbit` is the historical shape: a cinematic rig at a distance and altitude
 * from the vessel. Every published number in `HISTORICAL_REFERENCES` was taken
 * through one, so its behaviour is frozen.
 *
 * `stand` puts the eye at a named `stations.ts` position with an explicit look
 * direction, which is the only way to ask a question about what is drawn BELOW
 * DECKS. The interior round owes such a number — `SHIP_INTERIOR_HANDOVER` §20.8
 * wants the night cost of lamp shadowing, worst case five lit lamps by six cube
 * faces, thirty shadow passes — and the suite could not previously express a
 * scenario in which any of those lamps is in frame.
 */
const CAMERAS = Object.freeze({
  close: { kind: 'orbit', label: 'Close horizon', distanceM: 9, altitudeM: 0.9 },
  medium: { kind: 'orbit', label: 'Medium', distanceM: 34, altitudeM: 9 },
  high: { kind: 'orbit', label: 'Maximum high', distanceM: 1400, altitudeM: 267 },
  // Yaw 0 = toward the bow, 180 = the stern; positive pitch up. Same
  // convention as `?look=` and `tools/inspect-view.mjs`, deliberately, so a
  // scenario can be reproduced by eye from the URL before it is measured.
  'cabin-aft': {
    kind: 'stand',
    label: 'Cabin, looking aft',
    stand: 'Cabin',
    lookYawDeg: 180,
    lookPitchDeg: 0,
  },
  'wardroom-forward': {
    kind: 'stand',
    label: 'Wardroom, looking forward',
    stand: 'Wardroom',
    lookYawDeg: 0,
    lookPitchDeg: 0,
  },
  'forecastle-aft': {
    kind: 'stand',
    label: 'Forecastle, looking aft',
    stand: 'Forecastle',
    lookYawDeg: 180,
    lookPitchDeg: 0,
  },
  'deck-waist': {
    kind: 'stand',
    label: 'Deck at the waist',
    stand: 'Waist',
    lookYawDeg: 140,
    lookPitchDeg: 0,
  },
});

/**
 * Lantern policy for a scenario.
 *
 * `lamps` is the mode all four interior lamps are forced to; `lampsShadow` is
 * the occlusion-shadow A/B arm. Both are already live parameters on
 * `InspectionHost` and live methods on `window.__drift`, so this is scenario
 * plumbing over an existing capability rather than a new one. `null` means
 * "leave the session's own policy alone", which is what every pre-existing
 * scenario does and must keep doing.
 */
function lampPolicy(options) {
  const lamps = options.lamps ?? null;
  if (lamps !== null && !['auto', 'on', 'off'].includes(lamps)) {
    throw new Error(`lamps wants auto | on | off, got ${lamps}`);
  }
  const lampsShadow = options.lampsShadow ?? null;
  if (lampsShadow !== null && typeof lampsShadow !== 'boolean') {
    throw new Error(`lampsShadow wants a boolean, got ${lampsShadow}`);
  }
  return { lamps, lampsShadow };
}

function scenario(time, sea, camera, options = {}) {
  const timeSpec = TIMES[time];
  const seaSpec = SEAS[sea];
  const cameraSpec = CAMERAS[camera];
  if (!timeSpec) throw new Error(`unknown time '${time}'`);
  if (!seaSpec) throw new Error(`unknown sea '${sea}'`);
  if (!cameraSpec) throw new Error(`unknown camera '${camera}'`);
  const { lamps, lampsShadow } = lampPolicy(options);
  const suffix = options.idSuffix ? `-${options.idSuffix}` : '';
  return Object.freeze({
    id: `${time}-${sea}-${camera}${suffix}`,
    label:
      `${timeSpec.label} · ${seaSpec.label} · ${cameraSpec.label}` +
      (lampsShadow === null ? '' : ` · lamp shadows ${lampsShadow ? 'on' : 'off'}`),
    time: timeSpec.label,
    timeOffsetHours: timeSpec.offsetHours,
    seaState: seaSpec.preset,
    seaLabel: seaSpec.label,
    camera: cameraSpec,
    lamps,
    lampsShadow,
    attribution: options.attribution === true,
    // Only the historical orbital ids have published references; a stand
    // scenario deliberately has none until a cold machine produces one.
    historicalReferenceMs: HISTORICAL_REFERENCES[`${time}-${sea}-${camera}`],
  });
}

const historical = Object.freeze([
  scenario('day', 'production', 'medium', { attribution: true }),
  scenario('sunset', 'production', 'medium'),
  scenario('night', 'production', 'medium'),
]);

const representative = Object.freeze([
  ...historical,
  scenario('day', 'calm', 'medium'),
  scenario('day', 'rough', 'medium'),
  scenario('day', 'production', 'close'),
  scenario('day', 'production', 'high'),
]);

const southernAfternoon = Object.freeze([
  scenario('afternoon', 'rough', 'medium', { attribution: true }),
]);

/**
 * The interior lamp-shadow question, in the four frames it needs.
 *
 * `SHIP_INTERIOR_HANDOVER` §20.8: what does a night frame below decks cost
 * with the lanterns' cap-occlusion shadows on against off? The arms are
 * adjacent and alternating for the usual reason — a machine that drifts
 * between two long blocks puts its drift in the answer — and every scenario
 * forces `lamps: 'on'` so the worst case is actually present rather than left
 * to whichever rooms a latch happened to light.
 *
 * The deck frame is the control: same night, same lamp policy, eye outside, so
 * a delta that turns up there is not a below-decks cost.
 *
 * NO NUMBER IS RECORDED HERE. This suite exists so a cold machine can be asked
 * the question; the answer is not this session's to give.
 */
const interiorLamps = Object.freeze(
  ['cabin-aft', 'wardroom-forward', 'forecastle-aft', 'deck-waist'].flatMap(
    (camera) =>
      [true, false].map((lampsShadow) =>
        scenario('night', 'production', camera, {
          lamps: 'on',
          lampsShadow,
          idSuffix: lampsShadow ? 'shadow-on' : 'shadow-off',
        }),
      ),
  ),
);

const full = Object.freeze(
  ['day', 'sunset', 'night'].flatMap((time) =>
    Object.keys(SEAS).flatMap((sea) =>
      Object.keys(CAMERAS).map((camera) =>
        scenario(time, sea, camera, {
          attribution: time === 'day' && sea === 'production' && camera === 'medium',
        }),
      ),
    ),
  ),
);

export const SUITES = Object.freeze({
  smoke: Object.freeze([historical[0]]),
  historical,
  representative,
  'southern-afternoon': southernAfternoon,
  'interior-lamps': interiorLamps,
  full,
});

export const DEFAULT_MEASUREMENT = Object.freeze({
  warmFrames: 180,
  stateSettleFrames: 12,
  totalBatches: 9,
  framesPerBatch: 8,
  attributionPairs: 8,
  attributionFrames: 6,
  toggleWarmFrames: 2,
  fence: 'pixel',
});

export function buildSuiteConfig(name, overrides = {}) {
  const scenarios = SUITES[name];
  if (!scenarios) {
    throw new Error(
      `Unknown suite “${name}”. Choose one of: ${Object.keys(SUITES).join(', ')}`,
    );
  }
  return {
    schemaVersion: 1,
    suite: name,
    baseWorldUtcSeconds: BASE_WORLD_UTC_SECONDS,
    renderSurface: { ...RENDER_SURFACE },
    measurement: { ...DEFAULT_MEASUREMENT, ...overrides },
    scenarios: scenarios.map((entry) => ({
      ...entry,
      camera: { ...entry.camera },
    })),
  };
}

/**
 * What a scenario claims about the frame it will be measured in.
 *
 * The browser harness applies a scenario and then reads the live state back;
 * this is the comparison that decides whether the two agree. It lives here,
 * beside the scenario definitions, because a mismatch between what a suite
 * asked for and what a revision drew is the failure mode that makes a
 * cross-revision number meaningless — the same failure `render/renderTier.ts`
 * closes for captures.
 *
 * `actual` comes from the page: `{ cameraMode, eye: {x,y,z}, lookYawDeg,
 * lookPitchDeg, lamps, lampsShadow }`. Absent fields are only tolerated where
 * the scenario itself stated nothing.
 */
export function scenarioFaults(scenario, actual, options = {}) {
  const faults = [];
  const positionToleranceM = options.positionToleranceM ?? 0.05;
  const angleToleranceDeg = options.angleToleranceDeg ?? 0.5;
  const camera = scenario.camera;

  if (camera.kind === 'stand') {
    if (actual.cameraMode !== 'embodied') {
      faults.push(
        `camera mode: a stand scenario needs the embodied camera, got ${actual.cameraMode}`,
      );
    }
    if (actual.standRefused === true) {
      faults.push(
        `stand '${camera.stand}': the walker refused it, so the eye is not where ` +
          `the scenario says`,
      );
    }
    if (actual.standResolved && typeof actual.eye?.x === 'number') {
      const dx = actual.eye.x - actual.standResolved.x;
      const dz = actual.eye.z - actual.standResolved.z;
      const drift = Math.hypot(dx, dz);
      if (drift > positionToleranceM) {
        faults.push(
          `stand '${camera.stand}': eye is ${drift.toFixed(3)} m from the station ` +
            `(tolerance ${positionToleranceM} m)`,
        );
      }
    }
    for (const [field, wanted] of [
      ['lookYawDeg', camera.lookYawDeg],
      ['lookPitchDeg', camera.lookPitchDeg],
    ]) {
      const got = actual[field];
      if (typeof got !== 'number' || Math.abs(angleDelta(got, wanted)) > angleToleranceDeg) {
        faults.push(`${field}: asked for ${wanted}, got ${got}`);
      }
    }
  } else {
    if (actual.cameraMode !== 'cinematic') {
      faults.push(
        `camera mode: an orbit scenario needs the cinematic camera, got ${actual.cameraMode}`,
      );
    }
  }

  if (scenario.lamps !== null && scenario.lamps !== undefined) {
    if (actual.lamps !== scenario.lamps) {
      faults.push(`lamps: asked for ${scenario.lamps}, live mode is ${actual.lamps}`);
    }
  }
  if (scenario.lampsShadow !== null && scenario.lampsShadow !== undefined) {
    if (actual.lampsShadow !== scenario.lampsShadow) {
      faults.push(
        `lampsShadow: asked for ${scenario.lampsShadow}, live value is ${actual.lampsShadow}` +
          (actual.lampsShadow === undefined
            ? ' — no lamp reported one, so the vessel may have no interior lamps'
            : ''),
      );
    }
  }

  return faults;
}

/** Signed smallest angle between two degree values. */
function angleDelta(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** Throw unless the frame about to be measured is the one the suite asked for. */
export function assertScenarioApplied(scenario, actual, options) {
  const faults = scenarioFaults(scenario, actual, options);
  if (faults.length === 0) return;
  throw new Error(
    `scenario '${scenario.id}' did not take:\n  - ${faults.join('\n  - ')}`,
  );
}
