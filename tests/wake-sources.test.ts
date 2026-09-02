import { describe, expect, it } from 'vitest';
import type { OvertopEvent } from '../src/vessel/BuoyantBody';
import {
  createHullWaterContact,
  type HullWaterContact,
  type LongitudinalContactRegion,
} from '../src/vessel/HullWaterContact';
import {
  WAKE_WATERLINE_POLYLINE_STATIONS,
  WakeSources,
} from '../src/vessel/WakeSources';
import { runWakeContactCase } from '../src/vessel/schooner/WakeSourcesEvidence';

function contactFixture(options: {
  stationIndex: number;
  z: number;
  region: LongitudinalContactRegion;
  entrySpeedMps?: number;
  wet?: boolean;
  port?: [number, number, number];
  starboard?: [number, number, number];
}): HullWaterContact {
  const contact = createHullWaterContact({
    stationIndex: options.stationIndex,
    stationX: 0,
    stationZ: options.z,
    longitudinalRegion: options.region,
    transverseRegion: 'centre',
  });
  contact.isWet = options.wet ?? true;
  contact.normalEntrySpeedMps = options.entrySpeedMps ?? 0;

  if (options.port) {
    contact.portWaterline.active = true;
    [
      contact.portWaterline.worldPoint.x,
      contact.portWaterline.worldPoint.y,
      contact.portWaterline.worldPoint.z,
    ] = options.port;
    [
      contact.portWaterline.localPoint.x,
      contact.portWaterline.localPoint.y,
      contact.portWaterline.localPoint.z,
    ] = options.port;
  }
  if (options.starboard) {
    contact.starboardWaterline.active = true;
    [
      contact.starboardWaterline.worldPoint.x,
      contact.starboardWaterline.worldPoint.y,
      contact.starboardWaterline.worldPoint.z,
    ] = options.starboard;
    [
      contact.starboardWaterline.localPoint.x,
      contact.starboardWaterline.localPoint.y,
      contact.starboardWaterline.localPoint.z,
    ] = options.starboard;
  }
  return contact;
}

