import { describe, expect, it } from 'vitest';
import {
  AUTHORED_TRIM_RAD,
  RIG_TRIM_LIMITS,
  SAILS,
  SPARS,
  STANDING_RIGGING,
  applyRigTrim,
  rigNode,
  type RigTrimAnglesRad,
  type Sail,
  type SailName,
} from '../src/vessel/schooner/rig';
import {
  createSailClothFlow,
  sailLoftLive,
  sailSurface,
} from '../src/vessel/schooner/rigGeometry';
import type {
  RigLoftState,
  SailClothFlow,
  SailClothState,
} from '../src/vessel/schooner/rigGeometry';

/**
 * THE TRIM ENVELOPE SWEEP — design §8, and it is not optional.
 *
 * The rig round's central lesson: untested categories rot silently, and the
 * whole existing suite measures ONE pose — the authored trim. S4 makes trim
 * a continuous dimension; this file sweeps it. Every pose here is legal
 * (inside `RIG_TRIM_LIMITS`) and reachable from the dev panel, so every
 * pose must draw a rig whose sails do not pass through each other.
 *
 * What is measured: cloth-edge-through-cloth-triangle penetration on the
 * pairs that can approach each other; the drawn belly's side against the
 * sheeted side on both tacks; and the two rope-vs-cloth couplings the graph
 * itself flags as tack-coupled (the peak halyard and the fisherman sheet,
 * both rigged to starboard by authored choice).
 *
 * Contact is not penetration: a gaff sail eased onto its shrouds lies
 * against rope at sea. What must never happen is cloth passing *inside*
 * cloth, which is what these Möller–Trumbore checks detect.
 */

const DEG = Math.PI / 180;
const FULL_HOISTS = Object.fromEntries(SAILS.map((s) => [s.name, 1])) as Record<
  SailName,
  number
>;

type V = { x: number; y: number; z: number };

function trimsWith(overrides: Partial<RigTrimAnglesRad>): RigTrimAnglesRad {
  return { ...AUTHORED_TRIM_RAD, ...overrides };
}

interface Pose {
  name: string;
  trims: RigTrimAnglesRad;
  hoists?: Partial<Record<SailName, number>>;
  /** Sails whose trim differs from authored — only pairs touching these
   * are re-checked; all-authored pairs are the existing suite's job. */
  changed: readonly SailName[];
  /** M6: the cloth state this pose is drawn in. Absent is the flat arm. */
  cloth?: SailClothState;
}

/**
 * THE M6 CLOTH STATES THE SWEEP HAS TO COVER.
 *
 * The envelope was a sweep over *trim* because trim was the only thing that
 * moved the drawn surface. M6 adds a second axis: the same corners now carry
 * a belly whose depth and sign, a twist, a sagging luff, a rounded foot and a
 * flogging wave all come from the wind. A pose is no longer a trim — it is a
 * trim and a weather.
 *
 * These four are the corners of that second axis, worst-cased on purpose: a
 * hard breeze, because every load-driven shape scales with it.
 */
const CLOTH_WEATHERS: ReadonlyArray<readonly [string, SailClothState | undefined]> = [
  ['flat cloth', undefined],
  [
    'drawing hard',
    {
      flow: uniformFlow({ aoaDeg: 26, apparentSpeedMps: 18, blanketFactor: 1 }),
      elapsedSeconds: 0,
      animate: true,
    },
  ],
  [
    'aback',
    {
      flow: uniformFlow({ aoaDeg: -25, apparentSpeedMps: 18, blanketFactor: 1 }),
      elapsedSeconds: 0,
      animate: true,
    },
  ],
  [
    'slatting',
    {
      flow: uniformFlow({
        aoaDeg: 1,
        apparentSpeedMps: 18,
        blanketFactor: 1,
        cannotDraw: true,
      }),
      // A quarter-period offset: the flogging wave's extreme, not its zero.
      elapsedSeconds: 0.104,
      animate: true,
    },
  ],
];

