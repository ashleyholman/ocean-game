import type { GlobalTerrainSource } from './GlobalTerrainSource';
import {
  WGS84_SEMI_MAJOR_M,
  WGS84_SEMI_MINOR_M,
  wrapLongitudeRad,
} from '../world/wgs84';

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;
const RAD_TO_DEG = 180 / Math.PI;
const SEARCH_RADIUS_M =
  (2 * WGS84_SEMI_MAJOR_M + WGS84_SEMI_MINOR_M) / 3;

export interface OpeningCoordinate {
  readonly latitudeRad: number;
  readonly longitudeRad: number;
}

export interface AuthoredOpening extends OpeningCoordinate {
  /** Clockwise from true north. Used only after displacement ties. */
  readonly outboundCourseRad: number;
}

export interface WaterAwareOpeningSearchProfile {
  readonly minimumClearanceM: number;
  readonly radialStepM: number;
  readonly maximumRadiusM: number;
  readonly bearingStepDeg: number;
}

export const DEFAULT_WATER_AWARE_OPENING_PROFILE:
  WaterAwareOpeningSearchProfile = Object.freeze({
    minimumClearanceM: 5_000,
    radialStepM: 500,
    maximumRadiusM: 100_000,
    bearingStepDeg: 5,
  });

export type WaterAwareOpeningReason =
  | 'authored_water_qualified'
  | 'authored_land'
  | 'authored_water_below_clearance';

interface WaterAwareOpeningDiagnosticsBase {
  readonly sourceBuildId: string;
  readonly authored: Readonly<AuthoredOpening>;
  readonly authoredSurface: 'land' | 'ocean';
  readonly authoredClearanceM: number;
  readonly reason: WaterAwareOpeningReason;
  readonly profile: Readonly<WaterAwareOpeningSearchProfile>;
  /** Includes the authored point and every evaluated search candidate. */
  readonly candidatesTested: number;
  readonly ringsTested: number;
}

export interface WaterAwareOpeningSuccess
  extends WaterAwareOpeningDiagnosticsBase {
  readonly status: 'authored' | 'resolved';
  readonly resolved: Readonly<OpeningCoordinate>;
  readonly resolvedClearanceM: number;
  readonly displacementM: number;
  /** Null when the authored coordinate remains unchanged. */
  readonly selectedBearingRad: number | null;
}

export interface WaterAwareOpeningFailure
  extends WaterAwareOpeningDiagnosticsBase {
  readonly status: 'failed';
  readonly resolved: null;
  readonly maximumObservedClearanceM: number;
}

export type WaterAwareOpeningResolution =
  | WaterAwareOpeningSuccess
  | WaterAwareOpeningFailure;

interface WaterAwareTeleportDecisionBase {
  readonly selected: Readonly<OpeningCoordinate>;
}

export type WaterAwareTeleportDecision =
  | (WaterAwareTeleportDecisionBase & {
      readonly status: 'accepted';
      readonly target: Readonly<OpeningCoordinate>;
      readonly resolution: Readonly<WaterAwareOpeningSuccess>;
    })
  | (WaterAwareTeleportDecisionBase & {
      readonly status: 'relocated';
      readonly target: Readonly<OpeningCoordinate>;
      readonly resolution: Readonly<WaterAwareOpeningSuccess>;
    })
  | (WaterAwareTeleportDecisionBase & {
      readonly status: 'rejected';
      readonly target: null;
      readonly resolution: Readonly<WaterAwareOpeningFailure>;
    });

/**
 * Qualify an arbitrary globe selection against the same water authority as the
 * opening resolver. True north is the explicit tie gauge because a map click
 * has no authored outbound course; distance still wins before bearing.
 */
