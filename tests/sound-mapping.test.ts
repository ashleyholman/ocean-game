import { describe, expect, it } from 'vitest';

import {
  MUFFLED_CUTOFF_HZ,
  OPEN_CUTOFF_HZ,
  SOUND_ROOMS,
  cutoffForOpenness,
  roomAcoustics,
} from '../src/audio/interiorAcoustics';
import { NOISE_SEED, createNoiseRandom, fillNoise, peakAmplitude } from '../src/audio/noise';
import {
  SHIP_REFERENCE_M,
  SHIP_SILENCE_M,
  bowGain,
  bowPan,
  breakerGain,
  clothGain,
  clothSlatHz,
  createSoundVoiceLevels,
  hullGain,
  resolveVoices,
  riggingCentreHz,
  riggingGain,
  shipAudibility,
  swellCutoffHz,
  swellGain,
} from '../src/audio/soundMapping';
import { SOUND_LAYERS, createSoundMixerTrims } from '../src/audio/SoundMixer';
import { createSoundWorldState, type SoundWorldState } from '../src/audio/soundState';
import { whitecapCoverage } from '../src/ocean/spectrum';
import { sailShakeFraction } from '../src/vessel/schooner/sailAero';

/**
 * The sound round's gate.
 *
 * Everything here runs in node with no `AudioContext`, which is the point:
 * the mapping from the world to a gain is pure arithmetic and can be held to
 * the four properties `soundMapping.ts` claims for it — bounded, continuous,
 * monotonic where the world is, and defined at the edges.
 */

/** Sample a curve across a range and assert it never decreases. */
function expectNonDecreasing(
  f: (x: number) => number,
  from: number,
  to: number,
  steps = 400,
): void {
  let previous = f(from);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    const value = f(x);
    expect(
      value,
      `expected f(${x}) >= f(previous) but ${value} < ${previous}`,
    ).toBeGreaterThanOrEqual(previous - 1e-12);
    previous = value;
  }
}

function expectNonIncreasing(
  f: (x: number) => number,
  from: number,
  to: number,
  steps = 400,
): void {
  let previous = f(from);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    const value = f(x);
    expect(
      value,
      `expected f(${x}) <= f(previous) but ${value} > ${previous}`,
    ).toBeLessThanOrEqual(previous + 1e-12);
    previous = value;
  }
}

/** Assert a curve has no jump larger than `maxStep` across a range. */
function expectContinuous(
  f: (x: number) => number,
  from: number,
  to: number,
  maxStep: number,
  steps = 2000,
): void {
  let previous = f(from);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    const value = f(x);
    expect(
      Math.abs(value - previous),
      `jump of ${Math.abs(value - previous)} at x=${x}`,
    ).toBeLessThanOrEqual(maxStep);
    previous = value;
  }
}

describe('seeded noise', () => {
  it('produces identical samples for the same seed', () => {
    const a = fillNoise(new Float32Array(4096), NOISE_SEED.broadband);
    const b = fillNoise(new Float32Array(4096), NOISE_SEED.broadband);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces different samples for different seeds', () => {
    const a = fillNoise(new Float32Array(4096), NOISE_SEED.broadband);
    const b = fillNoise(new Float32Array(4096), NOISE_SEED.broadbandAlt);
    let differences = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences++;
    // Two independent streams should differ essentially everywhere.
    expect(differences).toBeGreaterThan(a.length * 0.99);
  });

  it('pins actual sample values, so a coefficient change is caught', () => {
    // A regression guard with teeth: these are the first four samples of the
    // sea buffer. If the integrator pole, the gain or the PRNG changes, the
    // sound of the game changes, and this line is the notification.
    const samples = fillNoise(new Float32Array(64), NOISE_SEED.broadband);
    const head = Array.from(samples.slice(0, 4)).map((v) => Number(v.toFixed(6)));
    expect(head).toMatchInlineSnapshot(`
      [
        0.008552,
        0.22675,
        0.353685,
        0.111523,
      ]
    `);
  });

  it('stays inside a sane amplitude and is not silent', () => {
    const samples = fillNoise(new Float32Array(48_000), NOISE_SEED.broadband);
    const peak = peakAmplitude(samples);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(4);
  });

  it('cross-fades the loop seam so the head and tail agree', () => {
    const samples = fillNoise(new Float32Array(48_000), NOISE_SEED.broadband);
    // The first sample is faded fully into the tail's first sample, so the
    // wrap from the last sample back to the first cannot be a step larger
    // than an ordinary sample-to-sample move.
    const wrap = Math.abs(samples[0] - samples[samples.length - 1]);
    const typical = Math.abs(samples[1000] - samples[999]);
    expect(wrap).toBeLessThan(Math.max(typical * 8, 0.05));
  });

  it('handles a zero-length buffer without throwing', () => {
    expect(() => fillNoise(new Float32Array(0), 1)).not.toThrow();
  });

  it('has a random stream in [0, 1) that does not immediately repeat', () => {
    const random = createNoiseRandom(12345);
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      seen.add(value);
    }
    expect(seen.size).toBeGreaterThan(4990);
  });
});

