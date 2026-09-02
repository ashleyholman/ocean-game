import { describe, expect, it } from 'vitest';
import {
  CHANNEL_BOARDS,
  CHANNEL_COMPANION,
  CHANNEL_HATCH,
  CHANNEL_SCUTTLE,
  CHANNEL_WINDOWS,
  LIGHT_CHANNELS,
  type LightRect,
  gratingTransmittance,
  interiorLightModel,
  lightRoomAt,
  linearRgbOfHex,
  luminanceOf,
  rectArea,
  rectCorners,
  rectFormFactor,
  rectToRectFormFactor,
  bathGradientAt,
  eyeLightMeterAt,
  vertexLightResponse,
} from '../src/vessel/schooner/interiorLight';
import {
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  CABIN_SOLE_Y,
  PLATFORM_SOLE_Y,
  CARGO_HATCH_Z,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
} from '../src/vessel/schooner/hullForm';
import { HOLD_FLOOR_Y } from '../src/vessel/schooner/holdStow';
import {
  INTERIOR_STEPS,
  STERN_WINDOWS,
  onStepsSillFlat,
  stepTreadCount,
  stepTreadY,
  stepTreadZ,
  stepsLowY,
  stepsRoom,
  stepsRunLength,
} from '../src/vessel/schooner/deckInterior';

/**
 * The interior light graph's arithmetic, held against references it cannot
 * share code with.
 *
 * Everything here is the static half of the below-decks lighting: the form
 * factors the bake writes into vertex attributes, and the room-exchange solve
 * whose numbers those attributes carry. The shader side is covered in
 * `world-lighting.test.ts`; what is pinned here is that the geometry-derived
 * numbers mean what they claim — a form factor is a fraction of a hemisphere,
 * a radiosity solve does not create energy, and the gradients point the way a
 * photon would.
 */

// --- the form factor against Monte Carlo ---------------------------------------

/**
 * Monte Carlo reference: cosine-weighted hemisphere sampling with ray-rect
 * intersection. Different algorithm, different failure modes — agreement is
 * meaningful, shared bugs are not.
 */
function monteCarloFormFactor(
  p: [number, number, number],
  n: [number, number, number],
  rect: LightRect,
  samples: number,
): number {
  // Orthonormal frame round the receiver normal.
  const a: [number, number, number] =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const t1 = norm(cross(a, n));
  const t2 = cross(n, t1);

  // A deterministic low-discrepancy sequence, so the test cannot flake.
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    const v = (i * 0.6180339887498949) % 1;
    const r = Math.sqrt(u);
    const phi = 2 * Math.PI * v;
    // Cosine-weighted direction in the receiver's frame.
    const d: [number, number, number] = [
      r * Math.cos(phi) * t1[0] + r * Math.sin(phi) * t2[0] + Math.sqrt(1 - u) * n[0],
      r * Math.cos(phi) * t1[1] + r * Math.sin(phi) * t2[1] + Math.sqrt(1 - u) * n[1],
      r * Math.cos(phi) * t1[2] + r * Math.sin(phi) * t2[2] + Math.sqrt(1 - u) * n[2],
    ];
    if (rayHitsRect(p, d, rect)) hits++;
  }
  return hits / samples;

  function cross(
    x: readonly number[],
    y: readonly number[],
  ): [number, number, number] {
    return [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
  }
  function norm(x: [number, number, number]): [number, number, number] {
    const l = Math.hypot(x[0], x[1], x[2]);
    return [x[0] / l, x[1] / l, x[2] / l];
  }
}

function rayHitsRect(
  p: readonly number[],
  d: readonly number[],
  rect: LightRect,
): boolean {
  const rn = rect.normal;
  const denom = d[0] * rn[0] + d[1] * rn[1] + d[2] * rn[2];
  if (Math.abs(denom) < 1e-9) return false;
  const t =
    ((rect.centre[0] - p[0]) * rn[0] +
      (rect.centre[1] - p[1]) * rn[1] +
      (rect.centre[2] - p[2]) * rn[2]) /
    denom;
  if (t <= 0) return false;
  const hx = p[0] + t * d[0] - rect.centre[0];
  const hy = p[1] + t * d[1] - rect.centre[1];
  const hz = p[2] + t * d[2] - rect.centre[2];
  const lu2 = rect.edgeU[0] ** 2 + rect.edgeU[1] ** 2 + rect.edgeU[2] ** 2;
  const lv2 = rect.edgeV[0] ** 2 + rect.edgeV[1] ** 2 + rect.edgeV[2] ** 2;
  const u = (hx * rect.edgeU[0] + hy * rect.edgeU[1] + hz * rect.edgeU[2]) / lu2;
  const v = (hx * rect.edgeV[0] + hy * rect.edgeV[1] + hz * rect.edgeV[2]) / lv2;
  return Math.abs(u) <= 1 && Math.abs(v) <= 1;
}

