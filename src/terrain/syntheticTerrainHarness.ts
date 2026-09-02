import type * as THREE from 'three';
import type { CameraSystem } from '../camera/CameraSystem';
import type { GpuPassProfiler } from '../render/GpuProfiler';
import type { WorldRenderAdapter } from '../scene/WorldRenderAdapter';
import type { CanonicalWorldState } from '../world/types';
import { ecefToGeodetic, wrapLongitudeRad } from '../world/wgs84';
import {
  placedFixtureTiles,
  SYNTHETIC_FIXTURE_IDS,
  syntheticFixtureCentreRangeM,
  syntheticFixtureNearestLandFromOffsetM,
} from './syntheticFixtures';
import { OPENING_TRUE_HEADING_DEG } from '../world/openingVoyage';
import { metresPerRadian } from './terrainMath';
import { TerrainSystem } from './TerrainSystem';

export const SYNTHETIC_TERRAIN_RANGE_KM = { min: 1, max: 400 } as const;

/**
 * Standing off the hill, in two halves — because only one of them was ever a
 * real hazard, and the handover blamed the wrong one.
 *
 * TERRAIN_ROUND_HANDOVER records "camera-inside-fixture is unguarded" and points
 * at the note that `range` is vessel-to-fixture-CENTRE, so `range=6` with the
 * peak (island radius ~19.6 km) would put the eye inside the massif. That was
 * true when it was written and is not true now: `range` became nearest-land
 * distance (`syntheticFixtureCentreRangeM`), which solves the placement so that
 * NO above-water lattice sample is closer to the vessel than the requested
 * clearance, from any bearing. With the 1 km floor on `range` the mount cannot
 * put the eye inside a fixture at all, for any fixture, and
 * `tests/synthetic-terrain-harness.test.ts` now measures that rather than
 * trusting it.
 *
 * What is genuinely unguarded is the other half: the vessel SAILS. The fixture
 * is anchored at a lat/lon derived from the vessel's position at mount time and
 * the voyage then closes the distance, so an unattended session eventually
 * walks the camera into the hill. There is no grounding model, no collision and
 * no shoreline, so nothing in the simulation objects — the picture just fills
 * with rock from the inside.
 *
 * This is the clearance at which that is called out. It is a REPORT, not a
 * barrier: stopping the vessel would be inventing a grounding rule inside a
 * rendering harness, and running a capture right up to the beach is a
 * legitimate thing to want. Chosen at 500 m because it is half the closest
 * range the harness can be asked to mount, so the warning always precedes
 * contact by a wide margin at any sane voyage rate.
 */
export const SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M = 500;
export const SYNTHETIC_TERRAIN_HAZE_KM = { min: 0.5, max: 500 } as const;
export const SYNTHETIC_TERRAIN_DEFAULT_HAZE_KM = 150;
export const SYNTHETIC_TERRAIN_DEFAULT_RANGE_KM = 6;

/**
 * Land is production now, and its default placement is derived the same way
 * the opening voyage is: fine on the bow of the opening course rather than at
 * a written-down compass bearing, so if the ocean is re-aimed the landfall
 * follows. 20° to starboard keeps the approach an *approach* — the headland
 * grows ahead and drifts slowly aft — instead of the pure bow-on case where
 * no sideways slide is visible at all.
 */
export const SYNTHETIC_TERRAIN_DEFAULT_BEARING_OFF_BOW_DEG = 20;
export const SYNTHETIC_TERRAIN_DEFAULT_BEARING_DEG =
  OPENING_TRUE_HEADING_DEG + SYNTHETIC_TERRAIN_DEFAULT_BEARING_OFF_BOW_DEG;
const SYNTHETIC_TERRAIN_FAR_MARGIN_KM = 40;
const SYNTHETIC_TERRAIN_FAR_KM = { min: 25, max: 500 } as const;

/**
 * Camera-space far clipping is measured along the view axis, not as a radial
 * distance from the camera. Keep every synthetic fixture comfortably inside
 * it: the broad `peak` reaches about 29 km from its centre, and the remaining
 * margin covers its elevation and the vessel camera offset.
 */
export function requiredSyntheticTerrainFarKm(
  rangeKm: number,
  requestedFarKm?: number,
): number {
  return Math.max(
    rangeKm + SYNTHETIC_TERRAIN_FAR_MARGIN_KM,
    requestedFarKm ?? 0,
  );
}

/**
 * Live distance from a vessel to a placed fixture's nearest above-water land.
 *
 * Extracted from the mount so it can be measured on its own, because the value
 * it replaced could not be. The harness used to hold the offset the PLACEMENT
 * solver produced — centre range minus requested range, measured along one
 * bearing — and subtract that constant from the centre distance forever after.
 * Exact where the vessel was mounted, and increasingly wrong from anywhere
 * else: over the four fixtures and a 25 km walk in every direction the
 * constant over-reported the clearance by up to 5.07 km on `peak` and 2.88 km
 * on `low-coast`, always in the unsafe direction. See
 * `syntheticFixtureNearestLandFromOffsetM` for what consumes the number.
 *
 * The local tangent-plane conversion is deliberate: the fixtures span tens of
 * kilometres, the query is a rate policy rather than a navigation fix, and a
 * geodesic inverse per frame would buy centimetres nobody spends.
 */
