import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TIMBER_GRAIN_ANCHOR,
  createWorldPbrMaterial,
  isTimberGrainMaterial,
  timberGrainFragmentShader,
} from '../src/scene/WorldPbrMaterial';
import {
  dressTimber,
  getTimberMode,
  parseTimberMode,
  setTimberMode,
  timberCanonicalColour,
  timberColour,
  timberKeyOfMaterial,
  timberKeys,
  timberWearSites,
  type TimberKey,
} from '../src/vessel/schooner/timberFinish';
import { HALF_LENGTH } from '../src/vessel/schooner/hullForm';

/**
 * The timber round's invariants.
 *
 * Two of them are the round's whole argument and are asserted rather than
 * described: the respec **holds luminance**, so nothing derived from these
 * colours goes stale; and `off` is **byte-identical**, so a session without the
 * switch is running the code that shipped before the round.
 *
 * The rest are the claims the write-up makes in numbers. If the palette is
 * retuned, these should move with it — they are the shape of the change, not a
 * lock on the values.
 */

const luminance = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const hueDeg = (c: THREE.Color): number => {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.h * 360;
};

const saturation = (c: THREE.Color): number => {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl, THREE.SRGBColorSpace);
  return hsl.s;
};

const spread = (values: number[]): number =>
  Math.max(...values) - Math.min(...values);

afterEach(() => setTimberMode('off'));

describe('the timber mode switch', () => {
  it('defaults to off and round-trips its four arms', () => {
    expect(getTimberMode()).toBe('off');
    for (const arm of ['off', 'woods', 'grain', 'wear'] as const) {
      expect(parseTimberMode(arm)).toBe(arm);
    }
    expect(parseTimberMode(null)).toBe('off');
  });

  it('refuses an unknown arm rather than silently shipping the default', () => {
    // `?terrain=` and `?depth=`'s rule: a capture that misspells the arm it
    // wants must not quietly photograph the arm it did not ask for. The A/B
    // registry's read-back would catch it, but only if this throws first.
    expect(() => parseTimberMode('gRaIn')).toThrow(/unknown \?timber=/);
    expect(() => parseTimberMode('rough')).toThrow(/off \| woods \| grain \| wear/);
  });
});

describe('off is byte-identical', () => {
  it('leaves a timber material white and undefine-d', () => {
    const material = createWorldPbrMaterial({ vertexColors: true });
    dressTimber(material, 'deckPlanking');
    expect(material.color.getHex()).toBe(0xffffff);
    expect(isTimberGrainMaterial(material)).toBe(false);
    material.dispose();
  });

  it('splices nothing into the shader, so the program is the one that shipped', () => {
    // Stronger than "the branch is compiled out": a timber material at `off`
    // and a material that was never dressed at all produce shader source that
    // is IDENTICAL, character for character. The round's guard is not merely
    // false at `off`; it is not in the text being preprocessed.
    const compile = (dress: boolean): { vertex: string; fragment: string;
      uniforms: Record<string, THREE.IUniform> } => {
      const material = createWorldPbrMaterial({ vertexColors: true });
      if (dress) dressTimber(material, 'cabinLining');
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      };
      material.onBeforeCompile(
        shader as unknown as THREE.WebGLProgramParametersWithUniforms,
        {} as THREE.WebGLRenderer,
      );
      material.dispose();
      return {
        vertex: shader.vertexShader,
        fragment: shader.fragmentShader,
        uniforms: shader.uniforms,
      };
    };
    const bare = compile(false);
    const dressed = compile(true);
    expect(dressed.fragment).toBe(bare.fragment);
    expect(dressed.vertex).toBe(bare.vertex);
    expect(Object.keys(dressed.uniforms).sort()).toEqual(
      Object.keys(bare.uniforms).sort(),
    );
  });
});

describe('the respec holds luminance', () => {
  it('matches every canonical timber to within 2%', () => {
    // The reason the whole round could be one line per material rather than
    // thirty in the geometry builders, and the reason nothing downstream goes
    // stale: `interiorLight.ts` bakes SOLE_ALBEDO, LINING_ALBEDO and
    // HOLD_ALBEDO as module constants off these hexes, the deadlight round's
    // legibility argument is a luminance ratio, and the portal bake is a
    // reflectance model. All of them survive a pure hue move; none of them
    // would survive a brightness one.
    for (const key of timberKeys()) {
      const before = luminance(timberCanonicalColour(key));
      const after = luminance(timberColour(key));
      expect(Math.abs(after - before) / before).toBeLessThan(0.02);
    }
  });
});