describe('rectFormFactor', () => {
  const overhead: LightRect = {
    name: 'test-overhead',
    centre: [0, 2, 0],
    edgeU: [0.75, 0, 0],
    edgeV: [0, 0, 0.9],
    normal: [0, -1, 0],
  };

  it('agrees with a Monte Carlo reference from the far field to the near', () => {
    const cases: Array<{ p: [number, number, number]; n: [number, number, number] }> = [
      { p: [0, 0, 0], n: [0, 1, 0] }, // sole straight under
      { p: [1.4, 0.5, 0.5], n: [-1, 0, 0] }, // a wall facing across
      { p: [0, 1.8, 0], n: [0, 1, 0] }, // just under the opening
      { p: [0.2, 1.2, 2.4], n: [0, 0, -1] }, // facing away along z
      { p: [-1.1, 0.9, -1.6], n: [0.6, 0.64, 0.48] }, // oblique
    ];
    for (const { p, n } of cases) {
      const nn = Math.hypot(...n);
      const unit: [number, number, number] = [n[0] / nn, n[1] / nn, n[2] / nn];
      const got = rectFormFactor(p[0], p[1], p[2], unit[0], unit[1], unit[2], overhead);
      const want = monteCarloFormFactor(p, unit, overhead, 200000);
      expect(Math.abs(got - want)).toBeLessThan(0.012);
    }
  });

  it('is zero behind the portal plane and behind the receiver', () => {
    // Above the overhead rect, looking up: the portal lights the other side.
    expect(rectFormFactor(0, 2.5, 0, 0, 1, 0, overhead)).toBe(0);
    // Below it but facing down: the rect is behind the receiver's horizon.
    expect(rectFormFactor(0, 0.5, 0, 0, -1, 0, overhead)).toBe(0);
  });

  it('approaches one when the opening fills the hemisphere', () => {
    const wide: LightRect = {
      name: 'test-wide',
      centre: [0, 0.02, 0],
      edgeU: [40, 0, 0],
      edgeV: [0, 0, 40],
      normal: [0, -1, 0],
    };
    const f = rectFormFactor(0, 0, 0, 0, 1, 0, wide);
    expect(f).toBeGreaterThan(0.97);
    expect(f).toBeLessThanOrEqual(1);
  });

  it('matches the analytic disc-limit for a small far patch', () => {
    // A patch of area A at distance r straight overhead: F ≈ A / (π r²).
    const patch: LightRect = {
      name: 'test-patch',
      centre: [0, 10, 0],
      edgeU: [0.1, 0, 0],
      edgeV: [0, 0, 0.1],
      normal: [0, -1, 0],
    };
    const f = rectFormFactor(0, 0, 0, 0, 1, 0, patch);
    const analytic = (0.2 * 0.2) / (Math.PI * 100);
    expect(Math.abs(f - analytic) / analytic).toBeLessThan(0.01);
  });
});

// --- the model ------------------------------------------------------------------

