import coarseData from './data/natural-earth-110m-coarse.json';
import coarseManifestJson from './data/global-coarse-manifest.json';
import {
  assertTerrainTileGeometry,
  type TerrainTileGeometry,
  type TerrainTileProvider,
} from './TerrainTile';
import { metresPerRadian } from './terrainMath';
import { vec3 } from '../world/math';
import {
  createGeographicBasis,
  geodeticToEcef,
  geographicBasisFromGeodetic,
  WGS84_SEMI_MAJOR_M,
  WGS84_SEMI_MINOR_M,
  wrapLongitudeRad,
} from '../world/wgs84';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const HALF_PI = Math.PI / 2;
const TILE_DEGREES = 2;
const TILE_CELLS = 32;
const TILE_SAMPLES = TILE_CELLS + 1;
const SAMPLE_STEP_DEGREES = TILE_DEGREES / TILE_CELLS;
const LONGITUDE_TILE_COUNT = 360 / TILE_DEGREES;
const LATITUDE_TILE_COUNT = 180 / TILE_DEGREES;
const WATER_FLOOR_HEIGHT_M = -80;
const NEIGHBOURHOOD_RADIUS_TILES = 1;
const DEFAULT_LAND_HEIGHT_M = 35;
const RELIEF_HEIGHT_SCALE = 0.62;
const COAST_ARC_MEMBERSHIP_EPSILON = 32 * Number.EPSILON;
const COAST_DISTANCE_ALGORITHM =
  'natural-earth-minor-great-circle-segment-v1';
const COAST_DISTANCE_RADIUS_POLICY =
  'WGS84 arithmetic mean radius (2a+b)/3';
const COAST_DISTANCE_LAND_POLICY =
  'exact zero from shared polygon classification';
const COAST_DISTANCE_PURPOSE =
  'voyage presentation governor and bounded coarse water qualification; not navigation, collision, grounding, or safety';

/**
 * Mean WGS84 radius used to turn the source polygon's spherical arc distance
 * into metres. Natural Earth's 1:110m generalisation dominates the sub-percent
 * ellipsoid approximation; this query is for the voyage governor, not
 * navigation or collision.
 */
export const GLOBAL_TERRAIN_COAST_DISTANCE_RADIUS_M =
  (2 * WGS84_SEMI_MAJOR_M + WGS84_SEMI_MINOR_M) / 3;

export type GlobalTerrainSurface = 'land' | 'ocean';

export interface GlobalTerrainSample {
  readonly latitudeRad: number;
  readonly longitudeRad: number;
  readonly surface: GlobalTerrainSurface;
  /** Visual displacement only; see the manifest's accuracy notice. */
  readonly heightM: number;
  /** Stable [0, 1] globe-shading input, not a physical material class. */
  readonly relief01: number;
}

export interface GlobalTerrainManifest {
  readonly schemaVersion: number;
  readonly buildId: string;
  readonly status: string;
  readonly canonical: boolean;
  readonly runtimeRoles: readonly string[];
  readonly accuracyNotice: string;
  readonly sources: {
    readonly land: Readonly<Record<string, string>>;
    readonly reliefSeeds: Readonly<Record<string, string>>;
  };
  readonly derivedAsset: {
    readonly path: string;
    readonly sha256: string;
    readonly builder: string;
    readonly coordinateQuantizationPerDegree: number;
    readonly landShapeCount: number;
    readonly elevationPointCount: number;
    readonly reliefAlgorithm: string;
    readonly reliefNotice: string;
  };
  readonly tileProfile: {
    readonly addressing: string;
    readonly tileDegrees: number;
    readonly samplesPerEdge: number;
    readonly neighbourhoodRadiusTiles: number;
    readonly waterFloorHeightM: number;
    readonly verticalPolicy: string;
  };
  readonly coastDistanceProfile: {
    readonly algorithm: string;
    readonly segmentCount: number;
    readonly distanceRadius: string;
    readonly landPolicy: string;
    readonly purpose: string;
  };
  readonly canonicalUpgrade: {
    readonly elevation: Readonly<Record<string, string>>;
    readonly water: Readonly<Record<string, string>>;
    readonly ingestionPipelineStatus: string;
    readonly gate: string;
  };
}