export function syntheticTerrainNearestLandM(
  fixtureId: string,
  vessel: { latitudeRad: number; longitudeRad: number },
  anchor: { latitudeRad: number; longitudeRad: number },
): number {
  const { northMPerRad, eastMPerRad } = metresPerRadian(vessel.latitudeRad);
  // Vessel offset FROM the fixture centre, which is the anchor-minus-vessel
  // difference negated — the sign that decides whether an island is ahead of
  // you or astern.
  const northM = (vessel.latitudeRad - anchor.latitudeRad) * northMPerRad;
  const eastM =
    wrapLongitudeRad(vessel.longitudeRad - anchor.longitudeRad) * eastMPerRad;
  return syntheticFixtureNearestLandFromOffsetM(fixtureId, eastM, northM);
}

/**
 * `?terrain=synthetic` experimental harness (TERR-103/110/133, spec §6).
 *
 * Parses `fixture`, nearest-visible-land `range` (km), and `bearing` (degrees
 * clockwise from north) from the URL. It regenerates the chosen fixture far
 * enough along that bearing for the closest above-water sample to match the
 * requested range, then mounts a TerrainSystem. The active
 * camera's far plane follows `range` (including live slider
 * changes) so long-range terrain cannot be sliced by the normal 25 km camera
 * limit. Optional `far` (km) can request still more headroom; both behaviours
 * are harness-only and leave production camera limits untouched (TERR-110).
 * `haze` (km) sets TerrainSystem's extinction length (TERR-133). When the key
 * is explicitly present, the production transaction reapplies that terrain-
 * only diagnostic value after ordinary weather visibility; the ocean keeps
 * the weather-derived visibility. Everything is scoped to the returned handle;
 * production frames without the URL switch never construct any of it.
 */
export interface SyntheticTerrainMountDeps {
  scene: THREE.Scene;
  adapter: WorldRenderAdapter;
  state: Readonly<CanonicalWorldState>;
  cameras: CameraSystem;
  skyRadianceLut: THREE.Texture;
  /** Optional; carries the terrain GPU bucket's leading edge (TERR-134). */
  profiler?: GpuPassProfiler;
}

export interface SyntheticTerrainHandle {
  system: TerrainSystem;
  fixtureId: string;
  getRangeKm(): number;
  setRangeKm(rangeKm: number): void;
  getHazeDistanceKm(): number;
  setHazeDistanceKm(hazeDistanceKm: number): void;
  /**
   * Live distance from the vessel to the nearest above-water land, metres.
   *
   * Measured against the fixture's whole coastline at lattice resolution, from
   * wherever the vessel has got to, so it stays true once the voyage has left
   * the placement bearing. The voyage clock's governor and readouts consume
   * this — a rate policy, not a navigation instrument.
   */
  getNearestLandM(): number;
  /**
   * Is the vessel inside the clearance the mount guaranteed?
   *
   * False from the mount onward until the voyage closes the land to within
   * `SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M`. Nothing acts on it — see that
   * constant for why the harness reports rather than intervenes.
   */
  isInsideClearance(): boolean;
  /** Call at render time with current canonical state. */
  update(state: Readonly<CanonicalWorldState>): void;
}

