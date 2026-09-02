import { describe, expect, it } from 'vitest';
import {
  DESIGN_DRAUGHT,
  HALF_LENGTH,
  MAX_BEAM,
  bulwarkTopY,
  deckAtSideY,
  deckLevelRise,
  floorYAt,
  halfBreadthAt,
} from '../src/vessel/schooner/hullForm';
import {
  SHIP_REGIONS,
  buildShipGeometry,
  counterRakeShift,
} from '../src/vessel/schooner/shipGeometry';
import type { ShipRegion } from '../src/vessel/schooner/shipGeometry';
import { buildLoadedShip } from '../src/vessel/schooner/massModel';
import { hydrostaticsAt } from '../src/vessel/schooner/hydrostatics';
import { rudderBottomY } from '../src/vessel/schooner/backbone';

/**
 * M1 acceptance for everything that is not a matter of taste.
 *
 * The milestone's real gate — "she reads correctly from the cinematic camera" —
 * is Ash's eye and cannot live here. What can live here is everything that would
 * make his verdict meaningless: geometry that disagrees with the hydrostatic
 * model, faces wound inside out, or a hull that quietly blows the frame budget.
 */

const built = buildShipGeometry();

/** Every triangle of every region, as flat vertex data. */
function* triangles(): Generator<{
  region: ShipRegion;
  a: number[];
  b: number[];
  c: number[];
  normal: number[];
}> {
  for (const region of SHIP_REGIONS) {
    const geometry = built.geometries.get(region);
    if (!geometry) continue;
    const pos = geometry.getAttribute('position');
    const nrm = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    if (!index) continue;
    for (let i = 0; i < index.count; i += 3) {
      const ia = index.getX(i);
      const ib = index.getX(i + 1);
      const ic = index.getX(i + 2);
      yield {
        region,
        a: [pos.getX(ia), pos.getY(ia), pos.getZ(ia)],
        b: [pos.getX(ib), pos.getY(ib), pos.getZ(ib)],
        c: [pos.getX(ic), pos.getY(ic), pos.getZ(ic)],
        normal: [
          (nrm.getX(ia) + nrm.getX(ib) + nrm.getX(ic)) / 3,
          (nrm.getY(ia) + nrm.getY(ib) + nrm.getY(ic)) / 3,
          (nrm.getZ(ia) + nrm.getZ(ib) + nrm.getZ(ic)) / 3,
        ],
      };
    }
  }
}

