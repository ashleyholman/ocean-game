import * as THREE from 'three';
import { vec3 } from '../world/math';
import type { TerrainTileGeometry } from './TerrainTile';
import { tileSampleLocalOffset } from './terrainMath';

interface LinearRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Terrain colours are authored as ordinary display/sRGB values, like the
 * schooner's hex palettes. Buffer attributes, however, enter three's lighting
 * equations directly in the linear working space. Convert the four palette
 * anchors once here rather than treating display code values as reflectance —
 * that mistake made the vegetation green 3.6–7.3x too energetic and noon sun
 * drove the whole fixture into the tone mapper's white highlight bleach.
 */
function linearPaletteColour(r: number, g: number, b: number): LinearRgb {
  const colour = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
  return { r: colour.r, g: colour.g, b: colour.b };
}

const TERRAIN_PALETTE = {
  seaFloor: linearPaletteColour(0.16, 0.2, 0.18),
  wetSand: linearPaletteColour(0.38, 0.31, 0.2),
  // Full noon sun contributes roughly three display-referred multiples on an
  // upward face. These anchors therefore describe the ground itself, not the
  // desired finished pixel: a deep coastal green and dark weathered rock that
  // the shared daylight can lift without washing either toward pastel.
  vegetation: linearPaletteColour(0.07, 0.17, 0.04),
  rock: linearPaletteColour(0.23, 0.21, 0.19),
} as const;

/**
 * Builds the static GPU geometry for one terrain tile (TERR-103).
 *
 * Vertices are Float32 tile-local offsets from the tile's double-precision
 * ECEF anchor — the anchoredTileMatrix moves them into the render frame each
 * frame, so this geometry is built exactly once and never touched again.
 *
 * Normals come from central differences over the fixture-wide cell lattice
 * via `heightAtCell`, which can see across tile borders. Both sides of a
 * shared edge therefore compute identical normals and lighting cannot seam
 * where geometry does not crack (design §5.2). Outside the fixture the
 * lookup fails and differences fall back to one-sided — that boundary is on
 * the −60 m sea floor where nobody will ever see it.
 */
export function buildTerrainTileGeometry(
  tile: TerrainTileGeometry,
  heightAtCell: (cellX: number, cellY: number) => number | undefined,
): THREE.BufferGeometry {
  const n = tile.samples;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const local = vec3();

  const heightOrClamped = (cellX: number, cellY: number, fallback: number): number => {
    const h = heightAtCell(cellX, cellY);
    return h === undefined ? fallback : h;
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const index = j * n + i;
      tileSampleLocalOffset(tile, i, j, local);
      positions[index * 3] = Math.fround(local.x);
      positions[index * 3 + 1] = Math.fround(local.y);
      positions[index * 3 + 2] = Math.fround(local.z);

      const cellX = tile.cellOriginX + i;
      const cellY = tile.cellOriginY + j;
      const h = tile.heightsM[index];
      const east = heightOrClamped(cellX + 1, cellY, h);
      const west = heightOrClamped(cellX - 1, cellY, h);
      const north = heightOrClamped(cellX, cellY + 1, h);
      const south = heightOrClamped(cellX, cellY - 1, h);
      // Tile-local axes are X=east, Y=up, Z=south; tangents (1, dh/du, 0)
      // and (0, dh/dv, -1) cross to (-dh/du, 1, dh/dv) before normalising.
      const du = (east - west) / (2 * tile.spacingM);
      const dv = (north - south) / (2 * tile.spacingM);
      const inverseLength = 1 / Math.sqrt(du * du + 1 + dv * dv);
      normals[index * 3] = -du * inverseLength;
      normals[index * 3 + 1] = inverseLength;
      normals[index * 3 + 2] = dv * inverseLength;

      writeHeightColor(colors, index * 3, h, du, dv);
    }
  }

  const cells = n - 1;
  const indices = new Uint32Array(cells * cells * 6);
  let cursor = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = d;
      indices[cursor++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Crude but legible height/slope palette for the spike: wet sand at the
 * waterline, vegetation-mass green on gentle low ground, grey rock on steep
 * or high ground, dark sea floor below. This is scaffolding for judging
 * silhouettes and coastlines, not the R2 material pass.
 */
function writeHeightColor(
  colors: Float32Array,
  offset: number,
  heightM: number,
  du: number,
  dv: number,
): void {
  const slope = Math.sqrt(du * du + dv * dv);
  let r: number;
  let g: number;
  let b: number;
  if (heightM <= 0) {
    ({ r, g, b } = TERRAIN_PALETTE.seaFloor);
  } else if (heightM < 3) {
    ({ r, g, b } = TERRAIN_PALETTE.wetSand);
  } else {
    const rockiness = Math.min(1, slope * 1.6 + Math.max(0, heightM - 500) / 2000);
    const vegetation = TERRAIN_PALETTE.vegetation;
    const rock = TERRAIN_PALETTE.rock;
    r = vegetation.r + (rock.r - vegetation.r) * rockiness;
    g = vegetation.g + (rock.g - vegetation.g) * rockiness;
    b = vegetation.b + (rock.b - vegetation.b) * rockiness;
  }
  colors[offset] = r;
  colors[offset + 1] = g;
  colors[offset + 2] = b;
}