export function resolveWaterAwareTeleport(
  query: OpeningWaterQuery,
  selected: Readonly<OpeningCoordinate>,
  profile: Readonly<WaterAwareOpeningSearchProfile> =
    DEFAULT_WATER_AWARE_OPENING_PROFILE,
): WaterAwareTeleportDecision {
  const selectedSnapshot = Object.freeze({
    latitudeRad: selected.latitudeRad,
    longitudeRad: selected.longitudeRad,
  });
  const resolution = resolveWaterAwareOpening(
    query,
    {
      ...selectedSnapshot,
      // A globe selection has no course. Pinning this gauge makes equal-range
      // candidates deterministic at ordinary coordinates and exact poles.
      outboundCourseRad: 0,
    },
    profile,
  );

  if (resolution.status === 'failed') {
    return Object.freeze({
      status: 'rejected',
      selected: selectedSnapshot,
      target: null,
      resolution,
    });
  }
  return Object.freeze({
    status: resolution.status === 'resolved' ? 'relocated' : 'accepted',
    selected: selectedSnapshot,
    target: resolution.resolved,
    resolution,
  });
}

/** Stable one-line publication for a user-requested globe teleport. */
export function formatWaterAwareTeleportDiagnostic(
  decision: Readonly<WaterAwareTeleportDecision>,
): string {
  const { resolution } = decision;
  const selected =
    `selected ${formatCoordinate(decision.selected)}` +
    ` (${resolution.authoredSurface}, ` +
    `${resolution.authoredClearanceM.toFixed(0)} m clearance)`;
  if (resolution.status === 'failed') {
    return (
      `global teleport rejected · ${selected}` +
      ` · no ${resolution.profile.minimumClearanceM.toFixed(0)} m-clearance lattice candidate` +
      ` across ${resolution.profile.maximumRadiusM.toFixed(0)} m search` +
      ` · maximum sampled ${resolution.maximumObservedClearanceM.toFixed(0)} m` +
      ` · ${resolution.sourceBuildId}`
    );
  }
  return (
    `global teleport ${decision.status} · ${selected}` +
    ` → target ${formatCoordinate(resolution.resolved)}` +
    ` (${resolution.resolvedClearanceM.toFixed(0)} m clearance)` +
    ` · displacement ${resolution.displacementM.toFixed(0)} m` +
    ` · ${resolution.sourceBuildId}`
  );
}

/** Compact result text shown beside the globe marker; null clears old text. */
export function formatWaterAwareTeleportNotice(
  decision: Readonly<WaterAwareTeleportDecision>,
): string | null {
  if (decision.status === 'rejected') {
    return (
      'rejected: ' +
      `${(decision.resolution.profile.maximumRadiusM / 1_000).toFixed(0)} km lattice exhausted`
    );
  }
  return decision.status === 'relocated'
    ? `moved ${(decision.resolution.displacementM / 1_000).toFixed(1)} km to qualified coarse water`
    : null;
}

/** Stable one-line publication for World/terrain inspection surfaces. */
export function formatWaterAwareOpeningDiagnostic(
  resolution: Readonly<WaterAwareOpeningSuccess>,
): string {
  return (
    `global opening ${resolution.status} · reason ${resolution.reason}` +
    ` · authored ${formatCoordinate(resolution.authored)}` +
    ` (${resolution.authoredSurface}, ${resolution.authoredClearanceM.toFixed(0)} m clearance)` +
    ` → resolved ${formatCoordinate(resolution.resolved)}` +
    ` (${resolution.resolvedClearanceM.toFixed(0)} m clearance)` +
    ` · displacement ${resolution.displacementM.toFixed(0)} m` +
    ` · ${resolution.sourceBuildId}`
  );
}

type OpeningWaterQuery = Pick<
  GlobalTerrainSource,
  'sourceBuildId' | 'sample' | 'nearestLandM'
>;

/**
 * Resolve an authored opening against one water/land authority.
 *
 * The search domain is finite and stated by `profile`: ascending geodesic
 * rings, then bearings ordered by proximity to the authored outbound course.
 * Therefore the first accepted point is the minimum-displacement qualified
 * candidate in that lattice. Clockwise wins an otherwise exact bearing tie.
 * No global state, clock, random source, renderer, or mutable cache is read.
 */