export interface GlobalTerrainSource extends TerrainTileProvider {
  readonly manifest: GlobalTerrainManifest;
  sample(latitudeRad: number, longitudeRad: number): GlobalTerrainSample;
  /** Zero on land; otherwise the shortest surface arc to this source's coast. */
  nearestLandM(latitudeRad: number, longitudeRad: number): number;
}

interface LandRing {
  readonly coordinatesDeg: Float64Array;
  readonly minLongitudeDeg: number;
  readonly minLatitudeDeg: number;
  readonly maxLongitudeDeg: number;
  readonly maxLatitudeDeg: number;
}

interface LandShape {
  readonly rings: readonly LandRing[];
  readonly minLongitudeDeg: number;
  readonly minLatitudeDeg: number;
  readonly maxLongitudeDeg: number;
  readonly maxLatitudeDeg: number;
}

interface ReliefSeed {
  readonly latitudeRad: number;
  readonly longitudeRad: number;
  readonly elevationM: number;
  readonly radiusRad: number;
}

interface CoastSegment {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  /** Unit normal of the minor great-circle arc from a to b. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Arc-interior half-space at a: n × a. */
  readonly startTangentX: number;
  readonly startTangentY: number;
  readonly startTangentZ: number;
  /** Arc-interior half-space at b: b × n. */
  readonly endTangentX: number;
  readonly endTangentY: number;
  readonly endTangentZ: number;
}

const manifest = coarseManifestJson as GlobalTerrainManifest;
assertStaticInputs();
const landShapes = decodeLandShapes();
const coastSegments = buildCoastSegments(landShapes);
assertCoastDistanceProfile(coastSegments.length);
const reliefSeeds = decodeReliefSeeds();

/** Fixed upper bound for one exact coarse-source coast query. */
export const GLOBAL_TERRAIN_COAST_SEGMENT_COUNT = coastSegments.length;

/**
 * Shared deterministic global base for the developer globe and local fallback
 * tiles. Natural Earth supplies the cartographic land mask and sparse named
 * extrema; the latter are broadened into deliberately coarse visual relief.
 * This is not, and the manifest does not call it, GLO-30 or WBM ingestion.
 */
class NaturalEarthCoarseTerrainSource implements GlobalTerrainSource {
  readonly sourceBuildId = manifest.buildId;
  readonly manifest = manifest;

  sample(latitudeRad: number, longitudeRad: number): GlobalTerrainSample {
    const location = normalizeLocation(latitudeRad, longitudeRad);
    const latitudeDeg = location.latitudeRad * RAD_TO_DEG;
    const longitudeDeg = location.longitudeRad * RAD_TO_DEG;
    const land = isNaturalEarthLand(latitudeDeg, longitudeDeg);
    const heightM = land
      ? visualLandHeightM(location.latitudeRad, location.longitudeRad)
      : WATER_FLOOR_HEIGHT_M;
    return {
      latitudeRad: location.latitudeRad,
      longitudeRad: location.longitudeRad,
      surface: land ? 'land' : 'ocean',
      heightM,
      relief01: land ? Math.min(1, Math.max(0, heightM / 5_500)) : 0,
    };
  }

