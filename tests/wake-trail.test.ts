import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import {
  FoamField,
  foamDecayFactor,
  foamFieldAdvectionStep,
  quantizeFoamFieldScroll,
} from '../src/scene/FoamField';
import { WaveField } from '../src/scene/Waves';
import {
  GRAVITY_MPS2,
  KELVIN_HALF_ANGLE_RAD,
  WAKE_POLICY_HULL_SPEED_MPS,
  createWakePatternPolicyResult,
  createWakeTrailPolicyResult,
  gateWakeTrailAppearance,
  kelvinTransverseWavelengthM,
  resolveWakePatternPolicy,
  resolveWakeTrailPolicy,
  type WakeTrailPolicyInput,
} from '../src/scene/wakePolicy';
import { SAILING_HULL_SPEED_MPS } from '../src/vessel/schooner/SailingForceEvidence';

function input(overrides: Partial<WakeTrailPolicyInput> = {}): WakeTrailPolicyInput {
  return {
    speedThroughWaterMps: 3,
    ambientWhitecapCoverage: 0.002,
    windSpeedMps: 6,
    sternWidthM: 2.4,
    sternSourceAvailable: true,
    ...overrides,
  };
}

describe('WK1 wake policy', () => {
  it('non-dimensionalises against the sailing thread\'s one hull speed', () => {
    // Pinned by test rather than by import so the render bundle never depends
    // on an evidence harness. If either side changes its number, this failure
    // is the two threads being asked to agree again — not a licence to fork.
    expect(WAKE_POLICY_HULL_SPEED_MPS).toBe(SAILING_HULL_SPEED_MPS);
  });

  it('injects exactly zero at zero speed while retaining stored-trail appearance gains', () => {
    const result = createWakeTrailPolicyResult();
    resolveWakeTrailPolicy(input({ speedThroughWaterMps: 0 }), result);

    expect(result.activeFoamRatePerSecond).toBe(0);
    expect(result.residualFoamRatePerSecond).toBe(0);
    expect(result.turbulenceRatePerSecond).toBe(0);
    // Existing B history is allowed to remain visible and decay after stopping.
    expect(result.bubbleHaze).toBeGreaterThan(0);
  });

  it('uses the displacement-hull V-squared stern drive', () => {
    const slow = createWakeTrailPolicyResult();
    const fast = createWakeTrailPolicyResult();
    resolveWakeTrailPolicy(input({ speedThroughWaterMps: 1 }), slow);
    resolveWakeTrailPolicy(input({ speedThroughWaterMps: 2 }), fast);

    expect(fast.activeFoamRatePerSecond / slow.activeFoamRatePerSecond).toBeCloseTo(4, 12);
    expect(fast.residualFoamRatePerSecond / slow.residualFoamRatePerSecond).toBeCloseTo(4, 12);
    expect(fast.turbulenceRatePerSecond / slow.turbulenceRatePerSecond).toBeCloseTo(4, 12);
  });

  it('does not invent a source from a one-sided or missing stern cut', () => {
    const result = createWakeTrailPolicyResult();
    resolveWakeTrailPolicy(input({ sternSourceAvailable: false }), result);
    expect(result.activeFoamRatePerSecond).toBe(0);
    expect(result.residualFoamRatePerSecond).toBe(0);
    expect(result.turbulenceRatePerSecond).toBe(0);
  });

  it('narrows, dims, and mixes the trail faster under rough ambient whitewater', () => {
    const moderate = createWakeTrailPolicyResult();
    const rough = createWakeTrailPolicyResult();
    resolveWakeTrailPolicy(input(), moderate);
    resolveWakeTrailPolicy(
      input({ ambientWhitecapCoverage: 0.06, windSpeedMps: 18 }),
      rough,
    );

    expect(rough.seaMask).toBe(1);
    expect(rough.sourceRadiusM).toBeLessThan(moderate.sourceRadiusM);
    expect(rough.turbulenceRatePerSecond).toBeLessThan(
      moderate.turbulenceRatePerSecond,
    );
    expect(rough.turbulenceTauSeconds).toBeLessThan(
      moderate.turbulenceTauSeconds,
    );
  });

  it('makes the master-off appearance path exactly zero', () => {
    const policy = createWakeTrailPolicyResult();
    resolveWakeTrailPolicy(input(), policy);
    const appearance = {
      bubbleHaze: -1,
      whitecapSuppression: -1,
      trailFoamFloor: -1,
    };
    gateWakeTrailAppearance(policy, false, true, true, true, appearance);
    expect(appearance).toEqual({
      bubbleHaze: 0,
      whitecapSuppression: 0,
      trailFoamFloor: 0,
    });
  });
});

