import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import {
  HULL_ATTITUDE_LIMIT_RADIANS,
  PHYSICS_STEP,
  type BuoyantBodySubstepAttitude,
  type OvertopEvent,
} from '../src/vessel/BuoyantBody';
import { buildSchoonerBuoyancy, buildSchoonerStations } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  SCHOONER_BOARDING_DISCHARGE_COEFFICIENT,
  advanceSchoonerBoardingIngress,
  resolveSchoonerBoardingIngress,
  schoonerBoardingCellShares,
} from '../src/vessel/schooner/SchoonerBoardingIngress';
import { advanceSchoonerDeckWater } from '../src/vessel/schooner/SchoonerDeckWaterAdvance';
import {
  NO_SCHOONER_DECK_WATER_REQUESTS,
  SCHOONER_DECK_WATER_CELLS,
  resolveSchoonerDeckWaterTransport,
} from '../src/vessel/schooner/SchoonerDeckWaterTransport';
import {
  ShipWaterState,
  ZERO_SHIP_DYNAMIC_WATER_LOAD,
} from '../src/vessel/schooner/ShipWaterState';
import {
  SCHOONER_LARGE_ANGLE_BOUNDARY,
  probeSchoonerRollHydrostatics,
} from '../src/vessel/schooner/largeAngleHydrostatics';
import {
  SHIP_WATER_COMPARTMENT_GEOMETRY,
  SHIP_WATER_COMPARTMENT_NAMES,
} from '../src/vessel/schooner/shipWaterCompartments';
import {
  SHIP_WATER_OPENINGS,
  SHIP_WATER_OPENING_NAMES,
} from '../src/vessel/schooner/shipWaterOpenings';
import { deckHalfWidth, deckLevelAt } from '../src/vessel/schooner/deckSurface';
import {
  ZERO_OVERTOP_FLUX,
  resolveOvertopFlux,
} from '../src/vessel/schooner/overtopFlux';
import { HULL_LENGTH, STATION_SPACING, stationZ } from '../src/vessel/schooner/hullForm';
import { Schooner } from '../src/vessel/schooner/Schooner';
import { presentationHeadingToModelYawRadians } from '../src/vessel/schooner/SchoonerResponse';

function overtop(overrides: Partial<OvertopEvent> = {}): OvertopEvent {
  return {
    x: 0,
    y: 0,
    z: 0,
    speed: 1,
    depth: 0.2,
    durationSeconds: 0.25,
    contactWidthM: 1.5,
    tributaryAreaM2: 2,
    stationIndex: 0,
    batchStepIndex: 0,
    stationLocalZ: 1,
    boardingSide: 'starboard',
    flowX: 0,
    flowZ: 0,
    ...overrides,
  };
}

function canonicalBoardingEvent(
  stationIndex: number,
  overrides: Partial<OvertopEvent> = {},
): OvertopEvent {
  const stationLocalZ = stationZ(stationIndex);
  return overtop({
    durationSeconds: PHYSICS_STEP,
    stationIndex,
    stationLocalZ,
    contactWidthM: STATION_SPACING,
    tributaryAreaM2:
      STATION_SPACING *
      deckHalfWidth(stationLocalZ, deckLevelAt(stationLocalZ)),
    ...overrides,
  });
}