describe('the listener', () => {
  it('hears the whole ship inside the reference radius', () => {
    expect(shipAudibility(0)).toBe(1);
    expect(shipAudibility(SHIP_REFERENCE_M)).toBe(1);
  });

  it('hears nothing of the ship at and beyond the silence distance', () => {
    expect(shipAudibility(SHIP_SILENCE_M)).toBe(0);
    expect(shipAudibility(SHIP_SILENCE_M * 2)).toBe(0);
    // The far cinematic knot is 1400 m; the ship must be gone there.
    expect(shipAudibility(1400)).toBe(0);
  });

  it('never gets louder as the listener backs away', () => {
    expectNonIncreasing(shipAudibility, 0, 1600, 1600);
  });

  it('is continuous across both joins', () => {
    expectContinuous(shipAudibility, 0, 700, 0.02, 4000);
  });

  it('still carries the ship at the default opening composition', () => {
    // 45 m is the authored default; she must be plainly audible there.
    expect(shipAudibility(45)).toBeGreaterThan(0.2);
  });

  it('pans the bow by bearing, centred ahead and astern', () => {
    expect(bowPan(0)).toBeCloseTo(0, 12);
    expect(bowPan(Math.PI / 2)).toBeCloseTo(1, 12);
    expect(bowPan(-Math.PI / 2)).toBeCloseTo(-1, 12);
    // Two ears cannot tell front from back, and neither does this.
    expect(bowPan(Math.PI)).toBeCloseTo(0, 12);
    for (let a = -Math.PI * 2; a <= Math.PI * 2; a += 0.01) {
      expect(Math.abs(bowPan(a))).toBeLessThanOrEqual(1);
    }
  });
});

describe('sea voices', () => {
  it('leaves a flat calm audible but quiet', () => {
    const calm = swellGain(0);
    expect(calm).toBeGreaterThan(0);
    expect(calm).toBeLessThan(0.1);
  });

  it('never quietens as the sea builds, and stays bounded', () => {
    expectNonDecreasing(swellGain, 0, 20);
    expect(swellGain(20)).toBeLessThan(1);
    expect(swellGain(1e6)).toBeLessThanOrEqual(1);
  });

  it('lowers the wash as the swell lengthens', () => {
    expectNonIncreasing(swellCutoffHz, 0, 30);
    expect(swellCutoffHz(0)).toBeGreaterThan(swellCutoffHz(14));
    // Defined at a sea with no period at all.
    expect(Number.isFinite(swellCutoffHz(0))).toBe(true);
  });

  it('never quietens the breakers as the wind builds', () => {
    // Composed through the real Monahan fit, so this is the brief's
    // "a rising wind never gets quieter" stated end to end.
    expectNonDecreasing((u) => breakerGain(whitecapCoverage(u), 1), 0, 40, 800);
  });

  it('is silent in a glassy calm and loud in a storm', () => {
    expect(breakerGain(whitecapCoverage(0), 1)).toBe(0);
    expect(breakerGain(whitecapCoverage(3), 1)).toBeLessThan(0.05);
    expect(breakerGain(whitecapCoverage(25), 1)).toBeGreaterThan(0.7);
  });

  it('clamps a lab preset that asks for absurd foam generation', () => {
    const sane = breakerGain(0.1, 1.5);
    expect(breakerGain(0.1, 50)).toBe(sane);
    expect(breakerGain(0.1, -5)).toBe(0);
  });
});

