import type { OvertopEvent } from './BuoyantBody';
import type {
  ContactVector3,
  HullWaterContactView,
  LongitudinalContactRegion,
} from './HullWaterContact';

/** One active hull/waterline intersection copied into the stable wake buffer. */
export interface WakeWaterlinePoint extends ContactVector3 {
  stationIndex: number;
  side: 'port' | 'starboard';
}

/**
 * The renderer's fixed waterline-source budget: thirteen matched cuts, with
 * one point per side.  Keep the number here, where the contact adapter can
 * resample once, rather than teaching FoamField about the schooner's 39
 * physical stations.
 */
export const WAKE_WATERLINE_POLYLINE_STATIONS = 13;

/** One resampled point in a matched port/starboard hull-side polyline. */
export interface WakeWaterlinePolylinePoint extends ContactVector3 {
  stationLocalZ: number;
  side: 'port' | 'starboard';
}

/** The aft-most complete waterline cut available in the stern region. */
export interface WakeWaterlineSegment {
  active: boolean;
  stationIndex: number;
  readonly port: ContactVector3;
  readonly starboard: ContactVector3;
}

/**
 * One complete resolved waterline cut, in both hull-local and render/world
 * coordinates.
 *
 * WK2's wet-hull ribbon consumes the local pair: it shades the geometry in the
 * same frame its vertices were authored in, so pitch and roll are already
 * represented by the contact solver rather than reconstructed in a material.
 * World points remain here for presentation effects that live on the ocean.
 */
export interface WakeResolvedWaterlineStation {
  stationIndex: number;
  stationLocalZ: number;
  readonly portLocal: ContactVector3;
  readonly starboardLocal: ContactVector3;
  readonly portWorld: ContactVector3;
  readonly starboardWorld: ContactVector3;
}

/** Contact kinematics condensed for one longitudinal third of the hull. */
export interface WakeRegionSources {
  /** Wet stations contributing to the entry-speed statistics this frame. */
  wetStationCount: number;
  /** Active port/starboard waterline intersections in this region. */
  waterlinePointCount: number;
  meanEntrySpeedMps: number;
  peakEntrySpeedMps: number;
  /**
   * Total immersed volume of this region's stations, m³.
   *
   * WK3's entry detector differences this between frames to get the rate at
   * which the bow is burying itself. The sum is published rather than the rate
   * because this adapter owns no history — see the class note below.
   */
  immersedVolumeM3: number;
}

/**
 * The bow station driving this frame's entry, with what is needed to aim from.
 *
 * WK3's design rule is that the throw comes from
 * `relativeWaterVelocityWorldMps` and the surface normal, never from a scripted
 * "up and out". Both live per station, so the adapter republishes them from the
 * one station with the highest wet-contact closing speed and the emitter never
 * iterates stations itself.
 */
export interface WakeBowEntryKinematics {
  active: boolean;
  stationIndex: number;
  entrySpeedMps: number;
  /** Outward water-surface normal at that station. */
  readonly surfaceNormal: ContactVector3;
  /** Water minus hull-point velocity: the flow the bow is actually meeting. */
  readonly relativeFlow: ContactVector3;
}

function point(): ContactVector3 {
  return { x: 0, y: 0, z: 0 };
}

function waterlinePoint(): WakeWaterlinePoint {
  return { ...point(), stationIndex: -1, side: 'port' };
}

function waterlinePolylinePoint(
  side: 'port' | 'starboard',
): WakeWaterlinePolylinePoint {
  return { ...point(), stationLocalZ: 0, side };
}

function resolvedWaterlineStation(): WakeResolvedWaterlineStation {
  return {
    stationIndex: -1,
    stationLocalZ: 0,
    portLocal: point(),
    starboardLocal: point(),
    portWorld: point(),
    starboardWorld: point(),
  };
}

function regionSources(): WakeRegionSources {
  return {
    wetStationCount: 0,
    waterlinePointCount: 0,
    meanEntrySpeedMps: 0,
    peakEntrySpeedMps: 0,
    immersedVolumeM3: 0,
  };
}

function bowEntryKinematics(): WakeBowEntryKinematics {
  return {
    active: false,
    stationIndex: -1,
    entrySpeedMps: 0,
    surfaceNormal: { x: 0, y: 1, z: 0 },
    relativeFlow: point(),
  };
}