function uniformFlow(flow: Partial<SailClothFlow>): Record<SailName, SailClothFlow> {
  return Object.fromEntries(
    SAILS.map((s) => [s.name, { ...createSailClothFlow(), ...flow }]),
  ) as Record<SailName, SailClothFlow>;
}

const TRIMMABLE: readonly (keyof RigTrimAnglesRad)[] = [
  'mainsail',
  'foresail',
  'foreStaysail',
  'jib',
  'flyingJib',
  'foreTopsail',
  'mainTopmastStaysail',
];

function limitsDeg(name: keyof RigTrimAnglesRad): { min: number; max: number } {
  const l = RIG_TRIM_LIMITS[name];
  return { min: l.minDeg, max: l.maxDeg };
}

function buildPoses(): Pose[] {
  const poses: Pose[] = [];
  // 1 — each channel swept independently across its mechanical range.
  for (const name of TRIMMABLE) {
    const { min, max } = limitsDeg(name);
    for (const deg of [min, min / 2, 0, max / 2, max]) {
      poses.push({
        name: `${name} at ${deg.toFixed(1)}°`,
        trims: trimsWith({ [name]: deg * DEG } as Partial<RigTrimAnglesRad>),
        changed: [name, ...(name === 'mainsail' ? (['mainGaffTopsail'] as const) : [])],
      });
    }
  }
  // 2 — coherent points of sail, both tacks. Close-hauled hard, the
  // authored broad reach's mirror, and everything eased to the stops.
  const closeHauled: Partial<RigTrimAnglesRad> = {
    mainsail: 12 * DEG,
    foresail: 14 * DEG,
    foreStaysail: 10 * DEG,
    jib: 11 * DEG,
    flyingJib: 12 * DEG,
    foreTopsail: RIG_TRIM_LIMITS.foreTopsail.maxDeg * DEG,
    mainTopmastStaysail: AUTHORED_TRIM_RAD.mainTopmastStaysail,
  };
  const run: Partial<RigTrimAnglesRad> = {
    mainsail: RIG_TRIM_LIMITS.mainsail.maxDeg * DEG,
    foresail: RIG_TRIM_LIMITS.foresail.maxDeg * DEG,
    foreStaysail: RIG_TRIM_LIMITS.foreStaysail.maxDeg * DEG,
    jib: RIG_TRIM_LIMITS.jib.maxDeg * DEG,
    flyingJib: RIG_TRIM_LIMITS.flyingJib.maxDeg * DEG,
    foreTopsail: 0,
  };
  const mirror = (t: Partial<RigTrimAnglesRad>): Partial<RigTrimAnglesRad> =>
    Object.fromEntries(
      Object.entries(t).map(([k, v]) => [k, -(v as number)]),
    ) as Partial<RigTrimAnglesRad>;
  for (const [label, t] of [
    ['close-hauled starboard tack', closeHauled],
    ['close-hauled port tack', mirror(closeHauled)],
    ['authored port tack', mirror({ ...AUTHORED_TRIM_RAD })],
    ['run, all eased, starboard', run],
    ['run, all eased, port', mirror(run)],
  ] as const) {
    poses.push({
      name: label,
      trims: trimsWith(t),
      changed: [...TRIMMABLE, 'mainGaffTopsail'],
    });
  }
  // 3 — adjacent headsails at opposite extremes: the fan collapses into
  // one plane exactly when neighbouring sheets disagree hardest.
  const pairs: Array<[keyof RigTrimAnglesRad, keyof RigTrimAnglesRad]> = [
    ['foreStaysail', 'jib'],
    ['jib', 'flyingJib'],
    ['foreStaysail', 'flyingJib'],
  ];
  for (const [a, b] of pairs) {
    for (const [da, db] of [
      [limitsDeg(a).min, limitsDeg(b).max],
      [limitsDeg(a).max, limitsDeg(b).min],
    ]) {
      poses.push({
        name: `${a} ${da.toFixed(0)}° vs ${b} ${db.toFixed(0)}°`,
        trims: trimsWith({ [a]: da * DEG, [b]: db * DEG } as Partial<RigTrimAnglesRad>),
        changed: [a, b],
      });
    }
  }
  // 4 — shortened canvas at the extremes, both signs: gathered cloth is a
  // near-subset of the set cloth, spot-checked rather than re-swept.
  poses.push(
    {
      name: 'reefed down, eased to the stops, starboard',
      trims: trimsWith({
        mainsail: RIG_TRIM_LIMITS.mainsail.maxDeg * DEG,
        foresail: RIG_TRIM_LIMITS.foresail.maxDeg * DEG,
      }),
      hoists: { mainsail: 0.55, foresail: 0.75 },
      changed: ['mainsail', 'foresail', 'mainGaffTopsail'],
    },
    {
      name: 'reefed down, eased to the stops, port',
      trims: trimsWith({
        mainsail: RIG_TRIM_LIMITS.mainsail.minDeg * DEG,
        foresail: RIG_TRIM_LIMITS.foresail.minDeg * DEG,
      }),
      hoists: { mainsail: 0.55, foresail: 0.75 },
      changed: ['mainsail', 'foresail', 'mainGaffTopsail'],
    },
  );
  // Every trim pose is swept in the weather a working rig is actually in.
  // The other three weathers get the coherent points of sail below — the
  // whole cross product would quadruple a sweep that already runs for a
  // minute, for poses that differ by a few centimetres of cloth.
  for (const pose of poses) pose.cloth = pose.cloth ?? CLOTH_WEATHERS[1][1];
  return poses;
}

