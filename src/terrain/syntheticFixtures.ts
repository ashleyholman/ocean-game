import { vec3 } from '../world/math';
import {
  createGeographicBasis,
  geodeticToEcef,
  geographicBasisFromGeodetic,
} from '../world/wgs84';
import {
  assertTerrainTileGeometry,
  type TerrainTileGeometry,
  type TerrainTileSource,
} from './TerrainTile';
import { latticeCellGeodetic, metresPerRadian } from './terrainMath';

/**
 * Deterministic synthetic fixtures for the R1 spike (TERR-101), per
 * docs/terrain/terrain-r1-synthetic-spike-spec.md §3. Four analytic landforms in
 * open water south-west of Kangaroo Island, each continuing underwater to
 * −60 m so no fixture presents a vertical coastal wall.
 *
 * Determinism is load-bearing: heights are pure functions of integer lattice
 * coordinates through polynomial shaping and an integer-hash value noise —
 * no Math.sin/cos in the height path, no RNG state — so the same fixture is
 * bit-identical across runs, machines and JS engines, which is what lets
 * later checksum and shared-edge tests mean anything.
 */

const SEA_FLOOR_M = -60;
const EDGE_CELLS = 128;
/** Samples per tile edge (2^7 + 1). */
const TILE_SAMPLES = EDGE_CELLS + 1;

/**
 * Width of the drowned rim every fixture ends in (TERR-130).
 *
 * A heightfield is a finite sheet, and where the sheet ends above water the
 * land simply stops: a vertical face down to nothing, with sky behind it. That
 * is the "open gap" half of TERR-130 and it is a different failure from the
 * "vertical coastal wall" half — the coastline can shelve perfectly and the
 * FOOTPRINT still end in mid-air. `low-coast` did exactly that: 354 samples of
 * its outer lattice ring stood up to 11.6 m above the sea because its dune
 * field ran east off the edge of the fixture.
 *
 * 700 m takes 12 m of dune down to the −60 m floor at about 6°, which is
 * shallower than the fixture's own shore. Fixtures that already reach the
 * floor before their boundary are unchanged by the blend, so this is only
 * paid where it is needed.
 */
const FIXTURE_RIM_MARGIN_M = 700;

/**
 * Blend a height toward the sea floor across the fixture's outer margin.
 *
 * Applied inside a fixture's own height function rather than generically in
 * the tile builder, because `landSampleOffsets` and the placement solver call
 * `spec.height` directly — a taper the builder applied and the solver did not
 * would put the coastline in two different places.
 */
function drownRim(
  heightM: number,
  uM: number,
  vM: number,
  halfWidthM: number,
  halfHeightM: number,
): number {
  const rim =
    smoothstep(0, FIXTURE_RIM_MARGIN_M, halfWidthM - Math.abs(uM)) *
    smoothstep(0, FIXTURE_RIM_MARGIN_M, halfHeightM - Math.abs(vM));
  return SEA_FLOOR_M + (heightM - SEA_FLOOR_M) * rim;
}

interface FixtureSpec {
  id: string;
  /** Fixture-centre anchor; lattice origin sits at the centre sample. */
  latitudeDeg: number;
  longitudeDeg: number;
  spacingM: number;
  tilesX: number;
  tilesY: number;
  /** Height in metres at metric offset (uM east, vM north) from centre. */
  height(uM: number, vM: number): number;
}

// --- deterministic noise ----------------------------------------------------

/** Integer avalanche hash to [0, 1). Exact integer ops; engine-portable. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise on a metric lattice, smoothstep-weighted, in [0, 1). */
function valueNoise(uM: number, vM: number, cellM: number, seed: number): number {
  const x = uM / cellM;
  const y = vM / cellM;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const wx = fx * fx * (3 - 2 * fx);
  const wy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * wx + (c - a) * wy + (a - b - c + d) * wx * wy;
}

/** Two-octave ridge noise in [0, 1]; sharp crests, soft valleys. */
function ridgeNoise(uM: number, vM: number, cellM: number, seed: number): number {
  const n1 = 1 - Math.abs(2 * valueNoise(uM, vM, cellM, seed) - 1);
  const n2 = 1 - Math.abs(2 * valueNoise(uM, vM, cellM / 2.3, seed ^ 0x9e3779b9) - 1);
  return 0.7 * n1 + 0.3 * n2;
}

