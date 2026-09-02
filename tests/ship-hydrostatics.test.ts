import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import {
  buildSchoonerBuoyancy,
  measureRollDecay,
} from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  CABIN_AFT_Z,
  CABIN_FORWARD_Z,
  DESIGN_DRAUGHT,
  HULL_LENGTH,
  MAX_BEAM,
  QUARTERDECK_RISE,
  STATION_COUNT,
  STATION_SPACING,
} from '../src/vessel/schooner/hullForm';
import {
  BELOW_DECKS_SPACES,
  belowDecksSoleArea,
  cabinHeadroomAt,
  cabinSoleArea,
  spaceSoleArea,
} from '../src/vessel/schooner/deckInterior';
import {
  RHO_WATER,
  displacedVolume,
  hullStations,
  hydrostaticsAt,
  solveWaterline,
} from '../src/vessel/schooner/hydrostatics';
import { createSectionImmersion } from '../src/vessel/schooner/hullSection';
import { buildLoadedShip } from '../src/vessel/schooner/massModel';

/**
 * M0 acceptance, from `docs/ship/SHIP_ROUND_HANDOVER.md` section 6.
 *
 * These are the gates the hull has to pass before anything visible is built on
 * it. They assert *outcomes* — displacement, stability, trim, the roll period
 * the integrator actually produces — never the shape parameters that produce
 * them, so the hull can be re-faired without rewriting the test.
 *
 * Bands rather than point values, deliberately. A hull is faired to land inside
 * a range; pinning it to twelve digits would make every future adjustment look
 * like a regression. The one exception is the raft, which is pinned exactly in
 * `raft-buoyancy-golden.test.ts` because there the requirement genuinely is
 * "nothing moved".
 */

describe('hull form', () => {
  it('keeps the principal dimensions the spec fixes', () => {
    expect(HULL_LENGTH).toBe(15.5);
    expect(MAX_BEAM).toBe(5.0);
    expect(DESIGN_DRAUGHT).toBe(2.3);
    // Spec section 6 allows 0.45–0.55 m and no more.
    expect(QUARTERDECK_RISE).toBeGreaterThanOrEqual(0.45);
    expect(QUARTERDECK_RISE).toBeLessThanOrEqual(0.55);
  });

  it('samples the sea finely enough to inherit the raft s Nyquist argument', () => {
    expect(STATION_COUNT).toBe(39);
    // The raft settled on 0.40 m; anything coarser aliased a 1.5 m wave into a
    // spurious low-frequency pitching moment. See BuoyantBody's station note.
    expect(STATION_SPACING).toBeLessThanOrEqual(0.4);
  });
});