describe('the complaint, in numbers', () => {
  it('opens six woods out of the 5 degrees of hue they all shared', () => {
    const was = timberKeys().map((k) => hueDeg(timberCanonicalColour(k)));
    const now = timberKeys().map((k) => hueDeg(timberColour(k)));
    // Measured on master: 31.9 to 36.7 across every bare timber aboard, the
    // spars included. Six woods and one hue is what "flat orange wood" is.
    expect(spread(was)).toBeLessThan(6);
    expect(spread(now)).toBeGreaterThan(14);
  });

  it('takes chroma out of every one of them', () => {
    // The other half of "orange". Sea-weathered and scrubbed timber is a
    // low-chroma material; every wood on this ship sat at HSL saturation
    // 0.21-0.36, which is closer to fresh-cut than to anything that has been
    // at sea.
    for (const key of timberKeys()) {
      expect(saturation(timberColour(key))).toBeLessThan(
        saturation(timberCanonicalColour(key)),
      );
    }
  });

  it('stops the cabin lining and the companionway coaming being one hex', () => {
    // They share `0xa08258` on master — one oak for a surface that is rained
    // on and one that has never been wet — and they meet each other at the
    // companionway, which is the one place the identity is visible.
    expect(timberCanonicalColour('cabinLining').getHex()).toBe(
      timberCanonicalColour('weatherJoinery').getHex(),
    );
    expect(
      Math.abs(hueDeg(timberColour('cabinLining')) - hueDeg(timberColour('weatherJoinery'))),
    ).toBeGreaterThan(8);
  });

  it('keeps the cabin the warmest wood aboard', () => {
    // `SHIP_SPEC` section 9: the cabin's whole point is that it reads warmer
    // and lighter than the exterior. Desaturating the ship without protecting
    // that would answer the complaint by taking the room's character with it.
    const lining = saturation(timberColour('cabinLining'));
    for (const key of timberKeys()) {
      if (key === 'cabinLining') continue;
      expect(lining).toBeGreaterThan(saturation(timberColour(key)));
    }
  });
});

describe('the tint is the ratio the vertex colours want', () => {
  it('lands each material on its respec when multiplied by the canonical', () => {
    // Every ship material is `vertexColors: true` with `color` set to white,
    // so the attribute decides the colour and the material colour is a free
    // multiplier. The tint is a per-channel ratio into it; if that arithmetic
    // is wrong the ship comes out an arbitrary colour and nothing throws.
    setTimberMode('woods');
    for (const key of timberKeys()) {
      const material = createWorldPbrMaterial({ vertexColors: true });
      dressTimber(material, key);
      const canonical = timberCanonicalColour(key);
      const landed = new THREE.Color(
        material.color.r * canonical.r,
        material.color.g * canonical.g,
        material.color.b * canonical.b,
      );
      const want = timberColour(key);
      for (const channel of ['r', 'g', 'b'] as const) {
        expect(landed[channel]).toBeCloseTo(want[channel], 5);
      }
      material.dispose();
    }
  });

  it('tints without grain at woods, and with it at grain', () => {
    const build = (): THREE.MeshStandardMaterial => {
      const m = createWorldPbrMaterial({ vertexColors: true });
      dressTimber(m, 'holdOak');
      return m;
    };
    setTimberMode('woods');
    const woods = build();
    expect(woods.color.getHex()).not.toBe(0xffffff);
    expect(isTimberGrainMaterial(woods)).toBe(false);
    woods.dispose();

    setTimberMode('grain');
    const grain = build();
    expect(isTimberGrainMaterial(grain)).toBe(true);
    // Grain but no wear: the wear loop is a per-fragment cost and the tier
    // that does not ask for it must not compile it.
    expect(grain.defines).not.toHaveProperty('WORLD_PBR_TIMBER_WEAR');
    grain.dispose();
  });

  it('compiles the wear loop only at the wear tier, sized to the sites', () => {
    setTimberMode('wear');
    const material = createWorldPbrMaterial({ vertexColors: true });
    dressTimber(material, 'deckPlanking');
    expect(material.defines?.WORLD_PBR_TIMBER_WEAR).toBe(
      String(timberWearSites().length),
    );
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.uniforms.uTimberWear.value).toHaveLength(
      timberWearSites().length,
    );
    material.dispose();
  });

  it('gives every timber its own uniform objects', () => {
    // One shared object would give the whole ship the last figure written —
    // the failure mode the SH coefficients deliberately DO have and a
    // per-material figure must not.
    setTimberMode('grain');
    const shaderOf = (key: TimberKey): Record<string, THREE.IUniform> => {
      const material = createWorldPbrMaterial({ vertexColors: true });
      dressTimber(material, key);
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      };
      material.onBeforeCompile(
        shader as unknown as THREE.WebGLProgramParametersWithUniforms,
        {} as THREE.WebGLRenderer,
      );
      material.dispose();
      return shader.uniforms;
    };
    const deck = shaderOf('deckPlanking');
    const oak = shaderOf('holdOak');
    expect(deck.uTimberFigure).not.toBe(oak.uTimberFigure);
    // The deck's board term is deliberately zero: it is already built as
    // planks carrying the ship's heaviest vertex jitter, and a second board
    // term at a different pitch would beat against the first.
    expect((deck.uTimberFigure.value as THREE.Vector4).x).toBe(0);
    expect((oak.uTimberFigure.value as THREE.Vector4).x).toBeGreaterThan(0);
  });
});

