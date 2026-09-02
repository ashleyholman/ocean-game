import { describe, expect, it } from 'vitest';
import { SEA_STATES, findSeaState } from '../src/ocean/presets';
import { SLOTS_DEFAULT, blendSeaState, resolveSeaState } from '../src/ocean/seaState';
import type { SeaState } from '../src/ocean/seaState';
import type { WaveBand, WaveComponent } from '../src/ocean/spectrum';
import {
  COMPOSITION,
  WIND_VALIDITY_CEILING,
  coxMunkSlopeVariance,
  effectiveGrowthWind,
  spreadExponentForDegrees,
  windSeaFromWind,
  windSeaSpreadExponent,
} from '../src/ocean/spectrum';
import { UNRESOLVED_MIN_SHARE, WaveField } from '../src/scene/Waves';

/**
 * PERCEPTUAL INVARIANTS.
 *
 * These tests are the compositional policy's contract: the properties that
 * make the sea read as waves rather than as a Gaussian mogul field, asserted
 * numerically over every preset AND swept along a weather trajectory, so any
 * state the future weather system can reach inherits them. If one of these
 * fails, the policy is broken for a whole class of states — do not fix it by
 * touching a preset.
 */

const TWO_PI = Math.PI * 2;

function bandComponents(state: SeaState, band: WaveBand): WaveComponent[] {
  return resolveSeaState(state, SLOTS_DEFAULT)
    .components.filter((c) => c.band === band && c.amplitude > 0);
}

function bandSigmaTheta(state: SeaState, band: WaveBand): number {
  if (band === 'wind') {
    const growth = effectiveGrowthWind(state.generatingWind.speedMps);
    const sea = windSeaFromWind(growth, state.generatingWind.maturity);
    const s = windSeaSpreadExponent(growth, sea.peakPeriod);
    return Math.sqrt(2 / (s + 1));
  }
  const swell = band === 'primary' ? state.primary : state.secondary;
  return Math.sqrt(2 / (spreadExponentForDegrees(swell.spreadDeg) + 1));
}

function headingOf(c: WaveComponent): number {
  return Math.atan2(c.dirX, -c.dirZ);
}

function angleBetween(a: number, b: number): number {
  return Math.abs((((a - b) % TWO_PI) + TWO_PI * 1.5) % TWO_PI - Math.PI);
}

const LIVE_BANDS = (state: SeaState): WaveBand[] => {
  const bands: WaveBand[] = [];
  if (state.generatingWind.speedMps > 0.5) bands.push('wind');
  if (state.primary.enabled && state.primary.significantHeight > 0.01) bands.push('primary');
  if (state.secondary.enabled && state.secondary.significantHeight > 0.01) bands.push('secondary');
  return bands;
};

const PRODUCTION = SEA_STATES.filter(
  (s) => !s.frozen && s.name !== 'FLAT' && s.name !== 'EXTREME_DEBUG',
);

describe('carrier hierarchy', () => {
  it('gives every live system one dominant component', () => {
    // The single strongest anti-mogul property: within each system, the
    // largest free component (the carrier) holds a large multiple of any
    // other's variance, so the sea has a legible dominant train instead of an
    // interference lattice of equals.
    for (const state of PRODUCTION) {
      for (const band of LIVE_BANDS(state)) {
        const free = bandComponents(state, band).filter((c) => c.boundTo < 0);
        if (free.length < 4) continue;
        const sorted = free.map((c) => c.amplitude).sort((a, b) => b - a);
        const share =
          (sorted[0] * sorted[0]) /
          sorted.reduce((s, a) => s + a * a, 0);
        expect(share, `${state.name}/${band} carrier variance share`).toBeGreaterThan(0.25);
        // The 1-vs-2 dominance ratio only applies away from the resolution
        // floor: a system whose peak sits near MIN_WAVELENGTH has its carrier
        // legitimately gated (the noise chain carries that sea), and the
        // longest surviving sideband takes over as the visible train.
        const longest = Math.max(...free.map((c) => c.wavelength));
        if (longest > 12) {
          expect(sorted[0] / sorted[1], `${state.name}/${band} dominance ratio`).toBeGreaterThan(1.35);
        }
      }
    }
  });

  it('keeps each system directionally coherent', () => {
    // Amplitude²-weighted directional resultant. A wide fan at one scale drops
    // this towards zero; a composed train keeps it high, with the stated
    // spread expressed across scale instead.
    for (const state of PRODUCTION) {
      for (const band of LIVE_BANDS(state)) {
        const comps = bandComponents(state, band);
        if (comps.length < 4) continue;
        let wSum = 0;
        let x = 0;
        let y = 0;
        for (const c of comps) {
          const w = c.amplitude * c.amplitude;
          const theta = headingOf(c);
          wSum += w;
          x += w * Math.cos(theta);
          y += w * Math.sin(theta);
        }
        const resultant = Math.hypot(x, y) / wSum;
        expect(resultant, `${state.name}/${band} directional resultant`).toBeGreaterThan(0.82);
      }
    }
  });
});