function copyPoint(
  destination: ContactVector3,
  source: Readonly<ContactVector3>,
): void {
  destination.x = source.x;
  destination.y = source.y;
  destination.z = source.z;
}

function interpolatePoint(
  destination: ContactVector3,
  a: Readonly<ContactVector3>,
  b: Readonly<ContactVector3>,
  t: number,
): void {
  destination.x = a.x + (b.x - a.x) * t;
  destination.y = a.y + (b.y - a.y) * t;
  destination.z = a.z + (b.z - a.z) * t;
}

function copyResolvedWaterlineStation(
  destination: WakeResolvedWaterlineStation,
  source: Readonly<WakeResolvedWaterlineStation>,
): void {
  destination.stationIndex = source.stationIndex;
  destination.stationLocalZ = source.stationLocalZ;
  copyPoint(destination.portLocal, source.portLocal);
  copyPoint(destination.starboardLocal, source.starboardLocal);
  copyPoint(destination.portWorld, source.portWorld);
  copyPoint(destination.starboardWorld, source.starboardWorld);
}

/**
 * Allocation-free contact-to-effects adapter.
 *
 * `HullWaterContactView` is a transient graph whose identities are stable while
 * its values are overwritten by physics. This adapter follows the same rule:
 * it allocates its output graph once, then rewrites it in `update()`. Consumers
 * may retain the objects but must not treat their values as history.
 *
 * The adapter is deliberately only a condensation step. It applies no wake
 * policy, owns no persistence, and writes to neither physics nor the wave
 * field. The active overtop list is exposed by reference because its owner
 * already clears and refills that same array at the physics-frame boundary.
 */
export class WakeSources {
  readonly sternWaterline: WakeWaterlineSegment = {
    active: false,
    stationIndex: -1,
    port: point(),
    starboard: point(),
  };

  /** Forward-most complete cut in the bow third, used by the mound candidate. */
  readonly bowStemWaterline: WakeWaterlineSegment = {
    active: false,
    stationIndex: -1,
    port: point(),
    starboard: point(),
  };

  /** Stable capacity buffer; only entries below `bowWaterlinePointCount` are live. */
  readonly bowWaterlinePoints: readonly WakeWaterlinePoint[];
  bowWaterlinePointCount = 0;

  /**
   * Stable, longitudinally sorted capacity buffer of complete waterline cuts.
   * Only entries below `resolvedWaterlineStationCount` are live.
   */
  readonly resolvedWaterlineStations: readonly WakeResolvedWaterlineStation[];
  resolvedWaterlineStationCount = 0;

  /**
   * Thirteen matched cuts packed port, starboard, port, starboard.  FoamField
   * consumes adjacent points on each side as continuous segments; only pairs
   * below `waterlinePolylineStationCount` are live.
   */
  readonly waterlinePolylinePoints: readonly WakeWaterlinePolylinePoint[];
  waterlinePolylineStationCount = 0;

  readonly regions = {
    bow: regionSources(),
    midships: regionSources(),
    stern: regionSources(),
  };

  /** Kinematics of the hardest-entering wet bow station, for WK3's throw. */
  readonly bowEntry: WakeBowEntryKinematics = bowEntryKinematics();

  constructor(
    private readonly contacts: readonly HullWaterContactView[],
    /** Same stable event list owned and refreshed by `BuoyantBody`. */
    readonly activeOvertopEvents: readonly OvertopEvent[],
  ) {
    this.bowWaterlinePoints = Array.from(
      { length: contacts.length * 2 },
      waterlinePoint,
    );
    this.resolvedWaterlineStations = Array.from(
      { length: contacts.length },
      resolvedWaterlineStation,
    );
    this.waterlinePolylinePoints = Array.from(
      { length: WAKE_WATERLINE_POLYLINE_STATIONS * 2 },
      (_, index) => waterlinePolylinePoint(index % 2 === 0 ? 'port' : 'starboard'),
    );
  }

  get activeOvertopEventCount(): number {
    return this.activeOvertopEvents.length;
  }

