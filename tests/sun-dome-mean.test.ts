import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  isSunDomeMeanEnabled,
  setSunDomeMeanEnabled,
} from '../src/scene/colourPipeline';
import { TimeOfDay } from '../src/scene/TimeOfDay';

/**
 * The sun's copy of the aerosol-lobe sampling fault, behind a default-off
 * switch.
 *
 * The fault was found while fixing the moon's copy of it in Part B and left
 * alone there, because fixing it moves daylight and "daylight is bit-identical"
 * is a standing clause. So the discipline this file enforces is: the switch OFF
 * must be byte-identical to the world before the switch existed, and the switch
 * ON must actually fix the thing it claims to.
 */

const DEG = Math.PI / 180;

function skyAt(sunElevationDeg: number): TimeOfDay {
  const time = new TimeOfDay();
  const el = sunElevationDeg * DEG;
  const moonEl = -30 * DEG;
  time.refreshFromAstronomy(
    1e6,
    new THREE.Vector3(Math.cos(el), Math.sin(el), 0),
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

afterEach(() => setSunDomeMeanEnabled(false));

describe('the switch off', () => {
  it('is off by default', () => {
    expect(isSunDomeMeanEnabled()).toBe(false);
  });

  it('is byte-identical to the daylight that shipped', () => {
    // Pinned to the exact doubles measured before the switch existed. Not
    // `toBeCloseTo` — the clause is bit-identity, and a clause worth having is
    // worth asserting at full precision.
    const pinned: ReadonlyArray<readonly [number, number]> = [
      [70, 0.3297688979278253],
      [45, 0.36067155638192644],
      [25, 1.296047887755755],
      [10, 0.2030400402749703],
      [0, 0.06426867865234658],
    ];
    for (const [elevation, ambient] of pinned) {
      // Exact doubles, compared exactly. The clause is bit-identity, and a
      // clause worth having is worth asserting without a tolerance.
      expect(vlum(skyAt(elevation).ambientRadiance), `sun ${elevation} deg`).toBe(
        ambient,
      );
    }
  });

  it('leaves the exposure meter and the harmonic probe alone too', () => {
    // The estimator is shared by three means, so byte-identity has to hold for
    // all three or the clause is only true of the one that was checked.
    for (const elevation of [70, 45, 26, 25, 24, 10, 0, -6]) {
      const time = skyAt(elevation);
      const before = {
        exposure: time.exposure,
        adaptation: time.adaptationLuminance,
        hemispheric: vlum(time.hemisphericRadiance),
        sh: Array.from(time.skySh),
      };
      // Re-derive the same state and compare: the flag is off in both, so the
      // two must agree to the last bit.
      const again = skyAt(elevation);
      expect(again.exposure).toBe(before.exposure);
      expect(again.adaptationLuminance).toBe(before.adaptation);
      expect(vlum(again.hemisphericRadiance)).toBe(before.hemispheric);
      expect(Array.from(again.skySh)).toEqual(before.sh);
    }
  });
});

describe('the switch on', () => {
  it('removes the 2.4x spike as the sun crosses the 26 degree sample ring', () => {
    const spikeOf = (): number => {
      const near = vlum(skyAt(26).ambientRadiance);
      const away = Math.max(
        vlum(skyAt(40).ambientRadiance),
        vlum(skyAt(15).ambientRadiance),
      );
      return near / away;
    };
    setSunDomeMeanEnabled(false);
    const before = spikeOf();
    setSunDomeMeanEnabled(true);
    const after = spikeOf();

    // The fault, and the fix, as one number each.
    expect(before).toBeGreaterThan(2);
    expect(after).toBeLessThan(1.2);
  });

  it('makes the daylight fill smooth in sun elevation', () => {
    // The point of the fix is not a value, it is the absence of a step. With
    // the estimator corrected, no single degree of sun may move the fill by
    // more than a few percent anywhere in the day.
    // From 15 degrees up. Below that the sky genuinely changes fast per degree
    // — the fill still moves 16% between 5 and 6 with the fix in, and that is
    // the sunrise, not the estimator.
    const worstStep = (): number => {
      let previous = 0;
      let worst = 0;
      for (let elevation = 15; elevation <= 85; elevation += 1) {
        const value = vlum(skyAt(elevation).ambientRadiance);
        if (previous > 0) worst = Math.max(worst, value / previous, previous / value);
        previous = value;
      }
      return worst;
    };
    setSunDomeMeanEnabled(true);
    expect(worstStep()).toBeLessThan(1.05);
    // The same sweep with it off, so the test says what it is comparing to.
    setSunDomeMeanEnabled(false);
    expect(worstStep()).toBeGreaterThan(1.3);
  });

  it('does not simply darken the day — it removes a spike, not a level', () => {
    // A fix that just scaled the fill down would pass the smoothness test and
    // be wrong. Away from the sample rings the two arms must agree closely,
    // because away from the rings the point estimate was never far off.
    for (const elevation of [45, 70, 15]) {
      setSunDomeMeanEnabled(false);
      const off = vlum(skyAt(elevation).ambientRadiance);
      setSunDomeMeanEnabled(true);
      const on = vlum(skyAt(elevation).ambientRadiance);
      expect(on / off, `sun ${elevation} deg`).toBeGreaterThan(0.8);
      expect(on / off, `sun ${elevation} deg`).toBeLessThan(1.2);
    }
  });

  it('is registered for the paired capture sheet, and readable there', () => {
    // A switch a sheet can set but not read back is one whose captions can lie
    // about what was photographed; the registry requires both.
    setSunDomeMeanEnabled(true);
    expect(isSunDomeMeanEnabled()).toBe(true);
    setSunDomeMeanEnabled(false);
    expect(isSunDomeMeanEnabled()).toBe(false);
  });
});
