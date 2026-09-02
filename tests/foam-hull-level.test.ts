import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FOAM_FAR_EXTENT,
  FOAM_HULL_EXTENT,
  FOAM_NEAR_EXTENT,
  FOAM_QUALITY_DESKTOP,
} from '../src/scene/FoamField';

const FOAM_SOURCE = readFileSync('src/scene/FoamField.ts', 'utf8');
const OCEAN_SOURCE = readFileSync('src/scene/Ocean.ts', 'utf8');

/** Where the ocean lookup has finished fading a level out, in uv from centre. */
const LOOKUP_FADE_END = 0.443;
/** Where the toroidal field wraps. */
const WRAP_EDGE = 0.5;

describe('the hull foam level', () => {
  it('holds 0.375 m per texel, one resolution step from the near level', () => {
    const hullTexel = FOAM_HULL_EXTENT / FOAM_QUALITY_DESKTOP.hullResolution;
    const nearTexel = FOAM_NEAR_EXTENT / FOAM_QUALITY_DESKTOP.nearResolution;
    // The collar detail this level exists for is unchanged by WK-R13's
    // widening: the window and the resolution doubled together.
    expect(hullTexel).toBeCloseTo(0.375, 6);
    // One step, not two. At 4x the whole ribbon-to-chunks transition happened
    // at once, a ship length astern.
    expect(nearTexel / hullTexel).toBeCloseTo(2, 6);

    const hullTexels = FOAM_QUALITY_DESKTOP.hullResolution ** 2;
    const nearTexels = FOAM_QUALITY_DESKTOP.nearResolution ** 2;
    expect(hullTexels / nearTexels).toBeCloseTo(0.25, 6);
  });

  it('pushes the first handover clear of the vessel and her near trail', () => {
    // Ash's complaint was that the break-up landed about one ship length
    // astern, right where the eye is. The fade band has to end well past that.
    const LOA_M = 15.5;
    const fadeStartM = 0.286 * FOAM_HULL_EXTENT;
    const fadeEndM = LOOKUP_FADE_END * FOAM_HULL_EXTENT;
    expect(fadeStartM / LOA_M).toBeGreaterThan(1.7);
    expect(fadeEndM / LOA_M).toBeGreaterThan(2.5);
    // And the blend band scales with the window, so it is exactly twice what
    // the 48 m window gave: 15.07 m, near enough a ship length, against 7.53.
    const PREVIOUS_EXTENT_M = 48;
    const bandM = (LOOKUP_FADE_END - 0.286) * FOAM_HULL_EXTENT;
    expect(fadeEndM - fadeStartM).toBeCloseTo(bandM, 10);
    expect(bandM / ((LOOKUP_FADE_END - 0.286) * PREVIOUS_EXTENT_M)).toBeCloseTo(2, 10);
    expect(bandM).toBeGreaterThan(0.9 * LOA_M);
  });

  it('covers the whole schooner well inside its own fade', () => {
    // 15.5 m stem to transom, centred, so +/- 7.75 m has to sit inside the
    // band where the level still carries full weight.
    const fullWeightRadiusM = 0.286 * FOAM_HULL_EXTENT;
    expect(fullWeightRadiusM).toBeGreaterThan(7.75);
  });

  it('kills recirculating foam strictly outside the lookup fade, before the wrap', () => {
    // The bug this exists for: every level is a torus, and 48 m is only
    // thirteen seconds at tow speed against B's 45 s constant, so most of the
    // trail used to survive the trip round and come back as a second wake.
    //
    // Both bounds matter. Start too early and the kill eats foam the lookup is
    // still blending in, which punches a dark ring through the crossfade;
    // finish too late and foam reaches the wrap alive and the ghost returns.
    const match = FOAM_SOURCE.match(
      /HULL_EDGE_KILL = new THREE\.Vector2\(([\d.]+), ([\d.]+)\)/,
    );
    expect(match).not.toBeNull();
    const start = Number(match![1]);
    const end = Number(match![2]);
    expect(start).toBeGreaterThanOrEqual(LOOKUP_FADE_END);
    expect(end).toBeLessThan(WRAP_EDGE);
    expect(end).toBeGreaterThan(start);
  });

  it('shows why the wide levels could not be left to decay alone', () => {
    // The claim this replaces: "384 m against a ~160 m e-fold is nine halvings
    // by the time anything comes back around, so the near and far levels need
    // no kill". Those two numbers do not go together. exp(-384/160) is nine
    // per cent, not 2^-9's two tenths of one per cent — 2^-9 needs a 62 m
    // e-fold. Nine per cent of the WK-R6 trail is a legible second streak, and
    // Ash saw it at about 100 m.
    const bTauSeconds = 45;
    const towSpeedMps = 3.59;
    const eFoldM = bTauSeconds * towSpeedMps;
    expect(eFoldM).toBeCloseTo(161.6, 0);

    const survivingNear = Math.exp(-FOAM_NEAR_EXTENT / eFoldM);
    expect(survivingNear).toBeGreaterThan(0.05);
    expect(survivingNear).toBeLessThan(0.15);
    // What the old note asserted, for contrast.
    expect(survivingNear).toBeGreaterThan(2 ** -9 * 40);

    expect(FOAM_NEAR_EXTENT / FOAM_HULL_EXTENT).toBe(4);
    expect(FOAM_FAR_EXTENT / FOAM_NEAR_EXTENT).toBe(4);
    expect(FOAM_SOURCE).not.toContain('NO_EDGE_KILL');
  });

  it('gives every level a kill outside its own fade and before the wrap', () => {
    // Structural rule, not a per-level judgement: placed outside the level's
    // own lookup fade the band costs nothing visible, and it makes the next
    // change to persistence or injected area unable to reopen R5-3.
    const levels: Array<[string, number]> = [
      ['NEAR_EDGE_KILL', 0.443],
      ['FAR_EDGE_KILL', 0.456],
      ['HULL_EDGE_KILL', 0.443],
    ];
    for (const [name, fadeEnd] of levels) {
      const match = FOAM_SOURCE.match(
        new RegExp(`${name} = new THREE\\.Vector2\\(([\\d.]+), ([\\d.]+)\\)`),
      );
      expect(match, name).not.toBeNull();
      const start = Number(match![1]);
      const end = Number(match![2]);
      expect(start, name).toBeGreaterThanOrEqual(fadeEnd);
      expect(end, name).toBeLessThan(WRAP_EDGE);
      expect(end, name).toBeGreaterThan(start);
    }
  });

  it('applies the kill in the advect pass, where recirculation happens', () => {
    expect(FOAM_SOURCE).toContain('float keep = 1.0 - smoothstep(uEdgeKill.x, uEdgeKill.y, edge);');
    expect(FOAM_SOURCE).toContain('previous * uDecay * keep');
  });

  it('blends innermost-first', () => {
    expect(OCEAN_SOURCE).toContain('return mix(outer, foamHull, hullFade);');
  });

  it('reconstructs the hull level with a gated four-tap B-spline', () => {
    // The hull level is the one that gets magnified hard — 0.375 m texels seen
    // from the rail — so it is the one where bilinear's C0 gradient jump shows
    // as a threshold snapping to the texel lattice: the 45-degree sawtooth
    // along the foam beside the hull. Four taps buy a C2 reconstruction with no
    // lattice in it.
    expect(OCEAN_SOURCE.match(/texture2D\(uFoamHull/g)).toHaveLength(4);
    // They are affordable only because the 48 m window means almost every
    // ocean fragment skips them. The gate is the contract, not the tap count.
    expect(OCEAN_SOURCE).toContain('if (hullFade > 0.0) {');
    expect(OCEAN_SOURCE).toContain('foamHull = foamHullBSpline(hullUv);');
    // The near and far levels keep plain bilinear plus the established warp, so
    // the foam-lookup A/B levers still mean exactly what they meant.
    expect(OCEAN_SOURCE).toContain(
      'vec2 nearFetch = smoothTexelUv(nearUv, float(FOAM_NEAR_RESOLUTION), uFoamLookupSmoothing);',
    );
  });

  it('uses a rounded window so no level handover has a straight edge', () => {
    // max(off.x, off.y) is the Chebyshev distance and its iso-lines are literal
    // axis-aligned squares, so every handover was ruled across the sea as a
    // straight line — the square outline around the widened wake trail.
    expect(OCEAN_SOURCE).toContain('float windowEdge(vec2 offsetFromCentre)');
    expect(OCEAN_SOURCE).not.toContain('float nearEdge = max(nearOff.x, nearOff.y);');
    for (const level of ['nearEdge = windowEdge(nearOff)', 'farEdge = windowEdge(farOff)', 'hullEdge = windowEdge(hullOff)']) {
      expect(OCEAN_SOURCE).toContain(level);
    }
  });

  it('keeps the rounded window inside the wrap the square one allowed', () => {
    // The L4 ball of a given radius is contained in the L-infinity square of
    // the same radius, so switching metrics can only move a fade inward. Along
    // the axes the edges are unchanged; the corners — the worst case for the
    // toroidal wrap — are now excluded rather than admitted.
    const l4 = (x: number, y: number) => (x ** 4 + y ** 4) ** 0.25;
    const linf = (x: number, y: number) => Math.max(x, y);
    const FADE_END = 0.443;
    const WRAP_EDGE = 0.5;

    // Unchanged on the axes.
    expect(l4(FADE_END, 0)).toBeCloseTo(linf(FADE_END, 0), 12);

    // The old square admitted its corner; the rounded window fades it out.
    expect(linf(FADE_END, FADE_END)).toBeLessThanOrEqual(FADE_END);
    expect(l4(FADE_END, FADE_END)).toBeGreaterThan(FADE_END);

    // Every point the rounded window still admits is inside the wrap, because
    // no coordinate on the L4 ball of radius FADE_END exceeds FADE_END itself.
    for (let i = 0; i <= 64; i++) {
      const theta = (i / 64) * (Math.PI / 2);
      // Walk the L4 iso-surface at the fade end and check its extent.
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const scale = FADE_END / l4(c, s);
      expect(Math.max(c * scale, s * scale)).toBeLessThanOrEqual(FADE_END + 1e-12);
      expect(Math.max(c * scale, s * scale)).toBeLessThan(WRAP_EDGE);
    }
  });
});
