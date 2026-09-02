import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  IBL_RADIANCE_ANCHOR,
  PORTAL_LIGHT_CHANNELS,
  createWorldPbrMaterial,
  getPortalLightMix,
  sampleWorldShIrradiance,
  setPortalLight,
  setPortalLightMix,
  setWorldSh,
  worldLightsFragmentMaps,
} from '../src/scene/WorldPbrMaterial';
import { SH_FLOAT_COUNT, shIrradiance } from '../src/scene/sphericalHarmonics';
import { Schooner } from '../src/vessel/schooner/Schooner';
import {
  SKY_VISIBILITY_ATTRIBUTE,
  hasPortalLightAttributes,
} from '../src/vessel/schooner/interiorLightBake';
import {
  CABIN_SOLE_Y,
  FORECASTLE_SOLE_Y,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
} from '../src/vessel/schooner/hullForm';
import {
  belowDecksSpace,
  spaceDeckheadY,
} from '../src/vessel/schooner/deckInterior';
import { isClosureOpen, setClosureOpen } from '../src/vessel/schooner/closures';

/**
 * The runtime half of the portal light: the shader plumbing, the CPU probe
 * mirror, the vessel-level attribute guarantee, and the portal culling.
 */

describe('the portal shader path', () => {
  it('guards the portal branch behind its define in the lighting chunk', () => {
    const chunk = worldLightsFragmentMaps();
    expect(chunk).toContain('#ifdef WORLD_PBR_PORTAL_LIGHT');
    expect(chunk).toContain('uPortalIrradiance[ 0 ]');
    expect(chunk).toContain('uPortalBounce[ 3 ]');
    // The legacy line survives verbatim on the else branch, so a material
    // without the define compiles to exactly the old model.
    expect(chunk).toContain('iblIrradiance += uSkyVisibility * shGetIrradianceAt( worldGeometryNormal, uWorldSh );');
    // And the environment reflection is scaled through the same A/B mix.
    expect(chunk).toContain('mix( 1.0, vWorldSkyVisibility, uPortalMix ) * getIBLRadiance');
  });

  it('still finds the radiance anchor in three\'s own chunk', () => {
    expect(THREE.ShaderChunk.lights_fragment_maps).toContain(IBL_RADIANCE_ANCHOR);
  });

  it('wires attributes, varyings and uniforms only for opted-in materials', () => {
    const plain = createWorldPbrMaterial({ name: 'test:plain' });
    expect(plain.defines).not.toHaveProperty('WORLD_PBR_PORTAL_LIGHT');

    const portal = createWorldPbrMaterial({ name: 'test:portal', portalLight: true });
    expect(portal.defines).toHaveProperty('WORLD_PBR_PORTAL_LIGHT');

    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    portal.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.uniforms.uPortalIrradiance).toBeDefined();
    expect(shader.uniforms.uPortalBounce).toBeDefined();
    expect(shader.uniforms.uPortalMix).toBeDefined();
    expect(shader.vertexShader).toContain('attribute vec4 aPortalDirect;');
    expect(shader.vertexShader).toContain('vWorldPortalDirect = aPortalDirect;');
    expect(shader.fragmentShader).toContain('uniform vec3 uPortalIrradiance');

    const plainShader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    plain.onBeforeCompile(
      plainShader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(plainShader.uniforms.uPortalIrradiance).toBeUndefined();
    expect(plainShader.vertexShader).not.toContain('vWorldPortalDirect = aPortalDirect;');

    plain.dispose();
    portal.dispose();
  });

  it('publishes one shared generation of channel light by reference', () => {
    const portal = createWorldPbrMaterial({ name: 'test:portal2', portalLight: true });
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    portal.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    const irradiance = new THREE.Vector3(1, 2, 3);
    const bounce = new THREE.Vector3(0.5, 0.4, 0.3);
    setPortalLight(2, irradiance, bounce);
    const uniforms = shader.uniforms.uPortalIrradiance.value as THREE.Vector3[];
    expect(uniforms).toHaveLength(PORTAL_LIGHT_CHANNELS);
    expect(uniforms[2].x).toBe(1);
    expect((shader.uniforms.uPortalBounce.value as THREE.Vector3[])[2].z).toBe(0.3);
    // Copied in, not retained: the caller's scratch cannot mutate a uniform.
    irradiance.set(9, 9, 9);
    expect(uniforms[2].x).toBe(1);
    portal.dispose();
  });

  it('clamps and reports the A/B mix', () => {
    setPortalLightMix(2);
    expect(getPortalLightMix()).toBe(1);
    setPortalLightMix(-1);
    expect(getPortalLightMix()).toBe(0);
    setPortalLightMix(1);
    expect(getPortalLightMix()).toBe(1);
  });
});

