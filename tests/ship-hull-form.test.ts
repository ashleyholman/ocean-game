import { describe, expect, it } from 'vitest';
import {
  AFT_RISE_Z,
  CABIN_SOLE_Y,
  DESIGN_DRAUGHT,
  FORE_RISE_Z,
  HALF_LENGTH,
  floorYAt,
  walkingDeckY,
} from '../src/vessel/schooner/hullForm';
import {
  KEEL_DRAG,
  KEEL_DEPTH,
  backboneBottomY,
  navigationalDraught,
  rudderBottomY,
} from '../src/vessel/schooner/backbone';
import { buildLightship } from '../src/vessel/schooner/massModel';

describe('the working schooner hull form', () => {
  it('hangs a substantial keel below the moulded baseline, with drag aft', () => {
    expect(KEEL_DEPTH).toBe(0.38);
    expect(KEEL_DRAG).toBe(0.35);
    expect(backboneBottomY(-6.6)).toBeLessThan(backboneBottomY(4.4));
    expect(rudderBottomY()).toBeCloseTo(backboneBottomY(-6.6), 9);

    const nav = navigationalDraught();
    expect(nav.forward).toBeCloseTo(2.52, 6);
    expect(nav.aft).toBeCloseTo(2.87, 6);
    expect(nav.aft - nav.forward).toBeCloseTo(KEEL_DRAG, 9);
    expect(nav.max).toBe(nav.aft);
  });

  it('curves the rabbet toward both ends instead of cutting it straight', () => {
    for (const [z0, z1] of [
      [AFT_RISE_Z, -HALF_LENGTH],
      [FORE_RISE_Z, HALF_LENGTH],
    ]) {
      const y0 = floorYAt(z0);
      const y1 = floorYAt(z1);
      let worstSag = 0;
      for (let t = 0.1; t <= 0.9; t += 0.05) {
        const chord = y0 + (y1 - y0) * t;
        worstSag = Math.max(worstSag, chord - floorYAt(z0 + (z1 - z0) * t));
      }
      expect(worstSag).toBeGreaterThan(0.15);
    }
  });

  it('keeps carried masses tied to their actual supporting geometry', () => {
    const items = buildLightship();
    const windlass = items.find((item) => item.name === 'windlass and bitts');
    const cabinJoinery = items.find((item) => item.name === 'joinery, cabin');
    const rudder = items.filter((item) => item.name.startsWith('rudder@'));

    expect(windlass?.y).toBeCloseTo(walkingDeckY(5.6) + 0.3, 9);
    expect(cabinJoinery?.y).toBeCloseTo(CABIN_SOLE_Y + 0.65, 9);
    expect(rudder.length).toBeGreaterThan(0);
    expect(items.some((item) => item.name === 'tiller and rudder')).toBe(false);
  });

  it('does not smuggle in the rejected deck drop', () => {
    expect(CABIN_SOLE_Y - DESIGN_DRAUGHT).toBeCloseTo(0.15, 9);
  });
});