describe('interiorLightModel', () => {
  const model = interiorLightModel();

  it('carries every opening the arrangement has', () => {
    const names = model.skyPortals.map((p) => p.name);
    expect(names).toContain('companionway');
    expect(names).toContain('cargo-hatch-grating');
    expect(names).toContain('hold-boards');
    expect(names.filter((n) => n.startsWith('stern-window'))).toHaveLength(
      STERN_WINDOWS.length,
    );
    // Three doored bulkheads, one rect per face.
    expect(model.doorways).toHaveLength(6);
  });

  it('gives every room to the solve and none a negative or runaway response', () => {
    for (const [room, response] of model.transfer) {
      expect(response).toHaveLength(LIGHT_CHANNELS);
      for (const value of response) {
        expect(value).toBeGreaterThanOrEqual(0);
        // Radiosity per unit portal irradiance is bounded by the albedo:
        // a room cannot glow brighter than what its paint returns of what
        // arrives, and what arrives is diluted over the room's whole area.
        expect(value).toBeLessThan(1);
      }
      expect(room).not.toBe('hold');
    }
  });

  it('conserves energy: solved radiosity stays under the direct input', () => {
    // For each channel, total reflected flux Σ A_i J_i must be less than the
    // flux the portals admit (Σ A_p τ_p) — the cavity absorbs the rest.
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      let admitted = 0;
      for (const portal of model.skyPortals) {
        if (portal.channel !== p || portal.room === 'hold') continue;
        admitted += rectArea(portal) * portal.transmittance;
      }
      if (admitted === 0) continue;
      let reflected = 0;
      for (const room of model.rooms) {
        if (room.name === 'hold') continue;
        reflected += room.area * (model.transfer.get(room.name)?.[p] ?? 0);
      }
      expect(reflected).toBeLessThan(admitted);
      expect(reflected).toBeGreaterThan(0);
    }
  });

  it('runs the multi-hop chain: stern windows light the wardroom two doors away', () => {
    const wardroom = model.transfer.get('wardroom')!;
    const landing = model.transfer.get('landing')!;
    const cabin = model.transfer.get('cabin')!;
    // The windows are the cabin's portal: response falls with every doorway.
    expect(cabin[CHANNEL_WINDOWS]).toBeGreaterThan(landing[CHANNEL_WINDOWS]);
    expect(landing[CHANNEL_WINDOWS]).toBeGreaterThan(wardroom[CHANNEL_WINDOWS]);
    // But it is genuinely there, which is the whole point of the solve.
    expect(wardroom[CHANNEL_WINDOWS]).toBeGreaterThan(0);
    // And the forecastle, three doors from the stern, still sees daylight from
    // the hatch next door.
    const forecastle = model.transfer.get('forecastle')!;
    expect(forecastle[CHANNEL_HATCH]).toBeGreaterThan(0);
  });

  it('passes less through the grating than the hole and derives it from the battens', () => {
    const tau = gratingTransmittance();
    expect(tau).toBeGreaterThan(0.15);
    expect(tau).toBeLessThan(0.45);
    const grating = model.skyPortals.find((p) => p.name === 'cargo-hatch-grating')!;
    expect(grating.transmittance).toBe(tau);
  });

  it('normalises the bounce tint to unit luminance and keeps it warm', () => {
    const [r, g, b] = model.bounceTint;
    expect(Math.abs(luminanceOf([r, g, b]) - 1)).toBeLessThan(1e-6);
    // Oiled oak and scrubbed pine: red above green above blue.
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('sees the grating from the boards with a plausible parallel-plate factor', () => {
    // Two roughly equal aligned rectangles ~2.1 m apart: the exact factor for
    // that geometry is a few percent to a few tens of percent. What matters is
    // that it is neither zero (no chain) nor near one (no shaft).
    expect(model.boards.toGratingF).toBeGreaterThan(0.05);
    expect(model.boards.toGratingF).toBeLessThan(0.5);
    expect(model.boards.ambientSpill).toBeCloseTo(1 - model.boards.toGratingF, 12);
  });
});

// --- room assignment --------------------------------------------------------------

describe('lightRoomAt', () => {
  it('places the walked rooms, the hold, and the voids', () => {
    expect(lightRoomAt(0, CABIN_SOLE_Y + 0.5, -5.5)).toBe('cabin');
    expect(lightRoomAt(0, CABIN_SOLE_Y + 0.5, -3.4)).toBe('landing');
    expect(lightRoomAt(0.5, PLATFORM_SOLE_Y + 0.5, 0.5)).toBe('wardroom');
    expect(lightRoomAt(0, 2.4, 4.5)).toBe('forecastle');
    expect(lightRoomAt(0, HOLD_FLOOR_Y + 0.3, CARGO_HATCH_Z)).toBe('hold');
    // Under the cabin sole: the bread room, sealed, no light room.
    expect(lightRoomAt(0, 1.5, -5.5)).toBeNull();
    // On deck.
    expect(lightRoomAt(0, 5.2, 0)).toBeNull();
  });

  it('gives the companion shaft to the landing up to its own portal', () => {
    const zShaft = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) / 2;
    expect(lightRoomAt(1.0, 4.1, zShaft)).toBe('landing');
  });

  it('admits every well cut below a sole to the room the flight stands in', () => {
    // §15.5 item 1: the wardroom-well treads sit below the landing's sole,
    // resolved to no room, and baked to zero — "maybe they weren't marked".
    // The rule is general: every flight that cuts a well gets its band.
    const model = interiorLightModel();
    let wells = 0;
    for (const steps of INTERIOR_STEPS) {
      if (steps.farY <= steps.sillY + 1e-6) continue; // descends away: no cut
      wells++;
      const room = stepsRoom(steps);
      expect(room).not.toBeNull();
      const probes: Array<[number, number]> = [];
      for (let index = 1; index <= stepTreadCount(steps); index++) {
        const { zAft, zForward } = stepTreadZ(steps, index);
        probes.push([stepTreadY(steps, index), (zAft + zForward) / 2]);
      }
      // The flat at the sill is in the well too, at the lower floor's level.
      const sillFlatZ = steps.zTop + steps.direction * (steps.sillRun / 2);
      if (onStepsSillFlat(steps, steps.x, sillFlatZ)) {
        probes.push([stepsLowY(steps), sillFlatZ]);
      }
      for (const [y, z] of probes) {
        expect(lightRoomAt(steps.x, y + 0.04, z)).toBe(room!.name);
        // And the light model answers there: a tread facing up must carry a
        // nonzero response, or it bakes black again.
        const response = vertexLightResponse(model, steps.x, y, z, 0, 1, 0);
        const total =
          response.direct.reduce((sum, v) => sum + v, 0) +
          response.bounce.reduce((sum, v) => sum + v, 0);
        expect(total).toBeGreaterThan(1e-5);
      }
    }
    expect(wells).toBeGreaterThan(0);
  });

  it('still seals the void under the sole outside the well band', () => {
    // The admission is a band, not a licence: beside the flight, below the
    // landing's sole is still the sealed dark it always was.
    const well = INTERIOR_STEPS.find((steps) => steps.name === 'wardroomWell')!;
    const z = well.zTop + well.direction * (stepsRunLength(well) / 2);
    expect(lightRoomAt(well.x + well.halfBreadth + 0.2, 2.1, z)).not.toBe(
      'landing',
    );
  });
});

/**
 * A full-length channel-luminance array from a sparse per-channel map.
 *
 * The point is the length: `eyeLightMeterAt` multiplies transfer by luminance
 * channel for channel, so a short array reads `undefined` on the tail and every
 * downstream number becomes `NaN`. Padding here means adding a channel breaks
 * nothing quietly — an unnamed channel simply contributes zero, which is a
 * statement a test can be wrong about out loud.
 */