describe('rig voices', () => {
  it('never quietens as the apparent wind rises, and stays bounded', () => {
    expectNonDecreasing(riggingGain, 0, 60);
    expect(riggingGain(0)).toBe(0);
    expect(riggingGain(60)).toBeLessThan(1);
  });

  it('is silent in a dead calm and singing in a gale', () => {
    expect(riggingGain(0)).toBe(0);
    expect(riggingGain(2)).toBeLessThan(0.1);
    expect(riggingGain(20)).toBeGreaterThan(0.7);
  });

  it('raises the rig band with the wind but caps it below a whistle', () => {
    expectNonDecreasing(riggingCentreHz, 0, 100);
    expect(riggingCentreHz(100)).toBeLessThanOrEqual(1800);
  });

  it('takes the cloth straight off the area in motion', () => {
    expect(clothGain(0)).toBe(0);
    expectNonDecreasing(clothGain, 0, 250);
    // One headsail shivering reads small; a gaff sail loose dominates.
    expect(clothGain(10)).toBeLessThan(0.4);
    expect(clothGain(60)).toBeGreaterThan(0.7);
    expect(clothGain(250)).toBeLessThan(1);
  });

  it('beats faster in more wind, within a bounded range', () => {
    expectNonDecreasing(clothSlatHz, 0, 60);
    expect(clothSlatHz(0)).toBeGreaterThan(0);
    expect(clothSlatHz(1e4)).toBeLessThanOrEqual(5);
  });
});