export function resolveWaterAwareOpening(
  query: OpeningWaterQuery,
  authored: Readonly<AuthoredOpening>,
  profile: Readonly<WaterAwareOpeningSearchProfile> =
    DEFAULT_WATER_AWARE_OPENING_PROFILE,
): WaterAwareOpeningResolution {
  assertAuthoredOpening(authored);
  const search = validateProfile(profile);
  const authoredCoordinate = Object.freeze({
    latitudeRad: authored.latitudeRad,
    longitudeRad: authored.longitudeRad,
    outboundCourseRad: authored.outboundCourseRad,
  });
  const profileSnapshot = Object.freeze({ ...profile });
  const authoredSample = query.sample(
    authored.latitudeRad,
    authored.longitudeRad,
  );
  const authoredClearanceM =
    authoredSample.surface === 'land'
      ? 0
      : checkedClearanceM(
          query.nearestLandM(authored.latitudeRad, authored.longitudeRad),
        );
  const reason: WaterAwareOpeningReason =
    authoredSample.surface === 'land'
      ? 'authored_land'
      : authoredClearanceM >= profile.minimumClearanceM
        ? 'authored_water_qualified'
        : 'authored_water_below_clearance';

  if (reason === 'authored_water_qualified') {
    // Do not normalise, recompute, or round an already-valid authored point.
    // This exact copy is the resolver's bit-identity contract.
    return Object.freeze({
      status: 'authored',
      sourceBuildId: query.sourceBuildId,
      authored: authoredCoordinate,
      authoredSurface: authoredSample.surface,
      authoredClearanceM,
      reason,
      profile: profileSnapshot,
      candidatesTested: 1,
      ringsTested: 0,
      resolved: Object.freeze({
        latitudeRad: authored.latitudeRad,
        longitudeRad: authored.longitudeRad,
      }),
      resolvedClearanceM: authoredClearanceM,
      displacementM: 0,
      selectedBearingRad: null,
    });
  }

  const orderedBearingOffsetsRad = buildOrderedBearingOffsetsRad(
    search.bearingCount,
  );
  const outboundCourseRad = wrapPositiveRadians(authored.outboundCourseRad);
  let candidatesTested = 1;
  let maximumObservedClearanceM = authoredClearanceM;

  for (let ringIndex = 1; ringIndex <= search.ringCount; ringIndex++) {
    const displacementM = ringIndex * profile.radialStepM;
    for (const bearingOffsetRad of orderedBearingOffsetsRad) {
      const selectedBearingRad = wrapPositiveRadians(
        outboundCourseRad + bearingOffsetRad,
      );
      const candidate = destinationPoint(
        authored,
        selectedBearingRad,
        displacementM,
      );
      candidatesTested++;
      const sample = query.sample(
        candidate.latitudeRad,
        candidate.longitudeRad,
      );
      if (sample.surface !== 'ocean') continue;
      const clearanceM = checkedClearanceM(
        query.nearestLandM(candidate.latitudeRad, candidate.longitudeRad),
      );
      maximumObservedClearanceM = Math.max(
        maximumObservedClearanceM,
        clearanceM,
      );
      if (clearanceM < profile.minimumClearanceM) continue;

      return Object.freeze({
        status: 'resolved',
        sourceBuildId: query.sourceBuildId,
        authored: authoredCoordinate,
        authoredSurface: authoredSample.surface,
        authoredClearanceM,
        reason,
        profile: profileSnapshot,
        candidatesTested,
        ringsTested: ringIndex,
        resolved: Object.freeze(candidate),
        resolvedClearanceM: clearanceM,
        displacementM,
        selectedBearingRad,
      });
    }
  }

  return Object.freeze({
    status: 'failed',
    sourceBuildId: query.sourceBuildId,
    authored: authoredCoordinate,
    authoredSurface: authoredSample.surface,
    authoredClearanceM,
    reason,
    profile: profileSnapshot,
    candidatesTested,
    ringsTested: search.ringCount,
    resolved: null,
    maximumObservedClearanceM,
  });
}

function validateProfile(profile: Readonly<WaterAwareOpeningSearchProfile>): {
  ringCount: number;
  bearingCount: number;
} {
  assertPositiveFinite(profile.minimumClearanceM, 'minimumClearanceM');
  assertPositiveFinite(profile.radialStepM, 'radialStepM');
  assertPositiveFinite(profile.maximumRadiusM, 'maximumRadiusM');
  assertPositiveFinite(profile.bearingStepDeg, 'bearingStepDeg');
  const ringCount = profile.maximumRadiusM / profile.radialStepM;
  const bearingCount = 360 / profile.bearingStepDeg;
  if (!Number.isInteger(ringCount) || ringCount < 1) {
    throw new RangeError('maximumRadiusM must be an integer multiple of radialStepM');
  }
  if (!Number.isInteger(bearingCount) || bearingCount < 1) {
    throw new RangeError('bearingStepDeg must divide 360 exactly');
  }
  return { ringCount, bearingCount };
}