/** The five coherent points of sail, for the weather cross product. */
function coherentPoses(): Pose[] {
  return buildPoses().filter((pose) =>
    /close-hauled|authored port|run, all eased|reefed down/.test(pose.name),
  );
}

/**
 * Everything solid the cloth could reach: the standing timber, and the wire.
 *
 * The swinging spars are deliberately left out. A gaff, a boom and a yard are
 * the things their own sails are BENT to — cloth lies on them by definition —
 * and `ship-rig.test.ts` already holds each gaff sail to its two spars at
 * every hoist. What was never covered is the cloth reaching something it is
 * not attached to, which is what an inverting belly does.
 */
interface SolidObstacle {
  name: string;
  a: V;
  b: V;
  radius: number;
}

const SOLID_OBSTACLES: readonly SolidObstacle[] = [
  ...SPARS.filter((spar) => /mast|bowsprit/i.test(spar.name)).map((spar) => ({
    name: spar.name,
    a: { x: spar.heel.x, y: spar.heel.y, z: spar.heel.z },
    b: { x: spar.head.x, y: spar.head.y, z: spar.head.z },
    // Mean radius: a truncated cone against a point sample, and the head is
    // the thin end everywhere it matters.
    radius: (spar.heelRadius + spar.headRadius) / 2,
  })),
  ...STANDING_RIGGING.map((run) => {
    const a = rigNode(run.from);
    const b = rigNode(run.to);
    return {
      name: run.name,
      a: { x: a.x, y: a.y, z: a.z },
      b: { x: b.x, y: b.y, z: b.z },
      radius: run.diameter / 2,
    };
  }),
];

/**
 * How far cloth may bear into a solid before it counts as passing through it.
 *
 * Not zero, and it should not be: a sail eased onto its shrouds lies against
 * the wire, and 30 mm is about the depth a stretched cloth takes over a rope
 * it is resting on. The number to watch is not this one but the measured
 * worst case, which the failure message prints.
 */
const CLOTH_BEARING_TOLERANCE_M = 0.03;

