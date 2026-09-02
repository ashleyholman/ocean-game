import { describe, expect, it } from 'vitest';
import {
  AUTHORED_TRIM_RAD,
  RIG_TRIM_LIMITS,
  SAILS,
  SPARS,
  applyRigTrim,
  rigNode,
  trimmedRigNodePositions,
  type RigTrimAnglesRad,
  type Sail,
  type SailName,
} from '../src/vessel/schooner/rig';
import {
  buildRigGeometry,
  createSailClothFlow,
  furlRoll,
  gatheredClothAreaM2,
  sailLoftLive,
  sailSurface,
  type RigLoftState,
  type SailClothFlow,
  type SailClothState,
} from '../src/vessel/schooner/rigGeometry';
import {
  SAIL_AERO_GEOMETRY,
  liveSailVariantGeometry,
  sailLuffFactor,
} from '../src/vessel/schooner/sailAero';
import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';

/**
 * M6 — THE CLOTH.
 *
 * The milestone's claim is that the six principal sails (eight, in the rig as
 * built) are deformable cloth answering the wind, and that the deformation is
 * *presentation driven by the physics' own state* rather than a second
 * simulation running alongside it. Everything in this file is an attempt to
 * make one half of that claim fail.
 *
 * The load-bearing ones, in order of how much damage they would do if they
 * stopped holding:
 *
 * 1. the corners still belong to `rig.ts` — no mode may move an attachment;
 * 2. the drawn belly and `sailAero`'s leeward normal are the same vector;
 * 3. `?cloth=flat` is the presentation that shipped, to the bit;
 * 4. cloth is conserved across hoist — what leaves the sail is in the roll.
 */

const DEG = Math.PI / 180;
const FULL_HOISTS = Object.fromEntries(SAILS.map((s) => [s.name, 1])) as Record<
  SailName,
  number
>;
const SAIL_BY_NAME = new Map(SAILS.map((s) => [s.name, s]));

function flows(
  overrides: Partial<Record<SailName, Partial<SailClothFlow>>> = {},
  base: Partial<SailClothFlow> = {},
): Record<SailName, SailClothFlow> {
  return Object.fromEntries(
    SAILS.map((sail) => [
      sail.name,
      { ...createSailClothFlow(), ...base, ...(overrides[sail.name] ?? {}) },
    ]),
  ) as Record<SailName, SailClothFlow>;
}

function clothState(
  base: Partial<SailClothFlow> = {},
  overrides: Partial<Record<SailName, Partial<SailClothFlow>>> = {},
  elapsedSeconds = 0,
  animate = true,
): SailClothState {
  return { flow: flows(overrides, base), elapsedSeconds, animate };
}

/** A sail drawing properly: well inside the attached band, in a working breeze. */
const DRAWING: Partial<SailClothFlow> = {
  aoaDeg: 22,
  apparentSpeedMps: 9,
  blanketFactor: 1,
};
/** A sail on the edge — the aero calls this luffing. */
const LUFFING: Partial<SailClothFlow> = {
  aoaDeg: 2,
  apparentSpeedMps: 9,
  blanketFactor: 1,
};
/** A sail with the wind on its leeward face. */
const ABACK: Partial<SailClothFlow> = {
  aoaDeg: -20,
  apparentSpeedMps: 9,
  blanketFactor: 1,
};

function stateWith(
  trims: RigTrimAnglesRad,
  cloth: SailClothState | undefined,
  hoists: Partial<Record<SailName, number>> = {},
): RigLoftState {
  return { trims, hoists: { ...FULL_HOISTS, ...hoists }, cloth };
}

function cornerOf(sail: Sail, index: number): { x: number; y: number; z: number } {
  const node = rigNode(sail.corners[index]);
  return { x: node.x, y: node.y, z: node.z };
}

/**
 * Where each of a sail's corners sits in `(u, v)`.
 *
 * A triangle enters the patch as head, head, clew, tack — so its head owns
 * the whole `v = 0` row and only three parameter points are distinct.
 */
function cornerParameters(sail: Sail): Array<[number, number, number]> {
  return sail.corners.length === 3
    ? [
        [0, 0, 0], // head, at the collapsed row
        [1, 1, 2], // clew
        [0, 1, 1], // tack
      ]
    : [
        [0, 0, 0],
        [1, 0, 1],
        [1, 1, 2],
        [0, 1, 3],
      ];
}

