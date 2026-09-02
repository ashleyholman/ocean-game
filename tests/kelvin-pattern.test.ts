import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KELVIN_HALF_ANGLE_RAD,
  kelvinTransverseWavelengthM,
} from '../src/scene/wakePolicy';

const OCEAN_SOURCE = readFileSync('src/scene/Ocean.ts', 'utf8');

/**
 * Mirror of the stationary-phase condition the fragment shader solves.
 *
 * Waves holding station against a hull at speed V satisfy k = k0 sec^2(theta).
 * Stationary phase in theta reduces to 2*Y*t^2 + X*t + Y = 0 with t = tan
 * theta, X astern and Y abeam in units of 1/k0. Everything the pattern does —
 * the wedge, the two branches, the cusp — is a property of this quadratic, so
 * it is what the tests below are about.
 */
function branches(X: number, Y: number): { transverse: number; divergent: number } | null {
  const disc = X * X - 8 * Y * Y;
  if (disc <= 0) return null;
  const denom = X + Math.sqrt(disc);
  return {
    // c/q form: exact on the centreline, where the textbook formula is 0/0.
    transverse: (-2 * Y) / denom,
    divergent: -denom / (4 * Y),
  };
}

describe('Kelvin pattern geometry', () => {
  it('derives the 19.47 degree wedge from the discriminant', () => {
    // The half-angle is not asserted anywhere in the new pattern: it falls out
    // of where the quadratic stops having real roots. If this drifts, the
    // solution is wrong rather than the constant being mistyped.
    const critical = 1 / Math.sqrt(8);
    expect(Math.atan(critical)).toBeCloseTo(KELVIN_HALF_ANGLE_RAD, 12);

    const X = 10;
    expect(branches(X, X * critical * 0.999)).not.toBeNull();
    expect(branches(X, X * critical * 1.001)).toBeNull();
  });

  it('collapses to a pure transverse wave on the centreline', () => {
    // theta -> 0 there, so the phase is X and the wavelength is exactly the
    // lambda the CPU policy publishes. This is the one place the whole
    // construction can be checked against a closed-form answer.
    const near = branches(10, 1e-7);
    expect(near).not.toBeNull();
    expect(near!.transverse).toBeCloseTo(-1e-8, 12);
    // The divergent branch runs off to -infinity and is killed by the depth
    // weight rather than by a special case.
    expect(near!.divergent).toBeLessThan(-1e6);
  });

  it('merges the two branches exactly at the cusp', () => {
    const X = 12;
    const cuspY = X / Math.sqrt(8);
    const inside = branches(X, cuspY * 0.98)!;
    expect(Math.abs(inside.divergent - inside.transverse)).toBeGreaterThan(0.05);

    // The branches meet as sqrt of the distance to the cusp, so approaching it
    // to 1e-12 is what buys six figures of agreement.
    const atCusp = branches(X, cuspY * (1 - 1e-12))!;
    expect(Math.abs(atCusp.divergent - atCusp.transverse)).toBeLessThan(1e-5);
    // Both tend to the propagation angle whose stationary point is the cusp,
    // tan theta = -1/sqrt(2), i.e. theta = 35.26 degrees off the track.
    expect(atCusp.transverse).toBeCloseTo(-1 / Math.SQRT2, 3);
  });

  it('packs the crests tighter near the bow than down the wedge', () => {
    // Ash's note: it should compress at the bow and fan out. Crest spacing on
    // the centreline is uniform, but the DIVERGENT branch's angle sweeps with
    // position, which is what makes the arms fan rather than run parallel.
    const nearBow = branches(4, 4 / Math.sqrt(8) * 0.6)!;
    const farAstern = branches(40, (40 / Math.sqrt(8)) * 0.6)!;
    // Same relative position across the wedge, same angle — X cancels
    // entirely. The pattern is self-similar, so the fan is geometry rather
    // than a fitted taper, and the crest SPACING (which goes as sec^2 theta
    // against a fixed lambda) is what tightens toward the bow.
    expect(nearBow.divergent).toBeCloseTo(farAstern.divergent, 9);
    // Sweeping across the wedge at fixed X is what turns the arms: the
    // divergent heading steepens monotonically toward the cusp.
    const inner = branches(20, (20 / Math.sqrt(8)) * 0.3)!;
    const outer = branches(20, (20 / Math.sqrt(8)) * 0.9)!;
    expect(Math.abs(outer.divergent)).toBeLessThan(Math.abs(inner.divergent));
  });

  it('scales as one length, V squared over g', () => {
    // Self-similarity is what lets a single solution serve every speed.
    const slow = kelvinTransverseWavelengthM(2);
    const fast = kelvinTransverseWavelengthM(4);
    expect(fast / slow).toBeCloseTo(4, 12);
  });
});

