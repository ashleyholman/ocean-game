import * as THREE from 'three';
import {
  CLOUD_TILE_REFRESH_FRAMES,
  CloudTileScheduler,
  type CloudTileSchedule,
} from './cloudTileScheduler';
import {
  SparseTilePool,
  createSparseAtlasLayout,
  type SparseAtlasLayout,
  type SparseTilePoolDelta,
} from './SparseTilePool';
import { GLSL_COMMON, GLSL_SKY } from './shaders/lib';

/**
 * Camera-local, synchronized cloud cache.
 *
 * The expensive march is tiled and camera-prioritized, but the displayed
 * cloud field still changes as one coherent generation. A staging target is
 * filled from one uniform snapshot over sixty rendered frames. Only after the
 * required visible + guard tiles are ready do front and staging swap.
 *
 * A camera pan can reveal a tile that the current front target never received.
 * That tile is baked on demand using the CURRENT DISPLAY SNAPSHOT — not live
 * uniforms — so it joins the existing generation rather than inventing an
 * independent tick. The same tile joins the next ordinary staged generation
 * before the following atomic swap.
 */

export const CLOUD_TILE_WIDTH = 256;
export const CLOUD_TILE_HEIGHT = 128;

const VISIBLE_PADDING_RADIANS = THREE.MathUtils.degToRad(2);
/** Covers camera motion and the shader's maximum 16.5° cumulus advection. */
const GUARD_BAND_RADIANS = THREE.MathUtils.degToRad(20);

const CLOUD_DOME_ELEV_MIN = -0.06;
const CLOUD_DOME_HALF_PI = Math.PI / 2;
const CLOUD_DOME_WARP = 0.6;
const CLOUD_TILE_GUTTER = 1;
/**
 * (RGBA16F + RG16F) × front/staging. packB carried the cirrus channels in its
 * z/w until the high deck was deleted; two channels is all W1/W2 need.
 */
const CLOUD_CACHE_BYTES_PER_TEXEL = (4 + 2) * 2 * 2;

type SnapshotValue = number | THREE.Vector2 | THREE.Vector3;
type UniformSnapshot = Record<string, SnapshotValue>;

interface CacheSurface {
  target: THREE.WebGLRenderTarget;
  readyGeneration: Int32Array;
  initialized: boolean;
}

export interface CloudTile {
  index: number;
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: THREE.Vector3;
  angularRadius: number;
}

export interface CloudTileGrid {
  columns: number;
  rows: number;
  tiles: CloudTile[];
}

export interface CloudDomeReading {
  visibleTiles: number;
  guardTiles: number;
  residentTiles: number;
  slotCapacity: number;
  unmappedGuardTiles: number;
  unmappedVisibleTiles: number;
  cacheBytes: number;
  fullCacheBytes: number;
  atlasWidth: number;
  atlasHeight: number;
  bakedTiles: number;
  rebaseTiles: number;
  onDemandTiles: number;
  stagingTiles: number;
  catchUpTiles: number;
  steadyBudget: number;
  swapped: boolean;
}