// --- the four fixtures ------------------------------------------------------

const FIXTURES: readonly FixtureSpec[] = [
  {
    // Shelving shore running north-south; sea west, dune field east.
    id: 'low-coast',
    latitudeDeg: -36.3,
    longitudeDeg: 136.2,
    spacingM: 31.25,
    tilesX: 2,
    tilesY: 1,
    height(uM, vM) {
      const shore = smoothstep(-3000, 1200, uM);
      const base = SEA_FLOOR_M + shore * (4 - SEA_FLOOR_M);
      const dunes =
        8 *
        ridgeNoise(uM, vM, 420, 0x10c0a57) *
        smoothstep(200, 1400, uM);
      // The only fixture whose land reached its own footprint boundary; the
      // rim turns a clipped plane into a low island. See FIXTURE_RIM_MARGIN_M.
      return drownRim(base + dunes, uM, vM, 4000, 2000);
    },
  },
  {
    // North-south ridge falling to a west-facing cliff coast.
    id: 'headland',
    latitudeDeg: -36.5,
    longitudeDeg: 136.6,
    spacingM: 31.25,
    tilesX: 1,
    tilesY: 1,
    height(uM, vM) {
      const along = smoothstep(-1900, -600, vM) * (1 - smoothstep(600, 1900, vM));
      const crest = 100 * along;
      // West of the crest the land ends in a cliff; eastward it tails off
      // gently into the sea, so the same fixture shows both coast types.
      const west = smoothstep(-1150, -780, uM);
      const east = 1 - smoothstep(-350, 1750, uM);
      const shape = west * east;
      const land = crest * shape;
      const submerged = SEA_FLOOR_M * (1 - smoothstep(0.02, 0.12, shape * along));
      return land + submerged;
    },
  },
  {
    // 500 m cone with two shoulder ridges and a shelving skirt.
    id: 'mountain',
    latitudeDeg: -36.8,
    longitudeDeg: 137.0,
    spacingM: 31.25,
    tilesX: 3,
    tilesY: 3,
    height(uM, vM) {
      const r = Math.hypot(uM, vM);
      const cone = 500 * Math.max(0, 1 - r / 4500);
      // Fixed unit directions instead of angles: no trig in the height path.
      const p1 = Math.max(0, (uM * 0.8 + vM * 0.6) / Math.max(r, 1));
      const p2 = Math.max(0, (-uM * 0.6 + vM * 0.8) / Math.max(r, 1));
      const shoulder =
        (p1 ** 6 + p2 ** 6) *
        120 *
        smoothstep(400, 1400, r) *
        (1 - smoothstep(2600, 4200, r));
      const skirt = SEA_FLOOR_M * smoothstep(4500, 5600, r);
      return cone + shoulder + skirt;
    },
  },
  {
    // 3,000 m massif on a broad elliptical base; the long-range depth and
    // cloud-occlusion subject.
    id: 'peak',
    latitudeDeg: -37.2,
    longitudeDeg: 137.6,
    spacingM: 125,
    tilesX: 3,
    tilesY: 2,
    height(uM, vM) {
      const rE = Math.hypot(uM / 1.4, vM);
      const s = 1 - smoothstep(0, 14000, rE);
      const relief = 0.8 + 0.2 * ridgeNoise(uM, vM, 3600, 0x5eed);
      const massif = 3000 * s * s * relief;
      const skirt = SEA_FLOOR_M * smoothstep(14000, 16500, rE);
      return massif + skirt;
    },
  },
];

// --- tile generation --------------------------------------------------------

