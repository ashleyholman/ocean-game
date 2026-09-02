import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';
import {
  RAIN_HORIZONTAL_SPAN_M,
  RAIN_MAX_DROPS,
  RainField,
  rainDropCount,
  sampleRainDrop,
  type RainDropSegment,
} from '../src/weather/RainField';
import {
  lightningEnvelope,
  manualStormEvent,
  stormEventForSlot,
  thunderDelaySeconds,
} from '../src/weather/StormEvents';
import { WeatherPresentation } from '../src/weather/WeatherPresentation';
import {
  WEATHER_PRESET_NAMES,
  weatherPresetState,
} from '../src/weather/WeatherPresets';
import { WeatherSystem } from '../src/weather/WeatherSystem';
import { assertWeatherStateWithinBounds } from '../src/weather/WeatherState';
import {
  WeatherWindCue,
  sampleWeatherWindCue,
} from '../src/weather/WeatherWindCue';
import { WorldWind } from '../src/world/WorldWind';

const BASE_WIND = Object.freeze({
  speedMps: 6,
  directionDeg: 350,
  gustiness: 0.35,
});

function segment(): RainDropSegment {
  return {
    headX: 0,
    headY: 0,
    headZ: 0,
    tailX: 0,
    tailY: 0,
    tailZ: 0,
  };
}

describe('weather review presets', () => {
  it('builds bounded, coherent clear/rain/storm records', () => {
    const clear = weatherPresetState('clear', BASE_WIND, 12);
    const rain = weatherPresetState('rain', BASE_WIND, 12);
    const storm = weatherPresetState('storm', BASE_WIND, 12);

    for (const state of [clear, rain, storm]) {
      expect(() => assertWeatherStateWithinBounds(state)).not.toThrow();
      expect(state.weatherElapsedSeconds).toBe(12);
    }
    expect(clear.precipRateMmPerHour).toBe(0);
    expect(clear.pressureHpa).toBeGreaterThan(rain.pressureHpa);
    expect(rain.precipRateMmPerHour).toBeGreaterThan(0);
    expect(rain.electricalActivity).toBe(0);
    expect(storm.precipRateMmPerHour).toBeGreaterThan(rain.precipRateMmPerHour);
    expect(storm.windSpeedMps).toBeGreaterThan(rain.windSpeedMps);
    expect(clear.gustExcessMps).toBeLessThan(rain.gustExcessMps);
    expect(rain.gustExcessMps).toBeLessThan(storm.gustExcessMps);
    expect(storm.electricalActivity).toBeGreaterThan(0.9);
    // 350 + the storm's 38-degree veer wraps through north.
    expect(storm.windDirectionDeg).toBe(28);
  });

  it('publishes presets through WeatherSystem and exits one on a sea declaration', () => {
    const world = {
      state: {
        worldInstantUtcSeconds: 0,
        positionEcefM: { x: 6_378_137, y: 0, z: 0 },
      },
    };
    const weather = new WeatherSystem({
      world,
      source: 'storm',
      baseWind: { ...BASE_WIND },
    });
    expect(weather.source).toBe('storm');
    expect(weather.state).toEqual(weatherPresetState('storm', BASE_WIND, 0));

    weather.recalibrateTo(8, 210, 0.4);
    expect(weather.source).toBe('live');
    expect(weather.wind).toEqual({
      speedMps: 8,
      directionDeg: 210,
      gustiness: 0.4,
    });
  });

  it('tunes the spatial field in physical units and restores preset coherence', () => {
    const world = {
      state: {
        worldInstantUtcSeconds: 0,
        positionEcefM: { x: 6_378_137, y: 0, z: 0 },
      },
    };
    const weather = new WeatherSystem({
      world,
      source: 'rain',
      baseWind: { ...BASE_WIND },
    });
    weather.setGustFieldControls({
      gustExcessMps: 7.5,
      gustPatchMetres: 240,
      gustPeriodSeconds: 55,
    });
    expect(weather.state).toMatchObject({
      gustExcessMps: 7.5,
      gustPatchMetres: 240,
      gustPeriodSeconds: 55,
    });
    // A condition selection is a coherent record, not a partial effect edit.
    weather.setSource('storm');
    expect(weather.state).toEqual(weatherPresetState('storm', BASE_WIND, 0));
  });

  it('accepts every preset as strict startup policy', () => {
    const host = { viewportWidth: 1280, viewportHeight: 720, isTouch: false };
    for (const preset of WEATHER_PRESET_NAMES) {
      expect(
        resolveRuntimeOptions(new URLSearchParams(`weather=${preset}`), host)
          .weatherSource,
      ).toBe(preset);
    }
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('weather=drizzle'), host),
    ).toThrow(/weather/);
  });
});