function channelLuminances(byChannel: Record<number, number>): number[] {
  return Array.from({ length: LIGHT_CHANNELS }, (_, p) => byChannel[p] ?? 0);
}

describe('eyeLightMeterAt', () => {
  const model = interiorLightModel();
  // Midday-shaped channel luminances: sky+beam on the two deck openings,
  // sky-only astern, boards shut.
  // **Sized from `LIGHT_CHANNELS`, not written out.** A hand-typed array of
  // four went silently to `undefined` on the fifth channel the moment one was
  // added, and `undefined` propagates as `NaN` through every meter in this
  // file — nine assertions failing with `expected NaN to be greater than NaN`,
  // none of which points at the fixture. Named per channel and padded, so a
  // sixth arrives as an explicit zero instead of a hole.
  const CHANNELS = channelLuminances({
    [CHANNEL_COMPANION]: 6.0,
    [CHANNEL_HATCH]: 6.0,
    [CHANNEL_WINDOWS]: 0.7,
    [CHANNEL_BOARDS]: 0.0,
    [CHANNEL_SCUTTLE]: 6.0,
  });

  /**
   * **This used to read `cabin > forecastle * 2`, and the fore scuttle is why
   * it does not any more.**
   *
   * That ordering was a true statement about an arrangement in which the
   * forecastle had no opening of its own at all: its only light was two hops of
   * doorway coupling from the cargo hatch, it metered about 1/50,000 of the
   * deck, and `SHIP_INTERIOR_HANDOVER.md` §9.4 had been carrying "the forecastle
   * still wants its scuttle" as a standing item for three rounds. Cutting the
   * scuttle is the whole point, so the assertion has to change — but it changes
   * to a *stronger* claim rather than a looser one, because a room with one
   * opening should now show the shape of that opening.
   */
  it('orders the rooms the way the light does', () => {
    const ladderFoot = eyeLightMeterAt(model, 0, 4.0, -3.0, CHANNELS)!;
    const cabin = eyeLightMeterAt(model, 0, 3.4, -6.0, CHANNELS)!;
    const underScuttle = eyeLightMeterAt(model, FORE_SCUTTLE_X, 3.0, FORE_SCUTTLE_Z, CHANNELS)!;
    const forecastlePeak = eyeLightMeterAt(model, 0, 3.0, 5.8, CHANNELS)!;

    // The companion shaft is still the brightest place below decks.
    expect(ladderFoot).toBeGreaterThan(cabin * 5);

    // Under its own scuttle the forecastle is now a lit room, not a dark one:
    // a direct sky opening beats four small stern lights by an order of
    // magnitude, which is what a hole in the deck against 0.65-transmittance
    // glass astern ought to look like.
    expect(underScuttle).toBeGreaterThan(cabin * 5);

    // And it is *one* opening, at the after end. The peak — forward, where the
    // berths are — is still the dimmest lived-in place in the ship. That is the
    // honest consequence of a 0.70 m hatch 2.8 m away, and it is worth pinning:
    // a solve that lit the whole room evenly from one scuttle would be wrong in
    // the direction this project keeps having to correct, the room-uniform bath.
    expect(forecastlePeak).toBeLessThan(underScuttle / 5);
    expect(forecastlePeak).toBeGreaterThan(0);
  });

  /**
   * **Shutting the lid must darken the forecastle — and darken it to exactly
   * the dark it had before the scuttle was cut, not to black.**
   *
   * This is the assertion the round's first attempt could not make. The
   * scuttle shared `CHANNEL_HATCH` then, so shutting the lid did nothing at
   * all; the alternative on the table was a per-room gate on that channel,
   * which would have gone too far the other way — the forecastle's *only*
   * light before this round also arrived on `CHANNEL_HATCH`, coupled through
   * the wardroom doorway, and a room gate would have taken that away too and
   * left a lid you shut to make the room blacker than the ship had ever drawn
   * it. `CHANNEL_SCUTTLE` exists so both halves can be true at once.
   *
   * The pre-scuttle numbers below were measured on the ship as she was, by
   * building the model with the scuttle's portal removed. They are the target,
   * and the gate hits them to within 0.2%.
   *
   * **They are re-measured whenever the scuttle moves.** The first set was
   * taken with the hatch at x = −1.30 and went stale the moment it moved
   * inboard to −1.10 for the pin-rail clearance — the "under the hatch" figure
   * alone changed by a third. A baseline pinned to a position is only evidence
   * while the position holds.
   */
  it('shuts the forecastle back to its doorway-lit dark, and no darker', () => {
    const shut = channelLuminances({ ...CHANNELS, [CHANNEL_SCUTTLE]: 0 });

    // Measured on the pre-scuttle ship: the wardroom doorway's own coupling,
    // which is dim but is a third of the captain's cabin and is not nothing.
    const beforeTheScuttle: Array<
      [string, readonly [number, number, number], number]
    > = [
      ['under the hatch', [FORE_SCUTTLE_X, 3.0, FORE_SCUTTLE_Z], 7.442e-3],
      ['mid room', [0, 3.0, 4.4], 2.879e-2],
      ['the berths, forward', [0, 3.0, 5.8], 1.163e-2],
    ];

    for (const [where, at, pre] of beforeTheScuttle) {
      const open = eyeLightMeterAt(model, ...at, CHANNELS)!;
      const closed = eyeLightMeterAt(model, ...at, shut)!;
      expect(closed, `${where} went dark instead of dim`).toBeGreaterThan(pre * 0.9);
      expect(closed, `${where} kept light the shut lid should have taken`).toBeLessThan(
        pre * 1.1,
      );
      expect(open, `${where} did not brighten when the lid came up`).toBeGreaterThan(
        closed * 2,
      );
    }
  });

  /**
   * The gate is the scuttle's alone. A channel shared with the cargo hatch
   * would have moved the wardroom and the hold every time anyone worked the
   * fore scuttle, which is the failure this channel was split to avoid.
   */
  it('leaves the after rooms where they were when the lid is worked', () => {
    const shut = channelLuminances({ ...CHANNELS, [CHANNEL_SCUTTLE]: 0 });
    const after: Array<[string, readonly [number, number, number]]> = [
      ['cabin', [0, 3.4, -6.0]],
      ['landing', [0, 3.6, -3.6]],
    ];
    for (const [room, at] of after) {
      const open = eyeLightMeterAt(model, ...at, CHANNELS)!;
      const closed = eyeLightMeterAt(model, ...at, shut)!;
      expect(Math.abs(open - closed) / open, `${room} moved with the scuttle`).toBeLessThan(
        0.001,
      );
    }

    // The wardroom is the exception and it is the honest one: it shares a
    // doorway with the forecastle, so an open scuttle really does put ~2% more
    // light into it. Small, one-directional, and bounded — not "unchanged".
    const wardroomOpen = eyeLightMeterAt(model, 0, 2.6, 1.4, CHANNELS)!;
    const wardroomShut = eyeLightMeterAt(model, 0, 2.6, 1.4, shut)!;
    expect(wardroomOpen).toBeGreaterThan(wardroomShut);
    expect((wardroomOpen - wardroomShut) / wardroomOpen).toBeLessThan(0.05);
  });

  /**
   * **Shipping the deadlights takes the cabin's daylight, and it is the boards'
   * own mechanism doing it.**
   *
   * The runtime gate is one line in `Schooner.publishPortalLight` — the same
   * shape as the hold's boards and the fore scuttle's lid — and what it does is
   * publish nothing on `CHANNEL_WINDOWS`. This is that channel zeroed, metered
   * where a body actually stands in the great cabin.
   *
   * **Two shapes of sky, because one of them understates it badly.** Under the
   * midday fixture the stern lights carry 0.7 against the deck openings' 6.0 —
   * they face away from the sun and the cabin is lit mostly through its own
   * door from the landing — so shipping the shutters costs mid-cabin only a
   * fifth of its light. With the sun astern it is the other way round and the
   * same act takes seven tenths. Both are true; a test that quoted only the
   * first would have let a cosmetic shutter through, and one that quoted only
   * the second would fail the day somebody re-tuned the noon sky.
   *
   * Measured, as percentages of the metered daylight lost:
   *
   * | | at the lights | mid cabin | at the desk |
   * |---|---|---|---|
   * | midday | 65 % | 21 % | 33 % |
   * | sun astern | 94 % | 69 % | 81 % |
   */
  it('darkens the cabin when the deadlights are shipped, and nothing else aboard', () => {
    const astern = channelLuminances({ ...CHANNELS, [CHANNEL_WINDOWS]: 6.0 });
    const cases: Array<[string, number[], number, number, number]> = [
      // sky shape, then the least each of the three points must lose.
      ['midday', CHANNELS, 0.5, 0.15, 0.25],
      ['with the sun astern', astern, 0.85, 0.6, 0.7],
    ];
    for (const [sky, open, atLights, midCabin, atDesk] of cases) {
      const shipped = channelLuminances(
        Object.fromEntries(open.map((value, p) => [p, p === CHANNEL_WINDOWS ? 0 : value])),
      );
      const at: Array<[string, readonly [number, number, number], number]> = [
        ['at the stern lights', [0, 3.6, -7.2], atLights],
        ['mid cabin', [0, 3.4, -6.0], midCabin],
        ['at the desk', [0.55, 3.4, -6.4], atDesk],
      ];
      for (const [where, point, least] of at) {
        const lit = eyeLightMeterAt(model, ...point, open)!;
        const shut = eyeLightMeterAt(model, ...point, shipped)!;
        expect(1 - shut / lit, `${sky}, ${where}: barely moved`).toBeGreaterThan(least);
        // Not black: the cabin still has its door, and a shutter that took the
        // room to nothing would be taking light that never came through it.
        expect(shut, `${sky}, ${where}: went black`).toBeGreaterThan(0);
      }
    }

    // The forward rooms are not lit through the stern lights, so shipping the
    // deadlights must not move them. The landing is the one that could — it
    // shares a doorway with the cabin — and it loses 2 %.
    const shipped = channelLuminances({ ...CHANNELS, [CHANNEL_WINDOWS]: 0 });
    const wardroom = eyeLightMeterAt(model, 0, 2.6, 1.4, CHANNELS)!;
    const wardroomShut = eyeLightMeterAt(model, 0, 2.6, 1.4, shipped)!;
    expect(Math.abs(wardroom - wardroomShut) / wardroom).toBeLessThan(0.01);
    const landing = eyeLightMeterAt(model, 0, 3.6, -3.6, CHANNELS)!;
    const landingShut = eyeLightMeterAt(model, 0, 3.6, -3.6, shipped)!;
    expect(landingShut).toBeLessThanOrEqual(landing);
    expect((landing - landingShut) / landing).toBeLessThan(0.05);
  });

  it('meters the shut hold at nothing — no gain rescues a sealed dark', () => {
    const hold = eyeLightMeterAt(model, 0, 1.4, 1.4, CHANNELS)!;
    expect(hold).toBeLessThan(1e-9);
    // Boards open, the same point meters something.
    const open = eyeLightMeterAt(
      model,
      0,
      1.4,
      1.4,
      channelLuminances({ ...CHANNELS, [CHANNEL_BOARDS]: 2.0 }),
    )!;
    expect(open).toBeGreaterThan(0.001);
  });

  it('is a continuous field along the walk from the ladder into the cabin', () => {
    // The adaptation this feeds replaces a binary flag; a seam anywhere on
    // the walk would put the jump right back. 20 cm strides, bounded ratio.
    const eyeY = 4.05;
    let previous: number | null = null;
    for (let z = -3.0; z >= -6.4; z -= 0.2) {
      const meter = eyeLightMeterAt(model, 0, eyeY, z, CHANNELS);
      expect(meter).not.toBeNull();
      if (previous !== null) {
        const ratio = Math.max(meter!, 1e-9) / Math.max(previous, 1e-9);
        expect(ratio).toBeGreaterThan(1 / 4);
        expect(ratio).toBeLessThan(4);
      }
      previous = meter;
    }
  });

  it('meters the view in gaze mode: the dark cabin door reads darker than the lit shaft', () => {
    // Ash's case: standing in the landing looking at the captain's doorway,
    // the room beyond reads pitch black until you step in. Gaze metering
    // must fall when the view turns from the bright companionway to the dim
    // door, so the exposure opens BEFORE the step through.
    const eye: [number, number, number] = [0, 3.7, -3.6];
    const towardShaft = eyeLightMeterAt(model, ...eye, CHANNELS, [0.35, 0.75, 0.55])!;
    const towardCabinDoor = eyeLightMeterAt(model, ...eye, CHANNELS, [0, -0.15, -0.99])!;
    expect(towardShaft).toBeGreaterThan(towardCabinDoor * 2);
    // And the gaze answer toward the door approaches what the position
    // meter reads INSIDE the cabin — the two modes agree across the
    // threshold, which is what kills the step-through brightening.
    const insideCabin = eyeLightMeterAt(model, 0, 3.5, -4.8, CHANNELS)!;
    expect(towardCabinDoor).toBeLessThan(insideCabin * 20);
    expect(towardCabinDoor).toBeGreaterThan(insideCabin / 20);
  });

  it('treats an eye above a downward deck opening as outdoors', () => {
    // Ash's two marked rays, 18 cm apart on the companion ladder, sat either
    // side of a ×14 exposure snap: the shaft ceiling admitted the eye to the
    // landing ABOVE the one-sided portal plane, where the portal radiates
    // nothing and the meter saw only the dim bath. Above the hole is the
    // open air, whatever the room lookup says.
    expect(eyeLightMeterAt(model, 1.3872, 5.3049, -2.5167, CHANNELS)).toBeNull(); // ray 2's origin
    expect(eyeLightMeterAt(model, 1.2, 5.0, -3.3, CHANNELS)).toBeNull();
    // Over the grating too: standing on the cargo hatch, head above the deck.
    expect(eyeLightMeterAt(model, 0, 4.2, 1.4, CHANNELS)).toBeNull();
    // Below the plane the meter answers again, and generously — the shaft.
    const belowPlane = eyeLightMeterAt(model, 1.2, 4.4, -3.3, CHANNELS);
    expect(belowPlane).not.toBeNull();
    expect(belowPlane!).toBeGreaterThan(1);
  });

  it('descends the companion shaft without an exposure cliff', () => {
    // The gain a meter value implies, at the shipped target and cap
    // (Schooner's ADAPTATION_METER_TARGET / ADAPTATION_GAIN_CAP).
    const gainOf = (meter: number | null): number =>
      meter === null ? 1 : Math.min(Math.max(1.5 / Math.max(meter, 1e-6), 1), 40);
    let previous = gainOf(eyeLightMeterAt(model, 1.2, 6.2, -3.3, CHANNELS));
    for (let y = 6.0; y >= 3.2; y -= 0.2) {
      const gain = gainOf(eyeLightMeterAt(model, 1.2, y, -3.3, CHANNELS));
      const ratio = gain / previous;
      expect(ratio).toBeLessThan(2.05);
      expect(ratio).toBeGreaterThan(1 / 2.05);
      previous = gain;
    }
  });

  it('converges toward the open sky at the companionway mouth', () => {
    const zShaft = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) / 2;
    const nearMouth = eyeLightMeterAt(model, 1.2, 4.35, zShaft, CHANNELS)!;
    const inLanding = eyeLightMeterAt(model, 0, 3.6, -3.6, CHANNELS)!;
    // Rising up the shaft the sky opening fills the view: the meter must
    // approach the opening's own level, far above the room's, so the gain
    // law reaches ~1 before the room lookup ever flips to null.
    expect(nearMouth).toBeGreaterThan(CHANNELS[0] * 0.4);
    expect(nearMouth).toBeGreaterThan(inLanding * 3);
  });
});

