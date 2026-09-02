import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { syntheticTileSource } from '../src/terrain/syntheticFixtures';
import type { TerrainTileGeometry } from '../src/terrain/TerrainTile';
import { buildTerrainTileGeometry } from '../src/terrain/TerrainTileMesh';
import { TerrainSystem } from '../src/terrain/TerrainSystem';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import { createWorldPbrMaterial } from '../src/scene/WorldPbrMaterial';

function flatTileAt(heightM: number): TerrainTileGeometry {
  const source = syntheticTileSource.tilesFor('headland')[0];
  return {
    ...source,
    key: `test/flat/${heightM}`,
    cellOriginX: 0,
    cellOriginY: 0,
    spacingM: 1,
    samples: 2,
    heightsM: new Float32Array([heightM, heightM, heightM, heightM]),
    minHeightM: heightM,
    maxHeightM: heightM,
    landFraction: heightM > 0 ? 1 : 0,
  };
}

function firstVertexColour(heightM: number): THREE.Color {
  const geometry = buildTerrainTileGeometry(flatTileAt(heightM), () => heightM);
  const attribute = geometry.getAttribute('color');
  const colour = new THREE.Color(
    attribute.getX(0),
    attribute.getY(0),
    attribute.getZ(0),
  );
  geometry.dispose();
  return colour;
}

describe('terrain tile material colours', () => {
  it.each([
    { name: 'sea floor', heightM: -10, srgb: [0.16, 0.2, 0.18] },
    { name: 'wet sand', heightM: 1, srgb: [0.38, 0.31, 0.2] },
    { name: 'vegetation', heightM: 10, srgb: [0.07, 0.17, 0.04] },
  ])('stores the authored $name colour as linear reflectance', ({ heightM, srgb }) => {
    const expected = new THREE.Color().setRGB(
      srgb[0],
      srgb[1],
      srgb[2],
      THREE.SRGBColorSpace,
    );
    const actual = firstVertexColour(heightM);
    expect(actual.r).toBeCloseTo(expected.r, 7);
    expect(actual.g).toBeCloseTo(expected.g, 7);
    expect(actual.b).toBeCloseTo(expected.b, 7);
  });

  it('keeps the green terrain below the direct-light clipping input that caused white noon land', () => {
    const vegetation = firstVertexColour(10);
    expect(Math.max(vegetation.r, vegetation.g, vegetation.b)).toBeLessThan(0.1);
  });
});

/**
 * TERR-132, and a correction to how the round has been describing it.
 *
 * The handover records "terrain colour/shading is deliberate scaffolding" and
 * files slope lighting as unstarted. Half of that is right and half is not:
 * the PALETTE is scaffolding — four flat anchors chosen to read a silhouette,
 * and R2 materials own it. The LIGHTING is not scaffolding at all. Terrain is
 * built on the shared world PBR material, so it receives the same Sun, Moon,
 * sky probe and exposure as the hull, and its normals are real slope normals
 * taken across the fixture-wide lattice rather than a face-flat approximation.
 *
 * That is TERR-132's acceptance — "terrain responds consistently to real Sun,
 * Moon and sky lighting" — so what it needed was a check, not a build. These
 * are the two claims it rests on, and both are the sort that fail silently: a
 * sign slip in the gradient lights the wrong faces, and a normal that stops at
 * a tile edge seams the lighting where the geometry does not crack.
 */
