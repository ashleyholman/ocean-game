import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { LAMP_COLOR } from '../src/scene/Lamp';
import { CLEAR_DEEP_OCEAN } from '../src/scene/oceanOptics';
import {
  MOON_IRRADIANCE_SCALE,
  MOON_SKY_POWER,
  SUN_IRRADIANCE_SCALE,
  SUN_SKY_POWER,
  TimeOfDay,
} from '../src/scene/TimeOfDay';
import {
  DEFAULT_SCOTOPIC_STRENGTH,
  applyScotopic,
  rodDominance,
} from '../src/scene/scotopic';
import { applyToneCurve } from '../src/scene/toneMapping';

/**
 * Part B of `docs/graphics/NIGHT_VISIBILITY_SPEC.md` — the moon.
 *
 * The headline clause is numeric and therefore gateable: "a full moon changes
 * the night ambient by at least an order of magnitude, measured on
 * `ambientRadiance`, not judged by eye". Everything else here exists because
 * satisfying that clause naively broke something else, and the tests are the
 * record of what.
 */

const DEG = Math.PI / 180;

function skyAt(
  sunElevationDeg: number,
  moonElevationDeg: number,
  moonFraction: number,
): TimeOfDay {
  const time = new TimeOfDay();
  const el = sunElevationDeg * DEG;
  const moonEl = moonElevationDeg * DEG;
  time.refreshFromAstronomy(
    1e6,
    new THREE.Vector3(Math.cos(el), Math.sin(el), 0),
    0,
    el,
    new THREE.Vector3(-Math.cos(moonEl), Math.sin(moonEl), 0),
    Math.PI,
    moonEl,
    moonFraction,
  );
  return time;
}

const vlum = (v: THREE.Vector3): number =>
  0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
const lum = (c: readonly [number, number, number]): number =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** No moon anywhere near the sky: the reference every ratio is taken against. */
const moonless = (): TimeOfDay => skyAt(-25, -30, 0.5);

/**
 * The luminance of an ambient-lit surface as it reaches the display: through
 * the exposure meter and the tone curve. Ash rejected Part A's observer pass,
 * so its shipped strength is explicitly multiplied in here as zero. This is the
 * quantity the player now sees and therefore the path Part B must calibrate.
 */
function shippingSeaLuminance(time: TimeOfDay): number {
  const exposure = time.exposure * time.daylightLift;
  const rod =
    rodDominance(time.retinalLuminance) * DEFAULT_SCOTOPIC_STRENGTH;
  const display = applyToneCurve(
    [time.ambientRadiance.x, time.ambientRadiance.y, time.ambientRadiance.z],
    exposure,
  );
  return lum(applyScotopic(display, display, rod));
}

describe('the moon, on ambientRadiance', () => {
  it('changes the night ambient by at least an order of magnitude', () => {
    // THE ACCEPTANCE CLAUSE. Measured, not judged.
    const dark = vlum(moonless().ambientRadiance);
    const full = vlum(skyAt(-25, 40, 1).ambientRadiance);
    const ratio = full / dark;
    expect(ratio).toBeGreaterThanOrEqual(10);
    // And recorded, so a regression reads as a number rather than a pass/fail.
    // 12.3x at the time of writing: chosen above the gate so the gate is a
    // margin rather than a coincidence, and left well under reality's 100-300x
    // because the exposure meter reads ambient and gives back most of what is
    // added beyond this.
    expect(ratio).toBeLessThan(20);
  });

  it('moves the whole-dome mean with it, not just the flat average', () => {
    const dark = moonless();
    const full = skyAt(-25, 40, 1);
    expect(
      vlum(full.hemisphericRadiance) / vlum(dark.hemisphericRadiance),
    ).toBeGreaterThanOrEqual(10);
  });

  it('leaves a moonless night exactly where it was', () => {
    // "A moonless night must not get brighter as a side effect." The moon is
    // gated to exactly zero power when it is down, so this is exact rather than
    // approximate — and the pinned values are Part A's, unchanged.
    const dark = moonless();
    expect(dark.moonPower).toBe(0);
    expect(dark.moonLightIntensity).toBe(0);
    expect(vlum(dark.ambientRadiance)).toBeCloseTo(1.4712e-3, 7);
    expect(dark.exposure).toBeCloseTo(4.991, 3);
    expect(dark.limitingMagnitude).toBeCloseTo(6.2, 2);
  });

  it('is inert in daylight, so Part A is untouched', () => {
    // Part B changes linear radiance at night. It must change nothing by day,
    // or Part A's bit-identical daylight stops being true for a second reason.
    for (const elevation of [90, 45, 10, 0, -1]) {
      const withMoon = skyAt(elevation, 60, 1);
      const withoutMoon = skyAt(elevation, -60, 1);
      expect(withMoon.moonPower, `sun ${elevation}`).toBe(0);
      expect(
        vlum(withMoon.ambientRadiance),
        `sun ${elevation}`,
      ).toBeCloseTo(vlum(withoutMoon.ambientRadiance), 12);
      expect(rodDominance(withMoon.retinalLuminance), `sun ${elevation}`).toBe(0);
    }
  });
});

