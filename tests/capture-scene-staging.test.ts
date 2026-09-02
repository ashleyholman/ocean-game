import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { findAbSwitch } from '../src/debug/abSwitches';
import {
  isLegacyMoonlight,
  LEGACY_MOON_SKY_POWER,
  MOON_SKY_POWER,
  moonSkyPower,
  setLegacyMoonlight,
  TimeOfDay,
} from '../src/scene/TimeOfDay';
import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';
import {
  AUTHORED_TRIM_DEG,
  createSailControlReadout,
  SailingControls,
} from '../src/vessel/schooner/SailingControls';
import { RIG_TRIM_LIMITS } from '../src/vessel/schooner/rig';
import {
  openingTrimDeg,
  openingTrueWindAngleDeg,
  OPENING_TRIMMED_SAILS,
  trimDegForTrueWindAngle,
} from '../src/world/openingVoyage';
import { utcDayOfYear } from '../src/astronomy/AstronomyProvider';
import { OPENING_UTC_SECONDS } from '../src/world/openingVoyage';
import type { SailName } from '../src/vessel/schooner/rig';

/**
 * The three capabilities the A/B harness was missing, and what each unblocks.
 *
 * Sixteen review-queue lines became pictures the day the capture instrument
 * landed. Three could not, and none of them for want of trying: each named a
 * specific capability that did not exist. This file guards the three.
 */

const DEG = Math.PI / 180;

describe('the sheets follow the tack, wherever the point of sail comes from', () => {
  it('hauls to leeward: a wind over port puts every sheet to starboard', () => {
    // Positive angle is the wind over the port side (`trueWindAngleDeg`), and a
    // sheet is hauled to leeward, so every sign is the mirror of the side the
    // wind comes over. Getting this backwards does not fail — it draws a rig
    // with every sail aback and captions it a broad reach.
    const port = trimDegForTrueWindAngle(60);
    const starboard = trimDegForTrueWindAngle(-60);
    for (const sail of OPENING_TRIMMED_SAILS) {
      const magnitude = Math.abs(AUTHORED_TRIM_DEG[sail]);
      expect(port[sail], sail).toBeCloseTo(-magnitude, 10);
      expect(starboard[sail], sail).toBeCloseTo(magnitude, 10);
    }
  });

  it('keeps the authored fan rather than flattening it to one number', () => {
    // The magnitudes are a sail plan, not a slider position: each sail further
    // forward is eased more because of what it does to the slot behind it.
    const trims = trimDegForTrueWindAngle(90);
    const magnitudes = OPENING_TRIMMED_SAILS.map((sail) =>
      Math.abs(trims[sail]!),
    );
    expect(new Set(magnitudes).size).toBeGreaterThan(1);
    expect(Math.max(...magnitudes)).toBeGreaterThan(Math.min(...magnitudes));
  });

  it('leaves the opening condition exactly where it was', () => {
    // `openingTrimDeg` now delegates. It is an initial condition the whole
    // opening voyage is tested against, so the refactor has to be inert.
    expect(openingTrimDeg()).toEqual(
      trimDegForTrueWindAngle(openingTrueWindAngleDeg()),
    );
  });
});

describe('a sheet re-set as an initial condition', () => {
  it('moves the current angle and the target together, so nothing walks', () => {
    const controls = new SailingControls();
    controls.setInitialTrimDeg('mainsail', -26);
    expect(controls.trimDeg('mainsail')).toBe(-26);
    const readout = controls.readSail('mainsail', createSailControlReadout());
    expect(readout.trimDeg).toBe(-26);
    expect(readout.trimTargetDeg).toBe(-26);
    // And it stays there under an ordinary advance, which a commanded trim
    // would not: `commandTrimDeg` moves the target and lets the sheet walk.
    controls.advanceSubstep(1);
    expect(controls.trimDeg('mainsail')).toBe(-26);
  });

  it('is the opposite of a command, and the difference is visible', () => {
    const commanded = new SailingControls();
    commanded.commandTrimDeg('mainsail', -26);
    expect(commanded.trimDeg('mainsail')).not.toBe(-26);
    expect(
      commanded.readSail('mainsail', createSailControlReadout()).trimTargetDeg,
    ).toBe(-26);
  });

  it('clamps to the rig rather than accepting an impossible sheet', () => {
    const controls = new SailingControls();
    controls.setInitialTrimDeg('mainsail', 1000);
    expect(controls.trimDeg('mainsail')).toBe(RIG_TRIM_LIMITS.mainsail.maxDeg);
  });

  it('refuses the two sails that have no sheet of their own', () => {
    const controls = new SailingControls();
    expect(() => controls.setInitialTrimDeg('mainGaffTopsail', 10)).toThrow(
      /slaved/,
    );
    expect(() =>
      controls.setInitialTrimDeg('mainTopmastStaysail', 10),
    ).toThrow(/a side, not a trim/);
    expect(() =>
      controls.setInitialTrimDeg('mainsail', Number.NaN),
    ).toThrow(/must be finite/);
  });
});