/** Deterministic logical grid; edge clipping is tested without WebGL. */
export function createCloudTileGrid(
  width: number,
  height: number,
  tileWidth = CLOUD_TILE_WIDTH,
  tileHeight = CLOUD_TILE_HEIGHT,
): CloudTileGrid {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    !Number.isInteger(tileWidth) ||
    !Number.isInteger(tileHeight) ||
    width <= 0 ||
    height <= 0 ||
    tileWidth <= 0 ||
    tileHeight <= 0
  ) {
    throw new RangeError(
      'Cloud cache and tile dimensions must be positive integers',
    );
  }

  const columns = Math.ceil(width / tileWidth);
  const rows = Math.ceil(height / tileHeight);
  const tiles: CloudTile[] = [];
  const centre = new THREE.Vector3();
  const corner = new THREE.Vector3();

  for (let row = 0; row < rows; row++) {
    const y = row * tileHeight;
    const h = Math.min(tileHeight, height - y);
    for (let column = 0; column < columns; column++) {
      const x = column * tileWidth;
      const w = Math.min(tileWidth, width - x);
      cloudDomeDirection(
        (x + w * 0.5) / width,
        (y + h * 0.5) / height,
        centre,
      );

      let angularRadius = 0;
      for (const u of [x / width, (x + w) / width]) {
        for (const v of [y / height, (y + h) / height]) {
          cloudDomeDirection(u, v, corner);
          angularRadius = Math.max(
            angularRadius,
            Math.acos(
              THREE.MathUtils.clamp(centre.dot(corner), -1, 1),
            ),
          );
        }
      }

      tiles.push({
        index: tiles.length,
        column,
        row,
        x,
        y,
        width: w,
        height: h,
        direction: centre.clone(),
        angularRadius,
      });
    }
  }

  return { columns, rows, tiles };
}

const VERTEX_SHADER = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_COMMON}
${GLSL_SKY}

in vec2 vUv;
uniform vec2 uCloudLogicalSize;
layout(location = 0) out vec4 outPackA;
layout(location = 1) out vec2 outPackB;