describe('the moon, scaling', () => {
  it('rises smoothly with phase, with no step anywhere', () => {
    let previous = -1;
    let largestJump = 0;
    for (let f = 0; f <= 1.0001; f += 0.01) {
      const value = vlum(skyAt(-25, 40, Math.min(f, 1)).ambientRadiance);
      if (previous >= 0) {
        expect(value, `fraction ${f.toFixed(2)}`).toBeGreaterThanOrEqual(
          previous - 1e-12,
        );
        largestJump = Math.max(largestJump, value - previous);
      }
      previous = value;
    }
    // No single one-percent step of phase may carry more than a tenth of the
    // whole range: that is what "scales rather than jumps" means as a number.
    const range =
      vlum(skyAt(-25, 40, 1).ambientRadiance) -
      vlum(skyAt(-25, 40, 0).ambientRadiance);
    expect(largestJump).toBeLessThan(range * 0.1);
    // New moon puts back exactly the moonless sky — no halo without a source.
    expect(vlum(skyAt(-25, 40, 0).ambientRadiance)).toBeCloseTo(
      vlum(moonless().ambientRadiance),
      12,
    );
  });

  it('rises smoothly with elevation, and a moon on the horizon lights little', () => {
    let previous = -1;
    for (let elevation = -6; elevation <= 80; elevation += 1) {
      const value = vlum(skyAt(-25, elevation, 1).ambientRadiance);
      if (previous >= 0) {
        expect(value, `moon ${elevation} deg`).toBeGreaterThanOrEqual(
          previous - 1e-12,
        );
      }
      previous = value;
    }
    const low = vlum(skyAt(-25, 2, 1).ambientRadiance);
    const high = vlum(skyAt(-25, 60, 1).ambientRadiance);
    expect(low).toBeLessThan(high * 0.5);
  });
});

describe('the moon, on the shipped direct-display path', () => {
  it('never makes the night darker than no moon at all', () => {
    // THE REGRESSION THIS ROUND EXISTS TO PREVENT.
    //
    // Part B originally found this fault inside Part A's observer model. With
    // that model rejected, re-run the invariant against the actual shipping
    // tone-mapped display path: exposure closure still must not overtake the
    // moon's added radiance at any phase or elevation.
    const dark = shippingSeaLuminance(moonless());
    for (let fraction = 0; fraction <= 1.0001; fraction += 0.05) {
      for (const elevation of [5, 20, 40, 70]) {
        const seen = shippingSeaLuminance(
          skyAt(-25, elevation, Math.min(fraction, 1)),
        );
        expect(
          seen,
          `fraction ${fraction.toFixed(2)} at ${elevation} deg`,
        ).toBeGreaterThanOrEqual(dark - 1e-9);
      }
    }
  });

  it('is unmistakably different from a moonless night at a glance', () => {
    // The other half of the acceptance: not merely brighter in the buffer, but
    // brighter where it counts, after the meter has had its say and without the
    // rejected lift. Re-audited at 17 -> 52 sRGB codes: a larger separation than
    // the old observer path's 40 -> 59, so MOON_SKY_POWER does not need retuning.
    const code = (y: number): number =>
      Math.round(255 * (1.055 * Math.pow(Math.max(y, 0), 1 / 2.4) - 0.055));
    const dark = code(shippingSeaLuminance(moonless()));
    const full = code(shippingSeaLuminance(skyAt(-25, 40, 1)));
    expect(dark).toBeGreaterThanOrEqual(15);
    expect(dark).toBeLessThanOrEqual(20);
    expect(full).toBeGreaterThanOrEqual(48);
    expect(full).toBeLessThanOrEqual(56);
    expect(full - dark).toBeGreaterThanOrEqual(30);
  });

  it('keeps the optional observer model physically ordered if it is enabled', () => {
    // A half moon is a tenth of a full one and leaves the eye essentially where
    // a moonless night does; a full moon is genuinely near the top of the
    // mesopic range. Getting this ordering wrong is what broke the test above.
    expect(rodDominance(moonless().retinalLuminance)).toBe(1);
    expect(rodDominance(skyAt(-25, 40, 0.5).retinalLuminance)).toBeGreaterThan(0.97);
    const full = rodDominance(skyAt(-25, 40, 1).retinalLuminance);
    expect(full).toBeGreaterThan(0.6);
    expect(full).toBeLessThan(0.85);
  });

  it('leaves the lantern the brightest thing, even under a full moon', () => {
    // Part A's clause, re-checked against the brightest night Part B can make.
    const time = skyAt(-25, 40, 1);
    const exposure = time.exposure * time.daylightLift;
    const optionalRod = rodDominance(time.retinalLuminance);
    const shippingRod = optionalRod * DEFAULT_SCOTOPIC_STRENGTH;
    const globe = applyToneCurve(
      [LAMP_COLOR.r * 0.55, LAMP_COLOR.g * 0.55, LAMP_COLOR.b * 0.55],
      exposure,
    );
    const lamp = lum(applyScotopic(globe, globe, shippingRod));
    // The shipping path is direct, and the optional operator would also leave
    // this photopic pixel untouched if somebody explicitly enabled it.
    expect(shippingRod).toBe(0);
    expect(applyScotopic(globe, globe, optionalRod)).toEqual(globe);
    // On the rejected path the margin was 13x. Re-audited without the lift it
    // is about 17x, still the same intended hierarchy.
    expect(shippingSeaLuminance(time)).toBeLessThan(lamp * 0.1);
    expect(shippingSeaLuminance(time)).toBeGreaterThan(lamp * 0.03);
  });
});

