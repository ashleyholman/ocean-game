import * as THREE from 'three';
import { WIND_CUES, windCueBasis, windCueDroopRad } from './windCues';
import type { WindCue } from './windCues';
import { buildWindCueGeometry } from './windCueGeometry';
import { createWorldPbrMaterial } from '../../scene/WorldPbrMaterial';

/**
 * The wind cues as meshes, and the one thing aboard that is aimed every frame.
 *
 * WHAT IS LIVE AND WHAT IS NOT
 * ----------------------------
 * The cloth's *shape* is baked (`windCueGeometry.ts`) and its *attitude* is
 * computed here from the apparent wind. Nothing in between: no flutter, no
 * ripple travelling down the fly, no reaction to the ship's own motion beyond
 * her velocity through the air. That division is the round's whole contract —
 * see the head of `windCues.ts`.
 *
 * WHY THE APPARENT WIND IS NOT EVALUATED AT THE CUE'S OWN POSITION
 * ---------------------------------------------------------------
 * A rolling masthead genuinely sweeps air: `docs/ship/SHIP_SPEC.md` §5.4 puts the lookout
 * through ±3.9 m at 5.8 m/s in a 20° roll, which is *comparable to the wind
 * itself* in `CURRENT_MODERATE`. So the physically complete input would swing
 * the pennant hard through every roll — and a rigid strip with no inertia would
 * present that swing as snapping, because what damps it on a real pennant is the
 * cloth. The point velocity used here is therefore the vessel's, not the point's.
 * That is a deliberate omission of a real term, and the term belongs with the
 * cloth dynamics in M6. `apparentWindRender` takes any point velocity, so it is
 * one argument to change when there is something that can absorb it.
 *
 * THE LAG IS INERTIA, NOT ANIMATION
 * ---------------------------------
 * A first-order lag on the direction and the droop, per cue, tuned by how heavy
 * the cloth is. Without it a gust step or a heading change teleports the flag,
 * and `WorldWind`'s direction wander is a continuous signal that would read as
 * jitter on a body with no mass. Deterministic in dt, so a frame rate cannot
 * change where a flag points.
 */

/** Roughness per material. Bunting is cloth; the staffs are the spars' finish. */
const CUE_FINISH = {
  bunting: { roughness: 0.86, metalness: 0 },
  cueStaff: { roughness: 0.62, metalness: 0 },
};

interface CueState {
  readonly cue: WindCue;
  readonly mesh: THREE.Mesh;
  /** Smoothed wind direction as a unit vector — smoothing an angle wraps. */
  directionX: number;
  directionZ: number;
  droopRad: number;
  settled: boolean;
}

const scratchInverse = new THREE.Quaternion();
const scratchPosition = new THREE.Vector3();
const scratchX = new THREE.Vector3();
const scratchY = new THREE.Vector3();
const scratchZ = new THREE.Vector3();

export class WindCueSet {
  readonly group = new THREE.Group();

  private readonly states: CueState[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  /** Draw calls added, for the schooner's own stats line. */
  readonly drawCalls: number;
  readonly triangleCount: number;

  constructor() {
    this.group.name = 'windCues';
    const built = buildWindCueGeometry();

    const buntingMaterial = createWorldPbrMaterial({
      color: 0xffffff,
      roughness: CUE_FINISH.bunting.roughness,
      metalness: CUE_FINISH.bunting.metalness,
      vertexColors: true,
      name: 'cue:bunting',
    });
    buntingMaterial.color.setScalar(1);
    // Cloth with no thickness, seen from both sides — the sails' argument, and a
    // flag is the case where you are guaranteed to see the back of it.
    buntingMaterial.side = THREE.DoubleSide;
    this.materials.push(buntingMaterial);

    const staffMaterial = createWorldPbrMaterial({
      color: 0xffffff,
      roughness: CUE_FINISH.cueStaff.roughness,
      metalness: CUE_FINISH.cueStaff.metalness,
      vertexColors: true,
      name: 'cue:staff',
    });
    staffMaterial.color.setScalar(1);
    this.materials.push(staffMaterial);

    const staffMesh = new THREE.Mesh(built.staffs, staffMaterial);
    staffMesh.name = 'cue:staffs';
    staffMesh.castShadow = true;
    staffMesh.receiveShadow = true;
    this.group.add(staffMesh);
    this.geometries.push(built.staffs);

    let drawCalls = 1;
    for (const cue of WIND_CUES) {
      const geometry = built.cloths.get(cue.name);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, buntingMaterial);
      mesh.name = `cue:${cue.name}`;
      // A flag's shadow is a moving scrap the size of a hand at the masthead and
      // a real shape on the counter. The ensign's is worth having; the two
      // aloft throw onto sails that are already moving, and a shadow map texel
      // at 22 m is larger than the pennant.
      mesh.castShadow = cue.kind === 'ensign';
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.geometries.push(geometry);
      this.states.push({
        cue,
        mesh,
        directionX: 0,
        directionZ: -1,
        droopRad: cue.maxDroopRad,
        settled: false,
      });
      drawCalls++;
    }

    this.drawCalls = drawCalls;
    this.triangleCount = built.triangleCount;
  }