describe('anti-mogul separation', () => {
  it('never puts significant crossing energy at the dominant scale', () => {
    // The mogul recipe is near-equal components at ONE wavelength with
    // DIFFERENT headings. Assert the offending variance — components within
    // ±30 % of the carrier's wavelength whose heading is off by more than
    // 0.6·σθ — stays a trace amount of each band's total.
    for (const state of PRODUCTION) {
      for (const band of LIVE_BANDS(state)) {
        const free = bandComponents(state, band).filter((c) => c.boundTo < 0);
        if (free.length < 4) continue;
        const sigmaTheta = Math.max(bandSigmaTheta(state, band), 0.02);
        const carrier = free.reduce((a, b) => (a.amplitude >= b.amplitude ? a : b));
        const carrierHeading = headingOf(carrier);
        let total = 0;
        let offending = 0;
        for (const c of free) {
          const w = c.amplitude * c.amplitude;
          total += w;
          // The angle that matters is absolute, not σθ-relative: interference
          // at mutual angles under ~20° reads as one train with finite crest
          // length, not as an egg-carton, however disciplined the system is.
          const nearScale =
            c.wavelength > carrier.wavelength / 1.3 && c.wavelength < carrier.wavelength * 1.3;
          const crossingAngle = Math.max(0.6 * sigmaTheta, 0.3);
          if (nearScale && angleBetween(headingOf(c), carrierHeading) > crossingAngle) {
            offending += w;
          }
        }
        expect(offending / total, `${state.name}/${band} mogul variance`).toBeLessThan(0.08);
      }
    }
  });

  it('keeps aggregate crossing energy at any one scale subordinate', () => {
    // The mogul disease is MANY comparable components crossing at ONE scale.
    // Two small components colliding is texture, not disease, so the invariant
    // is aggregate: for every pair that crosses in direction (> 0.85·σθ apart)
    // while sharing a scale (within ±30 % in wavelength), charge the smaller
    // member's variance to an "interference budget", and hold that budget to a
    // small fraction of the band's total. A wide fan at one scale blows this
    // up immediately; a composed cross-hatch barely registers.
    for (const state of PRODUCTION) {
      for (const band of LIVE_BANDS(state)) {
        const free = bandComponents(state, band).filter((c) => c.boundTo < 0);
        if (free.length < 4) continue;
        const sigmaTheta = Math.max(bandSigmaTheta(state, band), 0.02);
        let total = 0;
        let offending = 0;
        for (const c of free) total += c.amplitude * c.amplitude;
        for (let i = 0; i < free.length; i++) {
          for (let j = i + 1; j < free.length; j++) {
            const ratio =
              Math.max(free[i].wavelength, free[j].wavelength) /
              Math.min(free[i].wavelength, free[j].wavelength);
            if (ratio > 1.3) continue;
            // Absolute angle floor for the same reason as above: sub-20°
            // crossings at one scale are finite-crest texture, not moguls.
            const crossing = Math.max(0.85 * sigmaTheta, 0.35);
            if (angleBetween(headingOf(free[i]), headingOf(free[j])) <= crossing) continue;
            offending += Math.min(
              free[i].amplitude * free[i].amplitude,
              free[j].amplitude * free[j].amplitude,
            );
          }
        }
        expect(offending / total, `${state.name}/${band} interference budget`).toBeLessThan(0.10);
      }
    }
  });
});

