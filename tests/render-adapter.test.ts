import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AstronomyProvider,
  applyMat3,
  createAstronomyFrame,
  eqjDirectionFromRaDec,
} from '../src/astronomy/AstronomyProvider';
import {
  BRIGHT_STAR_CATALOGUE,
  BRIGHT_STAR_CATALOGUE_METADATA,
} from '../src/astronomy/data/brightStars.generated';
import { limitingMagnitudeFromSunElevation } from '../src/scene/TimeOfDay';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import {
  crossVec3,
  distanceVec3,
  normalizeVec3,
  vec3,
} from '../src/world/math';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';

const DEG_TO_RAD = Math.PI / 180;

describe('explicit ECEF-to-render boundary', () => {
  it('maps initial east/up/north to Three +X/+Y/-Z', () => {
    const world = worldAt(0, 0);
    const frame = world.state.surfaceFrameEcef;
    const adapter = new WorldRenderAdapter();

    const east = adapter.ecefDirectionToThree(
      world.state,
      frame.right,
      newVector(),
    );
    const up = adapter.ecefDirectionToThree(
      world.state,
      frame.up,
      newVector(),
    );
    const north = adapter.ecefDirectionToThree(
      world.state,
      frame.forward,
      newVector(),
    );

    expect(east.toArray()).toEqual([1, 0, -0]);
    expect(up.toArray()).toEqual([0, 1, -0]);
    expect(north.toArray()).toEqual([0, 0, -1]);
  });

  it('rotates Sun and the whole catalogue through one shared matrix', () => {
    const world = worldAt(-33.9, 151.9);
    rotateCarriedFrame(world, 47 * DEG_TO_RAD);
    const astronomy = new AstronomyProvider();
    const astronomyFrame = astronomy.compute(
      world.state,
      createAstronomyFrame(),
    );
    const adapter = new WorldRenderAdapter();
    adapter.update(world.state, astronomyFrame);

    const sunProjectedDirectly = adapter.ecefDirectionToThree(
      world.state,
      astronomyFrame.sunDirectionEcef,
      newVector(),
    );
    expect(adapter.sunDirection.distanceTo(sunProjectedDirectly)).toBeLessThan(
      1e-13,
    );

    const starEqj = eqjDirectionFromRaDec(12.443311, -63.099092, vec3());
    const starEcef = applyMat3(
      astronomyFrame.eqjToEcef,
      starEqj,
      vec3(),
    );
    const directStar = adapter.ecefDirectionToThree(
      world.state,
      starEcef,
      newVector(),
    );
    const matrixStar = applyMat3(
      adapter.celestialToRender,
      starEqj,
      vec3(),
    );
    expect(
      distanceVec3(matrixStar, {
        x: directStar.x,
        y: directStar.y,
        z: directStar.z,
      }),
    ).toBeLessThan(2e-15);
  });

  it('does not confuse conventional azimuth with transported-frame azimuth', () => {
    const world = worldAt(-33.9, 151.9);
    rotateCarriedFrame(world, 90 * DEG_TO_RAD);
    const astronomyFrame = new AstronomyProvider().compute(
      world.state,
      createAstronomyFrame(),
    );
    const adapter = new WorldRenderAdapter();
    adapter.update(world.state, astronomyFrame);

    const conventionalAzimuth = astronomyFrame.sunHorizontal.azimuthRad!;
    const difference = circularDifference(
      adapter.sunSceneAzimuthRad,
      conventionalAzimuth,
    );
    expect(Math.abs(Math.abs(difference) - Math.PI / 2)).toBeLessThan(1e-12);
    expect(adapter.sunDirection.y).toBeCloseTo(
      Math.sin(astronomyFrame.sunHorizontal.elevationRad),
      12,
    );
  });

  it('keeps exact-pole render directions finite', () => {
    const world = worldAt(90, 179.9);
    const astronomyFrame = new AstronomyProvider().compute(
      world.state,
      createAstronomyFrame(),
    );
    const adapter = new WorldRenderAdapter();
    adapter.update(world.state, astronomyFrame);
    expect(astronomyFrame.sunHorizontal.azimuthRad).toBeNull();
    expect(adapter.sunDirection.toArray().every(Number.isFinite)).toBe(true);
    expect(
      [...adapter.celestialToRender].every(Number.isFinite),
    ).toBe(true);
  });
});