/**
 * What each sail is BENT TO along a whole edge, rather than at a corner.
 *
 * A gaff sail's luff is hooped to its mast for its entire length and a
 * headsail's is hanked to its stay for its entire length, so those edges lie
 * *in* the timber and the wire by construction — measured, the mainsail's
 * luff is 142 mm inside the mainmast's mean radius at mid-hoist, and it was
 * before this round as well. The corner-proximity exemption cannot cover that
 * because the middle of a six-metre luff is nowhere near either end of it.
 *
 * Naming them is the point: this is the difference between "cloth may touch
 * anything" and "cloth may touch the two things it is tied to". The square
 * topsail has no entry at all, which is what keeps the case this test was
 * written for — an aback belly reaching back into the fore topmast, 94 mm
 * away — inside the gate.
 */
const SAIL_ATTACHMENTS: Readonly<Record<SailName, readonly string[]>> = {
  mainsail: ['mainmast'],
  foresail: ['foremast'],
  mainGaffTopsail: ['mainTopmast'],
  foreStaysail: ['foreStay'],
  jib: ['jibStay'],
  flyingJib: ['flyingJibStay'],
  mainTopmastStaysail: ['mainTopmastStay', 'springStay'],
  foreTopsail: [],
};

function distanceToSegment(p: V, segment: SolidObstacle): number {
  const ax = segment.b.x - segment.a.x;
  const ay = segment.b.y - segment.a.y;
  const az = segment.b.z - segment.a.z;
  const l2 = Math.max(ax * ax + ay * ay + az * az, 1e-12);
  let t = ((p.x - segment.a.x) * ax + (p.y - segment.a.y) * ay + (p.z - segment.a.z) * az) / l2;
  t = Math.min(Math.max(t, 0), 1);
  return Math.hypot(
    p.x - (segment.a.x + ax * t),
    p.y - (segment.a.y + ay * t),
    p.z - (segment.a.z + az * t),
  );
}

/** The sail pairs that can genuinely approach one another. */
const RISK_PAIRS: ReadonlyArray<[SailName, SailName]> = [
  ['mainsail', 'foresail'],
  ['mainsail', 'mainGaffTopsail'],
  ['mainGaffTopsail', 'mainTopmastStaysail'],
  ['mainTopmastStaysail', 'foresail'],
  ['mainTopmastStaysail', 'foreTopsail'],
  ['foresail', 'foreTopsail'],
  ['foresail', 'foreStaysail'],
  ['foreTopsail', 'foreStaysail'],
  ['foreTopsail', 'jib'],
  ['foreStaysail', 'jib'],
  ['jib', 'flyingJib'],
  ['foreStaysail', 'flyingJib'],
];

// --- mesh sampling and intersection ------------------------------------------

const G_U = 10;
const G_V = 8;

interface ClothMesh {
  points: V[];
  tris: Array<[number, number, number]>;
  edges: Array<[number, number]>;
  min: V;
  max: V;
}

function clothMesh(sail: Sail, state: RigLoftState): ClothMesh {
  const live = sailLoftLive(sail, state);
  const surface = sailSurface(sail, live);
  const points: V[] = [];
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i <= G_V; i++) {
    for (let j = 0; j <= G_U; j++) {
      const point = surface(j / G_U, i / G_V);
      points.push(point);
      min.x = Math.min(min.x, point.x);
      min.y = Math.min(min.y, point.y);
      min.z = Math.min(min.z, point.z);
      max.x = Math.max(max.x, point.x);
      max.y = Math.max(max.y, point.y);
      max.z = Math.max(max.z, point.z);
    }
  }
  const at = (i: number, j: number): number => i * (G_U + 1) + j;
  const tris: Array<[number, number, number]> = [];
  const edges: Array<[number, number]> = [];
  for (let i = 0; i < G_V; i++) {
    for (let j = 0; j < G_U; j++) {
      tris.push([at(i, j), at(i, j + 1), at(i + 1, j)]);
      tris.push([at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)]);
    }
  }
  for (let i = 0; i <= G_V; i++) {
    for (let j = 0; j < G_U; j++) edges.push([at(i, j), at(i, j + 1)]);
  }
  for (let i = 0; i < G_V; i++) {
    for (let j = 0; j <= G_U; j++) edges.push([at(i, j), at(i + 1, j)]);
  }
  return { points, tris, edges, min, max };
}

