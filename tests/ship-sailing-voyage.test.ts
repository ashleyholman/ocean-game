import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PHYSICS_STEP } from '../src/vessel/BuoyantBody';
import {
  DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
} from '../src/world/clock';
import { GeographicLibGeodesic } from '../src/world/geodesic';
import { trueWindAngleDeg } from '../src/world/WorldWind';
import { EVIDENCE_GEODESIC } from '../src/vessel/schooner/SchoonerHorizontalDynamicsEvidence';
import {
  ACTUATION_RATES,
  CREW_EVOLUTION_WORLD_SECONDS,
  SailingControls,
  setStateEvolutionSeconds,
} from '../src/vessel/schooner/SailingControls';
import {
  buildCanvasSweepEvidence,
  buildCompressionInvarianceEvidence,
  validateSailingVoyageEvidence,
  type SailingVoyageEvidence,
} from '../src/vessel/schooner/SailingVoyageEvidence';
import {
  CANVAS_HYSTERESIS_MPS,
  CANVAS_PLANS,
  CANVAS_SAILS,
  canvasAmount,
  canvasPlanAmount,
  canvasPlanIndexForWind,
  canvasPlansAreMonotonic,
  nextCanvasPlanIndex,
  RESET_STRUCK_SAIL_WIND_ANGLE_DEG,
  STRIKE_WHEN_CANNOT_DRAW,
} from '../src/vessel/schooner/crew/CanvasPolicy';
import {
  CrewOrderBook,
  StationOrderPipeline,
  type CrewOrder,
} from '../src/vessel/schooner/crew/CrewOrders';
import type { HelmObservation } from '../src/vessel/schooner/crew/CrewObservations';
import { Helmsman } from '../src/vessel/schooner/crew/Helmsman';
import { DEFAULT_SAILING_CREW_SEED } from '../src/vessel/schooner/crew/HumanOperator';
import {
  BEAT_ANGLE_DEG,
  Navigator,
  type NavigatorDeck,
} from '../src/vessel/schooner/crew/Navigator';
import type { SailName } from '../src/vessel/schooner/rig';
import type { CanvasState } from '../src/vessel/schooner/sailAero';

const DEG_TO_RAD = Math.PI / 180;

const evidence: SailingVoyageEvidence = JSON.parse(
  readFileSync('evidence/ship-sailing/voyage-baseline.json', 'utf8'),
);

function helmObservation(
  overrides: {
    windSide?: 'port' | 'starboard' | 'unclear';
    cloth?: 'drawing' | 'trembling' | 'luffing';
    tillerWeight?: 'light' | 'working' | 'heavy';
  } = {},
): HelmObservation {
  return {
    elapsedSeconds: 0,
    focus: 'looking-ahead',
    compass: {
      readingDeg: 215,
      ageSeconds: 0.4,
      confidence: 'focused',
      trend: 'steady',
    },
    shipHead: { swing: 'steady', strength: 'none' },
    windAndSails: {
      side: overrides.windSide ?? 'starboard',
      strength: 'working',
      cloth: overrides.cloth ?? 'drawing',
      angleOffBowDeg: 55,
      angleAgeSeconds: 0.5,
    },
    bodyMotion: { swing: 'steady', heelWeight: 'noticeable-port' },
    tillerLoad: {
      signedHandForceN: 10,
      direction: 'port-helm',
      weight: overrides.tillerWeight ?? 'working',
      trend: 'steady',
    },
  };
}

/** Drive a helmsman for a while against one unchanging observation. */
function runHelm(
  helmsman: Helmsman,
  seconds: number,
  observation: HelmObservation,
): void {
  const steps = Math.round(seconds / PHYSICS_STEP);
  for (let i = 0; i < steps; i++) {
    helmsman.advanceSubstep(PHYSICS_STEP, observation);
  }
}

