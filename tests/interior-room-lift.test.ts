import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  PORTAL_LIGHT_ROOM_SLOTS,
  createWorldPbrMaterial,
  getRoomLift,
  getRoomLiftMix,
  setRoomLift,
  setRoomLiftMix,
} from '../src/scene/WorldPbrMaterial';
import {
  LIGHT_ROOM_ORDER,
  VERTEX_ROOM_NUDGE,
  lightRoomAt,
  lightRoomIndexOf,
} from '../src/vessel/schooner/interiorLight';
import {
  ROOM_INDEX_ATTRIBUTE,
  SKY_VISIBILITY_ATTRIBUTE,
  bakeEnclosedPortalLight,
  hasPortalLightAttributes,
} from '../src/vessel/schooner/interiorLightBake';
import {
  INTERIOR_REGIONS,
  buildShipGeometry,
} from '../src/vessel/schooner/shipGeometry';
import { Schooner } from '../src/vessel/schooner/Schooner';

/**
 * The room-lift mode: fixed per-room constants on the SURFACES, the camera
 * retired to ×1. The design promise under test is separation — the lift may
 * touch only the baked portal sum, so the sky through a window, the sun's
 * beam and the lantern render at the scene's own exposure whatever the dials
 * say, at 14:00 and at 22:00 alike.
 */

describe('the room index encoding', () => {
  it('is the stable aft-to-forward order the bake writes against', () => {
    // Baked data means "index into this list"; a reorder silently re-rooms
    // every vessel built after it. Append, never reorder.
    expect(LIGHT_ROOM_ORDER).toEqual([
      'cabin',
      'landing',
      'wardroom',
      'hold',
      'forecastle',
    ]);
  });

  it('reserves slot 0 for outdoors and counts rooms from 1', () => {
    expect(lightRoomIndexOf(null)).toBe(0);
    LIGHT_ROOM_ORDER.forEach((room, i) => {
      expect(lightRoomIndexOf(room)).toBe(i + 1);
    });
  });

  it('agrees with the scene module about how many slots exist', () => {
    // WorldPbrMaterial deliberately does not import the room list; this is
    // the assertion that holds the two counts together.
    expect(PORTAL_LIGHT_ROOM_SLOTS).toBe(LIGHT_ROOM_ORDER.length + 1);
  });
});

