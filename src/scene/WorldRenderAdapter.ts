import * as THREE from 'three';
import type {
  AstronomyFrame,
  Mat3d,
} from '../astronomy/AstronomyProvider';
import { lengthVec3, type Vec3d } from '../world/math';
import type { CanonicalWorldState } from '../world/types';

/**
 * The only Earth-scale-to-Three.js boundary.
 *
 * The scene stays vessel-centred and small. ECEF position itself is never sent
 * to the GPU; only directions and nearby position deltas are projected.
 */
export class WorldRenderAdapter {
  readonly sunDirection = new THREE.Vector3();
  readonly moonDirection = new THREE.Vector3();
  readonly velocityDirection = new THREE.Vector3(0, 0, -1);
  /** Row-major EQJ/J2000 -> local Three.js rotation for the star point cloud. */
  readonly celestialToRender = new Float64Array(9);
  sunSceneAzimuthRad = 0;

  update(
    state: Readonly<CanonicalWorldState>,
    astronomy: Readonly<AstronomyFrame>,
  ): void {
    this.ecefDirectionToThree(
      state,
      astronomy.sunDirectionEcef,
      this.sunDirection,
    ).normalize();
    this.ecefDirectionToThree(
      state,
      astronomy.moonDirectionEcef,
      this.moonDirection,
    ).normalize();

    if (lengthVec3(state.velocityEcefMps) > 0) {
      this.ecefDirectionToThree(
        state,
        state.velocityEcefMps,
        this.velocityDirection,
      ).normalize();
    } else {
      this.velocityDirection.set(0, 0, -1);
    }

    let azimuth = Math.atan2(
      this.sunDirection.x,
      -this.sunDirection.z,
    );
    if (azimuth < 0) azimuth += 2 * Math.PI;
    this.sunSceneAzimuthRad = azimuth;
    this.composeCelestialToRender(
      state,
      astronomy.eqjToEcef,
      this.celestialToRender,
    );
  }

  ecefDirectionToThree(
    state: Readonly<CanonicalWorldState>,
    directionEcef: Readonly<Vec3d>,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const frame = state.surfaceFrameEcef;
    return out.set(
      dot(directionEcef, frame.right),
      dot(directionEcef, frame.up),
      -dot(directionEcef, frame.forward),
    );
  }

  /**
   * Per-frame transform of an ECEF-anchored terrain tile into the render
   * frame (TERR-102). Tile-local axes are X=east, Y=up, Z=south at the tile
   * anchor; vertex buffers stay static Float32 offsets in that frame and
   * only this matrix moves as the vessel travels.
   *
   * The anchor-minus-vessel subtraction happens here in JavaScript doubles —
   * the whole reason the boundary exists — so the translation reaching the
   * GPU is small even when the anchor is hundreds of kilometres away.
   */
  anchoredTileMatrix(
    state: Readonly<CanonicalWorldState>,
    tile: {
      anchorEcef: Readonly<Vec3d>;
      basisEcef: {
        east: Readonly<Vec3d>;
        north: Readonly<Vec3d>;
        up: Readonly<Vec3d>;
      };
    },
    out: THREE.Matrix4,
  ): THREE.Matrix4 {
    const frame = state.surfaceFrameEcef;
    const { east, north, up } = tile.basisEcef;
    const translation = this.nearbyEcefPositionToThree(
      state,
      tile.anchorEcef,
      TILE_TRANSLATION,
    );
    // Columns are the render-frame images of the tile axes; render mapping is
    // x=right, y=up, z=-forward, and tile Z is south (east x up = south).
    return out.set(
      dot(east, frame.right), dot(up, frame.right), -dot(north, frame.right), translation.x,
      dot(east, frame.up), dot(up, frame.up), -dot(north, frame.up), translation.y,
      -dot(east, frame.forward), -dot(up, frame.forward), dot(north, frame.forward), translation.z,
      0, 0, 0, 1,
    );
  }

  nearbyEcefPositionToThree(
    state: Readonly<CanonicalWorldState>,
    nearbyPositionEcefM: Readonly<Vec3d>,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const dx = nearbyPositionEcefM.x - state.positionEcefM.x;
    const dy = nearbyPositionEcefM.y - state.positionEcefM.y;
    const dz = nearbyPositionEcefM.z - state.positionEcefM.z;
    const frame = state.surfaceFrameEcef;
    return out.set(
      dx * frame.right.x + dy * frame.right.y + dz * frame.right.z,
      dx * frame.up.x + dy * frame.up.y + dz * frame.up.z,
      -(dx * frame.forward.x +
        dy * frame.forward.y +
        dz * frame.forward.z),
    );
  }

  private composeCelestialToRender(
    state: Readonly<CanonicalWorldState>,
    eqjToEcef: Mat3d,
    out: Mat3d,
  ): void {
    const frame = state.surfaceFrameEcef;
    for (let column = 0; column < 3; column++) {
      const ecefX = eqjToEcef[column];
      const ecefY = eqjToEcef[3 + column];
      const ecefZ = eqjToEcef[6 + column];
      out[column] =
        frame.right.x * ecefX +
        frame.right.y * ecefY +
        frame.right.z * ecefZ;
      out[3 + column] =
        frame.up.x * ecefX +
        frame.up.y * ecefY +
        frame.up.z * ecefZ;
      out[6 + column] = -(
        frame.forward.x * ecefX +
        frame.forward.y * ecefY +
        frame.forward.z * ecefZ
      );
    }
  }
}

function dot(a: Readonly<Vec3d>, b: Readonly<Vec3d>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

const TILE_TRANSLATION = new THREE.Vector3();