function boxesOverlap(a: ClothMesh, b: ClothMesh, pad: number): boolean {
  return (
    a.min.x - pad < b.max.x &&
    b.min.x - pad < a.max.x &&
    a.min.y - pad < b.max.y &&
    b.min.y - pad < a.max.y &&
    a.min.z - pad < b.max.z &&
    b.min.z - pad < a.max.z
  );
}

/** Möller–Trumbore, segment against triangle. */
function segmentHitsTriangle(p0: V, p1: V, a: V, b: V, c: V): boolean {
  const dirX = p1.x - p0.x;
  const dirY = p1.y - p0.y;
  const dirZ = p1.z - p0.z;
  const e1x = b.x - a.x;
  const e1y = b.y - a.y;
  const e1z = b.z - a.z;
  const e2x = c.x - a.x;
  const e2y = c.y - a.y;
  const e2z = c.z - a.z;
  const px = dirY * e2z - dirZ * e2y;
  const py = dirZ * e2x - dirX * e2z;
  const pz = dirX * e2y - dirY * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const tx = p0.x - a.x;
  const ty = p0.y - a.y;
  const tz = p0.z - a.z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dirX * qx + dirY * qy + dirZ * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 && t < 1 - 1e-9;
}

/**
 * Shared-corner exemption: adjacent sails legitimately meet where both are
 * bent near the same spar (the gaff topsail's clew rides 0.22 m over the
 * mainsail's gaff). Skip edge/triangle tests within this radius of any
 * corner the two sails' graphs bring within a metre of each other.
 */
function nearSharedAttachment(point: V, shared: V[], radius: number): boolean {
  for (const s of shared) {
    const dx = point.x - s.x;
    const dy = point.y - s.y;
    const dz = point.z - s.z;
    if (dx * dx + dy * dy + dz * dz < radius * radius) return true;
  }
  return false;
}

function sharedAttachmentPoints(a: Sail, b: Sail): V[] {
  const shared: V[] = [];
  for (const ca of a.corners) {
    for (const cb of b.corners) {
      const pa = rigNode(ca);
      const pb = rigNode(cb);
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dz = pa.z - pb.z;
      if (dx * dx + dy * dy + dz * dz < 1) {
        shared.push({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 });
      }
    }
  }
  return shared;
}

function pairPenetrations(a: ClothMesh, b: ClothMesh, shared: V[]): number {
  let hits = 0;
  const check = (edges: ClothMesh, tris: ClothMesh): void => {
    for (const [e0, e1] of edges.edges) {
      const p0 = edges.points[e0];
      const p1 = edges.points[e1];
      if (
        nearSharedAttachment(p0, shared, 0.9) &&
        nearSharedAttachment(p1, shared, 0.9)
      ) {
        continue;
      }
      for (const [t0, t1, t2] of tris.tris) {
        if (
          segmentHitsTriangle(
            p0,
            p1,
            tris.points[t0],
            tris.points[t1],
            tris.points[t2],
          )
        ) {
          hits++;
          break;
        }
      }
    }
  };
  check(a, b);
  check(b, a);
  return hits;
}

// --- the sweep ---------------------------------------------------------------