describe('S6 canvas policy — the table that can actually depower her', () => {
  it('never sets a sail while shortening, and always carries less cloth', () => {
    expect(canvasPlansAreMonotonic()).toBe(true);
    for (let i = 1; i < CANVAS_PLANS.length; i++) {
      const previous = CANVAS_PLANS[i - 1].canvas;
      const current = CANVAS_PLANS[i].canvas;
      for (const sail of CANVAS_SAILS) {
        expect(canvasAmount(current[sail])).toBeLessThanOrEqual(
          canvasAmount(previous[sail]),
        );
      }
      expect(canvasPlanAmount(current)).toBeLessThan(
        canvasPlanAmount(previous),
      );
    }
  });

  it('walks a rising wind monotonically down the table', () => {
    let index = 0;
    let lastAmount = Infinity;
    for (let windSpeedMps = 1; windSpeedMps <= 24; windSpeedMps += 0.5) {
      const next = nextCanvasPlanIndex(index, windSpeedMps);
      expect(next).toBeGreaterThanOrEqual(index);
      expect(next - index).toBeLessThanOrEqual(1);
      index = next;
      const amount = canvasPlanAmount(CANVAS_PLANS[index].canvas);
      expect(amount).toBeLessThanOrEqual(lastAmount);
      lastAmount = amount;
    }
    expect(index).toBe(CANVAS_PLANS.length - 1);
  });

  it('is quick to shorten and slow to shake out', () => {
    // Sitting just inside a band's own ceiling: no change either way.
    const index = 2;
    const ceiling = CANVAS_PLANS[index].uptoWindMps;
    const floor = CANVAS_PLANS[index - 1].uptoWindMps;
    expect(nextCanvasPlanIndex(index, ceiling - 0.01)).toBe(index);
    expect(nextCanvasPlanIndex(index, ceiling)).toBe(index + 1);
    // Falling back to the floor is not enough; it has to fall clear of it.
    expect(nextCanvasPlanIndex(index, floor)).toBe(index);
    expect(nextCanvasPlanIndex(index, floor - CANVAS_HYSTERESIS_MPS * 0.5)).toBe(
      index,
    );
    expect(nextCanvasPlanIndex(index, floor - CANVAS_HYSTERESIS_MPS)).toBe(
      index - 1,
    );
  });

  it('agrees with the plain band lookup at the band centres', () => {
    expect(canvasPlanIndexForWind(3)).toBe(0);
    expect(canvasPlanIndexForWind(6.5)).toBe(1);
    expect(canvasPlanIndexForWind(9)).toBe(2);
    expect(canvasPlanIndexForWind(12)).toBe(3);
    expect(canvasPlanIndexForWind(15)).toBe(4);
    expect(canvasPlanIndexForWind(22)).toBe(5);
  });

  it('hands only the square topsail when it cannot be made to draw', () => {
    // A fore-and-aft sail that will not draw is a trim or a course problem,
    // and striking it would be the wrong answer to it.
    expect([...STRIKE_WHEN_CANNOT_DRAW]).toEqual(['foreTopsail']);
  });
});

describe('S6 geodesy — the chart and the ship measure the same earth', () => {
  it('inverts what it propagates, on both figures of the earth', () => {
    const cases: Array<[number, number, number, number]> = [
      [-35, 138, 45, 4000],
      [-35, 138, 270, 24_000],
      [51.5, -0.1, 190, 120_000],
    ];
    for (const geodesic of [EVIDENCE_GEODESIC, new GeographicLibGeodesic()]) {
      for (const [latDeg, lonDeg, bearingDeg, distanceM] of cases) {
        const direct = {
          latitude2Rad: 0,
          longitude2Rad: 0,
          forwardAzimuth2Rad: 0,
        };
        geodesic.direct(
          latDeg * DEG_TO_RAD,
          lonDeg * DEG_TO_RAD,
          bearingDeg * DEG_TO_RAD,
          distanceM,
          direct,
        );
        const inverse = { distanceM: 0, forwardAzimuth1Rad: 0 };
        geodesic.inverse(
          latDeg * DEG_TO_RAD,
          lonDeg * DEG_TO_RAD,
          direct.latitude2Rad,
          direct.longitude2Rad,
          inverse,
        );
        expect(inverse.distanceM).toBeCloseTo(distanceM, 3);
        expect((inverse.forwardAzimuth1Rad * 180) / Math.PI).toBeCloseTo(
          bearingDeg > 180 ? bearingDeg - 360 : bearingDeg,
          6,
        );
      }
    }
  });

  it('lays the two close-hauled boards on the sides their names claim', () => {
    // The navigator computes windFrom ± the beat angle. Which of those is the
    // port tack is a sign, and signs in this project are set by test: the
    // world layer's own convention says a positive true-wind angle is a wind
    // over the port side.
    // Note the two conventions in play, which is the whole reason this is a
    // test and not a comment: the navigator works in the bearing the wind
    // blows *from*, and `trueWindAngleDeg` takes the bearing it blows *toward*.
    const windFromDeg = 270;
    const windTowardDeg = windFromDeg - 180;
    const portTackCourse = windFromDeg + BEAT_ANGLE_DEG;
    const starboardTackCourse = windFromDeg - BEAT_ANGLE_DEG;
    expect(trueWindAngleDeg(portTackCourse, windTowardDeg)).toBeCloseTo(
      BEAT_ANGLE_DEG,
      9,
    );
    expect(trueWindAngleDeg(starboardTackCourse, windTowardDeg)).toBeCloseTo(
      -BEAT_ANGLE_DEG,
      9,
    );
  });
});