describe('still-water hydrostatics at the design draught', () => {
  const h = hydrostaticsAt(DESIGN_DRAUGHT);

  it('displaces what the spec requires', () => {
    // Moulded — the fair body the offsets draw. This is the figure the hull was
    // faired to and it has not moved since M0.
    expect(h.mouldedVolume).toBeGreaterThan(75);
    expect(h.mouldedVolume).toBeLessThan(77);
    // Total, including the backbone and rudder. This is what floats her.
    expect(h.volume).toBeGreaterThan(78);
    expect(h.volume).toBeLessThan(81);
    expect(h.displacement / 1000).toBeGreaterThan(79.5);
    expect(h.displacement / 1000).toBeLessThan(82.5);
  });

  it('counts the timber below the rabbet, which M0 did not', () => {
    // The backbone and rudder were given mass and no volume: she weighed
    // something and pushed back with nothing. See `backbone.ts` and spec 4.2.
    expect(h.volume).toBeCloseTo(h.mouldedVolume + h.appendageVolume, 9);

    // The deeper dragged keel, curved forefoot/deadwood and matching rudder are
    // 5.7% of displacement. Keep this as a band because the appendages remain
    // shaped geometry, but do not let them silently double: every percent is
    // ballast and therefore feeds back into KG and roll.
    const share = h.appendageVolume / h.volume;
    expect(share).toBeGreaterThan(0.048);
    expect(share).toBeLessThan(0.068);
  });

  it('never lets the moulded body and an appendage pierce the surface together', () => {
    // `hydrostaticsAt` treats each station's waterline chord as one span centred
    // on the centreline when it takes the (2/3)b^3 second moment. That is exact
    // only while no station is cut through both the fair body and the backbone —
    // true here because the backbone shows above the moulded forefoot only
    // forward of where the fair body has left the water entirely. Re-fair the
    // ends and this could stop holding, and BM would over-read in silence.
    const scratch = createSectionImmersion();
    for (const st of hullStations()) {
      st.moulded.immerse(DESIGN_DRAUGHT, 0, scratch);
      const mouldedChord = scratch.chord;
      let appendageChord = 0;
      for (const a of st.appendages) {
        a.immerse(DESIGN_DRAUGHT, 0, scratch);
        appendageChord += scratch.chord;
      }
      expect(mouldedChord > 1e-6 && appendageChord > 1e-6).toBe(false);
    }
  });

  it('has form coefficients plausible for a period sailing hull', () => {
    // Chapelle's schooners run Cp 0.55–0.65 and Cm 0.55–0.75. The first fairing
    // produced Cm 0.61 with Cp 0.72 — a fine midsection with full ends, which is
    // backwards for the type and is what sent the shape back for another pass.
    expect(h.blockCoefficient).toBeGreaterThan(0.43);
    expect(h.blockCoefficient).toBeLessThan(0.5);
    expect(h.midshipCoefficient).toBeGreaterThan(0.65);
    expect(h.midshipCoefficient).toBeLessThan(0.76);
    expect(h.prismaticCoefficient).toBeGreaterThan(0.55);
    expect(h.prismaticCoefficient).toBeLessThan(0.66);
  });

  it('puts the metacentre where the stability calculation needs it', () => {
    expect(h.kb).toBeGreaterThan(1.45);
    expect(h.kb).toBeLessThan(1.56);
    expect(h.bm).toBeGreaterThan(1.08);
    expect(h.bm).toBeLessThan(1.19);
    expect(h.km).toBeCloseTo(h.kb + h.bm, 12);
  });

  it('agrees with the waterline solver', () => {
    const solved = solveWaterline(h.displacement);
    expect(solved).toBeCloseTo(DESIGN_DRAUGHT, 6);
    expect(displacedVolume(DESIGN_DRAUGHT)).toBeCloseTo(h.volume, 9);
  });
});

describe('mass and stability', () => {
  const h = hydrostaticsAt(DESIGN_DRAUGHT);
  const { ballast, properties } = buildLoadedShip();

  it('closes Archimedes exactly, because ballast is solved rather than chosen', () => {
    expect(properties.mass).toBeCloseTo(h.volume * RHO_WATER, 6);
  });

  it('carries a ballast fraction a vessel of this type actually carries', () => {
    // The diagnostic described in massModel.ts: an absurd figure here means the
    // structure estimate is wrong, not that the ballast needs adjusting.
    //
    // **The upper bound moved from 0.38 to 0.42, and it moved by decision.**
    // `docs/ship/SHIP_BELOW_DECKS_PLAN.md` section 3 pays for the platform deck
    // by cutting fresh water from 9.0 t to 4.8 t, and the solve replaces the
    // removed weight with iron: ballast 28.0 t → 31.4 t on a displacement that
    // barely moves, which is 0.385. That was predicted in the plan and approved
    // with it, so the band is what is stale here, not the ship. It is still a
    // plausibility check — 38.5% of displacement in iron on the floors is
    // ordinary for a deep-ballasted vessel of this size, and the figure is
    // pinned exactly below so it cannot drift further without saying so.
    expect(ballast.fraction).toBeGreaterThan(0.25);
    expect(ballast.fraction).toBeLessThan(0.42);
    expect(ballast.fraction).toBeCloseTo(0.3845, 3);
    expect(ballast.mass).toBeGreaterThan(0);
  });

  it('floats level, because the ballast is placed to bring G over B', () => {
    expect(properties.comZ).toBeCloseTo(h.lcb, 9);
    expect(properties.comX).toBeCloseTo(0, 9);
  });

  it('is stiff enough to carry sail and tender enough to be a small vessel', () => {
    const gm = h.km - properties.comY;
    expect(gm).toBeGreaterThan(0.55);
    expect(gm).toBeLessThan(0.85);
    // KG as a fraction of depth to the deck, a standard sanity check.
    expect(properties.comY / 3.82).toBeGreaterThan(0.44);
    expect(properties.comY / 3.82).toBeLessThan(0.57);
  });
});

