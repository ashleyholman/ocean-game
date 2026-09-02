import type { EllipsoidGeodesic } from '../../../world/geodesic';
import type { SailingControls } from '../SailingControls';
import type { SailName } from '../rig';
import type { CanvasState } from '../sailAero';
import { CanvasHands, type CanvasHandsReadout } from './CanvasHands';
import { CANVAS_SAILS } from './CanvasPolicy';
import { wrap360 } from './CompassInstrument';
import { CrewOrderBook, type CrewOrder, type CrewStationId } from './CrewOrders';
import type {
  HelmObservation,
  NavigatorObservation,
  SailTrimObservation,
} from './CrewObservations';
import { Helmsman, type HelmsmanReadout } from './Helmsman';
import { DEFAULT_SAILING_CREW_SEED } from './HumanOperator';
import {
  Navigator,
  type NavigatorDeck,
  type NavigatorReadout,
} from './Navigator';
import { Trimmers, TRIM_STATIONS, type TrimmersReadout } from './Trimmers';

/** Where each station's own view of its sail comes from. */
export type SailObservationSource = (
  sail: SailName,
) => Readonly<SailTrimObservation>;

export interface SailingCrewReadout {
  readonly elapsedSeconds: number;
  readonly helmsman: HelmsmanReadout;
  readonly trimmers: TrimmersReadout;
  readonly canvas: CanvasHandsReadout;
  readonly navigator: NavigatorReadout | null;
}

/**
 * S5's public captain/order API and operator orchestrator.
 *
 * This module imports observations, never vessel/aero truth. The composition
 * root connects it to `SailingCrewSensors` across the fixed-step observer seam.
 */
export class SailingCrew implements NavigatorDeck {
  readonly helmsman: Helmsman;
  readonly trimmers: Trimmers;
  readonly canvasHands: CanvasHands;
  private readonly orders: CrewOrderBook;
  private navigatorValue: Navigator | null = null;

  constructor(
    controls: SailingControls,
    readonly seed: number = DEFAULT_SAILING_CREW_SEED,
  ) {
    this.orders = new CrewOrderBook(seed);
    this.helmsman = new Helmsman(controls, seed);
    this.trimmers = new Trimmers(controls, seed);
    this.canvasHands = new CanvasHands(controls, seed);
  }

  get focus() {
    return this.helmsman.focus;
  }

  /**
   * The navigator, once one has been put on the chart.
   *
   * He is created on demand and not before: a crew with no destination has no
   * navigator, and — the reason that matters — a navigator who exists issues
   * spoken orders, and spoken orders draw from the captain's utterance stream.
   * Constructing one unconditionally would have moved every S5 trace by
   * shifting the draws underneath it.
   */
  get navigator(): Navigator | null {
    return this.navigatorValue;
  }

  /**
   * "Sail to that point on the chart."
   *
   * The captain's tier-2 order. The geodesic is the same solver the vessel is
   * propagated with, so the course he lays and the track she makes are
   * measured on one figure of the earth.
   */
  orderSailTo(
    geodesic: EllipsoidGeodesic,
    latitudeDeg: number,
    longitudeDeg: number,
    options: {
      readonly arrivalRadiusM?: number;
      /** The canvas plan she is already carrying, by index. */
      readonly initialCanvasIndex?: number;
    } = {},
  ): Navigator {
    if (this.navigatorValue === null) {
      this.navigatorValue = new Navigator(
        this,
        geodesic,
        this.seed,
        options.initialCanvasIndex ?? 0,
      );
    }
    this.navigatorValue.sailTo(
      latitudeDeg,
      longitudeDeg,
      options.arrivalRadiusM,
    );
    return this.navigatorValue;
  }

  // --- NavigatorDeck: what the navigator may say, and what he is told --------

  orderTack(newCourseDeg: number): CrewOrder {
    return this.orderEvolution('tack', newCourseDeg);
  }

  orderGybe(newCourseDeg: number): CrewOrder {
    return this.orderEvolution('gybe', newCourseDeg);
  }

  /**
   * "Shorten sail" / "make sail" — one spoken order, every station's own job.
   *
   * It goes to the helm as well as the sail stations only in the sense that
   * the helm ignores it; each sail's hand reads his own line out of the plan.
   */
  orderCanvas(planName: string, canvas: CanvasState): CrewOrder {
    const plan: Partial<Record<CrewStationId, string>> = {};
    for (const sail of CANVAS_SAILS) plan[sail as CrewStationId] = canvas[sail];
    const order = this.orders.issue(
      'set-canvas',
      CANVAS_SAILS as readonly CrewStationId[],
      this.helmsman.elapsedSeconds,
      { planName, canvas: plan },
      false,
    );
    this.canvasHands.receiveOrder(order);
    return order;
  }

  maneuver() {
    return this.helmsman.readout().maneuver;
  }