describe('deterministic near rain', () => {
  it('maps no rain to no draw and maximum rain to the fixed storage ceiling', () => {
    expect(rainDropCount(0)).toBe(0);
    expect(rainDropCount(-10)).toBe(0);
    expect(rainDropCount(40)).toBe(RAIN_MAX_DROPS);
    expect(rainDropCount(400)).toBe(RAIN_MAX_DROPS);
    expect(rainDropCount(10)).toBeGreaterThan(0);
    expect(rainDropCount(10)).toBeLessThan(rainDropCount(20));
  });

  it('repeats exactly and is anchored modulo the world-space rain cell', () => {
    const first = sampleRainDrop(
      17,
      8.25,
      { x: 0, y: 4, z: 0 },
      { x: 5, z: -2 },
      segment(),
    );
    const repeated = sampleRainDrop(
      17,
      8.25,
      { x: 0, y: 4, z: 0 },
      { x: 5, z: -2 },
      segment(),
    );
    expect(repeated).toEqual(first);

    const movedCamera = sampleRainDrop(
      17,
      8.25,
      { x: 0.5, y: 4, z: 0.5 },
      { x: 5, z: -2 },
      segment(),
    );
    // A camera move may select the neighbouring periodic image, but it cannot
    // drag a drop by the camera delta. The difference is exactly a cell wrap.
    expect((movedCamera.headX - first.headX) / RAIN_HORIZONTAL_SPAN_M).toBeCloseTo(
      Math.round((movedCamera.headX - first.headX) / RAIN_HORIZONTAL_SPAN_M),
      10,
    );
    expect((movedCamera.headZ - first.headZ) / RAIN_HORIZONTAL_SPAN_M).toBeCloseTo(
      Math.round((movedCamera.headZ - first.headZ) / RAIN_HORIZONTAL_SPAN_M),
      10,
    );
  });

  it('leans the streak from the present wind while falling downward', () => {
    const eastward = sampleRainDrop(
      3,
      1,
      { x: 0, y: 2, z: 0 },
      { x: 12, z: 0 },
      segment(),
    );
    expect(eastward.tailX).toBeLessThan(eastward.headX);
    expect(eastward.tailY).toBeGreaterThan(eastward.headY);

    const westward = sampleRainDrop(
      3,
      1,
      { x: 0, y: 2, z: 0 },
      { x: -12, z: 0 },
      segment(),
    );
    expect(westward.tailX).toBeGreaterThan(westward.headX);
  });

  it('lands on the same buffer at an absolute instant regardless of update history', () => {
    const wind = new WorldWind(55);
    wind.setMean(11, 125, 0);
    const camera = new THREE.Vector3(3, 5, -2);
    const direct = new RainField();
    const stepped = new RainField();

    direct.update(12, 18, camera, wind, 17);
    stepped.update(4, 18, camera, wind, 17);
    stepped.update(12, 18, camera, wind, 17);
    const directPositions = Array.from(
      (direct.lines.geometry.getAttribute('position') as THREE.BufferAttribute)
        .array,
    );
    const steppedPositions = Array.from(
      (stepped.lines.geometry.getAttribute('position') as THREE.BufferAttribute)
        .array,
    );
    expect(steppedPositions).toEqual(directPositions);
    direct.dispose();
    stepped.dispose();
  });
});