describe('the shake fraction shared with the cloth loft', () => {
  it('is zero for a sail drawing sweetly', () => {
    expect(sailShakeFraction(30, 12, 1, false)).toBe(0);
  });

  it('is zero in a calm however badly the sail is set', () => {
    expect(sailShakeFraction(0, 0, 1, false)).toBe(0);
  });

  it('is zero for a sail pressed firmly aback', () => {
    expect(sailShakeFraction(-30, 12, 1, false)).toBe(0);
  });

  it('peaks in the band between drawing and aback', () => {
    expect(sailShakeFraction(2, 12, 1, false)).toBeGreaterThan(0.5);
  });

  it('is continuous across the luffing boolean threshold', () => {
    // `PerSailForce.luffing` flips at `sailLuffFactor(aoa) < 0.5`. The whole
    // reason this function exists is that the sound must not.
    expectContinuous((aoa) => sailShakeFraction(aoa, 12, 1, false), -30, 40, 0.02, 4000);
  });

  it('quietens a blanketed sail', () => {
    const clear = sailShakeFraction(2, 6, 1, false);
    const blanketed = sailShakeFraction(2, 6, 0.25, false);
    expect(blanketed).toBeLessThan(clear);
    expect(blanketed).toBeGreaterThan(0);
  });

  it('shakes at least as hard once the hand has given her up', () => {
    // `cannotDraw` caps attachment, so it can only raise the shake.
    for (const aoa of [-5, 0, 4, 8, 12, 20]) {
      expect(sailShakeFraction(aoa, 10, 1, true)).toBeGreaterThanOrEqual(
        sailShakeFraction(aoa, 10, 1, false) - 1e-12,
      );
    }
    expect(sailShakeFraction(20, 10, 1, true)).toBeGreaterThan(0);
  });

  it('stays inside [0, 1] for every input, including absurd ones', () => {
    for (const aoa of [-180, -30, 0, 15, 90, 180]) {
      for (const wind of [0, 1, 10, 80]) {
        for (const blanket of [-1, 0, 0.5, 1, 4]) {
          const value = sailShakeFraction(aoa, wind, blanket, false);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('hull voices', () => {
  it('is silent in a dead flat sea and rises with the working', () => {
    expect(hullGain(0)).toBe(0);
    expectNonDecreasing(hullGain, 0, 5);
    expect(hullGain(5)).toBeLessThan(1);
  });

  it('never quietens as the ship goes faster, and is silent stopped', () => {
    expect(bowGain(0)).toBe(0);
    expectNonDecreasing(bowGain, 0, 12);
    // Hull speed on a ~13 m waterline is about 4.5 m/s; she must be loud there.
    expect(bowGain(4.5)).toBeGreaterThan(0.7);
    expect(bowGain(12)).toBeLessThan(1);
  });

  it('treats sternway as noise, not as negative noise', () => {
    expect(bowGain(-2)).toBe(bowGain(2));
  });
});

describe('the interior', () => {
  it('is the identity in the open air', () => {
    const open = roomAcoustics(null, {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: false,
    });
    expect(open.openness).toBe(1);
    expect(open.airGain).toBe(1);
    expect(open.cutoffHz).toBe(OPEN_CUTOFF_HZ);
  });

  it('muffles every room below decks', () => {
    for (const room of SOUND_ROOMS) {
      const inside = roomAcoustics(room, {
        hatchwayBoardsOpen: true,
        foreScuttleLidOpen: true,
      });
      expect(inside.openness, room).toBeLessThan(1);
      expect(inside.airGain, room).toBeLessThan(1);
      expect(inside.cutoffHz, room).toBeLessThan(OPEN_CUTOFF_HZ);
    }
  });

  it('muffles more with the scuttle lid shut than open', () => {
    const open = roomAcoustics('forecastle', {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: true,
    });
    const shut = roomAcoustics('forecastle', {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: false,
    });
    expect(shut.openness).toBeLessThan(open.openness);
    expect(shut.airGain).toBeLessThan(open.airGain);
    expect(shut.cutoffHz).toBeLessThan(open.cutoffHz);
  });

  it('muffles more with the hatchway boards laid than lifted', () => {
    const lifted = roomAcoustics('hold', {
      hatchwayBoardsOpen: true,
      foreScuttleLidOpen: false,
    });
    const laid = roomAcoustics('hold', {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: false,
    });
    expect(laid.openness).toBeLessThan(lifted.openness);
    expect(laid.cutoffHz).toBeLessThan(lifted.cutoffHz);
  });

  it('never takes a shut room to silence', () => {
    const sealed = roomAcoustics('hold', {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: false,
    });
    expect(sealed.airGain).toBeGreaterThan(0);
    expect(sealed.cutoffHz).toBeGreaterThanOrEqual(MUFFLED_CUTOFF_HZ);
  });

  it('leaves the companionway open, because it has no door', () => {
    // The landing hears the sea whatever the two closures are doing; that is
    // the light model's `CHANNEL_COMPANION` fact, restated for sound.
    const both = [true, false];
    for (const boards of both) {
      for (const lid of both) {
        const landing = roomAcoustics('landing', {
          hatchwayBoardsOpen: boards,
          foreScuttleLidOpen: lid,
        });
        expect(landing.openness).toBeGreaterThan(0.5);
      }
    }
  });

  it('maps openness to a cutoff that is monotone and exact at both ends', () => {
    expect(cutoffForOpenness(0)).toBeCloseTo(MUFFLED_CUTOFF_HZ, 6);
    expect(cutoffForOpenness(1)).toBeCloseTo(OPEN_CUTOFF_HZ, 6);
    expectNonDecreasing(cutoffForOpenness, 0, 1);
    // Clamped outside the unit range rather than extrapolating to infrasound.
    expect(cutoffForOpenness(-1)).toBeCloseTo(MUFFLED_CUTOFF_HZ, 6);
    expect(cutoffForOpenness(2)).toBeCloseTo(OPEN_CUTOFF_HZ, 6);
  });

  it('makes the hull louder below decks, not quieter', () => {
    const inside = roomAcoustics('wardroom', {
      hatchwayBoardsOpen: false,
      foreScuttleLidOpen: false,
    });
    expect(inside.structureGain).toBeGreaterThan(1);
  });
});

// --- whole-frame resolution ---------------------------------------------------

function stormState(): SoundWorldState {
  const state = createSoundWorldState();
  state.mode = 'embodied';
  state.vesselDistanceM = 2;
  state.significantHeightM = 9;
  state.dominantPeriodS = 11;
  state.whitecapCoverage = whitecapCoverage(28);
  state.whitewaterGeneration = 1.4;
  state.apparentWindMps = 30;
  state.setClothAreaM2 = 120;
  state.shakingClothAreaM2 = 90;
  state.hullWorkRateRadPerS = 0.9;
  state.speedThroughWaterMps = 5;
  return state;
}

describe('resolving a whole frame', () => {
  it('is silent in every ship voice in a dead calm with nothing set', () => {
    const levels = resolveVoices(
      createSoundWorldState(),
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );
    expect(levels.rigging.gain).toBe(0);
    expect(levels.cloth.gain).toBe(0);
    expect(levels.bow.gain).toBe(0);
    expect(levels.hull.gain).toBe(0);
    // The sea is never quite silent.
    expect(levels.swell.gain).toBeGreaterThan(0);
    expect(levels.breakers.gain).toBe(0);
  });

  it('keeps every gain inside [0, 1] in a full storm', () => {
    const levels = resolveVoices(
      stormState(),
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );
    for (const value of [
      levels.swell.gain,
      levels.breakers.gain,
      levels.rigging.gain,
      levels.cloth.gain,
      levels.bow.gain,
      levels.hull.gain,
      levels.air.gain,
      levels.master,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the sea and drops the ship when the camera pulls back', () => {
    const near = stormState();
    near.room = null;
    const far = { ...near, vesselDistanceM: 1400 };

    const nearLevels = resolveVoices(
      near,
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );
    const farLevels = resolveVoices(
      far,
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );

    // The ship is gone.
    expect(farLevels.rigging.gain).toBe(0);
    expect(farLevels.cloth.gain).toBe(0);
    expect(farLevels.bow.gain).toBe(0);
    expect(farLevels.hull.gain).toBe(0);
    // The sea is exactly as it was: it is a field, not a source.
    expect(farLevels.swell.gain).toBe(nearLevels.swell.gain);
    expect(farLevels.breakers.gain).toBe(nearLevels.breakers.gain);
  });

  it('muffles the air bus below decks but not the hull', () => {
    const onDeck = stormState();
    onDeck.room = null;
    const inTheHold = { ...stormState(), room: 'hold' as const };

    const deckLevels = resolveVoices(
      onDeck,
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );
    const holdLevels = resolveVoices(
      inTheHold,
      { ...createSoundMixerTrims(), muted: false },
      createSoundVoiceLevels(),
    );

    expect(holdLevels.air.gain).toBeLessThan(deckLevels.air.gain);
    expect(holdLevels.air.cutoffHz).toBeLessThan(deckLevels.air.cutoffHz);
    // Structure-borne: you are inside the sound box, so it goes up.
    expect(holdLevels.hull.gain).toBeGreaterThan(deckLevels.hull.gain);
  });

  it('silences everything when muted, whatever the world is doing', () => {
    const levels = resolveVoices(
      stormState(),
      createSoundMixerTrims(),
      createSoundVoiceLevels(),
    );
    expect(levels.master).toBe(0);
  });

  it('honours a per-voice trim', () => {
    const trims = { ...createSoundMixerTrims(), muted: false };
    trims.layers = { ...trims.layers, rigging: 0 };
    const levels = resolveVoices(stormState(), trims, createSoundVoiceLevels());
    expect(levels.rigging.gain).toBe(0);
    expect(levels.swell.gain).toBeGreaterThan(0);
  });

  it('silences the other five when one voice is soloed', () => {
    for (const solo of SOUND_LAYERS) {
      const trims = { ...createSoundMixerTrims(), muted: false, solo };
      const levels = resolveVoices(stormState(), trims, createSoundVoiceLevels());
      const gains: Record<string, number> = {
        swell: levels.swell.gain,
        breakers: levels.breakers.gain,
        rigging: levels.rigging.gain,
        cloth: levels.cloth.gain,
        bow: levels.bow.gain,
        hull: levels.hull.gain,
      };
      for (const layer of SOUND_LAYERS) {
        if (layer === solo) {
          expect(gains[layer], `${solo} soloed`).toBeGreaterThan(0);
        } else {
          expect(gains[layer], `${layer} while ${solo} soloed`).toBe(0);
        }
      }
    }
  });

  it('reuses the record the caller owns rather than allocating', () => {
    const out = createSoundVoiceLevels();
    const swell = out.swell;
    const returned = resolveVoices(stormState(), createSoundMixerTrims(), out);
    expect(returned).toBe(out);
    expect(returned.swell).toBe(swell);
  });
});