describe('bound harmonics', () => {
  it('stays phase-locked through time, morphs and origin shifts', () => {
    // The lock offset (phase − 2·carrier phase) is −π/2 − lean·sharpness:
    // whatever its value, it must be constant in time — that is what "bound"
    // means. Measure it per slot at two times and compare, in the initial
    // state, after a mid-morph re-seed, and after an origin shift.
    const field = new WaveField(findSeaState('GLASSY_LONG_SWELL'));
    const lockOffsets = (): Map<number, number> => {
      const comps = field.describeComponents();
      const out = new Map<number, number>();
      for (const c of comps) {
        if (c.boundTo < 0) continue;
        const carrier = comps.find((k) => k.slot === c.boundTo);
        expect(carrier).toBeDefined();
        out.set(c.slot, (((c.phase - 2 * carrier!.phase) % TWO_PI) + TWO_PI) % TWO_PI);
      }
      expect(out.size).toBeGreaterThan(0);
      return out;
    };
    const expectStable = (a: Map<number, number>, b: Map<number, number>): void => {
      expect(b.size).toBe(a.size);
      for (const [slot, rel] of a) {
        const delta = Math.abs(b.get(slot)! - rel);
        expect(Math.min(delta, TWO_PI - delta)).toBeLessThan(1e-9);
      }
    };

    field.setTime(11.7);
    const t0 = lockOffsets();
    field.advance(37.3);
    expectStable(t0, lockOffsets());

    field.applySeaState(
      blendSeaState(field.state, findSeaState('POST_STORM_SWELL'), 0.3),
      true,
    );
    const m0 = lockOffsets();
    field.advance(5.1);
    expectStable(m0, lockOffsets());

    field.setOrigin(1234.5, -876.2);
    const o0 = lockOffsets();
    field.advance(2.6);
    expectStable(o0, lockOffsets());
  });

  it('advances at twice the carrier frequency, not at free dispersion', () => {
    const field = new WaveField(findSeaState('GLASSY_LONG_SWELL'));
    const before = field.describeComponents();
    field.advance(1.75);
    const after = field.describeComponents();
    for (let i = 0; i < before.length; i++) {
      if (before[i].boundTo < 0) continue;
      const carrier = before.findIndex((c) => c.slot === before[i].boundTo);
      const dPhase = (((after[i].phase - before[i].phase) % TWO_PI) + TWO_PI) % TWO_PI;
      const dCarrier = (((after[carrier].phase - before[carrier].phase) % TWO_PI) + TWO_PI) % TWO_PI;
      const expected = (2 * dCarrier) % TWO_PI;
      const wrapped = Math.min(
        Math.abs(dPhase - expected),
        TWO_PI - Math.abs(dPhase - expected),
      );
      expect(wrapped).toBeLessThan(1e-9);
    }
  });

  it('peaks the crests: the surface is vertically asymmetric (Stokes skew)', () => {
    // A carrier plus its phase-locked harmonic at −π/2 raises crests and
    // flattens troughs — a linear sea is vertically symmetric, a Stokes sea
    // is positively skewed. A single transect or patch snapshot is too small
    // a sample for this (group phasing swings its skew either way — one
    // 600 m patch holds only ~10 carrier wavelengths), so aggregate the
    // moments over a 2-D patch at several well-separated times.
    const field = new WaveField(findSeaState('GLASSY_LONG_SWELL'));
    let max = -Infinity;
    let min = Infinity;
    let sum = 0;
    let sum2 = 0;
    let sum3 = 0;
    let n = 0;
    for (const t of [20, 60, 100, 140, 180]) {
      field.setTime(t);
      for (let x = -300; x <= 300; x += 4) {
        for (let z = -300; z <= 300; z += 4) {
          const h = field.sampleHeight(x, z);
          max = Math.max(max, h);
          min = Math.min(min, h);
          sum += h;
          sum2 += h * h;
          sum3 += h * h * h;
          n++;
        }
      }
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    const skew = (sum3 / n - 3 * mean * variance - mean ** 3) / variance ** 1.5;
    expect(max).toBeGreaterThan(Math.abs(min) * 1.02);
    expect(skew).toBeGreaterThan(0.05);
  });
});

describe('weather trajectory', () => {
  it('moves every slot continuously along a storm-to-calm arc', () => {
    // The narrative arc the weather system will drive: storm → post-storm →
    // glassy calm. Every slot's wavelength, heading and amplitude must move
    // by a bounded amount per 5 % blend step at every point along the arc —
    // this is what "all transition states are legitimate seas" means for the
    // component table. (Phase continuity is WaveField's own test.)
    const arc: Array<[SeaState, SeaState]> = [
      [findSeaState('SOUTHERN_OCEAN_ROUGH'), findSeaState('POST_STORM_SWELL')],
      [findSeaState('POST_STORM_SWELL'), findSeaState('GLASSY_LONG_SWELL')],
      [findSeaState('GLASSY_LONG_SWELL'), findSeaState('DEAD_CALM')],
    ];

    // Worst per-slot amplitude change across the whole arc at blend-step h.
    const worstAmplitudeStep = (from: SeaState, to: SeaState, h: number): number => {
      let previous = resolveSeaState(blendSeaState(from, to, 0), SLOTS_DEFAULT).components;
      let worst = 0;
      for (let t = h; t <= 1.0001; t += h) {
        const next = resolveSeaState(blendSeaState(from, to, t), SLOTS_DEFAULT).components;
        expect(next.length).toBe(previous.length);
        for (let i = 0; i < next.length; i++) {
          worst = Math.max(worst, Math.abs(next[i].amplitude - previous[i].amplitude));
        }
        previous = next;
      }
      return worst;
    };

    for (const [from, to] of arc) {
      // Geometry moves boundedly on a coarse grid...
      let previous = resolveSeaState(blendSeaState(from, to, 0), SLOTS_DEFAULT).components;
      for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const next = resolveSeaState(blendSeaState(from, to, t), SLOTS_DEFAULT).components;
        for (let i = 0; i < next.length; i++) {
          const a = previous[i];
          const b = next[i];
          // λ ∝ Tp², so a violent arc legitimately moves wavelengths ~25 % per
          // coarse step; a slot-identity failure would jump them 2× or more.
          expect(b.wavelength / a.wavelength).toBeGreaterThan(0.7);
          expect(b.wavelength / a.wavelength).toBeLessThan(1.45);
          expect(angleBetween(headingOf(a), headingOf(b))).toBeLessThan(0.2);
        }
        previous = next;
      }
      // ...and amplitude changes are FIRST-ORDER continuous: halving the blend
      // step (roughly) halves the worst per-step change, and the coarse-step
      // worst is centimetres. A genuine pop would stay constant as the step
      // shrinks; the ratio is what a discontinuity cannot fake. (The floor
      // fade is the stress case: the storm→post-storm arc collapses the wind
      // sea's peak from 176 m to 4 m, sweeping every ladder rung through the
      // fade band.)
      // The coarse-step worst is bounded by the arc's own violence (the wind
      // carrier retiring through the floor at the end of a 5 m → 0.2 m
      // collapse peaks around 9 cm per 5 % step — 2 mm per frame in a real
      // 20 s transition); the scaling ratio is the discontinuity detector.
      const coarse = worstAmplitudeStep(from, to, 0.05);
      const fine = worstAmplitudeStep(from, to, 0.0125);
      // 0.12 was this arc's bound while SOUTHERN_OCEAN_ROUGH led with a 15.5 s
      // swell. The storm now leads with a 9 s primary and an 80 % fetch, so the
      // storm→post-storm leg has a longer way to travel and the coarse worst
      // rose to 0.133 m per 5 % step — about 3 mm per frame through a 20 s
      // transition. It is a magnitude bound on how violent the arc is, not a
      // discontinuity detector; the ratio below is the detector, it is untouched
      // and it still passes.
      expect(coarse).toBeLessThan(0.15);
      expect(fine).toBeLessThan(Math.max(0.35 * coarse, 1e-6));
    }
  });

  it('holds the perceptual invariants at every point of the arc', () => {
    // Spot-check dominance and coherence mid-blend, where neither endpoint's
    // hand-set numbers apply and only the policy is holding the line.
    const from = findSeaState('SOUTHERN_OCEAN_ROUGH');
    const to = findSeaState('GLASSY_LONG_SWELL');
    for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
      const mid = blendSeaState(from, to, t);
      for (const band of LIVE_BANDS(mid)) {
        const free = bandComponents(mid, band).filter((c) => c.boundTo < 0);
        if (free.length < 4) continue;
        const sorted = free.map((c) => c.amplitude).sort((x, y) => y - x);
        const share = (sorted[0] * sorted[0]) / sorted.reduce((s, a) => s + a * a, 0);
        expect(share, `t=${t} ${band}`).toBeGreaterThan(0.25);
      }
    }
  });
});

