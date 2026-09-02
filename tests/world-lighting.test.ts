import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DITHERING_FRAGMENT_ANCHOR,
  IBL_IRRADIANCE_ANCHOR,
  OPAQUE_FRAGMENT_ANCHOR,
  PHYSICAL_IRRADIANCE_GUARD,
  WORLD_DEBUG_VIEWS,
  createWorldPbrMaterial,
  worldDebugFragmentShader,
  worldLightsFragmentMaps,
} from '../src/scene/WorldPbrMaterial';
import {
  SH_FLOAT_COUNT,
  cosineConvolveEquirect,
  equirectDirection,
  equirectSolidAngleSum,
  projectEquirectToSh,
  shIrradiance,
} from '../src/scene/sphericalHarmonics';

/**
 * The normalisation pins for the world lighting probe.
 *
 * The design's verification section asked for a "constant-environment test"
 * under a uniform white source. It could not be written as specified: these
 * tests run in node with no WebGL anywhere in the suite, and a test that needs
 * a GPU to evaluate is a test that never runs. So the projection was written as
 * a pure function over pixel data and the GPU keeps only the job of producing
 * pixels. What is asserted here is the whole of the diffuse path's arithmetic;
 * what is left for the browser lab is that the render target contains what we
 * think it contains.
 *
 * The point of pinning the normalisation is narrow and worth stating. Diffuse
 * and specular are two convolutions of ONE source. If either one carries a
 * stray gain, they stop being two views of the same light and become two look
 * multipliers wearing physics as a costume — which is the exact failure the
 * round is unwinding.
 */

const WIDTH = 128;
const HEIGHT = 64;

/** Directions to check, including the poles the equirect map degenerates at. */
const NORMALS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0.5773, 0.5773, 0.5773],
  [-0.5773, 0.5773, -0.5773],
  [0.7071, 0.7071, 0],
];

function fill(
  width: number,
  height: number,
  radiance: (x: number, y: number, z: number) => [number, number, number],
): Float32Array {
  const data = new Float32Array(width * height * 4);
  const dir: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      equirectDirection((i + 0.5) / width, (j + 0.5) / height, dir);
      const [r, g, b] = radiance(dir[0], dir[1], dir[2]);
      const p = (j * width + i) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 1;
    }
  }
  return data;
}

/**
 * Precision floor of the source map itself.
 *
 * The map is a half-float render target: 10 bits of mantissa, so ~4.9e-4
 * relative quantisation per texel. No tolerance below this is measuring
 * anything real, and the quadrature is deliberately not refined past it — see
 * the residual note in the constant-environment block.
 */
const HALF_FLOAT_EPSILON = 4.9e-4;

describe('equirect quadrature', () => {
  it('sums to exactly 4pi at every resolution', () => {
    // Not "close to" in the loose sense: the row weights are exact band
    // integrals, so this is a floating-point identity, not a convergence
    // property. Asserted at three resolutions because the failure mode being
    // guarded is a quadrature whose gain depends on map size — which would
    // silently rescale the whole world's diffuse light the day someone changes
    // WORLD_SOURCE_HEIGHT.
    expect(equirectSolidAngleSum(WIDTH, HEIGHT)).toBeCloseTo(4 * Math.PI, 10);
    expect(equirectSolidAngleSum(16, 8)).toBeCloseTo(4 * Math.PI, 10);
    expect(equirectSolidAngleSum(512, 256)).toBeCloseTo(4 * Math.PI, 10);
  });

  it('places v=0 at the nadir and v=1 at the zenith', () => {
    const dir: [number, number, number] = [0, 0, 0];
    expect(equirectDirection(0.5, 0.001, dir)[1]).toBeLessThan(-0.99);
    expect(equirectDirection(0.5, 0.999, dir)[1]).toBeGreaterThan(0.99);
  });

  it("matches three's equirectUv round trip", () => {
    // u = atan(z, x)/2pi + 0.5, v = asin(y)/pi + 0.5 — the mapping
    // PMREMGenerator assumes. If this drifts, specular and diffuse come out of
    // register with each other.
    const dir: [number, number, number] = [0, 0, 0];
    for (const [u, v] of [
      [0.13, 0.42],
      [0.77, 0.61],
      [0.5, 0.5],
    ]) {
      equirectDirection(u, v, dir);
      const backU = Math.atan2(dir[2], dir[0]) / (2 * Math.PI) + 0.5;
      const backV = Math.asin(dir[1]) / Math.PI + 0.5;
      expect(backU).toBeCloseTo(u, 6);
      expect(backV).toBeCloseTo(v, 6);
    }
  });
});

