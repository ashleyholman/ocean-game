import { RHO_TIMBER, type BeamGeometry, type LogGeometry } from './RaftBuoyancy';
import type { MassItem } from '../BuoyantBody';

/**
 * The raft's flotation geometry and mass budget, as pure data.
 *
 * Extracted from `Raft.ts` so the numbers the physics floats on can be built
 * and inspected without a WebGL context. `Raft` still owns the meshes and is
 * still the only thing that decides what the raft *looks* like; it calls in
 * here for the timber and then builds its cylinders from the same records it
 * hands to `RaftBuoyancy`. The contract in the `RaftBuoyancy` header is
 * unchanged — one description of one object — this just moves the description
 * somewhere a headless test can reach it.
 *
 * THE LCG SEQUENCE IS PART OF THE CONTRACT
 * ----------------------------------------
 * The raft is deterministic: one seed, no time or environment input, so the
 * same driftwood every load. That property only holds if the *order* of `rand()`
 * calls is preserved, which is why `buildRaftTimber` takes the generator rather
 * than owning it — `Raft` continues the same sequence afterwards for the
 * lashings and mast wraps, and those must keep drawing the numbers they always
 * drew. Reordering the calls below silently rebuilds the raft.
 */

export const DECK_LENGTH = 3.2;
export const DECK_WIDTH = 2.2;
export const LOG_COUNT = 9;

/**
 * Height of the deck-log *axes* above the raft origin. Not the deck surface:
 * the walking surface is a log radius higher, at about 0.25.
 */
export const DECK_Y = 0.13;

export const MAST_HEIGHT = 2.55;
export const SAIL_WIDTH = 1.78;

/** The seed the shipped raft is built from. */
export const RAFT_SEED = 20260727;

/** Wet hemp cordage. */
export const RHO_CORDAGE = 900;

/** Deterministic noise so the raft is identical on every load. */
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface RaftTimber {
  logs: LogGeometry[];
  beams: BeamGeometry[];
  /** Per-log `rotation.z`, drawn from the same sequence. Presentation only. */
  logTilt: number[];
  /** Per-beam `rotation.y`. Presentation only. */
  beamYaw: number[];
}

/**
 * Build the deck logs and the cross beams beneath them.
 *
 * Consumes exactly seven random numbers per log and one per beam, in the order
 * the meshes were originally written — see the header.
 */
export function buildRaftTimber(rand: () => number): RaftTimber {
  const logs: LogGeometry[] = [];
  const beams: BeamGeometry[] = [];
  const logTilt: number[] = [];
  const beamYaw: number[] = [];

  const spacing = DECK_WIDTH / LOG_COUNT;
  for (let i = 0; i < LOG_COUNT; i++) {
    const radius = spacing * 0.5 * (0.86 + rand() * 0.24);
    const length = DECK_LENGTH * (0.94 + rand() * 0.1);
    const radiusStern = radius * (0.9 + rand() * 0.16);
    logTilt.push((rand() - 0.5) * 0.05);
    const x = -DECK_WIDTH / 2 + spacing * (i + 0.5) + (rand() - 0.5) * 0.02;
    const y = DECK_Y + (rand() - 0.5) * 0.026;
    const z = (rand() - 0.5) * 0.14;
    logs.push({ radiusBow: radius, radiusStern, length, x, y, z });
  }

  for (const z of [-1.06, 1.06]) {
    beamYaw.push((rand() - 0.5) * 0.04);
    beams.push({
      radius: 0.0725,
      length: DECK_WIDTH + 0.16,
      y: DECK_Y - 0.115,
      z,
    });
  }

  return { logs, beams, logTilt, beamYaw };
}

/**
 * Everything that is not a log or a cross beam: mast, step, yard and furled
 * cloth, the seated castaway, and the cordage. Positions are the same literals
 * the meshes are placed with in `Raft.ts`, so the physics and the picture
 * describe one object.
 */
export function buildRaftTopsides(): MassItem[] {
  const cyl = (m: number, r: number, h: number) => ({
    ixx: (m * (3 * r * r + h * h)) / 12,
    izz: (m * (3 * r * r + h * h)) / 12,
  });

  const mastVolume =
    (Math.PI / 3) * MAST_HEIGHT * (0.042 ** 2 + 0.042 * 0.062 + 0.062 ** 2);
  const mastMass = mastVolume * RHO_TIMBER;
  const stepMass = 0.3 * 0.14 * 0.34 * RHO_TIMBER;
  const yardVolume =
    (Math.PI / 3) * (SAIL_WIDTH + 0.24) * (0.03 ** 2 + 0.03 * 0.026 + 0.026 ** 2);
  const yardMass = yardVolume * RHO_TIMBER;
  const stayMass = 3 * Math.PI * 0.01 ** 2 * 3.0 * RHO_CORDAGE;
  const loopMass = 2 * 0.00203 * RHO_CORDAGE;
  const tieMass = (6 * 0.00039 + 3 * 0.00029) * RHO_CORDAGE;
  const bundleMass = 0.0052 * RHO_CORDAGE;

  return [
    {
      mass: mastMass,
      x: 0.04,
      y: DECK_Y + MAST_HEIGHT / 2 - 0.02,
      z: -0.34,
      ...cyl(mastMass, 0.052, MAST_HEIGHT),
    },
    {
      mass: stepMass,
      x: 0.04,
      y: DECK_Y + 0.1,
      z: -0.34,
      ixx: (stepMass * (0.14 ** 2 + 0.34 ** 2)) / 12,
      izz: (stepMass * (0.3 ** 2 + 0.14 ** 2)) / 12,
    },
    {
      // Yard and furled cloth, at the stowed height. Raising the sail lifts
      // 9 kg by 1.66 m, which moves the centre of mass by 20 mm; that is below
      // the resolution of anything here and is not modelled.
      mass: yardMass + 7,
      x: 0.06,
      y: DECK_Y + 0.62,
      z: -0.3,
      ixx: ((yardMass + 7) * (3 * 0.028 ** 2 + 0.36 ** 2)) / 12,
      izz: ((yardMass + 7) * (3 * 0.028 ** 2 + (SAIL_WIDTH + 0.24) ** 2)) / 12,
    },
    // One seated adult, at the volumetric centroid of the figure geometry.
    {
      mass: 72,
      x: -0.18,
      y: 0.49,
      z: 1.075,
      ixx: (72 * (0.87 ** 2 + 0.5 ** 2)) / 12,
      izz: (72 * (0.4 ** 2 + 0.87 ** 2)) / 12,
    },
    {
      mass: stayMass,
      x: 0.04,
      y: 1.4,
      z: -0.1,
      ixx: (stayMass * 3.0 ** 2) / 12,
      izz: (stayMass * 3.0 ** 2) / 12,
    },
    {
      mass: loopMass,
      x: 0,
      y: DECK_Y - 0.02,
      z: 0,
      ixx: loopMass * 1.06 ** 2,
      izz: (loopMass * 1.19 ** 2) / 2,
    },
    {
      mass: tieMass,
      x: 0,
      y: DECK_Y + 0.045,
      z: 0,
      ixx: tieMass * 1.06 ** 2,
      izz: tieMass * 0.3 ** 2,
    },
    {
      mass: bundleMass,
      x: 0.72,
      y: DECK_Y + 0.08,
      z: 0.42,
      ixx: bundleMass * 0.02,
      izz: bundleMass * 0.02,
    },
  ];
}
