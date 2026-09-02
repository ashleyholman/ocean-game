import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OCEAN_QUALITY_DESKTOP,
  OCEAN_QUALITY_MOBILE,
  SUN_POOL_FADE_END_M,
  SUN_POOL_FADE_START_M,
} from '../src/scene/Ocean';

/**
 * GLSL lives in tagged template literals, so a stray backtick inside a shader
 * comment silently terminates the string and turns the rest of the shader into
 * TypeScript. That failure is confusing out of all proportion to its cause —
 * it surfaces as a syntax error hundreds of lines away, or as a shader that
 * compiles to something entirely different. Cheaper to forbid it.
 */
const SHADER_FILES = [
  'Ocean.ts',
  'FoamField.ts',
  'CrestSpray.ts',
  'CloudDome.ts',
  'StarField.ts',
  'shaders/lib.ts',
  '../weather/CatsPawField.ts',
  '../render/OceanTemporalResolve.ts',
];

function glslBlocks(source: string): Array<{ start: number; lines: string[] }> {
  const lines = source.split('\n');
  const blocks: Array<{ start: number; lines: string[] }> = [];
  let current: { start: number; lines: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!current && line.includes('/* glsl */ `')) {
      current = { start: i + 1, lines: [] };
      continue;
    }
    if (current && line.trim() === '`;') {
      blocks.push(current);
      current = undefined;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

describe('GLSL template literals', () => {
  for (const file of SHADER_FILES) {
    it(`${file} has no stray backticks inside a shader body`, () => {
      const source = readFileSync(join('src/scene', file), 'utf8');
      const blocks = glslBlocks(source);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const offender = block.lines.findIndex((line) => line.includes('`'));
        expect(
          offender === -1 ? null : `line ${block.start + offender + 1}: ${block.lines[offender]}`,
        ).toBeNull();
      }
    });
  }

  /**
   * Every ocean program that touches depth must encode it the same way.
   *
   * `logarithmicDepthBuffer: true` defines `USE_LOGARITHMIC_DEPTH_BUFFER` on
   * every program in the renderer, but only materials whose GLSL includes the
   * chunks act on it (TERR-112). A material that skips them keeps writing
   * conventional depth into a buffer everyone else writes logarithmically —
   * and the failure is silent, because the define is absent in production and
   * the shadow caster it hit is off by default. The ocean's displaced-swell
   * caster was left out of that wiring for exactly those reasons; a structural
   * rule is cheaper than remembering.
   */
  it('wires log depth into every ocean shader that writes a position', () => {
    const source = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    const positionBlocks = glslBlocks(source).filter((block) =>
      block.lines.some((line) => /^\s*gl_Position\s*=/.test(line)),
    );
    // The visible sea and its displaced shadow-caster twin.
    expect(positionBlocks.length).toBe(2);
    for (const block of positionBlocks) {
      const body = block.lines.join('\n');
      expect(
        body.includes('${GLSL_LOG_DEPTH_PARS_VERTEX}')
          ? null
          : `block at line ${block.start} declares no log-depth varyings`,
      ).toBeNull();
      expect(
        body.includes('${GLSL_LOG_DEPTH_VERTEX}')
          ? null
          : `block at line ${block.start} writes gl_Position without log depth`,
      ).toBeNull();
    }

    // ...and both of their fragment sides.
    for (const constant of ['SHADOW_FRAGMENT_SHADER', 'FRAGMENT_SHADER']) {
      const start = source.indexOf(`const ${constant} = /* glsl */ \``);
      expect(start, constant).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n`;', start));
      expect(body, constant).toContain('${GLSL_LOG_DEPTH_PARS_FRAGMENT}');
      expect(body, constant).toContain('${GLSL_LOG_DEPTH_FRAGMENT}');
    }
  });

  /**
   * Land and sea must haze toward the same sky (TERR-133).
   *
   * Both mix toward `SkyRadianceLut`'s texture, in the same frame, and the
   * mapping from a direction to a texel is what decides which sky. The two
   * mappings were separate copies with a comment between them asking the next
   * reader to keep them equal — and a divergence of one texel row would not
   * look like a mis-set constant, it would look like a seam at the waterline
   * that moves as the vessel turns. One exported snippet, both consumers.
   */
  it('samples the sky radiance LUT the same way on both sides of the waterline', () => {
    const lib = readFileSync(join('src/scene', 'shaders/lib.ts'), 'utf8');
    const ocean = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    const terrain = readFileSync(
      join('src/terrain', 'TerrainSystem.ts'),
      'utf8',
    );

    // Exactly one definition, in the shared library.
    const definition = /vec2\s+skyRadianceLutUv\s*\(/g;
    expect(lib.match(definition)?.length).toBe(1);
    expect(ocean.match(definition)).toBeNull();
    expect(terrain.match(definition)).toBeNull();

    // And both consumers reach it through the same import.
    expect(ocean).toContain('GLSL_SKY_RADIANCE_LUT_UV');
    expect(terrain).toContain('GLSL_SKY_RADIANCE_LUT_UV');
    // Terrain narrows the elevation range on top of the shared mapping rather
    // than rewriting it: the horizon clamp, expressed in LUT rows.
    expect(terrain).toContain('max(uv.y, 0.5 + 0.012 / 3.14159265359)');
  });

  it("uses one mirrored cat's-paw field for CPU, foam, and ocean presentation", () => {
    const field = readFileSync(
      join('src/weather', 'CatsPawField.ts'),
      'utf8',
    );
    const foam = readFileSync(join('src/scene', 'FoamField.ts'), 'utf8');
    const ocean = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    const waves = readFileSync(join('src/scene', 'Waves.ts'), 'utf8');

    // The function and its harmonic table are authored once. Both GPU
    // consumers inject that source; neither carries a private noise copy.
    expect(field.match(/float catsPawField\s*\(/g)?.length).toBe(1);
    expect(field).toContain('CATS_PAW_HARMONICS.map(');
    expect(foam).toContain('GLSL_CATS_PAW');
    expect(ocean).toContain('GLSL_CATS_PAW');
    expect(foam).not.toMatch(/float catsPawField\s*\(/);
    expect(ocean).not.toMatch(/float catsPawField\s*\(/);

    // Presentation-only is structural: the WaveField shared by geometry,
    // buoyancy and orbital velocity has no route to this module.
    expect(waves).not.toContain('CatsPawField');

    // Zero amplitude preserves today's foam arithmetic exactly and keeps the
    // new Ocean normal/whitecap terms behind literal positive branches.
    expect(foam).toContain('} else if (uGustiness > 0.001) {');
    expect(foam).toContain(
      'float g = vnoise(p * 0.010 + uWindDir * uNoiseTime * 0.06);',
    );
    expect(foam).toContain(
      'gust = mix(1.0, 0.25 + 1.9 * g, uGustiness);',
    );
    expect(ocean).toContain('if (uCatsPawGustExcessMps > 0.0) {');
    expect(ocean).toContain('detailGrad *= catsPawRoughnessScale;');
    expect(ocean).toContain('live *= catsPawWhitecapDrive;');
  });

  it('keeps the detail and foam-breakup domain fixed when the ocean disc recentres', () => {
    const source = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');

    // The radial disc follows a distant camera. Its vertex-local p therefore
    // moves by -centre for the same water parcel, while param = p + uWaveOrigin
    // adds the centre back. Foam is looked up with vParam; using p for vDetail
    // left the foam outline fixed while its breakup and relief scrolled beneath it.
    expect(source).toContain('vDetail = param + uDetailOrigin;');
    expect(source).not.toContain('vDetail = p + uDetailOrigin;');

    const waterPosition = 73;
    const presentationOrigin = 19;
    const detailAt = (discCentre: number) =>
      waterPosition - discCentre + discCentre + presentationOrigin;
    expect(detailAt(0)).toBe(detailAt(330));
    expect(detailAt(0)).toBe(detailAt(1_374));
  });

  /**
   * `uDetailWrap` is 256 detail cells wide, so `mod(vDetail, uDetailWrap)` is a
   * no-op for anything sampled at an integer multiple of `uDetailFreq` and a
   * discontinuity for anything else. A bare literal is right for exactly one
   * sea state — the one whose detail scale happens to be its reciprocal — and
   * draws a straight axis-aligned seam every `uDetailWrap` metres for all the
   * others: a 614 m grid across the foam at the default scale, invisible from
   * the raft and unmissable from the air.
   *
   * The property is structural and cheap to check, and the bug it guards is one
   * nobody would find by reading the shader.
   */
  it('samples the wrapped detail coordinate only at multiples of uDetailFreq', () => {
    const source = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    const pattern =
      /mod\(\s*vDetail\s*,\s*uDetailWrap\s*\)\s*\*\s*(\([^()\n]*\)|[A-Za-z_][\w.]*|[\d.]+)/g;
    const uses: string[] = [];
    for (const block of glslBlocks(source)) {
      for (const line of block.lines) {
        const code = line.replace(/\/\/.*$/, '');
        for (const m of code.matchAll(pattern)) uses.push(m[1].trim());
      }
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const multiplier of uses) {
      // Either uDetailFreq alone, or (<integer>.0 * uDetailFreq).
      const ok =
        /^uDetailFreq$/.test(multiplier) ||
        /^\(\s*\d+\.0\s*\*\s*uDetailFreq\s*\)$/.test(multiplier);
      expect(ok ? null : `wrapped detail sampled at "${multiplier}"`).toBeNull();
    }
  });

  it('keeps the counterflow prototype balanced within every detail octave', () => {
    const source = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    expect(source).toContain('noisedPeriodic(base + uDetailScroll[o])');
    expect(source).toContain('noisedPeriodic(base - uDetailScroll[o] + seed)');
    expect(source).toContain('(forwardField + reverseField) * 0.70710678');
  });

  it('evolves the in-place prototype along a separate temporal axis', () => {
    const source = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    expect(source).toContain('noisedPeriodic3(vec3(');
    expect(source).toContain('uDetailMorphTime * temporalRate');
  });

  it('retires daylight-only look controls through the shared night ramp', () => {
    const sky = readFileSync(join('src/scene', 'shaders/lib.ts'), 'utf8');
    const ocean = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');

    // uNight is exactly zero through the protected sunset band, so every
    // expression below reduces algebraically to the shipping daylight shader.
    expect(sky).toContain('mix(uSkyGainTrim, 1.0, uNight)');
    expect(ocean).toContain('waveOpenness = mix(waveOpenness, 1.0, nightLookRestore)');
    expect(ocean).toContain(
      'uHorizonBlock.y * belowHorizon * (1.0 - nightLookRestore)',
    );
    expect(ocean).toContain(
      'uGrazingSlopeLift * (1.0 - nightLookRestore)',
    );
    expect(ocean).toMatch(
      /effectiveGrazingRolloff = mix\(\s*uGrazingRolloff,\s*0\.55,\s*nightLookRestore\s*\)/,
    );
    expect(ocean).toContain(
      'mix(uWaterContrast.x, 1.0, nightLookRestore)',
    );
  });

  /**
   * The residual wave term draws, per pixel, the components the mesh was too
   * coarse to displace. Drawing one at fewer than two samples per wavelength
   * does not remove it — it folds it down to a low-frequency beat, and summed
   * over a sea state's worth of components that beat is the parallel ridging
   * that shows up in every view from altitude.
   */
  it('band-limits the residual wave term at or before Nyquist', () => {
    const source = readFileSync(join('src/scene', 'shaders/lib.ts'), 'utf8');
    const match = source.match(
      /smoothstep\(\s*wavelength\s*\*\s*([\d.]+)\s*,\s*wavelength\s*\*\s*([\d.]+)\s*,\s*footprint\s*\)/,
    );
    expect(match, 'residual visibility fade not found').not.toBeNull();
    const [, start, end] = match as RegExpMatchArray;
    expect(Number(end)).toBeLessThanOrEqual(0.5);
    expect(Number(start)).toBeLessThan(Number(end));
  });

  it('uses no GLSL reserved words as identifiers', () => {
    // GLSL ES reserves far more words than GLSL desktop. These are the ones a
    // TypeScript author is most likely to reach for without thinking.
    const reserved = ['active', 'input', 'output', 'filter', 'sample', 'common', 'partition'];
    for (const file of SHADER_FILES) {
      const source = readFileSync(join('src/scene', file), 'utf8');
      for (const block of glslBlocks(source)) {
        for (let i = 0; i < block.lines.length; i++) {
          const line = block.lines[i].replace(/\/\/.*$/, '');
          for (const word of reserved) {
            const declaration = new RegExp(`\\b(float|int|bool|vec[234]|mat[234])\\s+${word}\\b`);
            expect(
              declaration.test(line) ? `${file}:${block.start + i + 1} declares "${word}"` : null,
            ).toBeNull();
          }
        }
      }
    }
  });

  it('declares every GLSL constant and function before it is used', () => {
    // GLSL has no hoisting: a name must be declared above every use of it, or
    // the shader fails to compile at runtime. The CPU mirrors of this code are
    // TypeScript, where hoisting DOES apply, so a reordering mistake passes the
    // type checker and the whole numeric test suite and only shows up as a
    // black screen in the browser. That happened; this is the guard.
    //
    // Scope is deliberately top-level only (column zero): locals and parameters
    // are block-scoped and are not what this failure mode is about.
    for (const file of SHADER_FILES) {
      const source = readFileSync(join('src/scene', file), 'utf8');
      for (const block of glslBlocks(source)) {
        // Strip comments so prose cannot look like a reference.
        const body = block.lines
          .map((line) => line.replace(/\/\/.*$/, ''))
          .join('\n')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        // Blocks made only of preprocessor lines (the log-depth chunk
        // wrappers are `#include`s and an #ifdef guard) have no declaration
        // order to get wrong; the found-anything sanity check below would
        // reject them as regex rot when they are simply not its subject.
        const nonEmpty = body
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (nonEmpty.every((line) => line.startsWith('#'))) continue;
        const declaration =
          /^(?:const\s+)?(?:float|int|bool|vec[234]|mat[234]|void)\s+([A-Za-z_]\w*)\s*[=(]/gm;
        const declaredAt = new Map<string, number>();
        for (const match of body.matchAll(declaration)) {
          if (!declaredAt.has(match[1])) declaredAt.set(match[1], match.index ?? 0);
        }
        expect(declaredAt.size).toBeGreaterThan(0);
        for (const [name, at] of declaredAt) {
          for (const hit of body.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
            expect(
              (hit.index ?? 0) < at
                ? `${file}: "${name}" is used before it is declared`
                : null,
            ).toBeNull();
          }
        }
      }
    }
  });

  describe('direct-light geometry shadows', () => {
    const ocean = readFileSync(join('src/scene', 'Ocean.ts'), 'utf8');
    const lamp = readFileSync(join('src/scene', 'Lamp.ts'), 'utf8');
    const ship = readFileSync(
      join('src/vessel/schooner', 'Schooner.ts'),
      'utf8',
    );
    const main = readFileSync(join('src', 'main.ts'), 'utf8');
    const environmentRuntime = readFileSync(
      join('src/runtime', 'EnvironmentRuntime.ts'),
      'utf8',
    );

    it('has completely removed the old circular raft/contact mask', () => {
      expect(ocean).not.toContain('uniform vec2  uRaftPos');
      expect(ocean).not.toContain('float raftAO');
      // `vesselRayVisibility` was the other half of the old fake: an analytic
      // stand-in for DIRECT light occlusion. That stays gone — direct light has
      // a real depth map now. `vesselSkyVisibility` is deliberately NOT on this
      // list; occluding the sky hemisphere analytically is an approximation of
      // a real quantity rather than a substitute for geometry, and it is
      // asserted for its own behaviour below.
      expect(ocean).not.toContain('vesselRayVisibility');
    });

    it('widens the Sun penumbra with the blocker height', () => {
      expect(ocean).toContain('float sunPenumbraTexels()');
      expect(ocean).toContain('const float SUN_ANGULAR_RADIUS');
      // The whole trick: blocker height read backwards out of how far downwind
      // the pixel is. If this stops using the sun direction it has stopped
      // being a penumbra and become a constant blur.
      expect(ocean).toMatch(/sunPenumbraTexels\(\)[\s\S]{0,900}?uSunDir\.xz/);
      // Sized in metres, spent in texels — and the conversion must come from
      // the live camera, never a literal that a box resize would invalidate.
      expect(ocean).toContain('uSunShadowTexelWorld');
      expect(main).toContain('ocean.setSunShadowTexelWorld(');
      expect(main).toMatch(
        /setSunShadowTexelWorld\(\s*\(sunLight\.shadow\.camera\.right - sunLight\.shadow\.camera\.left\)/,
      );
      // Contact must stay crisp: a floor near one texel, not a flat blur.
      expect(ocean).toMatch(/clamp\(widthMetres \/ max\(uSunShadowTexelWorld, 1e-5\), 0\.5, 14\.0\)/);
    });

    it('occludes the sky by the hull, and only the sky', () => {
      expect(ocean).toContain('float vesselSkyVisibility()');
      expect(ocean).toContain('float skyVisibility = vesselSkyVisibility()');
      // Diffuse, hemisphere-integrated terms take the average.
      expect(ocean).toContain('uWaterAmbient * uBodyGains.x * skyVisibility');
      expect(ocean).toContain('uWaterAmbient * uFoamGains.x * skyVisibility');

      // The mirror asks a DIRECTIONAL question instead. A hemisphere average on
      // a specular term is the bug this split exists to fix: it hid at noon
      // behind a 0.03 Fresnel and took over the whole pixel at dusk.
      expect(ocean).toContain('float vesselMirrorVisibility(vec3 mirrorDir, float lobeAlpha)');
      expect(ocean).toContain('vec2 rayToAxisApproach(');
      expect(ocean).toContain('vesselMirrorVisibility(R, alphaReflect)');
      // The halo must shrink with range. A bare ray test occludes a hull fifty
      // metres downrange as completely as one alongside, and that painted a
      // disc out to the horizon. Coverage of the reflection lobe is what pulls
      // it back in, so it has to stay in the product.
      expect(ocean).toContain('clamp(angularRadius / max(lobeAlpha, 0.05), 0.0, 1.0)');
      expect(ocean).toContain('uVesselMirrorOcclusion * hit * coverage');
      // Diffuse skirt likewise: squared falloff, and a radius that is fed
      // rather than guessed, so a raft does not occlude like a schooner.
      expect(ocean).toContain('if (uVesselOcclusionWide < 0.5) falloff *= falloff;');
      expect(ocean).toContain('setVesselOcclusionRadius(');
      expect(main).toContain('ocean.setVesselOcclusionRadius(activeVessel.halfBeamM)');
      expect(ocean).toContain('lobeBlend) * reflectionVisibility');
      // ...and the mirror's own strength is a separate quantity from the AO's.
      expect(ocean).toContain('const VESSEL_MIRROR_OCCLUSION');
      expect(ocean).toMatch(/uVesselMirrorOcclusion/);

      // "No skyVisibility in the same statement as a direct light" has to be
      // asked of the CODE. Asked of the raw file it also reads the prose, and
      // a comment that happens to mention sunRadiance a few lines above a sky
      // term fails a test the shader passes.
      const code = ocean.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      // The sun owns a real depth map; occluding it here double-counts.
      expect(code).not.toMatch(/sunRadiance[^;]*skyVisibility/);
      // The lantern hangs on the very hull doing the occluding.
      expect(code).not.toMatch(/lampRadiance[^;]*skyVisibility/);
      // ...and the terms that SHOULD carry it still do, after stripping.
      expect(code).toMatch(/uWaterAmbient \* uBodyGains\.x \* skyVisibility/);
    });

    it('receives the vessel Sun shadow on every direct-sun term', () => {
      expect(ocean).toContain('#include <shadowmap_pars_vertex>');
      expect(ocean).toContain('#include <shadowmap_vertex>');
      expect(ocean).toContain('float directSunVisibility = sunSurfaceVisibility()');
      // declaration + glitter + body irradiance + crest SSS + foam direct
      expect(ocean.match(/directSunVisibility/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    });

    it('renders the Moon glitter as a phase-powered neutral silver path', () => {
      expect(ocean).toContain(
        'float moonTransmission = dot(moonT, vec3(0.2126, 0.7152, 0.0722))',
      );
      expect(ocean).toContain(
        'vec3 moonRadiance = vec3(moonTransmission) * uMoonPower * uMoonSpecular',
      );
      expect(ocean).not.toContain(
        'vec3 moonRadiance = uMoonTint * lightTransmittance(uMoonDir)',
      );
    });

    it('keeps the sea out of the Sun depth pass', () => {
      // A surface that is not in the map cannot self-shadow, which is the whole
      // reason the acne is gone. The displaced caster stays in the file for the
      // A/B and the cost bracket, so assert the DEFAULT rather than its absence.
      expect(ocean).toContain('this.mesh.castShadow = false');
      expect(ocean).toContain('const SHADOW_VERTEX_SHADER');
      expect(ocean).toMatch(
        /const SHADOW_VERTEX_SHADER[\s\S]*WaveResult w = evaluateWaves\(param, lodRadius\)/,
      );
      expect(ocean).toContain('this.mesh.customDepthMaterial = this.shadowMaterial');
      // Production must not silently re-arm the caster; only the A/B may.
      expect(environmentRuntime).toMatch(
        /this\.sunShadowMode = options\.initialDirectShadowing\s*\?\s*'water-receiver'/,
      );
    });

    it('ramps the Sun shadow term to lit before the map runs out', () => {
      // getShadow() steps from shadowed to lit at the frustum wall. The receiver
      // is a plane reaching the horizon, so that step is a straight line drawn
      // across the sea. Fading is what stops the box from being visible at all.
      expect(ocean).toContain('const float SUN_SHADOW_EDGE_FADE');
      expect(ocean).toMatch(/vec3 toWall = min\(coord, 1\.0 - coord\)/);
      // All three axes, so the far plane cannot draw a line either.
      expect(ocean).toMatch(/min\(min\(toWall\.x, toWall\.y\), toWall\.z\)/);
      expect(ocean).toMatch(/visibility = mix\(1\.0, visibility, fade\)/);
      // The fade must wrap the lookup, not sit beside it.
      expect(ocean).toMatch(
        /float fade = smoothstep\([\s\S]*?getShadow\([\s\S]*?visibility = mix\(1\.0, visibility, fade\)/,
      );
    });

    it('derives the Sun depth bias from the interval it is measured in', () => {
      // shadow.bias is normalised depth: a constant silently changes meaning
      // when near/far move. Deriving it keeps the offset a fixed distance of
      // real water, which is the quantity the deck planking was tuned against.
      expect(main).toContain('sunLight.shadow.bias = -0.03 / SUN_SHADOW_DEPTH_RANGE');
      // A bare numeric literal is exactly the thing that goes stale.
      expect(main).not.toMatch(/sunLight\.shadow\.bias\s*=\s*-?[\d.]+\s*;/);
    });

    it('samples a real point-shadow cube for the lantern', () => {
      expect(ocean).toContain('float lampSurfaceVisibility()');
      expect(ocean).toContain('getPointShadow(');
      expect(ocean).toContain('vPointShadowCoord[0]');
      expect(ocean).toContain('float lampShadow = lampSurfaceVisibility()');
      expect(lamp).toContain('this.light.shadow.camera.layers.set(LANTERN_SHADOW_LAYER)');
      expect(ship).toContain('mesh.layers.enable(LANTERN_SHADOW_LAYER)');
    });

    it('keeps the six lantern faces vessel-only and bounded', () => {
      expect(lamp).toContain('this.light.shadow.mapSize.set(256, 256)');
      expect(lamp).toContain('this.light.shadow.camera.far = 7.5');
      expect(ocean).not.toContain('this.mesh.layers.enable(LANTERN_SHADOW_LAYER)');
    });
  });
});

/**
 * The cloud field is written twice: once in GLSL for the dome and once in
 * TypeScript for the ambient fill, the exposure meter and the sun occlusion.
 * They are not two approximations of one idea — they are required to be the
 * same layer, or the scene is lit by clouds that are not the ones on screen.
 *
 * Every constant below is one a tuning pass will want to move, and moving it
 * in one file only is a silent, plausible-looking desync: nothing crashes, no
 * numeric test fails, the sky just stops agreeing with the light on the water.
 * Cheaper to forbid it. The march STEP COUNT is in here for the same reason —
 * a density that varies with height makes the number of samples part of the
 * layer's shape, not merely its quality.
 */
describe('cloud field CPU mirror', () => {
  it('keeps the per-pixel cloud march out of shipping ocean haze', () => {
    expect(OCEAN_QUALITY_DESKTOP.cloudsInHaze).toBe(false);
  });

  const glsl = readFileSync('src/scene/shaders/lib.ts', 'utf8');
  const cpu = readFileSync('src/scene/TimeOfDay.ts', 'utf8');

  /** Sole match of `pattern`, as a number. Ambiguity is itself a failure. */
  const one = (source: string, pattern: string, what: string): number => {
    const hits = [...source.matchAll(new RegExp(pattern, 'gm'))];
    expect(hits.length, `expected exactly one ${what}`).toBe(1);
    return Number(hits[0][1]);
  };

  const scalars: ReadonlyArray<readonly [string, string]> = [
    // The volume itself. CLOUD_EXTINCT is per METRE — the traverse integrates
    // an honest line integral rather than normalising by step count — so it is
    // the constant that decides whether a wisp is a wisp and a core is opaque.
    ['CLOUD_EXTINCT', 'CLOUD_EXTINCT'],
    ['CLOUD_SUN_GAIN', 'CLOUD_SUN_GAIN'],
    ['CLOUD_ERODE_BASE', 'CLOUD_ERODE_BASE'],
    ['CLOUD_ERODE_TOP', 'CLOUD_ERODE_TOP'],
    ['CLOUD_WARP', 'CLOUD_WARP'],
    // The 3D shape field and its gradient: the silhouette authority. Every one
    // of these moves what shape a cloud IS, so a mismatch here lights the sea
    // from clouds of a different shape than the ones on screen.
    ['CLOUD_GRAD_BASE', 'CLOUD_GRAD_BASE'],
    ['CLOUD_GRAD_KNEE', 'CLOUD_GRAD_KNEE'],
    ['CLOUD_GRAD_END', 'CLOUD_GRAD_END'],
    ['CLOUD_EDGE', 'CLOUD_EDGE'],
    ['CLOUD_DENSITY', 'CLOUD_DENSITY'],
    // The traverse's own geometry.
    ['CLOUD_REACH', 'CLOUD_REACH'],
    ['CLOUD_SUN_STEP', 'CLOUD_SUN_STEP'],
    ['CLOUD_SUN_GROWTH', 'CLOUD_SUN_GROWTH'],
    ['CLOUD_REGION_SCALE', 'CLOUD_REGION_SCALE'],
    ['CLOUD_REGION_SWING', 'CLOUD_REGION_SWING'],
    // The weather map's distribution. The 3D basis that lets the field evolve
    // has 14 % less spread than the 2D one it replaced, and these two numbers
    // put it back; drift them apart and the drawn sky grows towers the lit sky
    // does not, which is exactly the silent desync this whole block exists for.
    ['CLOUD_FBM_MEAN', 'CLOUD_FBM_MEAN'],
    ['CLOUD_FBM_GAIN', 'CLOUD_FBM_GAIN'],
  ];

  for (const [glslName, cpuName] of scalars) {
    it(`${glslName} matches between the shader and its CPU port`, () => {
      expect(one(glsl, `^const float ${glslName}\\s*=\\s*([-\\d.]+);`, glslName)).toBe(
        one(cpu, `^const ${cpuName} = ([-\\d.]+);`, cpuName),
      );
    });
  }

  /**
   * The march-step "comb", closed by arithmetic.
   *
   * `CLOUD_SHAPE_FINDINGS.md` records the standing figure: step count "has to
   * reach roughly 64 before the step banding ('combing') stops being visible.
   * At 28 it is obvious." That was measured per SCREEN PIXEL against a ~18 km
   * traverse cap, so what it really says is a step LENGTH: 18000/64 is about
   * 280 m at the threshold and 640 m where it was obvious. A step count is only
   * a proxy for that, and the proxy stopped holding when the march moved into
   * the direction cache.
   *
   * Two things have to be true for the comb to be gone, and this checks both.
   *
   * **The step is short enough, with the cache's magnification paid for.** The
   * cache carries about 17 texels per degree of azimuth against a screen that
   * resolves 30 or more, so any angular structure the bake writes is magnified
   * roughly 1.8x on the way out. Banding is angular structure — iso-`seg`
   * shells are iso-elevation bands — so the per-pixel threshold has to be
   * divided by that magnification before the shipped march is measured against
   * it: about 156 m rather than 280 m. The bound below is derived from the
   * shipped constants rather than written down, so a change to the slab, the
   * reach, the cap or the step count re-derives it.
   *
   * **There is no march-start dither.** The woven hatching that a separate
   * diagnosis blamed on "the IGN march dither baked at cache resolution and
   * magnified ~2x" was a real artefact and it was REMOVED at source, not
   * mitigated: commit 35d866f retired the interleaved-gradient offset entirely
   * and raised the count to 192 to pay for it honestly. That commit touched no
   * documents, which is exactly why the diagnosis kept being restated as open.
   * If a dither ever comes back it must be TEMPORAL and paired with TAA.
   */
  it('marches finely enough that the step comb cannot come back', () => {
    const base = one(glsl, '^const float CLOUD_BASE\\s+= ([-\\d.]+);', 'CLOUD_BASE');
    const top = one(glsl, '^const float CLOUD_TOP\\s+= ([-\\d.]+);', 'CLOUD_TOP');
    const reach = one(glsl, '^const float CLOUD_REACH = ([-\\d.]+);', 'CLOUD_REACH');
    const stepMax = one(
      glsl,
      '^const float CLOUD_STEP_MAX = ([-\\d.]+);',
      'CLOUD_STEP_MAX',
    );
    const steps = OCEAN_QUALITY_DESKTOP.cloudMarch;
    expect(OCEAN_QUALITY_MOBILE.cloudMarch).toBe(steps);

    // `seg = min(CLOUD_THICK / dir.y, CLOUD_REACH)`, so the longest segment any
    // ray can take is the reach, and the longest step is that over the count.
    const longestStepM = Math.min(reach / steps, stepMax);

    // The threshold from CLOUD_SHAPE_FINDINGS, in metres, corrected for the
    // ~1.8x the direction cache magnifies angular structure by.
    const perPixelThresholdM = 18000 / 64;
    const cacheMagnification = 1.8;
    expect(longestStepM).toBeLessThan(perPixelThresholdM / cacheMagnification);

    // And the cap is no longer what is holding the horizon together: at the
    // shipped count the division already lands under it, so every elevation is
    // sampled at the divided rate. This flips back below ~114 steps, which
    // `?cloudMarch=` can reach — the assertion is what would catch that.
    expect(reach / steps).toBeLessThan(stepMax);
    expect(top - base).toBeGreaterThan(0);

    // No march-start dither in EITHER traverse: the live one and the bake both
    // sample the midpoint of a uniform step.
    const marchStarts = [...glsl.matchAll(/^\s*float s = ([^;]+dt[^;]*);$/gm)].map(
      (m) => m[1].trim(),
    );
    // The live per-pixel traverse and the cache bake, and no third one.
    expect(marchStarts.length).toBe(2);
    for (const start of marchStarts) {
      expect(start).toBe('(float(i) + 0.5) * dt');
    }
    expect(glsl).not.toMatch(/interleavedGradient|ignNoise/);
  });

  it('the slab altitudes match between the shader and its CPU port', () => {
    // The traverse enters the slab at CLOUD_BASE and leaves at CLOUD_TOP, and
    // it converts each sample's world height into the normalised h the gradient
    // reads. Both ends therefore have to agree about where the slab IS, or the
    // mirror marches through a different volume than the dome draws — and it
    // would do it silently, because both would still produce plausible cloud.
    //
    // Both ports spell the slab as a base/top PAIR, so the pair is what gets
    // compared — deriving one side's mid and thickness from the other's would
    // just restate the CPU's arithmetic and prove nothing.
    const pair = (source: string, pattern: RegExp, what: string): number[] => {
      const m = source.match(pattern);
      expect(m, `expected one ${what}`).not.toBeNull();
      return [Number(m![1]), Number(m![2])];
    };
    const glslSlab = [
      one(glsl, '^const float CLOUD_BASE\\s+= ([-\\d.]+);', 'CLOUD_BASE'),
      one(glsl, '^const float CLOUD_TOP\\s+= ([-\\d.]+);', 'CLOUD_TOP'),
    ];
    expect(one(cpu, '^const CLOUD_BASE = ([-\\d.]+);', 'CPU CLOUD_BASE'))
      .toBe(glslSlab[0]);
    expect(pair(cpu, /^const CLOUD_MID = 0\.5 \* \((\d+) \+ (\d+)\);/m, 'CPU CLOUD_MID'))
      .toEqual(glslSlab);
    expect(pair(cpu, /^const CLOUD_THICK = (\d+) - (\d+);/m, 'CPU CLOUD_THICK'))
      .toEqual([glslSlab[1], glslSlab[0]]);
  });

  it('CLOUD_SHAPE_FREQ matches between the shader and its CPU port', () => {
    const match = glsl.match(
      /^const vec3 CLOUD_SHAPE_FREQ = vec3\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\);/m,
    );
    expect(match, 'expected one CLOUD_SHAPE_FREQ').not.toBeNull();
    expect([Number(match![1]), Number(match![2]), Number(match![3])]).toEqual([
      one(cpu, '^const CLOUD_SHAPE_FREQ_X = ([-\\d.]+);', 'CLOUD_SHAPE_FREQ_X'),
      one(cpu, '^const CLOUD_SHAPE_FREQ_Y = ([-\\d.]+);', 'CLOUD_SHAPE_FREQ_Y'),
      one(cpu, '^const CLOUD_SHAPE_FREQ_Z = ([-\\d.]+);', 'CLOUD_SHAPE_FREQ_Z'),
    ]);
  });

  for (const [glslName, axes] of [
    ['CLOUD_SCALE', ['CLOUD_SCALE_X', 'CLOUD_SCALE_Y']],
    ['CLOUD_SHEAR', ['CLOUD_SHEAR_X', 'CLOUD_SHEAR_Y']],
  ] as const) {
    it(`${glslName} matches between the shader and its CPU port`, () => {
      const pair = new RegExp(`^const vec2\\s+${glslName}\\s*=\\s*vec2\\(([-\\d.]+),\\s*([-\\d.]+)\\);`, 'm');
      const match = glsl.match(pair);
      expect(match, `expected one ${glslName}`).not.toBeNull();
      expect([Number(match![1]), Number(match![2])]).toEqual([
        one(cpu, `^const ${axes[0]} = ([-\\d.]+);`, axes[0]),
        one(cpu, `^const ${axes[1]} = ([-\\d.]+);`, axes[1]),
      ]);
    });
  }

  it('CLOUD_LUMP_FREQ matches between the shader and its CPU port', () => {
    // vec3(x) in GLSL, one scalar on the CPU: the billow field is isotropic,
    // and the CPU port would rather say so than carry three equal constants.
    const match = glsl.match(/^const vec3 CLOUD_LUMP_FREQ = vec3\(([-\d.]+)\);/m);
    expect(match, 'expected one isotropic CLOUD_LUMP_FREQ').not.toBeNull();
    expect(Number(match![1])).toBe(
      one(cpu, '^const CLOUD_LUMP_FREQ = ([-\\d.]+);', 'CLOUD_LUMP_FREQ'),
    );
  });

  for (const [glslName, axes] of [
    ['CLOUD_BOIL', ['CLOUD_BOIL_X', 'CLOUD_BOIL_Y', 'CLOUD_BOIL_Z']],
  ] as const) {
    it(`${glslName} matches between the shader and its CPU port`, () => {
      const triple = new RegExp(
        `^const vec3 ${glslName} = vec3\\(([-\\d.]+),\\s*([-\\d.]+),\\s*([-\\d.]+)\\);`,
        'm',
      );
      const match = glsl.match(triple);
      expect(match, `expected one ${glslName}`).not.toBeNull();
      expect([Number(match![1]), Number(match![2]), Number(match![3])]).toEqual(
        axes.map((axis) => one(cpu, `^const ${axis} = ([-\\d.]+);`, axis)),
      );
    });
  }

  /**
   * The evolution axis has to be scaled by the SAME factor on both sides. Get
   * this wrong and the sky the water is lit by evolves at a different rate from
   * the sky the dome draws — the two would start together and be looking at
   * unrelated weather within a minute, which is the one desync in this file
   * that gets worse the longer you watch.
   */
  it('the evolution-axis scales are derived the same way on both sides', () => {
    expect(glsl).toMatch(/^const float CLOUD_EVO_SCALE = 1\.0 \/ CLOUD_CELL_M;/m);
    expect(cpu).toMatch(/^const CLOUD_EVO_SCALE = 1 \/ CLOUD_CELL_M;/m);
  });

  /**
   * The mirror is allowed a COARSER traverse than the dome, and this test says
   * so on purpose rather than by omission.
   *
   * It used to demand an identical step count, because the old march normalised
   * optical depth by the number of steps — the column was walked at a fixed
   * distance and its geometric length was a fiction, so the step count was part
   * of the layer's OPACITY. The traverse integrates honestly (density times
   * extinction times metres crossed), so the step count now decides how finely
   * the integral is resolved and not what it converges to.
   *
   * What must still hold is that the mirror is coarser rather than finer, and
   * not so coarse that it steps over whole clouds: this consumer is a
   * hemisphere mean, and a mean taken with steps longer than a cloud is wide
   * would report a sky with holes in it that the dome does not draw.
   */
  it('marches the same volume as the dome, at its own resolution', () => {
    const cpuSteps = one(cpu, '^const CLOUD_MARCH_CPU = (\\d+);', 'CLOUD_MARCH_CPU');
    expect(cpuSteps).toBeLessThanOrEqual(OCEAN_QUALITY_DESKTOP.cloudMarch);
    // The slab is 2.2 km thick and the shape field's cell is ~1.05 km across,
    // so a straight-up traverse must take at least a couple of samples per cell.
    expect(cpuSteps).toBeGreaterThanOrEqual(8);
    expect(
      one(cpu, '^const CLOUD_SHAPE_OCTAVES_CPU = (\\d+);', 'CLOUD_SHAPE_OCTAVES_CPU'),
    ).toBe(OCEAN_QUALITY_DESKTOP.cloudShapeOctaves);
  });

  describe('moving sun-pool sample', () => {
    const ocean = readFileSync('src/scene/Ocean.ts', 'utf8');
    const shaderStart = ocean.indexOf(
      'float sunPoolCloudTransmittance(vec2 waterFromObserver)',
    );
    const shaderEnd = ocean.indexOf(
      '/** Taps in the variable-width filter.',
      shaderStart,
    );
    const shaderSample = ocean.slice(shaderStart, shaderEnd);
    const cpuStart = cpu.indexOf('  sunPoolTransmittanceAt(');
    const cpuEnd = cpu.indexOf(
      '  /**\n   * Disc-integrated direct sunlight',
      cpuStart,
    );
    const cpuSample = cpu.slice(cpuStart, cpuEnd);

    it('keeps its CPU and GLSL geometry, cloud clock, and Beer-Lambert path aligned', () => {
      expect(shaderStart).toBeGreaterThan(-1);
      expect(shaderEnd).toBeGreaterThan(shaderStart);
      expect(cpuStart).toBeGreaterThan(-1);
      expect(cpuEnd).toBeGreaterThan(cpuStart);

      expect(shaderSample).toContain('CLOUD_BASE * invY + pathM * 0.5');
      expect(cpuSample).toContain('CLOUD_BASE * invY + pathM * 0.5');
      expect(shaderSample).toContain('uSunDir.xz * sampleT');
      expect(cpuSample).toContain('dir.x * sampleT');
      expect(cpuSample).toContain('dir.z * sampleT');
      expect(shaderSample).toContain('+ uCloudOffset');
      expect(cpuSample).toContain('+ this.cloudOffsetX');
      expect(cpuSample).toContain('+ this.cloudOffsetZ');

      expect(shaderSample).toContain('uCloudEvolve * CLOUD_EVO_SCALE');
      expect(cpuSample).toContain('this.cloudEvolve * CLOUD_EVO_SCALE');
      expect(shaderSample).toContain('cloudXZ * CLOUD_SCALE');
      expect(cpuSample).toContain('cloudX * CLOUD_SCALE_X');
      expect(cpuSample).toContain('cloudZ * CLOUD_SCALE_Y');
      expect(shaderSample).toContain('uSunDir.y * sampleT - CLOUD_BASE');
      expect(cpuSample).toContain('dir.y * sampleT - CLOUD_BASE');
      expect(shaderSample).toContain('cloudPoint, height, threshold, 0.0');
      expect(cpuSample).toContain('height,\n      threshold,\n      0,');
      expect(shaderSample).toContain('CLOUD_THICK * invY, CLOUD_REACH');
      expect(cpuSample).toContain('CLOUD_THICK * invY, CLOUD_REACH');
      expect(shaderSample).toContain('density * CLOUD_EXTINCT * pathM');
      expect(cpuSample).toContain('density * CLOUD_EXTINCT * pathM');
      expect(shaderSample).toContain('alpha * uCloudOpacity');
      expect(cpuSample).toContain('alpha * this.cloudOpacity');
    });

    it('spends exactly one density sample and no second cloud march', () => {
      expect(shaderSample.match(/cloudDensity\s*\(/g)).toHaveLength(1);
      expect(shaderSample).not.toMatch(/\bfor\s*\(/);
      expect(shaderSample).not.toContain('cumulusDeck(');
      expect(shaderSample).not.toContain('cloudLayer(');
      expect(shaderSample).not.toContain('cloudBake(');

      const bypass = shaderSample.indexOf('uSunPoolStrength <= 0.0');
      const density = shaderSample.indexOf('cloudDensity(');
      expect(bypass).toBeGreaterThan(-1);
      expect(bypass).toBeLessThan(density);
      expect(shaderSample).toContain(
        'vLodRadius >= SUN_POOL_FADE_END_M',
      );
      expect(shaderSample).toContain(') return uSunCloudTrans;');
    });

    it('returns to the established scalar before the far horizon', () => {
      expect(SUN_POOL_FADE_START_M).toBeLessThan(SUN_POOL_FADE_END_M);
      expect(SUN_POOL_FADE_END_M).toBeLessThan(20_000);
      expect(
        one(
          ocean,
          '^const float SUN_POOL_FADE_START_M = ([\\d.]+);',
          'shader SUN_POOL_FADE_START_M',
        ),
      ).toBe(SUN_POOL_FADE_START_M);
      expect(
        one(
          ocean,
          '^const float SUN_POOL_FADE_END_M = ([\\d.]+);',
          'shader SUN_POOL_FADE_END_M',
        ),
      ).toBe(SUN_POOL_FADE_END_M);
      expect(ocean).toContain('uSunPoolStrength: { value: 0 }');
      expect(ocean).not.toContain('sunVisible *= uSunCloudTrans;');
      expect(ocean.match(/sunPoolCloudTransmittance\s*\(/g)).toHaveLength(2);
    });
  });
});
