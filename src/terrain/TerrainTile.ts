import type { Vec3d } from '../world/math';
import type { GeographicBasis } from '../world/wgs84';

/**
 * Experimental R1 terrain tile contract (TERR-100).
 *
 * Deliberately ignorant of cube-sphere versus geographic addressing: the key
 * is opaque and the renderer consumes only geometry. What the contract does
 * fix is how sample positions are derived, because two tiles that disagree
 * about a shared edge by even a metre produce a visible crack:
 *
 * - every sample sits on a fixture-wide geodetic lattice
 *   (`latticeOriginGeodetic` plus integer multiples of the lattice steps),
 *   so adjacent tiles evaluate the *same doubles* for shared-edge samples
 *   rather than each linearising the geodesy around its own anchor;
 * - heights displace along the geodetic normal at the sample, per design
 *   §5.1;
 * - rendering reconstructs each sample as `anchorEcef + basis · localOffset`
 *   with the offsets computed once in double precision
 *   (terrainMath.tileSampleLocalOffset) and stored as Float32 — six-million-
 *   metre absolute positions never reach the GPU.
 *
 * The production tile schema chosen at Gate A may replace the lattice fields
 * wholesale; the renderer-facing shape (anchor, basis, offsets, bounds) is
 * the part expected to survive.
 */
export type TerrainTileKey = string;

export interface TerrainTileGeometry {
  key: TerrainTileKey;
  /** Geodetic position of the tile's centre sample at height zero. */
  anchorGeodetic: { latitudeRad: number; longitudeRad: number };
  /** ECEF of the anchor, double precision, computed from the lattice. */
  anchorEcef: Vec3d;
  /** East/north/up at the anchor; tile-local axes are X=east, Y=up, Z=south. */
  basisEcef: GeographicBasis;
  /** Fixture-wide lattice reference (height-zero geodetic origin). */
  latticeOriginGeodetic: { latitudeRad: number; longitudeRad: number };
  /** Radians of latitude per lattice row, uniform across the fixture. */
  latticeLatStepRad: number;
  /** Radians of longitude per lattice column, uniform across the fixture. */
  latticeLonStepRad: number;
  /** Integer lattice coordinates of this tile's (i=0, j=0) sample. */
  cellOriginX: number;
  cellOriginY: number;
  /** Nominal metres between samples at the fixture origin latitude. */
  spacingM: number;
  /** Samples per edge; 2^n + 1 so neighbours can share edges exactly. */
  samples: number;
  /** Row-major geodetic-normal displacement per sample, metres. */
  heightsM: Float32Array;
  minHeightM: number;
  maxHeightM: number;
  /** Zero for full-resolution synthetic fixtures. */
  geometricErrorM: number;
  /** Fraction of samples above height zero. */
  landFraction: number;
}

export interface TerrainTileSource {
  tilesFor(fixtureId: string): TerrainTileGeometry[];
}

/**
 * Runtime-facing provider for location-addressed terrain.
 *
 * The renderer still consumes the same geometry-only tile contract above.
 * Addressing remains outside `TerrainSystem`: a provider gives it one stable
 * location key and materialises tiles only when that key changes. A later
 * cube-sphere/GLO-30 provider can therefore replace the coarse geographic
 * source without changing mesh construction or the anchored render boundary.
 */
export interface TerrainTileProvider {
  readonly sourceBuildId: string;
  locationKey(latitudeRad: number, longitudeRad: number): string;
  tilesAt(latitudeRad: number, longitudeRad: number): TerrainTileGeometry[];
}

/** Structural invariants; fixture generators and decoders both assert them. */
export function assertTerrainTileGeometry(tile: TerrainTileGeometry): void {
  const edge = tile.samples - 1;
  if (edge < 2 || (edge & (edge - 1)) !== 0) {
    throw new Error(`samples must be 2^n + 1, got ${tile.samples}`);
  }
  if (tile.heightsM.length !== tile.samples * tile.samples) {
    throw new Error(
      `heights length ${tile.heightsM.length} != samples^2 ${tile.samples ** 2}`,
    );
  }
  if (!(tile.minHeightM <= tile.maxHeightM)) {
    throw new Error('minHeightM must not exceed maxHeightM');
  }
  if (!(tile.landFraction >= 0 && tile.landFraction <= 1)) {
    throw new Error('landFraction must be in [0, 1]');
  }
  if (!(tile.spacingM > 0) || !Number.isFinite(tile.spacingM)) {
    throw new Error('spacingM must be positive and finite');
  }
  if (
    !Number.isInteger(tile.cellOriginX) ||
    !Number.isInteger(tile.cellOriginY)
  ) {
    throw new Error('cell origins must be integers');
  }
}
