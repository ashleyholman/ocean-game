import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { SoundSampler, type SoundSamplerPorts } from '../src/audio/SoundSampler';
import { SEA_STATES } from '../src/ocean/presets';
import { CABIN_SOLE_Y, PLATFORM_SOLE_Y } from '../src/vessel/schooner/hullForm';

/**
 * Where the ear is, and which room it is in.
 *
 * This file exists because the room lookup has a silent-failure shape. If the
 * ship-local transform is wrong, `lightRoomAt` answers `null` for every point
 * inside the hull, the muffling never engages, and *nothing complains* — the
 * sound simply stays as it is on deck. That is exactly the failure the foam
 * round shipped once already (the whitewater window drifted off the raft and
 * read as "whitewater is illegible" for weeks), and the lesson recorded from
 * it is to gate the window, not just the thing inside it.
 *
 * So these tests put the listener at coordinates `interior-light.test.ts`
 * already pins as belonging to a named room, through a real, non-identity
 * vessel transform, and assert the sampler agrees.
 */

const SEA = SEA_STATES[0];

/**
 * A vessel transform that is emphatically not the identity.
 *
 * Heeled, pitched, yawed and translated — because an identity matrix would
 * pass whether or not the code inverted anything, and the whole risk here is
 * an inverse that was never applied.
 */
function posedVessel(): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  matrix.compose(
    new THREE.Vector3(12, 0.8, -30),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.06, 1.1, -0.19, 'YXZ'),
    ),
    new THREE.Vector3(1, 1, 1),
  );
  return matrix;
}

/** Put the listener at a ship-local point, then build the ports around it. */
function samplerAtShipLocal(
  localX: number,
  localY: number,
  localZ: number,
  options: { hasInterior?: boolean } = {},
): SoundSampler {
  const matrixWorld = posedVessel();
  const worldPosition = new THREE.Vector3(localX, localY, localZ).applyMatrix4(
    matrixWorld,
  );

  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(worldPosition);
  camera.updateMatrixWorld();

  const bowWorld = new THREE.Vector3(0, 0, 7).applyMatrix4(matrixWorld);

  const ports: SoundSamplerPorts = {
    cameras: { camera, modeName: 'embodied' },
    vessel: {
      cameraAnchor: {
        matrixWorld,
        x: 12,
        z: -30,
        waterlineY: 0.8,
      },
      bowWorld,
      readAcoustics: () => ({
        apparentWindMps: 8,
        setClothAreaM2: 120,
        shakingClothAreaM2: 0,
        hullWorkRateRadPerS: 0.1,
        speedThroughWaterMps: 3,
      }),
    },
    waves: { significantHeight: 1.5, dominantPeriod: 8 },
    hasInterior: options.hasInterior ?? true,
  } as unknown as SoundSamplerPorts;

  return new SoundSampler(ports);
}

describe('the listener finds its room through the vessel transform', () => {
  it('is in the captain’s cabin at the cabin’s own coordinates', () => {
    const state = samplerAtShipLocal(0, CABIN_SOLE_Y + 0.5, -5.5).sample(SEA, 0);
    expect(state.room).toBe('cabin');
  });

  it('is on the landing at the foot of the companionway', () => {
    const state = samplerAtShipLocal(0, CABIN_SOLE_Y + 0.5, -3.4).sample(SEA, 0);
    expect(state.room).toBe('landing');
  });

  it('is in the wardroom under the hatchway', () => {
    const state = samplerAtShipLocal(0.5, PLATFORM_SOLE_Y + 0.5, 0.5).sample(SEA, 0);
    expect(state.room).toBe('wardroom');
  });

  it('is in the forecastle forward', () => {
    const state = samplerAtShipLocal(0, 2.4, 4.5).sample(SEA, 0);
    expect(state.room).toBe('forecastle');
  });

  it('is in the open air standing on deck', () => {
    const state = samplerAtShipLocal(0, 1.5, -5.5).sample(SEA, 0);
    expect(state.room).toBeNull();
  });

  it('is in the open air far outboard, where a cinematic camera sits', () => {
    const state = samplerAtShipLocal(0, 40, -300).sample(SEA, 0);
    expect(state.room).toBeNull();
  });

  it('never reports a room on a vessel that has no interior', () => {
    // The diagnostic raft. `lightRoomAt` is module-level schooner geometry and
    // would confidently place a point near a raft inside the captain's cabin.
    const state = samplerAtShipLocal(0, CABIN_SOLE_Y + 0.5, -5.5, {
      hasInterior: false,
    }).sample(SEA, 0);
    expect(state.room).toBeNull();
  });
});

describe('the listener measures its distance to the vessel', () => {
  it('is close aboard when standing on the deck', () => {
    const state = samplerAtShipLocal(0, 1.5, -5.5).sample(SEA, 0);
    // Measured to the hull's waterline point, so a listener on the deck of a
    // ship 30 m from the render origin is still a couple of metres from her.
    expect(state.vesselDistanceM).toBeLessThan(8);
  });

  it('is far off when the camera has pulled back', () => {
    const state = samplerAtShipLocal(0, 40, -300).sample(SEA, 0);
    expect(state.vesselDistanceM).toBeGreaterThan(290);
  });
});

describe('the sampler reuses one record', () => {
  it('hands back the same object every frame', () => {
    const sampler = samplerAtShipLocal(0, 1.5, -5.5);
    const first = sampler.sample(SEA, 0);
    const second = sampler.sample(SEA, 0);
    expect(second).toBe(first);
  });
});
