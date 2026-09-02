import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const OCEAN_SOURCE = readFileSync('src/scene/Ocean.ts', 'utf8');

/**
 * Numeric mirror of the bow near-field's bounding reject and crest profile.
 *
 * The shipped shader's own string is not evidence that its guards clear the
 * shape they are guarding: WK-R9 cut the front at a flat 1.5 m and every
 * source-text assertion in the suite still passed while that cut sliced the
 * crest at its steepest point and left a straight seam across open water ahead
 * of the stem. What the guards have to satisfy is an inequality, so that is
 * what is asserted here.
 *
 * Uniform values are the ones read live out of `?perf=wake-bow` in
 * CURRENT_MODERATE at 3.59 m/s.
 */
const LAMBDA = 8.267;
const STRENGTH = 0.229;
const SHOULDER_ASTERN = 2.34;
const FOOTPRINT = 0.05;

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);

const frontLead = clamp(LAMBDA * 0.11, 0.75, 1.15);
const frontWidth = Math.max(clamp(LAMBDA * 0.075, 0.45, 0.75), FOOTPRINT * 0.75);
const shoulderWidth = Math.max(clamp(LAMBDA * 0.05, 0.32, 0.58), FOOTPRINT * 0.75);

/** |gradient| of the front's crest-plus-trough profile, on the centreline. */
function frontSlopeMagnitude(astern: number): number {
  // frontU is 0 on the centreline, so the arc's own derivative drops out and
  // fromFront is just the distance ahead of the crest centre.
  const fromFront = astern + frontLead;
  const inverseWidth2 = 1 / (frontWidth * frontWidth);
  const crest = Math.exp(-0.5 * fromFront * fromFront * inverseWidth2);
  const troughWidth = frontWidth * 1.4;
  const fromTrough = fromFront - frontWidth * 1.55;
  const trough = Math.exp(
    -0.5 * fromTrough * fromTrough / (troughWidth * troughWidth),
  );
  const derivative =
    -fromFront * inverseWidth2 * crest
    + 0.3 * fromTrough / (troughWidth * troughWidth) * trough;
  return Math.abs(derivative * frontWidth) * STRENGTH * 2.25;
}

/** |gradient| of the shoulder crest, as a function of distance outboard. */
function shoulderSlopeMagnitude(fromShoulder: number): number {
  const inverseWidth2 = 1 / (shoulderWidth * shoulderWidth);
  const crest = Math.exp(-0.5 * fromShoulder * fromShoulder * inverseWidth2);
  const troughWidth = shoulderWidth * 1.35;
  const fromTrough = fromShoulder - shoulderWidth * 1.65;
  const trough = Math.exp(
    -0.5 * fromTrough * fromTrough / (troughWidth * troughWidth),
  );
  const derivative =
    -fromShoulder * inverseWidth2 * crest
    + 0.34 * fromTrough / (troughWidth * troughWidth) * trough;
  return Math.abs(derivative * shoulderWidth) * STRENGTH * 2.1;
}

function peak(f: (x: number) => number, lo: number, hi: number): number {
  let best = 0;
  for (let i = 0; i <= 4000; i++) {
    best = Math.max(best, f(lo + ((hi - lo) * i) / 4000));
  }
  return best;
}

describe('bow near-field bounding reject', () => {
  it('clears the crest before culling ahead of the stem', () => {
    const forwardReach = frontLead + frontWidth * 3.5;
    const crestPeak = peak(frontSlopeMagnitude, -4, 4);

    // The guard has to land where there is nothing left to cut. One per cent
    // of the crest's own peak slope is well under the ambient detail gradient.
    expect(frontSlopeMagnitude(-forwardReach)).toBeLessThan(crestPeak * 0.01);
  });

  it('records what the flat 1.5 m cull was doing', () => {
    // Regression witness, not a target. WK-R9's guard sat 0.94 sigma ahead of
    // the crest centre, which is a Gaussian's steepest point: it dropped
    // essentially all of the forward face's maximum slope to zero across one
    // fragment, along a straight transverse line about four metres wide locked
    // to the bow — three quarters of the whole profile's peak slope.
    const forwardFacePeak = peak(frontSlopeMagnitude, -4, -frontLead);
    const wholeProfilePeak = peak(frontSlopeMagnitude, -4, 4);
    expect(frontSlopeMagnitude(-1.5)).toBeGreaterThan(forwardFacePeak * 0.98);
    expect(frontSlopeMagnitude(-1.5)).toBeGreaterThan(wholeProfilePeak * 0.7);
  });

  it('clears the shoulder trough before culling outboard', () => {
    const shoulderPeak = peak(shoulderSlopeMagnitude, -3, 6);
    // abeamReach carries shoulderWidth * 6.0 past the crest line, and the
    // trough sits 1.65 widths outboard of it, so this is the tail of the tail.
    expect(shoulderSlopeMagnitude(shoulderWidth * 6)).toBeLessThan(
      shoulderPeak * 0.01,
    );
  });

  it('bounds both axes and derives the forward bound from the crest', () => {
    expect(OCEAN_SOURCE).toContain(
      'float forwardReach = frontLead + frontWidth * 3.5;',
    );
    expect(OCEAN_SOURCE).toContain('absAbeam > abeamReach');
    // The literal cut is gone; nothing may reintroduce a fixed forward plane.
    expect(OCEAN_SOURCE).not.toContain('astern < -1.5');
  });
});