  cannotDrawReports(): readonly SailName[] {
    const reports: SailName[] = [];
    for (const station of this.trimmers.readout().stations) {
      if (station.cannotDraw) reports.push(station.station);
    }
    return reports;
  }

  private orderEvolution(kind: 'tack' | 'gybe', newCourseDeg: number): CrewOrder {
    if (!Number.isFinite(newCourseDeg)) {
      throw new RangeError(`evolution course must be finite, got ${newCourseDeg}`);
    }
    // Everyone who has a rope in this hears it at once: the man on the tiller
    // and every hand at a sheet. Each of them works his own part of it.
    const stations: CrewStationId[] = [
      'helm',
      ...(TRIM_STATIONS as readonly CrewStationId[]),
    ];
    const order = this.orders.issue(
      kind,
      stations,
      this.helmsman.elapsedSeconds,
      { courseDeg: wrap360(newCourseDeg) },
      false,
    );
    this.helmsman.receiveOrder(order);
    this.trimmers.receiveOrder(order);
    return order;
  }

  orderCompassCourse(courseDeg: number): CrewOrder {
    if (!Number.isFinite(courseDeg)) {
      throw new RangeError(`compass course must be finite, got ${courseDeg}`);
    }
    const order = this.orders.issue(
      'steer-compass-course',
      ['helm'],
      this.helmsman.elapsedSeconds,
      { courseDeg: wrap360(courseDeg) },
      true,
    );
    this.helmsman.receiveOrder(order);
    return order;
  }

  /**
   * "Full and by" / "hold her at sixty" — an angle off the bow, either side.
   *
   * The tack she is on is not part of the order: the helmsman feels which
   * cheek the wind is on and works to that. He never receives the angle
   * itself, only what the dogvane and the luff tell him about it.
   */
  orderApparentWindAngle(angleOffBowDeg: number): CrewOrder {
    if (!Number.isFinite(angleOffBowDeg)) {
      throw new RangeError(
        `apparent wind angle must be finite, got ${angleOffBowDeg}`,
      );
    }
    const order = this.orders.issue(
      'hold-apparent-wind-angle',
      ['helm'],
      this.helmsman.elapsedSeconds,
      { apparentWindAngleDeg: Math.min(Math.abs(angleOffBowDeg), 180) },
      true,
    );
    this.helmsman.receiveOrder(order);
    return order;
  }

  standDownHelm(): CrewOrder {
    const order = this.orders.issue(
      'stand-down-helm',
      ['helm'],
      this.helmsman.elapsedSeconds,
      {},
      false,
    );
    this.helmsman.receiveOrder(order);
    return order;
  }

  /**
   * "Trim to draw" — one spoken order, heard by every sheet station.
   *
   * It activates a standing duty at each of them independently. Nothing after
   * this comes from the captain: each hand works his own sail on his own
   * observation until he is stood down.
   */
  orderTrimToDraw(stations: readonly SailName[] = TRIM_STATIONS): CrewOrder {
    const order = this.orders.issue(
      'trim-to-draw',
      stations as readonly CrewStationId[],
      this.helmsman.elapsedSeconds,
      {},
      true,
    );
    this.trimmers.receiveOrder(order);
    return order;
  }

  standDownTrim(stations: readonly SailName[] = TRIM_STATIONS): CrewOrder {
    const order = this.orders.issue(
      'stand-down-trim',
      stations as readonly CrewStationId[],
      this.helmsman.elapsedSeconds,
      {},
      false,
    );
    this.trimmers.receiveOrder(order);
    return order;
  }

  setDirectHelmTakeover(active: boolean): void {
    this.helmsman.setDirectTakeover(active);
  }

  /** The player has this sheet in his own hands; that station lets go. */
  setDirectTrimTakeover(sail: SailName, active: boolean): void {
    this.trimmers.setDirectTakeover(sail, active);
    this.canvasHands.setDirectTakeover(sail, active);
  }

  advanceSubstep(
    stepSeconds: number,
    observation: Readonly<HelmObservation>,
    sailObservation?: SailObservationSource,
    navigatorObservation?: Readonly<NavigatorObservation>,
  ): void {
    this.helmsman.advanceSubstep(stepSeconds, observation);
    if (sailObservation) {
      this.trimmers.advanceSubstep(stepSeconds, sailObservation);
    }
    this.canvasHands.advanceSubstep(stepSeconds);
    if (this.navigatorValue && navigatorObservation) {
      this.navigatorValue.advanceSubstep(stepSeconds, navigatorObservation);
    }
  }

  reset(): void {
    this.orders.reset();
    this.helmsman.reset();
    this.trimmers.reset();
    this.canvasHands.reset();
    this.navigatorValue?.reset();
  }

  readout(): SailingCrewReadout {
    return {
      elapsedSeconds: this.helmsman.elapsedSeconds,
      helmsman: this.helmsman.readout(),
      trimmers: this.trimmers.readout(),
      canvas: this.canvasHands.readout(),
      navigator: this.navigatorValue?.readout() ?? null,
    };
  }
}