describe('S6 evolutions — the helm half of a tack', () => {
  it('puts the helm toward the wind for a tack and away for a gybe', () => {
    // The magnitude and sign come from S4's measured tack, where the wind lay
    // on the starboard bow and 25° of negative rudder carried her through the
    // eye. Reasoning about it is exactly what this project forbids.
    for (const [side, expectedSign] of [
      ['starboard', -1],
      ['port', 1],
    ] as const) {
      const controls = new SailingControls();
      const helmsman = new Helmsman(controls, DEFAULT_SAILING_CREW_SEED);
      const orders = new CrewOrderBook(DEFAULT_SAILING_CREW_SEED);
      const observation = helmObservation({ windSide: side });
      // He has to have felt the wind before he can be asked to tack in it.
      runHelm(helmsman, 2, observation);
      helmsman.receiveOrder(
        orders.issue('tack', ['helm'], helmsman.elapsedSeconds, { courseDeg: 320 }, false),
      );
      runHelm(helmsman, 6, observation);
      const maneuver = helmsman.readout().maneuver;
      expect(maneuver).not.toBeNull();
      expect(maneuver!.kind).toBe('tack');
      expect(maneuver!.entrySide).toBe(side);
      expect(Math.sign(controls.rudderTargetDeg)).toBe(expectedSign);
      expect(Math.abs(controls.rudderTargetDeg)).toBeGreaterThanOrEqual(20);
    }

    const controls = new SailingControls();
    const helmsman = new Helmsman(controls, DEFAULT_SAILING_CREW_SEED);
    const orders = new CrewOrderBook(DEFAULT_SAILING_CREW_SEED);
    const observation = helmObservation({ windSide: 'starboard' });
    runHelm(helmsman, 2, observation);
    helmsman.receiveOrder(
      orders.issue('gybe', ['helm'], helmsman.elapsedSeconds, { courseDeg: 40 }, false),
    );
    runHelm(helmsman, 6, observation);
    expect(helmsman.readout().maneuver!.kind).toBe('gybe');
    expect(Math.sign(controls.rudderTargetDeg)).toBe(1);
  });

  it('calls her round when the wind is on the other cheek and the cloth fills', () => {
    const controls = new SailingControls();
    const helmsman = new Helmsman(controls, DEFAULT_SAILING_CREW_SEED);
    const orders = new CrewOrderBook(DEFAULT_SAILING_CREW_SEED);
    const before = helmObservation({ windSide: 'starboard', cloth: 'luffing' });
    runHelm(helmsman, 2, before);
    helmsman.receiveOrder(
      orders.issue('tack', ['helm'], helmsman.elapsedSeconds, { courseDeg: 320 }, false),
    );
    runHelm(helmsman, 6, before);
    expect(helmsman.readout().maneuver!.phase).toBe('helm-over');
    // The wind comes onto the other bow, but the cloth is still slatting: he
    // holds the helm on rather than calling it done.
    const crossing = helmObservation({ windSide: 'port', cloth: 'luffing' });
    runHelm(helmsman, 4, crossing);
    expect(helmsman.readout().maneuver!.phase).toBe('through');
    expect(Math.abs(controls.rudderTargetDeg)).toBeGreaterThanOrEqual(20);
    // Now she fills.
    runHelm(helmsman, 5, helmObservation({ windSide: 'port', cloth: 'drawing' }));
    const readout = helmsman.readout();
    expect(readout.maneuver!.phase).toBe('complete');
    expect(readout.orderedCourseDeg).toBe(320);
  });

  it('shifts the helm when she hangs in stays, and gives it up in the end', () => {
    const controls = new SailingControls();
    const helmsman = new Helmsman(controls, DEFAULT_SAILING_CREW_SEED);
    const orders = new CrewOrderBook(DEFAULT_SAILING_CREW_SEED);
    // Head to wind, tiller dead in his hand, sails slatting: in irons.
    const stuck = helmObservation({
      windSide: 'starboard',
      cloth: 'luffing',
      tillerWeight: 'light',
    });
    runHelm(helmsman, 2, stuck);
    helmsman.receiveOrder(
      orders.issue('tack', ['helm'], helmsman.elapsedSeconds, { courseDeg: 320 }, false),
    );
    runHelm(helmsman, 6, stuck);
    const helmOverDeg = controls.rudderTargetDeg;
    expect(helmsman.readout().maneuver!.phase).toBe('helm-over');
    runHelm(helmsman, 26, stuck);
    const inIrons = helmsman.readout().maneuver!;
    expect(inIrons.phase).toBe('in-irons');
    expect(inIrons.shiftedHelm).toBe(true);
    // Astern the blade answers the other way round, so the helm reverses.
    expect(Math.sign(controls.rudderTargetDeg)).toBe(-Math.sign(helmOverDeg));
    runHelm(helmsman, 100, stuck);
    expect(helmsman.readout().maneuver!.phase).toBe('failed');
    expect(controls.rudderTargetDeg).toBe(0);
  });
});