describe("the cloth arm is photographable now — REVIEW_QUEUE 2.6", () => {
  const cloth = findAbSwitch('cloth');

  it('is a page-load switch, because the rig is lofted once', () => {
    // `flat` decides whether a cloth state is attached to the loft AT ALL, and
    // that happens in `VesselRuntime`'s constructor. An arm chosen after the
    // ship exists is an arm that does nothing, silently.
    expect(cloth.scope).toBe('reload');
    expect(cloth.apply).toBeUndefined();
    expect(cloth.urlFor!('flat')).toEqual({ cloth: 'flat' });
    expect(cloth.defaultArm).toBe('alive');
  });

  it('reads back through the runtime rather than through the URL', () => {
    const readsFlat = cloth.read({
      sailClothMode: () => 'flat',
    } as never);
    expect(readsFlat).toBe('flat');
    expect(cloth.read({ sailClothMode: () => 'alive' } as never)).toBe('alive');
  });

  it('agrees with what ?cloth= parses to, arm for arm', () => {
    // The pair that matters: what the URL asks for and what the registry reads
    // back have to be the same alphabet, or the tier assertion rejects every
    // frame of a perfectly good capture.
    const host = { viewportWidth: 1280, viewportHeight: 720, isTouch: false };
    for (const arm of cloth.arms) {
      const parsed = resolveRuntimeOptions(
        new URLSearchParams(cloth.urlFor!(arm) as Record<string, string>),
        host,
      ).sailClothMode;
      expect(parsed, arm).toBe(arm);
    }
  });
});

describe("the scotopic sheet follows Ash's shipping verdict", () => {
  it('puts the unlifted arm first and marks it as the default', () => {
    const observer = findAbSwitch('scotopic');
    expect(observer.defaultArm).toBe('0');
    expect(observer.arms).toEqual(['0', '1']);
  });
});

describe('the moon has a second arm now — REVIEW_QUEUE 3.2', () => {
  const skyAt = (
    sunElevationDeg: number,
    moonElevationDeg: number,
    moonFraction: number,
  ): TimeOfDay => {
    const time = new TimeOfDay();
    const el = sunElevationDeg * DEG;
    const moonEl = moonElevationDeg * DEG;
    time.refreshFromAstronomy(
      1e6,
      new THREE.Vector3(Math.cos(el), Math.sin(el), 0),
      0,
      el,
      new THREE.Vector3(-Math.cos(moonEl), Math.sin(moonEl), 0),
      Math.PI,
      moonEl,
      moonFraction,
    );
    return time;
  };
  const vlum = (v: THREE.Vector3): number =>
    0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;

  it('ships on the arm it ships on, and says so', () => {
    expect(isLegacyMoonlight()).toBe(false);
    expect(moonSkyPower()).toBe(MOON_SKY_POWER);
    expect(findAbSwitch('legacyMoonlight').defaultArm).toBe('0');
  });

  it('is byte-identical off, which is the whole house rule', () => {
    const before = skyAt(-25, 40, 1);
    const reference = {
      power: before.moonPower,
      ambient: before.ambientRadiance.clone(),
    };
    setLegacyMoonlight(true);
    setLegacyMoonlight(false);
    const after = skyAt(-25, 40, 1);
    expect(after.moonPower).toBe(reference.power);
    expect(after.ambientRadiance.x).toBe(reference.ambient.x);
    expect(after.ambientRadiance.y).toBe(reference.ambient.y);
    expect(after.ambientRadiance.z).toBe(reference.ambient.z);
  });

  it('separates 1.79x from 12.14x — the number Part B actually moved', () => {
    // The queue line in one assertion. Part B raised the moon's SKY power from
    // 0.070 to 1.0 and left the direct light alone (0.34 hand-set became 0.36
    // derived, within 6%), so this switch moves the sky power and nothing else
    // — which is exactly the change under review.
    const moonless = () => vlum(skyAt(-25, -30, 0.5).ambientRadiance);
    const full = () => vlum(skyAt(-25, 40, 1).ambientRadiance);

    const shipping = full() / moonless();
    setLegacyMoonlight(true);
    try {
      expect(moonSkyPower()).toBe(LEGACY_MOON_SKY_POWER);
      const legacy = full() / moonless();
      expect(legacy).toBeGreaterThan(1.5);
      expect(legacy).toBeLessThan(2.2);
      expect(shipping / legacy).toBeGreaterThan(5);
    } finally {
      setLegacyMoonlight(false);
    }
    expect(shipping).toBeGreaterThanOrEqual(10);
  });

  it('leaves a moonless night alone on both arms', () => {
    // The moon is gated to exactly zero power when it is down, so an arm that
    // scales that zero cannot brighten anything. This is what makes the
    // dayOfYear field load-bearing rather than a convenience: on the opening
    // day the moon IS down, and both arms are then identically nothing.
    const down = () => skyAt(-25, -30, 0.097);
    const shipping = down();
    setLegacyMoonlight(true);
    try {
      const legacy = down();
      expect(shipping.moonPower).toBe(0);
      expect(legacy.moonPower).toBe(0);
      expect(vlum(legacy.ambientRadiance)).toBe(
        vlum(shipping.ambientRadiance),
      );
    } finally {
      setLegacyMoonlight(false);
    }
  });
});

describe('the capture scene can leave the opening day', () => {
  it('counts dayOfYear from the day the opening instant falls on', () => {
    // The origin the capture host offsets from. Pinned because the whole
    // reproducibility claim rests on "the same request names the same
    // instant", and a moving origin quietly breaks that across a year boundary.
    expect(utcDayOfYear(OPENING_UTC_SECONDS)).toBe(15);
    expect(new Date(OPENING_UTC_SECONDS * 1000).toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    );
  });
});

/** Every trimmed sail is a real rig sail, or the fan silently drops one. */
describe('the trimmed set is the rig', () => {
  it('names only sails the rig has sheets for', () => {
    for (const sail of OPENING_TRIMMED_SAILS as readonly SailName[]) {
      expect(RIG_TRIM_LIMITS[sail], sail).toBeTruthy();
      expect(sail).not.toBe('mainGaffTopsail');
      expect(sail).not.toBe('mainTopmastStaysail');
    }
  });
});
