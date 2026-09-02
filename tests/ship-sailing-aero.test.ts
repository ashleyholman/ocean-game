import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  SchoonerHorizontalDynamics,
  type HorizontalExternalForce,
} from '../src/vessel/schooner/SchoonerHorizontalDynamics';
import { SchoonerSailForces } from '../src/vessel/schooner/SchoonerSailForces';
import { buildSailingForceEvidence } from '../src/vessel/schooner/SailingForceEvidence';
import {
  BARE_POLES,
  BEATING_SAIL,
  FULL_SAIL,
  RIG_WINDAGE,
  SAIL_AERO_COEFFICIENTS,
  SAIL_AERO_FAMILIES,
  SAIL_AERO_GEOMETRY,
  SAIL_CLOTH_SHAPE,
  SEA_LEVEL_MODEL_Y,
  createSailAeroResult,
  evaluateSailAero,
  frozenSailStates,
  liveSailVariantGeometry,
  sailAbackCamber,
  sailAbackFactor,
  sailClMax,
  sailDragCoefficient,
  sailEffectiveAspectRatio,
  sailInducedDragCoefficient,
  sailLiftCoefficient,
  sailLuffFactor,
  sailShapeCamber,
  type SailAeroInput,
  type SailAeroResult,
} from '../src/vessel/schooner/sailAero';
import { sailLoftLive } from '../src/vessel/schooner/rigGeometry';
import { AUTHORED_TRIM_RAD, SAILS, rigNode } from '../src/vessel/schooner/rig';
import type { VesselHorizontalDynamicsBridge } from '../src/vessel/VesselMotion';
import { WorldWind } from '../src/world/WorldWind';

/**
 * S2a acceptance tests: derived sail geometry, the aero curves, the pinned
 * signs (rule 6: signs are set by measurement, never by reasoning), the
 * BuoyantBody external-wrench seam, and the dynamics-side force seam.
 *
 * The independent area check deliberately re-implements the two-triangle
 * quad measure locally, the same way `ship-rig.test.ts` keeps its own copy:
 * two implementations agreeing is the point of a pinned test.
 */

type V = { x: number; y: number; z: number };
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: V, b: V): V => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a: V): number => Math.hypot(a.x, a.y, a.z);

