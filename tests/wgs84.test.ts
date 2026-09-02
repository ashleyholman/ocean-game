import { describe, expect, it } from 'vitest';
import {
  WGS84_SEMI_MAJOR_M,
  WGS84_SEMI_MINOR_M,
  circularAngleDifferenceRad,
  createGeographicBasis,
  ecefToGeodetic,
  ellipsoidEquationResidual,
  geodeticToEcef,
  geographicBasisFromGeodetic,
  surfaceNormalEcef,
  wrapLongitudeRad,
  type GeodeticCoordinates,
} from '../src/world/wgs84';
import { distanceVec3, dotVec3, vec3 } from '../src/world/math';

const DEG = Math.PI / 180;

describe('WGS84 geodetic/ECEF conversion', () => {
  it('matches cardinal analytical coordinates', () => {
    const out = vec3();
    geodeticToEcef(0, 0, 0, out);
    expect(out).toEqual({ x: WGS84_SEMI_MAJOR_M, y: 0, z: 0 });

    geodeticToEcef(0, Math.PI / 2, 0, out);
    expect(out.x).toBeCloseTo(0, 8);
    expect(out.y).toBe(WGS84_SEMI_MAJOR_M);
    expect(out.z).toBe(0);

    geodeticToEcef(Math.PI / 2, 2.4, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: WGS84_SEMI_MINOR_M });
    geodeticToEcef(-Math.PI / 2, -1.3, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: -WGS84_SEMI_MINOR_M });
  });

  it('round-trips both exact poles using the longitude-zero gauge', () => {
    for (const sign of [-1, 1]) {
      const ecef = geodeticToEcef(
        sign * Math.PI / 2,
        179.5 * DEG,
        123.45,
        vec3(),
      );
      const result = ecefToGeodetic(ecef, geodetic());
      expect(result.latitudeRad).toBe(sign * Math.PI / 2);
      expect(result.longitudeRad).toBe(0);
      expect(result.heightM).toBeCloseTo(123.45, 7);
    }
  });

  it('matches the published EPSG:9602 worked example', () => {
    const latitudeDeg = 53 + 48 / 60 + 33.82 / 3600;
    const longitudeDeg = 2 + 7 / 60 + 46.38 / 3600;
    const actual = geodeticToEcef(
      latitudeDeg * DEG,
      longitudeDeg * DEG,
      73,
      vec3(),
    );
    // EPSG example values are rounded to centimetres.
    expect(actual.x).toBeCloseTo(3771793.97, 2);
    expect(actual.y).toBeCloseTo(140253.34, 2);
    expect(actual.z).toBeCloseTo(5124304.35, 2);
  });

  const cases = [
    [0, 0, 0],
    [0, 180, 0],
    [-33.9, 151.9, 0],
    [89.999999, -73, 0],
    [-89.999999, 45, 0],
    [67.123456, 179.99999, 8848.86],
    [-52.4, -179.99999, -430],
    [12.5, 77.2, 100_000],
  ] as const;

  it.each(cases)(
    'round-trips lat=%s lon=%s h=%s',
    (latitudeDeg, longitudeDeg, heightM) => {
      const ecef = geodeticToEcef(
        latitudeDeg * DEG,
        longitudeDeg * DEG,
        heightM,
        vec3(),
      );
      const result = ecefToGeodetic(ecef, geodetic());
      expect(result.latitudeRad).toBeCloseTo(latitudeDeg * DEG, 11);
      expect(
        Math.abs(
          circularAngleDifferenceRad(
            result.longitudeRad,
            longitudeDeg * DEG,
          ),
        ),
      ).toBeLessThan(2e-11);
      expect(result.heightM).toBeCloseTo(heightM, 5);
    },
  );

  it('round-trips deterministic random global points within 10 micrometres', () => {
    let state = 0x51a7f00d;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };

    for (let index = 0; index < 500; index++) {
      // Uniform surface distribution in sin(latitude).
      const latitudeRad = Math.asin(2 * random() - 1);
      const longitudeRad = (2 * random() - 1) * Math.PI;
      const heightM = -500 + random() * 101_000;
      const original = geodeticToEcef(
        latitudeRad,
        longitudeRad,
        heightM,
        vec3(),
      );
      const derived = ecefToGeodetic(original, geodetic());
      const reconstructed = geodeticToEcef(
        derived.latitudeRad,
        derived.longitudeRad,
        derived.heightM,
        vec3(),
      );
      expect(distanceVec3(original, reconstructed)).toBeLessThan(1e-5);
    }
  });

  it('uses the ellipsoid gradient, not radial ECEF, for up', () => {
    const position = geodeticToEcef(45 * DEG, 20 * DEG, 0, vec3());
    const up = surfaceNormalEcef(position, vec3());
    const radial = vec3(
      position.x / Math.hypot(position.x, position.y, position.z),
      position.y / Math.hypot(position.x, position.y, position.z),
      position.z / Math.hypot(position.x, position.y, position.z),
    );
    expect(Math.acos(dotVec3(up, radial))).toBeGreaterThan(0.003);
    expect(Math.abs(ellipsoidEquationResidual(position))).toBeLessThan(5e-15);
  });

  it('constructs right-handed conventional bases including pole gauges', () => {
    const basis = createGeographicBasis();
    geographicBasisFromGeodetic(Math.PI / 2, 1.8, basis);
    expect(basis.east).toEqual({ x: 0, y: 1, z: 0 });
    expect(basis.north).toEqual({ x: -1, y: 0, z: 0 });
    expect(basis.up.x).toBeCloseTo(0, 15);
    expect(basis.up.y).toBe(0);
    expect(basis.up.z).toBe(1);
  });

  it('wraps longitude and signed zero only at the display boundary', () => {
    expect(wrapLongitudeRad(Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(-Math.PI)).toBe(-Math.PI);
    expect(Object.is(wrapLongitudeRad(-0), -0)).toBe(false);
  });

  it('rejects the ECEF origin and non-finite input', () => {
    expect(() => ecefToGeodetic(vec3(), geodetic())).toThrow();
    expect(() => geodeticToEcef(Number.NaN, 0, 0, vec3())).toThrow();
  });
});

function geodetic(): GeodeticCoordinates {
  return { latitudeRad: 0, longitudeRad: 0, heightM: 0 };
}