describe('S6 order pipeline — FINDING S6-1, the order nobody heard', () => {
  it('delivers an order that arrives while the hand is mid-action', () => {
    const pipeline = new StationOrderPipeline('helm', 7);
    const orders = new CrewOrderBook(7);
    const order = orders.issue('tack', ['helm'], 0, { courseDeg: 90 }, false);
    pipeline.receive(order);
    // Walk to the moment he has understood it but not yet begun, then let him
    // finish an action he started under the *previous* order. That used to
    // steal the phase and the order was then never delivered at all.
    for (let time = 0; time <= 12; time += PHYSICS_STEP) {
      pipeline.advance(time);
      pipeline.markWatching(time);
    }
    expect(pipeline.consumeReadyOrder()).toBe(order);
  });
});

describe('S6 navigator — what he knows and what he does about it', () => {
  class RecordingDeck implements NavigatorDeck {
    readonly courses: number[] = [];
    readonly canvases: Array<{ planName: string; canvas: CanvasState }> = [];
    readonly evolutions: Array<{ kind: string; courseDeg: number }> = [];
    reports: SailName[] = [];
    private nextId = 1;

    private order(kind: string): CrewOrder {
      return {
        sequenceId: this.nextId++,
        kind: kind as CrewOrder['kind'],
        targetStations: ['helm'],
        issueTimeSeconds: 0,
        utteranceDurationSeconds: 1,
        standing: false,
        payload: {},
        cancelled: false,
      };
    }

    orderCompassCourse(courseDeg: number): CrewOrder {
      this.courses.push(courseDeg);
      return this.order('steer-compass-course');
    }

    orderTack(newCourseDeg: number): CrewOrder {
      this.evolutions.push({ kind: 'tack', courseDeg: newCourseDeg });
      return this.order('tack');
    }

    orderGybe(newCourseDeg: number): CrewOrder {
      this.evolutions.push({ kind: 'gybe', courseDeg: newCourseDeg });
      return this.order('gybe');
    }

    orderCanvas(planName: string, canvas: CanvasState): CrewOrder {
      this.canvases.push({ planName, canvas });
      return this.order('set-canvas');
    }

    maneuver() {
      return null;
    }

    cannotDrawReports(): readonly SailName[] {
      return this.reports;
    }
  }

  function observation(overrides: {
    windFromBearingDeg?: number | null;
    windSpeedMps?: number | null;
    compassHeadingDeg?: number;
    speedThroughWaterMps?: number;
    latitudeDeg?: number;
    longitudeDeg?: number;
    elapsedSeconds?: number;
  }) {
    return {
      elapsedSeconds: overrides.elapsedSeconds ?? 0,
      fixLatitudeRad: (overrides.latitudeDeg ?? -33.9) * DEG_TO_RAD,
      fixLongitudeRad: (overrides.longitudeDeg ?? 151.9) * DEG_TO_RAD,
      fixAgeSeconds: 1,
      windFromBearingDeg:
        overrides.windFromBearingDeg === undefined
          ? 270
          : overrides.windFromBearingDeg,
      windSpeedMps:
        overrides.windSpeedMps === undefined ? 9 : overrides.windSpeedMps,
      speedThroughWaterMps: overrides.speedThroughWaterMps ?? 3.2,
      compassHeadingDeg: overrides.compassHeadingDeg ?? 215,
    };
  }

  function drive(
    navigator: Navigator,
    deck: RecordingDeck,
    seconds: number,
    build: (elapsed: number) => ReturnType<typeof observation>,
  ): void {
    const steps = Math.round(seconds / PHYSICS_STEP);
    for (let i = 0; i < steps; i++) {
      navigator.advanceSubstep(PHYSICS_STEP, build((i + 1) * PHYSICS_STEP));
    }
    void deck;
  }

  it('lays the mark when she can sail it, and boards to windward when she cannot', () => {
    const deck = new RecordingDeck();
    const navigator = new Navigator(deck, EVIDENCE_GEODESIC, 11);
    // A mark to the south-west with the wind from the west: she can sail it.
    const direct = { latitude2Rad: 0, longitude2Rad: 0, forwardAzimuth2Rad: 0 };
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      180 * DEG_TO_RAD,
      6000,
      direct,
    );
    navigator.sailTo(
      (direct.latitude2Rad * 180) / Math.PI,
      (direct.longitude2Rad * 180) / Math.PI,
    );
    drive(navigator, deck, 3, () => observation({ compassHeadingDeg: 200 }));
    expect(navigator.phase).toBe('making-course');
    expect(deck.courses[0]).toBeCloseTo(180, 0);

    // And a mark dead into it: she cannot, so he lays a close-hauled board.
    const upwindDeck = new RecordingDeck();
    const upwind = new Navigator(upwindDeck, EVIDENCE_GEODESIC, 11);
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      270 * DEG_TO_RAD,
      6000,
      direct,
    );
    upwind.sailTo(
      (direct.latitude2Rad * 180) / Math.PI,
      (direct.longitude2Rad * 180) / Math.PI,
    );
    drive(upwind, upwindDeck, 3, () => observation({ compassHeadingDeg: 215 }));
    expect(upwind.phase).toBe('beating');
    // She was already on the starboard board; he keeps her on it.
    expect(upwindDeck.courses[0]).toBeCloseTo(270 - BEAT_ANGLE_DEG, 6);
    expect(upwindDeck.evolutions).toHaveLength(0);
  });

  it('will not order a tack she has not the way for', () => {
    const deck = new RecordingDeck();
    const navigator = new Navigator(deck, EVIDENCE_GEODESIC, 11);
    const direct = { latitude2Rad: 0, longitude2Rad: 0, forwardAzimuth2Rad: 0 };
    // The mark is broad on the other bow, so laying it means crossing the wind.
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      330 * DEG_TO_RAD,
      6000,
      direct,
    );
    navigator.sailTo(
      (direct.latitude2Rad * 180) / Math.PI,
      (direct.longitude2Rad * 180) / Math.PI,
    );
    drive(navigator, deck, 3, () =>
      observation({ compassHeadingDeg: 215, speedThroughWaterMps: 0.4 }),
    );
    expect(deck.evolutions).toHaveLength(0);
    expect(navigator.readout().deferredTackCount).toBeGreaterThanOrEqual(1);
    // But she is given a course to hold while she gathers way.
    expect(deck.courses).toHaveLength(1);
  });

  it('hands a sail that will not draw, and keeps it handed until she bears away', () => {
    const deck = new RecordingDeck();
    const navigator = new Navigator(deck, EVIDENCE_GEODESIC, 11);
    const direct = { latitude2Rad: 0, longitude2Rad: 0, forwardAzimuth2Rad: 0 };
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      270 * DEG_TO_RAD,
      20_000,
      direct,
    );
    const destinationLatitudeDeg = (direct.latitude2Rad * 180) / Math.PI;
    const destinationLongitudeDeg = (direct.longitude2Rad * 180) / Math.PI;
    navigator.sailTo(destinationLatitudeDeg, destinationLongitudeDeg);
    drive(navigator, deck, 3, () => observation({ compassHeadingDeg: 215 }));
    expect(navigator.intendedCanvas().foreTopsail).toBe('set');

    deck.reports = ['foreTopsail'];
    drive(navigator, deck, 40, () => observation({ compassHeadingDeg: 215 }));
    expect(navigator.readout().struckForCannotDraw).toEqual(['foreTopsail']);
    expect(navigator.intendedCanvas().foreTopsail).toBe('furled');
    const struckPlan = deck.canvases[deck.canvases.length - 1];
    expect(struckPlan.canvas.foreTopsail).toBe('furled');

    // Still close-hauled: the report clearing does not send anyone aloft.
    deck.reports = [];
    drive(navigator, deck, 40, () => observation({ compassHeadingDeg: 215 }));
    expect(navigator.intendedCanvas().foreTopsail).toBe('furled');

    // Off the wind past the reset angle, and she may carry it again. The mark
    // now lies where the direct course is a broad reach.
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      (270 + RESET_STRUCK_SAIL_WIND_ANGLE_DEG + 40) * DEG_TO_RAD,
      20_000,
      direct,
    );
    navigator.sailTo(
      (direct.latitude2Rad * 180) / Math.PI,
      (direct.longitude2Rad * 180) / Math.PI,
    );
    drive(navigator, deck, 60, () => observation({ compassHeadingDeg: 50 }));
    expect(navigator.readout().struckForCannotDraw).toEqual([]);
    expect(navigator.intendedCanvas().foreTopsail).toBe('set');
  });

  it('shortens sail on a wind that holds, not on one gust', () => {
    const deck = new RecordingDeck();
    const navigator = new Navigator(deck, EVIDENCE_GEODESIC, 11);
    const direct = { latitude2Rad: 0, longitude2Rad: 0, forwardAzimuth2Rad: 0 };
    EVIDENCE_GEODESIC.direct(
      -33.9 * DEG_TO_RAD,
      151.9 * DEG_TO_RAD,
      180 * DEG_TO_RAD,
      40_000,
      direct,
    );
    navigator.sailTo(
      (direct.latitude2Rad * 180) / Math.PI,
      (direct.longitude2Rad * 180) / Math.PI,
    );
    // Light air, then one hard puff that dies again.
    drive(navigator, deck, 20, () =>
      observation({ windSpeedMps: 4, compassHeadingDeg: 180 }),
    );
    expect(navigator.readout().canvasPlanIndex).toBe(0);
    drive(navigator, deck, 15, () =>
      observation({ windSpeedMps: 12, compassHeadingDeg: 180 }),
    );
    expect(navigator.readout().canvasPlanIndex).toBe(0);
    // Now it settles in and stays.
    drive(navigator, deck, 120, () =>
      observation({ windSpeedMps: 12, compassHeadingDeg: 180 }),
    );
    expect(navigator.readout().canvasPlanIndex).toBeGreaterThanOrEqual(2);
  });

  it('does nothing at all until he knows where the wind is', () => {
    const deck = new RecordingDeck();
    const navigator = new Navigator(deck, EVIDENCE_GEODESIC, 11);
    navigator.sailTo(-35.05, 137.9);
    drive(navigator, deck, 30, () =>
      observation({ windFromBearingDeg: null, windSpeedMps: null }),
    );
    expect(deck.courses).toHaveLength(0);
    expect(deck.canvases).toHaveLength(0);
  });
});

