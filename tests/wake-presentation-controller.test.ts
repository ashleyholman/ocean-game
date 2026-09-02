import { describe, expect, it } from 'vitest';
import {
  WakePresentationController,
  type WakeBowFeature,
  type WakeOceanTarget,
  type WakeSchoonerTarget,
  type WakeTrailFeature,
} from '../src/runtime/WakePresentationController';
import type {
  BowMoundAppearance,
  ShipWakePatternAppearance,
  WakeTrailAppearance,
} from '../src/scene/Ocean';
import type { HullWetBandAppearance } from '../src/scene/HullWetBand';
import { createHullWaterContact } from '../src/vessel/HullWaterContact';
import type { WakeSources } from '../src/vessel/WakeSources';

function createHarness() {
  const calls: string[] = [];
  const trailAppearances: Readonly<WakeTrailAppearance>[] = [];
  const moundAppearances: Readonly<BowMoundAppearance>[] = [];
  const patternAppearances: Readonly<ShipWakePatternAppearance>[] = [];
  const wetAppearances: Readonly<HullWetBandAppearance>[] = [];
  const contact = createHullWaterContact({
    stationIndex: 0,
    stationX: 0,
    stationZ: -4,
    longitudinalRegion: 'stern',
    transverseRegion: 'centre',
  });
  contact.isWet = true;
  contact.portWaterline.active = true;
  Object.assign(contact.portWaterline.worldPoint, { x: 1.2, y: 0, z: -4 });
  Object.assign(contact.portWaterline.localPoint, { x: 1.2, y: 0, z: -4 });
  contact.starboardWaterline.active = true;
  Object.assign(contact.starboardWaterline.worldPoint, {
    x: -1.1,
    y: 0,
    z: -4,
  });
  Object.assign(contact.starboardWaterline.localPoint, {
    x: -1.1,
    y: 0,
    z: -4,
  });

  const ocean: WakeOceanTarget = {
    setWakeTrailAppearance(appearance) {
      calls.push('trail');
      trailAppearances.push(appearance);
    },
    setWakeStreakTarget() {
      calls.push('streak');
    },
    setBowMoundAppearance(appearance) {
      calls.push('mound');
      moundAppearances.push(appearance);
    },
    setShipWakePattern(appearance) {
      calls.push('pattern');
      patternAppearances.push(appearance);
    },
  };
  const schooner: WakeSchoonerTarget = {
    yaw: 0.25,
    updateWetHullBand(
      _sources: Readonly<WakeSources>,
      appearance: Readonly<HullWetBandAppearance>,
    ) {
      calls.push('wetHull');
      wetAppearances.push(appearance);
    },
  };
  const encounterVelocity = { x: 3, z: 4 };
  const controller = new WakePresentationController({
    contacts: [contact],
    overtopEvents: [],
    waves: {
      invertDisplacement(x, z, out) {
        out.x = x + 10;
        out.z = z - 20;
      },
    },
    presentWind: { meanSpeedMps: 8 },
    ocean,
    encounterVelocity,
    vesselHalfBeamM: 2.5,
    schooner,
  });

  return {
    calls,
    contact,
    controller,
    encounterVelocity,
    moundAppearances,
    patternAppearances,
    trailAppearances,
    wetAppearances,
  };
}