describe('the CPU probe mirror', () => {
  it('agrees with the canonical SH irradiance at arbitrary directions', () => {
    // Deterministic pseudo-random coefficients: the mirror must reproduce
    // three's own basis exactly, sign conventions included.
    const sh = new Float32Array(SH_FLOAT_COUNT);
    for (let i = 0; i < sh.length; i++) sh[i] = Math.sin(i * 12.9898) * 0.5;
    setWorldSh(sh);

    const out = new THREE.Vector3();
    const reference: [number, number, number] = [0, 0, 0];
    const directions = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [0.36, 0.48, 0.8],
      [-0.6, 0.64, -0.48],
    ] as const;
    for (const [x, y, z] of directions) {
      sampleWorldShIrradiance(new THREE.Vector3(x, y, z), out);
      shIrradiance(sh, x, y, z, reference);
      expect(out.x).toBeCloseTo(reference[0], 6);
      expect(out.y).toBeCloseTo(reference[1], 6);
      expect(out.z).toBeCloseTo(reference[2], 6);
    }
    setWorldSh(new Float32Array(SH_FLOAT_COUNT));
  });
});


/**
 * The baked open-sky fraction at a raycast hit, **interpolated the way the
 * vertex stage interpolates it** rather than maxed over the face.
 *
 * The distinction matters and the max version is wrong: a fitting's box face
 * that crosses the planking has one vertex in daylight and one enclosed by
 * construction, so `Math.max` reports 1 for every such face and flags the
 * accepted shadow line as a leak. `interiorLightBake.ts` says so directly —
 * *"fragments across the deck line interpolate over one vertex gap, which
 * lands exactly where a real shadow line would sit"*. What a pixel actually
 * renders with is the barycentric blend, so that is what this measures.
 */
function skyVisibilityAtHit(hit: THREE.Intersection): number {
  const geometry = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry;
  const sky = geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
  const position = geometry.getAttribute('position');
  const face = hit.face;
  if (!sky || !position || !face) return 0;

  const a = new THREE.Vector3().fromBufferAttribute(position, face.a);
  const b = new THREE.Vector3().fromBufferAttribute(position, face.b);
  const c = new THREE.Vector3().fromBufferAttribute(position, face.c);
  const local = (hit.object as THREE.Mesh).worldToLocal(hit.point.clone());
  const weights = new THREE.Vector3();
  THREE.Triangle.getBarycoord(local, a, b, c, weights);

  return (
    sky.getX(face.a) * weights.x +
    sky.getX(face.b) * weights.y +
    sky.getX(face.c) * weights.z
  );
}

