import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  canUseDeskPointer,
  DeskPointer,
} from '../src/player/DeskPointer';
import { REACH } from '../src/player/Interactables';
import {
  cabinBarometerTarget,
  captainsSeatPose,
} from '../src/vessel/schooner/captainsDesk';
import { deskItems } from '../src/vessel/schooner/deskItems';

describe('player object actions outside the ship registry', () => {
  it('exposes the desk pointer only while embodied at the captain\'s desk', () => {
    expect(canUseDeskPointer({ seated: true, atDesk: true, embodied: true })).toBe(true);
    expect(canUseDeskPointer({ seated: false, atDesk: true, embodied: true })).toBe(false);
    expect(canUseDeskPointer({ seated: true, atDesk: false, embodied: true })).toBe(false);
    expect(canUseDeskPointer({ seated: true, atDesk: true, embodied: false })).toBe(false);
  });

  it('requires both explicit cursor gaze and arm-and-step reach at the desk', () => {
    const element = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    } as unknown as HTMLElement;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -1);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const pointer = new DeskPointer();
    const shipMatrixWorld = new THREE.Matrix4();
    const near = {
      box: { xLo: -0.2, xHi: 0.2, yLo: -0.2, yHi: 0.2, zLo: -1.1, zHi: -0.9 },
      value: 'near',
    };
    const far = {
      box: { xLo: -0.2, xHi: 0.2, yLo: -0.2, yHi: 0.2, zLo: -3.2, zHi: -3 },
      value: 'far',
    };

    expect(pointer.pick(500, 500, element, camera, shipMatrixWorld, [near], REACH))
      .toBe('near');
    expect(pointer.pick(900, 500, element, camera, shipMatrixWorld, [near], REACH))
      .toBeNull();
    expect(pointer.pick(500, 500, element, camera, shipMatrixWorld, [far], REACH))
      .toBeNull();
  });

  it('keeps every authored desk target inside the seated eye reach cap', () => {
    const eye = captainsSeatPose();
    const targets = [
      ...deskItems().map((item) => ({ name: item.name, box: item.box })),
      { name: 'barometer', box: cabinBarometerTarget().box },
    ];
    for (const target of targets) {
      const distance = Math.hypot(
        Math.max(target.box.xLo - eye.x, 0, eye.x - target.box.xHi),
        Math.max(target.box.yLo - eye.y, 0, eye.y - target.box.yHi),
        Math.max(target.box.zLo - eye.z, 0, eye.z - target.box.zHi),
      );
      expect(distance, `${target.name} exceeds seated reach`).toBeLessThanOrEqual(REACH);
    }
  });

  it('wires the desk station gate and exposes the object mast callback only on the raft', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toMatch(
      /canUseDeskPointer\(\{[\s\S]*?atDesk: occupiedStation\(\) === 'deskChair'[\s\S]*?embodied: cameras\.modeName === 'embodied'/,
    );
    expect(main).toContain('onTapSail: raftEnabled ? () => wind.toggleSail() : undefined');
    expect(main).toContain('driftSail: isTouch ? raftEnabled : driftSailVessel');
  });
});