  nearestLandM(latitudeRad: number, longitudeRad: number): number {
    const location = normalizeLocation(latitudeRad, longitudeRad);
    const latitudeDeg = location.latitudeRad * RAD_TO_DEG;
    const longitudeDeg = location.longitudeRad * RAD_TO_DEG;
    if (isNaturalEarthLand(latitudeDeg, longitudeDeg)) return 0;

    const query = sphericalUnitVector(latitudeDeg, longitudeDeg);
    let bestChordSquared = 4;
    for (const segment of coastSegments) {
      const dotA = clampUnitDot(
        query.x * segment.ax + query.y * segment.ay + query.z * segment.az,
      );
      const dotB = clampUnitDot(
        query.x * segment.bx + query.y * segment.by + query.z * segment.bz,
      );
      bestChordSquared = Math.min(
        bestChordSquared,
        2 - 2 * dotA,
        2 - 2 * dotB,
      );

      // If the perpendicular great-circle projection lies between both end
      // planes, its cross-track distance beats (or equals) the endpoints.
      const afterStart =
        query.x * segment.startTangentX +
        query.y * segment.startTangentY +
        query.z * segment.startTangentZ;
      if (afterStart < -COAST_ARC_MEMBERSHIP_EPSILON) continue;
      const beforeEnd =
        query.x * segment.endTangentX +
        query.y * segment.endTangentY +
        query.z * segment.endTangentZ;
      if (beforeEnd < -COAST_ARC_MEMBERSHIP_EPSILON) continue;

      const normalDot = clampUnitDot(
        query.x * segment.nx +
          query.y * segment.ny +
          query.z * segment.nz,
      );
      const projectedCosine = Math.sqrt(
        Math.max(0, 1 - normalDot * normalDot),
      );
      bestChordSquared = Math.min(
        bestChordSquared,
        2 - 2 * projectedCosine,
      );
    }

    // Chord and central angle are monotonic over [0, pi], so the fixed scan
    // needs only this one inverse trig conversion after finding its minimum.
    const halfChord = Math.min(
      1,
      Math.sqrt(Math.max(0, bestChordSquared)) / 2,
    );
    return (
      2 *
      Math.asin(halfChord) *
      GLOBAL_TERRAIN_COAST_DISTANCE_RADIUS_M
    );
  }

  locationKey(latitudeRad: number, longitudeRad: number): string {
    const indices = locationTileIndices(latitudeRad, longitudeRad);
    return `${this.sourceBuildId}/${indices.latitudeIndex}/${indices.longitudeIndex}`;
  }

  tilesAt(latitudeRad: number, longitudeRad: number): TerrainTileGeometry[] {
    const centre = locationTileIndices(latitudeRad, longitudeRad);
    const latitudeIndices = new Set<number>();
    for (
      let offset = -NEIGHBOURHOOD_RADIUS_TILES;
      offset <= NEIGHBOURHOOD_RADIUS_TILES;
      offset++
    ) {
      latitudeIndices.add(
        clampInteger(
          centre.latitudeIndex + offset,
          0,
          LATITUDE_TILE_COUNT - 1,
        ),
      );
    }

    const tiles: TerrainTileGeometry[] = [];
    for (const latitudeIndex of latitudeIndices) {
      for (
        let longitudeOffset = -NEIGHBOURHOOD_RADIUS_TILES;
        longitudeOffset <= NEIGHBOURHOOD_RADIUS_TILES;
        longitudeOffset++
      ) {
        const rawLongitudeIndex = centre.longitudeIndex + longitudeOffset;
        tiles.push(this.buildTile(latitudeIndex, rawLongitudeIndex));
      }
    }
    return tiles;
  }