describe('the schooner keeps the attribute contract', () => {
  const ship = new Schooner({ advancesWaveField: false });

  it('bakes every geometry its portal-lit materials draw', () => {
    const portalLit: string[] = [];
    ship.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.MeshStandardMaterial;
      if (!material.defines || !('WORLD_PBR_PORTAL_LIGHT' in material.defines)) return;
      portalLit.push(object.name);
      expect(
        hasPortalLightAttributes(object.geometry as THREE.BufferGeometry),
        `${object.name} draws with a portal-lit material but was never baked`,
      ).toBe(true);
    });
    // The whole below-decks family, and the spars for the masts.
    expect(portalLit).toContain('ship:interiorSole');
    expect(portalLit).toContain('ship:interiorLining');
    expect(portalLit).toContain('interior:timber');
    expect(portalLit).toContain('interior:boards:open');
    expect(portalLit).toContain('interior:boards:shut');
    // The scuttle's lid is an *exterior* fitting and is deliberately not in
    // the interior family — but it still draws through a portal-lit material,
    // so it still has to carry the attributes. An unbound `aPortalChannel4`
    // defaults to (0,0,0,1) in WebGL, which would light it with the scuttle's
    // own bounce channel at full strength.
    expect(portalLit).toContain('fitting:scuttleLid:open');
    expect(portalLit).toContain('fitting:scuttleLid:shut');
    expect(portalLit.filter((name) => name === 'rig:spar').length).toBeGreaterThan(0);
  });

  /**
   * **The deadlights are drawn by the closure state and by nothing else.**
   *
   * One state and hidden, which is the fore scuttle soffit's case rather than
   * the hatchway boards': unshipped, the shutters are inside the stern lockers
   * and there is nothing to draw. So the assertion is a pair — shipped, every
   * one of the three material meshes is up; unshipped, every one is down — and
   * it goes through `syncClosures`, which reads `closures.ts` rather than
   * taking an argument. A mesh set from anywhere else could show a shut
   * shutter over a window the light model was still pouring daylight through.
   */
  it('draws the deadlights only while they are shipped', () => {
    ship.group.updateMatrixWorld(true);
    const shutters = ship.group.children.filter((o) =>
      o.name.startsWith('interior:deadlight:'),
    ) as THREE.Mesh[];
    expect(shutters.length, 'no deadlight meshes on the vessel').toBeGreaterThanOrEqual(3);
    const was = isClosureOpen('sternDeadlights');
    // The camera has to be looking below decks, or the portal culling composes
    // its own `false` over the top and the test proves nothing either way.
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
    camera.position.set(0, CABIN_SOLE_Y + 1.6, -5.5);
    camera.lookAt(0, CABIN_SOLE_Y + 1.4, -7.6);
    camera.updateMatrixWorld(true);
    ship.updateInteriorVisibility(camera);
    try {
      setClosureOpen('sternDeadlights', false);
      ship.syncClosures();
      for (const mesh of shutters) {
        expect(mesh.visible, `${mesh.name} is not drawn when shipped`).toBe(true);
      }
      setClosureOpen('sternDeadlights', true);
      ship.syncClosures();
      for (const mesh of shutters) {
        expect(mesh.visible, `${mesh.name} is still drawn when unshipped`).toBe(false);
      }
    } finally {
      setClosureOpen('sternDeadlights', was);
      ship.syncClosures();
    }
  });

  it('culls the interior only when no opening is on screen', () => {
    ship.group.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
    const interiorMesh = ship.group.children.find(
      (o) => o.name === 'ship:interiorLining',
    ) as THREE.Mesh;
    expect(interiorMesh).toBeDefined();

    const look = (
      position: [number, number, number],
      target: [number, number, number],
    ): void => {
      camera.position.set(...position);
      camera.lookAt(...target);
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      ship.updateInteriorVisibility(camera);
    };

    // Standing in the captain's cabin: below decks, always visible.
    look([0, CABIN_SOLE_Y + 1.6, -5.5], [0, CABIN_SOLE_Y + 1.4, -3]);
    expect(interiorMesh.visible).toBe(true);
    expect(ship.interiorCullingActive).toBe(false);

    // On the foredeck looking out over the bow: no opening in the frustum.
    look([0, 5.2, 6.0], [0, 5.0, 60]);
    expect(interiorMesh.visible).toBe(false);
    expect(ship.interiorCullingActive).toBe(true);

    // On the quarterdeck looking down the companionway.
    look([0, 5.4, -4.6], [0.9, 4.0, -3.0]);
    expect(interiorMesh.visible).toBe(true);

    // Astern of her, looking at the stern windows.
    look([0, 4.0, -20], [0, 3.9, 0]);
    expect(interiorMesh.visible).toBe(true);

    // The debug switch draws the interior unconditionally.
    look([0, 5.2, 6.0], [0, 5.0, 60]);
    expect(interiorMesh.visible).toBe(false);
    ship.setInteriorCullingEnabled(false);
    expect(interiorMesh.visible).toBe(true);
    ship.setInteriorCullingEnabled(true);
    expect(interiorMesh.visible).toBe(false);
  });

  it('shows the scuttle lid the crew actually left, in both states', () => {
    const shut = ship.group.children.find(
      (o) => o.name === 'fitting:scuttleLid:shut',
    ) as THREE.Mesh;
    const open = ship.group.children.find(
      (o) => o.name === 'fitting:scuttleLid:open',
    ) as THREE.Mesh;
    expect(shut).toBeDefined();
    expect(open).toBeDefined();
    const was = isClosureOpen('foreScuttleLid');
    try {
      setClosureOpen('foreScuttleLid', false);
      ship.syncClosures();
      expect(shut.visible).toBe(true);
      expect(open.visible).toBe(false);

      setClosureOpen('foreScuttleLid', true);
      ship.syncClosures();
      expect(shut.visible).toBe(false);
      expect(open.visible).toBe(true);
    } finally {
      setClosureOpen('foreScuttleLid', was);
      ship.syncClosures();
    }
  });

  /**
   * **The lid is on the weather deck, so it must NOT ride interior culling.**
   *
   * The boards do — they are below decks and vanish with the rooms. This one
   * shares a `syncClosures` with them and the easy mistake is to hang it off
   * `applyInteriorVisibility` beside them, which would make a lid lying in
   * open daylight disappear whenever no opening was on screen.
   */
  it('keeps the lid drawn when the interior is culled away', () => {
    ship.group.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
    const interiorMesh = ship.group.children.find(
      (o) => o.name === 'ship:interiorLining',
    ) as THREE.Mesh;
    const shut = ship.group.children.find(
      (o) => o.name === 'fitting:scuttleLid:shut',
    ) as THREE.Mesh;
    const was = isClosureOpen('foreScuttleLid');
    try {
      setClosureOpen('foreScuttleLid', false);
      // Well clear of the ship, looking away: no opening on screen at all.
      camera.position.set(0, 5.2, 6.0);
      camera.lookAt(0, 5.0, 60);
      camera.updateMatrixWorld(true);
      ship.updateInteriorVisibility(camera);
      ship.syncClosures();
      expect(interiorMesh.visible).toBe(false);
      expect(shut.visible).toBe(true);
    } finally {
      setClosureOpen('foreScuttleLid', was);
      ship.syncClosures();
    }
  });

  /**
   * **With the scuttle shut, the forecastle must not see one exterior surface.**
   *
   * This is the second half of Ash's *"the forecastle should not be lit by the
   * hatch opening if the hatch is closed"*. Gating `CHANNEL_SCUTTLE` fixed the
   * light model; it could not fix this, because the coaming and the lid stand
   * *above* the planking and `bakeFittingPortalLight` therefore hands them full
   * sky — correctly, they are in daylight — while the deckhead below them is
   * cut and the room looks straight up at them.
   *
   * Two shapes of the soffit were not enough, and the second is why this test
   * casts rays rather than checking a dimension: a panel spanning the
   * deckhead's own range still let a shallow sight line **graze its top corner**
   * and reach `fitting:scuttleLid:shut` at vessel (−1.186, 4.149, 2.721). A
   * plug that stops inside the hole can always be got past by some angle, and
   * only a sweep finds the angle.
   *
   * **Budget.** This is the heaviest test in `npm test` and it was the last one
   * still riding the bare 60 s default. The sweep is the point of it, so the
   * cost is not going away, and on a quiet tree it already uses about half the
   * default. That is not enough margin: the suite runs in parallel workers on a
   * machine that routinely carries other agent sessions, contention has been
   * measured at 3-6x wall-clock inflation (see `vite.config.ts`), and this test
   * duly timed out at 60 s during the correctness round while other sessions
   * were running. It failed on the clock, not on a ray. 240 s is roughly eight
   * times the quiet cost — headroom, not a target. If it ever approaches that,
   * something has changed about the sweep and not about the machine.
   */
  it('shows the shut forecastle no sunlit fitting through its own deckhead', {
    timeout: 240_000,
  }, () => {
    ship.group.updateMatrixWorld(true);
    const was = isClosureOpen('foreScuttleLid');
    try {
      setClosureOpen('foreScuttleLid', false);
      ship.syncClosures();

      const raycaster = new THREE.Raycaster();
      const origin = new THREE.Vector3();
      const direction = new THREE.Vector3();
      const offenders = new Set<string>();
      const forecastle = belowDecksSpace('forecastle');
      let cast = 0;

      // An eye standing anywhere in the after half of the forecastle, looking
      // up and around: every direction that can see the scuttle at all.
      for (let ex = -1.6; ex <= 0.81; ex += 0.4) {
        for (let ez = 2.8; ez <= 4.81; ez += 0.4) {
          origin.set(ex, FORECASTLE_SOLE_Y + 1.6, ez);
          for (let a = 0; a < 24; a++) {
            const azimuth = (a / 24) * Math.PI * 2;
            for (const elevation of [0.15, 0.35, 0.6, 0.9, 1.25]) {
              direction
                .set(
                  Math.cos(azimuth) * Math.cos(elevation),
                  Math.sin(elevation),
                  Math.sin(azimuth) * Math.cos(elevation),
                )
                .normalize();
              raycaster.set(origin, direction);
              cast++;
              const hit = raycaster.intersectObject(ship.group, true)[0];
              if (!hit) continue;
              if (!/scuttleLid|^fitting:/.test(hit.object.name)) continue;
              // **The predicate is baked sky visibility, not the mesh's name.**
              // A fitting's foot below the planking is baked enclosed and is
              // dark timber overhead — seeing it is correct. What the room must
              // never see is a surface still carrying open sky, which is what
              // "lit like daylight through a shut hatch" actually means.
              // Half, not zero: a fragment right on the deck line legitimately
              // blends between enclosed and open over one vertex gap, and that
              // band is the shadow line rather than a leak. Anything the room
              // can see that is *mostly* in daylight is the fault.
              if (skyVisibilityAtHit(hit) < 0.5) continue;
              // **Only what is seen THROUGH the scuttle.** `fitting:timber` is
              // one merged mesh for the whole deck, so the name alone cannot
              // tell the scuttle's coaming from the foremast partner — whose
              // feet reach below the planking further forward and glow into
              // this same room. That is §15.5 item 5, it predates the scuttle,
              // and it is not what this guard is about. The scuttle's own leak
              // is a hit inside its footprint and above the room's ceiling.
              const p = ship.group.worldToLocal(hit.point.clone());
              const ceiling = spaceDeckheadY(forecastle, p.x, p.z);
              if (ceiling === null || p.y < ceiling) continue;
              if (Math.abs(p.x - FORE_SCUTTLE_X) > FORE_SCUTTLE_HALF_BREADTH + 0.12) continue;
              if (Math.abs(p.z - FORE_SCUTTLE_Z) > FORE_SCUTTLE_HALF_BREADTH + 0.12) continue;
              offenders.add(
                `${hit.object.name} at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})` +
                  ` from (${ex.toFixed(1)}, ${ez.toFixed(1)})`,
              );
            }
          }
        }
      }

      expect(cast).toBeGreaterThan(1000);
      expect([...offenders].slice(0, 5).join('\n')).toBe('');
    } finally {
      setClosureOpen('foreScuttleLid', was);
      ship.syncClosures();
    }
  });

  it('composes culling with the boards closure instead of racing it', () => {
    ship.group.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 200);
    const shut = ship.group.children.find(
      (o) => o.name === 'interior:boards:shut',
    ) as THREE.Mesh;
    const open = ship.group.children.find(
      (o) => o.name === 'interior:boards:open',
    ) as THREE.Mesh;
    const wasOpen = isClosureOpen('hatchwayBoards');
    try {
      setClosureOpen('hatchwayBoards', false);
      camera.position.set(0, 3.0, 1.4); // in the wardroom, below decks
      camera.lookAt(0, 2.5, 2.4);
      camera.updateMatrixWorld(true);
      ship.updateInteriorVisibility(camera);
      ship.syncClosures();
      expect(shut.visible).toBe(true);
      expect(open.visible).toBe(false);

      setClosureOpen('hatchwayBoards', true);
      ship.syncClosures();
      expect(shut.visible).toBe(false);
      expect(open.visible).toBe(true);
    } finally {
      setClosureOpen('hatchwayBoards', wasOpen);
      ship.syncClosures();
    }
  });
});