  /** Refresh every output value from the current contact instant. */
  update(): this {
    this.sternWaterline.active = false;
    this.sternWaterline.stationIndex = -1;
    this.bowStemWaterline.active = false;
    this.bowStemWaterline.stationIndex = -1;
    this.bowWaterlinePointCount = 0;
    this.resolvedWaterlineStationCount = 0;
    this.waterlinePolylineStationCount = 0;
    this.bowEntry.active = false;
    this.bowEntry.stationIndex = -1;
    this.bowEntry.entrySpeedMps = 0;

    const bow = this.regions.bow;
    const midships = this.regions.midships;
    const stern = this.regions.stern;
    this.resetRegion(bow);
    this.resetRegion(midships);
    this.resetRegion(stern);

    let sternStationZ = Number.POSITIVE_INFINITY;
    let bowStationZ = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < this.contacts.length; i++) {
      const contact = this.contacts[i];
      const region = this.region(contact.longitudinalRegion);
      const portActive = contact.portWaterline.active;
      const starboardActive = contact.starboardWaterline.active;

      if (portActive) region.waterlinePointCount++;
      if (starboardActive) region.waterlinePointCount++;

      if (contact.isWet) {
        const entrySpeed = contact.normalEntrySpeedMps;
        region.wetStationCount++;
        region.meanEntrySpeedMps += entrySpeed;
        region.peakEntrySpeedMps = Math.max(
          region.peakEntrySpeedMps,
          entrySpeed,
        );
        region.immersedVolumeM3 += contact.immersedVolumeM3;

        // Strictly greater, so a tie keeps the aft-most of two equal stations
        // rather than depending on iteration order.
        if (
          contact.longitudinalRegion === 'bow' &&
          (!this.bowEntry.active || entrySpeed > this.bowEntry.entrySpeedMps)
        ) {
          this.bowEntry.active = true;
          this.bowEntry.stationIndex = contact.stationIndex;
          this.bowEntry.entrySpeedMps = entrySpeed;
          copyPoint(this.bowEntry.surfaceNormal, contact.surfaceNormalWorld);
          copyPoint(
            this.bowEntry.relativeFlow,
            contact.relativeWaterVelocityWorldMps,
          );
        }
      }

      if (contact.longitudinalRegion === 'bow') {
        if (portActive) this.appendBowPoint(contact, 'port');
        if (starboardActive) this.appendBowPoint(contact, 'starboard');
      }

      if (portActive && starboardActive) {
        this.insertResolvedWaterlineStation(contact);
      }

      // A segment needs both real side intersections. Walk by geometry rather
      // than array order and retain the aft-most complete cut in the stern
      // third, so station reordering cannot move the emitter forward.
      if (
        contact.longitudinalRegion === 'stern' &&
        portActive &&
        starboardActive &&
        contact.stationReferenceLocal.z < sternStationZ
      ) {
        sternStationZ = contact.stationReferenceLocal.z;
        this.sternWaterline.active = true;
        this.sternWaterline.stationIndex = contact.stationIndex;
        copyPoint(
          this.sternWaterline.port,
          contact.portWaterline.worldPoint,
        );
        copyPoint(
          this.sternWaterline.starboard,
          contact.starboardWaterline.worldPoint,
        );
      }

      // The last complete cut before the stem is the only honest attachment
      // point for an analytic bow cue. Do not use design draught or design
      // length: both would drift away from the resolved surface in pitch.
      if (
        contact.longitudinalRegion === 'bow' &&
        portActive &&
        starboardActive &&
        contact.stationReferenceLocal.z > bowStationZ
      ) {
        bowStationZ = contact.stationReferenceLocal.z;
        this.bowStemWaterline.active = true;
        this.bowStemWaterline.stationIndex = contact.stationIndex;
        copyPoint(
          this.bowStemWaterline.port,
          contact.portWaterline.worldPoint,
        );
        copyPoint(
          this.bowStemWaterline.starboard,
          contact.starboardWaterline.worldPoint,
        );
      }
    }

