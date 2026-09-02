import { describe, expect, it } from 'vitest';
import { SEA_STATES, findSeaState } from '../src/ocean/presets';
import type { SeaState } from '../src/ocean/seaState';
import {
  MAX_WAVES,
  SLOTS_DEFAULT,
  blendSeaState,
  cloneSeaState,
  resolveSeaState,
} from '../src/ocean/seaState';
import {
  MIN_WAVELENGTH,
  breakingExceedance,
  breakingThreshold,
  breakingThresholdComposite,
  coxMunkSlopeVariance,
  fullyDevelopedHeight,
  fullyDevelopedPeriod,
  geometricFloor,
  safeGlobalQ,
  spreadExponentForDegrees,
  whitecapCoverage,
  windSeaFromWind,
} from '../src/ocean/spectrum';
import { WaveField } from '../src/scene/Waves';

const TWO_PI = Math.PI * 2;

describe('spectrum discretisation', () => {
  it('reproduces the requested significant height exactly', () => {
    // Hs = 4*sqrt(m0) is definitional, and the components are renormalised so
    // it holds for the finite sum actually rendered rather than for the
    // integral of the continuous shape. If this drifts, every preset's
    // documented height is a lie.
    for (const state of SEA_STATES) {
      if (state.name === 'FLAT') continue;
      const spectrum = resolveSeaState(state, SLOTS_DEFAULT);
      let variance = 0;
      for (const c of spectrum.components) variance += 0.5 * c.amplitude * c.amplitude;
      const measured = 4 * Math.sqrt(variance);
      expect(Math.abs(measured - spectrum.significantHeight)).toBeLessThan(1e-9);
    }
  });

  it('combines independent systems in quadrature', () => {
    const state = cloneSeaState(findSeaState('CROSSING_SEAS'));
    const spectrum = resolveSeaState(state, SLOTS_DEFAULT);
    const windSea = windSeaFromWind(state.generatingWind.speedMps, state.generatingWind.maturity);
    const expected = Math.hypot(
      windSea.significantHeight,
      state.primary.significantHeight,
      state.secondary.significantHeight,
    );
    // Within the floor-gated fraction, not exact: the ladder's deepest rungs
    // sit below MIN_WAVELENGTH and their energy deliberately goes to the
    // unresolved band instead of being re-inflated into the survivors. For a
    // developed sea that fraction is under one percent.
    expect(spectrum.significantHeight / expected).toBeGreaterThan(0.99);
    expect(spectrum.significantHeight / expected).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('never emits a component shorter than the state\'s own geometric floor', () => {
    // The floor is MIN_WAVELENGTH at microChop 0 and slides toward ~1.1 m at
    // microChop 1 — a deliberate art control, not a leak.
    for (const state of SEA_STATES) {
      const floor = geometricFloor(state.roughness.microChop);
      for (const c of resolveSeaState(state, SLOTS_DEFAULT).components) {
        if (c.amplitude === 0) continue;
        expect(c.wavelength).toBeGreaterThanOrEqual(floor - 1e-6);
      }
    }
  });

  it('micro chop adds real short-wave geometry and keeps Hs bookkeeping', () => {
    const base = cloneSeaState(findSeaState('WIND_CHOP'));
    (base.roughness as { microChop: number }).microChop = 0;
    const micro = cloneSeaState(findSeaState('WIND_CHOP'));
    (micro.roughness as { microChop: number }).microChop = 1;

    const shortLive = (s: SeaState) =>
      resolveSeaState(s, SLOTS_DEFAULT).components.filter(
        (c) => c.amplitude > 1e-5 && c.wavelength < MIN_WAVELENGTH,
      ).length;
    expect(shortLive(base)).toBe(0);
    expect(shortLive(micro)).toBeGreaterThanOrEqual(2);

    // The boost redistributes within the system; combined Hs stays within the
    // floor-gated bookkeeping either way.
    const a = resolveSeaState(base, SLOTS_DEFAULT).significantHeight;
    const b = resolveSeaState(micro, SLOTS_DEFAULT).significantHeight;
    expect(Math.abs(a - b) / a).toBeLessThan(0.06);
  });

  it('holds slot identity when a system is disabled', () => {
    // Slot identity is what makes a smooth morph possible. A system with no
    // energy must still occupy its slots, or enabling it would shift every
    // later component onto a different frequency and phase.
    const withSecondary = resolveSeaState(findSeaState('CROSSING_SEAS'), SLOTS_DEFAULT);
    const withoutSecondary = resolveSeaState(findSeaState('CURRENT_MODERATE'), SLOTS_DEFAULT);
    expect(withSecondary.components.length).toBe(48);
    expect(withoutSecondary.components.length).toBe(48);
    expect(withSecondary.components.length).toBeLessThanOrEqual(MAX_WAVES);
  });

  it('is deterministic for a given state', () => {
    const a = resolveSeaState(findSeaState('MATURE_WIND_SEA'), SLOTS_DEFAULT);
    const b = resolveSeaState(findSeaState('MATURE_WIND_SEA'), SLOTS_DEFAULT);
    for (let i = 0; i < a.components.length; i++) {
      expect(a.components[i].wavelength).toBe(b.components[i].wavelength);
      expect(a.components[i].amplitude).toBe(b.components[i].amplitude);
      expect(a.components[i].seedPhase).toBe(b.components[i].seedPhase);
      expect(a.components[i].dirX).toBe(b.components[i].dirX);
    }
  });

  it('gives no two free components the same direction', () => {
    // Exact spatial periodicity of a 2-D sum needs commensurability in both
    // axes at once, which generically cannot happen once directions differ.
    // Duplicated directions are the single strongest route to a visible tile.
    //
    // Bound harmonics are exempt — and must be: a bound harmonic shares its
    // carrier's direction *by definition* (it is the carrier's own profile,
    // phase-locked at 2ω), so it travels with the carrier forever and cannot
    // form an independent interference tile with it.
    const spectrum = resolveSeaState(findSeaState('SOUTHERN_OCEAN_ROUGH'), SLOTS_DEFAULT);
    const angles = spectrum.components
      .filter((c) => c.amplitude > 0 && c.boundTo < 0)
      .map((c) => Math.atan2(c.dirX, -c.dirZ));
    for (let i = 0; i < angles.length; i++) {
      for (let j = i + 1; j < angles.length; j++) {
        expect(Math.abs(angles[i] - angles[j])).toBeGreaterThan(1e-4);
      }
    }
  });

  it('locks every bound harmonic to a live carrier of twice its wavelength', () => {
    for (const state of SEA_STATES) {
      const spectrum = resolveSeaState(state, SLOTS_DEFAULT);
      for (const c of spectrum.components) {
        if (c.boundTo < 0) continue;
        const carrier = spectrum.components[c.boundTo];
        expect(carrier).toBeDefined();
        expect(carrier.boundTo).toBe(-1);
        if (c.amplitude > 0) {
          expect(carrier.amplitude).toBeGreaterThan(0);
          expect(c.wavelength * 2).toBeCloseTo(carrier.wavelength, 9);
          expect(c.dirX).toBe(carrier.dirX);
          expect(c.dirZ).toBe(carrier.dirZ);
          // Stokes second order: a₂ ≤ ½·(ka)·a, policy-capped at 0.2·a.
          expect(c.amplitude).toBeLessThanOrEqual(carrier.amplitude * 0.2 + 1e-12);
        }
      }
    }
  });

  it('matches the exact directional first moment of the spreading function', () => {
    // For D(theta) proportional to cos^2s(theta/2), <cos(theta - theta0)> is
    // exactly s/(s+1). The sampler is stratified rather than random, so it
    // should converge much faster than a Monte Carlo draw.
    const state = cloneSeaState(findSeaState('GLASSY_LONG_SWELL'));
    const spectrum = resolveSeaState(state, SLOTS_DEFAULT);
    const heading = (state.primary.directionDeg * Math.PI) / 180;
    const s = spreadExponentForDegrees(state.primary.spreadDeg);

    let weight = 0;
    let projected = 0;
    for (const c of spectrum.components) {
      if (c.amplitude <= 1e-6) continue;
      const angle = Math.atan2(c.dirX, -c.dirZ);
      // Swell only: the wind sea has its own, much broader spread.
      if (Math.abs(((angle - heading + Math.PI) % TWO_PI) - Math.PI) > 0.6) continue;
      const w = c.amplitude * c.amplitude;
      weight += w;
      projected += w * Math.cos(angle - heading);
    }
    expect(projected / weight).toBeCloseTo(s / (s + 1), 1);
  });
});

describe('wind-sea growth', () => {
  it('reaches the Pierson-Moskowitz limits at full development', () => {
    for (const u of [5, 10, 15, 20]) {
      const sea = windSeaFromWind(u, 1);
      expect(sea.significantHeight).toBeCloseTo(fullyDevelopedHeight(u), 6);
      expect(sea.peakPeriod).toBeCloseTo(fullyDevelopedPeriod(u), 6);
    }
    // The textbook fully-developed sea for a 10 m/s wind.
    expect(fullyDevelopedHeight(10)).toBeCloseTo(2.47, 1);
    expect(fullyDevelopedPeriod(10)).toBeCloseTo(7.84, 1);
  });

  it('makes a young sea shorter and steeper, not merely smaller', () => {
    // This is the single most recognisable property of wind chop, and the
    // reason it cannot be produced by scaling a swell down.
    const young = windSeaFromWind(12, 0.25);
    const mature = windSeaFromWind(12, 1);
    expect(young.significantHeight).toBeLessThan(mature.significantHeight);
    expect(young.peakPeriod).toBeLessThan(mature.peakPeriod);

    const steepness = (s: { significantHeight: number; peakPeriod: number }): number =>
      s.significantHeight / (1.5613 * s.peakPeriod * s.peakPeriod);
    expect(steepness(young)).toBeGreaterThan(steepness(mature));
  });

  it('produces no wind sea at all in a dead calm', () => {
    expect(windSeaFromWind(0, 1).significantHeight).toBe(0);
    expect(windSeaFromWind(10, 0).significantHeight).toBe(0);
  });
});

describe('whitecap calibration', () => {
  it('tracks Monahan below 16 m/s and saturates above it', () => {
    // Relative, not absolute: the quantity spans four orders of magnitude
    // across this range, so an absolute tolerance tests only the small end.
    for (const u of [5, 7, 10, 12, 14]) {
      const monahan = 3.84e-6 * u ** 3.41;
      expect(Math.abs(whitecapCoverage(u) / monahan - 1)).toBeLessThan(0.05);
    }
    expect(Math.abs(whitecapCoverage(10) / (3.84e-6 * 10 ** 3.41) - 1)).toBeLessThan(0.01);
    // The power law over-predicts badly at storm force; shipborne measurement
    // finds coverage levelling off near 10 %.
    expect(whitecapCoverage(25)).toBeLessThan(0.11);
    expect(whitecapCoverage(40)).toBeLessThan(0.11);
    expect(whitecapCoverage(0)).toBe(0);
  });

  it('raises the breaking threshold as the sea gets calmer', () => {
    const rough = breakingThreshold(0.015, 1, 18, 0);
    const calm = breakingThreshold(0.0005, 1, 2, 0);
    // In trace space a *higher* threshold means harder to break. A calm sea
    // must be harder to break than a rough one at the same steepness.
    expect(calm / Math.sqrt(0.0005)).toBeGreaterThan(rough / Math.sqrt(0.015));
  });

  it('treats the threshold bias in units of sigma, with the documented sign', () => {
    // This is a threshold in trace space: higher is harder to break. A negative
    // bias is documented as making foam *easier*, so it must lower the
    // threshold. Getting this backwards inverted whitecap coverage against wind
    // speed across the whole preset matrix, so it is worth a test of its own.
    const sigma = Math.sqrt(0.01);
    const neutral = breakingThreshold(0.01, 1, 12, 0);
    const easier = breakingThreshold(0.01, 1, 12, -0.5);
    const harder = breakingThreshold(0.01, 1, 12, 0.5);
    expect(easier).toBeLessThan(neutral);
    expect(harder).toBeGreaterThan(neutral);
    expect(neutral - easier).toBeCloseTo(0.5 * sigma, 9);
  });

  it('gives rougher seas more whitecap coverage than calmer ones', () => {
    // The regression this guards against is not subtle when it happens: the
    // preset trims silently inverted the physical ordering. Coverage is
    // reproduced from the same carrier-plus-Gaussian distribution the
    // threshold is calibrated against (`breakingExceedance`), so this also
    // pins that the calibration and the field agree with each other.
    const coverageOrder = ['GLASSY_LONG_SWELL', 'CURRENT_MODERATE', 'WIND_CHOP',
      'MATURE_WIND_SEA', 'SOUTHERN_OCEAN_ROUGH'];
    let previous = -Infinity;
    for (const name of coverageOrder) {
      const state = findSeaState(name);
      const field = new WaveField(state);
      const fraction =
        breakingExceedance(field.breakingDominant, field.breakingSigmaRest, field.breakingThreshold) *
        state.whitewater.generation;
      expect(fraction).toBeGreaterThanOrEqual(previous);
      previous = fraction;
    }
  });

  it('recovers Monahan coverage from the composite threshold at zero bias', () => {
    // The threshold is *defined* as the level whose exceedance equals the
    // observed whitecap coverage; solving and re-evaluating must round-trip.
    for (const [dominant, sigmaRest, wind] of [
      [0.15, 0.05, 12], [0.02, 0.08, 8], [0.3, 0.02, 18], [0, 0.06, 10],
    ]) {
      const threshold = breakingThresholdComposite(dominant, sigmaRest, wind, 0);
      const coverage = breakingExceedance(dominant, sigmaRest, threshold);
      expect(coverage / whitecapCoverage(wind)).toBeCloseTo(1, 2);
    }
  });

  it('keeps folding out of reach with the carrier taken at its worst', () => {
    // The composed field is carrier-dominated, so the fold bound treats the
    // top three steepness terms deterministically (all aligned at once) and
    // only the long tail statistically. The all-Gaussian bound is kept only as
    // the no-carrier limit.
    for (const state of SEA_STATES) {
      const field = new WaveField(state);
      const terms = field
        .describeComponents()
        .map((c) => c.steepness)
        .sort((a, b) => b - a);
      const top = terms.slice(0, 3).reduce((s, t) => s + t, 0);
      const restSigma = Math.sqrt(
        terms.slice(3).reduce((s, t) => s + 0.5 * t * t, 0),
      );
      expect(top + 3.2 * restSigma).toBeLessThanOrEqual(0.95 + 1e-9);
      // And the Gaussian-limit helper still honours its own contract.
      const q = safeGlobalQ(field.meanSquareSlope);
      const sigma = q * Math.sqrt(field.meanSquareSlope);
      if (sigma > 0) expect(1 / sigma).toBeGreaterThanOrEqual(4.5 - 1e-9);
    }
  });

  it('never asks the shading for a negative roughness', () => {
    // Cox-Munk describes a *wind-roughened* surface and says nothing about
    // swell slope, so a steep swell under no wind legitimately resolves more
    // slope variance than the Cox-Munk total for that wind. The subtraction
    // must therefore clamp, and the clamp must be the only thing that saves it.
    let clamped = 0;
    for (const state of SEA_STATES) {
      const field = new WaveField(state);
      expect(field.unresolvedSlopeVariance).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(field.unresolvedSlopeVariance)).toBe(true);
      const total = coxMunkSlopeVariance(state.generatingWind.speedMps);
      if (field.meanSquareSlope >= total) clamped++;
    }
    // FROZEN_SINGLE is the case: a 0.5 m amplitude wave in a dead calm.
    expect(clamped).toBeLessThanOrEqual(2);
  });
});

describe('WaveField', () => {
  it('keeps the Gerstner sum below the folding limit in every preset', () => {
    for (const state of SEA_STATES) {
      const field = new WaveField(state);
      expect(field.steepnessSum).toBeLessThanOrEqual(1.25 + 1e-9);
      expect(Number.isFinite(field.steepnessSum)).toBe(true);
    }
  });

  it('inverts the horizontal displacement to within a hundredth of a millimetre', () => {
    for (const name of ['CURRENT_MODERATE', 'SOUTHERN_OCEAN_ROUGH', 'EXTREME_DEBUG']) {
      const field = new WaveField(findSeaState(name));
      field.setTime(37.25);
      let worst = 0;
      for (let x = -40; x <= 40; x += 7) {
        for (let z = -40; z <= 40; z += 7) {
          field.sampleHeight(x, z);
          worst = Math.max(worst, field.lastSolveResidual);
        }
      }
      expect(worst).toBeLessThan(1e-5);
    }
  });

  it('is reproducible from absolute time, with no accumulation', () => {
    // setTime() must be a jump, not a replay. A field advanced in small steps
    // and one set directly must agree to the last bit, or long sessions drift.
    const stepped = new WaveField(findSeaState('CROSSING_SEAS'));
    const jumped = new WaveField(findSeaState('CROSSING_SEAS'));
    for (let i = 0; i < 400; i++) stepped.advance(0.05);
    jumped.setTime(20);
    for (const [x, z] of [[0, 0], [13, -7], [-31, 44]]) {
      expect(stepped.sampleHeight(x, z)).toBeCloseTo(jumped.sampleHeight(x, z), 9);
    }
  });

  it('carries phase across a continuous sea-state change', () => {
    // The whole transition design rests on this: change a slot's frequency and
    // the surface must not move in that instant. Without the re-seeding in
    // applySeaState, -omega*t jumps by delta_omega*t, which at ten minutes in
    // is several radians — the wave teleports.
    //
    // Two assertions. The 2 % step bound is looser than it was pre-composition
    // (0.12 m, not 0.05 m): concentrating the wind sea's variance in a carrier
    // makes a frequency shift show as one coherent centimetre-scale change
    // rather than an incoherent smaller one. What actually matters for a real
    // transition is the per-frame step, which is ~0.1 % for a 20 s morph —
    // the second assertion pins that at sub-centimetre, and the ratio between
    // the two pins the change as linear in the step (continuous), which is the
    // property a phase reset would break by a factor of a hundred.
    const xs = [-20, -5, 0, 11, 27];
    const target = findSeaState('MATURE_WIND_SEA');

    const deltaFor = (step: number): number => {
      const field = new WaveField(findSeaState('CURRENT_MODERATE'));
      field.setTime(600);
      const before = xs.map((x) => field.sampleHeight(x, 3));
      field.applySeaState(blendSeaState(field.state, target, step), true);
      return Math.max(...xs.map((x, i) => Math.abs(field.sampleHeight(x, 3) - before[i])));
    };

    const coarse = deltaFor(0.02);
    const fine = deltaFor(0.001);
    expect(coarse).toBeLessThan(0.12);
    expect(fine).toBeLessThan(0.01);
    expect(coarse / Math.max(fine, 1e-9)).toBeLessThan(30);
  });

  it('produces no motion at all in the flat state', () => {
    const field = new WaveField(findSeaState('FLAT'));
    field.setTime(123.456);
    for (const [x, z] of [[0, 0], [50, -50], [-120, 90]]) {
      expect(field.sampleHeight(x, z)).toBe(0);
    }
  });

  it('reports a compression that reaches the breaking threshold in rough seas', () => {
    const field = new WaveField(findSeaState('SOUTHERN_OCEAN_ROUGH'));
    const out = {
      height: 0, normalX: 0, normalY: 1, normalZ: 0,
      velocityX: 0, velocityY: 0, velocityZ: 0, jacobian: 1, compression: 0,
    };
    let peak = -Infinity;
    for (let t = 0; t < 8; t++) {
      field.setTime(t * 1.7);
      for (let x = -150; x <= 150; x += 11) {
        for (let z = -150; z <= 150; z += 11) {
          field.sample(x, z, out);
          peak = Math.max(peak, out.compression);
        }
      }
    }
    expect(peak).toBeGreaterThan(field.breakingThreshold);
  });

  it('never breaks a glassy swell under no wind', () => {
    const field = new WaveField(findSeaState('GLASSY_LONG_SWELL'));
    // A 1.9 m swell is large, but nothing local is driving it. The wind gate in
    // the injection shader is what enforces this at render time; here we only
    // check the sea state agrees that there is no wind to gate on.
    expect(field.state.generatingWind.speedMps).toBeLessThan(3.5);
  });
});

describe('sea-state interpolation', () => {
  it('takes the shortest arc through north', () => {
    const a = cloneSeaState(findSeaState('CURRENT_MODERATE'));
    const b = cloneSeaState(findSeaState('CURRENT_MODERATE'));
    (a.generatingWind as { directionDeg: number }).directionDeg = 350;
    (b.generatingWind as { directionDeg: number }).directionDeg = 10;
    const mid = blendSeaState(a, b, 0.5);
    // Halfway from 350 to 10 is 0, not 180.
    expect(((mid.generatingWind.directionDeg % 360) + 360) % 360).toBeCloseTo(0, 6);
  });

  it('ramps a switching-on system up from zero height', () => {
    const off = cloneSeaState(findSeaState('CURRENT_MODERATE'));
    const on = cloneSeaState(findSeaState('CROSSING_SEAS'));
    expect(off.secondary.enabled).toBe(false);
    expect(on.secondary.enabled).toBe(true);
    const start = blendSeaState(off, on, 0);
    const quarter = blendSeaState(off, on, 0.25);
    expect(start.secondary.significantHeight).toBe(0);
    expect(quarter.secondary.significantHeight).toBeGreaterThan(0);
    expect(quarter.secondary.significantHeight).toBeLessThan(on.secondary.significantHeight);
  });

  it('is continuous at both ends', () => {
    const a = findSeaState('DEAD_CALM');
    const b = findSeaState('SOUTHERN_OCEAN_ROUGH');
    expect(blendSeaState(a, b, 0).generatingWind.speedMps).toBeCloseTo(a.generatingWind.speedMps, 9);
    expect(blendSeaState(a, b, 1).generatingWind.speedMps).toBeCloseTo(b.generatingWind.speedMps, 9);
  });
});

describe('preset matrix', () => {
  it('has a unique name for every state and a production default', () => {
    const names = new Set(SEA_STATES.map((s) => s.name));
    expect(names.size).toBe(SEA_STATES.length);
    expect(findSeaState('CURRENT_MODERATE').name).toBe('CURRENT_MODERATE');
    // An unknown name must fall back to production, not to undefined.
    expect(findSeaState('nonexistent').name).toBe('CURRENT_MODERATE');
  });

  it('orders the presets by significant height as their names imply', () => {
    const hs = (name: string): number =>
      resolveSeaState(findSeaState(name), SLOTS_DEFAULT).significantHeight;
    expect(hs('DEAD_CALM')).toBeLessThan(hs('WIND_CHOP'));
    expect(hs('CURRENT_MODERATE')).toBeLessThan(hs('GLASSY_LONG_SWELL'));
    expect(hs('CROSSING_SEAS')).toBeLessThan(hs('MATURE_WIND_SEA'));
    expect(hs('MATURE_WIND_SEA')).toBeLessThan(hs('SOUTHERN_OCEAN_ROUGH'));
    expect(hs('SOUTHERN_OCEAN_ROUGH')).toBeLessThan(hs('EXTREME_DEBUG'));
  });

  it('keeps the production preset close to the ocean it replaces', () => {
    // The pre-round shipping ocean (1765bb7 DEFAULT_WAVES at its 1.00×
    // amplitude): Hs = 4·√(Σa²/2) = 1.165 m, dominant 0.33 m at 62 m (6.3 s),
    // and almost no energy below 16 m. This preset is the visual-regression
    // baseline and must not drift away from it.
    //
    // History demands the audit trail: the first restatement pinned this
    // window at 0.45–0.75 m because the old Hs had been derived as 2·√m0 —
    // half the definitional value — so the "production ocean" shipped at half
    // height and read as small, busy chop next to the original.
    const spectrum = resolveSeaState(findSeaState('CURRENT_MODERATE'), SLOTS_DEFAULT);
    expect(spectrum.significantHeight).toBeGreaterThan(1.05);
    expect(spectrum.significantHeight).toBeLessThan(1.3);
    expect(spectrum.dominantPeriod).toBeCloseTo(6.3, 1);

    // And the shape, not just the size: the biggest component sits on the old
    // dominant's 62 m wavelength, and the sub-16 m band stays a whisper, as
    // it was in the original.
    const live = spectrum.components.filter((c) => c.amplitude > 0);
    const biggest = live.reduce((a, b) => (a.amplitude >= b.amplitude ? a : b));
    expect(biggest.wavelength).toBeGreaterThan(55);
    expect(biggest.wavelength).toBeLessThan(70);
    expect(biggest.amplitude).toBeGreaterThan(0.2);
    const shortVariance = live
      .filter((c) => c.wavelength < 16)
      .reduce((s, c) => s + 0.5 * c.amplitude * c.amplitude, 0);
    const totalVariance = live.reduce((s, c) => s + 0.5 * c.amplitude * c.amplitude, 0);
    expect(shortVariance / totalVariance).toBeLessThan(0.06);
  });

  it('gives the single-component diagnostic exactly one wave of known size', () => {
    const spectrum = resolveSeaState(findSeaState('FROZEN_SINGLE'), SLOTS_DEFAULT);
    const live = spectrum.components.filter((c) => c.amplitude > 0);
    expect(live.length).toBe(1);
    expect(live[0].amplitude).toBeCloseTo(0.5, 3);
    expect(live[0].wavelength).toBeCloseTo(40, 0);
  });
});