function buildFixtureTiles(
  spec: FixtureSpec,
  originOverride?: { latitudeRad: number; longitudeRad: number },
): TerrainTileGeometry[] {
  const originLatRad =
    originOverride?.latitudeRad ?? (spec.latitudeDeg * Math.PI) / 180;
  const originLonRad =
    originOverride?.longitudeRad ?? (spec.longitudeDeg * Math.PI) / 180;
  const { northMPerRad, eastMPerRad } = metresPerRadian(originLatRad);
  const latticeLatStepRad = spec.spacingM / northMPerRad;
  const latticeLonStepRad = spec.spacingM / eastMPerRad;
  // The lattice origin is the fixture centre, so metric offsets used by the
  // height functions are exact multiples of spacing: cell * spacing.
  const centreCellX = (spec.tilesX * EDGE_CELLS) / 2;
  const centreCellY = (spec.tilesY * EDGE_CELLS) / 2;

  const lattice = {
    latticeOriginGeodetic: {
      latitudeRad: originLatRad,
      longitudeRad: originLonRad,
    },
    latticeLatStepRad,
    latticeLonStepRad,
  };

  const tiles: TerrainTileGeometry[] = [];
  for (let ty = 0; ty < spec.tilesY; ty++) {
    for (let tx = 0; tx < spec.tilesX; tx++) {
      const cellOriginX = tx * EDGE_CELLS - centreCellX;
      const cellOriginY = ty * EDGE_CELLS - centreCellY;

      const heightsM = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
      let minHeightM = Infinity;
      let maxHeightM = -Infinity;
      let landSamples = 0;
      for (let j = 0; j < TILE_SAMPLES; j++) {
        for (let i = 0; i < TILE_SAMPLES; i++) {
          // Metric coordinates from integer cells — the identical doubles on
          // both sides of a shared edge, which is the whole determinism story.
          const uM = (cellOriginX + i) * spec.spacingM;
          const vM = (cellOriginY + j) * spec.spacingM;
          const h = Math.fround(spec.height(uM, vM));
          heightsM[j * TILE_SAMPLES + i] = h;
          if (h < minHeightM) minHeightM = h;
          if (h > maxHeightM) maxHeightM = h;
          if (h > 0) landSamples += 1;
        }
      }

      const centreGeodetic = latticeCellGeodetic(
        lattice,
        cellOriginX + EDGE_CELLS / 2,
        cellOriginY + EDGE_CELLS / 2,
      );
      const anchorEcef = geodeticToEcef(
        centreGeodetic.latitudeRad,
        centreGeodetic.longitudeRad,
        0,
        vec3(),
      );
      const basisEcef = geographicBasisFromGeodetic(
        centreGeodetic.latitudeRad,
        centreGeodetic.longitudeRad,
        createGeographicBasis(),
      );

      const tile: TerrainTileGeometry = {
        key: `synthetic/${spec.id}/${tx}/${ty}`,
        anchorGeodetic: centreGeodetic,
        anchorEcef,
        basisEcef,
        ...lattice,
        cellOriginX,
        cellOriginY,
        spacingM: spec.spacingM,
        samples: TILE_SAMPLES,
        heightsM,
        minHeightM,
        maxHeightM,
        geometricErrorM: 0,
        landFraction: landSamples / heightsM.length,
      };
      assertTerrainTileGeometry(tile);
      tiles.push(tile);
    }
  }
  return tiles;
}

export const SYNTHETIC_FIXTURE_IDS = FIXTURES.map((f) => f.id);

function findSpec(fixtureId: string): FixtureSpec {
  const spec = FIXTURES.find((f) => f.id === fixtureId);
  if (!spec) {
    throw new Error(
      `Unknown synthetic fixture '${fixtureId}'; known: ${SYNTHETIC_FIXTURE_IDS.join(', ')}`,
    );
  }
  return spec;
}

const LAND_SAMPLE_OFFSETS_BY_FIXTURE = new Map<string, Float64Array>();

/** Unique above-water lattice samples as interleaved east/north metre pairs. */
function landSampleOffsets(spec: FixtureSpec): Float64Array {
  const cached = LAND_SAMPLE_OFFSETS_BY_FIXTURE.get(spec.id);
  if (cached) return cached;

  const cellsX = spec.tilesX * EDGE_CELLS;
  const cellsY = spec.tilesY * EDGE_CELLS;
  const centreCellX = cellsX / 2;
  const centreCellY = cellsY / 2;
  const offsets: number[] = [];
  for (let y = 0; y <= cellsY; y++) {
    const northM = (y - centreCellY) * spec.spacingM;
    for (let x = 0; x <= cellsX; x++) {
      const eastM = (x - centreCellX) * spec.spacingM;
      if (Math.fround(spec.height(eastM, northM)) <= 0) continue;
      offsets.push(eastM, northM);
    }
  }

  const result = new Float64Array(offsets);
  LAND_SAMPLE_OFFSETS_BY_FIXTURE.set(spec.id, result);
  return result;
}