describe('wake source condensation', () => {
  it('selects the aft-most complete stern cut and copies every active bow point', () => {
    const contacts = [
      contactFixture({
        stationIndex: 4,
        z: -4,
        region: 'stern',
        entrySpeedMps: 0.4,
        port: [1.2, 0.1, -4],
        starboard: [-1.1, 0.2, -4],
      }),
      contactFixture({
        stationIndex: 1,
        z: -7,
        region: 'stern',
        entrySpeedMps: 0.8,
        port: [0.7, 0.3, -7],
        starboard: [-0.6, 0.4, -7],
      }),
      contactFixture({
        stationIndex: 35,
        z: 5,
        region: 'bow',
        entrySpeedMps: 1.5,
        port: [1.0, 0.5, 5],
        starboard: [-0.9, 0.6, 5],
      }),
      contactFixture({
        stationIndex: 38,
        z: 7,
        region: 'bow',
        entrySpeedMps: 2.5,
        port: [0.2, 0.7, 7],
      }),
    ];
    const sources = new WakeSources(contacts, []).update();

    expect(sources.sternWaterline).toMatchObject({
      active: true,
      stationIndex: 1,
      port: { x: 0.7, y: 0.3, z: -7 },
      starboard: { x: -0.6, y: 0.4, z: -7 },
    });
    expect(sources.bowWaterlinePointCount).toBe(3);
    expect(sources.bowWaterlinePoints.slice(0, 3)).toMatchObject([
      { stationIndex: 35, side: 'port', x: 1, y: 0.5, z: 5 },
      { stationIndex: 35, side: 'starboard', x: -0.9, y: 0.6, z: 5 },
      { stationIndex: 38, side: 'port', x: 0.2, y: 0.7, z: 7 },
    ]);
    expect(sources.bowStemWaterline).toMatchObject({
      active: true,
      stationIndex: 35,
      port: { x: 1, y: 0.5, z: 5 },
      starboard: { x: -0.9, y: 0.6, z: 5 },
    });
    expect(sources.resolvedWaterlineStationCount).toBe(3);
    expect(
      sources.resolvedWaterlineStations
        .slice(0, 3)
        .map((station) => station.stationIndex),
    ).toEqual([1, 4, 35]);
    expect(sources.regions.stern).toMatchObject({
      wetStationCount: 2,
      waterlinePointCount: 4,
      peakEntrySpeedMps: 0.8,
    });
    expect(sources.regions.stern.meanEntrySpeedMps).toBeCloseTo(0.6, 12);
    expect(sources.regions.bow).toEqual({
      wetStationCount: 2,
      waterlinePointCount: 3,
      meanEntrySpeedMps: 2,
      peakEntrySpeedMps: 2.5,
      immersedVolumeM3: 0,
    });
  });

  it('excludes dry stations from entry statistics without losing their waterline facts', () => {
    const dry = contactFixture({
      stationIndex: 20,
      z: 1,
      region: 'midships',
      wet: false,
      entrySpeedMps: 9,
      port: [1, 0, 1],
    });
    const sources = new WakeSources([dry], []).update();

    expect(sources.regions.midships).toEqual({
      wetStationCount: 0,
      waterlinePointCount: 1,
      meanEntrySpeedMps: 0,
      peakEntrySpeedMps: 0,
      immersedVolumeM3: 0,
    });
  });

  it('resamples the complete waterline into continuous matched hull-side polylines', () => {
    const contacts = [
      contactFixture({
        stationIndex: 30,
        z: 6,
        region: 'bow',
        port: [0.5, 0.6, 6],
        starboard: [-0.5, 0.7, 6],
      }),
      contactFixture({
        stationIndex: 0,
        z: -6,
        region: 'stern',
        port: [0.75, 0, -6],
        starboard: [-0.75, 0.1, -6],
      }),
      contactFixture({
        stationIndex: 15,
        z: 0,
        region: 'midships',
        port: [2, 0.3, 0],
        starboard: [-2, 0.4, 0],
      }),
    ];
    const sources = new WakeSources(contacts, []).update();

    expect(sources.waterlinePolylineStationCount).toBe(
      WAKE_WATERLINE_POLYLINE_STATIONS,
    );
    expect(sources.waterlinePolylinePoints).toHaveLength(
      WAKE_WATERLINE_POLYLINE_STATIONS * 2,
    );
    expect(sources.waterlinePolylinePoints.slice(0, 2)).toMatchObject([
      { side: 'port', stationLocalZ: -6, x: 0.75, z: -6 },
      { side: 'starboard', stationLocalZ: -6, x: -0.75, z: -6 },
    ]);
    expect(sources.waterlinePolylinePoints.slice(-2)).toMatchObject([
      { side: 'port', stationLocalZ: 6, x: 0.5, z: 6 },
      { side: 'starboard', stationLocalZ: 6, x: -0.5, z: 6 },
    ]);

    const midshipsPort = sources.waterlinePolylinePoints[6 * 2];
    const midshipsStarboard = sources.waterlinePolylinePoints[6 * 2 + 1];
    expect(midshipsPort).toMatchObject({
      side: 'port',
      stationLocalZ: 0,
      x: 2,
      y: 0.3,
      z: 0,
    });
    expect(midshipsStarboard).toMatchObject({
      side: 'starboard',
      stationLocalZ: 0,
      x: -2,
      y: 0.4,
      z: 0,
    });
    for (let i = 1; i < WAKE_WATERLINE_POLYLINE_STATIONS; i++) {
      expect(
        sources.waterlinePolylinePoints[i * 2].stationLocalZ -
          sources.waterlinePolylinePoints[(i - 1) * 2].stationLocalZ,
      ).toBeCloseTo(1, 12);
    }
  });

  it('rewrites one stable output graph and exposes the body event list by reference', () => {
    const stern = contactFixture({
      stationIndex: 2,
      z: -6,
      region: 'stern',
      entrySpeedMps: 1,
      port: [1, 0, -6],
      starboard: [-1, 0, -6],
    });
    const bow = contactFixture({
      stationIndex: 36,
      z: 6,
      region: 'bow',
      entrySpeedMps: 2,
      port: [0.5, 0, 6],
    });
    const events: OvertopEvent[] = [];
    const sources = new WakeSources([stern, bow], events);
    sources.update();

    const segment = sources.sternWaterline;
    const segmentPort = segment.port;
    const points = sources.bowWaterlinePoints;
    const firstPoint = points[0];
    const bowStats = sources.regions.bow;
    const resolvedStations = sources.resolvedWaterlineStations;
    const waterlinePolyline = sources.waterlinePolylinePoints;
    const firstPolylinePoint = waterlinePolyline[0];

    events.push({
      x: 0,
      y: 1,
      z: 2,
      speed: 3,
      depth: 0.2,
      durationSeconds: 1 / 240,
      contactWidthM: 1,
      tributaryAreaM2: 1,
      stationIndex: 0,
      batchStepIndex: 0,
      stationLocalZ: 2,
      boardingSide: 'starboard',
      flowX: 4,
      flowZ: 5,
    });
    stern.portWaterline.active = false;
    stern.starboardWaterline.active = false;
    bow.portWaterline.worldPoint.x = 3.5;
    bow.normalEntrySpeedMps = 4;
    sources.update();

    expect(sources.sternWaterline).toBe(segment);
    expect(sources.sternWaterline.port).toBe(segmentPort);
    expect(sources.sternWaterline.active).toBe(false);
    expect(sources.bowWaterlinePoints).toBe(points);
    expect(sources.bowWaterlinePoints[0]).toBe(firstPoint);
    expect(sources.bowWaterlinePoints[0].x).toBe(3.5);
    expect(sources.regions.bow).toBe(bowStats);
    expect(sources.resolvedWaterlineStations).toBe(resolvedStations);
    expect(sources.waterlinePolylinePoints).toBe(waterlinePolyline);
    expect(sources.waterlinePolylinePoints[0]).toBe(firstPolylinePoint);
    expect(sources.regions.bow.meanEntrySpeedMps).toBe(4);
    expect(sources.activeOvertopEvents).toBe(events);
    expect(sources.activeOvertopEventCount).toBe(1);
  });

  it('does not invent a stern segment from a one-sided waterline cut', () => {
    const contact = contactFixture({
      stationIndex: 0,
      z: -7,
      region: 'stern',
      port: [0.5, 0, -7],
    });
    const sources = new WakeSources([contact], []).update();

    expect(sources.sternWaterline.active).toBe(false);
    expect(sources.sternWaterline.stationIndex).toBe(-1);
    expect(sources.regions.stern.waterlinePointCount).toBe(1);
  });
});

describe('wake contact evidence', () => {
  it('is deterministic for the same seeded sea and fixed-step timing', () => {
    const config = {
      name: 'TEST_MODERATE',
      seaStateName: 'CURRENT_MODERATE',
      speedMps: 2.5,
      leewayDeg: 1.25,
    };
    const timing = {
      warmupSeconds: 0.05,
      measurementSeconds: 0.1,
      callerHz: 60,
      sourceSampleHz: 10,
    };

    const first = runWakeContactCase(config, timing);
    const second = runWakeContactCase(config, timing);

    expect(second).toEqual(first);
    expect(first.sourceSeries).toHaveLength(2);
    expect(first.entrySpeeds.bow.samples).toBeGreaterThan(0);
  });
});