describe('terrain slope lighting (TERR-132)', () => {
  const tiles = syntheticTileSource.tilesFor('mountain');
  const heightAtCell = (() => {
    const heights = new Map<string, number>();
    for (const tile of tiles) {
      for (let j = 0; j < tile.samples; j++) {
        for (let i = 0; i < tile.samples; i++) {
          heights.set(
            `${tile.cellOriginX + i}/${tile.cellOriginY + j}`,
            tile.heightsM[j * tile.samples + i],
          );
        }
      }
    }
    return (x: number, y: number) => heights.get(`${x}/${y}`);
  })();

  it('takes its normals from the surface, not from the height array', () => {
    // Compared against the mesh's own triangles: an independent witness. A
    // gradient computed with the wrong sign or the wrong axis still produces a
    // unit vector and still shades — just not the face it is standing on.
    const tile = tiles[4];
    const geometry = buildTerrainTileGeometry(tile, heightAtCell);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');

    const at = (i: number, j: number, out: THREE.Vector3) =>
      out.fromBufferAttribute(position, j * tile.samples + i);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const d = new THREE.Vector3();
    const faceA = new THREE.Vector3();
    const faceB = new THREE.Vector3();
    const geometric = new THREE.Vector3();
    const stored = new THREE.Vector3();

    let worstDegrees = 0;
    let checked = 0;
    for (let j = 8; j < tile.samples - 8; j += 11) {
      for (let i = 8; i < tile.samples - 8; i += 11) {
        at(i, j, a);
        at(i + 1, j, b);
        at(i, j + 1, c);
        at(i - 1, j, d);
        // Two of the four triangles that meet at this vertex; their average is
        // the surface's own normal at the sample.
        faceA.copy(b).sub(a).cross(c.clone().sub(a)).normalize();
        faceB.copy(c).sub(a).cross(d.clone().sub(a)).normalize();
        geometric.copy(faceA).add(faceB).normalize();
        stored.fromBufferAttribute(normal, j * tile.samples + i);
        expect(stored.length()).toBeCloseTo(1, 6);
        // Up, always: a flipped normal turns a sunlit hillside black.
        expect(stored.y).toBeGreaterThan(0);
        worstDegrees = Math.max(
          worstDegrees,
          (Math.acos(Math.min(1, Math.abs(stored.dot(geometric)))) * 180) /
            Math.PI,
        );
        // The same hemisphere, not merely the same axis.
        expect(stored.dot(geometric)).toBeGreaterThan(0.9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80);
    // Central differences against a face average over a curved surface: a few
    // degrees is the discretisation, not a disagreement.
    expect(worstDegrees).toBeLessThan(6);
    geometry.dispose();
  });

  it('gives both sides of a shared tile edge the identical normal', () => {
    // Bit-identical, not merely close: lighting seams are visible at a
    // hundredth of a degree, and the fixture-wide lattice lookup exists to
    // make the two sides compute the same doubles rather than similar ones.
    const built = tiles.map((tile) => ({
      tile,
      geometry: buildTerrainTileGeometry(tile, heightAtCell),
    }));
    const seen = new Map<string, [number, number, number]>();
    let shared = 0;
    for (const { tile, geometry } of built) {
      const normal = geometry.getAttribute('normal');
      for (let j = 0; j < tile.samples; j++) {
        for (let i = 0; i < tile.samples; i++) {
          const key = `${tile.cellOriginX + i}/${tile.cellOriginY + j}`;
          const index = j * tile.samples + i;
          const value: [number, number, number] = [
            normal.getX(index),
            normal.getY(index),
            normal.getZ(index),
          ];
          const previous = seen.get(key);
          if (!previous) {
            seen.set(key, value);
            continue;
          }
          shared++;
          expect(value, key).toEqual(previous);
        }
      }
    }
    // The mountain is 3 x 3 tiles: twelve shared edges of 129 samples, with
    // the four interior corners counted three times over.
    expect(shared).toBeGreaterThan(1_500);
    for (const { geometry } of built) geometry.dispose();
  });

  it('lights terrain through the same material path as the hull', () => {
    // Not "a standard material" — the WORLD one. `skyVisibility` in userData is
    // WorldPbrMaterial's own marker, and it is what carries the sky probe, the
    // Moon and the shared exposure onto a surface.
    const scene = new THREE.Scene();
    const system = new TerrainSystem(scene, new WorldRenderAdapter(), {
      skyRadianceLut: new THREE.Texture(),
    });
    system.loadTiles([tiles[0]]);
    const mesh = system.group.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;

    const reference = createWorldPbrMaterial({ name: 'reference' });
    expect(material.type).toBe(reference.type);
    expect(material.userData.skyVisibility).toBeDefined();
    // Vertex colours are the palette, and the palette is the scaffolding half.
    expect(material.vertexColors).toBe(true);
    // The haze injection must keep its own program, or the vessel's materials
    // compile with terrain's fragment code.
    expect(material.customProgramCacheKey()).not.toBe(
      reference.customProgramCacheKey(),
    );
    expect(material.customProgramCacheKey()).toContain('terrain-haze');

    system.dispose();
  });
});