const COAST_SAMPLE_OFFSETS_BY_FIXTURE = new Map<string, Float64Array>();

/**
 * The coastline only: above-water samples with at least one submerged
 * four-neighbour, as interleaved east/north metre pairs.
 *
 * Why a separate set. The nearest land to a vessel at sea is always ON the
 * coast — the straight line to any inland sample crosses the shore first — so
 * a distance query never has to look at the interior. That matters because
 * the interior is most of the fixture: `peak` carries about 30,000 above-water
 * samples and only about 1,100 coastal ones, and the difference decides
 * whether an exact query can run every frame or not.
 */
function coastSampleOffsets(spec: FixtureSpec): Float64Array {
  const cached = COAST_SAMPLE_OFFSETS_BY_FIXTURE.get(spec.id);
  if (cached) return cached;

  const cellsX = spec.tilesX * EDGE_CELLS;
  const cellsY = spec.tilesY * EDGE_CELLS;
  const centreCellX = cellsX / 2;
  const centreCellY = cellsY / 2;
  const heightAt = (x: number, y: number): number =>
    Math.fround(
      spec.height((x - centreCellX) * spec.spacingM, (y - centreCellY) * spec.spacingM),
    );

  const offsets: number[] = [];
  for (let y = 0; y <= cellsY; y++) {
    for (let x = 0; x <= cellsX; x++) {
      if (heightAt(x, y) <= 0) continue;
      // A footprint-edge sample counts as coast: there is nothing beyond it,
      // so it bounds the land whether or not the sheet drowns there.
      const exposed =
        x === 0 ||
        y === 0 ||
        x === cellsX ||
        y === cellsY ||
        heightAt(x - 1, y) <= 0 ||
        heightAt(x + 1, y) <= 0 ||
        heightAt(x, y - 1) <= 0 ||
        heightAt(x, y + 1) <= 0;
      if (!exposed) continue;
      offsets.push((x - centreCellX) * spec.spacingM, (y - centreCellY) * spec.spacingM);
    }
  }

  const result = new Float64Array(offsets);
  COAST_SAMPLE_OFFSETS_BY_FIXTURE.set(spec.id, result);
  return result;
}

/** Coastal sample count; the cost of one `…NearestLandFromOffsetM` query. */
export function syntheticFixtureCoastSampleCount(fixtureId: string): number {
  return coastSampleOffsets(findSpec(fixtureId)).length / 2;
}

/**
 * Horizontal distance from a vessel to the nearest above-water sample, where
 * the vessel stands `eastM`/`northM` from the fixture centre.
 *
 * This is the live-readout form, and it exists because the harness used to
 * answer the question with a constant. A fixture is placed by solving for a
 * clearance along ONE bearing, and the offset that solve produced — centre
 * range minus requested range — was then subtracted from the centre distance
 * for the rest of the session. That is exact while the vessel sits on the
 * placement axis and wrong as soon as it sails: measured over the four
 * fixtures and a 25 km walk in every direction, the constant OVER-reported
 * the clearance by up to 5.07 km on `peak` and 2.88 km on `low-coast`, always
 * in the unsafe direction. The voyage governor divides by this number
 * (`rate = ω_max·d/v`), so a peak reported at 10 km when it is at 5 km buys
 * twice the compression the slide budget allows, and the 500 m contact
 * warning arrives late or not at all.
 *
 * Exact over the coastline at lattice resolution, from any direction — the
 * nearest land sample to a point at sea always has a submerged neighbour,
 * because a step toward the vessel from any fully-surrounded sample would be
 * land and nearer. Zero means the vessel is standing on land, which is tested
 * directly rather than inferred from the coast set: the middle of an island is
 * far from every shore.
 */
