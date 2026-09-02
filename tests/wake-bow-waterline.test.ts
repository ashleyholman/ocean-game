import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import {
  FoamField,
  MAX_WATERLINE_WAKE_POINTS,
  MAX_WATERLINE_WAKE_STATIONS,
} from '../src/scene/FoamField';
import {
  createWetHullBandProfile,
  updateWetHullBandProfile,
  wetHullWaterlineYAt,
} from '../src/scene/HullWetBand';
import { WaveField } from '../src/scene/Waves';
import {
  BOW_COLLAR_ONSET_SPEED_MPS,
  createWakeBowPolicyResult,
  gateWakeBowAppearance,
  resolveWakeBowPolicy,
  type WakeBowPolicyInput,
} from '../src/scene/wakePolicy';
import { PHYSICS_STEP } from '../src/vessel/BuoyantBody';
import {
  WAKE_WATERLINE_POLYLINE_STATIONS,
  WakeSources,
} from '../src/vessel/WakeSources';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';

function bowInput(
  overrides: Partial<WakeBowPolicyInput> = {},
): WakeBowPolicyInput {
  return {
    speedThroughWaterMps: 3,
    ambientWhitecapCoverage: 0.002,
    windSpeedMps: 8,
    bowWaterlinePointCount: 20,
    ...overrides,
  };
}

describe('WK2 bow policy', () => {
  it('has an exact 0.8 m/s onset and saturates at the one hull speed', () => {
    const below = createWakeBowPolicyResult();
    const onset = createWakeBowPolicyResult();
    const hullSpeed = createWakeBowPolicyResult();
    const surfing = createWakeBowPolicyResult();
    resolveWakeBowPolicy(
      bowInput({ speedThroughWaterMps: BOW_COLLAR_ONSET_SPEED_MPS - 0.01 }),
      below,
    );
    resolveWakeBowPolicy(
      bowInput({ speedThroughWaterMps: BOW_COLLAR_ONSET_SPEED_MPS }),
      onset,
    );
    resolveWakeBowPolicy(bowInput({ speedThroughWaterMps: 4.7 }), hullSpeed);
    resolveWakeBowPolicy(bowInput({ speedThroughWaterMps: 5.875 }), surfing);

    expect(below.collarDrive).toBe(0);
    expect(onset.activeFoamRatePerSecond).toBe(0);
    expect(hullSpeed.collarDrive).toBe(1);
    expect(surfing.activeFoamRatePerSecond).toBe(
      hullSpeed.activeFoamRatePerSecond,
    );
  });

  it('does not invent a collar without actual bow waterline points', () => {
    const result = createWakeBowPolicyResult();
    resolveWakeBowPolicy(bowInput({ bowWaterlinePointCount: 0 }), result);
    expect(result.activeFoamRatePerSecond).toBe(0);
    expect(result.residualFoamRatePerSecond).toBe(0);
    expect(result.turbulenceRatePerSecond).toBe(0);
  });

  it('tears the collar along the track, not downwind, and masks it in rough water', () => {
    const moderate = createWakeBowPolicyResult();
    const rough = createWakeBowPolicyResult();
    resolveWakeBowPolicy(bowInput({ windSpeedMps: 10 }), moderate);
    resolveWakeBowPolicy(
      bowInput({
        windSpeedMps: 18,
        ambientWhitecapCoverage: 0.06,
      }),
      rough,
    );

    // Foam in the water is left behind in the surface the hull passed through,
    // so the smear is the vessel's own travel over the residence time. Wind
    // coupling belongs to droplets thrown clear into the air, not to this.
    expect(moderate.tearLengthM).toBeCloseTo(
      bowInput().speedThroughWaterMps * 0.1,
      12,
    );
    expect(rough.seaMask).toBe(1);
    expect(rough.activeFoamRatePerSecond).toBeLessThan(
      moderate.activeFoamRatePerSecond,
    );
    expect(rough.moundNormalStrength).toBeLessThan(
      moderate.moundNormalStrength,
    );
  });

  it('gates every WK2 feature exactly off at the master or own toggle', () => {
    const policy = createWakeBowPolicyResult();
    resolveWakeBowPolicy(bowInput(), policy);
    const appearance = {
      collarEnabled: true,
      wetBandEnabled: true,
      wetBandHeightM: -1,
      wetBandDarkening: -1,
      wetBandRoughnessScale: -1,
      moundNormalStrength: -1,
      moundAcrossRadiusM: -1,
      moundAlongRadiusM: -1,
    };
    gateWakeBowAppearance(policy, false, true, true, true, appearance);
    expect(appearance.collarEnabled).toBe(false);
    expect(appearance.wetBandEnabled).toBe(false);
    expect(appearance.moundNormalStrength).toBe(0);

    gateWakeBowAppearance(policy, true, false, true, true, appearance);
    expect(appearance.collarEnabled).toBe(false);
    expect(appearance.wetBandEnabled).toBe(true);
  });
});

