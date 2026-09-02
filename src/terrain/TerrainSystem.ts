import * as THREE from 'three';
import type { GpuPassProfiler } from '../render/GpuProfiler';
import { CLEAR_DEEP_OCEAN } from '../scene/oceanOptics';
import { GLSL_SKY_RADIANCE_LUT_UV } from '../scene/shaders/lib';
import { createWorldPbrMaterial } from '../scene/WorldPbrMaterial';
import type { WorldRenderAdapter } from '../scene/WorldRenderAdapter';
import type { CanonicalWorldState } from '../world/types';
import { ecefToGeodetic } from '../world/wgs84';
import type {
  TerrainTileGeometry,
  TerrainTileProvider,
} from './TerrainTile';
import { buildTerrainTileGeometry } from './TerrainTileMesh';
import {
  getTerrainDrawOrder,
  onTerrainDrawOrderChange,
  terrainRenderOrderFor,
  type TerrainDrawOrder,
} from './terrainDrawOrder';

/**
 * What the terrain currently costs, in the units a budget is written in
 * (TERR-134). GPU milliseconds are the profiler's `terrain` bucket; these are
 * the residency numbers that explain it.
 */
export interface TerrainSystemStats {
  tiles: number;
  triangles: number;
  vertices: number;
  /**
   * Bytes of vertex and index attribute data resident on the GPU.
   *
   * Counted from the typed arrays actually uploaded — position, normal and
   * colour at three Float32 each, plus a Uint32 index per corner — rather than
   * from a nominal tile size, because the two diverge the moment a fixture
   * changes its sample count.
   */
  geometryBytes: number;
  /** Which side of the sea the tiles are submitted on (TERR-131). */
  drawOrder: TerrainDrawOrder;
  renderOrder: number;
  /** Null for manually loaded synthetic fixtures. */
  sourceBuildId: string | null;
  /** Provider location currently resident; null until the first update. */
  residentLocationKey: string | null;
}

export interface TerrainSystemOptions {
  /**
   * The frame's equirectangular linear-HDR gas-sky radiance
   * (SkySystem.radianceLut.texture). Terrain hazes toward the same sky the
   * ocean hazes toward, sampled with the same mapping, so land and sea agree
   * at the horizon instead of meeting in two different atmospheres.
   */
  skyRadianceLut: THREE.Texture;
  /**
   * Clear-air extinction length in metres. Defaults to the ocean's own
   * optical profile so one constant governs both; a later weather system
   * replaces the constant, not the architecture (design §8.2).
   */
  hazeDistanceM?: number;
  /**
   * Optional profiler, for the terrain GPU bucket (TERR-134).
   *
   * Every tile announces the bucket's leading edge from its own
   * `onBeforeRender`; `endPass` is idempotent within a frame, so the first tile
   * to draw sets the boundary and the rest cost a comparison. Which tile that
   * is depends on three's own depth sort and does not need to be known.
   */
  profiler?: GpuPassProfiler;
  /**
   * Optional location-addressed source. It is sampled from canonical world
   * position in `update`, so teleports and ordinary travel have one authority
   * and no second mutable latitude/longitude state.
   */
  tileProvider?: TerrainTileProvider;
}

/**
 * Terrain orchestration boundary (design §5.3).
 *
 * Owns the tile meshes and nothing else: it reads canonical world state to
 * refresh each tile's anchored matrix at render time and never advances
 * world time or moves the vessel. Synthetic R1 fixtures can still be loaded
 * manually; the coarse global slice instead supplies an optional provider
 * whose location is derived from that same canonical state.
 *
 * Lighting comes from the shared world PBR path — WorldPbrMaterial's header
 * is explicit that every solid non-sea, non-sky surface must — with one
 * terrain addition layered on top: distance haze toward the sky radiance
 * LUT, using the ocean's extinction form `exp(-d / hazeDistance)` (TERR-133).
 */