describe('bow near-field breaking coverage', () => {
  it('breaks only at the shoulders, never ahead of the stem', () => {
    // R9 whitened the pressure front with an outboard bias that peaked at 0.88
    // of the shoulder half-width, right where frontLateral was cutting the
    // front off — a narrow high-coverage band on each side, forward of the
    // stem, at fixed separation. Two white lines straddling the bow.
    expect(OCEAN_SOURCE).not.toContain('frontBreakBias');
    expect(OCEAN_SOURCE).not.toContain('float frontBreak =');
    // shoulderTip is what gates it, and it is zero more than 0.55 m ahead of
    // the measured shoulder cut.
    expect(OCEAN_SOURCE).toContain(
      'float shoulderTip = smoothstep(-0.55, 0.45, shoulderAlong);',
    );
    expect(SHOULDER_ASTERN - 0.55).toBeGreaterThan(0);
  });
});

describe('foam breakup grain', () => {
  it('blends two streak frames rather than rotating one sample', () => {
    // Rotating the sample moves it by |q| * dtheta, and |q| is measured from
    // the noise lattice origin — up to a full 256-cell period. An angle
    // interpolated on a decaying field therefore dragged the whole breakup
    // pattern through foam whose outline was standing still.
    expect(OCEAN_SOURCE).toContain('vec2 foamBreakupNoise(vec2 q, vec3 frame)');
    expect(OCEAN_SOURCE).not.toContain('vec2 alongRaw = mix(');
  });

  it('draws the grain only in latched frames, never in a live direction', () => {
    // WK-R11. Blending the RESULTS of two frames stops the blend being a
    // marquee; it does nothing about the frames themselves, and both were live
    // uniforms republished every frame. |q| runs to 614 m from the lattice
    // origin, so one degree of drift in either is a nine-metre slide of the
    // whole pattern through standing foam. The frames are latched on the CPU
    // and every breakup evaluation must go through the cross-fading wrapper.
    expect(OCEAN_SOURCE).toContain(
      'vec2 foamBreakupFramed(vec2 q, vec3 frameA, vec3 frameB, float blend)',
    );
    expect(OCEAN_SOURCE).toContain(
      'q, uFoamWindFrameA, uFoamWindFrameB, uFoamWindFrameBlend',
    );
    expect(OCEAN_SOURCE).toContain(
      'q, uFoamWakeFrameA, uFoamWakeFrameB, uFoamWakeFrameBlend',
    );

    // The live uniforms the frames used to be must be gone from the breakup.
    // uWakeStreakDir had no other consumer, so it is gone outright; uWindDir
    // survives for the whitecap slope bias and the salt fetch, neither of which
    // rotates a lattice coordinate — but it must never reach the grain again.
    expect(OCEAN_SOURCE).not.toContain('uWakeStreakDir');
    expect(OCEAN_SOURCE).not.toContain('uFoamStreak');
    const breakupCalls = OCEAN_SOURCE.match(/foamBreakupNoise\([^)]*\)/g) ?? [];
    expect(breakupCalls.length).toBeGreaterThan(0);
    for (const call of breakupCalls) {
      expect(call).not.toContain('uWindDir');
    }
  });

  it('shows the fine cut can never resolve a cut at its shipped scale', () => {
    // Measured spread of fnoisePeriodic about its 0.5 mean, 400k samples.
    const fineSigma = 0.176;
    // fineW's floor, from the shader.
    const narrowestBand = 0.16;
    // Erosion needs a band well inside the noise's own spread. At 0.9 sigma
    // this smoothstep passes a third of the distribution through a smooth
    // ramp, which is shading, not holes — the wood-grain marbling.
    expect(narrowestBand / fineSigma).toBeGreaterThan(0.85);
    expect(OCEAN_SOURCE).toContain('float fineResolve =');
    expect(OCEAN_SOURCE).toContain('mask *= mix(fineMean, fineCut, fineResolve);');
  });
});