function surfaceArea(sail: Sail, state: RigLoftState, n = 32): number {
  const surface = sailSurface(sail, sailLoftLive(sail, state));
  const rows: Array<Array<{ x: number; y: number; z: number }>> = [];
  for (let i = 0; i <= n; i++) {
    const row = [];
    for (let j = 0; j <= n; j++) row.push(surface(j / n, i / n));
    rows.push(row);
  }
  const tri = (
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
    c: { x: number; y: number; z: number },
  ): number => {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    return (
      0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    );
  };
  let area = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      area += tri(rows[i][j], rows[i][j + 1], rows[i + 1][j]);
      area += tri(rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]);
    }
  }
  return area;
}

/** The drawn centre's offset from the flat patch's centre. */
function bellyVector(
  sail: Sail,
  state: RigLoftState,
): { x: number; y: number; z: number } {
  const surface = sailSurface(sail, sailLoftLive(sail, state));
  const mid = surface(0.5, 0.5);
  const c = sail.corners.map((n) => rigNode(n));
  const [p0, p1, p2, p3] =
    c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
  return {
    x: mid.x - (p0.x + p1.x + p2.x + p3.x) / 4,
    y: mid.y - (p0.y + p1.y + p2.y + p3.y) / 4,
    z: mid.z - (p0.z + p1.z + p2.z + p3.z) / 4,
  };
}

function trimDegOf(sail: Sail, trims: RigTrimAnglesRad): number {
  const rad =
    sail.name === 'mainGaffTopsail'
      ? trims.mainsail
      : trims[sail.name as keyof RigTrimAnglesRad];
  return rad / DEG;
}

/** Order-sensitive mix of a float buffer; only exact equality is meaningful. */
function checksum(values: ArrayLike<number>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const q = Math.round(v * 1e7);
    h1 = (h1 ^ (q & 0xffffffff)) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + q * (i + 1)) % 2147483647;
    n++;
  }
  return `${h1}:${h2}:${n}`;
}

// --- 1. the corners are the rig's ---------------------------------------------

describe('M6 cloth — every mode leaves the corners where the rig put them', () => {
  /**
   * The one invariant the whole design rests on. `rig.ts` owns the corners and
   * the aero reads them; the cloth is allowed to shape the surface *between*
   * them and nothing else. Every mode shape is therefore zero at all four
   * corner parameters, and this sweeps the states that would break it if any
   * one of them were not.
   */
  const CASES: Array<[string, Partial<SailClothFlow>]> = [
    ['drawing', DRAWING],
    ['luffing', LUFFING],
    ['aback', ABACK],
    ['slatting', { aoaDeg: 0, apparentSpeedMps: 14, blanketFactor: 1 }],
    ['abandoned', { ...LUFFING, cannotDraw: true }],
    ['blanketed', { ...DRAWING, blanketFactor: 0.5 }],
    ['a gale', { aoaDeg: 8, apparentSpeedMps: 28, blanketFactor: 1 }],
  ];

  for (const [label, flow] of CASES) {
    for (const eased of [false, true]) {
      it(`${label}, sheets ${eased ? 'eased to the stops' : 'hardened'}`, () => {
        const trims = Object.fromEntries(
          Object.keys(AUTHORED_TRIM_RAD).map((key) => {
            const limits = RIG_TRIM_LIMITS[key as SailName];
            return [key, (eased ? limits.maxDeg : 10) * DEG];
          }),
        ) as unknown as RigTrimAnglesRad;
        const state = stateWith(trims, clothState(flow, {}, 3.7));
        const restore = applyRigTrim(trims);
        try {
          for (const sail of SAILS) {
            const surface = sailSurface(sail, sailLoftLive(sail, state));
            for (const [u, v, index] of cornerParameters(sail)) {
              const drawn = surface(u, v);
              const corner = cornerOf(sail, index);
              const slip = Math.hypot(
                drawn.x - corner.x,
                drawn.y - corner.y,
                drawn.z - corner.z,
              );
              expect(
                slip,
                `${sail.name} corner ${sail.corners[index]} slipped ${slip.toFixed(6)} m`,
              ).toBeLessThan(1e-9);
            }
          }
        } finally {
          restore();
        }
      });
    }
  }
});

