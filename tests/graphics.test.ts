import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Lamp } from '../src/scene/Lamp';
import {
  CLEAR_DEEP_OCEAN,
  waterBodyReflectance,
} from '../src/scene/oceanOptics';
import {
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  TimeOfDay,
  getSkyFillScale,
  limitingMagnitudeFromSunElevation,
  moonPhaseBrightness,
  setSkyFillScale,
} from '../src/scene/TimeOfDay';
import { WaveField } from '../src/scene/Waves';
import { SkySystem, type CloudFieldState } from '../src/scene/SkySystem';
import {
  STAR_CORE_SIGMA_PX,
  STAR_DOME_DEFAULT_FAR_M,
  STAR_DOME_LEGACY_RADIUS_M,
  STAR_HORIZON_EXTINCTION_MAG,
  STAR_POINT_SUPPORT_PX,
  STAR_TWINKLE_MAX_AMPLITUDE,
  StarField,
  starDomeRadiusM,
  starResolutionScale,
} from '../src/scene/StarField';
import { BRIGHT_STAR_CATALOGUE } from '../src/astronomy/data/brightStars.generated';
import { requiredSyntheticTerrainFarKm } from '../src/terrain/syntheticTerrainHarness';
import { SEA_STATES, findSeaState } from '../src/ocean/presets';
import { applyToneCurve } from '../src/scene/toneMapping';
import {
  MOON_EARTHSHINE_FLOOR,
  MOON_PHYSICAL_ANGULAR_RADIUS_RAD,
  MOON_PRESENTATION_RADIUS_RAD,
  moonRegolithPhaseMask,
} from '../src/scene/moonPresentation';

/**
 * Deterministic contracts for the graphics round's non-visual logic:
 * atmosphere continuity, exposure bounds and ordering, star visibility
 * monotonicity, lamp hysteresis, ocean optical functions, and isolation of
 * presentation state from the astronomy inputs it consumes.
 */

const DEG = Math.PI / 180;

/**
 * Ambient luminance of a moonless night, the anchor for the lamp's daylight
 * rolloff. Passing this means "the world is as dark as it gets", so the
 * rolloff is inert and these tests measure the flame alone.
 */
const NIGHT_AMBIENT = 1.472e-3;

/** Drive a TimeOfDay to a given sun elevation with a fixed azimuth. */
function refreshAt(
  time: TimeOfDay,
  sunElevationDeg: number,
  options: { moonElevationDeg?: number; moonFraction?: number; dt?: number } = {},
): void {
  const el = sunElevationDeg * DEG;
  const moonEl = (options.moonElevationDeg ?? -30) * DEG;
  const sun = new THREE.Vector3(Math.cos(el), Math.sin(el), 0);
  const moon = new THREE.Vector3(-Math.cos(moonEl), Math.sin(moonEl), 0);
  time.refreshFromAstronomy(
    options.dt ?? 1e6,
    sun,
    0,
    el,
    moon,
    Math.PI,
    moonEl,
    options.moonFraction ?? 0.5,
  );
}