    this.finishRegion(bow);
    this.finishRegion(midships);
    this.finishRegion(stern);
    this.resampleWaterlinePolylines();
    return this;
  }

  private region(region: LongitudinalContactRegion): WakeRegionSources {
    return this.regions[region];
  }

  private resetRegion(region: WakeRegionSources): void {
    region.wetStationCount = 0;
    region.waterlinePointCount = 0;
    region.meanEntrySpeedMps = 0;
    region.peakEntrySpeedMps = 0;
    region.immersedVolumeM3 = 0;
  }

  private finishRegion(region: WakeRegionSources): void {
    if (region.wetStationCount > 0) {
      region.meanEntrySpeedMps /= region.wetStationCount;
    }
  }

  private appendBowPoint(
    contact: HullWaterContactView,
    side: 'port' | 'starboard',
  ): void {
    const destination = this.bowWaterlinePoints[this.bowWaterlinePointCount];
    const source =
      side === 'port' ? contact.portWaterline : contact.starboardWaterline;
    destination.stationIndex = contact.stationIndex;
    destination.side = side;
    copyPoint(destination, source.worldPoint);
    this.bowWaterlinePointCount++;
  }

  /**
   * Insert a complete cut by local longitudinal position without allocating.
   *
   * Production contacts already arrive aft-to-forward, but the adapter's
   * contract must not depend on array order (the stern source never has). The
   * fixed-capacity insertion keeps the profile deterministic in hand-built
   * fixtures and future station layouts while preserving every object identity.
   */
  private insertResolvedWaterlineStation(
    contact: HullWaterContactView,
  ): void {
    let insertAt = this.resolvedWaterlineStationCount;
    while (
      insertAt > 0 &&
      this.resolvedWaterlineStations[insertAt - 1].stationLocalZ >
        contact.stationReferenceLocal.z
    ) {
      copyResolvedWaterlineStation(
        this.resolvedWaterlineStations[insertAt],
        this.resolvedWaterlineStations[insertAt - 1],
      );
      insertAt--;
    }

    const destination = this.resolvedWaterlineStations[insertAt];
    destination.stationIndex = contact.stationIndex;
    destination.stationLocalZ = contact.stationReferenceLocal.z;
    copyPoint(destination.portLocal, contact.portWaterline.localPoint);
    copyPoint(
      destination.starboardLocal,
      contact.starboardWaterline.localPoint,
    );
    copyPoint(destination.portWorld, contact.portWaterline.worldPoint);
    copyPoint(
      destination.starboardWorld,
      contact.starboardWaterline.worldPoint,
    );
    this.resolvedWaterlineStationCount++;
  }

  /**
   * Resample the complete, longitudinally sorted cuts into the renderer's
   * fixed source budget without allocating.
   *
   * Equal spacing in hull-local z retains both live endpoints and gives every
   * part of the 15.5 m waterline a segment even when the physical station
   * spacing is uneven.  World points are interpolated only for presentation;
   * neither the contact graph nor the physical surface is changed.
   */
  private resampleWaterlinePolylines(): void {
    const sourceCount = this.resolvedWaterlineStationCount;
    if (sourceCount === 0) return;

    const targetCount =
      sourceCount === 1 ? 1 : WAKE_WATERLINE_POLYLINE_STATIONS;
    const first = this.resolvedWaterlineStations[0];
    const last = this.resolvedWaterlineStations[sourceCount - 1];
    let upperIndex = sourceCount > 1 ? 1 : 0;

    for (let i = 0; i < targetCount; i++) {
      const fraction = targetCount > 1 ? i / (targetCount - 1) : 0;
      const targetZ =
        first.stationLocalZ +
        (last.stationLocalZ - first.stationLocalZ) * fraction;

      while (
        upperIndex < sourceCount - 1 &&
        this.resolvedWaterlineStations[upperIndex].stationLocalZ < targetZ
      ) {
        upperIndex++;
      }

      const upper = this.resolvedWaterlineStations[upperIndex];
      const lower = this.resolvedWaterlineStations[
        Math.max(upperIndex - 1, 0)
      ];
      const span = upper.stationLocalZ - lower.stationLocalZ;
      const interpolation = span > 1e-9
        ? Math.min(Math.max((targetZ - lower.stationLocalZ) / span, 0), 1)
        : 0;
      const port = this.waterlinePolylinePoints[i * 2];
      const starboard = this.waterlinePolylinePoints[i * 2 + 1];
      port.stationLocalZ = targetZ;
      starboard.stationLocalZ = targetZ;
      interpolatePoint(port, lower.portWorld, upper.portWorld, interpolation);
      interpolatePoint(
        starboard,
        lower.starboardWorld,
        upper.starboardWorld,
        interpolation,
      );
    }

    this.waterlinePolylineStationCount = targetCount;
  }
}