describe('constant environment', () => {
  const L = 0.37;
  const data = fill(WIDTH, HEIGHT, () => [L, L, L]);
  const sh = projectEquirectToSh(data, WIDTH, HEIGHT, new Float32Array(SH_FLOAT_COUNT));

  it('gives pi * L irradiance in every direction', () => {
    // The one number in the lighting system with an exactly known right answer.
    // Measured relative error is 1.3e-4, below the map's own half-float
    // quantisation.
    const out: [number, number, number] = [0, 0, 0];
    for (const [x, y, z] of NORMALS) {
      shIrradiance(sh, x, y, z, out);
      for (const channel of out) {
        expect(Math.abs(channel / (Math.PI * L) - 1)).toBeLessThan(HALF_FLOAT_EPSILON);
      }
    }
  });

  it('puts essentially all the energy in band 0', () => {
    // Bands 1 and 2 of a constant field are analytically zero. A large residual
    // would mean the basis and the mapping disagree about which way is up, and
    // would show as a phantom directional bias in the fill — a bug that reads
    // as "the lighting looks a bit off" forever.
    //
    // What survives is small and is NOT a gain: the row weights are exact, but
    // the basis functions are still point-sampled at row centres, so band 2's
    // (3z^2 - 1) keeps a 1.9e-4 residual relative to band 0. Integrating the
    // basis per row as well would remove it. That is deliberately not done:
    // 1.9e-4 is four times finer than the half-float source map it will be fed
    // from, so refining it further is measuring below the noise floor of the
    // data. It is bounded here so it cannot grow unnoticed.
    for (let k = 3; k < SH_FLOAT_COUNT; k++) {
      expect(Math.abs(sh[k]) / Math.abs(sh[0])).toBeLessThan(HALF_FLOAT_EPSILON);
    }
  });

  it('agrees with brute-force cosine convolution', () => {
    const out: [number, number, number] = [0, 0, 0];
    cosineConvolveEquirect(data, WIDTH, HEIGHT, 0, 1, 0, out);
    expect(out[0]).toBeCloseTo(Math.PI * L, 3);
  });
});

