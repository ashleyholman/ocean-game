import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  isFibonacciAmbientEnabled,
  setFibonacciAmbientEnabled,
  setSunDomeMeanEnabled,
} from '../src/scene/colourPipeline';
import { TimeOfDay } from '../src/scene/TimeOfDay';
import { fibonacciHemisphere } from '../src/scene/skyHarmonics';
import { AB_SWITCHES } from '../src/debug/abSwitches';

/**
 * The seven-direction ambient set, replaced by a spherical Fibonacci one.
 *
 * The class of bug this ends: `ambientRadiance` was estimated from seven fixed
 * directions on three rings, so every bright thing in the sky spiked the whole
 * scene's fill as it crossed one of them. Two rounds patched members of the
 * class — the moon's aureole outright, the sun's behind `?sunDomeMean=1`. This
 * removes the rings.
 *
 * Two disciplines are enforced here and they pull against each other:
 *
 *   1. OFF must be byte-identical to the world before the switch existed. The
 *      probe reduction MOVED above the ambient block to make the on arm
 *      possible, and "that reordering is numerically inert" is a claim that has
 *      to be gated rather than asserted in a comment.
 *   2. ON must remove a SPIKE and not a LEVEL. A fix that merely darkened the
 *      day would sail through a smoothness test and be wrong. So the level is
 *      pinned separately, and the on arm is checked against a converged
 *      8192-direction integral of the quantity the fill is trying to be.
 */

const DEG = Math.PI / 180;

function skyAt(
  sunElevationDeg: number,
  sunAzimuthDeg = 0,
  cloudOpacity = 0,
  cloudDrift = 0,
): TimeOfDay {
  const time = new TimeOfDay();
  if (cloudOpacity > 0) {
    time.setCloudState(0.5, cloudOpacity, {
      offsetX: cloudDrift,
      offsetZ: 0,
      evolve: 0,
    });
  }
  const el = sunElevationDeg * DEG;
  const az = sunAzimuthDeg * DEG;
  const moonEl = -30 * DEG;
  time.refreshFromAstronomy(
    1e6,
    new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
    ),
    0,
    el,
    new THREE.Vector3(-Math.cos(moonEl), Math.sin(moonEl), 0),
    Math.PI,
    moonEl,
    0.5,
  );
  return time;
}

const vlum = (v: THREE.Vector3): number =>
  0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;

const fill = (
  elevation: number,
  azimuth = 0,
  cloud = 0,
  drift = 0,
): number => vlum(skyAt(elevation, azimuth, cloud, drift).ambientRadiance);

/**
 * The quantity the fill is trying to be: the cosine-weighted mean of the sky
 * over the upper hemisphere, integrated on enough directions that the answer
 * has stopped moving. 8192 rather than 256 so this is a reference and not
 * another instance of the thing under test.
 */
const REFERENCE_DIRECTIONS = fibonacciHemisphere(8192);

function convergedMean(time: TimeOfDay): number {
  const d = new THREE.Vector3();
  const out: [number, number, number] = [0, 0, 0];
  let acc = 0;
  let weight = 0;
  for (const s of REFERENCE_DIRECTIONS) {
    d.set(s[0], s[1], s[2]);
    time.skyWithClouds(d, out, true);
    acc += (0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]) * s[1];
    weight += s[1];
  }
  return acc / weight;
}

/** The fill divided by the scale policy, so it compares with a raw sky mean. */
const SKY_FILL_SCALE = 0.8;

afterEach(() => {
  setFibonacciAmbientEnabled(false);
  setSunDomeMeanEnabled(false);
});