describe('wake presentation controller', () => {
  it('preserves the production defaults and maps every diagnostic feature', () => {
    const { controller } = createHarness();
    const trailFeatures: readonly WakeTrailFeature[] = [
      'injection',
      'bubbleHaze',
      'whitecapSuppression',
      'trailFoamFloor',
    ];
    const enabledBowFeatures: readonly WakeBowFeature[] = [
      'collar',
      'wetHull',
      'bowMound',
      'wavePattern',
      'entrySpray',
    ];

    expect(controller.wakeEffectsEnabled()).toBe(true);
    for (const feature of trailFeatures) {
      expect(controller.wakeTrailFeatureEnabled(feature)).toBe(true);
      controller.setWakeTrailFeatureEnabled(feature, false);
      expect(controller.wakeTrailFeatureEnabled(feature)).toBe(false);
    }
    for (const feature of enabledBowFeatures) {
      expect(controller.wakeBowFeatureEnabled(feature)).toBe(true);
      controller.setWakeBowFeatureEnabled(feature, false);
      expect(controller.wakeBowFeatureEnabled(feature)).toBe(false);
    }
    expect(controller.wakeBowFeatureEnabled('kelvinPattern')).toBe(false);
    controller.setWakeBowFeatureEnabled('kelvinPattern', true);
    expect(controller.wakeBowFeatureEnabled('kelvinPattern')).toBe(true);
    controller.setWakeEffectsEnabled(false);
    expect(controller.wakeEffectsEnabled()).toBe(false);
  });

  it('captures completed contacts into one stable graph and keeps output identities stable', () => {
    const {
      contact,
      controller,
      moundAppearances,
      patternAppearances,
      trailAppearances,
      wetAppearances,
    } = createHarness();
    const sources = controller.wakeSources;
    const hullSource = controller.foamHullWakeSource;
    const waterlineSource = controller.foamWaterlineWakeSource;
    const waterlinePoints = waterlineSource.points;
    const trailPolicy = controller.wakeTrailPolicy;
    const bowPolicy = controller.wakeBowPolicy;
    const patternPolicy = controller.wakePatternPolicy;

    controller.captureContacts();
    expect(controller.wakeSources).toBe(sources);
    expect(sources.sternWaterline.port.x).toBe(1.2);
    controller.prepareWater(0.002, 1 / 60);
    expect(hullSource).toMatchObject({
      enabled: true,
      portX: 11.2,
      portZ: -24,
      starboardX: 8.9,
      starboardZ: -24,
    });

    contact.portWaterline.worldPoint.x = 1.6;
    controller.captureContacts();
    controller.prepareWater(0.002, 1 / 60);

    expect(controller.wakeSources).toBe(sources);
    expect(controller.foamHullWakeSource).toBe(hullSource);
    expect(controller.foamWaterlineWakeSource).toBe(waterlineSource);
    expect(controller.foamWaterlineWakeSource.points).toBe(waterlinePoints);
    expect(controller.wakeTrailPolicy).toBe(trailPolicy);
    expect(controller.wakeBowPolicy).toBe(bowPolicy);
    expect(controller.wakePatternPolicy).toBe(patternPolicy);
    expect(hullSource.portX).toBe(11.6);
    expect(trailAppearances[1]).toBe(trailAppearances[0]);
    expect(moundAppearances[1]).toBe(moundAppearances[0]);
    expect(patternAppearances[1]).toBe(patternAppearances[0]);
    expect(wetAppearances[1]).toBe(wetAppearances[0]);
  });

  it('prepares water consumers in the established order and reads live velocity', () => {
    const { calls, controller, encounterVelocity } = createHarness();
    controller.captureContacts();
    controller.prepareWater(0.002, 1 / 60);

    expect(calls).toEqual([
      'trail',
      'streak',
      'wetHull',
      'mound',
      'pattern',
    ]);
    expect(controller.wakeSpeedThroughWaterMps()).toBe(5);
    encounterVelocity.x = 0;
    encounterVelocity.z = 0;
    expect(controller.wakeSpeedThroughWaterMps()).toBe(0);
  });

  it('exposes a bounded bow-spray density dial without changing event gates', () => {
    const { controller } = createHarness();
    expect(controller.hullSprayDensity()).toBe(1);
    controller.setHullSprayDensityScale(2.5);
    expect(controller.hullSprayDensity()).toBe(2.5);
    controller.setHullSprayDensityScale(-4);
    expect(controller.hullSprayDensity()).toBe(0);
    controller.setHullSprayDensityScale(40);
    expect(controller.hullSprayDensity()).toBe(4);
    expect(() => controller.setHullSprayDensityScale(Number.NaN)).toThrow(
      'hull spray density scale must be finite',
    );
  });
});
