import { describe, expect, it } from 'vitest';
import {
  BULWARK_THICKNESS,
  DESIGN_DRAUGHT,
  HALF_LENGTH,
} from '../src/vessel/schooner/hullForm';
import {
  deckHalfWidth,
  deckLevelAt,
  levelWalkingY,
} from '../src/vessel/schooner/deckSurface';
import {
  NO_SCHOONER_SCUPPER_DRAINAGE_REQUESTS,
  rectangularScupperOutflowM3PerSecond,
  resolveSchoonerScupperDrainage,
  spanningRectangularScupperOutflowM3PerSecond,
} from '../src/vessel/schooner/SchoonerScupperDrainage';
import {
  SCHOONER_SCUPPER_APERTURES,
  SCHOONER_SCUPPER_APERTURES_PER_OPENING,
  SCHOONER_SCUPPER_CLEAR_AREA_PER_SIDE_M2,
  SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
  SCHOONER_SCUPPER_MODERN_REFERENCE_AREA_PER_SIDE_M2,
  SCHOONER_SCUPPER_OPENINGS,
  SCHOONER_SCUPPER_OPENING_NAMES,
  SCHOONER_SCUPPER_SLOT_HEIGHT_M,
  SCHOONER_SCUPPER_SLOT_WIDTH_M,
} from '../src/vessel/schooner/SchoonerScupperGeometry';
import { ShipWaterState } from '../src/vessel/schooner/ShipWaterState';
import { SHIP_WATER_OPENINGS } from '../src/vessel/schooner/shipWaterOpenings';

const STEP = 1 / 240;

function seed(
  water: ShipWaterState,
  opening: 'railAftStarboard' | 'railAftPort' | 'railForeStarboard' | 'railForePort',
  volumeM3: number,
): void {
  water.advance(STEP, () => [
    { opening, rateM3PerSecond: volumeM3 / STEP },
  ]);
}

function flatFrame(rollRad = 0, pitchRad = 0) {
  return {
    originWorldYM: -DESIGN_DRAUGHT,
    rollRad,
    pitchRad,
    seaSurfaceWorldYM: () => 0,
  };
}

describe('SURV2 schooner scupper geometry', () => {
  it('authors sixteen deck-edge slots and closes the graph geometry', () => {
    expect(SCHOONER_SCUPPER_APERTURES).toHaveLength(16);
    expect(SCHOONER_SCUPPER_OPENING_NAMES).toHaveLength(4);
    for (const name of SCHOONER_SCUPPER_OPENING_NAMES) {
      const opening = SCHOONER_SCUPPER_OPENINGS[name];
      expect(opening.apertures).toHaveLength(
        SCHOONER_SCUPPER_APERTURES_PER_OPENING,
      );
      expect(SHIP_WATER_OPENINGS[name].clearAreaM2).toBe(
        opening.clearAreaM2,
      );
      expect(opening.effectiveAreaM2).toBeCloseTo(
        opening.clearAreaM2 * SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
        15,
      );
    }

    for (const aperture of SCHOONER_SCUPPER_APERTURES) {
      const level = deckLevelAt(aperture.zParam);
      const deckEdge = deckHalfWidth(aperture.zParam, level);
      expect(aperture.sill.y).toBe(levelWalkingY(aperture.zParam, level));
      expect(Math.abs(aperture.sill.x)).toBeGreaterThan(deckEdge);
      expect(Math.abs(aperture.sill.x)).toBeLessThan(
        deckEdge + BULWARK_THICKNESS,
      );
      expect(Math.abs(aperture.zParam)).toBeLessThan(HALF_LENGTH);
      expect(
        deckLevelAt(aperture.zParam - aperture.widthM / 2).name,
      ).toBe(level.name);
      expect(
        deckLevelAt(aperture.zParam + aperture.widthM / 2).name,
      ).toBe(level.name);
      expect(aperture.widthM).toBe(SCHOONER_SCUPPER_SLOT_WIDTH_M);
      expect(aperture.heightM).toBe(SCHOONER_SCUPPER_SLOT_HEIGHT_M);
      expect(aperture.clearAreaM2).toBe(
        SCHOONER_SCUPPER_SLOT_WIDTH_M * SCHOONER_SCUPPER_SLOT_HEIGHT_M,
      );
      expect(Math.sign(aperture.sill.x)).toBe(
        aperture.side === 'port' ? 1 : -1,
      );
    }
  });

  it('lands within 0.2% of the named modern exposed-water sizing reference', () => {
    expect(SCHOONER_SCUPPER_CLEAR_AREA_PER_SIDE_M2).toBeCloseTo(0.4368, 12);
    const portArea = SCHOONER_SCUPPER_APERTURES.filter(
      (aperture) => aperture.side === 'port',
    ).reduce((sum, aperture) => sum + aperture.clearAreaM2, 0);
    expect(portArea).toBe(SCHOONER_SCUPPER_CLEAR_AREA_PER_SIDE_M2);
    expect(
      Math.abs(
        SCHOONER_SCUPPER_CLEAR_AREA_PER_SIDE_M2 -
          SCHOONER_SCUPPER_MODERN_REFERENCE_AREA_PER_SIDE_M2,
      ) / SCHOONER_SCUPPER_MODERN_REFERENCE_AREA_PER_SIDE_M2,
    ).toBeLessThan(0.002);
  });
});