describe('the switch off', () => {
  it('is off by default', () => {
    expect(isFibonacciAmbientEnabled()).toBe(false);
  });

  it('is byte-identical to the daylight that shipped', () => {
    // The same five doubles the sun-dome round pinned, unchanged. They are the
    // strongest available statement that moving the probe reduction above the
    // ambient block did nothing: if the reorder had perturbed so much as a
    // rounding step, these would not still be exact.
    const pinned: ReadonlyArray<readonly [number, number]> = [
      [70, 0.3297688979278253],
      [45, 0.36067155638192644],
      [25, 1.296047887755755],
      [10, 0.2030400402749703],
      [0, 0.06426867865234658],
    ];
    for (const [elevation, ambient] of pinned) {
      expect(fill(elevation), `sun ${elevation} deg`).toBe(ambient);
    }
  });

  it('leaves the exposure meter, the probe and the harmonics alone too', () => {
    // The reorder touched the block that produces all three. Byte-identity has
    // to hold for every output of the moved code, not only for the one the
    // switch is about.
    // Read off the code as it stood BEFORE the reorder, by stashing the change
    // and re-running. Not read off the code afterwards and declared correct,
    // which is the way this kind of test usually lies.
    const pinned: ReadonlyArray<readonly [number, number, number, number]> = [
      [70, 0.797828335049827, 0.3297688979278253, 0.4285097384493529],
      [26, 0.526313253461535, 1.3570006075605607, 0.3578982120505511],
      [-6, 3.493059575677667, 0.0046857559156431045, 0.004849963209021627],
    ];
    for (const [elevation, exposure, ambient, hemispheric] of pinned) {
      const time = skyAt(elevation);
      expect(time.exposure, `exposure at ${elevation}`).toBe(exposure);
      expect(vlum(time.ambientRadiance), `ambient at ${elevation}`).toBe(ambient);
      expect(
        vlum(time.hemisphericRadiance),
        `hemispheric at ${elevation}`,
      ).toBe(hemispheric);
    }
  });

  it('keeps the adaptation meter and the harmonic coefficients reproducible', () => {
    for (const elevation of [70, 45, 26, 25, 24, 10, 0, -6]) {
      const before = skyAt(elevation);
      const snapshot = {
        adaptation: before.adaptationLuminance,
        sh: Array.from(before.skySh),
      };
      const again = skyAt(elevation);
      expect(again.adaptationLuminance).toBe(snapshot.adaptation);
      expect(Array.from(again.skySh)).toEqual(snapshot.sh);
    }
  });
});

describe('the switch on, against a converged integral', () => {
  it('lands within 2 percent of the truth where the ring set is out by 4.65x', () => {
    // The headline. At 26 degrees a sample direction sits almost on the sun.
    const time = skyAt(26);
    const truth = convergedMean(time);

    setFibonacciAmbientEnabled(false);
    const off = fill(26) / SKY_FILL_SCALE;
    setFibonacciAmbientEnabled(true);
    const on = fill(26) / SKY_FILL_SCALE;

    expect(off / truth).toBeGreaterThan(4);
    expect(Math.abs(on / truth - 1)).toBeLessThan(0.02);
  });

  it('is within 2 percent all day, where the ring set is out by up to 15 percent even between the rings', () => {
    // Between the rings is the part that matters for the level question: the
    // seven-sample set is not merely spiky, it is biased HIGH everywhere,
    // because the aureole's tail keeps landing in it.
    let worstOn = 1;
    let worstOffBetween = 1;
    for (const elevation of [15, 40, 45, 60, 70, 80]) {
      const truth = convergedMean(skyAt(elevation));
      setFibonacciAmbientEnabled(true);
      const on = fill(elevation) / SKY_FILL_SCALE / truth;
      setFibonacciAmbientEnabled(false);
      const off = fill(elevation) / SKY_FILL_SCALE / truth;
      worstOn = Math.max(worstOn, on, 1 / on);
      worstOffBetween = Math.max(worstOffBetween, off, 1 / off);
    }
    expect(worstOn).toBeLessThan(1.02);
    expect(worstOffBetween).toBeGreaterThan(1.1);
  });
});