// --- 2. the belly IS the aero's leeward face ----------------------------------

describe('M6 cloth — the drawn belly and the aero leeward normal are one vector', () => {
  /**
   * `rigGeometry` now calls `sailAero.sailLeewardNormal` for this direction
   * instead of holding a second copy of the same cross product, so the two
   * agree by construction. The test is here because "by construction" is a
   * claim about today's code and this is a claim about the drawn surface.
   */
  const TRIM_FRACTIONS = [-1, -0.6, -0.25, 0.25, 0.6, 1];

  it('points the belly to leeward at every trim in the envelope', () => {
    const failures: string[] = [];
    for (const fraction of TRIM_FRACTIONS) {
      const trims = Object.fromEntries(
        Object.keys(AUTHORED_TRIM_RAD).map((key) => {
          const limits = RIG_TRIM_LIMITS[key as SailName];
          const deg = fraction > 0 ? limits.maxDeg * fraction : limits.minDeg * -fraction;
          return [key, deg * DEG];
        }),
      ) as unknown as RigTrimAnglesRad;
      const state = stateWith(trims, clothState(DRAWING));
      const restore = applyRigTrim(trims);
      try {
        for (const sail of SAILS) {
          const belly = bellyVector(sail, state);
          const length = Math.hypot(belly.x, belly.y, belly.z);
          const trimDeg = trimDegOf(sail, trims);
          if (length < 1e-4) continue; // amidships: the camber ramp holds it flat
          const aero = liveSailVariantGeometry(sail.name, trimDeg, 1, trims.mainsail / DEG, 1);
          const cos =
            (belly.x * aero.leewardNormal.x +
              belly.y * aero.leewardNormal.y +
              belly.z * aero.leewardNormal.z) /
            length;
          if (cos < 0.995) {
            failures.push(
              `${sail.name} at ${trimDeg.toFixed(1)}°: cos(belly, leeward) = ${cos.toFixed(4)}`,
            );
          }
        }
      } finally {
        restore();
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('turns the belly to windward when the sail is aback', () => {
    const trims = { ...AUTHORED_TRIM_RAD };
    const state = stateWith(trims, clothState(ABACK));
    const restore = applyRigTrim(trims);
    try {
      for (const sail of SAILS) {
        const belly = bellyVector(sail, state);
        const length = Math.hypot(belly.x, belly.y, belly.z);
        expect(length, `${sail.name} has no aback belly at all`).toBeGreaterThan(1e-3);
        const aero = liveSailVariantGeometry(
          sail.name,
          trimDegOf(sail, trims),
          1,
          trims.mainsail / DEG,
          1,
        );
        const cos =
          (belly.x * aero.leewardNormal.x +
            belly.y * aero.leewardNormal.y +
            belly.z * aero.leewardNormal.z) /
          length;
        expect(cos, `${sail.name} aback belly`).toBeLessThan(-0.995);
      }
    } finally {
      restore();
    }
  });
});

// --- 3. the flat arm is the presentation that shipped -------------------------

describe('M6 cloth — ?cloth=flat is what shipped, to the bit', () => {
  /**
   * MEASURED against master 63308dc (the commit this branch forked from) by
   * building the same three poses there and here and comparing the mixed
   * checksum of the sampled cloth surface. These are that commit's numbers,
   * copied in. If a future change to the loft moves the pre-M6 arm, this fails
   * and the A/B has stopped being an A/B.
   *
   * The whole `sailcloth` *buffer* is deliberately not checksummed here: the
   * furl roll's radius DID change this round (see the conservation block
   * below), and it shares that buffer. The cloth surface is the thing the
   * switch is meant to hold still, and it does — at the reefed pose too.
   */
  const POSES: Array<[string, RigTrimAnglesRad, Partial<Record<SailName, number>>, string]> = [
    ['authored', { ...AUTHORED_TRIM_RAD }, {}, '3226074232:-1632345518:1176'],
    [
      'close-hauled port tack',
      Object.fromEntries(
        Object.keys(AUTHORED_TRIM_RAD).map((k) => [k, -12 * DEG]),
      ) as unknown as RigTrimAnglesRad,
      {},
      '1290881521:-892223989:1176',
    ],
    [
      'reefed and eased',
      { ...AUTHORED_TRIM_RAD, mainsail: 40 * DEG, foresail: 44 * DEG },
      { mainsail: 0.55, foresail: 0.75, mainGaffTopsail: 0 },
      '3985211909:-634087393:1029',
    ],
  ];

  for (const [label, trims, hoists, golden] of POSES) {
    it(`${label}`, () => {
      const state = stateWith(trims, undefined, hoists);
      const restore = applyRigTrim(trims, {
        mainsail: state.hoists.mainsail,
        foresail: state.hoists.foresail,
      });
      try {
        const samples: number[] = [];
        for (const sail of SAILS) {
          if (state.hoists[sail.name] <= 0.02) continue;
          const surface = sailSurface(sail, sailLoftLive(sail, state));
          for (let i = 0; i <= 6; i++) {
            for (let j = 0; j <= 6; j++) {
              const q = surface(j / 6, i / 6);
              samples.push(q.x, q.y, q.z);
            }
          }
        }
        expect(checksum(samples)).toBe(golden);
      } finally {
        restore();
      }
    });
  }

  it('ignores the cloth state entirely when none is attached', () => {
    const trims = { ...AUTHORED_TRIM_RAD };
    const flat = buildRigGeometry({ trims, hoists: FULL_HOISTS });
    const alsoFlat = buildRigGeometry({
      trims,
      hoists: FULL_HOISTS,
      cloth: undefined,
    });
    const a = flat.geometries.get('sailcloth')!.attributes.position.array;
    const b = alsoFlat.geometries.get('sailcloth')!.attributes.position.array;
    expect(checksum(b)).toBe(checksum(a));
  });

  it('parses the three arms of the switch and refuses anything else', () => {
    const host = { viewportWidth: 1280, viewportHeight: 800, isTouch: false };
    const mode = (query: string): string =>
      resolveRuntimeOptions(new URLSearchParams(query), host).sailClothMode;
    expect(mode('')).toBe('alive');
    expect(mode('cloth=alive')).toBe('alive');
    expect(mode('cloth=still')).toBe('still');
    expect(mode('cloth=flat')).toBe('flat');
    expect(() => mode('cloth=deformable')).toThrow(/cloth=deformable/);
  });
});

// --- 4. cloth is conserved -----------------------------------------------------

describe('M6 cloth — canvas is conserved across hoist and reef', () => {
  /**
   * What leaves the sail is in the roll. Before M6 the roll assumed a sail
   * loses area in proportion to its halyard, which no family aboard does, and
   * a headsail at its first reef point had lost 17.7% of its canvas to
   * nowhere. `gatheredClothAreaM2` now subtracts the measured standing area.
   *
   * THE BOUND, AND WHY IT IS NOT ZERO. The roll's cloth and the aero's set
   * area are both *flat planform*; the drawn sail is a bellied surface, which
   * has more area than its own planform — about 2% at the authored camber.
   * That excess is the whole of the residual here, and it is why the bound is
   * one-sided and why it grows at the bottom of the hoist, where the planform
   * has nearly collapsed and its belly has not.
   */
  const HOISTS = [1, 0.9, 0.75, 0.55, 0.4, 0.3];
  const STOWING: SailName[] = [
    'mainsail',
    'foresail',
    'foreStaysail',
    'jib',
    'flyingJib',
    'foreTopsail',
  ];

  for (const name of STOWING) {
    it(`${name}: drawn cloth plus rolled cloth stays the sail it was`, () => {
      const sail = SAIL_BY_NAME.get(name)!;
      const setArea = SAIL_AERO_GEOMETRY.find((g) => g.name === name)!.variants
        .starboard.set!.areaM2;
      for (const hoist of HOISTS) {
        const trims = { ...AUTHORED_TRIM_RAD };
        const state = stateWith(trims, clothState(DRAWING), { [name]: hoist });
        const restore = applyRigTrim(trims, {
          mainsail: state.hoists.mainsail,
          foresail: state.hoists.foresail,
        });
        let drawn = 0;
        try {
          drawn = surfaceArea(sail, state);
        } finally {
          restore();
        }
        const rolled = gatheredClothAreaM2(sail, hoist);
        const error = (drawn + rolled - setArea) / setArea;
        expect(
          error,
          `${name} at hoist ${hoist}: ${(drawn + rolled).toFixed(2)} m² against ${setArea.toFixed(2)} m²`,
        ).toBeGreaterThan(-0.005);
        expect(
          error,
          `${name} at hoist ${hoist}: ${(drawn + rolled).toFixed(2)} m² against ${setArea.toFixed(2)} m²`,
        ).toBeLessThan(0.055);
      }
    });
  }

  it('puts the whole sail in the roll once it is struck', () => {
    for (const name of STOWING) {
      const sail = SAIL_BY_NAME.get(name)!;
      const setArea = SAIL_AERO_GEOMETRY.find((g) => g.name === name)!.variants
        .starboard.set!.areaM2;
      expect(gatheredClothAreaM2(sail, 0), name).toBeCloseTo(setArea, 6);
      expect(gatheredClothAreaM2(sail, 1), name).toBe(0);
    }
  });

  it('sizes the roll by the volume of the cloth wound into it', () => {
    // Invert `furlRollRadius`: the sleeve's own volume, minus the spar it is
    // wrapped around, divided by the packed thickness, must be the cloth.
    const PACKED_M = 0.012;
    const CLEARANCE_M = 0.012;
    for (const name of STOWING) {
      const sail = SAIL_BY_NAME.get(name)!;
      for (const hoist of [0.9, 0.6, 0.25, 0]) {
        const roll = furlRoll(sail, hoist)!;
        expect(roll, `${name} has no roll`).toBeTruthy();
        for (const [radius, core] of [
          [roll.radiusA, roll.coreA],
          [roll.radiusB, roll.coreB],
        ]) {
          const sleeve = core + CLEARANCE_M;
          const clothM2 =
            (Math.PI * (radius * radius - sleeve * sleeve) * roll.lengthM) / PACKED_M;
          expect(
            clothM2,
            `${name} at hoist ${hoist}: roll holds ${clothM2.toFixed(2)} m²`,
          ).toBeCloseTo(gatheredClothAreaM2(sail, hoist), 6);
        }
      }
    }
  });

  it('never lets the spar out through the top of its own roll', () => {
    for (const name of STOWING) {
      const sail = SAIL_BY_NAME.get(name)!;
      for (const hoist of [0.99, 0.75, 0.4, 0]) {
        const roll = furlRoll(sail, hoist)!;
        expect(roll.radiusA - roll.coreA, `${name} A at ${hoist}`).toBeGreaterThan(0);
        expect(roll.radiusB - roll.coreB, `${name} B at ${hoist}`).toBeGreaterThan(0);
        expect(roll.sagM, `${name} sag at ${hoist}`).toBeLessThan(
          Math.min(roll.radiusA - roll.coreA, roll.radiusB - roll.coreB),
        );
      }
    }
  });

  it('does not measure the roll from a pose the caller happens to be holding', () => {
    // The gathered area is a question about halyard, not about sheet. It used
    // to be answered from the posed graph, which gave it a precondition a
    // caller could satisfy by accident.
    const sail = SAIL_BY_NAME.get('mainsail')!;
    const loose = gatheredClothAreaM2(sail, 0.6);
    const trims = { ...AUTHORED_TRIM_RAD, mainsail: 40 * DEG };
    const restore = applyRigTrim(trims, { mainsail: 0.6, foresail: 1 });
    try {
      expect(gatheredClothAreaM2(sail, 0.6)).toBe(loose);
    } finally {
      restore();
    }
  });
});

// --- 5. the hoist moves the spar ----------------------------------------------

describe('M6 cloth — a hoist lowers the gaff, and the drawn timber follows', () => {
  for (const [sail, gaffSpar, throat, peak] of [
    ['mainsail', 'mainGaff', 'mainThroat', 'mainPeak'],
    ['foresail', 'foreGaff', 'foreThroat', 'forePeak'],
  ] as const) {
    it(`${sail}: the gaff itself comes down, not the cloth on it`, () => {
      const spar = SPARS.find((s) => s.name === gaffSpar)!;
      // The spar table addresses the gaff by the same two node names the sail
      // is bent to, so lowering the hoist has to carry the timber with it.
      expect(spar.heel).toBe(rigNode(throat));
      expect(spar.head).toBe(rigNode(peak));
      let lastThroat = Infinity;
      let lastPeak = Infinity;
      for (const hoist of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
        const moved = trimmedRigNodePositions(AUTHORED_TRIM_RAD, {
          mainsail: sail === 'mainsail' ? hoist : 1,
          foresail: sail === 'foresail' ? hoist : 1,
        });
        expect(moved[throat].y, `${throat} at ${hoist}`).toBeLessThan(lastThroat);
        expect(moved[peak].y, `${peak} at ${hoist}`).toBeLessThan(lastPeak);
        lastThroat = moved[throat].y;
        lastPeak = moved[peak].y;
      }
    });
  }

  it('redraws the spar region when only a hoist changes', () => {
    const trims = { ...AUTHORED_TRIM_RAD };
    const up = buildRigGeometry({ trims, hoists: FULL_HOISTS });
    const down = buildRigGeometry({
      trims,
      hoists: { ...FULL_HOISTS, mainsail: 0.5 },
    });
    const a = up.geometries.get('spar')!.attributes.position.array;
    const b = down.geometries.get('spar')!.attributes.position.array;
    expect(a.length).toBe(b.length);
    expect(checksum(b)).not.toBe(checksum(a));
  });
});

// --- 6. the wind shapes it -----------------------------------------------------

describe('M6 cloth — the shape answers the wind the physics computed', () => {
  const trims = { ...AUTHORED_TRIM_RAD };

  function bellyDepth(sail: Sail, cloth: SailClothState): number {
    const belly = bellyVector(sail, stateWith(trims, cloth));
    return Math.hypot(belly.x, belly.y, belly.z);
  }

  it('fills and empties the cloth on the aero’s own attachment curve', () => {
    /**
     * Not "something that rises with AoA" — the drawn draft is the design
     * camber times `sailLuffFactor(aoa)`, the identical function the aero
     * multiplies CL by, so the ratio between two AoAs is that function's ratio
     * and nothing else.
     *
     * Asserted on `draftScale` rather than on the patch centre, and that is
     * where the first version of this test went wrong: the centre carries the
     * twist and the flogging wave too, and at 7° AoA the shake is at full
     * amplitude with a phase-0 value of −0.95 at `u = 0.5`. It was reading
     * three modes and calling the sum "the belly".
     */
    for (const sail of SAILS) {
      const reference = sailLoftLive(
        sail,
        stateWith(trims, clothState({ ...DRAWING, aoaDeg: 30 })),
      ).draftScale;
      for (const aoaDeg of [7, 8.5, 10, 14, 20]) {
        const live = sailLoftLive(
          sail,
          stateWith(trims, clothState({ ...DRAWING, aoaDeg })),
        );
        const expected = reference * (sailLuffFactor(aoaDeg) / sailLuffFactor(30));
        expect(live.draftScale, `${sail.name} at ${aoaDeg}° AoA`).toBeCloseTo(expected, 9);
      }
    }
  });

  it('empties a sail the aero calls luffing, and sets it moving', () => {
    for (const sail of SAILS) {
      const drawing = sailLoftLive(sail, stateWith(trims, clothState(DRAWING)));
      const luffing = sailLoftLive(sail, stateWith(trims, clothState(LUFFING)));
      expect(sailLuffFactor(LUFFING.aoaDeg!)).toBe(0);
      expect(luffing.draftScale, `${sail.name} luffing`).toBe(0);
      expect(drawing.draftScale, `${sail.name} drawing`).toBeGreaterThan(0.3);
      expect(luffing.shakeFraction, `${sail.name} luffing`).toBeGreaterThan(0);
      expect(drawing.shakeFraction, `${sail.name} drawing`).toBe(0);
    }
  });

  it('keeps the flogging wave to a plausible amplitude', () => {
    // The first cut of `CLOTH_CUTS` put a 1.2 m wave in the mainsail — 30% of
    // its chord, which the reach rail then had to clip. Real slatting canvas
    // moves a few per cent of its chord.
    const restore = applyRigTrim(trims);
    try {
      for (const sail of SAILS) {
        const live = sailLoftLive(sail, stateWith(trims, clothState(LUFFING)));
        const c = sail.corners.map((n) => rigNode(n));
        const [p0, p1, p2, p3] =
          c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
        const chord = Math.hypot(
          (p1.x + p2.x - p0.x - p3.x) / 2,
          (p1.y + p2.y - p0.y - p3.y) / 2,
          (p1.z + p2.z - p0.z - p3.z) / 2,
        );
        const amplitude = live.shakeFraction * chord;
        const where = `${sail.name} flogs ${amplitude.toFixed(2)} m`;
        expect(amplitude, where).toBeGreaterThan(0.05);
        expect(amplitude, where).toBeLessThan(0.6);
      }
    } finally {
      restore();
    }
  });

  it('flattens the cloth as the sheet hardens', () => {
    for (const sail of SAILS) {
      const key = (sail.name === 'mainGaffTopsail' ? 'mainsail' : sail.name) as SailName;
      const limits = RIG_TRIM_LIMITS[key];
      const eased: RigTrimAnglesRad = { ...AUTHORED_TRIM_RAD };
      const hard: RigTrimAnglesRad = { ...AUTHORED_TRIM_RAD };
      (eased as unknown as Record<string, number>)[key] = limits.maxDeg * DEG;
      (hard as unknown as Record<string, number>)[key] = limits.maxDeg * 0.3 * DEG;
      const measure = (t: RigTrimAnglesRad): number => {
        const restore = applyRigTrim(t);
        try {
          const belly = bellyVector(sail, stateWith(t, clothState(DRAWING)));
          // Against the sail's own chord, so swinging a boom does not read as
          // a change of shape.
          const c = sail.corners.map((n) => rigNode(n));
          const [p0, p1, p2, p3] =
            c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
          const chord = Math.hypot(
            (p1.x + p2.x - p0.x - p3.x) / 2,
            (p1.y + p2.y - p0.y - p3.y) / 2,
            (p1.z + p2.z - p0.z - p3.z) / 2,
          );
          return Math.hypot(belly.x, belly.y, belly.z) / chord;
        } finally {
          restore();
        }
      };
      expect(measure(hard), `${sail.name} hardened vs eased`).toBeLessThan(
        measure(eased),
      );
    }
  });

  it('softens a blanketed sail', () => {
    const restore = applyRigTrim(trims);
    try {
      for (const sail of SAILS) {
        const clear = bellyDepth(sail, clothState({ ...DRAWING, apparentSpeedMps: 2.2 }));
        const shadowed = bellyDepth(
          sail,
          clothState({ ...DRAWING, apparentSpeedMps: 2.2, blanketFactor: 0.5 }),
        );
        expect(shadowed, `${sail.name} blanketed`).toBeLessThan(clear);
      }
    } finally {
      restore();
    }
  });

  it('shakes slatting cloth and holds steady cloth still', () => {
    const restore = applyRigTrim(trims);
    try {
      for (const sail of SAILS) {
        const at = (cloth: SailClothState): Array<{ x: number; y: number; z: number }> => {
          const surface = sailSurface(sail, sailLoftLive(sail, stateWith(trims, cloth)));
          const points = [];
          for (let i = 1; i < 5; i++) for (let j = 1; j < 5; j++) points.push(surface(j / 5, i / 5));
          return points;
        };
        const spread = (
          a: Array<{ x: number; y: number; z: number }>,
          b: Array<{ x: number; y: number; z: number }>,
        ): number => {
          let worst = 0;
          for (let i = 0; i < a.length; i++) {
            worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y, a[i].z - b[i].z));
          }
          return worst;
        };
        const luffMove = spread(
          at(clothState(LUFFING, {}, 0)),
          at(clothState(LUFFING, {}, 0.12)),
        );
        expect(luffMove, `${sail.name} slatting`).toBeGreaterThan(0.01);
        const drawMove = spread(
          at(clothState(DRAWING, {}, 0)),
          at(clothState(DRAWING, {}, 0.12)),
        );
        expect(drawMove, `${sail.name} drawing`).toBe(0);
        // `?cloth=still` keeps the M6 shape and stops the clock.
        const stillMove = spread(
          at({ flow: flows({}, LUFFING), elapsedSeconds: 0, animate: false }),
          at({ flow: flows({}, LUFFING), elapsedSeconds: 0.12, animate: false }),
        );
        expect(stillMove, `${sail.name} frozen`).toBe(0);
      }
    } finally {
      restore();
    }
  });

  it('does not shake a sail that is firmly aback', () => {
    const restore = applyRigTrim(trims);
    try {
      for (const sail of SAILS) {
        const live = sailLoftLive(sail, stateWith(trims, clothState(ABACK)));
        expect(live.shakeFraction, `${sail.name} aback`).toBe(0);
      }
    } finally {
      restore();
    }
  });

  it('will not draw a sail full that the hand has given up on', () => {
    /**
     * The crew's sustained verdict caps attachment at the aero's own luffing
     * threshold, so a sail reported `cannotDraw` is never drawn more than half
     * filled however flattering this instant's AoA is — and the draft coming
     * off and the shake coming on are the same number moving, not two rules
     * that could disagree.
     *
     * The mechanism this replaced was a gain on the shake, and it was a no-op:
     * shake is `1 − attach`, already saturated at 1 throughout the luff band,
     * which is the only place the report is ever raised. Asserted at a
     * *drawing* AoA for exactly that reason — inside the band there is nothing
     * left to move.
     */
    for (const sail of SAILS) {
      const tended = sailLoftLive(sail, stateWith(trims, clothState(DRAWING)));
      const given = sailLoftLive(
        sail,
        stateWith(trims, clothState({ ...DRAWING, cannotDraw: true })),
      );
      expect(given.draftScale, `${sail.name} draft`).toBeLessThan(tended.draftScale);
      expect(given.draftScale, `${sail.name} draft`).toBeCloseTo(tended.draftScale * 0.5, 9);
      expect(given.shakeFraction, `${sail.name} shake`).toBeGreaterThan(
        tended.shakeFraction,
      );
      // Already flogging: the cap has nothing left to take, and must not
      // pretend otherwise.
      const alreadyGone = sailLoftLive(sail, stateWith(trims, clothState(LUFFING)));
      const alsoGone = sailLoftLive(
        sail,
        stateWith(trims, clothState({ ...LUFFING, cannotDraw: true })),
      );
      expect(alsoGone.shakeFraction, `${sail.name} luffing`).toBe(
        alreadyGone.shakeFraction,
      );
    }
  });

  it('keeps every mode inside its cut’s reach', () => {
    // The rail. Modes are independent and nothing else stops them stacking.
    const worstCase = clothState({
      aoaDeg: 30,
      apparentSpeedMps: 30,
      blanketFactor: 1,
      cannotDraw: true,
    });
    for (const fraction of [-1, -0.5, 0.5, 1]) {
      const t = Object.fromEntries(
        Object.keys(AUTHORED_TRIM_RAD).map((key) => {
          const limits = RIG_TRIM_LIMITS[key as SailName];
          const deg = fraction > 0 ? limits.maxDeg * fraction : limits.minDeg * -fraction;
          return [key, deg * DEG];
        }),
      ) as unknown as RigTrimAnglesRad;
      const restore = applyRigTrim(t);
      try {
        for (const sail of SAILS) {
          const surface = sailSurface(sail, sailLoftLive(sail, stateWith(t, worstCase)));
          const c = sail.corners.map((n) => rigNode(n));
          const [p0, p1, p2, p3] =
            c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
          const flat = (u: number, v: number) => {
            const l = (a: number, b: number, s: number): number => a + (b - a) * s;
            return {
              x: l(l(p0.x, p1.x, u), l(p3.x, p2.x, u), v),
              y: l(l(p0.y, p1.y, u), l(p3.y, p2.y, u), v),
              z: l(l(p0.z, p1.z, u), l(p3.z, p2.z, u), v),
            };
          };
          let worst = 0;
          for (let i = 0; i <= 12; i++) {
            for (let j = 0; j <= 12; j++) {
              const drawn = surface(j / 12, i / 12);
              const base = flat(j / 12, i / 12);
              worst = Math.max(
                worst,
                Math.hypot(drawn.x - base.x, drawn.y - base.y, drawn.z - base.z),
              );
            }
          }
          // The rail is a budget on the sum of the modes, so the realised
          // offset is at or under it with margin.
          expect(worst, `${sail.name} reach at ${fraction}`).toBeLessThanOrEqual(1.21);
        }
      } finally {
        restore();
      }
    }
  });
});