describe('one moon, one number', () => {
  it('derives its direct light from its sky power, as the sun does', () => {
    // Before Part B these were two independent hand-set dials for one body and
    // they disagreed by thirteen times. The scale is now the sun's, reduced by
    // the moon's share of sky power, so they cannot drift apart again.
    expect(MOON_IRRADIANCE_SCALE).toBeCloseTo(
      (SUN_IRRADIANCE_SCALE * MOON_SKY_POWER) / SUN_SKY_POWER,
      12,
    );
    // And the resulting key-to-fill lands in the same band as the sun's rather
    // than three-quarters of an order out. Irradiance on an upward face is
    // radiance x pi for the fill; the direct term is already an irradiance.
    const moon = skyAt(-25, 40, 1);
    const moonKeyToFill =
      moon.moonLightIntensity / (vlum(moon.ambientRadiance) * Math.PI);
    const sun = skyAt(45, -30, 0.5);
    const sunKeyToFill =
      sun.sunLightIntensity / (vlum(sun.ambientRadiance) * Math.PI);
    expect(moonKeyToFill).toBeGreaterThan(sunKeyToFill * 0.5);
    expect(moonKeyToFill).toBeLessThan(sunKeyToFill * 2);
  });

  it('carries the glitter path as a ratio to the same power', () => {
    // moonSpecularGain multiplies uMoonPower in the shader, so raising the moon
    // raises the glitter with it automatically. The gain was reduced in step, to
    // hold the moonglade's on-screen brightness where it was calibrated.
    const onScreenBefore = 0.07 * 0.75 * 4.29;
    const onScreenNow =
      MOON_SKY_POWER * CLEAR_DEEP_OCEAN.moonSpecularGain * skyAt(-25, 40, 1).exposure;
    expect(onScreenNow).toBeCloseTo(onScreenBefore, 1);
  });

  it('charges star visibility for the sky it actually brightens', () => {
    // Derived: background-limited detection costs 1.25*log10(B) magnitudes.
    // Checked against the real sky rather than against the old hand-set 1.2.
    const dark = moonless().limitingMagnitude;
    const full = skyAt(-25, 40, 1).limitingMagnitude;
    const half = skyAt(-25, 40, 0.5).limitingMagnitude;
    const lowFull = skyAt(-25, 10, 1).limitingMagnitude;
    expect(dark).toBeGreaterThan(full);
    expect(full).toBeLessThan(half);
    // A real full moon takes a 6.2 sky to about 4.5. Ours must land near that
    // and must not go so far that the catalogue empties.
    expect(full).toBeGreaterThan(4.2);
    expect(full).toBeLessThan(5.4);
    // Elevation matters: a low moon washes out less sky than a high one. The
    // old penalty saturated at 3 degrees and charged both the same.
    expect(lowFull).toBeGreaterThan(full);
  });
});