describe('SURV0 ship-water authority', () => {
  it('publishes stable positive compartment geometry and a directed opening graph', () => {
    expect(SHIP_WATER_COMPARTMENT_NAMES).toEqual([
      'weatherDeckAftStarboard',
      'weatherDeckAftPort',
      'weatherDeckForeStarboard',
      'weatherDeckForePort',
      'holdBilge',
      'cabin',
      'landing',
      'wardroom',
      'forecastle',
    ]);
    for (const name of SHIP_WATER_COMPARTMENT_NAMES) {
      const geometry = SHIP_WATER_COMPARTMENT_GEOMETRY[name];
      expect(geometry.name).toBe(name);
      expect(geometry.maximumCapacityM3).toBeGreaterThan(0);
      expect(geometry.freeSurfacePlanAreaM2).toBeGreaterThan(0);
      expect(Number.isFinite(geometry.fullCentroid.y)).toBe(true);
    }
    expect(Object.keys(SHIP_WATER_OPENINGS)).toEqual([...SHIP_WATER_OPENING_NAMES]);
    for (const name of SHIP_WATER_OPENING_NAMES) {
      const opening = SHIP_WATER_OPENINGS[name];
      expect(opening.name).toBe(name);
      expect(opening.from).not.toBe(opening.to);
      expect(opening.clearAreaM2 === null || opening.clearAreaM2 > 0).toBe(true);
    }
  });

  it('has a bit-exact dry state, ledger, reset and dynamic-load seam', () => {
    const water = new ShipWaterState();
    expect(water.onboardVolumeM3).toBe(0);
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
    for (const name of SHIP_WATER_COMPARTMENT_NAMES) {
      const state = water.compartment(name);
      expect(Object.is(state.volumeM3, 0)).toBe(true);
      expect(Object.is(state.fillFraction, 0)).toBe(true);
      expect(Object.is(state.freeSurfaceAreaM2, 0)).toBe(true);
    }

    water.advance(2, () => []);
    expect(water.stepIndex).toBe(480);
    expect(water.ledger()).toMatchObject({
      requestedM3: 0,
      transferredM3: 0,
      rejectedM3: 0,
      externalIngressM3: 0,
      externalDischargeM3: 0,
      internalTransferM3: 0,
      onboardVolumeM3: 0,
      conservationResidualM3: 0,
    });
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
    water.reset();
    expect(water.stepIndex).toBe(0);
    expect(water.timeSeconds).toBe(0);
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
  });

  it('is exactly caller-rate invariant at 30, 60, 120 and 240 Hz', () => {
    const run = (callerHz: number) => {
      const water = new ShipWaterState();
      for (let frame = 0; frame < callerHz * 8; frame++) {
        water.advance(1 / callerHz, () => [
          { opening: 'railForePort', rateM3PerSecond: 0.02 },
        ]);
      }
      return {
        stepIndex: water.stepIndex,
        timeSeconds: water.timeSeconds,
        compartment: water.compartment('weatherDeckForePort'),
        ledger: water.ledger(),
        load: water.dynamicLoad(),
      };
    };

    const at240 = run(240);
    expect(at240.stepIndex).toBe(8 * 240);
    for (const rate of [30, 60, 120]) expect(run(rate)).toStrictEqual(at240);
  });

  it('conserves ingress, internal transfer and discharge while gating closures', () => {
    let hatchwayBoardsOpen = false;
    const water = new ShipWaterState({
      closureIsOpen: (name) => name === 'hatchwayBoards' && hatchwayBoardsOpen,
    });
    for (let step = 0; step < 1_200; step++) {
      water.advance(1 / 240, ({ stepIndex }) => {
        if (stepIndex < 240) {
          return [{ opening: 'railForeStarboard', rateM3PerSecond: 0.2 }];
        }
        if (stepIndex < 480) {
          return [{ opening: 'cargoGratingStarboard', rateM3PerSecond: 0.1 }];
        }
        if (stepIndex < 720) {
          hatchwayBoardsOpen = false;
          return [{ opening: 'hatchwayBoards', rateM3PerSecond: 0.05 }];
        }
        if (stepIndex < 960) {
          hatchwayBoardsOpen = true;
          return [{ opening: 'hatchwayBoards', rateM3PerSecond: 0.05 }];
        }
        return [
          { opening: 'bilgePump', rateM3PerSecond: 0.02 },
          { opening: 'scupperForeStarboard', rateM3PerSecond: 0.03 },
        ];
      });
    }

    const ledger = water.ledger();
    expect(ledger.externalIngressM3).toBeCloseTo(0.2, 12);
    expect(ledger.externalDischargeM3).toBeCloseTo(0.05, 12);
    expect(ledger.internalTransferM3).toBeCloseTo(0.15, 12);
    expect(ledger.byOpening.hatchwayBoards.requestedM3).toBeCloseTo(0.1, 12);
    expect(ledger.byOpening.hatchwayBoards.transferredM3).toBeCloseTo(0.05, 12);
    expect(water.compartment('weatherDeckForeStarboard').volumeM3).toBeCloseTo(0.07, 12);
    expect(water.compartment('wardroom').volumeM3).toBeCloseTo(0.05, 12);
    expect(water.compartment('holdBilge').volumeM3).toBeCloseTo(0.03, 12);
    expect(ledger.onboardVolumeM3).toBeCloseTo(0.15, 12);
    expect(Math.abs(ledger.conservationResidualM3)).toBeLessThan(1e-12);
    expect(water.dynamicLoad().massKg).toBeCloseTo(0.15 * 1025, 10);
    expect(water.dynamicLoad().freeSurfaceRollM4).toBeGreaterThan(0);
  });

  it('leaves production hull motion bit-identical while the sidecar stays dry', () => {
    const baseline = buildSchoonerBuoyancy();
    const withSidecar = buildSchoonerBuoyancy();
    const baselineWaves = new WaveField(findSeaState('CURRENT_MODERATE'));
    const sidecarWaves = new WaveField(findSeaState('CURRENT_MODERATE'));
    const water = new ShipWaterState();
    baseline.snapToSurface(baselineWaves, 0, 0, 0);
    withSidecar.snapToSurface(sidecarWaves, 0, 0, 0);

    const stateOf = (body: typeof baseline) => [
      body.comWorldY,
      body.velocityY,
      body.pitch,
      body.roll,
      body.pitchRate,
      body.rollRate,
      body.accelerationY,
      body.centreWaterY,
      body.externalWrenchWorkJ,
    ];
    for (let frame = 0; frame < 180; frame++) {
      baseline.update(1 / 60, baselineWaves, 0, 0, 0);
      withSidecar.update(1 / 60, sidecarWaves, 0, 0, 0);
      expect(withSidecar.overtopEvents).toHaveLength(0);
      advanceSchoonerDeckWater(
        water,
        withSidecar.lastSubsteps,
        withSidecar.overtopEvents,
        withSidecar.substepAttitudes,
      );
      const expected = stateOf(baseline);
      const actual = stateOf(withSidecar);
      for (let i = 0; i < expected.length; i++) {
        expect(Object.is(actual[i], expected[i])).toBe(true);
      }
      expect(Object.is(sidecarWaves.time, baselineWaves.time)).toBe(true);
    }
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
  });
});