describe('the grain splice', () => {
  it('is anchored where albedo and roughness are both still live', () => {
    const fragment = THREE.ShaderLib.physical.fragmentShader;
    const anchor = fragment.indexOf(TIMBER_GRAIN_ANCHOR);
    expect(anchor).toBeGreaterThan(fragment.indexOf('#include <color_fragment>'));
    expect(anchor).toBeGreaterThan(
      fragment.indexOf('#include <roughnessmap_fragment>'),
    );
    expect(anchor).toBeLessThan(
      fragment.indexOf('#include <lights_physical_fragment>'),
    );
  });

  it('throws rather than drawing nothing when three moves the anchor', () => {
    expect(() => timberGrainFragmentShader('void main() {}')).toThrow(
      /timber grain/,
    );
  });

  it('writes both albedo and roughness', () => {
    const spliced = timberGrainFragmentShader(
      THREE.ShaderLib.physical.fragmentShader,
    );
    expect(spliced).toContain('diffuseColor.rgb *= timberTone');
    expect(spliced).toContain('roughnessFactor = clamp( roughnessFactor + timberRough');
  });
});

describe('where the ship is worn', () => {
  it('puts every mark on the ship', () => {
    for (const site of timberWearSites()) {
      expect(Math.abs(site.z)).toBeLessThan(HALF_LENGTH);
      expect(Math.abs(site.x)).toBeLessThan(2.6);
      expect(site.y).toBeGreaterThan(1.5);
      expect(site.y).toBeLessThan(6);
      expect(site.radiusM).toBeGreaterThan(0.5);
      expect(Math.abs(site.strength)).toBeLessThanOrEqual(1);
    }
  });

  it('has marks of both signs', () => {
    // The sign IS the model: a deck round a hatchway is scuffed to pale bare
    // fibre by feet and a handrail is burnished dark by hands. One unsigned
    // wear term would have to pick one and be wrong about the other.
    const signs = timberWearSites().map((s) => Math.sign(s.strength));
    expect(signs).toContain(1);
    expect(signs).toContain(-1);
  });
});

describe('which material is which wood', () => {
  it('knows the four hull timbers by their mesh names', () => {
    expect(timberKeyOfMaterial('ship:deck')).toBe('deckPlanking');
    expect(timberKeyOfMaterial('ship:interiorLining')).toBe('cabinLining');
    expect(timberKeyOfMaterial('ship:interiorSole')).toBe('cabinSole');
    expect(timberKeyOfMaterial('ship:deckJoinery')).toBe('weatherJoinery');
  });

  it('leaves the painted hull and the rig alone', () => {
    // Not an omission. The tarred palette is a verdict Ash took under the
    // current display transform, after one that had already reversed; and the
    // spars share the complaint exactly but belong to another round.
    for (const name of [
      'ship:topsides',
      'ship:wales',
      'ship:transom',
      'ship:bootTop',
      'ship:trim',
      'ship:inboardBulwark',
      'ship:belowWaterline',
      'ship:glazing',
      'rig:spar',
    ]) {
      expect(timberKeyOfMaterial(name)).toBeNull();
    }
  });
});