function buildOrderedBearingOffsetsRad(bearingCount: number): number[] {
  const stepRad = TWO_PI / bearingCount;
  const offsets = [0];
  for (let stepIndex = 1; offsets.length < bearingCount; stepIndex++) {
    offsets.push(stepIndex * stepRad);
    if (offsets.length < bearingCount) offsets.push(-stepIndex * stepRad);
  }
  return offsets;
}

/**
 * Spherical direct solution over the same mean-radius policy as coast range.
 *
 * The local tangent basis is also the pole gauge: at the north pole true
 * north continues across the pole on the opposite meridian; at the south pole
 * it follows the authored meridian. That is the limit of this same basis from
 * finite latitudes, so exact poles never depend on `atan2(0, 0)` or engine
 * rounding.
 */
function destinationPoint(
  origin: Readonly<OpeningCoordinate>,
  bearingRad: number,
  distanceM: number,
): OpeningCoordinate {
  const angularDistance = distanceM / SEARCH_RADIUS_M;
  const sinLatitude = Math.sin(origin.latitudeRad);
  const cosLatitude = Math.cos(origin.latitudeRad);
  const sinLongitude = Math.sin(origin.longitudeRad);
  const cosLongitude = Math.cos(origin.longitudeRad);
  const sinDistance = Math.sin(angularDistance);
  const cosDistance = Math.cos(angularDistance);
  const cosBearing = Math.cos(bearingRad);
  const sinBearing = Math.sin(bearingRad);

  const originX = cosLatitude * cosLongitude;
  const originY = cosLatitude * sinLongitude;
  const northX = -sinLatitude * cosLongitude;
  const northY = -sinLatitude * sinLongitude;
  const northZ = cosLatitude;
  const eastX = -sinLongitude;
  const eastY = cosLongitude;
  const travelX = northX * cosBearing + eastX * sinBearing;
  const travelY = northY * cosBearing + eastY * sinBearing;
  const travelZ = northZ * cosBearing;
  const x = originX * cosDistance + travelX * sinDistance;
  const y = originY * cosDistance + travelY * sinDistance;
  const z = sinLatitude * cosDistance + travelZ * sinDistance;
  const horizontal = Math.hypot(x, y);
  const latitudeRad = Math.atan2(z, horizontal);
  const longitudeRad = horizontal <= 16 * Number.EPSILON
    ? 0
    : wrapLongitudeRad(Math.atan2(y, x));
  return { latitudeRad, longitudeRad };
}

function formatCoordinate(coordinate: Readonly<OpeningCoordinate>): string {
  return (
    `${(coordinate.latitudeRad * RAD_TO_DEG).toFixed(5)}°,` +
    `${(coordinate.longitudeRad * RAD_TO_DEG).toFixed(5)}°`
  );
}

function assertAuthoredOpening(authored: Readonly<AuthoredOpening>): void {
  if (
    !Number.isFinite(authored.latitudeRad) ||
    !Number.isFinite(authored.longitudeRad) ||
    !Number.isFinite(authored.outboundCourseRad)
  ) {
    throw new RangeError('authored opening coordinates and course must be finite');
  }
  if (authored.latitudeRad < -HALF_PI || authored.latitudeRad > HALF_PI) {
    throw new RangeError('authored latitudeRad must be in [-pi/2, pi/2]');
  }
}

function checkedClearanceM(clearanceM: number): number {
  if (!Number.isFinite(clearanceM) || clearanceM < 0) {
    throw new RangeError('opening nearest-land clearance must be non-negative and finite');
  }
  return clearanceM;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive and finite`);
  }
}

function wrapPositiveRadians(angleRad: number): number {
  const wrapped = angleRad % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}
