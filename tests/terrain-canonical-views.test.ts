import { describe, expect, it } from 'vitest';

import { resolveCaptureCameraSpec } from '../src/debug/captureSceneCamera';
import {
  assertTerrainCanonicalReviewTable,
  buildTerrainCanonicalPlan,
  TERRAIN_CANONICAL_HIGH_RISK_PAIRINGS,
  TERRAIN_CANONICAL_PIXEL_GATES,
  TERRAIN_CANONICAL_REVIEW_VIEWS,
  terrainCanonicalPageQuery,
  type TerrainCanonicalStillView,
} from '../src/debug/terrainCanonicalViews';
import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';
import { requiredSyntheticTerrainFarKm } from '../src/terrain/syntheticTerrainHarness';

const HOST = {
  viewportWidth: 1280,
  viewportHeight: 720,
  screenWidth: 1280,
  screenHeight: 720,
  isTouch: false,
};

const stills = TERRAIN_CANONICAL_REVIEW_VIEWS.filter(
  (view): view is TerrainCanonicalStillView => view.kind === 'still',
);

describe('TERR-135 canonical terrain review table', () => {
  it('is a bounded twelve-row plan with twelve still frames and two honest motion checks', () => {
    expect(() => assertTerrainCanonicalReviewTable()).not.toThrow();
    expect(TERRAIN_CANONICAL_REVIEW_VIEWS).toHaveLength(12);
    expect(stills).toHaveLength(10);
    expect(
      TERRAIN_CANONICAL_REVIEW_VIEWS.filter((view) => view.kind === 'motion'),
    ).toHaveLength(2);

    const plan = buildTerrainCanonicalPlan();
    expect(plan.stillFrames).toBe(12);
    expect(plan.rows).toHaveLength(12);
    expect(plan.fullCaptureCommand).toBe(
      'node tools/terrain-canonical-captures.mjs --capture --cold-machine ' +
        '--out evidence/terrain/r1-renderer/terr-135-canonical-cold',
    );
  });

  it('owns every required high-risk pairing exactly once', () => {
    for (const risk of TERRAIN_CANONICAL_HIGH_RISK_PAIRINGS) {
      expect(
        TERRAIN_CANONICAL_REVIEW_VIEWS.filter(
          (view) => view.highRiskPairing === risk,
        ).map((view) => view.id),
      ).toHaveLength(1);
    }

    const farOcean = TERRAIN_CANONICAL_REVIEW_VIEWS.find(
      (view) => view.id === 'maximum-cinematic-far-ocean',
    );
    expect(farOcean).toMatchObject({
      kind: 'still',
      page: { rangeKm: 200, farKm: 300, hazeKm: 300 },
      scene: { cameraMode: 'cinematic', cinematicScale: 1 },
      highRiskPairing: 'maximum-cinematic-far-ocean',
    });
  });

  it('stages every still through an accepted embodied or cinematic camera spec', () => {
    const modes = new Set<string>();
    for (const view of stills) {
      const camera = resolveCaptureCameraSpec(view.scene);
      modes.add(camera.mode);
      expect(camera.mode).toBe(view.scene.cameraMode);
      expect(camera.cinematicScale).toBe(view.scene.cinematicScale ?? null);
    }
    expect([...modes].sort()).toEqual(['cinematic', 'embodied']);
    expect(
      stills.some(
        (view) =>
          view.scene.cameraMode === 'cinematic' &&
          view.scene.cinematicScale === 1,
      ),
    ).toBe(true);
  });

  it(
    'pins every still page to the requested host, tier, source, and range',
    () => {
      for (const view of stills) {
        const query = terrainCanonicalPageQuery(view);
        const params = new URLSearchParams(query);
        const runtime = resolveRuntimeOptions(params, HOST);

        expect(params.get('capture')).toBe('1');
        expect(runtime.captureHostEnabled).toBe(true);
        expect(runtime.terrainMode).toBe('synthetic');
        expect(runtime.forcedQualityTier).toBe(view.surface.tier);
        expect(runtime.fixedPixelRatio).toBe(view.surface.pixelRatio);
        expect(runtime.weatherSource).toBe('neutral');
        expect(runtime.seaFollowsWeather).toBe(false);
        expect(params.get('fixture')).toBe(view.page.fixture);
        expect(Number(params.get('range'))).toBe(view.page.rangeKm);
        expect(Number(params.get('haze'))).toBe(view.page.hazeKm);
        expect(view.page.farKm).toBeGreaterThanOrEqual(
          requiredSyntheticTerrainFarKm(view.page.rangeKm),
        );
      }
    },
  );

  it('loads only the paired temporal resolver and keeps motion out of capture mode', () => {
    const temporal = stills.find(
      (view) => view.id === 'temporal-resolve-identical-coast',
    )!;
    expect(new URLSearchParams(terrainCanonicalPageQuery(temporal)).get('oceanTaa')).toBe(
      '1',
    );
    for (const view of stills.filter((entry) => entry !== temporal)) {
      expect(
        new URLSearchParams(terrainCanonicalPageQuery(view)).has('oceanTaa'),
      ).toBe(false);
    }

    const motions = TERRAIN_CANONICAL_REVIEW_VIEWS.filter(
      (view) => view.kind === 'motion',
    );
    for (const motion of motions) {
      const params = new URLSearchParams(motion.url);
      expect(params.has('capture')).toBe(false);
      expect(params.get('terrain')).toBe('synthetic');
      expect(params.has('haze')).toBe(true);
      expect(motion.checklist.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('publishes deterministic metadata and a closed explicit-haze prerequisite', () => {
    const first = JSON.stringify(buildTerrainCanonicalPlan());
    const second = JSON.stringify(buildTerrainCanonicalPlan());
    expect(second).toBe(first);
    expect(first).not.toContain('generatedAt');
    expect(TERRAIN_CANONICAL_PIXEL_GATES).toEqual([
      expect.objectContaining({ id: 'TERR-135-VIS-01', status: 'closed' }),
    ]);

    const selected = buildTerrainCanonicalPlan([
      'near-low-coast-embodied',
      'maximum-cinematic-far-ocean',
    ]);
    expect(selected.rows.map((row) => row.id)).toEqual([
      'near-low-coast-embodied',
      'maximum-cinematic-far-ocean',
    ]);
    expect(selected.stillFrames).toBe(2);
    expect(() => buildTerrainCanonicalPlan(['not-a-view'])).toThrow(
      'unknown canonical terrain view',
    );
  });
});