describe('the baked room index', () => {
  const built = buildShipGeometry();
  const lining = built.geometries.get('interiorLining')!;
  bakeEnclosedPortalLight(lining);

  it('is part of the portal attribute contract', () => {
    expect(hasPortalLightAttributes(lining)).toBe(true);
    const index = lining.getAttribute(ROOM_INDEX_ATTRIBUTE);
    expect(index.itemSize).toBe(1);
    expect(index.count).toBe(lining.getAttribute('position').count);

    const stripped = lining.clone();
    stripped.deleteAttribute(ROOM_INDEX_ATTRIBUTE);
    expect(hasPortalLightAttributes(stripped)).toBe(false);
  });

  it('matches the nudged room lookup vertex for vertex', () => {
    // The same query vertexLightResponse resolves its room with — a vertex
    // must never carry one room's light and another room's lift.
    const position = lining.getAttribute('position');
    const normal = lining.getAttribute('normal');
    const sky = lining.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
    const index = lining.getAttribute(ROOM_INDEX_ATTRIBUTE);
    let indexed = 0;
    for (let i = 0; i < position.count; i++) {
      if (sky.getX(i) >= 1) {
        expect(index.getX(i)).toBe(0);
        continue;
      }
      const expected = lightRoomIndexOf(
        lightRoomAt(
          position.getX(i) + normal.getX(i) * VERTEX_ROOM_NUDGE,
          position.getY(i) + normal.getY(i) * VERTEX_ROOM_NUDGE,
          position.getZ(i) + normal.getZ(i) * VERTEX_ROOM_NUDGE,
        ),
      );
      expect(index.getX(i)).toBe(expected);
      if (expected > 0) indexed++;
    }
    // The lining is the rooms' own walls: most of it must resolve to a room,
    // or the lift dials would be turning nothing.
    expect(indexed).toBeGreaterThan(position.count * 0.5);
  });

  it('rooms every interior region it can see a room for', () => {
    for (const region of INTERIOR_REGIONS) {
      const geometry = built.geometries.get(region)!;
      if (geometry === lining) continue;
      bakeEnclosedPortalLight(geometry);
      const index = geometry.getAttribute(ROOM_INDEX_ATTRIBUTE);
      for (let i = 0; i < index.count; i++) {
        const v = index.getX(i);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(PORTAL_LIGHT_ROOM_SLOTS);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });
});

describe('the lift dials', () => {
  it('pins slot 0 (outdoors) at exactly 1', () => {
    setRoomLift(0, 25);
    expect(getRoomLift(0)).toBe(1);
  });

  it('clamps a dial into [1, 100] and reads it back', () => {
    setRoomLift(1, 12.5);
    expect(getRoomLift(1)).toBe(12.5);
    setRoomLift(1, 0.2);
    expect(getRoomLift(1)).toBe(1);
    setRoomLift(1, 1e6);
    expect(getRoomLift(1)).toBe(100);
    setRoomLift(1, 12.5);
  });

  it('ignores slots that do not exist', () => {
    setRoomLift(PORTAL_LIGHT_ROOM_SLOTS, 30);
    setRoomLift(-1, 30);
    setRoomLift(1.5, 30);
    expect(getRoomLift(PORTAL_LIGHT_ROOM_SLOTS)).toBe(1);
  });

  it('wires the lift uniforms into opted-in materials', () => {
    const portal = createWorldPbrMaterial({ name: 'test:room-lift', portalLight: true });
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    portal.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.uniforms.uRoomLift).toBeDefined();
    expect(shader.uniforms.uRoomLiftMix).toBeDefined();
    expect(shader.vertexShader).toContain('attribute float aRoomIndex;');
    expect(shader.vertexShader).toContain(
      'vWorldRoomLift = mix( 1.0, uRoomLift[ int( aRoomIndex + 0.5 ) ], uRoomLiftMix );',
    );
    expect(shader.fragmentShader).toContain(
      'iblIrradiance += uPortalMix * vWorldRoomLift * worldPortalLight;',
    );
    portal.dispose();
  });
});

describe('the vessel in room-lift mode', () => {
  const ship = new Schooner({ advancesWaveField: false });
  // Construction pushed the mix; re-assert it here so this suite does not
  // depend on what ran between collection and execution.
  beforeAll(() => ship.setAdaptationMode('room-lift'));
  afterAll(() => setRoomLiftMix(0));

  it('ships the mode on, dials pushed, camera retired to exactly 1', () => {
    expect(ship.adaptationDebug().mode).toBe('room-lift');
    expect(getRoomLiftMix()).toBe(1);
    // The whole point: no interior multiplier on the frame, so the night sky
    // through the stern windows renders at its authored exposure.
    expect(ship.interiorEyeAdaptation()).toBe(1);
    for (const room of LIGHT_ROOM_ORDER) {
      expect(ship.roomLift(room)).toBeGreaterThanOrEqual(1);
    }
  });

  it('holds the shader lift at ×1 for every camera mode, and back', () => {
    ship.setAdaptationMode('gaze');
    expect(getRoomLiftMix()).toBe(0);
    ship.setAdaptationMode('fixed');
    expect(getRoomLiftMix()).toBe(0);
    ship.setAdaptationMode('metered');
    expect(getRoomLiftMix()).toBe(0);
    ship.setAdaptationMode('room-lift');
    expect(getRoomLiftMix()).toBe(1);
  });

  it('round-trips a dial by room name', () => {
    const before = ship.roomLift('cabin');
    ship.setRoomLift('cabin', 17);
    expect(ship.roomLift('cabin')).toBe(17);
    expect(ship.roomLifts().cabin).toBe(17);
    ship.setRoomLift('cabin', before);
  });
});