  private buildTile(
    latitudeIndex: number,
    rawLongitudeIndex: number,
  ): TerrainTileGeometry {
    const cellOriginX = rawLongitudeIndex * TILE_CELLS;
    const cellOriginY = latitudeIndex * TILE_CELLS;
    const centreCellX = cellOriginX + TILE_CELLS / 2;
    const centreCellY = cellOriginY + TILE_CELLS / 2;
    const anchorGeodetic = latticeLocation(centreCellX, centreCellY);
    const heightsM = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
    let minHeightM = Number.POSITIVE_INFINITY;
    let maxHeightM = Number.NEGATIVE_INFINITY;
    let landSamples = 0;

    for (let j = 0; j < TILE_SAMPLES; j++) {
      for (let i = 0; i < TILE_SAMPLES; i++) {
        const location = latticeLocation(cellOriginX + i, cellOriginY + j);
        const heightM = Math.fround(
          this.sample(location.latitudeRad, location.longitudeRad).heightM,
        );
        const index = j * TILE_SAMPLES + i;
        heightsM[index] = heightM;
        minHeightM = Math.min(minHeightM, heightM);
        maxHeightM = Math.max(maxHeightM, heightM);
        if (heightM > 0) landSamples++;
      }
    }

    const canonicalLongitudeIndex = modulo(
      rawLongitudeIndex,
      LONGITUDE_TILE_COUNT,
    );
    const longitudeCycle = Math.floor(
      rawLongitudeIndex / LONGITUDE_TILE_COUNT,
    );
    const { northMPerRad } = metresPerRadian(anchorGeodetic.latitudeRad);
    const tile: TerrainTileGeometry = {
      key:
        `${this.sourceBuildId}/${latitudeIndex}/${canonicalLongitudeIndex}` +
        (longitudeCycle === 0 ? '' : `@${longitudeCycle}`),
      anchorGeodetic,
      anchorEcef: geodeticToEcef(
        anchorGeodetic.latitudeRad,
        anchorGeodetic.longitudeRad,
        0,
        vec3(),
      ),
      basisEcef: geographicBasisFromGeodetic(
        anchorGeodetic.latitudeRad,
        anchorGeodetic.longitudeRad,
        createGeographicBasis(),
      ),
      latticeOriginGeodetic: {
        latitudeRad: -HALF_PI,
        longitudeRad: -Math.PI,
      },
      latticeLatStepRad: SAMPLE_STEP_DEGREES * DEG_TO_RAD,
      latticeLonStepRad: SAMPLE_STEP_DEGREES * DEG_TO_RAD,
      cellOriginX,
      cellOriginY,
      spacingM: northMPerRad * SAMPLE_STEP_DEGREES * DEG_TO_RAD,
      samples: TILE_SAMPLES,
      heightsM,
      minHeightM,
      maxHeightM,
      // Sparse peak broadening is intentionally not an error-bounded DEM.
      geometricErrorM: 2_500,
      landFraction: landSamples / heightsM.length,
    };
    assertTerrainTileGeometry(tile);
    return tile;
  }
}

export const globalTerrainSource: GlobalTerrainSource =
  new NaturalEarthCoarseTerrainSource();

function assertStaticInputs(): void {
  if (coarseData.schemaVersion !== 1 || manifest.schemaVersion !== 1) {
    throw new Error('[terrain] unsupported coarse global data schema');
  }
  if (
    coarseData.coordinateQuantizationPerDegree !==
    manifest.derivedAsset.coordinateQuantizationPerDegree
  ) {
    throw new Error('[terrain] coarse coordinate quantization manifest mismatch');
  }
  if (
    coarseData.landShapes.length !== manifest.derivedAsset.landShapeCount ||
    coarseData.elevationPoints.length !==
      manifest.derivedAsset.elevationPointCount
  ) {
    throw new Error('[terrain] coarse source count manifest mismatch');
  }
  if (
    manifest.tileProfile.tileDegrees !== TILE_DEGREES ||
    manifest.tileProfile.samplesPerEdge !== TILE_SAMPLES ||
    manifest.tileProfile.neighbourhoodRadiusTiles !==
      NEIGHBOURHOOD_RADIUS_TILES ||
    manifest.tileProfile.waterFloorHeightM !== WATER_FLOOR_HEIGHT_M
  ) {
    throw new Error('[terrain] coarse tile-profile manifest mismatch');
  }
}

function assertCoastDistanceProfile(segmentCount: number): void {
  if (
    !manifest.runtimeRoles.includes('voyage_governor_presentation_distance') ||
    !manifest.runtimeRoles.includes('water_aware_world_panel_teleport') ||
    manifest.coastDistanceProfile.algorithm !== COAST_DISTANCE_ALGORITHM ||
    manifest.coastDistanceProfile.segmentCount !== segmentCount ||
    manifest.coastDistanceProfile.distanceRadius !==
      COAST_DISTANCE_RADIUS_POLICY ||
    manifest.coastDistanceProfile.landPolicy !== COAST_DISTANCE_LAND_POLICY ||
    manifest.coastDistanceProfile.purpose !== COAST_DISTANCE_PURPOSE
  ) {
    throw new Error('[terrain] coarse coast-distance manifest mismatch');
  }
}