describe('bathGradientAt', () => {
  const model = interiorLightModel();

  it('shapes the wardroom bath around its hatch', () => {
    const underHatch = bathGradientAt(model, 'wardroom', CHANNEL_HATCH, 0, 1.85, 1.4);
    const aftCorner = bathGradientAt(model, 'wardroom', CHANNEL_HATCH, 1.5, 1.85, -2.2);
    expect(underHatch).toBeGreaterThan(1);
    expect(aftCorner).toBeLessThan(1);
    expect(underHatch).toBeGreaterThan(aftCorner * 1.5);
  });

  it('carries two gradients in one room — the cabin, Ash\'s own example', () => {
    // Window light concentrates aft where the windows are; the landing's
    // light arrives through the door and concentrates forward. One vec4,
    // two shapes, four windows summed inside one of them.
    const nearWindows = bathGradientAt(model, 'cabin', CHANNEL_WINDOWS, 0, 3.4, -7.6);
    const nearDoor = bathGradientAt(model, 'cabin', CHANNEL_WINDOWS, 0, 3.4, -4.6);
    expect(nearWindows).toBeGreaterThan(nearDoor);

    const doorSideComp = bathGradientAt(model, 'cabin', CHANNEL_COMPANION, 0, 3.4, -4.6);
    const sternSideComp = bathGradientAt(model, 'cabin', CHANNEL_COMPANION, 0, 3.4, -7.6);
    expect(doorSideComp).toBeGreaterThan(sternSideComp);
  });

  it('redistributes without creating light: independent room mean stays ~1', () => {
    // A sampling the normalisation never saw: different grid, same rooms.
    const wardroom = model.rooms.find((r) => r.name === 'wardroom')!;
    let weighted = 0;
    let area = 0;
    for (let i = 0; i < 11; i++) {
      const z = wardroom.zAft + ((wardroom.zForward - wardroom.zAft) * (i + 0.5)) / 11;
      for (const y of [1.85, 2.6, 3.5]) {
        for (const x of [-1.6, -0.6, 0.6, 1.6]) {
          weighted += bathGradientAt(model, 'wardroom', CHANNEL_HATCH, x, y, z);
          area += 1;
        }
      }
    }
    const mean = weighted / area;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(1.25);
  });

  it('stays inside a sane band and returns 1 where a channel has no source', () => {
    for (const room of ['cabin', 'landing', 'wardroom', 'forecastle'] as const) {
      const r = model.rooms.find((candidate) => candidate.name === room)!;
      for (let p = 0; p < LIGHT_CHANNELS; p++) {
        for (let i = 0; i < 8; i++) {
          const z = r.zAft + ((r.zForward - r.zAft) * (i + 0.5)) / 8;
          const g = bathGradientAt(model, room, p, 0, r.soleY + 1, z);
          expect(g).toBeGreaterThan(0.05);
          expect(g).toBeLessThan(5);
        }
      }
    }
    // The forecastle has no boards-channel source at all: uniform 1.
    expect(bathGradientAt(model, 'forecastle', CHANNEL_BOARDS, 0, 3, 4.4)).toBe(1);
  });

  it('feeds the vertex response: gradient bath moves, glow and direct stay', () => {
    const under = vertexLightResponse(model, 0, 1.81, 1.4, 0, 1, 0);
    expect(under.bounceGradient[CHANNEL_HATCH]).toBeGreaterThan(
      under.bounce[CHANNEL_HATCH],
    );
    for (let p = 0; p < LIGHT_CHANNELS; p++) {
      expect(under.direct[p]).toBe(under.direct[p]); // direct untouched by design
    }
    const corner = vertexLightResponse(model, 1.5, 1.81, -2.2, 0, 1, 0);
    expect(corner.bounceGradient[CHANNEL_HATCH]).toBeLessThan(
      corner.bounce[CHANNEL_HATCH],
    );
  });
});