export function mountSyntheticTerrain(
  params: URLSearchParams,
  deps: SyntheticTerrainMountDeps,
): SyntheticTerrainHandle {
  const { scene, adapter, state, cameras } = deps;
  const fixtureId = params.get('fixture') ?? 'headland';
  let rangeKm = clampNumber(
    params.get('range'),
    SYNTHETIC_TERRAIN_RANGE_KM.min,
    SYNTHETIC_TERRAIN_RANGE_KM.max,
    SYNTHETIC_TERRAIN_DEFAULT_RANGE_KM,
  );
  const bearingDeg = clampNumber(
    params.get('bearing'),
    -360,
    360,
    SYNTHETIC_TERRAIN_DEFAULT_BEARING_DEG,
  );
  const requestedFarKm = params.has('far')
    ? clampNumber(
        params.get('far'),
        SYNTHETIC_TERRAIN_FAR_KM.min,
        SYNTHETIC_TERRAIN_FAR_KM.max,
        SYNTHETIC_TERRAIN_FAR_KM.min,
      )
    : undefined;
  const hazeKm = clampNumber(
    params.get('haze'),
    SYNTHETIC_TERRAIN_HAZE_KM.min,
    SYNTHETIC_TERRAIN_HAZE_KM.max,
    SYNTHETIC_TERRAIN_DEFAULT_HAZE_KM,
  );
  let latestState = state;
  let centreRangeKm = rangeKm;
  let anchorLatRad = 0;
  let anchorLonRad = 0;
  let warnedInsideClearance = false;

  const system = new TerrainSystem(scene, adapter, {
    skyRadianceLut: deps.skyRadianceLut,
    hazeDistanceM: hazeKm * 1000,
    profiler: deps.profiler,
  });

  const placeAtRange = (nextRangeKm: number): void => {
    const vessel = ecefToGeodetic(latestState.positionEcefM, {
      latitudeRad: 0,
      longitudeRad: 0,
      heightM: 0,
    });
    const bearingRad = (bearingDeg * Math.PI) / 180;
    const centreRangeM = syntheticFixtureCentreRangeM(
      fixtureId,
      bearingRad,
      nextRangeKm * 1000,
    );
    centreRangeKm = centreRangeM / 1000;
    const northM = centreRangeM * Math.cos(bearingRad);
    const eastM = centreRangeM * Math.sin(bearingRad);
    const { northMPerRad, eastMPerRad } = metresPerRadian(vessel.latitudeRad);
    anchorLatRad = vessel.latitudeRad + northM / northMPerRad;
    anchorLonRad = wrapLongitudeRad(
      vessel.longitudeRad + eastM / eastMPerRad,
    );
    system.loadTiles(placedFixtureTiles(fixtureId, anchorLatRad, anchorLonRad));
  };

  const nearestLandM = (): number => {
    const vessel = ecefToGeodetic(latestState.positionEcefM, {
      latitudeRad: 0,
      longitudeRad: 0,
      heightM: 0,
    });
    return syntheticTerrainNearestLandM(
      fixtureId,
      vessel,
      { latitudeRad: anchorLatRad, longitudeRad: anchorLonRad },
    );
  };

  const ensureTerrainFarPlane = (nextRangeKm: number): void => {
    const requiredFarM =
      requiredSyntheticTerrainFarKm(nextRangeKm, requestedFarKm) * 1000;
    if (requiredFarM <= cameras.camera.far) return;
    cameras.camera.far = requiredFarM;
    cameras.camera.updateProjectionMatrix();
  };

  placeAtRange(rangeKm);
  ensureTerrainFarPlane(centreRangeKm);

  console.info(
    `[terrain] synthetic fixture '${fixtureId}' nearest land ${rangeKm} km` +
      ` (centre ${centreRangeKm.toFixed(2)} km), bearing ${bearingDeg}°` +
      ` · ${system.stats.tiles} tiles · ${system.stats.triangles.toLocaleString()} triangles` +
      ` · far ${(cameras.camera.far / 1000).toFixed(0)} km` +
      ` · fixtures: ${SYNTHETIC_FIXTURE_IDS.join(', ')}`,
  );

  return {
    system,
    fixtureId,
    getRangeKm: () => rangeKm,
    setRangeKm: (nextRangeKm) => {
      const next = clampNumber(
        String(nextRangeKm),
        SYNTHETIC_TERRAIN_RANGE_KM.min,
        SYNTHETIC_TERRAIN_RANGE_KM.max,
        rangeKm,
      );
      if (Math.abs(next - rangeKm) < 1e-6) return;
      rangeKm = next;
      placeAtRange(rangeKm);
      ensureTerrainFarPlane(centreRangeKm);
    },
    getNearestLandM: nearestLandM,
    isInsideClearance: () =>
      nearestLandM() < SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M,
    getHazeDistanceKm: () => system.hazeDistanceM / 1000,
    setHazeDistanceKm: (nextHazeDistanceKm) => {
      const next = clampNumber(
        String(nextHazeDistanceKm),
        SYNTHETIC_TERRAIN_HAZE_KM.min,
        SYNTHETIC_TERRAIN_HAZE_KM.max,
        system.hazeDistanceM / 1000,
      );
      system.setHazeDistance(next * 1000);
    },
    update: (current) => {
      latestState = current;
      system.update(current);
      // Edge-triggered both ways: a session that stands in and then off again
      // should say so once each time, not once per frame and not only once
      // ever. See SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M.
      const inside = nearestLandM() < SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M;
      if (inside !== warnedInsideClearance) {
        warnedInsideClearance = inside;
        if (inside) {
          console.warn(
            `[terrain] vessel is inside the ${SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M} m` +
              ` clearance of synthetic fixture '${fixtureId}'` +
              ` (${nearestLandM().toFixed(0)} m to land).` +
              ' There is no grounding model: keep closing and the camera ends' +
              ' up inside the hill.',
          );
        } else {
          console.info(
            `[terrain] vessel is clear of '${fixtureId}' again` +
              ` (${nearestLandM().toFixed(0)} m to land).`,
          );
        }
      }
    },
  };
}

function clampNumber(
  raw: string | null,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  // Number(null) is 0 — a finite value — so an ABSENT parameter must be
  // handled before conversion or every default silently becomes the clamp
  // minimum. This exact slip once set a 500 m haze distance and painted a
  // whole headland as pure sky.
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