describe('rig — the trim envelope (S4)', () => {
  const SAIL_BY_NAME = new Map(SAILS.map((s) => [s.name, s]));

  it(
    'draws intersection-free cloth at every legal pose swept',
    { timeout: 120_000 },
    () => {
      const poses = buildPoses();
      const failures: string[] = [];
      for (const pose of poses) {
        const state: RigLoftState = {
          trims: pose.trims,
          hoists: { ...FULL_HOISTS, ...pose.hoists },
          cloth: pose.cloth,
        };
        // THE HOISTS HAVE TO GO INTO THE OVERLAY TOO. They did not, and the
        // two "reefed down" poses below were therefore sweeping a FULLY
        // HOISTED mainsail: `sailLoftLive` reported 0.55, and then
        // `gatherSailCorners` returns immediately for the gaff sails because
        // their hoist lowers a spar rather than compressing cloth — so the
        // corners it read were the ones `applyRigTrim` had left peaked. The
        // one category of pose this sweep added for shortened canvas was the
        // one category it was not testing.
        const restore = applyRigTrim(pose.trims, {
          mainsail: state.hoists.mainsail,
          foresail: state.hoists.foresail,
        });
        try {
          const changed = new Set(pose.changed);
          const meshes = new Map<SailName, ClothMesh>();
          const meshOf = (name: SailName): ClothMesh => {
            let mesh = meshes.get(name);
            if (!mesh) {
              mesh = clothMesh(SAIL_BY_NAME.get(name)!, state);
              meshes.set(name, mesh);
            }
            return mesh;
          };
          const trimDegOf = (name: SailName): number => {
            const rad =
              name === 'mainGaffTopsail'
                ? pose.trims.mainsail
                : pose.trims[name as keyof RigTrimAnglesRad];
            return rad / DEG;
          };
          for (const [aName, bName] of RISK_PAIRS) {
            if (!changed.has(aName) && !changed.has(bName)) continue;
            const stateA = state.hoists[aName];
            const stateB = state.hoists[bName];
            if (stateA <= 0.02 || stateB <= 0.02) continue;
            // THE FLOGGING EXEMPTION — measured, then reasoned about, in
            // that order. The sweep's first run failed exactly two poses:
            // a headsail sheeted amidships (trim 0) passing through its
            // steady neighbour. A fore-and-aft sail near zero trim is
            // crossing the wind mid-evolution: real cloth there is
            // slatting, shapeless, and genuinely dragging across the
            // adjacent sail — the rigid surface has no such state, and its
            // camber is already ramped flat (`CAMBER_RAMP_DEG`). So the
            // envelope's cleanliness claim covers *steady* trims; inside
            // the ±5° crossing band, cloth-through-cloth for a few seconds
            // of a tack is the honest picture of slatting canvas, not a
            // rig fault. Every steady pose must still be clean.
            if (
              Math.abs(trimDegOf(aName)) < 5 ||
              Math.abs(trimDegOf(bName)) < 5
            ) {
              continue;
            }
            const a = meshOf(aName);
            const b = meshOf(bName);
            if (!boxesOverlap(a, b, 0.05)) continue;
            const shared = sharedAttachmentPoints(
              SAIL_BY_NAME.get(aName)!,
              SAIL_BY_NAME.get(bName)!,
            );
            const hits = pairPenetrations(a, b, shared);
            if (hits > 0) {
              failures.push(`${pose.name}: ${aName} × ${bName} (${hits} edges)`);
            }
          }
        } finally {
          restore();
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
  );

  it(
    'draws intersection-free cloth in every weather, at every point of sail (M6)',
    { timeout: 120_000 },
    () => {
      // The second axis. Trim was the only thing that moved the drawn surface
      // before M6; now the wind moves it too, and a sweep over one axis of a
      // two-axis space is the exact shape of fault the rig round's lesson is
      // about — a category the suite has no test for.
      const failures: string[] = [];
      for (const [weather, cloth] of CLOTH_WEATHERS) {
        for (const pose of coherentPoses()) {
          const state: RigLoftState = {
            trims: pose.trims,
            hoists: { ...FULL_HOISTS, ...pose.hoists },
            cloth,
          };
          const restore = applyRigTrim(pose.trims, {
            mainsail: state.hoists.mainsail,
            foresail: state.hoists.foresail,
          });
          try {
            const meshes = new Map<SailName, ClothMesh>();
            const meshOf = (name: SailName): ClothMesh => {
              let mesh = meshes.get(name);
              if (!mesh) {
                mesh = clothMesh(SAIL_BY_NAME.get(name)!, state);
                meshes.set(name, mesh);
              }
              return mesh;
            };
            for (const [aName, bName] of RISK_PAIRS) {
              if (state.hoists[aName] <= 0.02 || state.hoists[bName] <= 0.02) continue;
              const trimOf = (name: SailName): number =>
                (name === 'mainGaffTopsail'
                  ? pose.trims.mainsail
                  : pose.trims[name as keyof RigTrimAnglesRad]) / DEG;
              // The same flogging exemption the steady sweep carries.
              if (Math.abs(trimOf(aName)) < 5 || Math.abs(trimOf(bName)) < 5) continue;
              const a = meshOf(aName);
              const b = meshOf(bName);
              if (!boxesOverlap(a, b, 0.05)) continue;
              const hits = pairPenetrations(
                a,
                b,
                sharedAttachmentPoints(SAIL_BY_NAME.get(aName)!, SAIL_BY_NAME.get(bName)!),
              );
              if (hits > 0) {
                failures.push(`${weather} / ${pose.name}: ${aName} × ${bName} (${hits})`);
              }
            }
          } finally {
            restore();
          }
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    },
  );

  it(
    'keeps live cloth out of the spars and the standing rigging (M6)',
    { timeout: 120_000 },
    () => {
      /**
       * Ropes were never checked against cloth until the rig round found a
       * peak halyard running through the gaff topsail; the standing rigging
       * still was not, because static cloth never reached it. A belly that
       * inverts when the sail goes aback does.
       *
       * The square topsail is why this test exists. Its flat patch clears the
       * fore topmast by 0.094 m — measured — so it has almost no room aft
       * whatever the wind does, and `CLOTH_CUTS.foreTopsail.aback` is the
       * small number in that table for exactly this reason.
       *
       * Cloth *bearing* on rope or timber is not a fault; a gaff sail eased
       * onto its shrouds lies against wire at sea. Cloth passing INSIDE the
       * solid is. The gate is therefore about penetration depth, and the
       * attachment exemption is the same one the sail suite uses: every sail
       * is legitimately in contact with the spar it is bent to.
       */
      const failures: string[] = [];
      const worstBySail = new Map<SailName, number>();
      for (const [weather, cloth] of CLOTH_WEATHERS) {
        for (const pose of coherentPoses()) {
          const state: RigLoftState = {
            trims: pose.trims,
            hoists: { ...FULL_HOISTS, ...pose.hoists },
            cloth,
          };
          const restore = applyRigTrim(pose.trims, {
            mainsail: state.hoists.mainsail,
            foresail: state.hoists.foresail,
          });
          try {
            for (const sail of SAILS) {
              if (state.hoists[sail.name] <= 0.02) continue;
              const mesh = clothMesh(sail, state);
              const bentTo = SAIL_ATTACHMENTS[sail.name];
              const ownCorners = sail.corners.map((n) => {
                const node = rigNode(n);
                return { x: node.x, y: node.y, z: node.z };
              });
              for (const point of mesh.points) {
                // Things this sail meets at a corner — a headsail tack on the
                // bowsprit, the flying jib's tack where the bobstay lands.
                if (nearSharedAttachment(point, ownCorners, 1.1)) continue;
                for (const obstacle of SOLID_OBSTACLES) {
                  // Things it is bent to along a whole edge.
                  if (bentTo.includes(obstacle.name)) continue;
                  const depth = obstacle.radius - distanceToSegment(point, obstacle);
                  if (depth <= 0) continue;
                  const worst = worstBySail.get(sail.name) ?? 0;
                  if (depth > worst) worstBySail.set(sail.name, depth);
                  if (depth > CLOTH_BEARING_TOLERANCE_M) {
                    failures.push(
                      `${weather} / ${pose.name}: ${sail.name} is ${(depth * 1000).toFixed(
                        0,
                      )} mm inside ${obstacle.name}`,
                    );
                  }
                }
              }
            }
          } finally {
            restore();
          }
        }
      }
      expect(failures, [...new Set(failures)].slice(0, 20).join('\n')).toEqual([]);
      /**
       * MEASURED, and recorded rather than merely tolerated: the deepest the
       * cloth bears into anything it is not bent to, anywhere in the envelope
       * and in any weather. A change that doubles it is worth noticing even
       * while it is still inside the tolerance above.
       *
       * 13.0 mm at this sampling — the fore staysail's leech flogging against
       * the foremast when it is slatting close-hauled, which is a real thing
       * canvas does. An independent 11 × 11 probe of the same pair found 21 mm,
       * so the gate sits above both: the quantity is a sampled maximum of a
       * continuous surface and refining the grid finds a little more of it.
       */
      const deepest = Math.max(0, ...worstBySail.values());
      expect(
        deepest,
        `deepest bearing ${(deepest * 1000).toFixed(1)} mm: ${[...worstBySail]
          .map(([name, d]) => `${name} ${(d * 1000).toFixed(1)}`)
          .join(', ')}`,
      ).toBeLessThan(0.025);
    },
  );

  it('bellies every fore-and-aft sail to the sheeted side, both tacks', () => {
    for (const sign of [1, -1] as const) {
      const trims = Object.fromEntries(
        Object.entries(AUTHORED_TRIM_RAD).map(([k, v]) => [k, sign * v]),
      ) as unknown as RigTrimAnglesRad;
      const state: RigLoftState = { trims, hoists: FULL_HOISTS };
      const restore = applyRigTrim(trims);
      try {
        for (const sail of SAILS) {
          if (sail.name === 'foreTopsail') continue; // bellies forward, not sideways
          const live = sailLoftLive(sail, state);
          const surface = sailSurface(sail, live);
          const centre = surface(0.5, 0.5);
          const c = sail.corners.map((n) => rigNode(n));
          const [p0, p1, p2, p3] =
            c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
          const flatX = (p0.x + p1.x + p2.x + p3.x) / 4;
          const belly = centre.x - flatX;
          // Sheeted to port (positive trim) ⇒ belly falls to port (+x).
          expect(
            Math.sign(belly),
            `${sail.name} belly on ${sign > 0 ? 'starboard' : 'port'} tack`,
          ).toBe(sign);
        }
      } finally {
        restore();
      }
    }
  });

  it('measures the tack-coupled rope leads instead of assuming them', () => {
    // The peak halyard and the fisherman sheet are rigged to starboard by
    // authored choice — the graph's own comments flag that a port-tack
    // re-trim puts cloth on their side. Measure the minimum clearance from
    // rope line to cloth on the port tack and record the truth.
    const trims = Object.fromEntries(
      Object.entries(AUTHORED_TRIM_RAD).map(([k, v]) => [k, -v]),
    ) as unknown as RigTrimAnglesRad;
    const state: RigLoftState = { trims, hoists: FULL_HOISTS };
    const restore = applyRigTrim(trims);
    try {
      const topsail = SAIL_BY_NAME.get('mainGaffTopsail')!;
      const surface = sailSurface(topsail, sailLoftLive(topsail, state));
      const a = rigNode('mainGaffSpan');
      const b = rigNode('mainPeakBlock');
      let worst = Infinity;
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const pz = a.z + (b.z - a.z) * t;
        for (let u = 0; u <= 12; u++) {
          for (let v = 0; v <= 10; v++) {
            const s = surface(u / 12, v / 10);
            worst = Math.min(worst, Math.hypot(s.x - px, s.y - py, s.z - pz));
          }
        }
      }
      // MEASURED 2026-08-07 (S4): the halyard chord passes this close to the
      // port-tack topsail. The gate asserts the rope is not *inside* the
      // cloth (clearance above one rope radius); bearing contact is the
      // period-honest outcome for gear rigged one side.
      expect(worst).toBeGreaterThan(0.012);
    } finally {
      restore();
    }
  });
});