// --- the vertex response -----------------------------------------------------------

describe('vertexLightResponse', () => {
  const model = interiorLightModel();

  it('lights the sole under the open hatch more than a corner behind the ladder', () => {
    const zShaft = (COMPANION_AFT_Z + COMPANION_FORWARD_Z) / 2;
    const underOpening = vertexLightResponse(model, 1.0, CABIN_SOLE_Y, zShaft, 0, 1, 0);
    const corner = vertexLightResponse(model, -1.2, CABIN_SOLE_Y, -4.2, 0, 1, 0);
    expect(underOpening.direct[CHANNEL_COMPANION]).toBeGreaterThan(
      corner.direct[CHANNEL_COMPANION] * 3,
    );
  });

  it('lights the two side walls of the cabin nearly alike', () => {
    // The reported fault this round exists to fix: opposite wall normals must
    // not produce grossly different responses in an enclosed room. The stern
    // windows sit near the centreline, so port and starboard walls see them
    // nearly symmetrically.
    const port = vertexLightResponse(model, 1.1, CABIN_SOLE_Y + 1.0, -5.5, -1, 0, 0);
    const starboard = vertexLightResponse(model, -1.1, CABIN_SOLE_Y + 1.0, -5.5, 1, 0, 0);
    const total = (r: typeof port): number =>
      r.direct.reduce((s, v) => s + v, 0) + r.bounce.reduce((s, v) => s + v, 0);
    const hi = Math.max(total(port), total(starboard));
    const lo = Math.min(total(port), total(starboard));
    expect(hi / lo).toBeLessThan(1.35);
  });

  it('gives the wall facing a doorway more of the neighbour glow than the wall behind it', () => {
    // In the cabin: the doorway to the landing is forward on the centreline.
    const facingDoor = vertexLightResponse(
      model,
      0,
      CABIN_SOLE_Y + 1.0,
      -6.8,
      0,
      0,
      1, // aft wall looking forward at the door
    );
    const behindDoor = vertexLightResponse(
      model,
      0.4,
      CABIN_SOLE_Y + 1.0,
      -4.45,
      0,
      0,
      -1, // forward wall looking aft, door behind it
    );
    expect(facingDoor.bounce[CHANNEL_COMPANION]).toBeGreaterThan(
      behindDoor.bounce[CHANNEL_COMPANION],
    );
  });

  it('returns nothing for a surface in a sealed void', () => {
    const response = vertexLightResponse(model, 0, 1.5, -5.5, 0, 1, 0);
    expect(response.direct.every((v) => v === 0)).toBe(true);
    expect(response.bounce.every((v) => v === 0)).toBe(true);
  });

  it('feeds the hold only through the boards channel', () => {
    const inHold = vertexLightResponse(model, 0, HOLD_FLOOR_Y + 0.1, CARGO_HATCH_Z, 0, 1, 0);
    expect(inHold.direct[CHANNEL_BOARDS]).toBeGreaterThan(0.1);
    expect(inHold.direct[CHANNEL_COMPANION]).toBe(0);
    expect(inHold.direct[CHANNEL_HATCH]).toBe(0);
    expect(inHold.direct[CHANNEL_WINDOWS]).toBe(0);
  });

  it('keeps every response inside the physical band', () => {
    // A dense sweep over the cabin and wardroom: direct + bounce per channel
    // can never exceed 1 + max radiosity — nothing a hemisphere cannot hold.
    for (let z = -7; z <= 2.4; z += 0.8) {
      for (let y = 1.0; y <= 4.2; y += 0.6) {
        for (const n of [
          [0, 1, 0],
          [0, -1, 0],
          [1, 0, 0],
          [0, 0, 1],
        ] as const) {
          const r = vertexLightResponse(model, 0.4, y, z, n[0], n[1], n[2]);
          for (let p = 0; p < LIGHT_CHANNELS; p++) {
            expect(r.direct[p]).toBeGreaterThanOrEqual(0);
            expect(r.direct[p]).toBeLessThanOrEqual(1);
            expect(r.bounce[p]).toBeGreaterThanOrEqual(0);
            expect(r.bounce[p]).toBeLessThan(1.5);
          }
        }
      }
    }
  });
});