describe('WorldWind-derived in-world cue', () => {
  it('stays legible as a teaching overlay after ocean submission', () => {
    const cue = new WeatherWindCue(true);
    const drawables: THREE.Object3D[] = [];
    cue.group.traverse((object) => {
      if (object instanceof THREE.Line || object instanceof THREE.Mesh) {
        drawables.push(object);
        const material = object.material as THREE.Material;
        expect(material.depthTest).toBe(false);
        expect(material.depthWrite).toBe(false);
        expect(object.frustumCulled).toBe(false);
        expect(object.renderOrder).toBe(20);
      }
    });
    expect(drawables).toHaveLength(3);
    expect(cue.group.getObjectByName('weather:wind-shaft')).toBeInstanceOf(
      THREE.Mesh,
    );
    expect(
      (cue.group.getObjectByName('weather:wind-shaft') as THREE.Mesh).geometry,
    ).toBeInstanceOf(THREE.BoxGeometry);
    expect(
      (cue.group.getObjectByName('weather:wind-origin-ring') as THREE.Mesh)
        .geometry,
    ).toBeInstanceOf(THREE.TorusGeometry);
    cue.dispose();
  });

  it('reads instantaneous direction and magnitude from the authoritative object', () => {
    const wind = new WorldWind(123);
    wind.setMean(12, 90, 0);
    const east = sampleWeatherWindCue(wind, 0);
    expect(east.speedMps).toBe(12);
    expect(east.directionX).toBeCloseTo(1, 12);
    expect(east.directionZ).toBeCloseTo(0, 12);

    wind.setMean(4, 180, 0);
    const southInTurnedFrame = sampleWeatherWindCue(wind, 90);
    expect(southInTurnedFrame.speedMps).toBe(4);
    expect(southInTurnedFrame.lengthM).toBeLessThan(east.lengthM);
    expect(southInTurnedFrame.directionX).toBeCloseTo(-1, 12);
  });

  it('rotates its side placement with the vessel and clears the bulwark', () => {
    const wind = new WorldWind(123);
    wind.setMean(8, 90, 0);
    const cue = new WeatherWindCue(true);
    cue.update(wind, 0, new THREE.Vector3(1, 2, 3), Math.PI / 2);
    expect(cue.group.position.x).toBeCloseTo(7, 12);
    expect(cue.group.position.y).toBeCloseTo(3.1, 12);
    expect(cue.group.position.z).toBeCloseTo(8.2, 12);
    const shaft = cue.group.getObjectByName('weather:wind-shaft') as THREE.Mesh;
    const renderedDirection = new THREE.Vector3(0, 0, 1).applyQuaternion(
      shaft.quaternion,
    );
    expect(renderedDirection.x).toBeCloseTo(1, 12);
    expect(renderedDirection.y).toBeCloseTo(0, 12);
    expect(renderedDirection.z).toBeCloseTo(0, 12);
    expect(shaft.scale.z).toBeGreaterThan(2);
    cue.dispose();
  });

  it('places itself on the observer-facing side instead of drawing through the hull', () => {
    const wind = new WorldWind(123);
    wind.setMean(8, 90, 0);
    const cue = new WeatherWindCue(true);
    cue.update(
      wind,
      0,
      new THREE.Vector3(0, 2, 0),
      0,
      new THREE.Vector3(10, 4, 0),
    );
    expect(cue.group.position.x).toBeCloseTo(5.2, 12);
    cue.update(
      wind,
      0,
      new THREE.Vector3(0, 2, 0),
      0,
      new THREE.Vector3(-10, 4, 0),
    );
    expect(cue.group.position.x).toBeCloseTo(-5.2, 12);
    cue.dispose();
  });

  it('scales its placement to a raft instead of using schooner offsets', () => {
    const wind = new WorldWind(123);
    wind.setMean(8, 90, 0);
    const cue = new WeatherWindCue(true);
    cue.update(
      wind,
      0,
      new THREE.Vector3(0, 0.25, 0),
      0,
      new THREE.Vector3(10, 2, 0),
      1.1,
      1.6,
    );
    expect(cue.group.position.x).toBeCloseTo(2.6, 12);
    expect(cue.group.position.y).toBeCloseTo(1.35, 12);
    expect(cue.group.position.z).toBeCloseTo(1.6, 12);
    const raftShaft = cue.group.getObjectByName(
      'weather:wind-shaft',
    ) as THREE.Mesh;
    const raftHead = cue.group.getObjectByName(
      'weather:wind-head',
    ) as THREE.Mesh;
    const raftRing = cue.group.getObjectByName(
      'weather:wind-origin-ring',
    ) as THREE.Mesh;
    expect(raftShaft.scale.x).toBeCloseTo(0.4, 12);
    expect(raftShaft.scale.y).toBeCloseTo(0.4, 12);
    expect(raftHead.scale.x).toBeCloseTo(0.4, 12);
    expect(raftHead.scale.z).toBeCloseTo(0.4, 12);
    expect(raftRing.scale.x).toBeCloseTo(0.4, 12);
    expect(raftRing.scale.y).toBeCloseTo(0.4, 12);
    expect(raftRing.scale.z).toBeCloseTo(0.4, 12);
    // Magnitude remains comparable between the raft and schooner overlays;
    // only the cross-section changes with vessel scale.
    expect(raftShaft.scale.z + raftHead.scale.y * 0.9).toBeCloseTo(
      cue.sample.lengthM,
      12,
    );
    cue.dispose();
  });

  it('contains no constructor or setter for a second wind authority', () => {
    const sources = [
      'src/weather/RainField.ts',
      'src/weather/WeatherWindCue.ts',
      'src/weather/WeatherPresentation.ts',
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(sources).not.toMatch(/new\s+WorldWind/);
    expect(sources).not.toMatch(/\.setMean\s*\(/);
  });
});

describe('lightning and thunder coupling', () => {
  it('constructs a complete fresh scene graph without relying on HMR state', () => {
    const worldWind = new WorldWind(1);
    worldWind.setMean(6, 144, 0.3);
    const construct = () =>
      new WeatherPresentation({
        worldWind,
        frameHeadingDeg: () => 0,
        cameraPosition: () => new THREE.Vector3(),
        anchorPosition: () => new THREE.Vector3(),
        playThunder: () => {},
      });
    const presentation = construct();
    expect(presentation.group.name).toBe('weather:presentation');
    expect(presentation.group.children.map((child) => child.name)).toEqual([
      'weather:near-rain',
      'weather:lightning-bolt',
      'weather:world-wind-cue',
    ]);
    expect(presentation.windCueVisible).toBe(false);
    presentation.dispose();
    expect(() => {
      const second = construct();
      second.dispose();
    }).not.toThrow();
  });

  it('has no events at zero activity and repeats the same seeded schedule', () => {
    for (let slot = 0; slot < 100; slot++) {
      expect(stormEventForSlot(slot, 0)).toBeNull();
    }
    const first = Array.from({ length: 30 }, (_, slot) =>
      stormEventForSlot(slot, 0.95),
    );
    const repeated = Array.from({ length: 30 }, (_, slot) =>
      stormEventForSlot(slot, 0.95),
    );
    expect(repeated).toEqual(first);
    expect(first.filter(Boolean).length).toBeGreaterThan(10);
  });

  it('delays thunder monotonically with strike distance', () => {
    expect(thunderDelaySeconds(0)).toBe(0);
    expect(thunderDelaySeconds(343)).toBe(1);
    expect(thunderDelaySeconds(686)).toBe(2);
    expect(() => thunderDelaySeconds(-1)).toThrow(RangeError);
  });

  it('uses an absolute, double-pulse flash envelope', () => {
    expect(lightningEnvelope(-0.01)).toBe(0);
    expect(lightningEnvelope(0.025)).toBeGreaterThan(0.9);
    expect(lightningEnvelope(0.07)).toBeCloseTo(0.12, 12);
    expect(lightningEnvelope(0.15)).toBeGreaterThan(0.4);
    expect(lightningEnvelope(0.24)).toBe(0);
  });

  it('queues manual lightning and releases its one thunder only after delay', () => {
    const worldWind = new WorldWind(99);
    worldWind.setMean(9, 144, 0.5);
    const playThunder = vi.fn();
    const camera = new THREE.Vector3(0, 4, 0);
    const anchor = new THREE.Vector3(0, 0, 0);
    const presentation = new WeatherPresentation({
      worldWind,
      frameHeadingDeg: () => 0,
      cameraPosition: () => camera,
      anchorPosition: () => anchor,
      reviewStrikeBearingRad: () => 0,
      playThunder,
    });
    const dry = weatherPresetState('clear', BASE_WIND);

    presentation.update(0, dry);
    presentation.triggerLightning();
    expect(presentation.reading.lastFlashId).toBe(-1);
    expect(presentation.reading.pendingThunder).toBe(1);
    presentation.update(0.1, dry);
    expect(presentation.reading.flashActive).toBe(true);
    const bolt = presentation.group.getObjectByName(
      'weather:lightning-bolt',
    ) as THREE.InstancedMesh;
    expect(bolt).toBeInstanceOf(THREE.InstancedMesh);
    expect(bolt.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect((bolt.material as THREE.MeshBasicMaterial).toneMapped).toBe(false);
    const firstStroke = new THREE.Matrix4();
    const firstStrokePosition = new THREE.Vector3();
    const firstStrokeRotation = new THREE.Quaternion();
    const firstStrokeScale = new THREE.Vector3();
    bolt.getMatrixAt(0, firstStroke);
    firstStroke.decompose(
      firstStrokePosition,
      firstStrokeRotation,
      firstStrokeScale,
    );
    expect(firstStrokeScale.x).toBeGreaterThan(1);
    expect(firstStrokeScale.y).toBeGreaterThan(1);
    expect(firstStrokeScale.z).toBeGreaterThan(1);
    expect(firstStrokePosition.toArray().every(Number.isFinite)).toBe(true);
    expect(firstStrokePosition.z).toBeLessThan(0);
    expect(playThunder).not.toHaveBeenCalled();

    for (let time = 0.2; time <= 6; time += 0.1) {
      presentation.update(time, dry);
    }
    expect(playThunder).toHaveBeenCalledTimes(1);
    const firstCue = playThunder.mock.calls[0][0];
    expect(firstCue.eventId).toBe(-1);
    expect(firstCue.delaySeconds).toBeCloseTo(
      thunderDelaySeconds(firstCue.distanceM),
      12,
    );
    expect(presentation.reading.lastThunderId).toBe(-1);
    expect(presentation.reading.pendingThunder).toBe(0);

    // Reset also resets the manual sequence, so the exact cue comes back.
    presentation.reset(0);
    playThunder.mockClear();
    presentation.triggerLightning();
    for (let time = 0.1; time <= 6; time += 0.1) {
      presentation.update(time, dry);
    }
    expect(playThunder.mock.calls[0][0]).toEqual(firstCue);
    presentation.dispose();
  });

  it('renders rain from WeatherState and honours independent presentation kills', () => {
    const worldWind = new WorldWind(12);
    worldWind.setMean(10, 90, 0);
    const setCloudCoverThreshold = vi.fn();
    const setVisibilityM = vi.fn();
    const presentation = new WeatherPresentation({
      worldWind,
      frameHeadingDeg: () => 0,
      cameraPosition: () => new THREE.Vector3(0, 4, 0),
      anchorPosition: () => new THREE.Vector3(0, 0, 0),
      playThunder: () => {},
      setCloudCoverThreshold,
      setVisibilityM,
    });
    presentation.update(1, weatherPresetState('rain', BASE_WIND));
    expect(presentation.reading.activeRainDrops).toBeGreaterThan(0);
    expect(setCloudCoverThreshold).toHaveBeenLastCalledWith(0.36, false);
    expect(setVisibilityM).toHaveBeenLastCalledWith(3500);

    presentation.setRainEnabled(false);
    presentation.update(2, weatherPresetState('storm', BASE_WIND));
    expect(presentation.reading.activeRainDrops).toBe(0);
    expect(setCloudCoverThreshold).toHaveBeenLastCalledWith(0.24, true);
    expect(setVisibilityM).toHaveBeenLastCalledWith(900);
    presentation.setWindCueVisible(true);
    expect(presentation.reading.windCueVisible).toBe(true);
    presentation.setLightningEnabled(false);
    presentation.triggerLightning();
    expect(presentation.reading.lastFlashId).toBeNull();
    presentation.dispose();
  });

  it('manual event data itself is deterministic', () => {
    expect(manualStormEvent(10, 2)).toEqual(manualStormEvent(10, 2));
    expect(manualStormEvent(10, 2)).not.toEqual(manualStormEvent(10, 3));
  });
});