void main() {
  // Sparse slots include a one-texel gutter. Wrap azimuth and clamp elevation
  // to the full cache's edge texel centres so a gutter texel is bit-identical
  // to the logical neighbour it duplicates.
  vec2 logicalUv = vec2(
    fract(vUv.x),
    clamp(
      vUv.y,
      0.5 / uCloudLogicalSize.y,
      1.0 - 0.5 / uCloudLogicalSize.y
    )
  );
  cloudBake(cloudDomeDir(logicalUv), outPackA, outPackB);
}
`;

export class CloudDome {
  /**
   * Bootstrap references. After the first synchronized swap the shared sky
   * uniforms are the authority because front and staging exchange identities.
   */
  readonly textureA: THREE.Texture;
  readonly textureB: THREE.Texture;
  readonly reading: CloudDomeReading = {
    visibleTiles: 0,
    guardTiles: 0,
    residentTiles: 0,
    slotCapacity: 0,
    unmappedGuardTiles: 0,
    unmappedVisibleTiles: 0,
    cacheBytes: 0,
    fullCacheBytes: 0,
    atlasWidth: 0,
    atlasHeight: 0,
    bakedTiles: 0,
    rebaseTiles: 0,
    onDemandTiles: 0,
    stagingTiles: 0,
    catchUpTiles: 0,
    steadyBudget: 0,
    swapped: false,
  };

  private front: CacheSurface;
  private staging: CacheSurface;
  private readonly scene: THREE.Scene;
  // Orthographic, not bare Camera: the fullscreen shader ignores the
  // projection, but three's reversed-depth path (?depth=reversed) calls
  // updateProjectionMatrix() on every camera it renders with, and the base
  // class does not have one.
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly batchPositions: Float32Array;
  private readonly batchUvs: Float32Array;
  private readonly batchPositionAttribute: THREE.BufferAttribute;
  private readonly batchUvAttribute: THREE.BufferAttribute;
  private readonly liveUniforms: Record<string, THREE.IUniform>;
  private readonly grid: CloudTileGrid;
  private readonly pool: SparseTilePool;
  private readonly atlas: SparseAtlasLayout;
  private readonly pageTableData: Uint8Array;
  private readonly pageTable: THREE.DataTexture;
  private readonly scheduler: CloudTileScheduler;
  private readonly visible = new Set<number>();
  private readonly guard = new Set<number>();
  private readonly residentGuard = new Set<number>();
  private readonly guardOrder: number[] = [];
  private readonly cameraForward = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3();
  private displaySnapshot: UniformSnapshot;
  private stagingSnapshot: UniformSnapshot;
  private displayGeneration = 0;
  private stagingGeneration = 1;
  private stagingFrame = 0;
  private started = false;
  private rebaseRequested = false;
  private frozenValue = false;

  /** Diagnostic hold used to make multi-render A/B captures pixel-comparable. */
  get frozen(): boolean {
    return this.frozenValue;
  }

  setFrozen(frozen: boolean): void {
    this.frozenValue = frozen;
  }

  /**
   * Return the cache to the state a freshly constructed dome is in.
   *
   * THIS IS THE LARGEST SINGLE TERM IN RE-STAGE NON-DETERMINISM. The cache is
   * filled by an amortized generation whose tile order comes off a round-robin
   * cursor, and whose progress is counted by `stagingFrame` inside a
   * sixty-frame cycle. None of that was reachable from `resetSimulation`, so
   * staging one scene twice on a page entered the cycle at a different frame,
   * with the cursor at a different tile, over a pool holding a different
   * residency — measured on the capture host as a cursor ending at 149 on one
   * staging and 83 on the next, and mean 1.37/255 of pixel residue that fell
   * to 0.14 when the warm frames were removed.
   *
   * The freeze is cleared too. A frozen dome is a diagnostic hold on a cache
   * that no longer has contents, and leaving it set would photograph a bare
   * sky; "restart from a known state" has to mean the hold comes off as well.
   *
   * No GPU work happens here. The render targets keep whatever texels they
   * hold; every tile is marked not-ready, so the next `update` re-renders each
   * one it needs before anything samples it.
   */
  reset(): void {
    this.scheduler.reset();
    this.pool.reset();
    this.front.readyGeneration.fill(-1);
    this.staging.readyGeneration.fill(-1);
    this.displayGeneration = 0;
    this.stagingGeneration = 1;
    this.stagingFrame = 0;
    this.rebaseRequested = false;
    this.frozenValue = false;
    // `started` re-arms the one-shot bootstrap: the next update re-captures
    // both uniform snapshots and republishes the front textures, so the cache
    // is keyed on the instant the reset left behind rather than the one the
    // previous scene was staged at.
    this.started = false;
    this.visible.clear();
    this.guard.clear();
    this.residentGuard.clear();
    this.guardOrder.length = 0;
    // Every logical tile back to the bare-sky entry, matching the pool.
    this.pageTableData.fill(0);
    for (let logical = 0; logical < this.grid.tiles.length; logical++) {
      this.pageTableData[logical * 4 + 3] = 255;
    }
    this.pageTable.needsUpdate = true;
  }

  /** Where the amortized generation stands. Determinism diagnostics only. */
  get scheduleState(): {
    nextTileIndex: number;
    displayGeneration: number;
    stagingGeneration: number;
    stagingFrame: number;
    residentTiles: number;
  } {
    return {
      nextTileIndex: this.scheduler.nextIndex,
      displayGeneration: this.displayGeneration,
      stagingGeneration: this.stagingGeneration,
      stagingFrame: this.stagingFrame,
      residentTiles: this.pool.residentCount,
    };
  }

  constructor(
    liveUniforms: Record<string, THREE.IUniform>,
    defines: Record<string, number | string>,
    width: number,
    height: number,
    slotCapacity: number,
  ) {
    this.liveUniforms = liveUniforms;
    this.grid = createCloudTileGrid(width, height);
    if (
      width % CLOUD_TILE_WIDTH !== 0 ||
      height % CLOUD_TILE_HEIGHT !== 0
    ) {
      throw new RangeError(
        'Sparse cloud-cache dimensions must contain complete logical tiles',
      );
    }
    const capacity = Math.min(slotCapacity, this.grid.tiles.length);
    this.pool = new SparseTilePool(this.grid.tiles.length, capacity);
    this.atlas = createSparseAtlasLayout(
      capacity,
      CLOUD_TILE_WIDTH,
      CLOUD_TILE_HEIGHT,
      CLOUD_TILE_GUTTER,
    );
    this.scheduler = new CloudTileScheduler(this.grid.tiles.length);

    this.pageTableData = new Uint8Array(this.grid.tiles.length * 4);
    this.pageTable = new THREE.DataTexture(
      this.pageTableData,
      this.grid.columns,
      this.grid.rows,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.pageTable.minFilter = THREE.NearestFilter;
    this.pageTable.magFilter = THREE.NearestFilter;
    this.pageTable.wrapS = THREE.ClampToEdgeWrapping;
    this.pageTable.wrapT = THREE.ClampToEdgeWrapping;
    this.pageTable.generateMipmaps = false;
    this.pageTable.needsUpdate = true;

    liveUniforms.uCloudPageTable = { value: this.pageTable };
    liveUniforms.uCloudLogicalGrid = {
      value: new THREE.Vector2(this.grid.columns, this.grid.rows),
    };
    liveUniforms.uCloudLogicalSize = {
      value: new THREE.Vector2(width, height),
    };
    liveUniforms.uCloudAtlasSize = {
      value: new THREE.Vector2(this.atlas.width, this.atlas.height),
    };
    liveUniforms.uCloudTileSize = {
      value: new THREE.Vector2(CLOUD_TILE_WIDTH, CLOUD_TILE_HEIGHT),
    };
    liveUniforms.uCloudSlotSize = {
      value: new THREE.Vector2(this.atlas.slotWidth, this.atlas.slotHeight),
    };
    liveUniforms.uCloudAtlasColumns = { value: this.atlas.columns };
    liveUniforms.uCloudTileGutter = { value: CLOUD_TILE_GUTTER };

    const makeSurface = (): CacheSurface => {
      const target = new THREE.WebGLRenderTarget(
        this.atlas.width,
        this.atlas.height,
        {
          count: 2,
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          depthBuffer: false,
          stencilBuffer: false,
        },
      );
      for (const texture of target.textures) {
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
      }
      // Per-attachment format: packA needs four channels, packB two. Set after
      // construction because the render target's options apply to every
      // attachment alike.
      target.textures[1].format = THREE.RGFormat;
      const readyGeneration = new Int32Array(this.grid.tiles.length);
      readyGeneration.fill(-1);
      return { target, readyGeneration, initialized: false };
    };

    this.front = makeSurface();
    this.staging = makeSurface();
    this.textureA = this.front.target.textures[0];
    this.textureB = this.front.target.textures[1];

    this.reading.slotCapacity = capacity;
    this.reading.cacheBytes =
      this.atlas.width *
        this.atlas.height *
        CLOUD_CACHE_BYTES_PER_TEXEL +
      this.pageTableData.byteLength;
    this.reading.fullCacheBytes =
      width * height * CLOUD_CACHE_BYTES_PER_TEXEL;
    this.reading.atlasWidth = this.atlas.width;
    this.reading.atlasHeight = this.atlas.height;

    const materialUniforms = cloneUniforms(liveUniforms);
    this.material = new THREE.ShaderMaterial({
      uniforms: materialUniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      glslVersion: THREE.GLSL3,
      defines,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.displaySnapshot = createSnapshot(liveUniforms);
    this.stagingSnapshot = createSnapshot(liveUniforms);

    // One six-vertex quad per logical tile. Updating this small pair of arrays
    // lets every selected tile render in ONE draw call, instead of recursively
    // calling WebGLRenderer once per scissored tile from the sky's
    // onBeforeRender hook. Apart from the submission spikes, those nested
    // scissor changes could leak partially populated rectangles into the outer
    // sky draw while the renderer changed resolution.
    const batchVertices = this.grid.tiles.length * 6;
    this.batchPositions = new Float32Array(batchVertices * 3);
    this.batchUvs = new Float32Array(batchVertices * 2);
    this.batchPositionAttribute = new THREE.BufferAttribute(
      this.batchPositions,
      3,
    );
    this.batchPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.batchUvAttribute = new THREE.BufferAttribute(this.batchUvs, 2);
    this.batchUvAttribute.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.batchPositionAttribute);
    this.geometry.setAttribute('uv', this.batchUvAttribute);
    this.geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(mesh);
  }

  update(renderer: THREE.WebGLRenderer, renderCamera: THREE.Camera): void {
    if (!this.started) {
      captureSnapshot(this.liveUniforms, this.displaySnapshot);
      captureSnapshot(this.liveUniforms, this.stagingSnapshot);
      this.publishDisplay();
      this.started = true;
    }
    if (this.frozenValue) return;

    this.updateVisibility(renderCamera);
    const poolDelta = this.pool.reconcile(this.guardOrder);
    this.applyPoolDelta(poolDelta);
    this.residentGuard.clear();
    for (const logical of this.guardOrder) {
      if (this.pool.slotFor(logical) >= 0) {
        this.residentGuard.add(logical);
      }
    }

    const rebaseTiles = this.rebaseRequested
      ? this.rebaseDisplay(renderer)
      : 0;

    // Fill every current guard tile from the displayed snapshot. Normally this
    // is empty; after a pan it is the explicitly accepted inline catch-up.
    const onDemand = missingTiles(
      this.residentGuard,
      this.front.readyGeneration,
      this.displayGeneration,
    );
    if (onDemand.length > 0) {
      this.renderTiles(
        renderer,
        this.front,
        this.displaySnapshot,
        onDemand,
      );
      markGeneration(
        this.front.readyGeneration,
        this.displayGeneration,
        onDemand,
      );
    }

    const finishGeneration =
      this.stagingFrame === CLOUD_TILE_REFRESH_FRAMES - 1;
    const schedule = this.scheduler.select(
      this.stagingGeneration,
      this.staging.readyGeneration,
      this.residentGuard,
      this.stagingFrame,
      finishGeneration,
    );
    if (schedule.indices.length > 0) {
      this.renderTiles(
        renderer,
        this.staging,
        this.stagingSnapshot,
        schedule.indices,
      );
      this.scheduler.markReady(
        this.stagingGeneration,
        this.staging.readyGeneration,
        schedule.indices,
      );
    }

    this.publishReading(
      rebaseTiles,
      onDemand.length,
      schedule,
      finishGeneration,
    );
    if (finishGeneration) this.swapGeneration();
    else this.stagingFrame++;
  }

  /**
   * Request an atomic visible-cache reset at the next render. Calls coalesce,
   * so a burst of DOM events can never schedule more than one reset per frame.
   */
  requestDisplayRebase(): void {
    this.rebaseRequested = true;
  }

  private rebaseDisplay(renderer: THREE.WebGLRenderer): number {
    this.rebaseRequested = false;

    // Retire both old generations. Only the current guard is needed now; tiles
    // outside it remain invalid and will be filled on demand if a later camera
    // movement brings them into the guard.
    this.displayGeneration =
      Math.max(this.displayGeneration, this.stagingGeneration) + 1;
    captureSnapshot(this.liveUniforms, this.displaySnapshot);

    const indices = [...this.residentGuard];
    if (indices.length > 0) {
      this.renderTiles(
        renderer,
        this.front,
        this.displaySnapshot,
        indices,
      );
      markGeneration(
        this.front.readyGeneration,
        this.displayGeneration,
        indices,
      );
    }
    this.publishDisplay();

    // The ordinary amortized generation starts again from exactly the instant
    // just published, rather than completing a pre-jump staging texture.
    this.stagingGeneration = this.displayGeneration + 1;
    this.stagingFrame = 0;
    captureSnapshot(this.liveUniforms, this.stagingSnapshot);
    return indices.length;
  }

  private applyPoolDelta(delta: SparseTilePoolDelta): void {
    if (delta.allocated.length === 0 && delta.evicted.length === 0) return;

    for (const logical of [...delta.evicted, ...delta.allocated]) {
      this.front.readyGeneration[logical] = -1;
      this.staging.readyGeneration[logical] = -1;
      const offset = logical * 4;
      const slot = this.pool.slotFor(logical);
      // Slot zero is encoded as one; zero remains the invalid/bare-sky entry.
      this.pageTableData[offset] = slot >= 0 ? slot + 1 : 0;
      this.pageTableData[offset + 1] = 0;
      this.pageTableData[offset + 2] = 0;
      this.pageTableData[offset + 3] = 255;
    }
    this.pageTable.needsUpdate = true;
  }

  private swapGeneration(): void {
    const oldFront = this.front;
    this.front = this.staging;
    this.staging = oldFront;

    const oldDisplaySnapshot = this.displaySnapshot;
    this.displaySnapshot = this.stagingSnapshot;
    this.stagingSnapshot = oldDisplaySnapshot;

    this.displayGeneration = this.stagingGeneration;
    this.stagingGeneration++;
    this.stagingFrame = 0;
    this.publishDisplay();
    captureSnapshot(this.liveUniforms, this.stagingSnapshot);
  }

  private publishDisplay(): void {
    const uniforms = this.liveUniforms;
    if (uniforms.uCloudPackA && uniforms.uCloudPackB) {
      uniforms.uCloudPackA.value = this.front.target.textures[0];
      uniforms.uCloudPackB.value = this.front.target.textures[1];
    }
    const cloudBase = this.displaySnapshot.uCloudOffset;
    if (cloudBase instanceof THREE.Vector2) {
      (uniforms.uCloudDriftBase.value as THREE.Vector2).copy(cloudBase);
    }
  }

  private updateVisibility(renderCamera: THREE.Camera): void {
    this.visible.clear();
    this.guard.clear();
    this.guardOrder.length = 0;

    if (!(renderCamera instanceof THREE.PerspectiveCamera)) {
      for (const tile of this.grid.tiles) {
        this.visible.add(tile.index);
        this.guard.add(tile.index);
        this.guardOrder.push(tile.index);
      }
      return;
    }

    renderCamera.getWorldDirection(this.cameraForward);
    this.cameraRight
      .set(1, 0, 0)
      .applyQuaternion(renderCamera.quaternion)
      .normalize();
    this.cameraUp
      .set(0, 1, 0)
      .applyQuaternion(renderCamera.quaternion)
      .normalize();
    const verticalHalfFov =
      THREE.MathUtils.degToRad(renderCamera.getEffectiveFOV()) * 0.5;
    const horizontalHalfFov = Math.atan(
      Math.tan(verticalHalfFov) * Math.max(renderCamera.aspect, 1e-6),
    );
    const visibleCandidates: Array<{ index: number; angle: number }> = [];
    const guardCandidates: Array<{ index: number; angle: number }> = [];

    for (const tile of this.grid.tiles) {
      const forward = this.cameraForward.dot(tile.direction);
      const horizontalAngle = Math.atan2(
        Math.abs(this.cameraRight.dot(tile.direction)),
        forward,
      );
      const verticalAngle = Math.atan2(
        Math.abs(this.cameraUp.dot(tile.direction)),
        forward,
      );
      const padding =
        tile.angularRadius + VISIBLE_PADDING_RADIANS;
      const inVisible =
        horizontalAngle <= horizontalHalfFov + padding &&
        verticalAngle <= verticalHalfFov + padding;
      const inGuard =
        horizontalAngle <=
          horizontalHalfFov + padding + GUARD_BAND_RADIANS &&
        verticalAngle <=
          verticalHalfFov + padding + GUARD_BAND_RADIANS;
      if (!inGuard) continue;

      const centreAngle = Math.acos(
        THREE.MathUtils.clamp(forward, -1, 1),
      );
      if (inVisible) {
        visibleCandidates.push({ index: tile.index, angle: centreAngle });
      } else {
        guardCandidates.push({ index: tile.index, angle: centreAngle });
      }
    }

    visibleCandidates.sort((a, b) => a.angle - b.angle);
    guardCandidates.sort((a, b) => a.angle - b.angle);
    for (const candidate of visibleCandidates) {
      this.visible.add(candidate.index);
      this.guard.add(candidate.index);
      this.guardOrder.push(candidate.index);
    }
    for (const candidate of guardCandidates) {
      this.guard.add(candidate.index);
      this.guardOrder.push(candidate.index);
    }
  }

  private renderTiles(
    renderer: THREE.WebGLRenderer,
    surface: CacheSurface,
    snapshot: UniformSnapshot,
    indices: readonly number[],
  ): void {
    applySnapshot(snapshot, this.material.uniforms);
    this.writeTileBatch(indices);
    const previousTarget = renderer.getRenderTarget();
    const previousShadowAuto = renderer.shadowMap.autoUpdate;
    const previousAutoClear = renderer.autoClear;

    try {
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(surface.target);
      if (!surface.initialized) {
        renderer.clear(true, false, false);
        surface.initialized = true;
      }
      // Preserve every tile written by earlier frames of this generation.
      // The selected tile quads cover only their atlas rectangles, so no
      // scissor is required and one render submits the complete batch.
      renderer.autoClear = false;
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
      renderer.shadowMap.autoUpdate = previousShadowAuto;
    }
  }

  private writeTileBatch(indices: readonly number[]): void {
    let positionOffset = 0;
    let uvOffset = 0;
    let writtenTiles = 0;

    for (const index of indices) {
      const tile = this.grid.tiles[index];
      const slot = this.pool.slotFor(index);
      if (slot < 0) continue;
      writtenTiles++;
      const slotColumn = slot % this.atlas.columns;
      const slotRow = Math.floor(slot / this.atlas.columns);
      const physicalX = slotColumn * this.atlas.slotWidth;
      const physicalY = slotRow * this.atlas.slotHeight;
      const x0 = (physicalX / this.atlas.width) * 2 - 1;
      const y0 = (physicalY / this.atlas.height) * 2 - 1;
      const x1 =
        ((physicalX + this.atlas.slotWidth) / this.atlas.width) * 2 - 1;
      const y1 =
        ((physicalY + this.atlas.slotHeight) / this.atlas.height) * 2 - 1;
      const u0 =
        (tile.x - this.atlas.gutter) /
        (this.grid.columns * CLOUD_TILE_WIDTH);
      const v0 =
        (tile.y - this.atlas.gutter) /
        (this.grid.rows * CLOUD_TILE_HEIGHT);
      const u1 =
        (tile.x + tile.width + this.atlas.gutter) /
        (this.grid.columns * CLOUD_TILE_WIDTH);
      const v1 =
        (tile.y + tile.height + this.atlas.gutter) /
        (this.grid.rows * CLOUD_TILE_HEIGHT);

      positionOffset = writeQuad3(
        this.batchPositions,
        positionOffset,
        x0,
        y0,
        x1,
        y1,
      );
      uvOffset = writeQuad2(
        this.batchUvs,
        uvOffset,
        u0,
        v0,
        u1,
        v1,
      );
    }

    this.batchPositionAttribute.needsUpdate = true;
    this.batchUvAttribute.needsUpdate = true;
    this.geometry.setDrawRange(0, writtenTiles * 6);
  }

  private publishReading(
    rebaseTiles: number,
    onDemandTiles: number,
    schedule: CloudTileSchedule,
    swapped: boolean,
  ): void {
    this.reading.visibleTiles = this.visible.size;
    this.reading.guardTiles = this.guard.size;
    this.reading.residentTiles = this.pool.residentCount;
    this.reading.unmappedGuardTiles =
      this.guard.size - this.residentGuard.size;
    let unmappedVisible = 0;
    for (const logical of this.visible) {
      if (this.pool.slotFor(logical) < 0) unmappedVisible++;
    }
    this.reading.unmappedVisibleTiles = unmappedVisible;
    this.reading.rebaseTiles = rebaseTiles;
    this.reading.onDemandTiles = onDemandTiles;
    this.reading.stagingTiles = schedule.indices.length;
    this.reading.catchUpTiles = schedule.catchUpCount;
    this.reading.bakedTiles =
      rebaseTiles + onDemandTiles + schedule.indices.length;
    this.reading.steadyBudget = schedule.steadyBudget;
    this.reading.swapped = swapped;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.pageTable.dispose();
    this.front.target.dispose();
    this.staging.target.dispose();
  }
}

function missingTiles(
  required: ReadonlySet<number>,
  readyGeneration: Int32Array,
  generation: number,
): number[] {
  const missing: number[] = [];
  for (const index of required) {
    if (readyGeneration[index] !== generation) missing.push(index);
  }
  return missing;
}

function markGeneration(
  readyGeneration: Int32Array,
  generation: number,
  indices: readonly number[],
): void {
  for (const index of indices) readyGeneration[index] = generation;
}

function writeQuad3(
  destination: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const values = [
    x0, y0, 0,
    x1, y0, 0,
    x0, y1, 0,
    x0, y1, 0,
    x1, y0, 0,
    x1, y1, 0,
  ];
  destination.set(values, offset);
  return offset + values.length;
}

function writeQuad2(
  destination: Float32Array,
  offset: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const values = [
    x0, y0,
    x1, y0,
    x0, y1,
    x0, y1,
    x1, y0,
    x1, y1,
  ];
  destination.set(values, offset);
  return offset + values.length;
}

function cloudDomeDirection(
  u: number,
  v: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const azimuth = (u - 0.5) * Math.PI * 2;
  const t = Math.pow(
    THREE.MathUtils.clamp(v, 0, 1),
    1 / CLOUD_DOME_WARP,
  );
  const elevation =
    CLOUD_DOME_ELEV_MIN +
    t * (CLOUD_DOME_HALF_PI - CLOUD_DOME_ELEV_MIN);
  const horizontal = Math.cos(elevation);
  return out.set(
    Math.cos(azimuth) * horizontal,
    Math.sin(elevation),
    Math.sin(azimuth) * horizontal,
  );
}

function createSnapshot(
  source: Record<string, THREE.IUniform>,
): UniformSnapshot {
  const snapshot: UniformSnapshot = {};
  for (const [key, uniform] of Object.entries(source)) {
    const value = uniform.value;
    if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3) {
      snapshot[key] = value.clone();
    } else if (typeof value === 'number') {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function captureSnapshot(
  source: Record<string, THREE.IUniform>,
  destination: UniformSnapshot,
): void {
  for (const [key, value] of Object.entries(destination)) {
    const sourceValue = source[key]?.value;
    if (
      value instanceof THREE.Vector2 ||
      value instanceof THREE.Vector3
    ) {
      value.copy(sourceValue as never);
    } else if (typeof sourceValue === 'number') {
      destination[key] = sourceValue;
    }
  }
}

function applySnapshot(
  snapshot: UniformSnapshot,
  uniforms: Record<string, THREE.IUniform>,
): void {
  for (const [key, value] of Object.entries(snapshot)) {
    const destination = uniforms[key]?.value;
    if (
      destination instanceof THREE.Vector2 ||
      destination instanceof THREE.Vector3
    ) {
      destination.copy(value as never);
    } else if (typeof value === 'number' && uniforms[key]) {
      uniforms[key].value = value;
    }
  }
}

function cloneUniforms(
  source: Record<string, THREE.IUniform>,
): Record<string, THREE.IUniform> {
  const out: Record<string, THREE.IUniform> = {};
  for (const [key, uniform] of Object.entries(source)) {
    const value = uniform.value;
    if (value instanceof THREE.Vector2 || value instanceof THREE.Vector3) {
      out[key] = { value: value.clone() };
    } else if (typeof value === 'number') {
      out[key] = { value };
    }
  }
  return out;
}