  /**
   * Aim every cue.
   *
   * `apparentX/apparentZ` are the apparent wind in **render** axes; `yawRad` is
   * the vessel's model yaw, used to put the spindle-mounted cue into the frame
   * its spindle is actually fixed in. `shipQuaternion` is the ship group's world
   * rotation, which the free-flying cues are given back out of: a flag hangs
   * from gravity and the wind, not from the spar, so it must not heel with her.
   */
  update(
    dt: number,
    apparentX: number,
    apparentZ: number,
    yawRad: number,
    shipQuaternion: THREE.Quaternion,
  ): void {
    const speed = Math.hypot(apparentX, apparentZ);
    const inverseShip = scratchInverse.copy(shipQuaternion).invert();

    for (const state of this.states) {
      const { cue } = state;

      // In the vessel's own frame for a vane on a spindle, in the world's for
      // free cloth. The two differ by the yaw and by nothing else here; the heel
      // and pitch difference is applied at the quaternion, below.
      let windX = apparentX;
      let windZ = apparentZ;
      if (cue.attitude === 'spindle') {
        const sy = Math.sin(yawRad);
        const cy = Math.cos(yawRad);
        windX = apparentX * cy - apparentZ * sy;
        windZ = apparentX * sy + apparentZ * cy;
      }

      const targetDroop = windCueDroopRad(cue, speed);
      // In a flat calm there is no direction to point at, so the last one is
      // held: a flag in a dying breeze keeps the set it had and sags, which is
      // what it does. Snapping to a default heading would be inventing a wind.
      const hasDirection = speed > 1e-4;

      if (!state.settled) {
        if (hasDirection) {
          state.directionX = windX / speed;
          state.directionZ = windZ / speed;
        }
        state.droopRad = targetDroop;
        state.settled = true;
      } else {
        const alpha = 1 - Math.exp(-Math.max(dt, 0) / cue.settleSeconds);
        if (hasDirection) {
          state.directionX += (windX / speed - state.directionX) * alpha;
          state.directionZ += (windZ / speed - state.directionZ) * alpha;
        }
        state.droopRad += (targetDroop - state.droopRad) * alpha;
      }

      const length = Math.hypot(state.directionX, state.directionZ);
      if (length > 1e-6) {
        state.directionX /= length;
        state.directionZ /= length;
      }

      // The heading whose vector is (sin, −cos), which is the convention every
      // wind quantity in this codebase is expressed in.
      const headingRad = Math.atan2(state.directionX, -state.directionZ);
      const basis = windCueBasis(headingRad, state.droopRad);

      /**
       * A MATRIX, BECAUSE THE ATTITUDE IS A SHEAR
       * -----------------------------------------
       * `windCueBasis` holds the luff vertical while the fly droops, so its
       * axes are deliberately not orthogonal and there is no quaternion that
       * expresses it. Three is perfectly happy with a sheared basis in the
       * local matrix — the vertex normals come out slightly skewed, which on a
       * shear this size is well under the shading noise the bunting's own
       * colour jitter already carries.
       */
      scratchX.set(basis.x.x, basis.x.y, basis.x.z);
      scratchY.set(basis.y.x, basis.y.y, basis.y.z);
      scratchZ.set(basis.z.x, basis.z.y, basis.z.z);
      // The hoist swings round the staff with the wind — a halyard, not a weld.
      scratchPosition.set(
        state.directionX * cue.standoff,
        0,
        state.directionZ * cue.standoff,
      );

      if (cue.attitude === 'free') {
        // Composed in the world and handed back into the ship's frame, so she
        // can roll 20° under a pennant that stays level.
        scratchX.applyQuaternion(inverseShip);
        scratchY.applyQuaternion(inverseShip);
        scratchZ.applyQuaternion(inverseShip);
        scratchPosition.applyQuaternion(inverseShip);
      }

      state.mesh.matrixAutoUpdate = false;
      state.mesh.matrix.makeBasis(scratchX, scratchY, scratchZ);
      state.mesh.matrix.setPosition(
        cue.staff.head.x + scratchPosition.x,
        cue.staff.head.y + scratchPosition.y,
        cue.staff.head.z + scratchPosition.z,
      );
      state.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
    this.group.clear();
  }
}