describe('WK2 resolved wet hull', () => {
  it('tracks the actual contact height through a seeded pitching run', () => {
    const sea = findSeaState('SOUTHERN_OCEAN_ROUGH');
    const waves = new WaveField(sea);
    const body = buildSchoonerBuoyancy();
    const yaw = 0.37;
    const velocity = { x: 1.1, z: 4.4 };
    body.snapToSurface(waves, 0, 0, yaw);
    const sources = new WakeSources(body.contacts, body.overtopEvents);
    const profile = createWetHullBandProfile();
    let minimumPitch = Number.POSITIVE_INFINITY;
    let maximumPitch = Number.NEGATIVE_INFINITY;
    let minimumWaterlineY = Number.POSITIVE_INFINITY;
    let maximumWaterlineY = Number.NEGATIVE_INFINITY;
    let checkedKnots = 0;

    for (let frame = 0; frame < 240; frame++) {
      body.update(
        1 / 60,
        waves,
        0,
        0,
        yaw,
        PHYSICS_STEP,
        velocity.x,
        velocity.z,
      );
      sources.update();
      updateWetHullBandProfile(sources, profile);
      minimumPitch = Math.min(minimumPitch, body.pitch);
      maximumPitch = Math.max(maximumPitch, body.pitch);

      for (let i = 0; i < profile.count; i++) {
        const knot = profile.samples[i];
        const source = sources.resolvedWaterlineStations
          .slice(0, sources.resolvedWaterlineStationCount)
          .find((candidate) => candidate.stationIndex === knot.stationIndex);
        expect(source).toBeDefined();
        if (!source) continue;
        const portY = wetHullWaterlineYAt(
          profile,
          1,
          source.stationLocalZ,
        );
        const starboardY = wetHullWaterlineYAt(
          profile,
          -1,
          source.stationLocalZ,
        );
        expect(portY).toBeCloseTo(source.portLocal.y, 10);
        expect(starboardY).toBeCloseTo(source.starboardLocal.y, 10);
        minimumWaterlineY = Math.min(
          minimumWaterlineY,
          source.portLocal.y,
          source.starboardLocal.y,
        );
        maximumWaterlineY = Math.max(
          maximumWaterlineY,
          source.portLocal.y,
          source.starboardLocal.y,
        );
        checkedKnots++;
      }
    }

    expect(checkedKnots).toBeGreaterThan(500);
    expect(maximumPitch - minimumPitch).toBeGreaterThan(0.002);
    expect(maximumWaterlineY - minimumWaterlineY).toBeGreaterThan(0.1);
  });

  it('keeps the wet treatment in the world-PBR shader and off the physics surface', () => {
    const wetBand = readFileSync('src/scene/HullWetBand.ts', 'utf8');
    expect(wetBand).toContain('diffuseColor.rgb *= 1.0 - wetHullMask');
    expect(wetBand).toContain('roughnessFactor *= mix(');
    expect(wetBand).toContain('localPosition.y - waterlineY');
    expect(wetBand).not.toContain('WaveField');
  });
});