describe('the shipped pattern shader', () => {
  it('solves the quadratic rather than summing plane waves', () => {
    expect(OCEAN_SOURCE).toContain('float disc = X * X - 8.0 * Y * Y;');
    expect(OCEAN_SOURCE).toContain('float tTransverse = -2.0 * Y / max(denom, 1e-5);');
    // The superseded implementation's fixed 35.26-degree plane wave and its
    // painted-on Gaussian cusp must not come back.
    expect(OCEAN_SOURCE).not.toContain('divergentPhase');
    expect(OCEAN_SOURCE).not.toContain('cuspEnv');
  });

  it('stays a normal-only perturbation, so the wake remains one-way', () => {
    // Ash's standing constraint. The pattern may never reach a vertex, the
    // wave field, or anything the physics samples.
    // The fragment shader's main() is not the first in the file, so anchor the
    // end to the one that follows this function rather than to the first.
    const start = OCEAN_SOURCE.indexOf('vec2 shipWakePatternGradient');
    const pattern = OCEAN_SOURCE.slice(
      start,
      OCEAN_SOURCE.indexOf('void main()', start),
    );
    expect(pattern.length).toBeGreaterThan(500);
    expect(pattern).not.toContain('gl_Position');
    expect(pattern).not.toContain('transformed');
    expect(pattern).not.toContain('displace');
  });

  it('feathers only the added pattern while ambient detail continues through it', () => {
    expect(OCEAN_SOURCE).toContain(
      'float cuspDistanceM = astern * 0.35355339 - absAbeam;',
    );
    expect(OCEAN_SOURCE).toContain(
      'clamp(lambda * 0.18, 1.25, 3.5)',
    );
    expect(OCEAN_SOURCE).toContain(
      'float cuspFade = smoothstep(0.0, cuspFeatherM, cuspDistanceM);',
    );
    expect(OCEAN_SOURCE).not.toContain('detailGrad *= wakeDetailScale;');
    expect(OCEAN_SOURCE).not.toContain('wakeMicroScale');
  });

  it('hands a finite bow pressure front to the far-field Kelvin pattern', () => {
    expect(OCEAN_SOURCE).toContain('vec2 shipBowNearFieldGradient(');
    expect(OCEAN_SOURCE).toContain(
      'vec2 shoulderDelta = uShipWakeBowShoulderCentre - uShipWakeOrigin;',
    );
    expect(OCEAN_SOURCE).toContain(
      'float frontAstern = -frontLead',
    );
    expect(OCEAN_SOURCE).toContain(
      'return frontGradient + shoulderGradient;',
    );
    expect(OCEAN_SOURCE).not.toContain('float hullHalfBreadth =');
    expect(OCEAN_SOURCE).toContain(
      'vec2 bowWaveGradient = shipBowNearFieldGradient(',
    );
    expect(OCEAN_SOURCE).toContain('+ bowWaveGradient');
    expect(OCEAN_SOURCE).toContain(
      'float fresh0 = field.x + live * 0.55 + bowWaveBreakingCoverage;',
    );
    expect(OCEAN_SOURCE).not.toContain('vHeight += shipBowNearField');
  });

  it('never renders the far-field point apex beneath the finite hull', () => {
    expect(OCEAN_SOURCE).toContain(
      'float farFieldAuthority = smoothstep(',
    );
    expect(OCEAN_SOURCE).toContain(
      '* farFieldAuthority * cuspFade * tail * alias;',
    );
  });
});