describe('S6 the voyage clock — control on ordinary seconds', () => {
  it('prices a sail evolution against the crew day, never the voyage clock', () => {
    // `SailingControls` is where every actuation rate lives, and it has no
    // reference to voyage compression at all — that is the invariant, stated
    // structurally rather than measured.
    const source = readFileSync(
      'src/vessel/schooner/SailingControls.ts',
      'utf8',
    );
    expect(source).not.toMatch(/voyageSecondsPerRealSecond/);
    expect(source).not.toMatch(/DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND/);
    expect(source).toMatch(/DEFAULT_WORLD_SECONDS_PER_REAL_SECOND/);

    expect(ACTUATION_RATES.gaffHoistSeconds).toBeCloseTo(
      CREW_EVOLUTION_WORLD_SECONDS.gaffHoist /
        DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
      12,
    );
    expect(setStateEvolutionSeconds('mainsail', 'set', 'reef1')).toBeCloseTo(
      CREW_EVOLUTION_WORLD_SECONDS.reef / DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
      12,
    );

    // And the walk itself takes that long on the fixed grid, whatever the
    // world is doing around it.
    const controls = new SailingControls();
    controls.commandSetState('foreStaysail', 'furled');
    let seconds = 0;
    while (controls.hoistFraction('foreStaysail') > 0 && seconds < 60) {
      controls.advanceSubstep(PHYSICS_STEP);
      seconds += PHYSICS_STEP;
    }
    expect(seconds).toBeCloseTo(ACTUATION_RATES.headsailSetSeconds, 1);
  });

  it('is asserted in the committed evidence at 1x and 30x', () => {
    const { compression } = evidence;
    expect(compression.runs.map((run) => run.voyageSecondsPerRealSecond)).toEqual(
      [1, 30],
    );
    expect(compression.identicalControlTrace).toBe(true);
    expect(compression.encounterDistanceIdentical).toBe(true);
    expect(compression.groundRatio).toBeCloseTo(30, 6);
    expect(compression.runs[0].canvasEvolutionSeconds.length).toBeGreaterThan(0);
    expect(compression.runs[0].canvasEvolutionSeconds).toEqual(
      compression.runs[1].canvasEvolutionSeconds,
    );
  });

  it('navigates at thirty times as well as at one', () => {
    const compressed = evidence.voyages.upwindCompressed;
    expect(compressed.voyageSecondsPerRealSecond).toBe(30);
    expect(compressed.arrivedAtSeconds).not.toBeNull();
    expect(compressed.tackCount).toBeGreaterThanOrEqual(1);
  });
});