function independentArea(corners: readonly string[]): number {
  const c = corners.map(rigNode);
  const [a, b, cc, d] =
    c.length === 3 ? [c[0], c[0], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
  return (
    len(cross(sub(b, a), sub(cc, a))) / 2 + len(cross(sub(cc, a), sub(d, a))) / 2
  );
}

/** A rest-state evaluation input; tests override what they need. */
function baseInput(): SailAeroInput {
  return {
    trueWindWorldX: 0,
    trueWindWorldZ: 0,
    velocityWorldX: 0,
    velocityWorldY: 0,
    velocityWorldZ: 0,
    yawRad: 0,
    pitchRad: 0,
    rollRad: 0,
    yawRateRadPerSecond: 0,
    pitchRateRadPerSecond: 0,
    rollRateRadPerSecond: 0,
    // A symmetric reference point: the pure-maths mirror tests need comX 0
    // exactly; the real ship's centre of mass sits slightly to port because
    // her booms do, which is what the evidence's small tack-mirror residual
    // measures.
    comX: 0,
    comY: 2,
    comZ: 0,
    sails: frozenSailStates(FULL_SAIL, 'starboard'),
  };
}

function totals(result: SailAeroResult): {
  driveN: number;
  sideN: number;
} {
  let driveN = result.windage.forceModelZN;
  let sideN = result.windage.forceModelXN;
  for (const sail of result.perSail) {
    driveN += sail.forceModelZN;
    sideN += sail.forceModelXN;
  }
  return { driveN, sideN };
}

describe('derived sail geometry', () => {
  it('matches an independent area measure for every sail', () => {
    for (let i = 0; i < SAILS.length; i++) {
      const expected = independentArea(SAILS[i].corners);
      const derived = SAIL_AERO_GEOMETRY[i].variants.starboard.set!.areaM2;
      expect(Math.abs(derived - expected)).toBeLessThan(1e-9);
    }
  });

  it('carries a plausible total sail plan', () => {
    const total = SAIL_AERO_GEOMETRY.reduce(
      (sum, sail) => sum + sail.variants.starboard.set!.areaM2,
      0,
    );
    expect(total).toBeGreaterThan(150);
    expect(total).toBeLessThan(250);
    // The square topsail must clear the rig test's own distance-cue bound.
    const topsail = SAIL_AERO_GEOMETRY.find((s) => s.name === 'foreTopsail')!;
    expect(topsail.variants.starboard.set!.areaM2).toBeGreaterThan(33);
  });

  it('places every centre of effort inside its sail and above the deck', () => {
    for (let i = 0; i < SAILS.length; i++) {
      const corners = SAILS[i].corners.map(rigNode);
      const coe = SAIL_AERO_GEOMETRY[i].variants.starboard.set!.coe;
      for (const axis of ['x', 'y', 'z'] as const) {
        const values = corners.map((c) => c[axis]);
        expect(coe[axis]).toBeGreaterThanOrEqual(Math.min(...values) - 1e-9);
        expect(coe[axis]).toBeLessThanOrEqual(Math.max(...values) + 1e-9);
      }
      expect(coe.y).toBeGreaterThan(5);
    }
  });

  it('derives reefs that shrink area and lower the centre of effort', () => {
    for (const name of ['mainsail', 'foresail'] as const) {
      const sail = SAIL_AERO_GEOMETRY.find((s) => s.name === name)!;
      const set = sail.variants.starboard.set!;
      const reef1 = sail.variants.starboard.reef1!;
      expect(reef1.areaM2).toBeLessThan(set.areaM2);
      expect(reef1.coe.y).toBeLessThan(set.coe.y);
    }
    const mainsail = SAIL_AERO_GEOMETRY.find((s) => s.name === 'mainsail')!;
    expect(mainsail.variants.starboard.reef2!.areaM2).toBeLessThan(
      mainsail.variants.starboard.reef1!.areaM2,
    );
    // Reefs the design does not grant do not exist.
    const jib = SAIL_AERO_GEOMETRY.find((s) => s.name === 'jib')!;
    expect(jib.variants.starboard.reef1).toBeUndefined();
  });

  it('mirrors the port-tack geometry exactly', () => {
    for (const sail of SAIL_AERO_GEOMETRY) {
      const starboard = sail.variants.starboard.set!;
      const port = sail.variants.port.set!;
      expect(Math.abs(port.areaM2 - starboard.areaM2)).toBeLessThan(1e-9);
      expect(Math.abs(port.coe.x + starboard.coe.x)).toBeLessThan(1e-9);
      expect(Math.abs(port.coe.y - starboard.coe.y)).toBeLessThan(1e-9);
      expect(
        Math.abs(port.leewardNormal.x + starboard.leewardNormal.x),
      ).toBeLessThan(1e-12);
      expect(
        Math.abs(port.leewardNormal.z - starboard.leewardNormal.z),
      ).toBeLessThan(1e-12);
    }
  });

  it('lumps a small honest spar windage', () => {
    expect(RIG_WINDAGE.areaM2).toBeGreaterThan(10);
    expect(RIG_WINDAGE.areaM2).toBeLessThan(30);
    expect(RIG_WINDAGE.coe.y).toBeGreaterThan(5);
    expect(RIG_WINDAGE.coe.y).toBeLessThan(15);
  });
});

describe('live trim reproduces the frozen fixtures (S4)', () => {
  it('derives the frozen starboard table bit-exactly at authored trim and hoist', () => {
    for (const geometry of SAIL_AERO_GEOMETRY) {
      const sail = SAILS.find((s) => s.name === geometry.name)!;
      const authoredDeg =
        (sail.name === 'mainGaffTopsail'
          ? AUTHORED_TRIM_RAD.mainsail
          : AUTHORED_TRIM_RAD[sail.name as keyof typeof AUTHORED_TRIM_RAD]) *
        (180 / Math.PI);
      for (const [state, frozen] of Object.entries(geometry.variants.starboard)) {
        const hoist =
          state === 'set'
            ? 1
            : 1 -
              SAIL_AERO_COEFFICIENTS.reefHoistFraction[state as 'reef1' | 'reef2'];
        const live = liveSailVariantGeometry(sail.name, authoredDeg, hoist);
        // toBe, not toBeCloseTo: the live path re-runs the same constructors
        // and reductions the frozen table was built with. Any drift here is
        // a second geometric truth sneaking in.
        expect(live.areaM2, `${sail.name} ${state} area`).toBe(frozen.areaM2);
        expect(live.coe.x, `${sail.name} ${state} coe.x`).toBe(frozen.coe.x);
        expect(live.coe.y, `${sail.name} ${state} coe.y`).toBe(frozen.coe.y);
        expect(live.coe.z, `${sail.name} ${state} coe.z`).toBe(frozen.coe.z);
        expect(live.leewardNormal.x, `${sail.name} ${state} n.x`).toBe(
          frozen.leewardNormal.x,
        );
        expect(live.leewardNormal.y, `${sail.name} ${state} n.y`).toBe(
          frozen.leewardNormal.y,
        );
        expect(live.leewardNormal.z, `${sail.name} ${state} n.z`).toBe(
          frozen.leewardNormal.z,
        );
      }
    }
  });

  it('mirrors the frozen port table at the negated trim to rounding error', () => {
    for (const geometry of SAIL_AERO_GEOMETRY) {
      const sail = SAILS.find((s) => s.name === geometry.name)!;
      const authoredDeg =
        (sail.name === 'mainGaffTopsail'
          ? AUTHORED_TRIM_RAD.mainsail
          : AUTHORED_TRIM_RAD[sail.name as keyof typeof AUTHORED_TRIM_RAD]) *
        (180 / Math.PI);
      const frozen = geometry.variants.port.set!;
      const live = liveSailVariantGeometry(sail.name, -authoredDeg, 1, -authoredDeg);
      // The frozen port table was built by reflecting corner coordinates in
      // the same list order; the live path swings constructors to the other
      // side, which for the square topsail lands the same physical corners
      // in side-swapped list positions. Same cloth, different rounding path
      // — so this pin is 12 digits, not bits.
      expect(live.areaM2).toBeCloseTo(frozen.areaM2, 9);
      expect(live.coe.x).toBeCloseTo(frozen.coe.x, 12);
      expect(live.coe.y).toBeCloseTo(frozen.coe.y, 12);
      expect(live.coe.z).toBeCloseTo(frozen.coe.z, 12);
      expect(live.leewardNormal.x).toBeCloseTo(frozen.leewardNormal.x, 12);
      expect(live.leewardNormal.y).toBeCloseTo(frozen.leewardNormal.y, 12);
      expect(live.leewardNormal.z).toBeCloseTo(frozen.leewardNormal.z, 12);
    }
  });
});

describe('aero curves', () => {
  it('rises to CLmax at the peak and stalls softly', () => {
    for (const family of ['boomGaff', 'headsail', 'square'] as const) {
      const camber = 0.08;
      const clMax = sailClMax(family, camber);
      expect(sailLiftCoefficient(0, family, camber)).toBe(0);
      const peak = SAIL_AERO_COEFFICIENTS.aoaPeakDeg;
      let best = 0;
      let bestAoa = 0;
      let previous = sailLiftCoefficient(0, family, camber);
      for (let aoa = 0.25; aoa <= 90; aoa += 0.25) {
        const cl = sailLiftCoefficient(aoa, family, camber);
        expect(Math.abs(cl - previous)).toBeLessThan(0.02 * clMax);
        previous = cl;
        if (cl > best) {
          best = cl;
          bestAoa = aoa;
        }
      }
      expect(Math.abs(best - clMax)).toBeLessThan(1e-6);
      expect(Math.abs(bestAoa - peak)).toBeLessThan(0.5);
      expect(
        sailLiftCoefficient(90, family, camber) / clMax,
      ).toBeCloseTo(SAIL_AERO_COEFFICIENTS.stallFloor, 6);
    }
  });

  it('anchors drag at the stated base and flat-on values', () => {
    for (const family of ['boomGaff', 'headsail', 'square'] as const) {
      const f = SAIL_AERO_FAMILIES[family];
      expect(sailDragCoefficient(0, family)).toBeCloseTo(f.cd0, 9);
      expect(sailDragCoefficient(90, family)).toBeCloseTo(f.cd90, 9);
    }
    // The design anchor: the square topsail is drag-dominant square-on.
    expect(SAIL_AERO_FAMILIES.square.cd90).toBeCloseTo(1.2, 9);
  });

  it('collapses across the luff band', () => {
    const { luffEndDeg, luffBandDeg } = SAIL_AERO_COEFFICIENTS;
    expect(sailLuffFactor(luffEndDeg - luffBandDeg)).toBe(0);
    expect(sailLuffFactor(-5)).toBe(0);
    expect(sailLuffFactor(luffEndDeg)).toBe(1);
    expect(sailLuffFactor(45)).toBe(1);
  });
});

describe('the coefficient block (S6c)', () => {
  it('derives an aspect ratio with both image limits right', () => {
    // A sail whose foot touches the water is half of a wing of twice the
    // aspect ratio. One high in the air keeps its own. Nothing in between
    // may leave the bracket.
    const span = 10;
    const area = 40;
    const geometric = (span * span) / area;
    expect(sailEffectiveAspectRatio(span, area, 0)).toBeCloseTo(2 * geometric, 9);
    expect(sailEffectiveAspectRatio(span, area, 1e9)).toBeCloseTo(geometric, 6);
    let previous = Infinity;
    for (let gap = 0; gap <= 40; gap += 0.5) {
      const value = sailEffectiveAspectRatio(span, area, gap);
      expect(value).toBeLessThanOrEqual(2 * geometric + 1e-9);
      expect(value).toBeGreaterThanOrEqual(geometric - 1e-9);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
    // Degenerate cloth cannot divide by zero.
    expect(Number.isFinite(sailEffectiveAspectRatio(0, 0, 0))).toBe(true);
  });

  it('makes the gaff sails and the square topsail the low-aspect ones', () => {
    // THE FINDING (S4-1) AS AN ASSERTION: the two workhorses and the square
    // topsail are the surfaces that pay for their lift, and it falls out of
    // the rig's geometry rather than being asserted anywhere.
    const at = (name: Parameters<typeof liveSailVariantGeometry>[0]) => {
      const key = name === 'mainGaffTopsail' ? 'mainsail' : name;
      const trimDeg =
        (AUTHORED_TRIM_RAD[key as keyof typeof AUTHORED_TRIM_RAD] * 180) /
        Math.PI;
      return liveSailVariantGeometry(
        name,
        trimDeg,
        1,
        (AUTHORED_TRIM_RAD.mainsail * 180) / Math.PI,
      );
    };
    const topsail = at('foreTopsail');
    const mainsail = at('mainsail');
    const jib = at('jib');
    // The square topsail is the lowest-aspect surface aboard, and it is high
    // enough that the sea's mirror barely reaches it.
    expect(topsail.aspectRatioEff).toBeLessThan(1.5);
    expect(topsail.footAboveSeaM / topsail.spanM).toBeGreaterThan(1);
    // A gaff main is a low-aspect sail; a jib on a bowsprit is not.
    expect(mainsail.aspectRatioEff).toBeLessThan(4);
    expect(jib.aspectRatioEff).toBeGreaterThan(2.5 * mainsail.aspectRatioEff);
    // The sea plane is the waterline, not the baseline: every foot is above
    // it, so no sail gets the clamped zero-gap case by accident.
    for (const sail of SAILS) {
      expect(at(sail.name).footAboveSeaM, sail.name).toBeGreaterThan(0);
    }
    expect(SEA_LEVEL_MODEL_Y).toBeGreaterThan(0);
  });

  it('charges CL²/(π·AR·e), so low aspect pays more for the same lift', () => {
    const cl = 1.1;
    const low = sailInducedDragCoefficient(cl, 1.14);
    const high = sailInducedDragCoefficient(cl, 10.4);
    expect(low).toBeCloseTo(
      (cl * cl) / (Math.PI * 1.14 * SAIL_AERO_COEFFICIENTS.spanEfficiency),
      12,
    );
    expect(low / high).toBeCloseTo(10.4 / 1.14, 9);
    // Quadratic in the lift, and free when there is none.
    expect(sailInducedDragCoefficient(0, 3)).toBe(0);
    expect(sailInducedDragCoefficient(2 * cl, 3)).toBeCloseTo(
      4 * sailInducedDragCoefficient(cl, 3),
      12,
    );
    // Sign-blind: a backed sail pays for the lift it carries backwards.
    expect(sailInducedDragCoefficient(-cl, 3)).toBeCloseTo(
      sailInducedDragCoefficient(cl, 3),
      12,
    );
    // Below the rudder's clean-blade efficiency, deliberately.
    expect(SAIL_AERO_COEFFICIENTS.spanEfficiency).toBeLessThan(0.9);
  });

  it('hands over from drawing to aback through a band that carries neither', () => {
    // FINDING S4-2's shape. `sailLuffFactor` and `sailAbackFactor` are the
    // two branches; between them is the cloth that flogs.
    expect(sailAbackFactor(5)).toBe(0);
    expect(sailAbackFactor(0)).toBe(0);
    expect(sailAbackFactor(-SAIL_AERO_COEFFICIENTS.abackFullDeg)).toBe(1);
    expect(sailAbackFactor(-90)).toBe(1);
    expect(sailAbackFactor(-6)).toBeGreaterThan(0);
    expect(sailAbackFactor(-6)).toBeLessThan(1);
    // The flogging band: a few degrees each side of zero where the luff
    // factor has not opened and the aback fill has barely started.
    expect(sailLuffFactor(2) + sailAbackFactor(2)).toBeLessThan(0.5);
    // Monotone in how far aback she is.
    let previous = -1;
    for (let aoa = 0; aoa >= -20; aoa -= 0.25) {
      const value = sailAbackFactor(aoa);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
  });

  it('reads CLmax from the camber the cloth is drawn at, not the design one', () => {
    // SHIP_RIG_HANDOVER §11.6. A hard sheet flattens the sail, and the
    // coefficient has to know — the M6 cloth already drew it that way.
    const sail = SAILS.find((s) => s.name === 'mainsail')!;
    const hard = sailShapeCamber('mainsail', sail.camber, 12);
    const working = sailShapeCamber('mainsail', sail.camber, 20);
    const eased = sailShapeCamber('mainsail', sail.camber, 46);
    expect(hard).toBeLessThan(working);
    expect(working).toBeLessThan(eased);
    // Eased to the mechanical stop there is no flattening left to do.
    expect(eased).toBeCloseTo(sail.camber, 9);
    expect(sailClMax('boomGaff', working)).toBeLessThan(
      sailClMax('boomGaff', sail.camber),
    );
    // The centreline ramp: a sail crossing amidships has no belly either way.
    expect(sailShapeCamber('mainsail', sail.camber, 0)).toBe(0);
    expect(sailAbackCamber('mainsail', sail.camber, 0)).toBe(0);
    // The square topsail's cloth rotates with its yard and never crosses.
    const topsail = SAILS.find((s) => s.name === 'foreTopsail')!;
    expect(sailShapeCamber('foreTopsail', topsail.camber, 0)).toBeGreaterThan(0);
    // Backed, every sail is shallower than it is drawing — that is what the
    // aback fraction means — and the square topsail is the shallowest.
    for (const s of SAILS) {
      const key = s.name === 'mainGaffTopsail' ? 'mainsail' : s.name;
      const trimDeg =
        (AUTHORED_TRIM_RAD[key as keyof typeof AUTHORED_TRIM_RAD] * 180) /
        Math.PI;
      expect(sailAbackCamber(s.name, s.camber, trimDeg), s.name).toBeLessThan(
        sailShapeCamber(s.name, s.camber, trimDeg),
      );
    }
    expect(SAIL_CLOTH_SHAPE.foreTopsail.aback).toBeLessThan(
      SAIL_CLOTH_SHAPE.mainsail.aback,
    );
  });

  it('gives the loft and the coefficient ONE camber, not two that agree', () => {
    // The M6 lesson (§11.4: two copies of the belly normal). `rigGeometry`
    // must not hold its own flatten/aback numbers — it reads this table, so
    // the drawn draft and CLmax cannot drift apart.
    const sail = SAILS.find((s) => s.name === 'mainsail')!;
    const trimDeg = 24;
    const trims = { ...AUTHORED_TRIM_RAD, mainsail: (trimDeg * Math.PI) / 180 };
    const hoists = Object.fromEntries(
      SAILS.map((s) => [s.name, 1]),
    ) as Record<(typeof SAILS)[number]['name'], number>;
    const drawing = sailLoftLive(sail, {
      trims,
      hoists,
      cloth: {
        animate: false,
        elapsedSeconds: 0,
        flow: {
          mainsail: {
            aoaDeg: 40,
            apparentSpeedMps: 12,
            blanketFactor: 1,
            cannotDraw: false,
          },
        },
      } as never,
    });
    // Well past the luff band and well clear of light airs, the loft's own
    // draft scale reduces to exactly the shape camber this module exports.
    expect(sail.camber * drawing.camberScale * drawing.draftScale).toBeCloseTo(
      sailShapeCamber('mainsail', sail.camber, trimDeg),
      12,
    );
    const backed = sailLoftLive(sail, {
      trims,
      hoists,
      cloth: {
        animate: false,
        elapsedSeconds: 0,
        flow: {
          mainsail: {
            aoaDeg: -40,
            apparentSpeedMps: 12,
            blanketFactor: 1,
            cannotDraw: false,
          },
        },
      } as never,
    });
    expect(sail.camber * backed.camberScale * backed.draftScale).toBeCloseTo(
      -sailAbackCamber('mainsail', sail.camber, trimDeg),
      12,
    );
  });

  it('carries a backed sail as negative lift and pressed drag', () => {
    // Head to wind at rest with everything sheeted, the square topsail is
    // hard aback and must now be a brake rather than a bystander.
    const input = baseInput();
    input.trueWindWorldZ = -8;
    const out = evaluateSailAero(input, createSailAeroResult());
    const topsail = out.perSail.find((s) => s.name === 'foreTopsail')!;
    expect(topsail.aoaDeg).toBeLessThan(-20);
    expect(topsail.liftCoefficient).toBeLessThan(0);
    expect(topsail.camberDrawn).toBeLessThan(0);
    // Pressed cloth, not a shivering rag: well above `cdLuffing`.
    expect(topsail.dragCoefficient).toBeGreaterThan(
      10 * SAIL_AERO_COEFFICIENTS.cdLuffing,
    );
    expect(topsail.inducedDragCoefficient).toBeGreaterThanOrEqual(0);
    // And it is pushing her astern hard, which is the measured consequence.
    expect(topsail.forceModelZN).toBeLessThan(-500);
  });

  it('is quicker close-hauled with the square topsail handed', () => {
    // The BEATING_SAIL canvas earns its place: at a close-hauled apparent
    // wind, handing the one sail that cannot be braced to draw INCREASES
    // total drive, which no version of this model could say before S6c.
    const angle = (35 * Math.PI) / 180;
    const drive = (sails: SailAeroInput['sails']) => {
      const input = baseInput();
      input.trueWindWorldX = 8 * Math.sin(angle);
      input.trueWindWorldZ = -8 * Math.cos(angle);
      input.sails = sails;
      return totals(evaluateSailAero(input, createSailAeroResult())).driveN;
    };
    const full = drive(frozenSailStates(FULL_SAIL, 'starboard'));
    const handed = drive(frozenSailStates(BEATING_SAIL, 'starboard'));
    expect(handed).toBeGreaterThan(full);
  });
});

describe('pinned force signs (measured, not reasoned)', () => {
  it('drives forward and heels to leeward on a starboard-wind beam reach', () => {
    const input = baseInput();
    // Wind blowing toward +x at yaw 0 = over the starboard rail toward port.
    input.trueWindWorldX = 8;
    const out = evaluateSailAero(input, createSailAeroResult());
    const { driveN, sideN } = totals(out);
    expect(driveN).toBeGreaterThan(1000);
    expect(sideN).toBeGreaterThan(2000);
    // Heel away from the wind. The convention this pins: negative roll is
    // port side down — asserted against the body transform below.
    expect(out.rollTorqueNm).toBeLessThan(-10_000);
    // Weather helm: she rounds up toward a starboard wind (bow to −x).
    expect(out.yawMomentNm).toBeLessThan(-1000);
  });

  it('confirms negative roll is port side down on the real body transform', () => {
    const body = buildSchoonerBuoyancy();
    body.roll = -0.1;
    const port = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };
    const starboard = { x: 0, y: 0, z: 0, fx: 0, fz: 0 };
    body.transform(1, 0, 0, 0, port);
    body.transform(-1, 0, 0, 0, starboard);
    expect(port.y).toBeLessThan(starboard.y);
  });

  it('is dead in the no-go zone and pushed astern by windage', () => {
    const input = baseInput();
    // Wind from dead ahead blows toward the stern: toward −z at yaw 0.
    input.trueWindWorldZ = -8;
    const out = evaluateSailAero(input, createSailAeroResult());
    expect(out.luffingCount).toBe(8);
    expect(totals(out).driveN).toBeLessThan(0);
  });

  it('runs downwind under drag', () => {
    const input = baseInput();
    // Wind from dead astern blows toward the bow: toward +z at yaw 0.
    input.trueWindWorldZ = 8;
    const out = evaluateSailAero(input, createSailAeroResult());
    expect(totals(out).driveN).toBeGreaterThan(500);
  });

  it('mirrors the pure aero exactly across tacks', () => {
    const starboardInput = baseInput();
    starboardInput.trueWindWorldX = 8;
    starboardInput.trueWindWorldZ = -3;
    const starboard = evaluateSailAero(starboardInput, createSailAeroResult());
    const portInput = baseInput();
    portInput.trueWindWorldX = -8;
    portInput.trueWindWorldZ = -3;
    portInput.sails = frozenSailStates(FULL_SAIL, 'port');
    const port = evaluateSailAero(portInput, createSailAeroResult());
    const s = totals(starboard);
    const p = totals(port);
    expect(Math.abs(s.driveN - p.driveN)).toBeLessThan(1e-6 * Math.abs(s.driveN));
    expect(Math.abs(s.sideN + p.sideN)).toBeLessThan(1e-6 * Math.abs(s.sideN));
    expect(
      Math.abs(starboard.rollTorqueNm + port.rollTorqueNm),
    ).toBeLessThan(1e-6 * Math.abs(starboard.rollTorqueNm));
    expect(
      Math.abs(starboard.yawMomentNm + port.yawMomentNm),
    ).toBeLessThan(1e-6 * Math.abs(starboard.yawMomentNm) + 1e-9);
  });

  it('feeds heel into the angle of attack instead of a cosine fudge', () => {
    // Close-hauled, wind 55° off the starboard bow — the frozen trim's
    // near-peak sector, where less angle means less lift.
    const angle = (55 * Math.PI) / 180;
    const upright = baseInput();
    upright.trueWindWorldX = 8 * Math.sin(angle);
    upright.trueWindWorldZ = -8 * Math.cos(angle);
    const uprightOut = evaluateSailAero(upright, createSailAeroResult());
    const heeled = baseInput();
    heeled.trueWindWorldX = upright.trueWindWorldX;
    heeled.trueWindWorldZ = upright.trueWindWorldZ;
    heeled.rollRad = -0.5;
    const heeledOut = evaluateSailAero(heeled, createSailAeroResult());
    // Attitude reaches the geometry: the mainsail's AoA genuinely moves.
    // (Which way the eight-sail *sum* moves at moderate heel is not signed —
    // sails below the lift peak gain while sails past it lose.)
    const uprightMain = uprightOut.perSail.find((s) => s.name === 'mainsail')!;
    const heeledMain = heeledOut.perSail.find((s) => s.name === 'mainsail')!;
    expect(Math.abs(heeledMain.aoaDeg - uprightMain.aoaDeg)).toBeGreaterThan(2);
    // The robust endpoint: laid nearly on her beam ends the cloth is almost
    // edge-on to a horizontal wind and the drive collapses.
    const flattened = baseInput();
    flattened.trueWindWorldX = upright.trueWindWorldX;
    flattened.trueWindWorldZ = upright.trueWindWorldZ;
    flattened.rollRad = -1.4;
    const flattenedOut = evaluateSailAero(flattened, createSailAeroResult());
    expect(totals(flattenedOut).driveN).toBeLessThan(
      0.5 * totals(uprightOut).driveN,
    );
  });
});

describe('BuoyantBody external wrench seam', () => {
  it('is inert by default, bit for bit', { tags: ['slow', 'sailing'] }, () => {
    const untouched = buildSchoonerBuoyancy();
    const written = buildSchoonerBuoyancy();
    const wavesA = new WaveField(findSeaState('CURRENT_MODERATE'));
    const wavesB = new WaveField(findSeaState('CURRENT_MODERATE'));
    for (let i = 0; i < 600; i++) {
      // Writing explicit zeros must be indistinguishable from never writing.
      written.externalWrench.forceYN = 0;
      written.externalWrench.pitchTorqueNm = 0;
      written.externalWrench.rollTorqueNm = 0;
      untouched.update(1 / 60, wavesA, 0, 0, 0);
      written.update(1 / 60, wavesB, 0, 0, 0);
    }
    expect(written.roll).toBe(untouched.roll);
    expect(written.pitch).toBe(untouched.pitch);
    expect(written.comWorldY).toBe(untouched.comWorldY);
    expect(written.velocityY).toBe(untouched.velocityY);
    expect(written.externalWrenchWorkJ).toBe(0);
    expect(untouched.externalWrenchWorkJ).toBe(0);
  });

  it('heels under a constant roll torque and tracks its work', () => {
    const body = buildSchoonerBuoyancy();
    const waves = new WaveField(findSeaState('FLAT'));
    body.externalWrench.rollTorqueNm = -60_000;
    for (let i = 0; i < 1800; i++) body.update(1 / 60, waves, 0, 0, 0);
    expect(body.roll).toBeLessThan(-0.01);
    expect(body.roll).toBeGreaterThan(-0.35);
    expect(body.externalWrenchWorkJ).toBeGreaterThan(0);
  });

  it('floats higher under a constant upward force', () => {
    const control = buildSchoonerBuoyancy();
    const lifted = buildSchoonerBuoyancy();
    const wavesA = new WaveField(findSeaState('FLAT'));
    const wavesB = new WaveField(findSeaState('FLAT'));
    lifted.externalWrench.forceYN = 40_000;
    for (let i = 0; i < 1200; i++) {
      control.update(1 / 60, wavesA, 0, 0, 0);
      lifted.update(1 / 60, wavesB, 0, 0, 0);
    }
    expect(lifted.comWorldY).toBeGreaterThan(control.comWorldY + 0.005);
  });
});

describe('dynamics external-force seam', () => {
  function freeBridge(): VesselHorizontalDynamicsBridge {
    return {
      mode: 'free',
      towVelocityWorldMps: { x: 0, z: 0 },
      towYawRad: 0,
      commitStep() {},
    };
  }

  it('reports zero external work and force with no provider', () => {
    const body = buildSchoonerBuoyancy();
    const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
    const waves = new WaveField(findSeaState('FLAT'));
    const velocity = { x: 0, z: 3 };
    let result = dynamics.advance(0, body, waves, 0, 0, velocity, 0, 0, freeBridge());
    for (let i = 0; i < 120; i++) {
      result = dynamics.advance(
        1 / 60,
        body,
        waves,
        0,
        0,
        velocity,
        result.yawRad,
        result.yawRateRadPerSecond,
        freeBridge(),
      );
    }
    expect(result.externalWorkJ).toBe(0);
    expect(result.externalForce.forceWorldXN).toBe(0);
    expect(result.externalForce.forceWorldZN).toBe(0);
    expect(result.externalForce.yawMomentNm).toBe(0);
  });

  it('makes a becalmed bare-poled provider bit-identical to no provider', () => {
    // FLAT water is calm to denormal noise, not to the last bit, so the pin
    // is not "exactly zero velocity" — it is that attaching the provider
    // with no wind and no canvas changes nothing at all.
    const run = (attachProvider: boolean) => {
      const body = buildSchoonerBuoyancy();
      const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
      const waves = new WaveField(findSeaState('FLAT'));
      if (attachProvider) {
        const worldWind = new WorldWind();
        worldWind.setMean(0, 0, 0);
        const sails = new SchoonerSailForces(worldWind);
        sails.canvas = BARE_POLES;
        dynamics.externalForces = sails;
        dynamics.reset();
      }
      const velocity = { x: 0, z: 0 };
      let result = dynamics.advance(0, body, waves, 0, 0, velocity, 0, 0, freeBridge());
      for (let i = 0; i < 300; i++) {
        result = dynamics.advance(
          1 / 60,
          body,
          waves,
          0,
          0,
          velocity,
          result.yawRad,
          result.yawRateRadPerSecond,
          freeBridge(),
        );
      }
      return { velocity, yawRad: result.yawRad, externalWorkJ: result.externalWorkJ };
    };
    const bare = run(true);
    const passive = run(false);
    expect(bare.velocity.x).toBe(passive.velocity.x);
    expect(bare.velocity.z).toBe(passive.velocity.z);
    expect(bare.yawRad).toBe(passive.yawRad);
    expect(bare.externalWorkJ).toBe(0);
  });

  it('writes the body wrench and the horizontal force in one evaluation', () => {
    const body = buildSchoonerBuoyancy();
    const worldWind = new WorldWind();
    worldWind.setMean(8, 90, 0);
    const sails = new SchoonerSailForces(worldWind);
    const out: HorizontalExternalForce = {
      forceWorldXN: 0,
      forceWorldZN: 0,
      yawMomentNm: 0,
    };
    sails.evaluateSubstep(1 / 240, body, 0, 0, 0, 0, out);
    expect(Math.abs(out.forceWorldXN)).toBeGreaterThan(100);
    expect(Math.abs(body.externalWrench.rollTorqueNm)).toBeGreaterThan(1000);
  });

  it('is caller-rate invariant with sails drawing', { timeout: 30_000 }, () => {
    const run = (callerHz: number) => {
      const body = buildSchoonerBuoyancy();
      const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
      const waves = new WaveField(findSeaState('FLAT'));
      const worldWind = new WorldWind();
      worldWind.setMean(8, 90, 1);
      const sails = new SchoonerSailForces(worldWind);
      dynamics.externalForces = sails;
      dynamics.reset();
      const velocity = { x: 0, z: 0 };
      let result = dynamics.advance(0, body, waves, 0, 0, velocity, 0, 0, freeBridge());
      const callers = Math.round(6 * callerHz);
      for (let i = 0; i < callers; i++) {
        result = dynamics.advance(
          1 / callerHz,
          body,
          waves,
          0,
          0,
          velocity,
          result.yawRad,
          result.yawRateRadPerSecond,
          freeBridge(),
        );
      }
      return { velocity, result };
    };
    const slow = run(30);
    const fast = run(240);
    expect(slow.velocity.x).toBe(fast.velocity.x);
    expect(slow.velocity.z).toBe(fast.velocity.z);
    expect(slow.result.yawRad).toBe(fast.result.yawRad);
    expect(slow.result.externalWorkJ).toBe(fast.result.externalWorkJ);
  });
});

describe('sailing force evidence contract', () => {
  // The full builder: captive sweep, gust energy run, invariance pairs —
  // the suite's single heaviest test, tens of seconds of simulated physics
  // even unloaded. The budget is headroom, not a target; the same gates also
  // run in `npm run ship:sailing`, so a hang here cannot hide a regression.
  it('builds and passes every gate', {
    tags: ['slow', 'sailing'],
    timeout: 300_000,
  }, () => {
    const evidence = buildSailingForceEvidence();
    const gates = evidence.captiveSweep.gates;
    // The no-go zone is dead: head to wind she is pushed astern.
    expect(gates.driveDeadAheadN).toBeLessThan(0);
    // Best drive on the drawing tack's reach sector, and substantial.
    expect(gates.bestDriveAngleDeg).toBeGreaterThan(-140);
    expect(gates.bestDriveAngleDeg).toBeLessThan(-50);
    expect(gates.bestDriveN).toBeGreaterThan(3000);
    // Mirrored tack mirrors to within the ship's real (booms-to-port)
    // centre-of-mass asymmetry.
    expect(gates.tackMirrorRelativeError).toBeLessThan(1e-3);
    expect(gates.heelAlwaysToLeewardWhileDrawing).toBe(true);
    // Head to wind, every sail luffs.
    const deadAhead = evidence.captiveSweep.entries.find(
      (entry) => entry.windAngleOffBowDeg === 0,
    )!;
    expect(deadAhead.luffingCount).toBe(8);

    // The generalised energy gate: kinetic energy never beats wind work.
    expect(evidence.freeRuns.gustEnergy.maxEnergyOverWorkJ).toBeLessThanOrEqual(
      1e-6,
    );
    expect(evidence.freeRuns.gustEnergy.finalSpeedMps).toBeLessThan(
      evidence.freeRuns.gustEnergy.hullSpeedBoundMps,
    );
    expect(evidence.freeRuns.gustEnergy.finalSpeedMps).toBeGreaterThan(1);
    // Becalmed bare poles: exactly nothing.
    expect(evidence.freeRuns.zeroWindBarePoles.finalSpeedMps).toBe(0);
    expect(evidence.freeRuns.zeroWindBarePoles.externalWorkJ).toBe(0);

    // Invariance with sails drawing, on the pure-time gust grid.
    expect(evidence.invariance.callerRate.velocityErrorMps).toBeLessThan(1e-9);
    expect(evidence.invariance.callerRate.yawErrorRad).toBeLessThan(1e-9);
    expect(evidence.invariance.callerRate.externalWorkErrorJ).toBeLessThan(1e-6);
    expect(
      evidence.invariance.voyageCompression.localVelocityErrorMps,
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(evidence.invariance.voyageCompression.globalDistanceRatio - 30),
    ).toBeLessThan(1e-6);
  });
});