describe('the floating body', () => {
  it('solves its equilibrium waterline at the design draught', () => {
    const body = buildSchoonerBuoyancy();
    // The bracket for this solve is derived from the hull's own extent. It used
    // to be the constant [-0.5, 1.0], which is right for a raft and silently
    // saturates for anything deeper — a 2.3 m draught came out as 1.0 and she
    // floated on a seventh of her displacement with no error raised.
    expect(body.designWaterlineY).toBeCloseTo(DESIGN_DRAUGHT, 2);
    expect(body.displacedVolume).toBeGreaterThan(78);
    expect(body.displacedVolume).toBeLessThan(81);
    expect(body.stations).toHaveLength(STATION_COUNT);
    expect(body.freeboard).toBeGreaterThan(1.4);
    expect(body.freeboard).toBeLessThan(2.0);
  });

  // These decay trials intentionally run the complete 240 Hz contact contract
  // for 60 simulated seconds. Give concurrent full-suite workers headroom;
  // their assertions, rather than wall-clock scheduling, are the physical gate.
  it('rolls with a period the restoring stiffness predicts', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const body = buildSchoonerBuoyancy();
    const flat = new WaveField(findSeaState('FLAT'));
    const decay = measureRollDecay(body, flat, (10 * Math.PI) / 180, 60);

    expect(decay.crossings.length).toBeGreaterThan(10);
    // Quick and stiff, per spec section 5.1 — a small vessel's motion.
    expect(decay.period).toBeGreaterThan(5.0);
    expect(decay.period).toBeLessThan(6.2);

    // Cross-check against the closed form the integrator is supposed to be
    // reproducing: 2*pi*sqrt(I_virtual / (rho*g*V*GM)). Agreement to a percent
    // is what says the free decay is measuring physics and not an artefact of
    // the substep or the release transient.
    const h = hydrostaticsAt(DESIGN_DRAUGHT);
    const { properties } = buildLoadedShip();
    const gm = h.km - properties.comY;
    const stiffness = RHO_WATER * 9.81 * h.volume * gm;
    const virtualInertia = properties.inertiaRoll * (1 + body.addedMassCoefficient);
    const predicted = 2 * Math.PI * Math.sqrt(virtualInertia / stiffness);
    expect(decay.period).toBeCloseTo(predicted, 1);
    // 60 s of free decay at the real 240 Hz substep is 14,400 steps over 39
    // stations. It fits inside the 5 s default alone and does not when the
    // whole suite is running on every core — which is why this and the decay
    // test below were an intermittent two-test failure that always passed when
    // run on their own. A timeout, not a flake, and the deck round and the
    // dynamics round diagnosed it independently within a day of each other.
    // 30 s rather than 10: the margin costs nothing on a green run.
  });

  it('decays rather than growing, so the body is dissipative', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const body = buildSchoonerBuoyancy();
    const flat = new WaveField(findSeaState('FLAT'));
    const start = (12 * Math.PI) / 180;
    measureRollDecay(body, flat, start, 60);
    expect(Math.abs(body.roll)).toBeLessThan(start);
    expect(Number.isFinite(body.roll)).toBe(true);
    expect(Number.isFinite(body.comWorldY)).toBe(true);
  });

  /**
   * The roll damping fix, held from the outside.
   *
   * Before it, the station forces could not deliver roll damping on a
   * centreline hull at all — a declared ratio of 0.18 was reaching roll as an
   * effective 0.0011 — and beam-on she wound up onto the integrator's ±0.7 rad
   * limiter and stayed there for a tenth of the run. See
   * `BuoyantBodyOptions.rollDampingRatio`.
   *
   * She still rolls hard in the worst sea in the matrix, which is correct: this
   * is beam-on with no steering, the worst heading there is. What she must not
   * do is reach the limiter, because past it the model is no longer physics.
   */
  it('rolls hard in the worst sea without ever reaching the limiter', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const body = buildSchoonerBuoyancy();
    const waves = new WaveField(findSeaState('SOUTHERN_OCEAN_ROUGH'));
    body.snapToSurface(waves, 0, 0, 0);

    let maxRoll = 0;
    const steps = 3600;
    for (let i = 0; i < steps; i++) {
      body.update(1 / 60, waves, 0, 0, 0);
      maxRoll = Math.max(maxRoll, Math.abs(body.roll));
    }

    expect(Number.isFinite(body.comWorldY)).toBe(true);
    expect(Number.isFinite(body.pitch)).toBe(true);
    expect(Number.isFinite(body.roll)).toBe(true);
    // Dramatic, and short of the 0.7 rad limiter — but the margin is now thin
    // and that is a finding, not a threshold to nudge.
    //
    // This bound was 0.63 against a Southern Ocean led by a 15.5 s swell, which
    // rolled her to about 0.56. The violence round rebuilt that preset around a
    // 9 s primary and an 80 % fetch because the long version could not be made
    // to look dangerous, and the same hull now peaks at 0.664 rad — 38 degrees,
    // two degrees off the limiter, in a sea she is meant to be merely marginal
    // in. Beam-on and unsteered is the worst heading there is, so this is the
    // worst case rather than the typical one, but the hull-form round should
    // treat it as an input: the sea she has to survive got harder while she was
    // paused.
    expect(maxRoll).toBeGreaterThan(0.3);
    expect(maxRoll).toBeLessThan(0.7);
    expect(Math.abs(body.pitch)).toBeLessThan(0.35);
  });

  it('stays comfortable in the sea the walking deck has to work in', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    // `docs/ship/SHIP_ROUND_HANDOVER.md` M3: comfortable in CURRENT_MODERATE, survivable
    // in WIND_CHOP. Beam-on and unsteered, which is the worst case for both.
    for (const [name, maxDeg] of [
      ['WIND_CHOP', 10],
      ['CURRENT_MODERATE', 26],
    ] as const) {
      const body = buildSchoonerBuoyancy();
      const waves = new WaveField(findSeaState(name));
      body.snapToSurface(waves, 0, 0, 0);
      let maxRoll = 0;
      for (let i = 0; i < 3600; i++) {
        body.update(1 / 60, waves, 0, 0, 0);
        maxRoll = Math.max(maxRoll, Math.abs(body.roll));
      }
      expect((maxRoll * 180) / Math.PI).toBeLessThan(maxDeg);
    }
  });

  /**
   * Roll damping must be amplitude-dependent, and this is the assertion that
   * says so.
   *
   * A purely linear model decays at one ratio whatever the amplitude. A real
   * hull sheds eddies off the bilge in proportion to `|phi_dot| * phi_dot`, so
   * the effective ratio *rises* with amplitude — which is the whole reason she
   * no longer integrates into the limiter at resonance. If someone deletes the
   * quadratic term this goes flat and the test fails.
   */
  it('damps roll harder the harder she is rolling', () => {
    const flat = new WaveField(findSeaState('FLAT'));

    function effectiveZeta(startDeg: number): number {
      const body = buildSchoonerBuoyancy();
      body.reset();
      body.snapToSurface(flat, 0, 0, 0);
      body.roll = (startDeg * Math.PI) / 180;
      body.rollRate = 0;

      const step = 1 / 240;
      const peaks: number[] = [];
      let previous = body.roll;
      let previousRate = 0;
      for (let i = 0; i < Math.round(30 / step); i++) {
        body.update(step, flat, 0, 0, 0);
        if (previousRate > 0 !== body.rollRate > 0 && Math.abs(previous) > 1e-5) {
          peaks.push(Math.abs(previous));
        }
        previousRate = body.rollRate;
        previous = body.roll;
      }
      const decrement = Math.log(peaks[0] / peaks[1]);
      return decrement / Math.sqrt(4 * Math.PI ** 2 + decrement ** 2);
    }

    const small = effectiveZeta(5);
    const large = effectiveZeta(25);

    // Both inside the band a ballasted hull with no bilge keels actually shows.
    expect(small).toBeGreaterThan(0.03);
    expect(small).toBeLessThan(0.06);
    expect(large).toBeGreaterThan(0.05);
    expect(large).toBeLessThan(0.09);
    // And the large-amplitude roll is damped meaningfully harder.
    expect(large).toBeGreaterThan(small * 1.25);
  }, 120_000);
});

