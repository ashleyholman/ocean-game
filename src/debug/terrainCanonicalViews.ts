import type { CameraMode } from '../camera/CameraSystem';
import type {
  CaptureSceneSpec,
  CaptureSurfaceSpec,
} from './captureHost';

export const TERRAIN_CANONICAL_TABLE_ID =
  'terr-135-r1-synthetic-canonical-v1';
export const TERRAIN_CANONICAL_SCHEMA_VERSION = 1;

export const TERRAIN_CANONICAL_HIGH_RISK_PAIRINGS = [
  'low-sun-rough-sea-coastline',
  'temporal-resolve-identical-view',
  'maximum-cinematic-far-ocean',
  'cloud-occlusion-peak',
] as const;

export type TerrainCanonicalHighRiskPairing =
  (typeof TERRAIN_CANONICAL_HIGH_RISK_PAIRINGS)[number];

export type TerrainCanonicalDimension =
  | 'range-1km'
  | 'range-5km'
  | 'range-20km'
  | 'range-80km'
  | 'range-200km'
  | 'range-300km'
  | 'camera-embodied'
  | 'camera-cinematic-default'
  | 'camera-cinematic-maximum'
  | 'light-midday'
  | 'light-low-angle'
  | 'sea-calm'
  | 'sea-rough'
  | 'motion-stationary'
  | 'motion-slow-orbit'
  | 'motion-accelerated-travel'
  | 'temporal-resolve-off-on'
  | 'tier-production-desktop'
  | 'tier-fixed-lower-power';

export type TerrainCanonicalFixtureId =
  | 'low-coast'
  | 'headland'
  | 'mountain'
  | 'peak';

export type TerrainCanonicalDepthMode =
  | 'conventional'
  | 'log'
  | 'reversed';

export interface TerrainCanonicalPageSpec {
  readonly fixture: TerrainCanonicalFixtureId;
  readonly rangeKm: number;
  readonly bearingDeg: number;
  readonly farKm: number;
  readonly hazeKm: number;
  readonly depthMode: TerrainCanonicalDepthMode;
}

export type TerrainCanonicalSceneSpec = Readonly<
  CaptureSceneSpec & { cameraMode: CameraMode }
>;

export type TerrainCanonicalCapturePolicy =
  | Readonly<{
      kind: 'single';
      /** Shipping arms which the atomic shot must read back. */
      expectedSwitches: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      kind: 'ab';
      switchName: 'oceanTaa' | 'terrainOrder';
      arms: readonly [string, string];
    }>;

interface TerrainCanonicalReviewBase {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly dimensions: readonly TerrainCanonicalDimension[];
  readonly highRiskPairing?: TerrainCanonicalHighRiskPairing;
}

export interface TerrainCanonicalStillView
  extends TerrainCanonicalReviewBase {
  readonly kind: 'still';
  readonly page: Readonly<TerrainCanonicalPageSpec>;
  readonly surface: Readonly<CaptureSurfaceSpec>;
  readonly scene: TerrainCanonicalSceneSpec;
  readonly capture: TerrainCanonicalCapturePolicy;
}

export interface TerrainCanonicalMotionView
  extends TerrainCanonicalReviewBase {
  readonly kind: 'motion';
  /** Exact live-review URL. It deliberately does not opt into capture mode. */
  readonly url: string;
  readonly checklist: readonly string[];
}

export type TerrainCanonicalReviewView =
  | TerrainCanonicalStillView
  | TerrainCanonicalMotionView;

export interface TerrainCanonicalPixelGate {
  readonly id: string;
  readonly status: 'open' | 'closed';
  readonly summary: string;
  readonly evidence: string;
}

/** Pixel prerequisites are explicit even after they close, so a later change
 * cannot quietly remove the condition which made the named scene truthful. */
export const TERRAIN_CANONICAL_PIXEL_GATES: readonly TerrainCanonicalPixelGate[] =
  Object.freeze([
    Object.freeze({
      id: 'TERR-135-VIS-01',
      status: 'closed' as const,
      summary:
        'explicit terrain review haze must remain authoritative over weather visibility',
      evidence:
        'ProductionSimulationRuntime reapplies explicit synthetic ?haze= after ' +
        'environment derivation; ordinary sessions omit the port',
    }),
  ]);