function decodeLandShapes(): LandShape[] {
  const quantization = coarseData.coordinateQuantizationPerDegree;
  return coarseData.landShapes.map((encodedShape) => {
    const rings = encodedShape.rings.map((encodedRing): LandRing => {
      if (encodedRing.length < 8 || encodedRing.length % 2 !== 0) {
        throw new Error('[terrain] invalid Natural Earth land ring');
      }
      const coordinatesDeg = new Float64Array(encodedRing.length);
      let minLongitudeDeg = Number.POSITIVE_INFINITY;
      let minLatitudeDeg = Number.POSITIVE_INFINITY;
      let maxLongitudeDeg = Number.NEGATIVE_INFINITY;
      let maxLatitudeDeg = Number.NEGATIVE_INFINITY;
      for (let offset = 0; offset < encodedRing.length; offset += 2) {
        const longitudeDeg = encodedRing[offset] / quantization;
        const latitudeDeg = encodedRing[offset + 1] / quantization;
        coordinatesDeg[offset] = longitudeDeg;
        coordinatesDeg[offset + 1] = latitudeDeg;
        minLongitudeDeg = Math.min(minLongitudeDeg, longitudeDeg);
        minLatitudeDeg = Math.min(minLatitudeDeg, latitudeDeg);
        maxLongitudeDeg = Math.max(maxLongitudeDeg, longitudeDeg);
        maxLatitudeDeg = Math.max(maxLatitudeDeg, latitudeDeg);
      }
      return {
        coordinatesDeg,
        minLongitudeDeg,
        minLatitudeDeg,
        maxLongitudeDeg,
        maxLatitudeDeg,
      };
    });
    return {
      rings,
      minLongitudeDeg: Math.min(...rings.map((ring) => ring.minLongitudeDeg)),
      minLatitudeDeg: Math.min(...rings.map((ring) => ring.minLatitudeDeg)),
      maxLongitudeDeg: Math.max(...rings.map((ring) => ring.maxLongitudeDeg)),
      maxLatitudeDeg: Math.max(...rings.map((ring) => ring.maxLatitudeDeg)),
    };
  });
}

function buildCoastSegments(shapes: readonly LandShape[]): CoastSegment[] {
  const segments: CoastSegment[] = [];
  for (const shape of shapes) {
    for (const ring of shape.rings) {
      const pointCount = ring.coordinatesDeg.length / 2;
      let previous = sphericalUnitVector(
        ring.coordinatesDeg[(pointCount - 1) * 2 + 1],
        ring.coordinatesDeg[(pointCount - 1) * 2],
      );
      for (let currentIndex = 0; currentIndex < pointCount; currentIndex++) {
        const current = sphericalUnitVector(
          ring.coordinatesDeg[currentIndex * 2 + 1],
          ring.coordinatesDeg[currentIndex * 2],
        );
        const crossX = previous.y * current.z - previous.z * current.y;
        const crossY = previous.z * current.x - previous.x * current.z;
        const crossZ = previous.x * current.y - previous.y * current.x;
        const crossLength = Math.hypot(crossX, crossY, crossZ);
        const endpointDot = clampUnitDot(
          previous.x * current.x +
            previous.y * current.y +
            previous.z * current.z,
        );

        // Natural Earth rings close explicitly, and a few source paths repeat
        // a vertex. Neither creates a coast arc. Antipodal endpoints would be
        // ambiguous and are rejected rather than assigned an arbitrary plane.
        if (crossLength <= 1e-14) {
          if (endpointDot < 0) {
            throw new Error('[terrain] ambiguous antipodal coast segment');
          }
          previous = current;
          continue;
        }

        const nx = crossX / crossLength;
        const ny = crossY / crossLength;
        const nz = crossZ / crossLength;
        segments.push({
          ax: previous.x,
          ay: previous.y,
          az: previous.z,
          bx: current.x,
          by: current.y,
          bz: current.z,
          nx,
          ny,
          nz,
          startTangentX: ny * previous.z - nz * previous.y,
          startTangentY: nz * previous.x - nx * previous.z,
          startTangentZ: nx * previous.y - ny * previous.x,
          endTangentX: current.y * nz - current.z * ny,
          endTangentY: current.z * nx - current.x * nz,
          endTangentZ: current.x * ny - current.y * nx,
        });
        previous = current;
      }
    }
  }
  if (segments.length === 0) {
    throw new Error('[terrain] Natural Earth source has no coast segments');
  }
  return segments;
}