describe("the captain's cabin", () => {
  /**
   * THIS TEST USED TO PASS AGAINST A DECK THAT IS NOT DRAWN.
   *
   * `cabinHeadroomAt` lived in `hullForm.ts` and built the deck's camber from
   * `deckCrownY`, which spans the hull's *maximum* half-beam. The quarterdeck is
   * lofted over `deckHalfWidth` instead — the inboard face of the bulwark, up at
   * the walking surface, 0.26 m narrower — so the figure asserted here stood
   * 9–16 mm above the height a head actually meets. It is measured against the
   * drawn deck now, and the minimum M4 measured was **1.841 m at the forward
   * bulkhead**, against the 1.85 m of spec section 6.
   *
   * **THE 9 mm CAME BACK BY ITSELF, AND NOT BECAUSE ANYTHING WAS BOUGHT.**
   * `docs/ship/SHIP_BELOW_DECKS_PLAN.md` moved the cabin's forward bulkhead from
   * −3.4 to −4.3 to make room for the companion ladder's landing, and the sheer
   * rises toward the transom, so the room's tightest point moved aft with it.
   * The measured minimum is now **1.874 m**, which clears section 6 outright.
   * Nothing about the hull changed; the room stopped being in the low place.
   *
   * The numbers below are named exactly so that a change that moves them has to
   * come through here and say so rather than sliding within a band.
   */
  it('clears the spec 1.85 m on the centreline over the whole cabin', () => {
    // The binding point is still the cabin's *forward* end, where the sheer has
    // not yet risen toward the transom — it is just further aft than it was.
    for (let i = 0; i <= 16; i++) {
      const z = CABIN_AFT_Z + ((CABIN_FORWARD_Z - CABIN_AFT_Z) * i) / 16;
      expect(cabinHeadroomAt(z)).toBeGreaterThanOrEqual(1.85);
    }
    expect(cabinHeadroomAt(CABIN_FORWARD_Z)).toBeCloseTo(1.8737, 3);
    expect(cabinHeadroomAt(CABIN_AFT_Z)).toBeCloseTo(2.0730, 3);
  });

  it('has room for the 7-9 m2 of sole the spec asks for', () => {
    // Also measured against the room rather than against the hull now: the sole
    // is clipped to the deck that roofs it, which is 0.13-0.26 m narrower each
    // side than the shell is down at sole level, because the topsides tumble
    // home above the maximum beam. 11.34 m2 was the shell's answer; 9.29 is the
    // room's, now that it runs aft to the transom and forward only to −4.3.
    const area = cabinSoleArea();
    expect(area).toBeGreaterThan(9);
    expect(area).toBeLessThan(14);
  });

  it('gives the whole below-decks the walkable floor the plan measured', () => {
    // The plan's own drawing tool and the ship read the same width function, so
    // these are the figures `docs/ship/SHIP_BELOW_DECKS_PLAN.md` section 4
    // published — 49.3 m² against the 9.37 m² M4 built.
    const byName = Object.fromEntries(
      BELOW_DECKS_SPACES.map((space) => [space.name, spaceSoleArea(space)]),
    );
    expect(byName.cabin).toBeCloseTo(9.29, 1);
    expect(byName.landing).toBeCloseTo(6.44, 1);
    expect(byName.wardroom).toBeCloseTo(21.02, 1);
    expect(byName.forecastle).toBeCloseTo(12.57, 1);
    expect(belowDecksSoleArea()).toBeCloseTo(49.32, 1);
  });
});