describe('sky over sea', () => {
  // The shape the source map actually has: a bright, slightly horizon-brightened
  // sky above and a dim sea below, with a hard step between them. This is the
  // case the design flagged as a ringing risk.
  const data = fill(WIDTH, HEIGHT, (_x, y) => {
    if (y >= 0) {
      const horizon = 1 + 1.4 * Math.pow(1 - y, 2.0);
      return [0.42 * horizon, 0.56 * horizon, 0.9 * horizon];
    }
    return [0.02, 0.03, 0.045];
  });
  const sh = projectEquirectToSh(data, WIDTH, HEIGHT, new Float32Array(SH_FLOAT_COUNT));

  it('tracks the exact convolution within 3% on every normal a hull presents', () => {
    // The answer to the design's ringing risk, measured rather than assumed.
    //
    // L2 cannot represent a hard horizon step, and the received wisdom is that
    // this is a problem. Swept across elevation it is not: from straight up to
    // 25° below horizontal the SH reconstruction tracks the brute-force cosine
    // convolution to better than 1.5%, and most of that band is under 0.5%.
    // Every surface whose brightness a viewer actually reads — topsides and
    // wales near horizontal, deck and cap rail facing up — lives in here.
    const shOut: [number, number, number] = [0, 0, 0];
    const exact: [number, number, number] = [0, 0, 0];
    const dir: [number, number, number] = [0, 0, 0];

    for (let elevation = -25; elevation <= 90; elevation += 5) {
      const y = Math.sin((elevation * Math.PI) / 180);
      const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      for (let azimuth = 0; azimuth < 360; azimuth += 45) {
        const phi = (azimuth * Math.PI) / 180;
        dir[0] = horizontal * Math.cos(phi);
        dir[1] = y;
        dir[2] = horizontal * Math.sin(phi);
        shIrradiance(sh, dir[0], dir[1], dir[2], shOut);
        cosineConvolveEquirect(data, WIDTH, HEIGHT, dir[0], dir[1], dir[2], exact);
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(shOut[c] - exact[c]) / Math.max(exact[c], 1e-6)).toBeLessThan(0.03);
        }
      }
    }
  });

  it('over-lights the pure nadir by a bounded, documented amount', () => {
    // Where the step DOES cost something, so the cost is on the record rather
    // than discovered later as a mystery.
    //
    // A normal pointing straight down — the underside of the hull, the deep
    // corner of a bulwark — gets 29% more light than the exact convolution
    // gives, because L2 rounds the sky/sea step off into the lower hemisphere.
    // In absolute terms the overshoot is 0.04 against a zenith irradiance of
    // 3.5, about 1% of the scene's range, and it lands on surfaces that are in
    // shadow anyway. This is the same term the design books as future ambient
    // occlusion work; the number is here so that round starts with a
    // measurement instead of an impression.
    const shOut: [number, number, number] = [0, 0, 0];
    const exact: [number, number, number] = [0, 0, 0];
    shIrradiance(sh, 0, -1, 0, shOut);
    cosineConvolveEquirect(data, WIDTH, HEIGHT, 0, -1, 0, exact);
    const overshoot = shOut[2] / exact[2] - 1;
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThan(0.35);
  });

  it('never returns negative irradiance, including straight down', () => {
    const out: [number, number, number] = [0, 0, 0];
    for (let j = 0; j <= 32; j++) {
      for (let i = 0; i <= 32; i++) {
        const dir: [number, number, number] = [0, 0, 0];
        equirectDirection(i / 32, j / 32, dir);
        shIrradiance(sh, dir[0], dir[1], dir[2], out);
        for (const channel of out) expect(channel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps the sky brighter than the sea', () => {
    // The one qualitative thing the fill must never get wrong: an upward-facing
    // deck plank catches more light than the underside of a bulwark.
    const up: [number, number, number] = [0, 0, 0];
    const down: [number, number, number] = [0, 0, 0];
    shIrradiance(sh, 0, 1, 0, up);
    shIrradiance(sh, 0, -1, 0, down);
    expect(up[2]).toBeGreaterThan(down[2] * 3);
  });
});

describe('three shader chunk anchors', () => {
  // The design proposed "one test that fails loudly if the shader chunk we
  // anchor on changes" and assumed it would need a browser. It does not:
  // three's ShaderChunk is plain strings, so the whole containment story runs
  // in node alongside everything else.

  it('still contains the environment-irradiance line the adapter rewrites', () => {
    expect(THREE.ShaderChunk.lights_fragment_maps).toContain(IBL_IRRADIANCE_ANCHOR);
  });

  it('still guards iblIrradiance merging to LAMBERT and PHONG', () => {
    // The load-bearing one. For a MeshStandardMaterial, iblIrradiance reaches
    // diffuse only via RE_IndirectSpecular_Physical — which is what makes
    // injecting the probe there correct and a scene LightProbe redundant. If
    // three ever merges it for physical materials too, this adapter starts
    // double-counting the sky and the fix is to stop injecting, not to scale
    // anything down.
    expect(THREE.ShaderChunk.lights_fragment_end).toContain(PHYSICAL_IRRADIANCE_GUARD);
    const guardIndex = THREE.ShaderChunk.lights_fragment_end.indexOf(PHYSICAL_IRRADIANCE_GUARD);
    const mergeIndex = THREE.ShaderChunk.lights_fragment_end.indexOf(
      'irradiance += iblIrradiance;',
    );
    expect(mergeIndex).toBeGreaterThan(guardIndex);
  });

  it('produces a chunk that reads the world probe and not the environment', () => {
    const chunk = worldLightsFragmentMaps();
    expect(chunk).not.toContain('getIBLIrradiance');
    expect(chunk).toContain('shGetIrradianceAt');
    expect(chunk).toContain('uWorldSh');
    // The specular half must survive untouched — the PMREM is still the right
    // tool for glossy reflection and is the only reason a dark tarred hull
    // reads at all.
    expect(chunk).toContain('getIBLRadiance');
  });

  it('adds optional local diffuse transport without scaling the world probe', () => {
    const chunk = worldLightsFragmentMaps();
    expect(chunk).toContain('#ifdef WORLD_PBR_LOCAL_DIFFUSE_BOUNCE');
    expect(chunk).toContain('uLocalBounceIrradiance * localBounceWeight');
    expect(chunk).toContain('0.5 * ( 1.0 - dot( worldGeometryNormal');
    expect(chunk).toContain(
      'uSkyVisibility * shGetIrradianceAt( worldGeometryNormal, uWorldSh )',
    );
    expect(chunk).not.toMatch(
      /uSkyVisibility[^;]*uLocalBounceIrradiance/,
    );
  });

  it('retains one moving local-bounce state by reference across shader compilation', () => {
    const bounce = {
      irradiance: new THREE.Vector3(1, 2, 3),
      upWorld: new THREE.Vector3(0, 1, 0),
    };
    const material = createWorldPbrMaterial({ localDiffuseBounce: bounce });
    expect(material.defines).toHaveProperty(
      'WORLD_PBR_LOCAL_DIFFUSE_BOUNCE',
    );

    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.uniforms.uLocalBounceIrradiance.value).toBe(
      bounce.irradiance,
    );
    expect(shader.uniforms.uLocalBounceUpWorld.value).toBe(bounce.upWorld);
    material.dispose();
  });

  it('transforms the normal to world space at the injection site', () => {
    // The coefficients are world-space; `geometryNormal` is view-space. Three's
    // own getIBLIrradiance does this transform, and dropping it would rotate
    // the entire diffuse fill with the camera — the exact camera-dependence
    // this round exists to remove, reintroduced one layer down.
    expect(worldLightsFragmentMaps()).toContain('transformNormalByInverseViewMatrix');
    expect(THREE.ShaderChunk.common).toContain('vec3 transformNormalByInverseViewMatrix');
  });

  it('has shGetIrradianceAt available unconditionally', () => {
    // Defined in lights_pars_begin OUTSIDE the USE_LIGHT_PROBES guard, which is
    // what lets the adapter call it without adding a LightProbe to the scene.
    const chunk = THREE.ShaderChunk.lights_pars_begin;
    const guardIndex = chunk.indexOf('#if defined( USE_LIGHT_PROBES )');
    const endifIndex = chunk.indexOf('#endif', guardIndex);
    const functionIndex = chunk.indexOf('vec3 shGetIrradianceAt(');
    expect(functionIndex).toBeGreaterThan(endifIndex);
  });
});