describe('the switch on, as a spike remover', () => {
  it('removes the 26 and 53 degree steps', () => {
    const spikeOf = (elevation: number): number => {
      const near = fill(elevation);
      const away = Math.max(fill(elevation + 14), fill(elevation - 11));
      return near / away;
    };
    setFibonacciAmbientEnabled(false);
    expect(spikeOf(26), 'the 26 degree ring, off').toBeGreaterThan(2);
    expect(spikeOf(53), 'the 53 degree ring, off').toBeGreaterThan(2);
    setFibonacciAmbientEnabled(true);
    expect(spikeOf(26), 'the 26 degree ring, on').toBeLessThan(1.05);
    expect(spikeOf(53), 'the 53 degree ring, on').toBeLessThan(1.05);
  });

  it('makes the fill smooth in sun elevation', () => {
    const worstStep = (): number => {
      let previous = 0;
      let worst = 0;
      for (let elevation = 15; elevation <= 85; elevation += 1) {
        const value = fill(elevation);
        if (previous > 0) {
          worst = Math.max(worst, value / previous, previous / value);
        }
        previous = value;
      }
      return worst;
    };
    setFibonacciAmbientEnabled(true);
    // 1.04, not 1.00, and the gap is the honest residual rather than slack in
    // the gate. A 256-direction set spaces its samples about 4.9 degrees
    // apart; the aureole's half-width is 2.7. No affordable sampling of the
    // sphere resolves that lobe, so a few percent of it survives as ripple —
    // which is exactly why `?sunDomeMean=1` stays available.
    expect(worstStep()).toBeLessThan(1.04);
    setFibonacciAmbientEnabled(false);
    expect(worstStep()).toBeGreaterThan(1.3);
  });

  it('makes the fill smooth in sun AZIMUTH, which the rings never were', () => {
    // The rings are rings: at a ring elevation the fill also swings as the sun
    // turns, because the four samples on the 26 degree ring sit at four
    // azimuths. That half of the fault is invisible to an elevation sweep.
    const span = (): number => {
      let low = Infinity;
      let high = 0;
      for (let azimuth = 0; azimuth <= 90; azimuth += 3) {
        const value = fill(26, azimuth);
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      return high / low;
    };
    setFibonacciAmbientEnabled(false);
    expect(span()).toBeGreaterThan(4);
    setFibonacciAmbientEnabled(true);
    expect(span()).toBeLessThan(1.1);
  });

  it('steadies the fill under a drifting cloud deck', () => {
    // The larger everyday fault, and the one neither aureole fix touched: a
    // cumulus field sampled at seven points is a lottery drawn afresh every
    // time a tuft crosses a sample direction. This happens on every cloudy
    // frame, not only when the sun crosses a ring.
    //
    // SYNTHETIC FIELD, and the label matters. This is a bare TimeOfDay with one
    // deck at cover 0.5, not the shipping two-deck cloud clock. It is a fine
    // deterministic gate and a poor description of the real sky: measured live
    // in the running app the same comparison is much starker — the seven-sample
    // fill swings up to 2.82x where the sky itself changes by 1.13x, and runs
    // 13% dark under a thick deck at a high sun against 13% bright under the
    // same deck at 39 degrees. See docs/graphics/AMBIENT_SET_ROUND.md, which
    // carries the live table; do not quote the numbers below as the sky's.
    const swing = (): number => {
      let low = Infinity;
      let high = 0;
      for (let drift = 0; drift < 2000; drift += 100) {
        const value = fill(40, 0, 1, drift);
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      return high / low;
    };
    setFibonacciAmbientEnabled(false);
    const off = swing();
    setFibonacciAmbientEnabled(true);
    const on = swing();
    expect(off).toBeGreaterThan(1.7);
    expect(on).toBeLessThan(1.2);
  });
});

describe('a spike, not a level', () => {
  it('moves the fill by less than 20 percent away from the rings', () => {
    // The discipline the sun-dome round set, kept. A fix that merely darkened
    // the day would pass every smoothness test above and be wrong, so the two
    // arms are required to agree closely where the point estimate was never
    // far off.
    for (const elevation of [15, 40, 45, 60, 70]) {
      setFibonacciAmbientEnabled(false);
      const off = fill(elevation);
      setFibonacciAmbientEnabled(true);
      const on = fill(elevation);
      expect(on / off, `sun ${elevation} deg`).toBeGreaterThan(0.8);
      expect(on / off, `sun ${elevation} deg`).toBeLessThan(1.2);
    }
  });

  it('pins the level move itself, so a later change cannot smuggle one in', () => {
    // Measured, not chosen. These are the ratios Ash is being asked to accept
    // when he flips the switch, and they are here so that a future edit which
    // quietly rescales the fill fails rather than passes.
    const cases: ReadonlyArray<readonly [string, () => number, number]> = [
      ['clear day, sun 45', () => fill(45), 0.914],
      ['clear day, sun 70', () => fill(70), 1.04],
      ['moonless night, sun -20', () => fill(-20), 0.959],
    ];
    for (const [label, measure, expected] of cases) {
      setFibonacciAmbientEnabled(false);
      const off = measure();
      setFibonacciAmbientEnabled(true);
      const on = measure();
      expect(on / off, label).toBeCloseTo(expected, 2);
    }
  });

  it('does not disturb the night thread more than four percent', () => {
    // Parts A to C derived the scotopic lift against a night sea whose
    // radiance comes largely from this fill. Four percent is 0.06 stops, but
    // it is not zero and the number belongs in a test rather than in a memory.
    setFibonacciAmbientEnabled(false);
    const off = fill(-34);
    setFibonacciAmbientEnabled(true);
    const on = fill(-34);
    expect(on / off).toBeGreaterThan(0.95);
    expect(on / off).toBeLessThan(1.0);
  });
});

describe('the two fixes together', () => {
  it('leaves sunDomeMean with almost nothing left to do', () => {
    // With the rings gone, the lobe normalisation moves the fill by about a
    // percent instead of by a factor of four. That is the evidence for
    // retiring the switch — recorded, not acted on: it is queued for Ash's
    // A/B and deleting it would take the comparison away before he makes it.
    setFibonacciAmbientEnabled(true);
    for (const elevation of [26, 45, 70]) {
      setSunDomeMeanEnabled(false);
      const without = fill(elevation);
      setSunDomeMeanEnabled(true);
      const withIt = fill(elevation);
      expect(Math.abs(withIt / without - 1), `sun ${elevation}`).toBeLessThan(0.03);
    }
  });

  it('is no better with the normalisation than without it', () => {
    // The counter-intuitive half, and the reason the recommendation is to
    // retire the switch rather than to promote it. `1/(2pi)` is the exact mean
    // of a phase function over a UNIFORM hemisphere; the fill is now a
    // COSINE-weighted mean, for which the exact substitution would be
    // max(l.y, 0)/pi. Stacking the normalisation on the Fibonacci set is
    // therefore a small step away from the honest integral, not toward it.
    setFibonacciAmbientEnabled(true);
    for (const elevation of [45, 70]) {
      // The reference has to integrate the REAL lobe, so the flag must be off
      // while it is taken — including on the second pass round this loop,
      // where the previous iteration left it on. A reference computed through
      // the approximation under test measures nothing.
      setSunDomeMeanEnabled(false);
      const truth = convergedMean(skyAt(elevation));
      const raw = Math.abs(fill(elevation) / SKY_FILL_SCALE / truth - 1);
      setSunDomeMeanEnabled(true);
      const normalised = Math.abs(fill(elevation) / SKY_FILL_SCALE / truth - 1);
      expect(raw, `sun ${elevation}`).toBeLessThan(normalised);
    }
  });
});

describe('the paired capture sheet', () => {
  it('is registered, and readable there', () => {
    const entry = AB_SWITCHES.find((s) => s.name === 'fibonacciAmbient');
    expect(entry, 'fibonacciAmbient must be in the A/B registry').toBeDefined();
    expect(entry?.scope).toBe('live');
    expect(entry?.defaultArm).toBe('0');
    // A switch a sheet can set but not read back is one whose captions can lie
    // about what was photographed.
    const sim = {} as never;
    entry?.apply?.(sim, '1');
    expect(entry?.read(sim)).toBe('1');
    expect(isFibonacciAmbientEnabled()).toBe(true);
    entry?.apply?.(sim, '0');
    expect(entry?.read(sim)).toBe('0');
  });
});