describe('WK-R4 wave pattern policy', () => {
  it('pins the transverse wavelength to 2πV²/g and the wedge to asin(1/3)', () => {
    for (const v of [1.5, 2.6, 3.5, 4.1, 4.7]) {
      expect(kelvinTransverseWavelengthM(v)).toBeCloseTo(
        (2 * Math.PI * v * v) / GRAVITY_MPS2,
        12,
      );
    }
    // 19.47°: a deep-water constant, not a tunable.
    expect((KELVIN_HALF_ANGLE_RAD * 180) / Math.PI).toBeCloseTo(19.4712, 3);
  });

  it('is exactly zero at anchor and fades under ambient sea energy and turns', () => {
    const still = createWakePatternPolicyResult();
    resolveWakePatternPolicy(
      { speedThroughWaterMps: 0, ambientWhitecapCoverage: 0.002, turnRateRadPerSec: 0 },
      still,
    );
    expect(still.normalStrength).toBe(0);

    const glassy = createWakePatternPolicyResult();
    const rough = createWakePatternPolicyResult();
    const turning = createWakePatternPolicyResult();
    resolveWakePatternPolicy(
      { speedThroughWaterMps: 3.5, ambientWhitecapCoverage: 0.0, turnRateRadPerSec: 0 },
      glassy,
    );
    resolveWakePatternPolicy(
      { speedThroughWaterMps: 3.5, ambientWhitecapCoverage: 0.06, turnRateRadPerSec: 0 },
      rough,
    );
    resolveWakePatternPolicy(
      { speedThroughWaterMps: 3.5, ambientWhitecapCoverage: 0.0, turnRateRadPerSec: 0.2 },
      turning,
    );
    expect(glassy.normalStrength).toBeGreaterThan(0);
    expect(rough.normalStrength).toBeLessThan(glassy.normalStrength * 0.25);
    // Hard turn: the analytic steady pattern declines to lie about the curve.
    expect(turning.normalStrength).toBe(0);
  });
});

