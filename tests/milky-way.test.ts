import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { eqjDirectionFromRaDec } from '../src/astronomy/AstronomyProvider';
import {
  MILKY_WAY_CHROMA_BASE64,
  MILKY_WAY_CHROMA_DIVISOR,
  MILKY_WAY_HEIGHT,
  MILKY_WAY_LUMINANCE_BASE64,
  MILKY_WAY_LUMINANCE_GAMMA,
  MILKY_WAY_METADATA,
  MILKY_WAY_WIDTH,
} from '../src/astronomy/data/milkyWay.generated';
import {
  renderToGalactic,
  visibilityFromLimitingMagnitude,
} from '../src/scene/MilkyWay';
import { vec3 } from '../src/world/math';

/** Row-major identity, i.e. render space aligned with EQJ. */
const IDENTITY: Float64Array = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function galacticOf(
  rightAscensionHours: number,
  declinationDeg: number,
  celestialToRender: Float64Array = IDENTITY,
): { longitudeDeg: number; latitudeDeg: number } {
  const matrix = renderToGalactic(celestialToRender, new THREE.Matrix3());
  const eqj = eqjDirectionFromRaDec(
    rightAscensionHours,
    declinationDeg,
    vec3(),
  );
  // EQJ into render space first — celestialToRender is row-major — and only
  // then into galactic, which is the order the frame actually runs in.
  const m = celestialToRender;
  const render = new THREE.Vector3(
    m[0] * eqj.x + m[1] * eqj.y + m[2] * eqj.z,
    m[3] * eqj.x + m[4] * eqj.y + m[5] * eqj.z,
    m[6] * eqj.x + m[7] * eqj.y + m[8] * eqj.z,
  );
  const g = render.applyMatrix3(matrix);
  let longitudeDeg = (Math.atan2(g.y, g.x) * 180) / Math.PI;
  if (longitudeDeg < 0) longitudeDeg += 360;
  return {
    longitudeDeg,
    latitudeDeg: (Math.asin(Math.min(Math.max(g.z, -1), 1)) * 180) / Math.PI,
  };
}

describe('galactic frame', () => {
  it('puts the IAU defining directions where they belong', () => {
    // The galactic centre is (l, b) = (0, 0) by definition, and the north
    // galactic pole is b = +90. If the basis were transposed or mis-handed,
    // these are the two places it would show first.
    const centre = galacticOf(266.4051 / 15, -28.93617);
    expect(centre.latitudeDeg).toBeCloseTo(0, 3);
    expect(Math.min(centre.longitudeDeg, 360 - centre.longitudeDeg))
      .toBeLessThan(0.01);

    const pole = galacticOf(192.85948 / 15, 27.12825);
    expect(pole.latitudeDeg).toBeCloseTo(90, 4);
  });

  it('agrees with published galactic coordinates for real objects', () => {
    // Independent of the two directions the basis was BUILT from, so this is
    // the check that the handedness of the third axis is right rather than
    // merely self-consistent. Tolerances are a tenth of a degree, far inside
    // the map's 0.75-degree texel.
    const cases: ReadonlyArray<
      readonly [string, number, number, number, number]
    > = [
      // name, RA hours, Dec deg, expected l, expected b
      ['LMC', 5.3928, -69.7561, 280.46, -32.89],
      ['SMC', 0.8772, -72.8286, 302.81, -44.33],
      ['Polaris', 2.5303, 89.2641, 123.28, 26.46],
      ['Sirius', 6.7525, -16.7161, 227.23, -8.89],
      ['Deneb', 20.6905, 45.2803, 84.28, 2.0],
    ];
    for (const [name, ra, dec, l, b] of cases) {
      const got = galacticOf(ra, dec);
      expect(`${name} l`).toBe(`${name} l`);
      expect(Math.abs(got.longitudeDeg - l)).toBeLessThan(0.1);
      expect(Math.abs(got.latitudeDeg - b)).toBeLessThan(0.1);
    }
  });

  it('pins the band to the sky, not to the screen', () => {
    // Whatever the world's rotation is doing, a star's galactic coordinates
    // must not move: the render rotation cancels between the two halves of
    // (M · G)ᵀ · M. If it did not, the band would swim against the stars
    // standing in it as the night turned — which is the failure this whole
    // composition exists to prevent.
    const c = Math.cos(0.9);
    const s = Math.sin(0.9);
    const rotations: ReadonlyArray<Float64Array> = [
      new Float64Array([c, -s, 0, s, c, 0, 0, 0, 1]),
      new Float64Array([1, 0, 0, 0, c, -s, 0, s, c]),
      new Float64Array([c, 0, s, 0, 1, 0, -s, 0, c]),
    ];
    const reference = galacticOf(6.7525, -16.7161);
    for (const rotation of rotations) {
      const moved = galacticOf(6.7525, -16.7161, rotation);
      expect(moved.longitudeDeg).toBeCloseTo(reference.longitudeDeg, 9);
      expect(moved.latitudeDeg).toBeCloseTo(reference.latitudeDeg, 9);
    }
  });
});

describe('baked Milky Way map', () => {
  it('decodes to exactly the declared planes', () => {
    expect(atob(MILKY_WAY_LUMINANCE_BASE64).length).toBe(
      MILKY_WAY_WIDTH * MILKY_WAY_HEIGHT,
    );
    expect(atob(MILKY_WAY_CHROMA_BASE64).length).toBe(
      2 *
        (MILKY_WAY_WIDTH / MILKY_WAY_CHROMA_DIVISOR) *
        (MILKY_WAY_HEIGHT / MILKY_WAY_CHROMA_DIVISOR),
    );
    expect(MILKY_WAY_METADATA.licence).toBe('CC BY 4.0');
    expect(MILKY_WAY_METADATA.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is brightest on the galactic plane and dark at the poles', () => {
    const luminance = atob(MILKY_WAY_LUMINANCE_BASE64);
    // Decoded, not raw. The stored bytes are linear^(1/4), so comparing them
    // directly compares a fourth root and would call a thousandfold
    // difference in brightness a threefold one.
    const rowMean = (row: number): number => {
      let sum = 0;
      for (let x = 0; x < MILKY_WAY_WIDTH; x++) {
        const stored = luminance.charCodeAt(row * MILKY_WAY_WIDTH + x) / 255;
        sum += stored ** MILKY_WAY_LUMINANCE_GAMMA;
      }
      return sum / MILKY_WAY_WIDTH;
    };
    const equator = rowMean(MILKY_WAY_HEIGHT / 2);
    // Not the very top row, which is the pole itself and a single point.
    const north = rowMean(4);
    const south = rowMean(MILKY_WAY_HEIGHT - 5);
    expect(equator).toBeGreaterThan(north * 3);
    expect(equator).toBeGreaterThan(south * 3);
  });
});

describe('milky way visibility', () => {
  it('needs a genuinely dark sky and saturates once it has one', () => {
    // Twilight and moonlight both arrive as a reduced limiting magnitude, so
    // one curve covers both. An extended source at 1.6-to-1 contrast is gone
    // long before the faintest stars are.
    expect(visibilityFromLimitingMagnitude(3)).toBe(0);
    expect(visibilityFromLimitingMagnitude(4.9)).toBe(0);
    expect(visibilityFromLimitingMagnitude(5.45)).toBeCloseTo(0.5, 2);
    expect(visibilityFromLimitingMagnitude(6.2)).toBe(1);
  });

  it('is monotone in sky darkness', () => {
    let previous = -1;
    for (let m = 0; m <= 7; m += 0.1) {
      const value = visibilityFromLimitingMagnitude(m);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});
