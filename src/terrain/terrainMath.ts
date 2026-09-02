import { setVec3, vec3, type Vec3d } from '../world/math';
import {
  WGS84_ECCENTRICITY_SQUARED,
  WGS84_SEMI_MAJOR_M,
  geodeticToEcef,
  wrapLongitudeRad,
} from '../world/wgs84';
import type { TerrainTileGeometry } from './TerrainTile';

/**
 * Pure double-precision terrain math (TERR-100/102). Everything here is the
 * one shared definition of "where a sample is": the fixture generator, the
 * mesh builder and the numerical tests all call these, so a disagreement is
 * impossible rather than merely unlikely.
 */

/**
 * Metres of ground per radian at a latitude: meridional (north) and
 * prime-vertical-times-cos (east). Used once per fixture to choose lattice
 * steps; runtime code never rederives geodesy from these.
 */
export function metresPerRadian(latitudeRad: number): {
  northMPerRad: number;
  eastMPerRad: number;
} {
  const sinLat = Math.sin(latitudeRad);
  const w2 = 1 - WGS84_ECCENTRICITY_SQUARED * sinLat * sinLat;
  const w = Math.sqrt(w2);
  const primeVertical = WGS84_SEMI_MAJOR_M / w;
  const meridional =
    (WGS84_SEMI_MAJOR_M * (1 - WGS84_ECCENTRICITY_SQUARED)) / (w2 * w);
  return {
    northMPerRad: meridional,
    eastMPerRad: primeVertical * Math.cos(latitudeRad),
  };
}

/**
 * Geodetic coordinates of lattice cell (cellX, cellY). The formula is the
 * shared-edge contract: origin plus integer times step, in this order, so
 * two tiles quoting the same cell compute bit-identical doubles.
 */
export function latticeCellGeodetic(
  tile: Pick<
    TerrainTileGeometry,
    | 'latticeOriginGeodetic'
    | 'latticeLatStepRad'
    | 'latticeLonStepRad'
  >,
  cellX: number,
  cellY: number,
): { latitudeRad: number; longitudeRad: number } {
  return {
    latitudeRad:
      tile.latticeOriginGeodetic.latitudeRad + cellY * tile.latticeLatStepRad,
    longitudeRad: wrapLongitudeRad(
      tile.latticeOriginGeodetic.longitudeRad + cellX * tile.latticeLonStepRad,
    ),
  };
}

/** Double-precision ECEF of tile sample (i, j) at its stored height. */
export function tileSampleEcef(
  tile: TerrainTileGeometry,
  i: number,
  j: number,
  out: Vec3d,
): Vec3d {
  const geodetic = latticeCellGeodetic(
    tile,
    tile.cellOriginX + i,
    tile.cellOriginY + j,
  );
  return geodeticToEcef(
    geodetic.latitudeRad,
    geodetic.longitudeRad,
    tile.heightsM[j * tile.samples + i],
    out,
  );
}

/**
 * Tile-local offset of sample (i, j): the double-precision ECEF delta from
 * the anchor, expressed in the tile basis as X=east, Y=up, Z=south (a
 * right-handed frame matching Three's y-up convention). These are what a
 * mesh builder rounds to Float32 vertex positions; planetary curvature
 * appears here naturally as Y falling away with distance from the anchor.
 */
export function tileSampleLocalOffset(
  tile: TerrainTileGeometry,
  i: number,
  j: number,
  out: Vec3d,
  scratch: Vec3d = vec3(),
): Vec3d {
  const sample = tileSampleEcef(tile, i, j, scratch);
  const dx = sample.x - tile.anchorEcef.x;
  const dy = sample.y - tile.anchorEcef.y;
  const dz = sample.z - tile.anchorEcef.z;
  const { east, north, up } = tile.basisEcef;
  return setVec3(
    out,
    dx * east.x + dy * east.y + dz * east.z,
    dx * up.x + dy * up.y + dz * up.z,
    -(dx * north.x + dy * north.y + dz * north.z),
  );
}
