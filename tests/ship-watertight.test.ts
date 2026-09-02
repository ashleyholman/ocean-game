import { describe, expect, it } from 'vitest';
import { buildShipSealSolids } from '../src/vessel/schooner/shipGeometry';

type Point = [number, number, number];

function pointKey(point: Point, scale = 100_000): string {
  return point.map((value) => Math.round(value * scale)).join(',');
}

describe('ship structural watertightness', () => {
  it('builds every structural component as a closed, consistently oriented two-manifold', () => {
    const solids = buildShipSealSolids();
    expect([...solids.keys()]).toEqual([
      'hull:quarterdeck',
      'hull:main',
      'hull:forecastle',
      'backbone',
      'rudder',
    ]);

    for (const [name, geometry] of solids) {
      const position = geometry.getAttribute('position');
      const index = geometry.getIndex();
      expect(index, `${name}: indexed geometry`).not.toBeNull();
      if (!index) continue;

      const edges = new Map<string, { count: number; direction: number }>();
      let degenerate = 0;
      let signedVolumeTimesSix = 0;
      for (let i = 0; i < index.count; i += 3) {
        const points = [0, 1, 2].map((offset) => {
          const vertex = index.getX(i + offset);
          return [
            position.getX(vertex),
            position.getY(vertex),
            position.getZ(vertex),
          ] as Point;
        });
        const [a, b, c] = points;
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cross = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ];
        if (Math.hypot(...cross) < 1e-8) {
          degenerate++;
          continue;
        }
        signedVolumeTimesSix +=
          a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0]);

        for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
          const p = pointKey(points[edgeIndex]);
          const q = pointKey(points[(edgeIndex + 1) % 3]);
          if (p === q) continue;
          const forward = p < q;
          const key = forward ? `${p}|${q}` : `${q}|${p}`;
          const edge = edges.get(key) ?? { count: 0, direction: 0 };
          edge.count++;
          edge.direction += forward ? 1 : -1;
          edges.set(key, edge);
        }
      }

      const boundaryEdges = [...edges].filter(([, edge]) => edge.count === 1);
      const nonManifoldEdges = [...edges].filter(([, edge]) => edge.count > 2);
      const sameDirectionEdges = [...edges].filter(
        ([, edge]) => edge.count === 2 && edge.direction !== 0,
      );
      expect(degenerate, `${name}: zero-area triangles`).toBe(0);
      expect(boundaryEdges, `${name}: open boundary edges`).toEqual([]);
      expect(nonManifoldEdges, `${name}: non-manifold edges`).toEqual([]);
      expect(sameDirectionEdges, `${name}: inconsistently directed shared edges`).toEqual([]);
      expect(Math.abs(signedVolumeTimesSix), `${name}: non-zero enclosed volume`).toBeGreaterThan(1e-4);
    }

    for (const geometry of solids.values()) geometry.dispose();
  });
});