export function syntheticFixtureNearestLandFromOffsetM(
  fixtureId: string,
  eastM: number,
  northM: number,
): number {
  const spec = findSpec(fixtureId);
  if (Math.fround(spec.height(eastM, northM)) > 0) return 0;
  const offsets = coastSampleOffsets(spec);
  let nearestSquaredM = Infinity;
  for (let i = 0; i < offsets.length; i += 2) {
    const dx = offsets[i] - eastM;
    const dy = offsets[i + 1] - northM;
    const squared = dx * dx + dy * dy;
    if (squared < nearestSquaredM) nearestSquaredM = squared;
  }
  return Math.sqrt(nearestSquaredM);
}

/**
 * Centre range needed to put the nearest above-water fixture sample at the
 * requested horizontal distance from the vessel.
 *
 * The vessel-to-centre bearing defines a ray through the fixture. Around each
 * land sample, imagine a circle whose radius is the requested clearance. The
 * outermost intersection of those circles with the ray is the first centre
 * position at which no land sample is closer than that clearance. This makes
 * `range=1` mean one kilometre to land rather than one kilometre to the middle
 * of a mountain that may itself be tens of kilometres wide.
 */
export function syntheticFixtureCentreRangeM(
  fixtureId: string,
  bearingRad: number,
  nearestLandRangeM: number,
): number {
  if (!Number.isFinite(nearestLandRangeM) || nearestLandRangeM <= 0) {
    throw new RangeError('nearestLandRangeM must be positive and finite');
  }

  const offsets = landSampleOffsets(findSpec(fixtureId));
  const eastDirection = Math.sin(bearingRad);
  const northDirection = Math.cos(bearingRad);
  let centreRangeM = -Infinity;

  for (let i = 0; i < offsets.length; i += 2) {
    const eastM = offsets[i];
    const northM = offsets[i + 1];
    const alongM = eastM * eastDirection + northM * northDirection;
    const acrossM = eastM * northDirection - northM * eastDirection;
    if (Math.abs(acrossM) > nearestLandRangeM) continue;

    const radialM = Math.sqrt(
      Math.max(
        0,
        nearestLandRangeM * nearestLandRangeM - acrossM * acrossM,
      ),
    );
    centreRangeM = Math.max(centreRangeM, -alongM + radialM);
  }

  if (!Number.isFinite(centreRangeM)) {
    throw new Error(
      `Fixture '${fixtureId}' has no land within ${nearestLandRangeM} m of its bearing axis`,
    );
  }
  return centreRangeM;
}

/**
 * What a placement actually delivered: the horizontal distance from the vessel
 * to the NEAREST above-water sample of a fixture whose centre sits
 * `centreRangeM` along `bearingRad`.
 *
 * The exact inverse of `syntheticFixtureCentreRangeM`, and it exists because
 * "the camera cannot end up inside the hill" is a claim about geometry that
 * should be measured rather than argued. The solver above promises a clearance;
 * this reads back what the promise is worth, over every land sample and not
 * only the ones on the bearing axis. Zero means the vessel is standing on land.
 */
export function syntheticFixtureNearestLandM(
  fixtureId: string,
  bearingRad: number,
  centreRangeM: number,
): number {
  const offsets = landSampleOffsets(findSpec(fixtureId));
  const centreEastM = centreRangeM * Math.sin(bearingRad);
  const centreNorthM = centreRangeM * Math.cos(bearingRad);
  let nearestM = Infinity;
  for (let i = 0; i < offsets.length; i += 2) {
    nearestM = Math.min(
      nearestM,
      Math.hypot(centreEastM + offsets[i], centreNorthM + offsets[i + 1]),
    );
  }
  return nearestM;
}

export const syntheticTileSource: TerrainTileSource = {
  tilesFor(fixtureId: string): TerrainTileGeometry[] {
    return buildFixtureTiles(findSpec(fixtureId));
  },
};

/**
 * The same fixture regenerated around an arbitrary anchor. The R1 harness
 * uses this to park a fixture at a chosen range and bearing from wherever
 * the vessel actually is, instead of teleporting the vessel; buoyancy and
 * voyage state stay production (spec §6).
 */
export function placedFixtureTiles(
  fixtureId: string,
  latitudeRad: number,
  longitudeRad: number,
): TerrainTileGeometry[] {
  return buildFixtureTiles(findSpec(fixtureId), { latitudeRad, longitudeRad });
}