const DESKTOP_SURFACE: Readonly<CaptureSurfaceSpec> = Object.freeze({
  tier: 'desktop',
  cssWidth: 1280,
  cssHeight: 720,
  pixelRatio: 2,
});

const LOWER_POWER_SURFACE: Readonly<CaptureSurfaceSpec> = Object.freeze({
  tier: 'mobile',
  cssWidth: 960,
  cssHeight: 540,
  pixelRatio: 1,
});

const SHIPPING_SWITCHES = Object.freeze({
  oceanTaa: '0',
  terrainOrder: 'after',
});

const BASE_SCENE: TerrainCanonicalSceneSpec = Object.freeze({
  seaState: 'CURRENT_MODERATE',
  waveTimeSeconds: 120,
  sunElevationDeg: 38,
  stand: 'Waist',
  lookYawDeg: 140,
  lookBearingDeg: -48,
  lookPitchDeg: 0,
  originX: 0,
  originZ: 0,
  cloudWarmFrames: 72,
  cameraMode: 'embodied',
});

function scene(
  overrides: Partial<TerrainCanonicalSceneSpec>,
): TerrainCanonicalSceneSpec {
  return Object.freeze({ ...BASE_SCENE, ...overrides });
}

function page(
  fixture: TerrainCanonicalFixtureId,
  rangeKm: number,
  farKm: number,
  hazeKm: number,
  depthMode: TerrainCanonicalDepthMode,
): Readonly<TerrainCanonicalPageSpec> {
  return Object.freeze({
    fixture,
    rangeKm,
    bearingDeg: -48,
    farKm,
    hazeKm,
    depthMode,
  });
}

function singleCapture(): TerrainCanonicalCapturePolicy {
  return Object.freeze({
    kind: 'single' as const,
    expectedSwitches: SHIPPING_SWITCHES,
  });
}

function dimensions(
  ...values: TerrainCanonicalDimension[]
): readonly TerrainCanonicalDimension[] {
  return Object.freeze(values);
}

/**
 * Twelve named review rows, deliberately not a cross-product.
 *
 * Ten rows are capture-host recipes. Two of those are paired A/B rows, so the
 * still run yields twelve atomic frames. The final two rows are motion checks:
 * a still cannot answer an orbit or accelerated-travel question honestly.
 */