describe('term diagnostics', () => {
  // Same containment story as the chunk anchors above, one layer out: the term
  // views are positioned RELATIVE to the tone curve, and that ordering lives in
  // meshphysical's main rather than in any chunk. Four of the seven views are
  // only meaningful because they are substituted before the curve and three are
  // only meaningful because they are written after it, so an upgrade that moves
  // either anchor must fail here rather than silently photograph the wrong
  // point in the chain.

  const physical = THREE.ShaderLib.physical.fragmentShader;

  it('still has the two anchors the diagnostics are positioned by', () => {
    expect(physical).toContain(OPAQUE_FRAGMENT_ANCHOR);
    expect(physical).toContain(DITHERING_FRAGMENT_ANCHOR);
  });

  it('keeps the tone curve between them', () => {
    // The load-bearing ordering. If tone mapping ever moved before
    // `opaque_fragment`, the four accumulator views would stop being
    // comparable with the beauty frame; if it moved after
    // `dithering_fragment`, `pre-tonemap linear` would stop being pre-tonemap.
    const opaque = physical.indexOf(OPAQUE_FRAGMENT_ANCHOR);
    const tone = physical.indexOf('#include <tonemapping_fragment>');
    const dither = physical.indexOf(DITHERING_FRAGMENT_ANCHOR);
    expect(tone).toBeGreaterThan(opaque);
    expect(dither).toBeGreaterThan(tone);
  });

  it('splices a block at each anchor without disturbing the display path', () => {
    const spliced = worldDebugFragmentShader(physical);
    for (const include of [
      OPAQUE_FRAGMENT_ANCHOR,
      '#include <tonemapping_fragment>',
      '#include <colorspace_fragment>',
      DITHERING_FRAGMENT_ANCHOR,
    ]) {
      expect(spliced).toContain(include);
    }
    expect(spliced).toContain('reflectedLight.indirectDiffuse');
    expect(spliced).toContain('uWorldDebugStops');
    // Before the curve for the accumulators, after the dither for the raw
    // views: the two blocks must not have collapsed onto one site.
    const display = spliced.indexOf('worldDebugTerm');
    const raw = spliced.indexOf('worldDebugRaw');
    const tone = spliced.indexOf('#include <tonemapping_fragment>');
    expect(display).toBeLessThan(tone);
    expect(raw).toBeGreaterThan(spliced.indexOf(DITHERING_FRAGMENT_ANCHOR));
  });

  it('reads the same world normal the probe is evaluated with', () => {
    // `geometryNormal` through the same inverse-view transform the SH injection
    // uses. A normals view built on anything else is a picture of a different
    // shader, which is the one thing a diagnostic may never be.
    expect(worldDebugFragmentShader(physical)).toContain(
      'transformNormalByInverseViewMatrix( geometryNormal, viewMatrix )',
    );
  });

  it('throws rather than silently skipping a missing anchor', () => {
    expect(() => worldDebugFragmentShader('void main() {}')).toThrow(/opaque_fragment/);
    expect(() =>
      worldDebugFragmentShader(`void main() { ${OPAQUE_FRAGMENT_ANCHOR} }`),
    ).toThrow(/dithering_fragment/);
  });

  it('numbers the views contiguously from off, in the order the shader branches', () => {
    // The shader dispatches on ranges (`> 3.5`, `< 5.5`), so a gap or a
    // reordering here does not fail loudly — it quietly shows the wrong term.
    expect(WORLD_DEBUG_VIEWS.map((v) => v.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(WORLD_DEBUG_VIEWS[0].view).toBe('off');
    expect(new Set(WORLD_DEBUG_VIEWS.map((v) => v.view)).size).toBe(
      WORLD_DEBUG_VIEWS.length,
    );
    // Every view states its units. The sheet prints these.
    for (const view of WORLD_DEBUG_VIEWS) expect(view.meaning.length).toBeGreaterThan(0);
  });
});

describe('linearity', () => {
  it('scales with the source', () => {
    // Two convolutions of one source means exactly this: doubling the world's
    // radiance doubles the light on the hull, with no knee, no plateau and no
    // per-object exception anywhere in the path.
    const base = fill(WIDTH, HEIGHT, (_x, y) => [0.3 + 0.2 * y, 0.4, 0.5 - 0.1 * y]);
    const scaled = new Float32Array(base.length);
    for (let i = 0; i < base.length; i++) scaled[i] = base[i] * 2.5;

    const shBase = projectEquirectToSh(base, WIDTH, HEIGHT, new Float32Array(SH_FLOAT_COUNT));
    const shScaled = projectEquirectToSh(scaled, WIDTH, HEIGHT, new Float32Array(SH_FLOAT_COUNT));

    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [0, 0, 0];
    shIrradiance(shBase, 0.3, 0.9, 0.31, a);
    shIrradiance(shScaled, 0.3, 0.9, 0.31, b);
    for (let c = 0; c < 3; c++) expect(b[c]).toBeCloseTo(a[c] * 2.5, 5);
  });
});