describe('SURV1 safe foundation', () => {
  it('publishes one reusable start-pose attitude fact per body substep', () => {
    const body = buildSchoonerBuoyancy();
    const waves = new WaveField(findSeaState('FLAT'));
    body.snapToSurface(waves, 0, 0, 0);
    body.pitch = 0.08;
    body.roll = -0.12;
    body.pitchRate = 0.05;
    body.rollRate = 0.08;

    body.update(2 * PHYSICS_STEP, waves, 0, 0, 0, PHYSICS_STEP);
    expect(body.lastSubsteps).toBe(2);
    expect(body.substepAttitudes).toHaveLength(2);
    expect(body.substepAttitudes[0]).toMatchObject({
      batchStepIndex: 0,
      durationSeconds: PHYSICS_STEP,
      pitchRad: 0.08,
      rollRad: -0.12,
    });
    expect(body.substepAttitudes[1].batchStepIndex).toBe(1);
    expect(body.substepAttitudes[1].durationSeconds).toBe(PHYSICS_STEP);
    expect([
      body.substepAttitudes[1].pitchRad,
      body.substepAttitudes[1].rollRad,
    ]).not.toEqual([0.08, -0.12]);

    const firstFact = body.substepAttitudes[0];
    body.update(PHYSICS_STEP, waves, 0, 0, 0, PHYSICS_STEP);
    expect(body.substepAttitudes).toHaveLength(1);
    expect(body.substepAttitudes[0]).toBe(firstFact);
    expect(body.substepAttitudes[0].batchStepIndex).toBe(0);
  });

  it('publishes finite overtop contact and tributary geometry at every station', () => {
    const stations = buildSchoonerStations();
    expect(stations.length).toBeGreaterThan(30);
    for (const station of stations) {
      expect(station.overtopContactWidthM).toBeGreaterThan(0);
      expect(station.overtopTributaryAreaM2).toBeGreaterThan(0);
      expect(Number.isFinite(station.overtopTributaryAreaM2)).toBe(true);
    }
    expect(
      stations.reduce(
        (sum, station) => sum + station.overtopContactWidthM,
        0,
      ),
    ).toBeCloseTo(HULL_LENGTH, 12);
    expect(
      stations.every(
        (station) => station.overtopContactWidthM === STATION_SPACING,
      ),
    ).toBe(true);
    const tributaryAreaM2 = stations.reduce(
      (sum, station) => sum + station.overtopTributaryAreaM2,
      0,
    );
    const starboardDeckAreaM2 =
      SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckAftStarboard
        .freeSurfacePlanAreaM2 +
      SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckForeStarboard
        .freeSurfacePlanAreaM2;
    expect(
      Math.abs(tributaryAreaM2 - starboardDeckAreaM2) /
        starboardDeckAreaM2,
    ).toBeLessThan(0.002);
  });

  it('resolves a pure provisional weir flux with a finite water-prism cap', () => {
    expect(resolveOvertopFlux(overtop({ depth: 0 }))).toBe(ZERO_OVERTOP_FLUX);
    expect(resolveOvertopFlux(overtop({ contactWidthM: 0 }))).toBe(ZERO_OVERTOP_FLUX);

    const ordinary = resolveOvertopFlux(overtop());
    expect(ordinary.weirRateM3PerSecond).toBeGreaterThan(0);
    expect(ordinary.volumeM3).toBeCloseTo(
      ordinary.weirRateM3PerSecond * 0.25,
      12,
    );
    expect(ordinary.cappedByTributaryArea).toBe(false);

    const capped = resolveOvertopFlux(
      overtop({ depth: 1, durationSeconds: 10, contactWidthM: 10, tributaryAreaM2: 0.1 }),
    );
    expect(capped.cappedByTributaryArea).toBe(true);
    expect(capped.waterPrismCapM3).toBe(0.1);
    expect(capped.volumeM3).toBe(0.1);
    expect(capped.resolvedRateM3PerSecond).toBe(0.01);
  });

  it('projects deck-cell surface heads into ship-frame heel and pitch', () => {
    const water = new ShipWaterState();
    const depthM = 0.01;
    water.advance(PHYSICS_STEP, () => [
      {
        opening: 'railAftStarboard',
        rateM3PerSecond:
          depthM *
          SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckAftStarboard
            .freeSurfacePlanAreaM2 /
          PHYSICS_STEP,
      },
      {
        opening: 'railAftPort',
        rateM3PerSecond:
          depthM *
          SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckAftPort
            .freeSurfacePlanAreaM2 /
          PHYSICS_STEP,
      },
      {
        opening: 'railForeStarboard',
        rateM3PerSecond:
          depthM *
          SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckForeStarboard
            .freeSurfacePlanAreaM2 /
          PHYSICS_STEP,
      },
      {
        opening: 'railForePort',
        rateM3PerSecond:
          depthM *
          SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckForePort
            .freeSurfacePlanAreaM2 /
          PHYSICS_STEP,
      },
    ]);

    expect(
      resolveSchoonerDeckWaterTransport(water, {
        rollRad: 0,
        pitchRad: 0,
      }),
    ).toBe(NO_SCHOONER_DECK_WATER_REQUESTS);
    expect(
      resolveSchoonerDeckWaterTransport(water, {
        rollRad: 0.25,
        pitchRad: 0.12,
      }).map((request) => request.opening),
    ).toEqual([
      'deckAftPortToStarboard',
      'deckForePortToStarboard',
      'deckStarboardAftToFore',
      'deckPortAftToFore',
    ]);
  });

  it('keeps dry deck transport exact and canonical', () => {
    const water = new ShipWaterState();
    const attitude = { rollRad: 0.3, pitchRad: -0.15 };
    for (let frame = 0; frame < 600; frame++) {
      water.advance(1 / 60, ({ water: state }) => {
        const requests = resolveSchoonerDeckWaterTransport(state, attitude);
        expect(requests).toBe(NO_SCHOONER_DECK_WATER_REQUESTS);
        return requests;
      });
    }
    expect(water.stepIndex).toBe(2_400);
    expect(water.onboardVolumeM3).toBe(0);
    expect(water.ledger()).toMatchObject({
      requestedM3: 0,
      transferredM3: 0,
      externalIngressM3: 0,
      internalTransferM3: 0,
      onboardVolumeM3: 0,
      conservationResidualM3: 0,
    });
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
    expect(() =>
      resolveSchoonerDeckWaterTransport(water, {
        rollRad: HULL_ATTITUDE_LIMIT_RADIANS + 1e-6,
        pitchRad: 0,
      }),
    ).toThrow(/production attitude limiter/);
  });

  it('advects bounded deck water without loss, negative cells, or rejected transfer', () => {
    const water = new ShipWaterState();
    water.advance(PHYSICS_STEP, () => [
      {
        opening: 'railAftPort',
        rateM3PerSecond: 0.4 / PHYSICS_STEP,
      },
    ]);
    const before = water.volumeM3('weatherDeckAftPort');
    for (let step = 0; step < 12 * 240; step++) {
      water.advance(PHYSICS_STEP, ({ water: state }) =>
        resolveSchoonerDeckWaterTransport(state, {
          rollRad: 0.28,
          pitchRad: 0.12,
        }),
      );
      for (const name of SCHOONER_DECK_WATER_CELLS) {
        expect(water.volumeM3(name)).toBeGreaterThanOrEqual(0);
        expect(water.volumeM3(name)).toBeLessThanOrEqual(
          SHIP_WATER_COMPARTMENT_GEOMETRY[name].maximumCapacityM3,
        );
      }
    }

    const ledger = water.ledger();
    expect(water.volumeM3('weatherDeckAftPort')).toBeLessThan(before);
    expect(water.volumeM3('weatherDeckForeStarboard')).toBeGreaterThan(0);
    expect(ledger.externalIngressM3).toBeCloseTo(0.4, 15);
    expect(ledger.internalTransferM3).toBeGreaterThan(0);
    expect(Math.abs(ledger.rejectedM3)).toBeLessThan(1e-12);
    expect(ledger.onboardVolumeM3).toBeCloseTo(0.4, 12);
    expect(Math.abs(ledger.conservationResidualM3)).toBeLessThan(1e-12);
  });

  it('advects a fixed boarding-water case identically at 30/60/120/240 Hz', () => {
    const run = (callerHz: number) => {
      const water = new ShipWaterState();
      const attitude = { rollRad: 0.24, pitchRad: 0.1 };
      for (let frame = 0; frame < callerHz * 8; frame++) {
        water.advance(1 / callerHz, ({ stepIndex, water: state }) => {
          const transport = resolveSchoonerDeckWaterTransport(state, attitude);
          if (stepIndex >= 2 * 240) return transport;
          const boarding = {
            opening: 'railAftPort' as const,
            rateM3PerSecond: 0.12,
          };
          return transport.length === 0
            ? [boarding]
            : [boarding, ...transport];
        });
      }
      return {
        stepIndex: water.stepIndex,
        cells: Object.fromEntries(
          SCHOONER_DECK_WATER_CELLS.map((name) => [
            name,
            water.volumeM3(name),
          ]),
        ),
        ledger: water.ledger(),
        load: water.dynamicLoad(),
      };
    };

    const at240 = run(240);
    for (const callerHz of [30, 60, 120]) {
      expect(run(callerHz)).toStrictEqual(at240);
    }
    expect(at240.stepIndex).toBe(8 * 240);
    expect(at240.ledger.externalIngressM3).toBeCloseTo(0.24, 15);
    expect(at240.ledger.internalTransferM3).toBeGreaterThan(0);
    expect(at240.ledger.onboardVolumeM3).toBeCloseTo(0.24, 12);
    expect(Math.abs(at240.ledger.conservationResidualM3)).toBeLessThan(1e-12);
    expect(
      Object.values(at240.cells).every((volumeM3) => volumeM3 >= 0),
    ).toBe(true);
  });

  it('uses each ordered body attitude fact instead of smearing the final pose', () => {
    const seedPortSide = (water: ShipWaterState) => {
      const depthM = 0.02;
      water.advance(PHYSICS_STEP, () => [
        {
          opening: 'railAftPort',
          rateM3PerSecond:
            depthM *
            SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckAftPort
              .freeSurfacePlanAreaM2 /
            PHYSICS_STEP,
        },
        {
          opening: 'railForePort',
          rateM3PerSecond:
            depthM *
            SHIP_WATER_COMPARTMENT_GEOMETRY.weatherDeckForePort
              .freeSurfacePlanAreaM2 /
            PHYSICS_STEP,
        },
      ]);
    };
    const fact = (
      batchStepIndex: number,
      rollRad: number,
    ): BuoyantBodySubstepAttitude => ({
      batchStepIndex,
      durationSeconds: PHYSICS_STEP,
      pitchRad: 0,
      rollRad,
    });

    const ordered = new ShipWaterState();
    seedPortSide(ordered);
    advanceSchoonerDeckWater(
      ordered,
      2,
      [],
      [fact(0, -0.25), fact(1, 0.25)],
    );

    const smeared = new ShipWaterState();
    seedPortSide(smeared);
    advanceSchoonerDeckWater(
      smeared,
      2,
      [],
      [fact(0, 0.25), fact(1, 0.25)],
    );

    expect(
      ordered.ledger().byOpening.deckAftPortToStarboard.transferredM3,
    ).toBeGreaterThan(0);
    expect(
      smeared.ledger().byOpening.deckAftPortToStarboard.transferredM3,
    ).toBeGreaterThan(
      ordered.ledger().byOpening.deckAftPortToStarboard.transferredM3,
    );
    const stepBefore = ordered.stepIndex;
    expect(() =>
      advanceSchoonerDeckWater(
        ordered,
        2,
        [],
        [fact(0, 0.25)],
      ),
    ).toThrow(/one attitude fact per physics step/);
    expect(ordered.stepIndex).toBe(stepBefore);
  });

  it('routes station-owned strips, splits the centre strip, and de-duplicates only one station-step fact', () => {
    const starboardFore = canonicalBoardingEvent(30, {
      batchStepIndex: 0,
      boardingSide: 'starboard',
      depth: 0.2,
    });
    const strongerDuplicate = {
      ...starboardFore,
      depth: 0.24,
    };
    const portAft = canonicalBoardingEvent(5, {
      batchStepIndex: 0,
      boardingSide: 'port',
      depth: 0.18,
    });
    const centre = canonicalBoardingEvent(19, {
      batchStepIndex: 1,
      boardingSide: 'starboard',
      depth: 0.15,
    });

    expect(schoonerBoardingCellShares(centre)).toEqual([
      {
        cell: 'weatherDeckAftStarboard',
        opening: 'railAftStarboard',
        fraction: 0.5,
      },
      {
        cell: 'weatherDeckForeStarboard',
        opening: 'railForeStarboard',
        fraction: 0.5,
      },
    ]);
    const batch = resolveSchoonerBoardingIngress(
      [starboardFore, strongerDuplicate, portAft, centre],
      2,
    );
    expect(batch.eventSamples).toBe(4);
    expect(batch.uniqueStationContacts).toBe(3);
    expect(batch.duplicateStationContacts).toBe(1);
    expect(batch.maximumSimultaneousContactWidthM).toBeCloseTo(
      2 * STATION_SPACING,
      12,
    );
    expect(
      Object.values(batch.byCellM3).reduce((sum, volume) => sum + volume, 0),
    ).toBeCloseTo(batch.requestedVolumeM3, 15);

    const water = new ShipWaterState();
    const applied = advanceSchoonerBoardingIngress(
      water,
      2,
      [starboardFore, strongerDuplicate, portAft, centre],
    );
    expect(water.ledger().externalIngressM3).toBeCloseTo(
      applied.requestedVolumeM3,
      15,
    );
    expect(water.compartment('weatherDeckForeStarboard').volumeM3).toBeGreaterThan(0);
    expect(water.compartment('weatherDeckAftStarboard').volumeM3).toBeGreaterThan(0);
    expect(water.compartment('weatherDeckAftPort').volumeM3).toBeGreaterThan(0);

    expect(() =>
      resolveSchoonerBoardingIngress(
        [starboardFore, { ...starboardFore, boardingSide: 'port' }],
        1,
      ),
    ).toThrow(/disagree on owned geometry/);
    expect(() =>
      resolveSchoonerBoardingIngress(
        [{ ...starboardFore, stationLocalZ: starboardFore.stationLocalZ + 0.01 }],
        1,
      ),
    ).toThrow(/canonical station-owned strip/);
  });

  it('keeps the composed production water path exactly dry when the body emits no events', () => {
    const body = buildSchoonerBuoyancy();
    const waves = new WaveField(findSeaState('FLAT'));
    const water = new ShipWaterState();
    body.snapToSurface(waves, 0, 0, 0);
    const cachedBatch = resolveSchoonerBoardingIngress([], 4);
    expect(resolveSchoonerBoardingIngress([], 4)).toBe(cachedBatch);
    expect(cachedBatch.requestsByStep[0]).toBe(cachedBatch.requestsByStep[3]);
    for (let frame = 0; frame < 600; frame++) {
      body.update(1 / 60, waves, 0, 0, 0, PHYSICS_STEP);
      expect(body.overtopEvents).toHaveLength(0);
      const batch = advanceSchoonerDeckWater(
        water,
        body.lastSubsteps,
        body.overtopEvents,
        body.substepAttitudes,
      );
      expect(batch).toBe(cachedBatch);
      expect(batch.requestedVolumeM3).toBe(0);
      expect(batch.uniqueStationContacts).toBe(0);
    }
    expect(water.stepIndex).toBe(2_400);
    expect(water.onboardVolumeM3).toBe(0);
    expect(water.ledger()).toMatchObject({
      requestedM3: 0,
      transferredM3: 0,
      externalIngressM3: 0,
      onboardVolumeM3: 0,
      conservationResidualM3: 0,
    });
    expect(water.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
  });

  it('passes the composed boarding-and-transport gate exactly at 30/60/120/240 Hz', () => {
    const run = (callerHz: number) => {
      const body = buildSchoonerBuoyancy();
      const waves = new WaveField(findSeaState('SOUTHERN_OCEAN_ROUGH'));
      const water = new ShipWaterState();
      const yaw = presentationHeadingToModelYawRadians(75);
      body.snapToSurface(waves, 0, 0, yaw);
      let eventSamples = 0;
      let uniqueStationContacts = 0;
      let cappedEventCount = 0;
      let maximumSimultaneousContactWidthM = 0;
      let peakDepthM = 0;
      for (let frame = 0; frame < callerHz * 22; frame++) {
        body.update(1 / callerHz, waves, 0, 0, yaw, PHYSICS_STEP);
        for (const event of body.overtopEvents) {
          peakDepthM = Math.max(peakDepthM, event.depth);
        }
        const batch = advanceSchoonerDeckWater(
          water,
          body.lastSubsteps,
          body.overtopEvents,
          body.substepAttitudes,
        );
        eventSamples += batch.eventSamples;
        uniqueStationContacts += batch.uniqueStationContacts;
        cappedEventCount += batch.cappedEventCount;
        maximumSimultaneousContactWidthM = Math.max(
          maximumSimultaneousContactWidthM,
          batch.maximumSimultaneousContactWidthM,
        );
      }
      return {
        eventSamples,
        uniqueStationContacts,
        cappedEventCount,
        maximumSimultaneousContactWidthM,
        peakDepthM,
        stepIndex: water.stepIndex,
        ledger: water.ledger(),
        cells: Object.fromEntries(
          [
            'weatherDeckAftStarboard',
            'weatherDeckAftPort',
            'weatherDeckForeStarboard',
            'weatherDeckForePort',
          ].map((name) => [
            name,
            water.compartment(name as keyof typeof SHIP_WATER_COMPARTMENT_GEOMETRY),
          ]),
        ),
      };
    };

    const at240 = run(240);
    for (const callerHz of [30, 60, 120]) {
      expect(run(callerHz)).toStrictEqual(at240);
    }
    expect(SCHOONER_BOARDING_DISCHARGE_COEFFICIENT).toBe(1);
    expect(at240.eventSamples).toBe(835);
    expect(at240.uniqueStationContacts).toBe(at240.eventSamples);
    expect(at240.cappedEventCount).toBe(0);
    expect(at240.maximumSimultaneousContactWidthM).toBeCloseTo(
      8 * STATION_SPACING,
      15,
    );
    expect(at240.peakDepthM).toBeCloseTo(0.8268342232357601, 12);
    expect(at240.stepIndex).toBe(22 * 240);
    expect(at240.ledger.externalIngressM3).toBeCloseTo(0.6005345832978084, 12);
    expect(at240.ledger.internalTransferM3).toBeGreaterThan(0);
    expect(at240.ledger.onboardVolumeM3).toBeCloseTo(0.6005345832978084, 12);
    expect(Math.abs(at240.ledger.rejectedM3)).toBeLessThan(1e-12);
    expect(
      at240.ledger.byOpening.railAftStarboard.transferredM3,
    ).toBeCloseTo(0.6005345832978084, 12);
    expect(Math.abs(at240.ledger.conservationResidualM3)).toBeLessThan(1e-12);
  });

  it('applies one completed production batch and clears it at the production restart boundary', () => {
    const body = buildSchoonerBuoyancy();
    const waves = new WaveField(findSeaState('FLAT'));
    const waterState = new ShipWaterState();
    body.snapToSurface(waves, 0, 0, 0);
    body.roll = 0.25;
    waterState.advance(PHYSICS_STEP, () => [
      {
        opening: 'railAftPort',
        rateM3PerSecond: 0.1 / PHYSICS_STEP,
      },
    ]);
    const event = canonicalBoardingEvent(30, {
      batchStepIndex: 0,
      boardingSide: 'port',
      depth: 0.2,
    });
    const horizontalDynamics = {
      advance: () => {
        body.update(0, waves, 0, 0, 0, PHYSICS_STEP);
        body.update(
          PHYSICS_STEP,
          waves,
          0,
          0,
          0,
          PHYSICS_STEP,
          0,
          0,
          true,
        );
        body.overtopEvents.length = 0;
        body.overtopEvents.push(event);
        return {
          yawRad: 0.25,
          yawRateRadPerSecond: -0.125,
          substeps: 1,
        };
      },
      reset: () => undefined,
    };
    const ship = {
      body,
      horizontalDynamics,
      waterState,
      yaw: 0,
      yawRate: 0,
    } as unknown as Schooner;

    Schooner.prototype.advancePhysics.call(ship, {
      dt: PHYSICS_STEP,
      waves,
      localX: 0,
      localZ: 0,
      wind: undefined,
      elapsed: 0,
      encounterVelocity: { x: 0, z: 0 },
      horizontalMotion: {},
    } as unknown as Parameters<Schooner['advancePhysics']>[0]);

    expect(ship.yaw).toBe(0.25);
    expect(ship.yawRate).toBe(-0.125);
    expect(waterState.stepIndex).toBe(2);
    expect(
      waterState.compartment('weatherDeckForePort').volumeM3,
    ).toBeGreaterThan(0);
    expect(waterState.ledger().internalTransferM3).toBeGreaterThan(0);
    expect(waterState.ledger().conservationResidualM3).toBe(0);

    Schooner.prototype.resetHorizontalMotion.call(ship);
    expect(waterState.stepIndex).toBe(0);
    expect(waterState.onboardVolumeM3).toBe(0);
    expect(waterState.dynamicLoad()).toBe(ZERO_SHIP_DYNAMIC_WATER_LOAD);
  });

  it('wires only the production horizontal schooner path into composed deck water', () => {
    const source = readFileSync('src/vessel/schooner/Schooner.ts', 'utf8');
    expect(source).toMatch(
      /if \(horizontalMotion\)[\s\S]*?horizontalDynamics\.advance[\s\S]*?advanceSchoonerDeckWater\([\s\S]*?this\.waterState[\s\S]*?advanced\.substeps[\s\S]*?this\.body\.overtopEvents[\s\S]*?this\.body\.substepAttitudes/,
    );
    expect(source).not.toMatch(
      /waterState\.dynamicLoad\(\)[\s\S]*?(externalWrench|horizontalDynamics)/,
    );
  });

  it('draws an explicit credibility boundary at the runtime limiter and inversion', () => {
    expect(SCHOONER_LARGE_ANGLE_BOUNDARY.productionCredibilityRadians).toBe(
      HULL_ATTITUDE_LIMIT_RADIANS,
    );
    expect(SCHOONER_LARGE_ANGLE_BOUNDARY.graphRepresentationLimitRadians).toBe(
      Math.PI / 2,
    );
    expect(SCHOONER_LARGE_ANGLE_BOUNDARY.invertedHydrostaticsSupported).toBe(false);

    for (const degrees of [10, 25, 40]) {
      const positive = probeSchoonerRollHydrostatics(degrees * Math.PI / 180);
      const negative = probeSchoonerRollHydrostatics(-degrees * Math.PI / 180);
      expect(positive.quasiStaticSupported).toBe(true);
      expect(positive.credibility).toBe('inside-production-limiter');
      expect(positive.displacedVolumeM3).toBeGreaterThan(0);
      expect(positive.restoringMomentNm).toBeLessThan(0);
      expect(negative.restoringMomentNm).toBeGreaterThan(0);
      expect(positive.rightingLeverM).toBeCloseTo(-negative.rightingLeverM!, 8);
    }

    const beyondRuntime = probeSchoonerRollHydrostatics(50 * Math.PI / 180);
    expect(beyondRuntime.quasiStaticSupported).toBe(true);
    expect(beyondRuntime.credibility).toBe('diagnostic-geometry-only');
    expect(beyondRuntime.boundaryReason).toContain('0.7-rad limiter');
    expect(probeSchoonerRollHydrostatics(80 * Math.PI / 180).credibility).toBe(
      'diagnostic-geometry-only',
    );

    for (const degrees of [90, 100, 180]) {
      const result = probeSchoonerRollHydrostatics(degrees * Math.PI / 180);
      expect(result.quasiStaticSupported).toBe(false);
      expect(result.credibility).toBe('unsupported');
      expect(result.restoringMomentNm).toBeNull();
      expect(result.boundaryReason).toContain('opposite clipping half-plane');
    }
  });
});
