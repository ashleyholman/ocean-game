import { describe, expect, it } from 'vitest';
import {
  GeographicLibGeodesic,
  type DirectGeodesicResult,
} from '../src/world/geodesic';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import {
  circularAngleDifferenceRad,
  frameMaximumResidual,
  surfaceNormalEcef,
} from '../src/world/wgs84';
import {
  crossVec3,
  distanceVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  vec3,
} from '../src/world/math';
import { createNavigationTelemetry } from '../src/world/navigation';
import { deriveNavigationTelemetry } from '../src/world/navigation';

const DEG = Math.PI / 180;
const QUARTER_MERIDIAN_M = 10001965.729312722;

describe('GeographicLib isolation layer', () => {
  const backend = new GeographicLibGeodesic();

  it.each([
    [
      35.60777,
      -139.44815,
      111.098748429560326,
      8935244.5604818305,
      -11.17491,
      -69.95921,
      129.289270889708762,
    ],
    [
      55.52454,
      106.05087,
      22.020059880982801,
      4105086.1713924406,
      77.03196,
      197.18234,
      109.112041110671519,
    ],
    [
      -87.85331,
      85.66836,
      -65.120313040242748,
      17286615.3147144645,
      66.48646,
      16.09921,
      -4.888658719272296,
    ],
  ])(
    'matches an official Karney regression vector',
    (
      lat1Deg,
      lon1Deg,
      azi1Deg,
      distanceM,
      lat2Deg,
      lon2Deg,
      azi2Deg,
    ) => {
      const result = backend.direct(
        lat1Deg * DEG,
        lon1Deg * DEG,
        azi1Deg * DEG,
        distanceM,
        directResult(),
      );
      expect(result.latitude2Rad / DEG).toBeCloseTo(lat2Deg, 9);
      expect(result.longitude2Rad / DEG).toBeCloseTo(lon2Deg, 9);
      expect(result.forwardAzimuth2Rad / DEG).toBeCloseTo(azi2Deg, 9);
    },
  );

  it('crosses the antimeridian analytically along the equator', () => {
    const result = backend.direct(
      0,
      179.999 * DEG,
      90 * DEG,
      222.63898158654715,
      directResult(),
    );
    expect(result.latitude2Rad).toBeCloseTo(0, 13);
    expect(
      circularAngleDifferenceRad(result.longitude2Rad, -179.999 * DEG),
    ).toBeCloseTo(0, 12);
    expect(result.forwardAzimuth2Rad).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('canonical geodesic propagation and transport', () => {
  it('crosses the north pole without reflection or frame flip', () => {
    const world = makeWorld(89.999, 24, 0, 10);
    const before = { ...world.state.surfaceFrameEcef.right };
    world.advancePhysicsSeconds(40);
    const nav = deriveNavigationTelemetry(
      world.state,
      createNavigationTelemetry(),
    );

    expect(nav.latitudeRad / DEG).toBeLessThan(89.999);
    expect(
      Math.abs(circularAngleDifferenceRad(nav.longitudeRad, -156 * DEG)),
    ).toBeLessThan(2e-5);
    expect(lengthVec3(world.state.velocityEcefMps)).toBeCloseTo(10, 11);
    expect(frameMaximumResidual(world.state.surfaceFrameEcef)).toBeLessThan(
      5e-12,
    );
    expect(dotVec3(before, world.state.surfaceFrameEcef.right)).toBeGreaterThan(
      0.999999,
    );
  });

  it('crosses the south pole without reflection or frame flip', () => {
    const world = makeWorld(-89.999, -70, 180, 10);
    const before = { ...world.state.surfaceFrameEcef.right };
    world.advancePhysicsSeconds(40);
    const nav = deriveNavigationTelemetry(
      world.state,
      createNavigationTelemetry(),
    );
    expect(nav.latitudeRad / DEG).toBeGreaterThan(-89.999);
    expect(lengthVec3(world.state.velocityEcefMps)).toBeCloseTo(10, 11);
    expect(dotVec3(before, world.state.surfaceFrameEcef.right)).toBeGreaterThan(
      0.999999,
    );
  });

  it('agrees when an exact pole is an intermediate step', () => {
    const oneStep = makeWorld(0, 0, 0, 1);
    const splitAtPole = makeWorld(0, 0, 0, 1);

    oneStep.advancePhysicsSeconds(2 * QUARTER_MERIDIAN_M);
    splitAtPole.advancePhysicsSeconds(QUARTER_MERIDIAN_M);
    const atPole = deriveNavigationTelemetry(
      splitAtPole.state,
      createNavigationTelemetry(),
    );
    expect(atPole.latitudeRad / DEG).toBeCloseTo(90, 8);
    expect(atPole.trueCourseRad).toBeNull();
    splitAtPole.advancePhysicsSeconds(QUARTER_MERIDIAN_M);

    expect(
      distanceVec3(
        oneStep.state.positionEcefM,
        splitAtPole.state.positionEcefM,
      ),
    ).toBeLessThan(0.001);
    expect(
      distanceVec3(
        oneStep.state.surfaceFrameEcef.right,
        splitAtPole.state.surfaceFrameEcef.right,
      ),
    ).toBeLessThan(1e-9);
    expect(
      distanceVec3(
        oneStep.state.surfaceFrameEcef.forward,
        splitAtPole.state.surfaceFrameEcef.forward,
      ),
    ).toBeLessThan(1e-9);
  });

  it('also agrees when the exact south pole is an intermediate step', () => {
    const oneStep = makeWorld(0, 0, 180, 1);
    const splitAtPole = makeWorld(0, 0, 180, 1);

    oneStep.advancePhysicsSeconds(2 * QUARTER_MERIDIAN_M);
    splitAtPole.advancePhysicsSeconds(QUARTER_MERIDIAN_M);
    const atPole = deriveNavigationTelemetry(
      splitAtPole.state,
      createNavigationTelemetry(),
    );
    expect(atPole.latitudeRad / DEG).toBeCloseTo(-90, 8);
    expect(atPole.trueCourseRad).toBeNull();
    splitAtPole.advancePhysicsSeconds(QUARTER_MERIDIAN_M);

    expect(
      distanceVec3(
        oneStep.state.positionEcefM,
        splitAtPole.state.positionEcefM,
      ),
    ).toBeLessThan(0.001);
    expect(
      distanceVec3(
        oneStep.state.surfaceFrameEcef.right,
        splitAtPole.state.surfaceFrameEcef.right,
      ),
    ).toBeLessThan(1e-9);
    expect(
      distanceVec3(
        oneStep.state.velocityEcefMps,
        splitAtPole.state.velocityEcefMps,
      ),
    ).toBeLessThan(1e-9);
  });

  it('keeps ECEF and a non-ENU carried frame continuous at the antimeridian', () => {
    const world = makeWorld(20, 179.999, 90, 4);
    rotateFrameInTangentPlane(world, 37 * DEG);
    const beforePosition = { ...world.state.positionEcefM };
    const beforeRight = { ...world.state.surfaceFrameEcef.right };
    world.advancePhysicsSeconds(120);
    const nav = deriveNavigationTelemetry(
      world.state,
      createNavigationTelemetry(),
    );

    expect(nav.longitudeRad).toBeLessThan(0);
    expect(
      distanceVec3(beforePosition, world.state.positionEcefM),
    ).toBeLessThan(481);
    expect(dotVec3(beforeRight, world.state.surfaceFrameEcef.right)).toBeGreaterThan(
      0.99999999,
    );
  });

  it('crosses the antimeridian westward without a false displacement', () => {
    const world = makeWorld(-20, -179.999, 270, 4);
    const beforePosition = { ...world.state.positionEcefM };
    world.advancePhysicsSeconds(120);
    const nav = deriveNavigationTelemetry(
      world.state,
      createNavigationTelemetry(),
    );
    expect(nav.longitudeRad).toBeGreaterThan(0);
    expect(
      distanceVec3(beforePosition, world.state.positionEcefM),
    ).toBeLessThan(481);
    expect(lengthVec3(world.state.velocityEcefMps)).toBeCloseTo(4, 12);
  });

  it('is robust to one large step versus 1000 partitions', () => {
    const oneStep = makeWorld(-33.9, 151.9, 31.25, 7.25);
    const partitioned = makeWorld(-33.9, 151.9, 31.25, 7.25);
    rotateFrameInTangentPlane(oneStep, -52 * DEG);
    rotateFrameInTangentPlane(partitioned, -52 * DEG);
    const elapsedSeconds = 1_000_000;

    oneStep.advancePhysicsSeconds(elapsedSeconds);
    for (let index = 0; index < 1000; index++) {
      partitioned.advancePhysicsSeconds(elapsedSeconds / 1000);
    }

    expect(
      distanceVec3(oneStep.state.positionEcefM, partitioned.state.positionEcefM),
    ).toBeLessThan(0.001);
    expect(
      distanceVec3(
        oneStep.state.surfaceFrameEcef.right,
        partitioned.state.surfaceFrameEcef.right,
      ),
    ).toBeLessThan(1e-9);
    expect(
      distanceVec3(
        oneStep.state.velocityEcefMps,
        partitioned.state.velocityEcefMps,
      ),
    ).toBeLessThan(1e-9);
  });

  it('supports multiple full wraps without longitude accumulation state', () => {
    const world = makeWorld(0, 12, 90, 1);
    world.advancePhysicsSeconds(400751401.3557849);
    const nav = deriveNavigationTelemetry(
      world.state,
      createNavigationTelemetry(),
    );
    expect(nav.latitudeRad / DEG).toBeCloseTo(0, 10);
    expect(nav.longitudeRad / DEG).toBeCloseTo(12.011089702182455, 8);
    expect(nav.trueCourseRad! / DEG).toBeCloseTo(90, 10);
  });

  it('leaves a stationary position and frame exactly stable', () => {
    const world = makeWorld(70, -30, 80, 0);
    const before = world.createSnapshot();
    world.advancePhysicsSeconds(1_000_000);
    const after = world.createSnapshot();
    expect(after.positionEcefM).toEqual(before.positionEcefM);
    expect(after.surfaceFrameEcef).toEqual(before.surfaceFrameEcef);
    expect(after.velocityEcefMps).toEqual([0, 0, 0]);
  });

  it('preserves tangency and frame invariants over adversarial random paths', () => {
    let seed = 0xbadc0de;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let sample = 0; sample < 40; sample++) {
      const latitudeDeg = (Math.asin(2 * random() - 1) / DEG);
      const longitudeDeg = random() * 360 - 180;
      const world = makeWorld(
        latitudeDeg,
        longitudeDeg,
        random() * 360,
        0.05 + random() * 12,
      );
      rotateFrameInTangentPlane(world, (random() * 2 - 1) * Math.PI);
      for (let step = 0; step < 20; step++) {
        world.advancePhysicsSeconds(random() * 200_000);
        const up = surfaceNormalEcef(world.state.positionEcefM, vec3());
        const speed = lengthVec3(world.state.velocityEcefMps);
        expect(Math.abs(dotVec3(up, world.state.velocityEcefMps))).toBeLessThan(
          Math.max(1e-12, speed * 5e-11),
        );
        expect(frameMaximumResidual(world.state.surfaceFrameEcef)).toBeLessThan(
          2e-10,
        );
      }
    }
  });
});

function makeWorld(
  latitudeDeg: number,
  longitudeDeg: number,
  courseDeg: number,
  speedMps: number,
): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 0, 15) / 1000,
    latitudeRad: latitudeDeg * DEG,
    longitudeRad: longitudeDeg * DEG,
    initialCourseRad: courseDeg * DEG,
    initialSpeedMps: speedMps,
    worldSecondsPerRealSecond: 1,
    // These tests specify geodesic distance directly through speed × seconds;
    // production applies the separate 30× compressed voyage scale.
    voyageSecondsPerRealSecond: 1,
  });
}

function rotateFrameInTangentPlane(
  world: PlanetaryWorld,
  angleRad: number,
): void {
  const { right, forward, up } = world.state.surfaceFrameEcef;
  const oldRight = { ...right };
  const oldForward = { ...forward };
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  right.x = oldRight.x * cosine + oldForward.x * sine;
  right.y = oldRight.y * cosine + oldForward.y * sine;
  right.z = oldRight.z * cosine + oldForward.z * sine;
  crossVec3(forward, up, right);
  normalizeVec3(right, right);
  normalizeVec3(forward, forward);
  world.assertInvariants();
}

function directResult(): DirectGeodesicResult {
  return {
    latitude2Rad: 0,
    longitude2Rad: 0,
    forwardAzimuth2Rad: 0,
  };
}