describe('WK2 GPU source contract', () => {
  it('ships the combined wake on behind the Debug Tools master switch', () => {
    const controller = readFileSync(
      'src/runtime/WakePresentationController.ts',
      'utf8',
    );
    const oceanLab = readFileSync('src/debug/OceanLab.ts', 'utf8');
    expect(controller).toContain('private effectsEnabled = true;');
    expect(oceanLab).toContain("'Wake effects master'");
  });

  it('fits two resampled hull-side polylines in the existing 26-position budget', () => {
    const body = buildSchoonerBuoyancy();
    const sources = new WakeSources(body.contacts, body.overtopEvents);
    const waves = new WaveField(findSeaState('CURRENT_MODERATE'));
    body.snapToSurface(waves, 0, 0, 0);
    body.update(1 / 60, waves, 0, 0, 0, PHYSICS_STEP, 0, 0);
    sources.update();
    expect(WAKE_WATERLINE_POLYLINE_STATIONS).toBe(
      MAX_WATERLINE_WAKE_STATIONS,
    );
    expect(MAX_WATERLINE_WAKE_POINTS).toBe(26);
    expect(sources.waterlinePolylineStationCount).toBe(
      MAX_WATERLINE_WAKE_STATIONS,
    );

    const field = new FoamField(waves, {
      hullResolution: 2,
      nearResolution: 8,
      farResolution: 4,
      updateHz: 24,
    });
    const internals = field as unknown as {
      injectMaterial: THREE.ShaderMaterial;
    };
    expect(
      internals.injectMaterial.defines?.MAX_WATERLINE_WAKE_STATIONS,
    ).toBe(MAX_WATERLINE_WAKE_STATIONS);
    expect(
      internals.injectMaterial.defines?.MAX_WATERLINE_WAKE_POINTS,
    ).toBe(
      MAX_WATERLINE_WAKE_POINTS,
    );
    expect(
      internals.injectMaterial.uniforms.uWaterlineWakePoints.value,
    ).toHaveLength(MAX_WATERLINE_WAKE_POINTS);
    expect(
      internals.injectMaterial.uniforms.uWaterlineWakeBounds.value,
    ).toBeInstanceOf(THREE.Vector4);
    field.dispose();
  });

  // Vitest has no GPU; keep the same reviewer guidance as WK1's shader pins.
  it('adds the collar in the existing pass and keeps bow cues one-way', () => {
    const foam = readFileSync('src/scene/FoamField.ts', 'utf8');
    const ocean = readFileSync('src/scene/Ocean.ts', 'utf8');
    expect(foam).toContain('distanceToSweptWakeSegment(');
    expect(foam).toContain('p.x >= uWaterlineWakeBounds.x - waterlineBoundsMargin');
    expect(foam).toContain(
      'injected += uWaterlineWakeRate * (waterlineSource * uDeltaTime);',
    );
    expect(foam).toContain(
      'waterlineSource = max(waterlineSource, segmentSource);',
    );
    expect(foam).not.toContain('uBowWakePoints');
    expect(foam).toContain('this.simulate(renderer, waves, step, options, false);');
    const controller = readFileSync(
      'src/runtime/WakePresentationController.ts',
      'utf8',
    );
    const simHandleFactory = readFileSync(
      'src/runtime/diagnostics/createSimHandle.ts',
      'utf8',
    );
    expect(controller).toContain('wakeSources.waterlinePolylinePoints[i]');
    expect(simHandleFactory).toContain(
      'waterlineWake: wake.presentation.foamWaterlineWakeSource',
    );
    expect(controller).toContain('resolveBowPressureFrontGeometry(');
    expect(controller).toContain(
      'this.bowPressureFrontGeometry.shoulderHalfWidthM',
    );
    expect(ocean).toContain('+ bowMoundGradient(vParam)');
    expect(ocean).toContain('vec2 bowWaveGradient = shipBowNearFieldGradient(');
    expect(ocean).toContain('+ bowWaveBreakingCoverage;');
    expect(ocean).toContain('if (uBowMoundNormalStrength <= 0.0)');
    expect(ocean).toContain('abs(along) > alongRadius * 3.5');
    expect(ocean).not.toContain('vHeight += bowMound');
    expect(ocean).not.toContain('vHeight += shipBowNearField');
  });
});
