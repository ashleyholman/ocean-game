import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { ScenePresentPass } from '../src/render/ScenePresentPass';
import {
  FLAME_INTENSITY,
  LAMP_COLOR,
  LAMP_CORE_RADIANCE,
  LAMP_GLASS_EMISSIVE_INTENSITY,
} from '../src/scene/Lamp';
import {
  GLSL_SCOTOPIC,
  DEFAULT_SCOTOPIC_STRENGTH,
  SCOTOPIC_ACUITY_LOSS,
  SCOTOPIC_DESATURATION,
  SCOTOPIC_KNEE_HI,
  SCOTOPIC_KNEE_LO,
  SCOTOPIC_LIFT_GAMMA,
  SCOTOPIC_LIFT_SCALE,
  SCOTOPIC_PHOTOPIC_ADAPTATION,
  SCOTOPIC_ROD_TINT,
  SCOTOPIC_SCOTOPIC_ADAPTATION,
  applyScotopic,
  parseScotopicStrength,
  rodDominance,
  scotopicPassEngaged,
  scotopicStrength,
} from '../src/scene/scotopic';
import { TimeOfDay } from '../src/scene/TimeOfDay';
import { applyToneCurve } from '../src/scene/toneMapping';

/**
 * The three machine-checkable acceptance clauses of Part A of
 * `docs/graphics/NIGHT_VISIBILITY_SPEC.md`, plus the structural facts the
 * observer model rests on.
 *
 * The fourth clause — "a moonless night is readable on a laptop panel in a lit
 * room" — is deliberately absent. It cannot be asserted from node and it is not
 * this file's to certify.
 */

const DEG = Math.PI / 180;

/**
 * Every shipping source file, debug harnesses excluded. The sweeps below are
 * whole-tree rather than a hand-kept list on purpose: a hand-kept list is
 * exactly what missed the sky dome's dither the first time.
 */
function shaderSources(): string[] {
  return readdirSync('src', { recursive: true })
    .filter((entry) => entry.endsWith('.ts') && !entry.includes('debug/'))
    .map((entry) => `src/${entry}`.replace(/\\/g, '/'))
    .sort();
}

function refreshAt(
  time: TimeOfDay,
  sunElevationDeg: number,
  options: { moonElevationDeg?: number; moonFraction?: number } = {},
): void {
  const el = sunElevationDeg * DEG;
  const moonEl = (options.moonElevationDeg ?? -30) * DEG;
  time.refreshFromAstronomy(
    1e6,
    new THREE.Vector3(Math.cos(el), Math.sin(el), 0),
    0,
    el,
    new THREE.Vector3(-Math.cos(moonEl), Math.sin(moonEl), 0),
    Math.PI,
    moonEl,
    options.moonFraction ?? 0.5,
  );
}

const luma = (c: readonly [number, number, number]): number =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Chroma as the two ratios a hue is: nothing here may move them. */
const chroma = (c: readonly [number, number, number]): [number, number] => [
  c[0] / c[1],
  c[2] / c[1],
];

/** The night the operator is built for: sun well down, no moon up. */
function deepNight(): { time: TimeOfDay; exposure: number; rod: number } {
  const time = new TimeOfDay();
  refreshAt(time, -25);
  return {
    time,
    exposure: time.exposure * time.daylightLift,
    rod: rodDominance(time.retinalLuminance),
  };
}