describe('S6 committed voyage evidence', () => {
  it('passes every gate it was built with', () => {
    expect(() => validateSailingVoyageEvidence(evidence)).not.toThrow();
  });

  it('fetched a mark dead to windward, on boards, in wind chop', () => {
    const upwind = evidence.voyages.upwind;
    expect(upwind.arrivedAtSeconds).not.toBeNull();
    expect(upwind.finalDistanceToGoM).toBeLessThanOrEqual(upwind.arrivalRadiusM);
    expect(upwind.distanceMadeGoodM).toBeGreaterThan(
      upwind.destinationDistanceM - upwind.arrivalRadiusM,
    );
    expect(upwind.tackCount).toBeGreaterThanOrEqual(1);
    expect(upwind.tackCount).toBeLessThanOrEqual(14);
    expect(upwind.completedManeuverCount).toBeGreaterThanOrEqual(1);
    // A beat cannot sail the straight line, and a ship that "beat" at 0.95 of
    // it did not beat at all.
    expect(upwind.trackEfficiency).toBeGreaterThan(0.3);
    expect(upwind.trackEfficiency).toBeLessThan(0.85);
  });

  it('brought her stern through the wind, not her bow, going downwind', () => {
    const downwind = evidence.voyages.downwind;
    expect(downwind.gybeCount).toBeGreaterThanOrEqual(1);
    expect(downwind.tackCount).toBe(0);
    expect(
      downwind.events.some((event) => event.kind === 'gybe'),
    ).toBe(true);
  });

  it('acted on the square topsail that would not draw', () => {
    const upwind = evidence.voyages.upwind;
    expect(upwind.foreTopsailCannotDrawAtSeconds).not.toBeNull();
    expect(upwind.foreTopsailStruckAtSeconds).not.toBeNull();
    expect(upwind.foreTopsailStruckAtSeconds!).toBeGreaterThanOrEqual(
      upwind.foreTopsailCannotDrawAtSeconds!,
    );
    // And the report was answered promptly — this is the whole of FINDING
    // S5-3's fix, so a slow answer is as good as none.
    expect(evidence.gates.cannotDrawResponseSeconds!).toBeLessThan(30);
    expect(upwind.finalCanvas.foreTopsail).toBe('furled');
  });

  it('shortened sail as the wind rose, and it bought real heel', () => {
    expect(evidence.canvasSweep.monotonicByPolicy).toBe(true);
    expect(evidence.canvasSweep.monotonicBySweep).toBe(true);
    const relief = evidence.heelRelief;
    expect(relief.easingOnlySettledRollDeg).toBeGreaterThan(
      relief.shortenedSettledRollDeg,
    );
    expect(relief.reliefDeg).toBeGreaterThanOrEqual(4);
    // The trimmers alone leave her past the 15–25° band S2 gated steady heel
    // into; that is FINDING S5-4, and it is the thing being fixed.
    expect(relief.easingOnlySettledRollDeg).toBeGreaterThan(25);
  });

  it('replays exactly, at every caller rate', () => {
    expect(evidence.determinism.identical).toBe(true);
    expect(evidence.determinism.callerRateInvariant).toBe(true);
    expect(evidence.determinism.repeatedControlSignature.length).toBeGreaterThan(
      10,
    );
  });
});