function cross(u: number[], v: number[]): number[] {
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

describe('the lofted hull', () => {
  it('builds one draw call per paint region and stays inside the budget', () => {
    // `docs/ship/SHIP_ROUND_HANDOVER.md` section 5. The GPU-time third of that budget is
    // hand-measured in the browser; these two are the parts a test can hold.
    expect(built.geometries.size).toBeLessThanOrEqual(12);
    expect(built.triangleCount).toBeGreaterThan(2000);
    expect(built.triangleCount).toBeLessThan(200_000);
  });

  it('paints every region the spec asks for, and keeps the bottom separate', () => {
    // Section 16 requires the below-waterline finish to be its own material so
    // the choice between composition, dark coating and copper stays open.
    expect(built.geometries.has('belowWaterline')).toBe(true);
    expect(built.geometries.has('bootTop')).toBe(true);
    expect(built.geometries.has('topsides')).toBe(true);
    expect(built.geometries.has('wales')).toBe(true);
    expect(built.geometries.has('trim')).toBe(true);
    expect(built.geometries.has('deck')).toBe(true);
    expect(built.geometries.has('inboardBulwark')).toBe(true);
  });

  it('winds every face to agree with the normal it was given', () => {
    // The failure this catches is silent and total: mirror one patch with the
    // wrong winding and a whole side of the ship is invisible from outside and
    // solid from within. Collapsed loft rows are allowed as input, but the
    // builder must discard their zero-area faces before they reach the mesh.
    let checked = 0;
    let wrong = 0;
    let degenerate = 0;
    const wrongExamples: unknown[] = [];
    for (const t of triangles()) {
      const u = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]];
      const v = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
      const n = cross(u, v);
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-9) {
        degenerate++;
        continue;
      }
      const dot = (n[0] * t.normal[0] + n[1] * t.normal[1] + n[2] * t.normal[2]) / len;
      checked++;
      if (dot < 0) {
        wrong++;
        if (wrongExamples.length < 5) {
          wrongExamples.push({ region: t.region, a: t.a, b: t.b, c: t.c, normal: t.normal, dot });
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(degenerate).toBe(0);
    expect(wrong, JSON.stringify(wrongExamples, null, 2)).toBe(0);
  });

  it('stays inside the canonical dimensions', () => {
    let maxAbsX = 0;
    let maxY = -Infinity;
    let minY = Infinity;
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (const t of triangles()) {
      for (const p of [t.a, t.b, t.c]) {
        maxAbsX = Math.max(maxAbsX, Math.abs(p[0]));
        maxY = Math.max(maxY, p[1]);
        minY = Math.min(minY, p[1]);
        maxZ = Math.max(maxZ, p[2]);
        minZ = Math.min(minZ, p[2]);
      }
    }
    // Beam: the caprail overhangs the planking slightly, and nothing else may.
    expect(maxAbsX).toBeLessThanOrEqual(MAX_BEAM / 2 + 0.05);
    // The lowest timber is now the keel/rudder heel below the moulded baseline.
    expect(minY).toBeCloseTo(rudderBottomY(), 6);
    expect(minY).toBeLessThan(-0.4);
    // Nothing rises above the caprail — there is no rig at M1.
    expect(maxY).toBeLessThan(bulwarkTopY(-HALF_LENGTH) + 0.2);
    expect(maxZ).toBeCloseTo(HALF_LENGTH, 3);
    // The counter overhangs aft of the sternpost, and only aft of it.
    expect(minZ).toBeLessThan(-HALF_LENGTH);
    // 18 degrees of rake carried from the waterline to the taffrail overhangs
    // about 1.07 m: hull length overall is therefore ~16.6 m against the 15.5 m
    // stem-to-sternpost the spec fixes. Both are correct and they are different
    // measurements.
    expect(minZ).toBeGreaterThan(-HALF_LENGTH - 1.2);
  });
});

describe('the mesh and the hydrostatic model', () => {
  it('never moves a vertex the water can reach at rest', () => {
    // The transom's rake is a shear, and a shear on an immersed surface would
    // put the drawn hull and the displacement integral into exactly the
    // disagreement this round exists to prevent. It is keyed on height for that
    // reason: below the design waterline it must be identically zero, at every
    // station, including the ones under the counter.
    for (let i = 0; i <= 200; i++) {
      const z = -HALF_LENGTH + ((2 * HALF_LENGTH) * i) / 200;
      for (let j = 0; j <= 20; j++) {
        const y = (DESIGN_DRAUGHT * j) / 20;
        expect(counterRakeShift(z, y)).toBe(0);
      }
    }
  });

  it('lofts the shell from the offsets table itself', () => {
    // Spot-check that the drawn surface is the function the physics integrates,
    // not a lookalike: every immersed vertex must lie on `halfBreadthAt`.
    let immersed = 0;
    for (const t of triangles()) {
      if (t.region !== 'belowWaterline') continue;
      for (const p of [t.a, t.b, t.c]) {
        const [x, y, z] = p;
        if (y > DESIGN_DRAUGHT - 0.2 || Math.abs(z) > HALF_LENGTH - 0.1) continue;
        if (y <= floorYAt(z) + 1e-6) continue;
        const expected = halfBreadthAt(z, y);
        // The backbone is drawn as a slab of its own siding and is not on the
        // moulded surface; skip anything narrower than the planking there.
        if (Math.abs(x) < expected - 1e-6) continue;
        // Float32 vertex storage, so the tolerance is precision, not slack.
        expect(Math.abs(Math.abs(x) - expected)).toBeLessThan(1e-4);
        immersed++;
      }
    }
    expect(immersed).toBeGreaterThan(500);
  });

  it('floats at the M0 waterline with the bulwarks aboard', () => {
    // The bulwark mass item lands in the same commit as the bulwark geometry,
    // per the handover's M1 note. This is the assertion that keeps them together:
    // if someone draws more timber without weighing it, the ship stops closing
    // Archimedes at her design draught.
    const h = hydrostaticsAt(DESIGN_DRAUGHT);
    const { properties, ballast } = buildLoadedShip();
    expect(properties.mass).toBeCloseTo(h.displacement, 6);
    // 0.42, in from 0.38 with the platform deck's water cut — the argument and
    // the exact figure are in `ship-hydrostatics.test.ts`, which owns this band.
    expect(ballast.fraction).toBeGreaterThan(0.25);
    expect(ballast.fraction).toBeLessThan(0.42);
    const gm = h.km - properties.comY;
    expect(gm).toBeGreaterThan(0.55);
    expect(gm).toBeLessThan(0.85);
  });
});

describe('the deck', () => {
  it('carries three levels, and the mass model knows about all of them', () => {
    expect(deckLevelRise(-6)).toBeGreaterThan(0.5);
    expect(deckLevelRise(0)).toBe(0);
    expect(deckLevelRise(6)).toBeGreaterThan(0.15);

    const { items } = buildLoadedShip();
    const bulwark = items.filter((i) => i.name.startsWith('bulwark@'));
    expect(bulwark.length).toBeGreaterThan(30);
    const mass = bulwark.reduce((a, i) => a + i.mass, 0);
    // About a tonne of fence at roughly deck-plus-half-a-bulwark.
    expect(mass).toBeGreaterThan(700);
    expect(mass).toBeLessThan(1600);
    const meanY = bulwark.reduce((a, i) => a + i.mass * i.y, 0) / mass;
    expect(meanY).toBeGreaterThan(4);
    expect(meanY).toBeLessThan(5);
  });

  it('keeps the walking surface inside the bulwarks', () => {
    for (let i = 0; i <= 40; i++) {
      const z = -HALF_LENGTH + ((2 * HALF_LENGTH) * i) / 40;
      expect(bulwarkTopY(z)).toBeGreaterThan(deckAtSideY(z) + deckLevelRise(z));
      expect(halfBreadthAt(z, deckAtSideY(z))).toBeLessThanOrEqual(MAX_BEAM / 2 + 1e-9);
    }
  });
});