describe('WK1 foam-field contract', () => {
  it('advects the trail opposite the full course vector, including leeway sign', () => {
    // Hull heading is +Z, but the imposed course has +X leeway. Old field
    // contents must therefore move toward both -X and -Z behind the vessel.
    const step = { x: 0, z: 0 };
    foamFieldAdvectionStep(
      0.25,
      { x: 1, y: 0 },
      0,
      0,
      { x: 0.4, z: 3.2 },
      step,
    );
    expect(step.x).toBeCloseTo(-0.1, 12);
    expect(step.z).toBeCloseTo(-0.8, 12);
  });

  it('scrolls in whole texels only, never losing distance to the quantiser', () => {
    // The advection copy is only lossless when it lands on texel centres, so
    // every sub-texel fraction must wait in the remainder rather than being
    // resampled — and nothing may be lost or invented while it waits.
    const texel = 1.5;
    const remainder = { x: 0, y: 0 };
    const shift = { x: 0, y: 0 };
    // 4.1 m/s at 24 Hz: 0.170833… m per step, 0.1139 texels — the moderate
    // polar case that used to diffuse the trail away.
    const step = 4.1 / 24;
    let shiftedTexels = 0;
    for (let i = 0; i < 240; i++) {
      quantizeFoamFieldScroll(-step, 0, texel, remainder, shift);
      shiftedTexels += shift.x;
      expect(Number.isInteger(shift.x)).toBe(true);
      expect(shift.y).toBe(0);
      expect(Math.abs(remainder.x)).toBeLessThanOrEqual(texel / 2 + 1e-9);
    }
    // Exactness: shifted whole texels plus the parked remainder is the exact
    // distance travelled. This is the no-numerical-diffusion contract.
    expect(shiftedTexels * texel + remainder.x).toBeCloseTo(-step * 240, 9);
    expect(Math.abs(shiftedTexels)).toBeGreaterThan(0);
  });

  it('parks sub-texel drift in the remainder without shifting at all', () => {
    // Wind drift in the moderate preset is ~0.0075 m per step against a 12 m
    // far texel: the far level must simply hold position (no blur, no creep)
    // until a whole texel has genuinely accumulated.
    const remainder = { x: 0, y: 0 };
    const shift = { x: 0, y: 0 };
    for (let i = 0; i < 100; i++) {
      quantizeFoamFieldScroll(0.0075, 0.0075, 12, remainder, shift);
      expect(shift.x).toBe(0);
      expect(shift.y).toBe(0);
    }
    expect(remainder.x).toBeCloseTo(0.75, 12);
    expect(remainder.y).toBeCloseTo(0.75, 12);
  });

  it('decays B by the exact exponential at arbitrary step sizes', () => {
    const tau = 27.5;
    const a = 0.137;
    const b = 1.913;
    expect(foamDecayFactor(a + b, tau)).toBeCloseTo(
      foamDecayFactor(a, tau) * foamDecayFactor(b, tau),
      15,
    );
    expect(foamDecayFactor(0, tau)).toBe(1);
  });

  it('allocates RGBA half-float storage and accounts for all four channels', () => {
    const field = new FoamField(new WaveField(findSeaState('CURRENT_MODERATE')), {
      hullResolution: 2,
      nearResolution: 8,
      farResolution: 4,
      updateHz: 24,
    });
    const internals = field as unknown as {
      injectMaterial: THREE.ShaderMaterial;
      advectMaterial: THREE.ShaderMaterial;
    };
    expect(field.nearTexture.format).toBe(THREE.RGBAFormat);
    expect(field.farTexture.format).toBe(THREE.RGBAFormat);
    expect(field.hullTexture.format).toBe(THREE.RGBAFormat);
    // All three levels, both ping-pong halves each.
    expect(field.memoryBytes).toBe((8 * 8 + 4 * 4 + 2 * 2) * 4 * 2 * 2);
    expect(internals.injectMaterial.blending).toBe(THREE.CustomBlending);
    expect(internals.injectMaterial.blendSrc).toBe(THREE.OneFactor);
    expect(internals.injectMaterial.blendDst).toBe(THREE.OneFactor);
    expect(internals.injectMaterial.blendSrcAlpha).toBe(THREE.ZeroFactor);
    expect(internals.injectMaterial.blendDstAlpha).toBe(THREE.OneFactor);
    expect(internals.advectMaterial.uniforms.uDecay.value).toBeInstanceOf(
      THREE.Vector3,
    );
    field.dispose();
  });

  // The two tests below pin exact source text as a proxy for GPU behaviour,
  // because vitest has no GPU to render with. They are deliberately brittle:
  // a failure means a shader expression this project promised to preserve has
  // changed shape. The right response is to read the shader diff, decide
  // whether the promise still holds, and re-pin the new text on purpose —
  // never to revert the shader to satisfy the string, and never to loosen the
  // match until it passes. Behavioural verification lives in the contact
  // sheet and the paired GPU runs, not here.
  it('preserves ambient R/G arithmetic and keeps additive alpha stable', () => {
    const foam = readFileSync('src/scene/FoamField.ts', 'utf8');
    expect(foam).toContain('vec2 ambientInjected = rate * uDeltaTime / uTau.xy;');
    expect(foam).toContain(
      'vec3 injected = vec3(ambientInjected.x, ambientInjected.y * 0.85, 0.0);',
    );
    expect(foam).toContain('gl_FragColor = vec4(injected, 0.0);');
    expect(foam).toContain('blendSrcAlpha: THREE.ZeroFactor');
    expect(foam).toContain('blendDstAlpha: THREE.OneFactor');
    expect(foam).toContain('this.simulate(renderer, waves, step, options, false);');
  });

  it('shares one persistent-field fetch while preserving ambient detail through the wake', () => {
    const ocean = readFileSync('src/scene/Ocean.ts', 'utf8');
    expect(ocean.match(/texture2D\(uFoamNear/g)).toHaveLength(1);
    // One persistent-field read plus the established upwind salt-loading read.
    expect(ocean.match(/texture2D\(uFoamFar/g)).toHaveLength(2);
    expect(ocean).toContain('persistentFoam = persistentFoamField(');
    expect(ocean).not.toContain('wakeDetailDamping');
    expect(ocean).not.toContain('wakeMicroScale');
    expect(ocean).toContain(
      'float sigma2 = uUnresolvedSlopeVariance + variance * jGain + slopeJitter2;',
    );
    expect(ocean).toContain('wakeTurbulence * uWakeWhitecapSuppression');
  });
});