export class TerrainSystem {
  readonly group = new THREE.Group();
  private readonly meshes: Array<{
    tile: TerrainTileGeometry;
    mesh: THREE.Mesh;
  }> = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly hazeDistanceUniform: { value: number };
  private readonly profiler: GpuPassProfiler | undefined;
  private readonly tileProvider: TerrainTileProvider | undefined;
  private readonly unsubscribeDrawOrder: () => void;
  private triangleCount = 0;
  private vertexCount = 0;
  private geometryByteCount = 0;
  private renderOrderValue = terrainRenderOrderFor(getTerrainDrawOrder());
  private residentLocationKey: string | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly adapter: WorldRenderAdapter,
    options: TerrainSystemOptions,
  ) {
    this.group.name = 'terrain-experimental';
    this.profiler = options.profiler;
    this.tileProvider = options.tileProvider;
    this.hazeDistanceUniform = {
      value: options.hazeDistanceM ?? CLEAR_DEEP_OCEAN.hazeDistanceM,
    };
    this.material = createTerrainMaterial(
      options.skyRadianceLut,
      this.hazeDistanceUniform,
    );
    scene.add(this.group);
    // Fires immediately with the current arm, so tiles loaded later and tiles
    // already resident are placed by the same one line.
    this.unsubscribeDrawOrder = onTerrainDrawOrderChange((order) => {
      this.renderOrderValue = terrainRenderOrderFor(order);
      for (const entry of this.meshes) {
        entry.mesh.renderOrder = this.renderOrderValue;
      }
    });
  }

  /** The design's small visibility-distance input for later weather. */
  setHazeDistance(metres: number): void {
    this.hazeDistanceUniform.value = Math.max(1, metres);
  }

  /** Current terrain-only extinction length, for live tuning readback. */
  get hazeDistanceM(): number {
    return this.hazeDistanceUniform.value;
  }

  /** Replace resident tiles with a fixture's tiles. Build cost is one-off. */
  loadTiles(tiles: TerrainTileGeometry[]): void {
    // A manual fixture is an explicit override. If this system also has a
    // provider, its next canonical update will re-establish provider terrain.
    this.residentLocationKey = null;
    this.replaceTiles(tiles);
  }

  private replaceTiles(tiles: TerrainTileGeometry[]): void {
    this.clear();
    // The fixture-wide cell lookup that lets normals see across tile edges.
    const cellHeights = new Map<string, number>();
    for (const tile of tiles) {
      for (let j = 0; j < tile.samples; j++) {
        for (let i = 0; i < tile.samples; i++) {
          cellHeights.set(
            `${tile.cellOriginX + i}/${tile.cellOriginY + j}`,
            tile.heightsM[j * tile.samples + i],
          );
        }
      }
    }
    const heightAtCell = (cellX: number, cellY: number): number | undefined =>
      cellHeights.get(`${cellX}/${cellY}`);

    for (const tile of tiles) {
      const geometry = buildTerrainTileGeometry(tile, heightAtCell);
      const mesh = new THREE.Mesh(geometry, this.material);
      // The anchored matrix is authoritative; three must not recompose it
      // from position/quaternion/scale it knows nothing about.
      mesh.matrixAutoUpdate = false;
      mesh.name = tile.key;
      mesh.renderOrder = this.renderOrderValue;
      if (this.profiler) {
        const profiler = this.profiler;
        mesh.onBeforeRender = () => profiler.endPass('sceneOpaque');
      }
      this.group.add(mesh);
      this.meshes.push({ tile, mesh });
      this.triangleCount += (tile.samples - 1) ** 2 * 2;
      this.vertexCount += tile.samples ** 2;
      this.geometryByteCount += geometryBytes(geometry);
    }
  }

  /** Refresh every tile's render-frame matrix from canonical state. */
  update(state: Readonly<CanonicalWorldState>): void {
    if (this.tileProvider) {
      const location = ecefToGeodetic(state.positionEcefM, {
        latitudeRad: 0,
        longitudeRad: 0,
        heightM: 0,
      });
      const locationKey = this.tileProvider.locationKey(
        location.latitudeRad,
        location.longitudeRad,
      );
      if (locationKey !== this.residentLocationKey) {
        // Materialise before clearing so a provider failure leaves the last
        // coherent resident set intact rather than punching a terrain hole.
        const tiles = this.tileProvider.tilesAt(
          location.latitudeRad,
          location.longitudeRad,
        );
        this.replaceTiles(tiles);
        this.residentLocationKey = locationKey;
      }
    }
    for (const entry of this.meshes) {
      this.adapter.anchoredTileMatrix(state, entry.tile, entry.mesh.matrix);
      entry.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  get stats(): TerrainSystemStats {
    return {
      tiles: this.meshes.length,
      triangles: this.triangleCount,
      vertices: this.vertexCount,
      geometryBytes: this.geometryByteCount,
      drawOrder: getTerrainDrawOrder(),
      renderOrder: this.renderOrderValue,
      sourceBuildId: this.tileProvider?.sourceBuildId ?? null,
      residentLocationKey: this.residentLocationKey,
    };
  }

  private clear(): void {
    for (const entry of this.meshes) {
      this.group.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    this.meshes.length = 0;
    this.triangleCount = 0;
    this.vertexCount = 0;
    this.geometryByteCount = 0;
  }

  dispose(): void {
    this.unsubscribeDrawOrder();
    this.clear();
    this.material.dispose();
    this.scene.remove(this.group);
  }
}

/** Resident attribute and index bytes of one built tile geometry. */
function geometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    const array = (attribute as THREE.BufferAttribute).array;
    bytes += array.byteLength;
  }
  const index = geometry.getIndex();
  if (index) bytes += index.array.byteLength;
  return bytes;
}