describe('S6 architecture — the navigator is a person, not a telemetry reader', () => {
  it('imports no vessel, aerodynamic or wind truth', () => {
    const source = readFileSync(
      'src/vessel/schooner/crew/Navigator.ts',
      'utf8',
    );
    expect(source).not.toMatch(/from ['"].*SchoonerResistance/);
    expect(source).not.toMatch(/from ['"].*WorldWind/);
    expect(source).not.toMatch(/from ['"].*PlanetaryWorld/);
    expect(source).not.toMatch(/from ['"].*VesselMotion/);
    expect(source).not.toMatch(/from ['"].*SailingControls/);
    // He may know the *shape* of a sail plan — that is chart-room vocabulary,
    // and a set state is what he writes in the log. He may not read a force,
    // an angle of attack or a luff flag, and he may not command a control.
    for (const line of source.match(/^import.*sailAero.*$/gm) ?? []) {
      expect(line.startsWith('import type ')).toBe(true);
    }
    expect(source).not.toMatch(
      /SailAeroResult|PerSailForce|evaluateSailAero|aoaDeg|luffing/,
    );
    expect(source).not.toMatch(/commandSetState|commandTrimDeg|commandRudderDeg/);
  });

  it('writes no control from the canvas policy either', () => {
    const source = readFileSync(
      'src/vessel/schooner/crew/CanvasPolicy.ts',
      'utf8',
    );
    expect(source).not.toMatch(/commandSetState|commandTrimDeg/);
  });
});

describe('S6 slow gates — rebuilt rather than read', () => {
  it(
    'rebuilds the canvas sweep and the voyage-clock case and they still hold',
    { tags: ['slow', 'sailing'], timeout: 600_000 },
    () => {
      const sweep = buildCanvasSweepEvidence();
      expect(sweep.monotonicByPolicy).toBe(true);
      expect(sweep.monotonicBySweep).toBe(true);
      expect(sweep.points).toEqual(evidence.canvasSweep.points);

      const compression = buildCompressionInvarianceEvidence(
        DEFAULT_SAILING_CREW_SEED,
      );
      expect(compression.identicalControlTrace).toBe(true);
      expect(compression.encounterDistanceIdentical).toBe(true);
      expect(compression.groundRatio).toBeCloseTo(30, 6);
      // And it is the same trace the committed evidence carries: the whole
      // point of a baseline is that rebuilding it changes nothing.
      expect(compression.runs[0].controlSignature).toBe(
        evidence.compression.runs[0].controlSignature,
      );
    },
  );
});