describe('wind validity ceiling', () => {
  it('saturates wave growth smoothly and monotonically', () => {
    expect(effectiveGrowthWind(10)).toBe(10);
    expect(effectiveGrowthWind(24)).toBe(24);
    let previous = 0;
    for (let u = 0; u <= 80; u += 0.5) {
      const eff = effectiveGrowthWind(u);
      expect(eff).toBeLessThan(WIND_VALIDITY_CEILING);
      expect(eff).toBeGreaterThanOrEqual(previous);
      previous = eff;
    }
    // C¹ at the knee: the slope just above 24 is within a few percent of 1.
    const slope = (effectiveGrowthWind(24.2) - effectiveGrowthWind(24.0)) / 0.2;
    expect(slope).toBeGreaterThan(0.95);
  });

  it('stops growing the sea while the storm keeps getting angrier', () => {
    const at = (u: number): number => {
      const state = {
        ...findSeaState('SOUTHERN_OCEAN_ROUGH'),
        generatingWind: { ...findSeaState('SOUTHERN_OCEAN_ROUGH').generatingWind, speedMps: u },
      };
      return resolveSeaState(state, SLOTS_DEFAULT).significantHeight;
    };
    // Hs at 60 m/s is within a couple of percent of Hs at 40 — growth
    // saturated (the raw-wind ratio would be 2.25×). The raw-wind channels
    // (whitecap-coverage-driven foam, spray) still see the real speed; that
    // contract lives in main.ts passing raw wind onwards.
    expect(at(60) / at(40)).toBeLessThan(1.05);
    expect(at(34)).toBeGreaterThan(at(20));
  });
});