describe("Ash's shipping verdict", () => {
  it('ships at 0%, while keeping explicit opt-in and partial lab arms', () => {
    expect(DEFAULT_SCOTOPIC_STRENGTH).toBe(0);
    expect(scotopicStrength()).toBe(0);
    expect(parseScotopicStrength(null)).toBe(0);
    expect(parseScotopicStrength('0')).toBe(0);
    expect(parseScotopicStrength('0.35')).toBe(0.35);
    expect(parseScotopicStrength('1')).toBe(1);
    for (const invalid of ['-0.01', '1.01', 'on', 'NaN']) {
      expect(() => parseScotopicStrength(invalid), invalid).toThrow(/scotopic/);
    }
  });

  it('cannot engage the alternate presentation path at the shipped strength', () => {
    const { time } = deepNight();
    expect(rodDominance(time.retinalLuminance)).toBe(1);
    expect(
      scotopicPassEngaged({
        adaptationLuminance: time.retinalLuminance,
        strength: DEFAULT_SCOTOPIC_STRENGTH,
        rod: 1,
        engaged: true,
      }),
    ).toBe(false);
  });

  it('does no observer, calibration or prewarm work while off', () => {
    const adaptation = vi.fn(() => 1e-3);
    const readStoredCalibration = vi.fn(() => null);
    vi.stubGlobal('localStorage', {
      getItem: readStoredCalibration,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const renderer = {
      getRenderTarget: vi.fn(() => null),
      getDrawingBufferSize: vi.fn(),
      render: vi.fn(),
    } as unknown as THREE.WebGLRenderer;
    const pass = new ScenePresentPass(renderer, {
      adaptationLuminance: adaptation,
      setInlineQuantisationDither: vi.fn(),
    });
    try {
      pass.update(1 / 60);
      expect(pass.active).toBe(false);
      expect(pass.rodDominance).toBe(0);
      expect(adaptation).not.toHaveBeenCalled();
      expect(renderer.getDrawingBufferSize).not.toHaveBeenCalled();
      expect(readStoredCalibration).not.toHaveBeenCalled();

      expect(pass.render(new THREE.Scene(), new THREE.Camera())).toBe(false);
      expect(renderer.render).not.toHaveBeenCalled();
    } finally {
      pass.dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe('scotopic operator', () => {
  it('is exactly the identity when the observer is not dark-adapted', () => {
    for (const c of [
      [0.0, 0.0, 0.0],
      [0.0031, 0.0042, 0.0071],
      [0.31, 0.44, 0.62],
      [1.0, 0.65, 0.4],
    ] as Array<[number, number, number]>) {
      const out = applyScotopic(c, [0.5, 0.5, 0.5], 0);
      // Bit-identical, not "close": the guard returns its argument.
      expect(out).toEqual(c);
    }
  });

  it('is exactly the identity for any pixel at or above the knee', () => {
    for (const y of [SCOTOPIC_KNEE_HI, 0.1, 0.35, 0.7, 1.0]) {
      const c: [number, number, number] = [y, y, y];
      expect(applyScotopic(c, [0, 0, 0], 1)).toEqual(c);
    }
    // And a coloured pixel whose LUMINANCE clears the knee, which is the case
    // the lantern is: warm, so its green and blue sit below the threshold while
    // the pixel as a whole is far above it.
    const warm: [number, number, number] = [0.98, 0.65, 0.4];
    expect(luma(warm)).toBeGreaterThan(SCOTOPIC_KNEE_HI);
    expect(applyScotopic(warm, [0, 0, 0], 1)).toEqual(warm);
  });

  it('lifts the dark end, and by the amount the doc claims', () => {
    const rod = 1;
    // Measured display luminances of a moonless night on this pipeline.
    const nightSky = 0.0035;
    const nightSea = 0.0054;
    const horizonBand = 0.0107;
    const lifted = (y: number): number => {
      const c: [number, number, number] = [y, y, y];
      return luma(applyScotopic(c, c, rod));
    };
    // The lift is real and monotone, and it does not invert the ordering.
    expect(lifted(nightSky)).toBeGreaterThan(nightSky * 3);
    expect(lifted(nightSea)).toBeGreaterThan(nightSea * 3);
    expect(lifted(horizonBand)).toBeGreaterThan(horizonBand * 2);
    expect(lifted(nightSky)).toBeLessThan(lifted(nightSea));
    expect(lifted(nightSea)).toBeLessThan(lifted(horizonBand));

    // In sRGB codes, which is the unit the legibility argument is made in.
    const code = (y: number): number =>
      Math.round(255 * (1.055 * Math.pow(y, 1 / 2.4) - 0.055));
    expect(code(nightSky)).toBe(11);
    expect(code(lifted(nightSky))).toBeGreaterThanOrEqual(33);
    expect(code(horizonBand)).toBe(27);
    expect(code(lifted(horizonBand))).toBeGreaterThanOrEqual(45);
  });

  it('joins the photopic branch smoothly enough not to band', () => {
    // A slope discontinuity at the knee would draw a Mach band along an
    // iso-luminance contour, which in a sea gradient is a visible ring. Both
    // the blend weight and the value difference vanish there by construction;
    // this measures the second difference across the join to prove it.
    const step = 1e-4;
    const at = (y: number): number => luma(applyScotopic([y, y, y], [y, y, y], 1));
    let worst = 0;
    for (let y = SCOTOPIC_KNEE_LO; y < SCOTOPIC_KNEE_HI * 1.4; y += step) {
      const second = at(y + step) - 2 * at(y) + at(y - step);
      worst = Math.max(worst, Math.abs(second) / (step * step));
    }
    // Finite curvature everywhere, i.e. no kink. A discontinuous slope would
    // send this to 1/step.
    expect(worst).toBeLessThan(1 / step);
  });

  it('desaturates toward blue-grey rather than toward nothing', () => {
    // A green-ish dark pixel: the rods should take most of its chroma and what
    // is left should lean blue, which is the Purkinje shift's whole signature.
    const dark: [number, number, number] = [0.002, 0.005, 0.003];
    const seen = applyScotopic(dark, dark, 1);
    const before = Math.max(...dark) / Math.min(...dark);
    const after = Math.max(...seen) / Math.min(...seen);
    expect(after).toBeLessThan(before);
    expect(seen[2]).toBeGreaterThan(seen[0]);
    expect(SCOTOPIC_ROD_TINT[2]).toBeGreaterThan(SCOTOPIC_ROD_TINT[0]);
    // The tint carries no luminance of its own; it only redistributes.
    expect(luma(SCOTOPIC_ROD_TINT)).toBeCloseTo(1, 12);
  });

  it('derives its lift scale from the knee rather than choosing it', () => {
    // f(KNEE_HI) == KNEE_HI is what makes the blend the identity at the join.
    const atKnee =
      SCOTOPIC_LIFT_SCALE * Math.pow(SCOTOPIC_KNEE_HI, 1 / SCOTOPIC_LIFT_GAMMA);
    expect(atKnee).toBeCloseTo(SCOTOPIC_KNEE_HI, 12);
  });
});

describe('rod dominance', () => {
  it('is exactly zero through all of daylight and all of sunset', () => {
    // Clause: "daylight is bit-identical". This is the load-bearing half of the
    // proof — not "small", not "negligible", exactly 0.0 — and it is asserted
    // against the real meter rather than against the anchor constant.
    const time = new TimeOfDay();
    for (let elevation = 90; elevation >= -6; elevation -= 0.5) {
      refreshAt(time, elevation);
      expect(
        rodDominance(time.retinalLuminance),
        `sun ${elevation} deg`,
      ).toBe(0);
    }
  });

  it('and the pass therefore never runs above civil twilight', () => {
    // The other half: with rod dominance at zero the buffer is not switched in
    // either, so the frame takes the untouched direct-to-canvas call.
    const time = new TimeOfDay();
    for (let elevation = 90; elevation >= -4; elevation -= 0.5) {
      refreshAt(time, elevation);
      const engaged = scotopicPassEngaged({
        adaptationLuminance: time.retinalLuminance,
        strength: 1,
        rod: 0,
        engaged: false,
      });
      expect(engaged, `sun ${elevation} deg`).toBe(false);
    }
  });

  it('engages the buffer before the operator starts to act', () => {
    // There must be a band where the pass is running and inert, so that a
    // path-change artefact can be told apart from the operator.
    const time = new TimeOfDay();
    let inertAndEngaged = 0;
    for (let elevation = -4; elevation >= -9; elevation -= 0.1) {
      refreshAt(time, elevation);
      const rod = rodDominance(time.retinalLuminance);
      const engaged = scotopicPassEngaged({
        adaptationLuminance: time.retinalLuminance,
        strength: 1,
        rod,
        engaged: false,
      });
      if (engaged && rod === 0) inertAndEngaged++;
      // The converse must never happen: the operator acting with no buffer.
      if (rod > 0) expect(engaged, `sun ${elevation} deg`).toBe(true);
    }
    expect(inertAndEngaged).toBeGreaterThan(0);
  });

  it('reaches full rod dominance by the end of nautical twilight', () => {
    const time = new TimeOfDay();
    refreshAt(time, -12);
    expect(rodDominance(time.retinalLuminance)).toBeGreaterThan(0.99);
    refreshAt(time, -25);
    expect(rodDominance(time.retinalLuminance)).toBe(1);
  });

  it('is monotone in the light, and anchored where the doc says', () => {
    let previous = -1;
    for (let elevation = -20; elevation <= 10; elevation += 0.25) {
      const time = new TimeOfDay();
      refreshAt(time, elevation);
      const rod = rodDominance(time.retinalLuminance);
      expect(rod, `sun ${elevation} deg`).toBeLessThanOrEqual(
        previous < 0 ? 1 : previous + 1e-9,
      );
      previous = rod;
    }
    // The two anchors are the twilight definitions, measured on this meter.
    expect(rodDominance(SCOTOPIC_PHOTOPIC_ADAPTATION)).toBe(0);
    expect(rodDominance(SCOTOPIC_SCOTOPIC_ADAPTATION)).toBe(1);
  });

  it('hands legibility back to a full moon, which is Part B\'s inheritance', () => {
    // A brighter night meters brighter, so the observer partly returns to cone
    // vision on its own. Part B has to be tuned inside this, not before it.
    const moonless = new TimeOfDay();
    refreshAt(moonless, -25);
    const moonlit = new TimeOfDay();
    refreshAt(moonlit, -25, { moonElevationDeg: 40, moonFraction: 1 });
    expect(moonlit.retinalLuminance).toBeGreaterThan(
      moonless.retinalLuminance,
    );
    const rod = rodDominance(moonlit.retinalLuminance);
    expect(rod).toBeLessThan(rodDominance(moonless.retinalLuminance));
    expect(rod).toBeGreaterThan(0.5);
    expect(rod).toBeLessThan(0.9);
  });
});

describe('the lantern at night', () => {
  it('passes through the operator bit-identically, colour and all', () => {
    const { exposure, rod } = deepNight();
    expect(rod).toBe(1);
    // The two surfaces the lamp actually draws: the lit glass globe and the
    // flame core inside it, at their shipping surface-radiance strengths.
    const emissive = (intensity: number): [number, number, number] => [
      LAMP_COLOR.r * intensity,
      LAMP_COLOR.g * intensity,
      LAMP_COLOR.b * intensity,
    ];
    for (const [name, linear] of [
      ['glass globe', emissive(LAMP_GLASS_EMISSIVE_INTENSITY)],
      ['flame core', emissive(LAMP_CORE_RADIANCE)],
    ] as Array<[string, [number, number, number]]>) {
      const display = applyToneCurve(linear, exposure);
      const seen = applyScotopic(display, [0, 0, 0], rod);
      expect(seen, name).toEqual(display);
      expect(chroma(seen), name).toEqual(chroma(display));
    }
  });

  it('is still the brightest thing in the frame, by a wide margin', () => {
    const { time, exposure, rod } = deepNight();
    const globe = applyToneCurve(
      [
        LAMP_COLOR.r * LAMP_GLASS_EMISSIVE_INTENSITY,
        LAMP_COLOR.g * LAMP_GLASS_EMISSIVE_INTENSITY,
        LAMP_COLOR.b * LAMP_GLASS_EMISSIVE_INTENSITY,
      ],
      exposure,
    );
    const lampY = luma(applyScotopic(globe, globe, rod));

    const sky = (x: number, y: number, z: number): number => {
      const out: [number, number, number] = [0, 0, 0];
      time.skyRadiance(new THREE.Vector3(x, y, z).normalize(), out);
      const display = applyToneCurve(out, exposure);
      return luma(applyScotopic(display, display, rod));
    };
    const ambient = ((): number => {
      const a: [number, number, number] = [
        time.ambientRadiance.x,
        time.ambientRadiance.y,
        time.ambientRadiance.z,
      ];
      const display = applyToneCurve(a, exposure);
      return luma(applyScotopic(display, display, rod));
    })();

    for (const [name, value] of [
      ['zenith sky', sky(0, 1, 0)],
      ['horizon sky', sky(1, 0.02, 0)],
      ['ambient-lit surface', ambient],
    ] as Array<[string, number]>) {
      // A tenth of the lamp is the bar: after the lift the sea is still an
      // order of magnitude down, so the refuge is still a refuge.
      expect(value, name).toBeLessThan(lampY * 0.1);
    }
    expect(lampY).toBeGreaterThan(0.6);
  });

  it('keeps the visible wick brighter than the globe without bleaching it neutral', () => {
    const { exposure } = deepNight();
    const display = (intensity: number) =>
      applyToneCurve(
        [
          LAMP_COLOR.r * intensity,
          LAMP_COLOR.g * intensity,
          LAMP_COLOR.b * intensity,
        ],
        exposure,
      );
    const globe = display(LAMP_GLASS_EMISSIVE_INTENSITY);
    const core = display(LAMP_CORE_RADIANCE);

    expect(luma(core)).toBeGreaterThan(luma(globe));
    expect(core[0] - core[2]).toBeGreaterThan(0.25);
    expect(core[0] - core[1]).toBeGreaterThan(0.15);
  });

  it('keeps its 2100 K colour where the ocean already knew it did', () => {
    // One flame, two renderers, one number: the ocean shader mirrors LAMP_COLOR
    // as LAMP_TINT, and the operator must not silently split them.
    const source = readFileSync('src/scene/Ocean.ts', 'utf8');
    expect(source).toContain(
      `const vec3 LAMP_TINT = vec3(${LAMP_COLOR.r.toFixed(1)}, ${LAMP_COLOR.g}, ${LAMP_COLOR.b});`,
    );
    expect(FLAME_INTENSITY).toBeGreaterThan(0);
  });
});

describe('the operator as it reaches the GPU', () => {
  const glsl = GLSL_SCOTOPIC;

  it('compiles the same constants the CPU mirror uses', () => {
    const constant = (name: string): number => {
      const match = glsl.match(new RegExp(`const float ${name} = ([-0-9.e]+);`));
      if (match === null) throw new Error(`${name} missing from GLSL`);
      return Number(match[1]);
    };
    expect(constant('SCOTOPIC_KNEE_LO')).toBeCloseTo(SCOTOPIC_KNEE_LO, 9);
    expect(constant('SCOTOPIC_KNEE_HI')).toBeCloseTo(SCOTOPIC_KNEE_HI, 9);
    // The lift is a UNIFORM, not a constant — the display calibration
    // re-derives it and it has to land without a page reload. Its two
    // components are pinned in tests/display-calibration.ts instead.
    expect(glsl).toContain('uniform vec2 uScotopicLift;');
    expect(glsl).toContain('uScotopicLift.y * pow( ys, 1.0 / uScotopicLift.x )');
    expect(SCOTOPIC_LIFT_SCALE).toBeCloseTo(
      Math.pow(SCOTOPIC_KNEE_HI, 1 - 1 / SCOTOPIC_LIFT_GAMMA),
      12,
    );
    expect(constant('SCOTOPIC_DESATURATION')).toBeCloseTo(
      SCOTOPIC_DESATURATION,
      9,
    );
    expect(constant('SCOTOPIC_ACUITY_LOSS')).toBeCloseTo(SCOTOPIC_ACUITY_LOSS, 9);
    const tint = glsl.match(/SCOTOPIC_ROD_TINT = vec3\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
    expect(tint).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(Number((tint as RegExpMatchArray)[i + 1])).toBeCloseTo(
        SCOTOPIC_ROD_TINT[i],
        7,
      );
    }
  });

  it('keeps the guard that makes the identity exact', () => {
    // If this ever becomes arithmetic instead of an early return, both the
    // daylight clause and the lantern clause stop being provable.
    expect(glsl).toContain('if ( w <= 0.0 ) return c;');
  });

  it('runs after the tone curve and before the encode, then dithers', () => {
    const file = readFileSync('src/render/ScenePresentPass.ts', 'utf8');
    // The shader body only: the prose above it names the same chunks.
    const present = file.slice(file.indexOf('const PRESENT_FRAGMENT'));
    const toneMapped = present.indexOf('c = toneMapping(c);');
    const operator = present.indexOf('seen = scotopicVision(');
    const encode = present.indexOf('#include <colorspace_fragment>');
    const dither = present.indexOf('presentHash21(gl_FragCoord.xy)');
    expect(toneMapped).toBeGreaterThan(0);
    expect(operator).toBeGreaterThan(toneMapped);
    expect(encode).toBeGreaterThan(operator);
    expect(dither).toBeGreaterThan(encode);
  });

  it('knows exactly which materials tone-map inline', () => {
    // The enumeration the architecture rests on, kept as a list so it cannot
    // grow silently. Every include below expands to NOTHING when the frame is
    // aimed at the pass's buffer — three forces NoToneMapping and a linear
    // output colour space for every material at once whenever a non-XR render
    // target is bound — and the pass then applies the curve once, for all of
    // them. That rule is what makes "no material can be tone-mapped twice, and
    // none can be forgotten" a property of the renderer rather than of our
    // diligence.
    //
    // A new entry here is not a bug. It is a material whose display transform
    // somebody has to have thought about, and it should not be able to appear
    // without this test saying so.
    const inline = shaderSources().filter((file) =>
      // Shader bodies only. Two files discuss the chunk in prose; a shader body
      // indents the include, and TerrainSystem passes it as a string literal.
      /\n\s+#include <tonemapping_fragment>|'#include <tonemapping_fragment>'/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(inline).toEqual([
      // The temporal resolve's own copy, used when the scotopic pass declines.
      'src/render/OceanTemporalResolve.ts',
      // The sea: the flat profile stand-in and the real shader.
      'src/scene/Ocean.ts',
      // The dome, the stars, the land.
      'src/scene/SkySystem.ts',
      'src/scene/StarField.ts',
      'src/terrain/TerrainSystem.ts',
      // The debug-only raft (?debug=raft) and its sail.
      'src/vessel/raft/Raft.ts',
    ]);
  });

  it('accounts for every surface that dithers past the colourspace encode', () => {
    // THE AUDIT, AS A TEST.
    //
    // Three's render-target rule disables tone mapping and the sRGB encode for
    // every material at once when the frame is aimed offscreen, so no material
    // can be tone-mapped twice or skipped. The one thing that rule does NOT
    // reach is a write placed AFTER colorspace_fragment: it survives, and it
    // lands on a raw linear radiance instead of on a display code. There were
    // two such writes when this pass was built — the sea's 1-LSB dither and the
    // sky dome's — and the second was found by running this sweep rather than
    // by remembering it.
    //
    // So the sweep is the guard. Any future write past the encode must either
    // be gated on uQuantiseDither or live in a presenter that owns the canvas.
    const presenters = [
      'src/render/ScenePresentPass.ts',
      'src/render/OceanTemporalResolve.ts',
    ];
    const unguarded: string[] = [];
    for (const file of shaderSources()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes('#include <colorspace_fragment>')) continue;
        // The straight-line tail after the encode: stop at the first brace or
        // preprocessor directive. A write behind an #ifdef is a DIAGNOSTIC one
        // — the ocean's debug views deliberately bypass the whole transform so
        // a readback gets the shader's number rather than a photograph of it —
        // and the pass is switched off for those frames by
        // framePresentationCompatible() in main.ts.
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j].trim();
          if (line.startsWith('}') || line.startsWith('#')) break;
          if (!/gl_FragColor\s*(\.rgb|\.a)?\s*\+?=/.test(line)) continue;
          if (line.includes('uQuantiseDither')) continue;
          if (presenters.includes(file)) continue;
          unguarded.push(`${file}: ${line}`);
        }
      }
    }
    expect(unguarded).toEqual([]);

    // Both known dithers are still gated, so the sweep passes because they are
    // guarded rather than because it found nothing to look at.
    for (const file of ['src/scene/Ocean.ts', 'src/scene/SkySystem.ts']) {
      expect(readFileSync(file, 'utf8'), file).toContain(
        'gl_FragColor.rgb += (hash21(gl_FragCoord.xy) - 0.5) * (uQuantiseDither / 255.0);',
      );
    }

    // And every presenter dithers at its own output instead.
    const present = readFileSync('src/render/ScenePresentPass.ts', 'utf8');
    expect(present).toContain('setInlineQuantisationDither(false)');
    expect(present).toContain('presentHash21(gl_FragCoord.xy)');
    const temporal = readFileSync('src/render/OceanTemporalResolve.ts', 'utf8');
    expect(temporal).toContain('this.setInlineQuantisationDither(false);');
    expect(temporal).toContain('copyHash21(gl_FragCoord.xy)');
  });
});