describe('SURV2 rectangular scupper hydraulics', () => {
  it('integrates a partially wet free-outfall slot analytically', () => {
    const depthM = 0.08;
    const widthM = 0.42;
    const cd = 0.61;
    const expected =
      cd *
      widthM *
      (2 / 3) *
      Math.sqrt(2 * 9.81) *
      depthM ** 1.5;
    expect(
      rectangularScupperOutflowM3PerSecond({
        widthM,
        heightM: 0.13,
        dischargeCoefficient: cd,
        upProjection: 1,
        sillWorldYM: 2,
        insideSurfaceWorldYM: 2 + depthM,
        outsideSurfaceWorldYM: 0,
      }),
    ).toBeCloseTo(expected, 15);
  });

  it('uses only positive inside-to-outside head for a submerged slot', () => {
    const common = {
      widthM: 0.42,
      heightM: 0.13,
      dischargeCoefficient: 0.61,
      upProjection: 1,
      sillWorldYM: 1,
      insideSurfaceWorldYM: 1.5,
    };
    const free = rectangularScupperOutflowM3PerSecond({
      ...common,
      outsideSurfaceWorldYM: 0,
    });
    const submerged = rectangularScupperOutflowM3PerSecond({
      ...common,
      outsideSurfaceWorldYM: 1.4,
    });
    expect(submerged).toBeGreaterThan(0);
    expect(submerged).toBeLessThan(free);
    const mixed = rectangularScupperOutflowM3PerSecond({
      ...common,
      insideSurfaceWorldYM: 1.2,
      outsideSurfaceWorldYM: 1.06,
    });
    expect(mixed).toBeGreaterThan(0);
    expect(mixed).toBeLessThan(
      rectangularScupperOutflowM3PerSecond({
        ...common,
        insideSurfaceWorldYM: 1.2,
        outsideSurfaceWorldYM: 0,
      }),
    );
    expect(
      rectangularScupperOutflowM3PerSecond({
        ...common,
        insideSurfaceWorldYM: 1.7,
        outsideSurfaceWorldYM: 1.6,
      }),
    ).toBeCloseTo(
      common.dischargeCoefficient *
        common.widthM *
        common.heightM *
        Math.sqrt(2 * 9.81 * 0.1),
      15,
    );
    expect(
      rectangularScupperOutflowM3PerSecond({
        ...common,
        outsideSurfaceWorldYM: 1.5,
      }),
    ).toBe(0);
    expect(
      rectangularScupperOutflowM3PerSecond({
        ...common,
        outsideSurfaceWorldYM: 2,
      }),
    ).toBe(0);
  });

  it('integrates pitch across the full slot width rather than sampling its centre', () => {
    const widthM = 0.42;
    const heightM = 0.13;
    const insideSurfaceWorldYM = 1.08;
    const gradient = -Math.sin(0.7);
    const resolved = spanningRectangularScupperOutflowM3PerSecond({
      widthM,
      heightM,
      dischargeCoefficient: 0.61,
      upProjection: Math.cos(0.7),
      sillCentreWorldYM: 1,
      sillWorldYGradientPerM: gradient,
      insideSurfaceWorldYM,
      outsideSurfaceWorldYM: () => 0,
    });

    const strips = 20_000;
    let reference = 0;
    for (let i = 0; i < strips; i++) {
      const offsetM = -widthM / 2 + ((i + 0.5) * widthM) / strips;
      reference += rectangularScupperOutflowM3PerSecond({
        widthM: widthM / strips,
        heightM,
        dischargeCoefficient: 0.61,
        upProjection: Math.cos(0.7),
        sillWorldYM: 1 + gradient * offsetM,
        insideSurfaceWorldYM,
        outsideSurfaceWorldYM: 0,
      });
    }
    expect(Math.abs(resolved - reference) / reference).toBeLessThan(0.005);
  });

  it('resolves pitched wet slivers continuously at the physical slot end', () => {
    const widthM = 0.42;
    const pitchRad = 0.7;
    const upProjection = Math.cos(pitchRad);
    const gradient = -Math.sin(pitchRad);
    const lowSillWorldYM = 1 + gradient * (widthM / 2);
    const coefficient = 0.61;

    for (const headM of [0.0001, 0.0005, 0.001, 0.002, 0.004, 0.005]) {
      const resolved = spanningRectangularScupperOutflowM3PerSecond({
        widthM,
        heightM: 0.13,
        dischargeCoefficient: coefficient,
        upProjection,
        sillCentreWorldYM: 1,
        sillWorldYGradientPerM: gradient,
        insideSurfaceWorldYM: lowSillWorldYM + headM,
        outsideSurfaceWorldYM: () => 0,
      });
      // Across this tiny end interval the head is linear from `headM` to zero,
      // remains below the slot top, and is entirely free outfall. Integrating
      // the vertical 2/3*h^(3/2) result once more along the pitched span gives
      // this closed-form 2-D reference.
      const expected =
        coefficient *
        (2 / 3) *
        Math.sqrt(2 * 9.81) *
        (1 / upProjection) *
        (1 / Math.abs(gradient)) *
        (2 / 5) *
        headM ** 2.5;
      expect(resolved).toBeGreaterThan(0);
      expect(Math.abs(resolved - expected) / expected).toBeLessThan(1e-5);
    }
  });

  it('clips outside-wave head crossings before quadrature can miss an end sliver', () => {
    const widthM = 0.42;
    const outsideAt = (offsetM: number) => 1 + 0.1 * (0.205 - offsetM);
    const resolved = spanningRectangularScupperOutflowM3PerSecond({
      widthM,
      heightM: 0.13,
      dischargeCoefficient: 0.61,
      upProjection: 1,
      sillCentreWorldYM: 0,
      sillWorldYGradientPerM: 0,
      insideSurfaceWorldYM: 1,
      outsideSurfaceWorldYM: outsideAt,
    });

    const strips = 20_000;
    let reference = 0;
    for (let i = 0; i < strips; i++) {
      const offsetM = -widthM / 2 + ((i + 0.5) * widthM) / strips;
      reference += rectangularScupperOutflowM3PerSecond({
        widthM: widthM / strips,
        heightM: 0.13,
        dischargeCoefficient: 0.61,
        upProjection: 1,
        sillWorldYM: 0,
        insideSurfaceWorldYM: 1,
        outsideSurfaceWorldYM: outsideAt(offsetM),
      });
    }
    expect(resolved).toBeGreaterThan(0);
    expect(Math.abs(resolved - reference) / reference).toBeLessThan(0.005);
  });
});