export const TERRAIN_CANONICAL_REVIEW_VIEWS: readonly TerrainCanonicalReviewView[] =
  Object.freeze([
    Object.freeze({
      kind: 'still' as const,
      id: 'near-low-coast-embodied',
      title: '1 km low coast · embodied midday calm',
      purpose: 'Near shoreline continuity, drowned rim and ordinary eye height.',
      page: page('low-coast', 1, 50, 80, 'conventional'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        seaState: 'DEAD_CALM',
        cameraMode: 'embodied',
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-1km',
        'camera-embodied',
        'light-midday',
        'sea-calm',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'coast-low-sun-rough-sea',
      title: '5 km headland · low Sun and rough sea',
      purpose: 'High-risk waterline contrast under rough occlusion and low light.',
      highRiskPairing: 'low-sun-rough-sea-coastline' as const,
      page: page('headland', 5, 50, 40, 'conventional'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        seaState: 'SOUTHERN_OCEAN_ROUGH',
        sunElevationDeg: 6,
        cameraMode: 'embodied',
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-5km',
        'camera-embodied',
        'light-low-angle',
        'sea-rough',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'midrange-default-cinematic',
      title: '20 km mountain · default cinematic',
      purpose: 'Default external composition, silhouette and ocean intersection.',
      page: page('mountain', 20, 80, 80, 'reversed'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        cameraMode: 'cinematic',
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-20km',
        'camera-cinematic-default',
        'light-midday',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'hazy-peak-80km',
      title: '80 km peak · explicit long haze',
      purpose: 'Long silhouette, haze stability and depth ordering before the horizon.',
      page: page('peak', 80, 160, 120, 'reversed'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        cameraMode: 'cinematic',
        sunElevationDeg: 18,
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-80km',
        'camera-cinematic-default',
        'light-low-angle',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'maximum-cinematic-far-ocean',
      title: '200 km peak · maximum cinematic over far ocean',
      purpose: 'High-risk maximum-altitude sea horizon with distant land in frame.',
      highRiskPairing: 'maximum-cinematic-far-ocean' as const,
      page: page('peak', 200, 300, 300, 'reversed'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        seaState: 'GLASSY_LONG_SWELL',
        cameraMode: 'cinematic',
        cinematicScale: 1,
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-200km',
        'camera-cinematic-maximum',
        'light-midday',
        'sea-calm',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'conventional-300km-bounds',
      title: '300 km peak · conventional bounds control',
      purpose: 'Explicit clipping/bounds control at the render matrix maximum.',
      page: page('peak', 300, 500, 500, 'conventional'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        cameraMode: 'cinematic',
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-300km',
        'camera-cinematic-default',
        'light-midday',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'temporal-resolve-identical-coast',
      title: '20 km mountain · ocean temporal resolve off/on',
      purpose: 'One staged scene with only ocean detail temporal resolve changed.',
      highRiskPairing: 'temporal-resolve-identical-view' as const,
      page: page('mountain', 20, 80, 80, 'reversed'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        seaState: 'CURRENT_MODERATE',
        cameraMode: 'embodied',
      }),
      capture: Object.freeze({
        kind: 'ab' as const,
        switchName: 'oceanTaa' as const,
        arms: Object.freeze(['0', '1'] as const),
      }),
      dimensions: dimensions(
        'range-20km',
        'camera-embodied',
        'motion-stationary',
        'temporal-resolve-off-on',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'cloud-occlusion-peak',
      title: '20 km peak · cloud occlusion review',
      purpose: 'Stage the unresolved peak/cloud punch-through case without claiming a verdict.',
      highRiskPairing: 'cloud-occlusion-peak' as const,
      page: page('peak', 20, 100, 80, 'reversed'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        cameraMode: 'cinematic',
        cloudWarmFrames: 96,
        sunElevationDeg: 18,
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-20km',
        'camera-cinematic-default',
        'light-low-angle',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'waterline-draw-order',
      title: '5 km headland · terrain draw-order A/B',
      purpose: 'Identical waterline pixels with terrain submitted after/before ocean.',
      page: page('headland', 5, 50, 80, 'conventional'),
      surface: DESKTOP_SURFACE,
      scene: scene({
        cameraMode: 'embodied',
        sunElevationDeg: 18,
      }),
      capture: Object.freeze({
        kind: 'ab' as const,
        switchName: 'terrainOrder' as const,
        arms: Object.freeze(['after', 'before'] as const),
      }),
      dimensions: dimensions(
        'range-5km',
        'camera-embodied',
        'light-low-angle',
        'motion-stationary',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'still' as const,
      id: 'lower-power-coast',
      title: '5 km low coast · fixed lower-power tier',
      purpose: 'One fixed mobile-tier composition without silently substituting desktop.',
      page: page('low-coast', 5, 50, 40, 'log'),
      surface: LOWER_POWER_SURFACE,
      scene: scene({
        seaState: 'DEAD_CALM',
        cameraMode: 'embodied',
      }),
      capture: singleCapture(),
      dimensions: dimensions(
        'range-5km',
        'camera-embodied',
        'sea-calm',
        'motion-stationary',
        'tier-fixed-lower-power',
      ),
    }),
    Object.freeze({
      kind: 'motion' as const,
      id: 'slow-cinematic-orbit',
      title: '80 km peak · slow cinematic orbit',
      purpose: 'Primary eye verdict for horizon, haze and silhouette stability in camera motion.',
      url:
        '?terrain=synthetic&fixture=peak&range=80&bearing=-48&far=160&haze=120' +
        '&depth=reversed&weather=off&seaCoupling=independent&quality=desktop' +
        '&fixedDpr=2&debug=camera',
      checklist: Object.freeze([
        'Press V for cinematic mode and set the Camera scale to its authored default.',
        'Drag one slow 360-degree orbit; do not use idle camera drift as the motion source.',
        'Watch the coastline, peak silhouette, ocean horizon and haze ordering continuously.',
      ]),
      dimensions: dimensions(
        'range-80km',
        'camera-cinematic-default',
        'motion-slow-orbit',
        'tier-production-desktop',
      ),
    }),
    Object.freeze({
      kind: 'motion' as const,
      id: 'accelerated-voyage-past-mountain',
      title: '5 km mountain · accelerated canonical travel',
      purpose:
        'Primary eye verdict for anchored geometry and tile-boundary stability under travel.',
      url:
        '?terrain=synthetic&fixture=mountain&range=5&bearing=-48&far=60&haze=80' +
        '&depth=reversed&weather=off&seaCoupling=independent&quality=desktop' +
        '&fixedDpr=2&voyage=30&debug=voyage',
      checklist: Object.freeze([
        'Press V for the default cinematic view and leave the voyage rate at the URL-authored 30x.',
        'Watch at least 90 seconds, including the closest approach and a visible tile refresh.',
        'Fail on swimming, a seam pulse, horizon reordering or a phase-locked ocean/terrain jump.',
      ]),
      dimensions: dimensions(
        'range-5km',
        'camera-cinematic-default',
        'motion-accelerated-travel',
        'tier-production-desktop',
      ),
    }),
  ]);

export interface TerrainCanonicalRequestedCameraMetadata {
  readonly cameraMode: CameraMode;
  readonly cinematicScale: number | 'authored-default' | null;
}

export interface TerrainCanonicalStillPlan extends TerrainCanonicalStillView {
  readonly pageQuery: string;
  readonly expectedFrames: number;
  readonly requestedCamera: TerrainCanonicalRequestedCameraMetadata;
}

export type TerrainCanonicalPlanView =
  | TerrainCanonicalStillPlan
  | TerrainCanonicalMotionView;

export interface TerrainCanonicalPlan {
  readonly schemaVersion: number;
  readonly tableId: string;
  readonly captureTool: string;
  readonly fullCaptureCommand: string;
  readonly pixelGates: readonly TerrainCanonicalPixelGate[];
  readonly rows: readonly TerrainCanonicalPlanView[];
  readonly stillFrames: number;
}

/** Stable query order is part of the evidence manifest and review diff. */
export function terrainCanonicalPageQuery(
  view: Readonly<TerrainCanonicalStillView>,
): string {
  const params = new URLSearchParams();
  params.set('capture', '1');
  params.set('quality', view.surface.tier);
  params.set('fixedDpr', String(view.surface.pixelRatio));
  params.set('terrain', 'synthetic');
  params.set('fixture', view.page.fixture);
  params.set('range', String(view.page.rangeKm));
  params.set('bearing', String(view.page.bearingDeg));
  params.set('far', String(view.page.farKm));
  params.set('haze', String(view.page.hazeKm));
  params.set('depth', view.page.depthMode);
  params.set('weather', 'off');
  params.set('seaCoupling', 'independent');
  params.set('terrainOrder', 'after');
  if (
    view.capture.kind === 'ab' &&
    view.capture.switchName === 'oceanTaa'
  ) {
    // The resolve object is constructed only when the page loads with this arm.
    params.set('oceanTaa', '1');
  }
  return params.toString();
}

export function terrainCanonicalRequestedCamera(
  view: Readonly<TerrainCanonicalStillView>,
): TerrainCanonicalRequestedCameraMetadata {
  return Object.freeze({
    cameraMode: view.scene.cameraMode,
    cinematicScale:
      view.scene.cameraMode === 'embodied'
        ? null
        : view.scene.cinematicScale ?? 'authored-default',
  });
}

export function buildTerrainCanonicalPlan(
  selectedIds: readonly string[] = [],
): TerrainCanonicalPlan {
  const selected = new Set(selectedIds);
  const unknown = [...selected].filter(
    (id) => !TERRAIN_CANONICAL_REVIEW_VIEWS.some((view) => view.id === id),
  );
  if (unknown.length > 0) {
    throw new Error(`unknown canonical terrain view: ${unknown.join(', ')}`);
  }
  const rows = TERRAIN_CANONICAL_REVIEW_VIEWS.filter(
    (view) => selected.size === 0 || selected.has(view.id),
  ).map((view): TerrainCanonicalPlanView => {
    if (view.kind === 'motion') return view;
    return Object.freeze({
      ...view,
      pageQuery: terrainCanonicalPageQuery(view),
      expectedFrames: view.capture.kind === 'single' ? 1 : view.capture.arms.length,
      requestedCamera: terrainCanonicalRequestedCamera(view),
    });
  });
  const stillFrames = rows.reduce(
    (total, view) =>
      total + (view.kind === 'still' ? view.expectedFrames : 0),
    0,
  );
  return Object.freeze({
    schemaVersion: TERRAIN_CANONICAL_SCHEMA_VERSION,
    tableId: TERRAIN_CANONICAL_TABLE_ID,
    captureTool: 'tools/terrain-canonical-captures.mjs',
    fullCaptureCommand:
      'node tools/terrain-canonical-captures.mjs --capture --cold-machine ' +
      '--out evidence/terrain/r1-renderer/terr-135-canonical-cold',
    pixelGates: TERRAIN_CANONICAL_PIXEL_GATES,
    rows: Object.freeze(rows),
    stillFrames,
  });
}

export function assertTerrainCanonicalReviewTable(
  views: readonly TerrainCanonicalReviewView[] =
    TERRAIN_CANONICAL_REVIEW_VIEWS,
): void {
  if (views.length !== 12) {
    throw new Error(`canonical terrain review table must have 12 rows, got ${views.length}`);
  }
  const ids = new Set(views.map((view) => view.id));
  if (ids.size !== views.length) {
    throw new Error('canonical terrain review view ids must be unique');
  }
  const stills = views.filter(
    (view): view is TerrainCanonicalStillView => view.kind === 'still',
  );
  const motions = views.filter(
    (view): view is TerrainCanonicalMotionView => view.kind === 'motion',
  );
  if (stills.length !== 10 || motions.length !== 2) {
    throw new Error(
      'canonical terrain review table must contain 10 still and 2 motion ' +
        `rows, got ${stills.length}/${motions.length}`,
    );
  }
  const frameCount = stills.reduce(
    (total, view) =>
      total + (view.capture.kind === 'single' ? 1 : view.capture.arms.length),
    0,
  );
  if (frameCount !== 12) {
    throw new Error(`canonical terrain still run must produce 12 frames, got ${frameCount}`);
  }
  for (const risk of TERRAIN_CANONICAL_HIGH_RISK_PAIRINGS) {
    const owners = views.filter((view) => view.highRiskPairing === risk);
    if (owners.length !== 1) {
      throw new Error(`high-risk pairing '${risk}' must have exactly one owner`);
    }
  }
  const requiredDimensions: readonly TerrainCanonicalDimension[] = [
    'range-1km',
    'range-5km',
    'range-20km',
    'range-80km',
    'range-200km',
    'range-300km',
    'camera-embodied',
    'camera-cinematic-default',
    'camera-cinematic-maximum',
    'light-midday',
    'light-low-angle',
    'sea-calm',
    'sea-rough',
    'motion-stationary',
    'motion-slow-orbit',
    'motion-accelerated-travel',
    'temporal-resolve-off-on',
    'tier-production-desktop',
    'tier-fixed-lower-power',
  ];
  const covered = new Set(views.flatMap((view) => view.dimensions));
  const missing = requiredDimensions.filter((dimension) => !covered.has(dimension));
  if (missing.length > 0) {
    throw new Error(`canonical terrain dimensions missing: ${missing.join(', ')}`);
  }
  for (const view of stills) {
    if (view.page.farKm < view.page.rangeKm + 40) {
      throw new Error(
        `${view.id} far plane must include the synthetic fixture's 40 km margin`,
      );
    }
    const scale = view.scene.cinematicScale;
    if (
      view.scene.cameraMode === 'embodied' &&
      scale !== undefined
    ) {
      throw new Error(`${view.id} gives an embodied camera a cinematic scale`);
    }
    if (
      scale !== undefined &&
      (!Number.isFinite(scale) || scale < 0 || scale > 1)
    ) {
      throw new Error(`${view.id} cinematic scale must be finite in [0, 1]`);
    }
    if (view.scene.cameraMode === 'cinematic' && view.scene.lookPitchDeg !== 0) {
      throw new Error(`${view.id} cinematic view must use the authored orbit elevation`);
    }
  }
}

assertTerrainCanonicalReviewTable();