function sphericalUnitVector(
  latitudeDeg: number,
  longitudeDeg: number,
): { x: number; y: number; z: number } {
  const latitudeRad = latitudeDeg * DEG_TO_RAD;
  const longitudeRad = longitudeDeg * DEG_TO_RAD;
  const cosLatitude = Math.cos(latitudeRad);
  return {
    x: cosLatitude * Math.cos(longitudeRad),
    y: cosLatitude * Math.sin(longitudeRad),
    z: Math.sin(latitudeRad),
  };
}

function clampUnitDot(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function decodeReliefSeeds(): ReliefSeed[] {
  const quantization = coarseData.coordinateQuantizationPerDegree;
  return coarseData.elevationPoints.map((point) => {
    const elevationMagnitudeM = Math.abs(point.elevationM);
    return {
      latitudeRad: (point.latitudeQ / quantization) * DEG_TO_RAD,
      longitudeRad: (point.longitudeQ / quantization) * DEG_TO_RAD,
      elevationM: point.elevationM,
      // A sparse named extremum cannot reconstruct a range. This broad,
      // bounded envelope merely lets the globe communicate relief at its
      // cartographic scale; the manifest gives the algorithm a version and
      // explicitly denies DEM status.
      radiusRad:
        (350 + Math.min(950, elevationMagnitudeM * 0.11)) / 6_371,
    };
  });
}

function isNaturalEarthLand(
  latitudeDeg: number,
  longitudeDeg: number,
): boolean {
  for (const shape of landShapes) {
    if (
      latitudeDeg < shape.minLatitudeDeg ||
      latitudeDeg > shape.maxLatitudeDeg ||
      longitudeDeg < shape.minLongitudeDeg ||
      longitudeDeg > shape.maxLongitudeDeg
    ) {
      continue;
    }
    let insideShape = false;
    for (const ring of shape.rings) {
      if (
        latitudeDeg < ring.minLatitudeDeg ||
        latitudeDeg > ring.maxLatitudeDeg ||
        longitudeDeg < ring.minLongitudeDeg ||
        longitudeDeg > ring.maxLongitudeDeg
      ) {
        continue;
      }
      if (pointInRing(longitudeDeg, latitudeDeg, ring.coordinatesDeg)) {
        insideShape = !insideShape;
      }
    }
    if (insideShape) return true;
  }
  return false;
}

function pointInRing(
  longitudeDeg: number,
  latitudeDeg: number,
  coordinatesDeg: Float64Array,
): boolean {
  let inside = false;
  const pointCount = coordinatesDeg.length / 2;
  for (let current = 0, previous = pointCount - 1; current < pointCount; previous = current++) {
    const currentX = coordinatesDeg[current * 2];
    const currentY = coordinatesDeg[current * 2 + 1];
    const previousX = coordinatesDeg[previous * 2];
    const previousY = coordinatesDeg[previous * 2 + 1];

    if (
      pointOnSegment(
        longitudeDeg,
        latitudeDeg,
        previousX,
        previousY,
        currentX,
        currentY,
      )
    ) {
      return true;
    }
    const crosses =
      (currentY > latitudeDeg) !== (previousY > latitudeDeg) &&
      longitudeDeg <
        ((previousX - currentX) * (latitudeDeg - currentY)) /
          (previousY - currentY) +
          currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-10) return false;
  return (
    x >= Math.min(ax, bx) - 1e-10 &&
    x <= Math.max(ax, bx) + 1e-10 &&
    y >= Math.min(ay, by) - 1e-10 &&
    y <= Math.max(ay, by) + 1e-10
  );
}

function visualLandHeightM(latitudeRad: number, longitudeRad: number): number {
  let positiveReliefM = 0;
  let negativeReliefM = 0;
  for (const seed of reliefSeeds) {
    const distanceRad = angularDistanceRad(
      latitudeRad,
      longitudeRad,
      seed.latitudeRad,
      seed.longitudeRad,
    );
    const normalizedDistance = distanceRad / seed.radiusRad;
    if (normalizedDistance >= 1) continue;
    const smooth = 1 - normalizedDistance * normalizedDistance;
    const contributionM = seed.elevationM * smooth * smooth;
    if (contributionM >= 0) {
      positiveReliefM = Math.max(positiveReliefM, contributionM);
    } else {
      negativeReliefM = Math.min(negativeReliefM, contributionM);
    }
  }
  return Math.max(
    2,
    DEFAULT_LAND_HEIGHT_M +
      (positiveReliefM + negativeReliefM) * RELIEF_HEIGHT_SCALE,
  );
}

function angularDistanceRad(
  latitudeARad: number,
  longitudeARad: number,
  latitudeBRad: number,
  longitudeBRad: number,
): number {
  const deltaLatitude = latitudeBRad - latitudeARad;
  const deltaLongitude = wrapLongitudeRad(longitudeBRad - longitudeARad);
  const sinHalfLatitude = Math.sin(deltaLatitude / 2);
  const sinHalfLongitude = Math.sin(deltaLongitude / 2);
  const haversine =
    sinHalfLatitude * sinHalfLatitude +
    Math.cos(latitudeARad) *
      Math.cos(latitudeBRad) *
      sinHalfLongitude *
      sinHalfLongitude;
  return 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

function locationTileIndices(
  latitudeRad: number,
  longitudeRad: number,
): { latitudeIndex: number; longitudeIndex: number } {
  const location = normalizeLocation(latitudeRad, longitudeRad);
  const latitudeDeg = location.latitudeRad * RAD_TO_DEG;
  const longitudeDeg = location.longitudeRad * RAD_TO_DEG;
  return {
    latitudeIndex: clampInteger(
      Math.floor((latitudeDeg + 90) / TILE_DEGREES),
      0,
      LATITUDE_TILE_COUNT - 1,
    ),
    longitudeIndex: modulo(
      Math.floor((longitudeDeg + 180) / TILE_DEGREES),
      LONGITUDE_TILE_COUNT,
    ),
  };
}

function latticeLocation(
  globalCellX: number,
  globalCellY: number,
): { latitudeRad: number; longitudeRad: number } {
  return {
    latitudeRad: (-90 + globalCellY * SAMPLE_STEP_DEGREES) * DEG_TO_RAD,
    longitudeRad: wrapLongitudeRad(
      (-180 + globalCellX * SAMPLE_STEP_DEGREES) * DEG_TO_RAD,
    ),
  };
}

function normalizeLocation(
  latitudeRad: number,
  longitudeRad: number,
): { latitudeRad: number; longitudeRad: number } {
  if (!Number.isFinite(latitudeRad) || !Number.isFinite(longitudeRad)) {
    throw new RangeError('terrain latitude and longitude must be finite');
  }
  if (latitudeRad < -HALF_PI || latitudeRad > HALF_PI) {
    throw new RangeError('terrain latitudeRad must be in [-pi/2, pi/2]');
  }
  const atPole = Math.abs(Math.abs(latitudeRad) - HALF_PI) <= 4 * Number.EPSILON;
  return {
    latitudeRad,
    // Longitude is a gauge at an exact pole, matching world/wgs84.ts.
    longitudeRad: atPole ? 0 : wrapLongitudeRad(longitudeRad),
  };
}

function modulo(value: number, divisor: number): number {
  const result = value % divisor;
  return result < 0 ? result + divisor : result;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