describe('derived detail amplitude', () => {
  /**
   * This used to pin the pre-round hand-set amplitude (0.08-0.13). It now pins
   * the thing that replaced that calibration: the drawn detail should consume
   * essentially the WHOLE unresolved slope band rather than the 45 % it was
   * taking, because the specular lobe holding the remainder cannot make a
   * highlight at a midday Fresnel of 2 % and a drawn facet can.
   *
   * Expressed as the relationship rather than the number, so it survives a
   * re-tune of κ and fails if the intent is lost.
   */
  it('draws essentially all of the unresolved slope band', () => {
    const field = new WaveField(findSeaState('CURRENT_MODERATE'));
    // Slope variance of the five-octave desktop stack at unit octave gains:
    // rms per octave is amp*freq, amplitude falling 0.55 and frequency rising
    // sqrt(5) per level. Mirrors the sum in Ocean.updateUniforms.
    const detailScale = findSeaState('CURRENT_MODERATE').roughness.detailScale;
    let drawn = 0;
    let amp = field.detailAmplitude;
    let freq = 1 / detailScale;
    for (let o = 0; o < 5; o++) {
      drawn += 0.5 * (amp * freq) ** 2;
      amp *= 0.55;
      freq *= Math.sqrt(5);
    }
    const share = drawn / field.unresolvedSlopeVariance;
    expect(share).toBeGreaterThan(0.8);
    // And never invents roughness the sea does not have: drawing meaningfully
    // more than the band would push total slope past the Cox-Munk figure.
    expect(share).toBeLessThan(1.35);
  });

  it('tracks the wind ordering across presets', () => {
    const at = (name: string): number => new WaveField(findSeaState(name)).detailAmplitude;
    expect(at('DEAD_CALM')).toBeLessThan(at('LIGHT_BREEZE_OVER_SWELL'));
    expect(at('LIGHT_BREEZE_OVER_SWELL')).toBeLessThan(at('WIND_CHOP'));
    expect(at('WIND_CHOP')).toBeLessThan(at('SOUTHERN_OCEAN_ROUGH'));
  });

  /**
   * A big swell under a light wind used to empty the roughness budget entirely:
   * the resolved mean square slope exceeded the Cox–Munk total, the subtraction
   * clamped at zero, and the fragment stage lost both its ripple geometry and
   * its statistical roughness at once. The sea then rendered as rounded glass —
   * reachable from the ocean lab by dragging one slider.
   */
  it('keeps ripple and roughness alive under a swell far past the wind that could raise it', () => {
    const base = findSeaState('CURRENT_MODERATE');
    const calm = new WaveField(base);
    const coxMunk = coxMunkSlopeVariance(base.generatingWind.speedMps);

    for (const significantHeight of [4, 5.6, 9, 14]) {
      const monstrous: SeaState = {
        ...base,
        primary: { ...base.primary, significantHeight },
      };
      const field = new WaveField(monstrous);
      // The resolved slope really does exceed the whole Cox-Munk budget here —
      // this is the condition that used to collapse, not a hypothetical.
      expect(field.meanSquareSlope).toBeGreaterThan(coxMunk);
      expect(field.unresolvedSlopeVariance).toBeGreaterThanOrEqual(
        coxMunk * UNRESOLVED_MIN_SHARE - 1e-12,
      );
      expect(field.detailAmplitude).toBeGreaterThan(0.05);
    }

    // And the floor is genuinely inactive at every shipping preset, so nothing
    // that already exists moves.
    for (const preset of SEA_STATES) {
      const field = new WaveField(preset);
      // Wave growth sees the wind through the same validity ceiling the
      // roughness budget does, so the reference has to as well.
      const budget = coxMunkSlopeVariance(effectiveGrowthWind(preset.generatingWind.speedMps));
      if (field.meanSquareSlope < budget * (1 - UNRESOLVED_MIN_SHARE)) {
        expect(field.unresolvedSlopeVariance).toBeCloseTo(
          budget - field.meanSquareSlope,
          10,
        );
      }
    }
    expect(calm.detailAmplitude).toBeGreaterThan(0.08);
  });
});

describe('policy constants', () => {
  it('keeps the swell fan ratios non-harmonic and below the carrier', () => {
    for (const fan of COMPOSITION.swellFan) {
      expect(fan.ratio).toBeLessThan(1);
      // Floor matches the reference ocean's shortest visible rider (10.4 m on
      // a 62 m carrier = 0.168); anything shorter belongs to the wind ladder
      // and the detail band.
      expect(fan.ratio).toBeGreaterThan(0.15);
      for (const other of COMPOSITION.swellFan) {
        if (other === fan) continue;
        const ratio = Math.max(fan.ratio, other.ratio) / Math.min(fan.ratio, other.ratio);
        expect(ratio).toBeGreaterThan(1.15);
      }
    }
  });
});