describe('packaged bright-star catalogue', () => {
  it('has documented provenance and a compact, valid magnitude-limited subset', () => {
    expect(BRIGHT_STAR_CATALOGUE.length).toBe(8920);
    expect(BRIGHT_STAR_CATALOGUE_METADATA.recordCount).toBe(
      BRIGHT_STAR_CATALOGUE.length,
    );
    expect(BRIGHT_STAR_CATALOGUE_METADATA.catalogueEpoch).toBe('J2000');
    expect(BRIGHT_STAR_CATALOGUE_METADATA.licence).toBe('CC BY-SA 4.0');
    expect(BRIGHT_STAR_CATALOGUE_METADATA.sourceSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    for (const [
      rightAscensionHours,
      declinationDeg,
      visualMagnitude,
    ] of BRIGHT_STAR_CATALOGUE) {
      expect(rightAscensionHours).toBeGreaterThanOrEqual(0);
      expect(rightAscensionHours).toBeLessThan(24);
      expect(declinationDeg).toBeGreaterThanOrEqual(-90);
      expect(declinationDeg).toBeLessThanOrEqual(90);
      expect(visualMagnitude).toBeLessThanOrEqual(6.5);
    }
  });

  it('reaches past the darkest sky the world can make', () => {
    // The catalogue's floor has to sit BELOW `TimeOfDay.limitingMagnitude` at
    // astronomical night, or no star is ever near the threshold and the whole
    // field renders comfortably visible — which is what a 4.5 cut did. See the
    // depth discussion in scripts/generate_bright_stars.py.
    const faintest = BRIGHT_STAR_CATALOGUE.reduce(
      (worst, record) => Math.max(worst, record[2]),
      -Infinity,
    );
    expect(faintest).toBeGreaterThan(
      limitingMagnitudeFromSunElevation(-18),
    );
  });

  it('contains Polaris and the five principal Southern Cross stars', () => {
    const labels = new Set(
      BRIGHT_STAR_CATALOGUE.map((record) => record[4]),
    );
    // `as const` narrows these to the catalogue's own label literals, so a
    // misspelling here is a type error rather than a test that quietly asserts
    // a name the catalogue never had.
    for (const label of [
      'Polaris',
      'Acrux',
      'Mimosa',
      'Gacrux',
      'Imai',
      'Ginan',
    ] as const) {
      expect(labels.has(label)).toBe(true);
    }
  });
});

function worldAt(
  latitudeDeg: number,
  longitudeDeg: number,
): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds:
      Date.parse('2025-01-15T10:00:00.000Z') / 1000,
    latitudeRad: latitudeDeg * DEG_TO_RAD,
    longitudeRad: longitudeDeg * DEG_TO_RAD,
    initialCourseRad: 68 * DEG_TO_RAD,
    initialSpeedMps: 0.5,
  });
}

function rotateCarriedFrame(
  world: PlanetaryWorld,
  angleRad: number,
): void {
  const frame = world.state.surfaceFrameEcef;
  const oldRight = { ...frame.right };
  const oldForward = { ...frame.forward };
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  frame.right.x = oldRight.x * cosine + oldForward.x * sine;
  frame.right.y = oldRight.y * cosine + oldForward.y * sine;
  frame.right.z = oldRight.z * cosine + oldForward.z * sine;
  crossVec3(frame.forward, frame.up, frame.right);
  normalizeVec3(frame.right, frame.right);
  normalizeVec3(frame.forward, frame.forward);
  world.assertInvariants();
}

function circularDifference(aRad: number, bRad: number): number {
  let difference = (aRad - bRad + Math.PI) % (2 * Math.PI);
  if (difference < 0) difference += 2 * Math.PI;
  return difference - Math.PI;
}

function newVector() {
  return new THREE.Vector3();
}