describe('atmosphere inputs', () => {
  it('produces finite lighting across the full sun-elevation range', () => {
    const time = new TimeOfDay();
    for (let e = -90; e <= 90; e += 1.5) {
      refreshAt(time, e);
      const values = [
        time.sunLightIntensity,
        time.moonLightIntensity,
        time.ambientIntensity,
        time.exposure,
        time.ambientRadiance.x,
        time.ambientRadiance.y,
        time.ambientRadiance.z,
        time.hemisphericRadiance.x,
        time.hemisphericRadiance.y,
        time.hemisphericRadiance.z,
        time.limitingMagnitude,
        time.nightFactor,
      ];
      for (const v of values) {
        expect(Number.isFinite(v), `elev ${e}`).toBe(true);
      }
      expect(time.sunLightIntensity).toBeGreaterThanOrEqual(0);
      expect(time.ambientRadiance.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('is continuous through sunrise, zenith and twilight', () => {
    const time = new TimeOfDay();
    let previous: number | null = null;
    for (let e = -20; e <= 89.9; e += 0.1) {
      refreshAt(time, e);
      const lum =
        0.2126 * time.ambientRadiance.x +
        0.7152 * time.ambientRadiance.y +
        0.0722 * time.ambientRadiance.z;
      if (previous !== null) {
        const ratio = (lum + 1e-4) / (previous + 1e-4);
        expect(ratio, `elev ${e.toFixed(1)}`).toBeGreaterThan(0.8);
        expect(ratio, `elev ${e.toFixed(1)}`).toBeLessThan(1.25);
      }
      previous = lum;
    }
  });

  it('samples the sky, not the clock: elevation is the only driver', () => {
    const a = new TimeOfDay();
    const b = new TimeOfDay();
    refreshAt(a, 30);
    refreshAt(b, 30);
    expect(a.ambientRadiance.toArray()).toEqual(b.ambientRadiance.toArray());
  });

  it('retires the daylight fill cut only after the Sun is down', () => {
    const original = getSkyFillScale();
    try {
      const sample = (elevation: number, scale: number): THREE.Vector3 => {
        setSkyFillScale(scale);
        const time = new TimeOfDay();
        refreshAt(time, elevation);
        return time.ambientRadiance.clone();
      };

      const dayDim = sample(60, 0.8);
      const dayFull = sample(60, 1);
      expect(dayDim.x / dayFull.x).toBeCloseTo(0.8, 6);
      expect(dayDim.y / dayFull.y).toBeCloseTo(0.8, 6);
      expect(dayDim.z / dayFull.z).toBeCloseTo(0.8, 6);

      // The protected sunset band is unchanged as well: nightFactor is still
      // exactly zero while the disc is on the horizon.
      const sunsetDim = sample(0, 0.8);
      const sunsetFull = sample(0, 1);
      expect(sunsetDim.x / sunsetFull.x).toBeCloseTo(0.8, 6);

      // At astronomical night the clear-day key:fill decision is gone.
      const nightDim = sample(-25, 0.8);
      const nightFull = sample(-25, 1);
      expect(nightDim.x / nightFull.x).toBeCloseTo(1, 6);
      expect(nightDim.y / nightFull.y).toBeCloseTo(1, 6);
      expect(nightDim.z / nightFull.z).toBeCloseTo(1, 6);
    } finally {
      setSkyFillScale(original);
    }
  });
});

describe('lantern shadow lifecycle', () => {
  it('renders its six geometry-shadow faces only while the lamp contributes', () => {
    const lamp = new Lamp();
    try {
      expect(lamp.shadowEnabled).toBe(true);
      expect(lamp.shadowActive).toBe(false);

      // Auto-lights below civil twilight and completes its two-second ramp.
      lamp.update(2, -25, 0, NIGHT_AMBIENT);
      expect(lamp.renderEmission).toBeGreaterThan(1e-4);
      expect(lamp.shadowActive).toBe(true);

      // Auto-extinguishes in daylight, so the expensive cube map disappears.
      lamp.update(2, 30, 2, NIGHT_AMBIENT);
      expect(lamp.renderEmission).toBe(0);
      expect(lamp.shadowActive).toBe(false);

      lamp.mode = 'on';
      lamp.update(2, -25, 4, NIGHT_AMBIENT);
      expect(lamp.shadowActive).toBe(true);
      lamp.setShadowEnabled(false);
      expect(lamp.shadowActive).toBe(false);
    } finally {
      lamp.dispose();
    }
  });
});

describe('exposure', () => {
  it('stays inside its documented bounds everywhere', () => {
    const time = new TimeOfDay();
    for (let e = -90; e <= 90; e += 0.5) {
      refreshAt(time, e);
      // Asserted against the meter's own clamps rather than a copy of them,
      // so retuning the curve cannot leave this test guarding a stale number.
      expect(time.exposure).toBeGreaterThanOrEqual(EXPOSURE_MIN);
      expect(time.exposure).toBeLessThanOrEqual(EXPOSURE_MAX);
    }
  });

  it('orders day, sunset and night targets sensibly', () => {
    const time = new TimeOfDay();
    refreshAt(time, 60);
    const day = time.exposure;
    refreshAt(time, 0.5);
    const sunset = time.exposure;
    refreshAt(time, -25);
    const night = time.exposure;
    expect(day).toBeLessThan(sunset);
    expect(sunset).toBeLessThan(night);
  });

  it('smooths with the presentation delta, snapping only on large steps', () => {
    const time = new TimeOfDay();
    refreshAt(time, 60); // initialise at the day target
    const day = time.exposure;
    refreshAt(time, -25, { dt: 1 / 60 });
    const oneFrame = time.exposure;
    // One 60 fps frame of a 4 s time constant moves ~0.4% of the way.
    expect(Math.abs(oneFrame - day)).toBeLessThan(0.05);
    refreshAt(time, -25, { dt: 1e6 });
    const settled = time.exposure;
    expect(settled).toBeGreaterThan(1.2);
  });
});

describe('star visibility', () => {
  it('conserves point energy while a star crosses the device-pixel grid', () => {
    // CPU mirror of the fragment shader's normalized Gaussian, sampled across
    // one complete sub-pixel cell. The old 1.5 px hard-cut core reached zero
    // at DPR 1 and varied by roughly 2x even at DPR 2.
    const norm = 1 / (2 * Math.PI * STAR_CORE_SIGMA_PX ** 2);
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = 0;
    for (let sy = 0; sy <= 20; sy++) {
      for (let sx = 0; sx <= 20; sx++) {
        const subX = sx / 20;
        const subY = sy / 20;
        let energy = 0;
        for (let py = -3; py <= 4; py++) {
          for (let px = -3; px <= 4; px++) {
            const dx = px + 0.5 - subX;
            const dy = py + 0.5 - subY;
            if (
              Math.abs(dx) <= STAR_POINT_SUPPORT_PX / 2 &&
              Math.abs(dy) <= STAR_POINT_SUPPORT_PX / 2
            ) {
              energy +=
                Math.exp(
                  (-0.5 * (dx * dx + dy * dy)) /
                    (STAR_CORE_SIGMA_PX ** 2),
                ) * norm;
            }
          }
        }
        minimum = Math.min(minimum, energy);
        maximum = Math.max(maximum, energy);
      }
    }
    expect(minimum).toBeGreaterThan(0.98);
    expect(maximum / minimum).toBeLessThan(1.025);
  });

  it('uses brightness-only scintillation with no hard fragment cutoff', () => {
    const stars = new StarField({});
    try {
      expect(STAR_TWINKLE_MAX_AMPLITUDE).toBeLessThanOrEqual(0.05);
      expect(stars.material.vertexShader).toContain(
        'vIntensity = unoccludedIntensity * cloudTransmission * twinkleGain',
      );
      expect(stars.material.vertexShader).not.toMatch(
        /gl_PointSize[^;]*twinkle/,
      );
      expect(stars.material.fragmentShader).toContain(
        'pixelOffset = (gl_PointCoord - 0.5) * vPointSize',
      );
      expect(stars.material.fragmentShader).not.toContain(
        'if (alpha < 0.003) discard',
      );
    } finally {
      stars.dispose();
    }
  });

  it('conserves what a star puts on the screen when resolution drops', () => {
    // Adaptive resolution lowers setPixelRatio, the buffer shrinks, and the
    // browser upscales it. Without a correction the halo doubles in angular
    // size and every star quadruples the light it delivers, because the core
    // PSF is normalized per RENDER pixel and those pixels got bigger.
    expect(starResolutionScale(2)).toBe(1);
    expect(starResolutionScale(1)).toBe(0.5);
    expect(starResolutionScale(0.5)).toBe(0.25);
    // Above the reference nothing moves: the look was judged there, and a 3x
    // display must not get a different star field from a 2x one.
    expect(starResolutionScale(3)).toBe(1);

    const identity = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const stars = new StarField({});
    try {
      // Halo sigma scales linearly — angular size held.
      expect(stars.material.vertexShader).toContain('* uResolutionScale');
      // Core normalization scales quadratically — displayed energy held.
      expect(stars.material.fragmentShader).toContain(
        'CORE_NORM * uResolutionScale * uResolutionScale',
      );
      // The core's own sigma must NOT scale: it is a sampling floor, and
      // shrinking it below half a pixel is what makes stars alias in motion.
      expect(stars.material.fragmentShader).toContain(
        'pixelRadius2 / (CORE_SIGMA_PX * CORE_SIGMA_PX)',
      );

      stars.update(identity, new THREE.Vector3(), 6, 1);
      expect(stars.material.uniforms.uResolutionScale.value).toBe(0.5);
      stars.update(identity, new THREE.Vector3(), 6, 2);
      expect(stars.material.uniforms.uResolutionScale.value).toBe(1);
    } finally {
      stars.dispose();
    }
  });

  it('uses scene depth and the displayed cloud alpha as occluders', () => {
    const stars = new StarField({});
    try {
      expect(stars.material.depthTest).toBe(true);
      expect(stars.material.depthWrite).toBe(false);
      expect(stars.material.vertexShader).toContain(
        'cloudCacheAddress(cloudCumulusUv(skyDirection))',
      );
      // Beam transmittance, not the sky's appearance alpha. The exponent is
      // what converts one into the other; a linear composite here is what let
      // stars sit visibly on top of solid overcast.
      expect(stars.material.vertexShader).toContain(
        'pow(\n        max(1.0 - clamp(cloudAlpha, 0.0, 1.0), 0.0),\n        uCloudBeamPower\n      )',
      );
      expect(stars.material.vertexShader).toContain(
        'unoccludedIntensity * cloudTransmission',
      );
    } finally {
      stars.dispose();
    }
  });

  /**
   * The star dome's depth, which is a correctness question and not a look one.
   *
   * The pass depth-tests, which is what lets a sail mask the catalogue. It was
   * built at 485 m, so it also passed that test in front of a 6 km headland and
   * a 3,000 m massif — the depth arithmetic was right and the dome's position
   * was wrong. These pin the dome behind everything the camera can see, in the
   * ordinary view and in every range the terrain harness can mount.
   */
  describe('the star dome sits behind the world', () => {
    it('parks just inside whatever far plane the camera is carrying', () => {
      expect(starDomeRadiusM(STAR_DOME_DEFAULT_FAR_M)).toBeCloseTo(24500, 6);
      // The terrain harness raises `far` to range + 40 km, so a constant
      // distance would be overtaken the first time a peak was mounted far out.
      expect(starDomeRadiusM(200_000)).toBeCloseTo(196_000, 6);
      // Never collapse onto the vessel: a diagnostic camera with a short far
      // plane pulls the dome in only as far as the radius it always had.
      expect(starDomeRadiusM(100)).toBe(STAR_DOME_LEGACY_RADIUS_M);
      expect(starDomeRadiusM(Number.NaN)).toBe(
        starDomeRadiusM(STAR_DOME_DEFAULT_FAR_M),
      );
      // The A/B switch (`?starDome=near`) is the shipped-before behaviour.
      expect(starDomeRadiusM(STAR_DOME_DEFAULT_FAR_M, 'near')).toBe(485);
    });

    it('clears every mountable synthetic fixture and the far ocean', () => {
      // The ocean disc's OUTER_RADIUS is 20 km (src/scene/Ocean.ts).
      expect(starDomeRadiusM(STAR_DOME_DEFAULT_FAR_M)).toBeGreaterThan(20_000);
      for (const rangeKm of [1, 6, 21, 120, 400]) {
        const farM = requiredSyntheticTerrainFarKm(rangeKm) * 1000;
        const domeM = starDomeRadiusM(farM);
        // Behind the land, and still inside the frustum that land forced.
        expect(domeM, `range ${rangeKm} km`).toBeGreaterThan(rangeKm * 1000);
        expect(domeM, `range ${rangeKm} km`).toBeLessThan(farM);
      }
    });

    it('scales the dome without moving a star on screen', () => {
      const identity = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
      const stars = new StarField({});
      try {
        // Altitude is read from a normalized direction, not from a division by
        // a compiled-in radius — that division is what a scaled dome breaks.
        expect(stars.material.vertexShader).toContain(
          'vec3 skyDirection = normalize(rotated);\n  float altitude = skyDirection.y;',
        );
        expect(stars.material.vertexShader).not.toMatch(/rotated\.y \/ /);

        const eye = new THREE.Vector3(3, 2, -7);
        const sample = new THREE.Vector3(0, 485, 0);
        stars.update(identity, eye, 6, 2, undefined, 0, 25_000);
        stars.mesh.updateMatrixWorld(true);
        const far = sample.clone().applyMatrix4(stars.mesh.matrix).sub(eye);
        expect(stars.domeRadiusM).toBeCloseTo(24_500, 6);
        expect(far.length()).toBeCloseTo(24_500, 3);

        stars.domeAnchor = 'near';
        stars.update(identity, eye, 6, 2, undefined, 0, 25_000);
        const near = sample.clone().applyMatrix4(stars.mesh.matrix).sub(eye);
        expect(near.length()).toBeCloseTo(485, 6);

        // Same ray from the eye in both anchors: the dome radius is depth and
        // nothing else, because the pass sizes its own points.
        expect(
          far.clone().normalize().dot(near.clone().normalize()),
        ).toBeCloseTo(1, 12);
      } finally {
        stars.dispose();
      }
    });

    /**
     * The one population the move takes off the screen, bounded by arithmetic.
     *
     * Pushing the dome out lets the sea past 485 m occlude stars below the
     * horizon, where before only the sea within 485 m did. That band is not a
     * matter of taste: below the horizon `airMass` clamps, so extinction is a
     * fixed 6.893 magnitudes, and a star needs `mEff < uLimitMag + 0.40` to
     * have any visibility at all against the darkest sky the model produces.
     */
    it('can only ever have shown two stars below the horizon', () => {
      expect(STAR_HORIZON_EXTINCTION_MAG).toBeCloseTo(6.8929, 4);
      const darkestSky = limitingMagnitudeFromSunElevation(-90);
      expect(darkestSky).toBe(6.2);
      const brightestInvisible = darkestSky + 0.4 - STAR_HORIZON_EXTINCTION_MAG;
      expect(brightestInvisible).toBeCloseTo(-0.293, 3);

      const belowHorizon = BRIGHT_STAR_CATALOGUE.filter(
        ([, , magnitude]) => magnitude < brightestInvisible,
      ).map(([, , , , label]) => label);
      expect(belowHorizon.sort()).toEqual(['Canopus', 'Sirius']);
    });
  });

  it('limiting magnitude rises monotonically as the sun sinks', () => {
    let previous = limitingMagnitudeFromSunElevation(10);
    for (let e = 10; e >= -30; e -= 0.25) {
      const limit = limitingMagnitudeFromSunElevation(e);
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit, `elev ${e}`).toBeGreaterThanOrEqual(previous);
      previous = limit;
    }
  });

  it('hides ordinary stars in daylight and frees the catalogue only in the dark', () => {
    expect(limitingMagnitudeFromSunElevation(30)).toBeLessThanOrEqual(-6);
    expect(limitingMagnitudeFromSunElevation(-4)).toBeLessThan(2.5);
    expect(limitingMagnitudeFromSunElevation(-18)).toBeGreaterThanOrEqual(6);
  });

  it('a brighter star becomes visible no later than a fainter one', () => {
    // The shader's visibility ramp: smoothstep(limit + 0.4, limit - 0.9, m).
    const visibility = (m: number, limit: number): number => {
      const t = Math.min(
        1,
        Math.max(0, (m - (limit + 0.4)) / (limit - 0.9 - (limit + 0.4))),
      );
      return t * t * (3 - 2 * t);
    };
    for (let limit = -2; limit <= 6.5; limit += 0.25) {
      let previous = visibility(-1.5, limit);
      for (let m = -1.5; m <= 5; m += 0.25) {
        const v = visibility(m, limit);
        expect(v).toBeLessThanOrEqual(previous + 1e-9);
        previous = v;
      }
    }
  });

  it('a bright moon reduces the limit without breaking bounds', () => {
    const dark = new TimeOfDay();
    refreshAt(dark, -25, { moonElevationDeg: -30, moonFraction: 0 });
    const moonless = dark.limitingMagnitude;
    refreshAt(dark, -25, { moonElevationDeg: 45, moonFraction: 1 });
    const fullMoon = dark.limitingMagnitude;
    expect(fullMoon).toBeLessThan(moonless);
    expect(fullMoon).toBeGreaterThanOrEqual(-6);
  });
});

describe('lunar phase presentation', () => {
  it('reaches zero at new moon and follows disc-integrated phase brightness', () => {
    expect(moonPhaseBrightness(0)).toBe(0);
    expect(moonPhaseBrightness(0.5)).toBeCloseTo(0.125, 12);
    expect(moonPhaseBrightness(1)).toBe(1);
    expect(moonPhaseBrightness(-1)).toBe(0);
    expect(moonPhaseBrightness(2)).toBe(1);
  });

  it('scales Moon power and direct light from the same phase authority', () => {
    const time = new TimeOfDay();
    refreshAt(time, -25, { moonElevationDeg: 45, moonFraction: 1 });
    const fullPower = time.moonPower;
    const fullLight = time.moonLightIntensity;
    refreshAt(time, -25, { moonElevationDeg: 45, moonFraction: 0.5 });
    expect(time.moonPhaseBright).toBeCloseTo(0.125, 12);
    expect(time.moonPower).toBeCloseTo(fullPower * 0.125, 12);
    expect(time.moonLightIntensity).toBeCloseTo(fullLight * 0.125, 12);
    refreshAt(time, -25, { moonElevationDeg: 45, moonFraction: 0 });
    expect(time.moonPower).toBe(0);
    expect(time.moonLightIntensity).toBe(0);
  });

  it('publishes the same phase brightness to the Moon halo', () => {
    const time = new TimeOfDay();
    const sky = new SkySystem(3, 8);
    try {
      refreshAt(time, -25, { moonElevationDeg: 45, moonFraction: 0.5 });
      sky.update(time, 0, new THREE.Vector3());
      expect(sky.uniforms.uMoonHalo.value).toBeCloseTo(0.125, 12);

      refreshAt(time, -25, { moonElevationDeg: 45, moonFraction: 0 });
      sky.update(time, 1, new THREE.Vector3());
      expect(sky.uniforms.uMoonHalo.value).toBe(0);
    } finally {
      sky.dispose();
    }
  });

  it('draws an enlarged continuously lit sphere while leaving ocean energy separate', () => {
    expect(
      MOON_PRESENTATION_RADIUS_RAD / MOON_PHYSICAL_ANGULAR_RADIUS_RAD,
    ).toBeGreaterThan(2.4);
    expect(
      MOON_PRESENTATION_RADIUS_RAD / MOON_PHYSICAL_ANGULAR_RADIUS_RAD,
    ).toBeLessThan(2.9);

    // Full-phase form rolls continuously from the face to the limb. A binary
    // mask returns the same value for all three and recreates the reported
    // geometric-cutout look.
    const face = moonRegolithPhaseMask(1);
    const shoulder = moonRegolithPhaseMask(0.6);
    const limb = moonRegolithPhaseMask(0.15);
    expect(face).toBeCloseTo(1, 12);
    expect(face).toBeGreaterThan(shoulder);
    expect(shoulder).toBeGreaterThan(limb);
    expect(face - limb).toBeGreaterThan(0.3);
    expect(moonRegolithPhaseMask(0)).toBe(MOON_EARTHSHINE_FLOOR);
    expect(moonRegolithPhaseMask(-1)).toBe(MOON_EARTHSHINE_FLOOR);

    const sky = new SkySystem(3, 8);
    try {
      expect(sky.material.fragmentShader).toContain(
        'float phaseMask = 0.006 + 0.994 * direct * terminator',
      );
      expect(sky.material.fragmentShader).toContain(
        `/ ${MOON_PRESENTATION_RADIUS_RAD.toFixed(6)}`,
      );
    } finally {
      sky.dispose();
    }
    expect(CLEAR_DEEP_OCEAN.moonSpecularGain).toBeLessThanOrEqual(0.75);
  });
});

describe('lamp logic', () => {
  it('follows the hysteresis band without flickering inside it', () => {
    const lamp = new Lamp();
    lamp.group.updateMatrixWorld();
    lamp.update(10, 10, 0, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(false);
    // Descend into the band: stays off until -5.
    lamp.update(10, -4, 1, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(false);
    lamp.update(10, -6, 2, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(true);
    // Back inside the band: stays on until above -3.
    lamp.update(10, -4, 3, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(true);
    lamp.update(10, -2, 4, NIGHT_AMBIENT);
    lamp.update(10, -2, 5, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(false);
  });

  /**
   * The ocean reads `emission`; the deck reads `light.intensity`. They are two
   * renderers looking at one flame, and the sea's response must not be
   * expressed in the deck renderer's units — feeding the PointLight's
   * intensity to the water is what made a trim to the planks silently retune
   * the sea. The contract is that `emission` is a 0..1 level with the flame's
   * flicker on it and nothing else, and that the light's own scale factor is
   * demonstrably not part of it.
   */
  it('reports a renderer-independent emission level for the water', () => {
    const lamp = new Lamp();
    lamp.group.updateMatrixWorld();
    lamp.update(10, 30, 0, NIGHT_AMBIENT);
    expect(lamp.emission).toBe(0);

    for (let i = 0; i < 100; i++) lamp.update(0.1, -10, i * 0.1, NIGHT_AMBIENT);
    // Unit-scaled: the flicker is +/-6% at most, and nothing else rides along.
    expect(lamp.emission).toBeGreaterThan(0.9);
    expect(lamp.emission).toBeLessThan(1.07);
    // The deck's light lives on a different scale, and stays there.
    expect(lamp.light.intensity).toBeGreaterThan(1.5 * lamp.emission);

    lamp.intensityScale = 0.5;
    lamp.update(0.1, -10, 20, NIGHT_AMBIENT);
    expect(lamp.emission).toBeLessThan(0.55);
  });

  /**
   * The daylight rolloff, which is the whole reason `renderEmission` exists
   * apart from `emission`.
   *
   * A real lantern is not dim at noon, it is irrelevant at noon — five orders
   * of magnitude under the sun — and this scene's 8.5-stop day/night span
   * cannot say that on its own. So the flame's ILLUMINATION rolls off with the
   * ambient it is competing against, while the flame's own emissive surfaces
   * do not, because daylight does not dim a flame.
   */
  it('drowns the flame out as the world brightens, without putting it out', () => {
    const lamp = new Lamp();
    lamp.mode = 'on';
    lamp.group.updateMatrixWorld();

    const settle = (ambient: number): void => {
      for (let i = 0; i < 100; i++) lamp.update(0.1, -10, i * 0.1, ambient);
    };

    settle(NIGHT_AMBIENT);
    const night = lamp.renderEmission;
    const nightGlass = lamp.emission;
    // Anchored: at the reference darkness the rolloff is inert.
    expect(night).toBeCloseTo(lamp.emission, 6);

    // Civil dusk: lit and clearly present, but not yet at full strength.
    settle(5.03e-3);
    expect(lamp.renderEmission).toBeLessThan(night * 0.5);
    expect(lamp.renderEmission).toBeGreaterThan(night * 0.1);

    // Noon: three orders of magnitude down, so it lights nothing discernible.
    settle(5.14e-1);
    expect(lamp.renderEmission).toBeLessThan(night * 0.01);
    // ...but the flame itself is burning exactly as hard as it was at midnight,
    // so the lantern still reads as lit if you look straight at it.
    expect(lamp.emission).toBeCloseTo(nightGlass, 6);
    expect(lamp.isOn).toBe(true);

    // Monotonic in ambient — the drown-out is a ramp, never a step.
    let previous = Infinity;
    for (const ambient of [1e-3, 5e-3, 2e-2, 1e-1, 5e-1]) {
      settle(ambient);
      expect(lamp.renderEmission).toBeLessThan(previous);
      previous = lamp.renderEmission;
    }
  });

  /**
   * The flame's height above the raft is a lighting number, not just a
   * modelling one: the ocean reflects a source at this height, and a reflected
   * source's glitter column lengthens with it. Rebuilding the lantern must not
   * move it by accident.
   */
  it('keeps the flame at the height the glitter column is built around', () => {
    const lamp = new Lamp();
    lamp.group.updateMatrixWorld();
    lamp.update(0.1, -10, 0, NIGHT_AMBIENT);
    expect(lamp.flameWorld.y).toBeCloseTo(0.6, 2);
    // Hung off the davit arm, clear of the post it is lashed to.
    expect(lamp.flameWorld.x).toBeGreaterThan(0.1);
  });

  it('ramps rather than steps, and respects forced modes', () => {
    const lamp = new Lamp();
    lamp.group.updateMatrixWorld();
    lamp.update(0.1, -10, 0, NIGHT_AMBIENT);
    expect(lamp.litLevel).toBeGreaterThan(0);
    expect(lamp.litLevel).toBeLessThan(0.2);
    lamp.mode = 'off';
    for (let i = 0; i < 100; i++) lamp.update(0.1, -10, i * 0.1, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(false);
    lamp.mode = 'on';
    for (let i = 0; i < 100; i++) lamp.update(0.1, 30, i * 0.1, NIGHT_AMBIENT);
    expect(lamp.isOn).toBe(true);
    expect(lamp.litLevel).toBeLessThanOrEqual(1);
  });
});

describe('ocean optical functions', () => {
  it('derives a plausible, bounded deep-water reflectance', () => {
    const rw = waterBodyReflectance(CLEAR_DEEP_OCEAN);
    for (const channel of rw) {
      expect(channel).toBeGreaterThan(0);
      expect(channel).toBeLessThan(0.2);
    }
    // Deep clear water is blue: reflectance must rise towards the blue end.
    expect(rw[2]).toBeGreaterThan(rw[1]);
    expect(rw[1]).toBeGreaterThan(rw[0]);
  });

  it('keeps the whitecap band finite and ordered in every preset', () => {
    const band: [number, number] = [0, 0];
    for (const state of SEA_STATES) {
      const field = new WaveField(findSeaState(state.name));
      field.breakBand(band);
      expect(Number.isFinite(band[0]), state.name).toBe(true);
      expect(Number.isFinite(band[1]), state.name).toBe(true);
      expect(band[1], state.name).toBeGreaterThan(band[0]);
    }
  });

  it('reproduces the calibrated band exactly at the shipping moderate state', () => {
    const field = new WaveField(findSeaState('CURRENT_MODERATE'));
    const band: [number, number] = [0, 0];
    field.breakBand(band);
    // k0/k1 were solved so this state keeps its pre-round 0.80T..1.25T band.
    expect(band[0]).toBeCloseTo(field.breakingThreshold * 0.8, 2);
    expect(band[1]).toBeCloseTo(field.breakingThreshold * 1.25, 2);
  });
});

describe('lighting isolation', () => {
  it('keeps direct light at zero below the horizon and moonlight gated', () => {
    const time = new TimeOfDay();
    refreshAt(time, -10);
    expect(time.sunLightIntensity).toBeLessThan(1e-4);
    refreshAt(time, -15, { moonElevationDeg: -20 });
    expect(time.moonLightIntensity).toBe(0);
    refreshAt(time, -15, { moonElevationDeg: 40, moonFraction: 1 });
    expect(time.moonLightIntensity).toBeGreaterThan(0);
  });

  it('does not mutate the astronomical vectors it consumes', () => {
    const time = new TimeOfDay();
    const sun = new THREE.Vector3(0.3, 0.5, 0.81).normalize();
    const moon = new THREE.Vector3(-0.3, -0.5, 0.81).normalize();
    const sunBefore = sun.clone();
    const moonBefore = moon.clone();
    time.refreshFromAstronomy(1, sun, 0, 0.5, moon, Math.PI, -0.5, 0.25);
    expect(sun.equals(sunBefore)).toBe(true);
    expect(moon.equals(moonBefore)).toBe(true);
  });
});

/**
 * SUNSET PROGRESSION.
 *
 * The defect these lock out, reported from the running game: "the sky
 * surrounding the sun peaks in its orange/pink colour when the sun is still
 * several degrees above the horizon... but then as the disc of the sun falls
 * lower past that point, the sky starts getting bluer again to match more like
 * daytime colours, even though the sun disc is still visible."
 *
 * It was real and measurable — the sky just above the horizon toward the sun
 * went 248,238,215 at sun +6 deg and 155,196,238 at sun 0 — and its cause was
 * charging every scattering event along the view ray the sun transmittance
 * measured AT THE OBSERVER. These assert the property directly, on the shared
 * model, so the geometry cannot silently regress into a flat slab again.
 */
describe('sunset progression', () => {
  // The claim is about what the player SEES, so these assert display values,
  // through the same exposure + ACES + sRGB chain the renderer uses. A linear
  // radiance ratio is a poor proxy: ACES compresses hard near white, so a large
  // linear ratio can still look like a pale cream.
  const encode = (x: number) =>
    x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

  /** Scene radiance in the given direction, before exposure or tone curve. */
  function radiance(
    time: TimeOfDay,
    elevationDeg: number,
    azimuth = 0,
  ): { rgb: [number, number, number]; lum: number } {
    const el = elevationDeg * DEG;
    const rgb: [number, number, number] = [0, 0, 0];
    time.skyRadiance(
      new THREE.Vector3(
        Math.cos(el) * Math.cos(azimuth),
        Math.sin(el),
        Math.cos(el) * Math.sin(azimuth),
      ),
      rgb,
    );
    return { rgb, lum: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] };
  }

  function displayed(time: TimeOfDay, elevationDeg: number, azimuth = 0): number[] {
    const el = elevationDeg * DEG;
    const out: [number, number, number] = [0, 0, 0];
    time.skyRadiance(
      new THREE.Vector3(
        Math.cos(el) * Math.cos(azimuth),
        Math.sin(el),
        Math.cos(el) * Math.sin(azimuth),
      ),
      out,
    );
    // The SHIPPING display transform, not a local copy of one. A test that
    // measures the sky through a curve the game does not use is measuring
    // nothing — this assertion set was written against ACES and kept passing
    // for a while after ACES was gone.
    return applyToneCurve(out, time.exposure).map((c) =>
      Math.round(Math.min(Math.max(encode(c), 0), 1) * 255),
    );
  }

  it('keeps warming as the sun descends, and is warm when the disc lands', () => {
    // The reported defect, verbatim: "the sky surrounding the sun peaks in its
    // orange/pink colour when the sun is still several degrees above the
    // horizon... but then as the disc of the sun falls lower past that point,
    // the sky starts getting bluer again". Measured before the fix, sky at 2 deg
    // elevation in the sun's azimuth: R-B = +33 at sun +6, and -83 at sun 0 —
    // it really did hand back a daytime blue with the disc still on the water.
    const time = new TimeOfDay();
    let previous = -Infinity;
    for (const elevation of [8, 6, 4, 3, 2, 1]) {
      refreshAt(time, elevation);
      const [r, , b] = displayed(time, 2);
      expect(r - b).toBeGreaterThan(previous);
      previous = r - b;
    }
    // Warmth peaks around +1 rather than +6, and the disc touching the sea
    // still finds an unambiguously warm sky rather than a blue one.
    refreshAt(time, 0);
    const [r, g, b] = displayed(time, 2);
    expect(r - b).toBeGreaterThan(50);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('keeps the afterglow alive below the horizon and concentrated', () => {
    const time = new TimeOfDay();
    for (const elevation of [0, -1, -2, -4, -6]) {
      refreshAt(time, elevation);
      // The glow is a place in the sky, not a tint on the whole dome: the
      // sunset side stays markedly brighter than the Earth's-shadow side all
      // the way through nautical twilight.
      //
      // Asserted on RADIANCE, not on the displayed pixel. The claim is about
      // the sky model, and any display transform with a shoulder compresses
      // the brighter side harder than the dimmer one — measured through the
      // shipping curve this same 1.45-2.2x radiance ratio reads as 1.17-1.45x
      // on screen. Testing it through the transform makes a sky assertion
      // hostage to a tone-curve constant, which is how it would fail next time
      // the curve is retuned for a reason that has nothing to do with dusk.
      expect(radiance(time, 3, 0).lum).toBeGreaterThan(
        radiance(time, 3, Math.PI).lum * 1.3,
      );
      // The anti-solar side stays cool while it does. This one IS a claim
      // about the finished picture, so it is measured there.
      const away = displayed(time, 3, Math.PI);
      expect(away[2]).toBeGreaterThan(away[0]);
    }
  });

  it('has no radiance step across the horizon line', () => {
    // A discontinuity here draws a hard band between ocean and sky — reported
    // as "this glowing white halo across the horizon" looking at the sunset
    // and "literally this dark band between the ocean and the sky" opposite.
    // The cause was the multi-scatter reach blowing up hyperbolically as the
    // view ray flattened; the ratio test below is what bounds it.
    const time = new TimeOfDay();
    const out: [number, number, number] = [0, 0, 0];
    for (const sunElevation of [3, 0, -1.5, -5, -8]) {
      refreshAt(time, sunElevation);
      for (const azimuth of [0, Math.PI / 2, Math.PI]) {
        let previousLum = 0;
        for (let e = 0; e <= 6; e += 0.25) {
          const el = e * DEG;
          time.skyRadiance(
            new THREE.Vector3(
              Math.cos(el) * Math.cos(azimuth),
              Math.sin(el),
              Math.cos(el) * Math.sin(azimuth),
            ),
            out,
          );
          const lum = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
          if (previousLum > 0) {
            const ratio = lum / previousLum;
            // Calibrated, not guessed. Measured worst change per quarter-degree
            // over this whole sweep: 3.4% for the pre-round model, 27.3% for
            // the state the band was reported in, 3.2% now. 8% leaves room for
            // honest gradients and still fails long before a band is visible.
            expect(ratio).toBeLessThan(1.08);
            expect(ratio).toBeGreaterThan(1 / 1.08);
          }
          previousLum = lum;
        }
      }
    }
  });

  it('leaves the established daytime sky deep blue', () => {
    // The round's gating fix. The sunset work reaches into the same shared
    // function, so the daytime verdict is asserted rather than assumed.
    const time = new TimeOfDay();
    const out: [number, number, number] = [0, 0, 0];
    for (const elevation of [30, 45, 60]) {
      refreshAt(time, elevation);
      time.skyRadiance(new THREE.Vector3(0, 1, 0), out);
      expect(out[2]).toBeGreaterThan(out[0] * 3);
      expect(out[2]).toBeGreaterThan(out[1] * 1.6);
      // Blue, not turquoise: the red channel must stay off the gamut floor.
      expect(out[0]).toBeGreaterThan(0.005);
    }
  });
});

/** A cloud clock frozen at a chosen drift and evolution. */
function cloudField(patch: Partial<CloudFieldState> = {}): CloudFieldState {
  return {
    offsetX: 0,
    offsetZ: 0,
    evolve: 0,
    ...patch,
  };
}

class StubSunDiscTimeOfDay extends TimeOfDay {
  sunTransmission: (dir: THREE.Vector3) => number = () => 1;
  readonly sampledSunDirections: THREE.Vector3[] = [];

  protected override sunDiscPointTransmittance(dir: THREE.Vector3): number {
    this.sampledSunDirections.push(dir.clone());
    return this.sunTransmission(dir);
  }
}

describe('cloud-aware radiance means', () => {
  it('clouds move the means, and zero opacity restores the clear sky exactly', () => {
    const clear = new TimeOfDay();
    refreshAt(clear, 45);

    const cloudy = new TimeOfDay();
    cloudy.setCloudState(0.5, 0.85, cloudField());
    refreshAt(cloudy, 45);
    expect(cloudy.hemisphericRadiance.toArray()).not.toEqual(
      clear.hemisphericRadiance.toArray(),
    );
    expect(cloudy.ambientRadiance.toArray()).not.toEqual(
      clear.ambientRadiance.toArray(),
    );

    // The lab's "Clouds" toggle zeroes the shared opacity, so opacity 0 must
    // be bit-for-bit the clear-sky model, not merely close to it.
    const off = new TimeOfDay();
    off.setCloudState(0.5, 0, cloudField());
    refreshAt(off, 45);
    expect(off.hemisphericRadiance.toArray()).toEqual(
      clear.hemisphericRadiance.toArray(),
    );
    expect(off.ambientRadiance.toArray()).toEqual(
      clear.ambientRadiance.toArray(),
    );
  });

  /**
   * Cover greys the sky, dims it, and shuts the sun off — three claims, and
   * the first one is deliberately weaker than it used to be.
   *
   * This test used to assert that blue share falls MONOTONICALLY as cover
   * rises, and that is not a property of a physically integrated layer. A
   * half-covered sunlit sky is the most NEUTRAL of the three, because brilliant
   * white cumulus dominate a mean that also contains blue sky; a heavy overcast
   * is dimmer and slightly blue-grey, which is what an overcast sky looks like
   * in a photograph. Measured at sun 45: clear 0.512, broken 0.351, overcast
   * 0.378 — the ordering the old form asserted holds at the ends and inverts in
   * the middle, and it inverted because the OLD march could not make an
   * overcast base dark enough for its own blue skylight to stop dominating.
   *
   * What survives is what was load bearing: an overcast sky must be far nearer
   * grey than a clear one, must be dimmer than a clear one, and must not let
   * the sun through. Those catch the regression this guard exists for — the
   * ambient term keeping its hue at depth, which made a heavy overcast come out
   * BLUER than a broken sky and did exactly that during the traverse round.
   */
  it('greys, dims and occludes as cover rises', () => {
    // uCloudCover is a threshold on the noise field: LOWER means more cloud.
    const sample = (cover: number) => {
      const time = new TimeOfDay();
      time.setCloudState(cover, 1, cloudField());
      refreshAt(time, 45);
      const h = time.hemisphericRadiance;
      const total = Math.max(h.x + h.y + h.z, 1e-9);
      return {
        // Distance of the mean's blue share from neutral grey.
        fromGrey: Math.abs(h.z / total - 1 / 3),
        lum: 0.2126 * h.x + 0.7152 * h.y + 0.0722 * h.z,
        // What actually lights the world: the two three.js light intensities,
        // which share a scale with each other.
        scene: time.ambientIntensity + time.sunLightIntensity,
        sun: time.sunCloudTransmittance,
      };
    };
    const overcast = sample(0.15);
    const clear = sample(0.95);
    expect(overcast.fromGrey).toBeLessThan(clear.fromGrey * 0.5);
    expect(overcast.sun).toBeLessThan(0.05);
    expect(clear.sun).toBeGreaterThan(0.95);
    // An overcast day is darker where darkness is actually decided: in the
    // light that reaches the scene. NOT in the sky's mean radiance, which this
    // used to assert — a bright overcast dome really is brighter in mean than a
    // clear one that is deep blue over most of its area, and the model agrees.
    // The old assertion only held because the 13-sample estimator it read
    // over-reported the clear sky by 154% against a 4000-sample reference.
    expect(overcast.scene).toBeLessThan(clear.scene * 0.5);
    // And the sun opens up monotonically as the threshold rises.
    let previous = -1;
    for (const cover of [0.15, 0.3, 0.5, 0.7, 0.95]) {
      const t = sample(cover).sun;
      expect(t, `cover ${cover}`).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it('an occluding cloud dims the direct sun with its transmittance', () => {
    const clear = new TimeOfDay();
    refreshAt(clear, 45);
    expect(clear.sunCloudTransmittance).toBe(1);

    // Cover 0.05 is near-total overcast (cover is a threshold: lower = more
    // cloud), so the slab passes almost nothing and the directional light —
    // the glitter's and the raft's sun — must collapse with it.
    const overcast = new TimeOfDay();
    overcast.setCloudState(0.05, 0.85, cloudField());
    refreshAt(overcast, 45);
    expect(overcast.sunCloudTransmittance).toBeGreaterThanOrEqual(0);
    expect(overcast.sunCloudTransmittance).toBeLessThan(0.6);
    expect(overcast.sunLightIntensity).toBeLessThan(
      clear.sunLightIntensity * 0.7,
    );
  });

  it('integrates partial cloud cover over sixteen points on the solar disc', () => {
    const time = new StubSunDiscTimeOfDay();
    time.setCloudState(0.5, 1, cloudField());
    time.sunTransmission = (dir) => (dir.z > 0 ? 1 : 0);

    refreshAt(time, 45, { dt: 1 / 60 });

    expect(time.sunCloudTransmittance).toBeCloseTo(0.5, 7);
    expect(time.sampledSunDirections).toHaveLength(16);
    const radii = time.sampledSunDirections.map((dir) =>
      Math.acos(Math.min(1, Math.max(-1, dir.dot(time.sunDirection)))),
    );
    expect(Math.max(...radii)).toBeLessThan(0.00465);
    expect(Math.max(...radii)).toBeGreaterThan(0.0044);
  });

  it('refreshes four cached solar-disc points per frame and snaps all sixteen', () => {
    const time = new StubSunDiscTimeOfDay();
    time.setCloudState(0.5, 1, cloudField());

    refreshAt(time, 45, { dt: 1 / 60 });
    expect(time.sampledSunDirections).toHaveLength(16);
    expect(time.sunCloudTransmittance).toBe(1);

    time.sampledSunDirections.length = 0;
    time.sunTransmission = () => 0;
    const expected = [0.75, 0.5, 0.25, 0];
    for (const transmission of expected) {
      refreshAt(time, 45, { dt: 1 / 60 });
      expect(time.sunCloudTransmittance).toBeCloseTo(transmission, 7);
    }
    expect(time.sampledSunDirections).toHaveLength(16);

    time.sampledSunDirections.length = 0;
    time.sunTransmission = () => 0.4;
    refreshAt(time, 45, { dt: 1 });
    expect(time.sampledSunDirections).toHaveLength(16);
    expect(time.sunCloudTransmittance).toBeCloseTo(0.4, 6);
  });

  it('stays finite and non-negative with clouds across sun elevations', () => {
    const time = new TimeOfDay();
    time.setCloudState(0.3, 0.85, cloudField({ offsetX: 137, offsetZ: -42 }));
    for (let e = -30; e <= 80; e += 5) {
      refreshAt(time, e);
      for (const v of [
        time.ambientRadiance.x,
        time.ambientRadiance.y,
        time.ambientRadiance.z,
        time.hemisphericRadiance.x,
        time.hemisphericRadiance.y,
        time.hemisphericRadiance.z,
        time.exposure,
      ]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/** Cloud/weather motion has no astronomical-clock input. */
describe('cloud presentation clock', () => {
  const WIND = new THREE.Vector2(1, 0);
  /** The vessel's starting latitude: 35 degrees SOUTH, so the veer is negative. */
  const LAT = -33.9 * DEG;

  const drift = (sky: SkySystem): number =>
    Math.hypot(sky.cloudField.offsetX, sky.cloudField.offsetZ);

  it('stands still for a zero presentation delta', () => {
    const sky = new SkySystem(3, 8);
    sky.advanceCloudPresentation(0, WIND, 6, LAT);
    expect(drift(sky)).toBe(0);
    expect(sky.cloudField.evolve).toBe(0);
  });

  it('drifts and evolves in proportion to bounded presentation time', () => {
    const oneSecond = new SkySystem(3, 8);
    oneSecond.advanceCloudPresentation(1, WIND, 6, LAT);
    const twoSeconds = new SkySystem(3, 8);
    twoSeconds.advanceCloudPresentation(2, WIND, 6, LAT);
    expect(drift(oneSecond)).toBeGreaterThan(0);
    expect(drift(twoSeconds)).toBeCloseTo(2 * drift(oneSecond), 6);
    expect(twoSeconds.cloudField.evolve).toBeCloseTo(
      2 * oneSecond.cloudField.evolve,
      6,
    );
  });

  it('moves at the weather speed expressed by metres per real second', () => {
    const sky = new SkySystem(3, 8);
    sky.advanceCloudPresentation(1, WIND, 6, LAT);
    expect(drift(sky)).toBeCloseTo(6 * 1.85, 4);
  });

  it('does not teleport the sky when the wind changes', () => {
    const sky = new SkySystem(3, 8);
    for (let i = 0; i < 600; i++) {
      sky.advanceCloudPresentation(1, WIND, 6, LAT);
    }
    const before = { x: sky.cloudField.offsetX, z: sky.cloudField.offsetZ };
    sky.advanceCloudPresentation(
      1,
      new THREE.Vector2(0, 1),
      14,
      LAT,
    );
    const step = Math.hypot(
      sky.cloudField.offsetX - before.x,
      sky.cloudField.offsetZ - before.z,
    );
    // One frame of the NEW wind, and nothing more.
    expect(step).toBeLessThan(500);
  });

  it('turns the wind the hemisphere\'s way, and not at all on the equator', () => {
    // The Ekman spiral is driven by the Coriolis parameter, so the sense of the
    // turn flips with the hemisphere and the turn itself vanishes at the line.
    // The raft starts in the SOUTH; hard-coding the northern sense would have
    // been wrong for the only water anyone has sailed.
    const heading = (lat: number): number => {
      const sky = new SkySystem(3, 8);
      sky.advanceCloudPresentation(1, WIND, 6, lat);
      return Math.atan2(sky.cloudField.offsetZ, sky.cloudField.offsetX);
    };
    const surface = Math.atan2(WIND.y, WIND.x);
    expect(heading(45 * DEG) - surface).toBeGreaterThan(0.1);
    expect(heading(-45 * DEG) - surface).toBeLessThan(-0.1);
    expect(heading(0)).toBeCloseTo(surface, 6);
  });

  it('carries the deck faster than the surface wind that drives it', () => {
    const sky = new SkySystem(3, 8);
    const elapsedSeconds = 60;
    sky.advanceCloudPresentation(elapsedSeconds, WIND, 6, LAT);
    const surfaceDistance = 6 * elapsedSeconds;
    const deckDistance = Math.hypot(
      sky.cloudField.offsetX,
      sky.cloudField.offsetZ,
    );
    // Wind aloft strengthens with height. The gain is the textbook maritime
    // Ekman figure and is what stops the sky drifting at sea-surface pace;
    // bracketed rather than pinned so the constant can still be tuned.
    expect(deckDistance / surfaceDistance).toBeGreaterThan(1.5);
    expect(deckDistance / surfaceDistance).toBeLessThan(2.5);
  });

  it('rejects negative or non-finite presentation deltas', () => {
    const sky = new SkySystem(3, 8);
    expect(() => sky.advanceCloudPresentation(-1, WIND, 6, LAT)).toThrow(
      /non-negative/,
    );
    expect(() => sky.advanceCloudPresentation(Number.NaN, WIND, 6, LAT)).toThrow(
      /finite/,
    );
  });
});