describe('SURV2 four-cell scupper resolver', () => {
  it('returns the canonical dry result without sampling the sea', () => {
    const water = new ShipWaterState();
    let samples = 0;
    const first = resolveSchoonerScupperDrainage(water, {
      ...flatFrame(),
      seaSurfaceWorldYM: () => {
        samples++;
        return 0;
      },
    });
    expect(first).toBe(NO_SCHOONER_SCUPPER_DRAINAGE_REQUESTS);
    expect(resolveSchoonerScupperDrainage(water, flatFrame())).toBe(first);
    expect(samples).toBe(0);
  });

  it('converges to zero continuously at the dry limit', () => {
    const rateAt = (volumeM3: number): number => {
      const water = new ShipWaterState();
      seed(water, 'railForeStarboard', volumeM3);
      return (
        resolveSchoonerScupperDrainage(water, flatFrame()).find(
          (request) => request.opening === 'scupperForeStarboard',
        )?.rateM3PerSecond ?? 0
      );
    };
    const epsilonRate = rateAt(1e-12);
    expect(epsilonRate).toBeLessThanOrEqual(240e-12);
    expect(rateAt(1e-9)).toBeGreaterThanOrEqual(epsilonRate);
    expect(rateAt(1e-6)).toBeGreaterThanOrEqual(rateAt(1e-9));
  });

  it('uses pitched aperture endpoints so the volume cap is only a safety ceiling', () => {
    const fractionOfAvailability = (
      opening: 'railForeStarboard' | 'railForePort',
      request: 'scupperForeStarboard' | 'scupperForePort',
      volumeM3: number,
      rollRad: number,
    ): number => {
      const water = new ShipWaterState();
      seed(water, opening, volumeM3);
      const rateM3PerSecond =
        resolveSchoonerScupperDrainage(
          water,
          flatFrame(rollRad, 0.35),
        ).find((candidate) => candidate.opening === request)
          ?.rateM3PerSecond ?? 0;
      return rateM3PerSecond / (volumeM3 / STEP);
    };

    for (const [opening, request, rollRad] of [
      ['railForeStarboard', 'scupperForeStarboard', 0.7],
      ['railForePort', 'scupperForePort', -0.7],
    ] as const) {
      const atMicro = fractionOfAvailability(
        opening,
        request,
        1e-6,
        rollRad,
      );
      const atNano = fractionOfAvailability(
        opening,
        request,
        1e-9,
        rollRad,
      );
      const atPico = fractionOfAvailability(
        opening,
        request,
        1e-12,
        rollRad,
      );
      expect(atMicro).toBeLessThan(1);
      expect(atNano).toBeLessThanOrEqual(atMicro);
      expect(atPico).toBeLessThanOrEqual(atNano);
      expect(atPico).toBeLessThan(1e-6);
    }
  });

  it('drains equal upright cells equally and a positive heel favours starboard', () => {
    const water = new ShipWaterState();
    seed(water, 'railAftStarboard', 0.3);
    seed(water, 'railAftPort', 0.3);

    const upright = resolveSchoonerScupperDrainage(water, flatFrame());
    const uprightStarboard = upright.find(
      (request) => request.opening === 'scupperAftStarboard',
    )!;
    const uprightPort = upright.find(
      (request) => request.opening === 'scupperAftPort',
    )!;
    expect(uprightStarboard.rateM3PerSecond).toBeCloseTo(
      uprightPort.rateM3PerSecond,
      12,
    );

    const heeled = resolveSchoonerScupperDrainage(water, flatFrame(0.24));
    const heeledStarboard = heeled.find(
      (request) => request.opening === 'scupperAftStarboard',
    )!;
    const heeledPort = heeled.find(
      (request) => request.opening === 'scupperAftPort',
    );
    expect(heeledStarboard.rateM3PerSecond).toBeGreaterThan(
      heeledPort?.rateM3PerSecond ?? 0,
    );
  });

  it('is strict-equal at 30, 60, 120 and 240 Hz on the water clock', () => {
    const run = (callerHz: number) => {
      const water = new ShipWaterState();
      seed(water, 'railForeStarboard', 0.4);
      for (let frame = 0; frame < callerHz * 3; frame++) {
        water.advance(1 / callerHz, ({ water: state }) =>
          resolveSchoonerScupperDrainage(state, flatFrame()),
        );
      }
      return {
        stepIndex: water.stepIndex,
        volumeM3: water.volumeM3('weatherDeckForeStarboard'),
        ledger: water.ledger(),
      };
    };

    const at240 = run(240);
    for (const callerHz of [30, 60, 120]) {
      expect(run(callerHz)).toStrictEqual(at240);
    }
    expect(at240.volumeM3).toBeLessThan(0.4);
    expect(at240.ledger.externalDischargeM3).toBeGreaterThan(0);
    expect(Math.abs(at240.ledger.conservationResidualM3)).toBeLessThan(1e-12);
  });
});