/**
 * World-lit terrain with distance haze layered on. The haze injection chains
 * after WorldPbrMaterial's own shader surgery and splits the program cache
 * key so the vessel's materials keep their unhazed program.
 *
 * The LUT UV mapping must stay identical to Ocean.ts's skyRadianceLutUv —
 * both sample the same texture in the same render frame, and a divergence
 * here would put two different skies on either side of the waterline.
 */
function createTerrainMaterial(
  skyRadianceLut: THREE.Texture,
  hazeDistance: { value: number },
): THREE.MeshStandardMaterial {
  const material = createWorldPbrMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    name: 'terrain:experimental',
  });
  const worldCompile = material.onBeforeCompile;
  const worldKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    worldCompile(shader, renderer);
    shader.uniforms.uTerrainSkyLut = { value: skyRadianceLut };
    shader.uniforms.uTerrainHazeDistance = hazeDistance;
    shader.vertexShader =
      'varying vec3 vTerrainWorldPos;\n' +
      shader.vertexShader.replace(
        '#include <fog_vertex>',
        '#include <fog_vertex>\n' +
          '  vTerrainWorldPos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;',
      );
    shader.fragmentShader =
      'varying vec3 vTerrainWorldPos;\n' +
      'uniform sampler2D uTerrainSkyLut;\n' +
      'uniform float uTerrainHazeDistance;\n' +
      // The azimuth/elevation mapping is the OCEAN'S, imported rather than
      // retyped: land and sea sample one texture in one frame, and a copy that
      // drifts by a texel row puts two different skies on either side of the
      // waterline. That was a comment asking for care; it is now an import.
      GLSL_SKY_RADIANCE_LUT_UV +
      'vec2 terrainSkyLutUv(vec3 direction) {\n' +
      '  vec2 uv = skyRadianceLutUv(direction);\n' +
      // Terrain haze rays run within a degree of horizontal, and the LUT's
      // below-horizon rows carry the gas model's saturated long-path colour;
      // bilinear at the horizon row drags every sample toward it. Haze
      // physically dissolves a distant object toward the sky AT the horizon,
      // so clamp the sampled elevation just above it. In LUT rows that is the
      // same clamp: v = elevation / PI + 0.5.
      '  return vec2(uv.x, max(uv.y, 0.5 + 0.012 / 3.14159265359));\n' +
      '}\n' +
      // The mix must happen in linear HDR, before the shared tone transform —
      // exactly where the ocean does it. Injecting after tone mapping mixes
      // raw sky radiance into display-referred values and the sky term
      // swamps everything.
      shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        '{\n' +
          '  vec3 terrainToFragment = vTerrainWorldPos - cameraPosition;\n' +
          '  float terrainDist = length(terrainToFragment);\n' +
          '  vec3 terrainHaze = texture2D(uTerrainSkyLut,\n' +
          '    terrainSkyLutUv(terrainToFragment / max(terrainDist, 1e-3))).rgb;\n' +
          '  float terrainTransmit = exp(-terrainDist / uTerrainHazeDistance);\n' +
          '  gl_FragColor.rgb = mix(terrainHaze, gl_FragColor.rgb, terrainTransmit);\n' +
          '}\n' +
          '#include <tonemapping_fragment>',
      );
  };
  material.customProgramCacheKey = () => `${worldKey()}:terrain-haze`;
  return material;
}