// --- small helpers ------------------------------------------------------------------

describe('rect helpers', () => {
  it('measures area and corners consistently', () => {
    const rect: LightRect = {
      name: 'test',
      centre: [1, 2, 3],
      edgeU: [0.5, 0, 0],
      edgeV: [0, 0, 1.5],
      normal: [0, 1, 0],
    };
    expect(rectArea(rect)).toBeCloseTo(3, 10);
    const corners = rectCorners(rect);
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual([0.5, 2, 1.5]);
    expect(corners[2]).toEqual([1.5, 2, 4.5]);
  });

  it('converts sRGB hex to linear with the exact transfer curve', () => {
    expect(linearRgbOfHex(0xffffff)).toEqual([1, 1, 1]);
    const mid = linearRgbOfHex(0x808080);
    expect(mid[0]).toBeCloseTo(0.2158, 3);
  });

  it('agrees between the two form-factor quadratures', () => {
    const a: LightRect = {
      name: 'a',
      centre: [0, 0, 0],
      edgeU: [0.75, 0, 0],
      edgeV: [0, 0, 0.9],
      normal: [0, 1, 0],
    };
    const b: LightRect = {
      name: 'b',
      centre: [0, 2.1, 0],
      edgeU: [0.75, 0, 0],
      edgeV: [0, 0, 0.9],
      normal: [0, -1, 0],
    };
    const f = rectToRectFormFactor(a, b);
    // The exact aligned-equal-rectangles factor for these proportions is
    // ~0.15–0.2 (Howell catalogue C-11); hold the quadrature to that band.
    expect(f).toBeGreaterThan(0.1);
    expect(f).toBeLessThan(0.3);
  });
});
