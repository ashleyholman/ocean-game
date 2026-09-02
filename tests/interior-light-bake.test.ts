import { describe, expect, it } from 'vitest';
import {
  CHANNEL_BOARDS,
  CHANNEL_COMPANION,
  CHANNEL_HATCH,
  CHANNEL_WINDOWS,
} from '../src/vessel/schooner/interiorLight';
import {
  bakedChannelMeans,
  bakeEnclosedPortalLight,
  bakeFittingPortalLight,
  bakeSparPortalLight,
  hasPortalLightAttributes,
  PORTAL_BOUNCE_ATTRIBUTE,
  PORTAL_DIRECT_ATTRIBUTE,
  SKY_VISIBILITY_ATTRIBUTE,
} from '../src/vessel/schooner/interiorLightBake';
import {
  INTERIOR_REGIONS,
  buildShipGeometry,
} from '../src/vessel/schooner/shipGeometry';
import {
  buildHatchwayBoardGeometry,
  buildInteriorFittingGeometry,
} from '../src/vessel/schooner/interiorFittingGeometry';
import { buildDeckFittingGeometry } from '../src/vessel/schooner/deckFittingGeometry';
import {
  buildLiveRigGeometry,
  buildStaticRigGeometry,
} from '../src/vessel/schooner/rigGeometry';
import { deckOverheadAt } from '../src/vessel/schooner/deckSurface';
import { MAINMAST_Z } from '../src/vessel/schooner/rig';

/**
 * The bake over the real ship: every geometry a portal-lit material draws
 * must carry the attributes, and what is in them must say what the room
 * arrangement says.
 *
 * These tests build the actual production geometry, so they are also the
 * budget guard: the bake runs at startup, and a form-factor quadrature that
 * quietly went quadratic would land on every load. The wall-clock assertion
 * is generous on purpose — it exists to catch order-of-magnitude regressions,
 * not scheduler noise.
 */

describe('the interior bake over the built ship', () => {
  const built = buildShipGeometry();
  const started = performance.now();
  const baked = new Map(
    INTERIOR_REGIONS.map((region) => {
      const geometry = built.geometries.get(region)!;
      bakeEnclosedPortalLight(geometry);
      return [region, geometry] as const;
    }),
  );
  const bakeSeconds = (performance.now() - started) / 1000;

  it('writes all three attributes on every interior region', () => {
    for (const [, geometry] of baked) {
      expect(hasPortalLightAttributes(geometry)).toBe(true);
      const direct = geometry.getAttribute(PORTAL_DIRECT_ATTRIBUTE);
      const position = geometry.getAttribute('position');
      expect(direct.count).toBe(position.count);
      expect(direct.itemSize).toBe(4);
      expect(geometry.getAttribute(PORTAL_BOUNCE_ATTRIBUTE).itemSize).toBe(4);
      expect(geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE).itemSize).toBe(1);
    }
  });

  it('gives an enclosed surface no open sky at all', () => {
    for (const [, geometry] of baked) {
      expect(bakedChannelMeans(geometry).skyVisibility).toBe(0);
    }
  });

  it('lights the rooms from the openings the arrangement gives them', () => {
    // The lining (walls, deckheads, bulkheads) sees every family of opening
    // somewhere along the ship; the channels must all be live somewhere.
    const lining = bakedChannelMeans(baked.get('interiorLining')!);
    expect(lining.direct[CHANNEL_COMPANION]).toBeGreaterThan(0);
    expect(lining.direct[CHANNEL_HATCH]).toBeGreaterThan(0);
    expect(lining.direct[CHANNEL_WINDOWS]).toBeGreaterThan(0);
    // Bounce reaches everything that is in a room at all.
    expect(lining.bounce[CHANNEL_COMPANION]).toBeGreaterThan(0);

    const sole = bakedChannelMeans(baked.get('interiorSole')!);
    expect(sole.direct[CHANNEL_COMPANION]).toBeGreaterThan(0);
    expect(sole.direct[CHANNEL_WINDOWS]).toBeGreaterThan(0);
  });

  it('stays inside the startup budget', () => {
    // Measured ~10⁵ vertices against ~13 rectangles. If this trips, the
    // quadrature got deeper or the vertex count exploded — find out which
    // before loosening the bound.
    expect(bakeSeconds).toBeLessThan(10);
  });
});

describe('the interior bake over the fittings and boards', () => {
  it('covers the pump, the stow and both board states', () => {
    const fittings = buildInteriorFittingGeometry();
    for (const [, geometry] of fittings.geometries) {
      bakeEnclosedPortalLight(geometry);
      expect(hasPortalLightAttributes(geometry)).toBe(true);
    }
    // The hold's stow is in the timber region and lives on the boards channel.
    const timber = fittings.geometries.get('timber');
    expect(timber).toBeDefined();
    const means = bakedChannelMeans(timber!);
    expect(means.direct[CHANNEL_BOARDS]).toBeGreaterThan(0);

    for (const open of [false, true]) {
      const set = buildHatchwayBoardGeometry(open);
      for (const [, geometry] of set.geometries) {
        bakeEnclosedPortalLight(geometry);
        expect(hasPortalLightAttributes(geometry)).toBe(true);
      }
    }
  });
});

describe('the deck-fitting bake', () => {
  // §15.5 item 5: fittings reach below the planking (the partners, the
  // grating, the bitts' feet) and used to render there with the full-sky
  // exterior constant — daylight leaking through the deckhead.
  const fittings = buildDeckFittingGeometry();
  for (const [, geometry] of fittings.geometries) {
    bakeFittingPortalLight(geometry);
  }

  it('writes the attributes on every fitting region', () => {
    for (const [, geometry] of fittings.geometries) {
      expect(hasPortalLightAttributes(geometry)).toBe(true);
    }
  });

  it('encloses everything under a deck and nothing standing on one', () => {
    let below = 0;
    let above = 0;
    for (const [, geometry] of fittings.geometries) {
      const position = geometry.getAttribute('position');
      const sky = geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
      for (let i = 0; i < position.count; i++) {
        const deck = deckOverheadAt(position.getX(i), position.getZ(i));
        if (!deck) continue;
        const y = position.getY(i);
        if (y < deck.y - 0.02) {
          below++;
          expect(sky.getX(i)).toBe(0);
        } else {
          above++;
          expect(sky.getX(i)).toBe(1);
        }
      }
    }
    // The leak needed both populations to exist: undersides below the
    // planking (the glowing "planks in the ceiling") and feet on it.
    expect(below).toBeGreaterThan(10);
    expect(above).toBeGreaterThan(100);
  });
});

describe('the spar bake', () => {
  // The lower masts build in the STATIC rig half now — they never move, and
  // forty rows of enclosure-lofted tube should not rebuild per frame. The
  // live half (booms, gaffs, yards) is baked identically and is all above
  // deck; both draw with the one portal-lit spar material.
  const spar = buildStaticRigGeometry().geometries.get('spar')!;
  bakeSparPortalLight(spar);
  const liveSpar = buildLiveRigGeometry().geometries.get('spar');
  if (liveSpar) bakeSparPortalLight(liveSpar);

  it('keeps the rig above deck in full sky', () => {
    const position = spar.getAttribute('position');
    const sky = spar.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
    let above = 0;
    let aboveFull = 0;
    for (let i = 0; i < position.count; i++) {
      const deck = deckOverheadAt(position.getX(i), position.getZ(i));
      const y = position.getY(i);
      if (!deck || y > deck.y + 0.35) {
        above++;
        if (sky.getX(i) === 1) aboveFull++;
      }
    }
    expect(above).toBeGreaterThan(100);
    expect(aboveFull).toBe(above);
  });

  it('bakes exactly zero sky on the interior side of the partners', () => {
    // §15.5 item 4: the old ramp began 5 cm BELOW the planking, and with
    // rows every 0.3 m the interpolation band glowed inside the room — "the
    // tip of the mast is lit" at the forecastle deckhead. The invariant now
    // is hard: any spar vertex at or below planking + 0.05 carries no sky.
    for (const geometry of [spar, liveSpar].filter(
      (g): g is NonNullable<typeof g> => g !== undefined,
    )) {
      const position = geometry.getAttribute('position');
      const sky = geometry.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
      let below = 0;
      for (let i = 0; i < position.count; i++) {
        const deck = deckOverheadAt(position.getX(i), position.getZ(i));
        if (!deck || position.getY(i) > deck.y + 0.05) continue;
        below++;
        expect(sky.getX(i)).toBe(0);
      }
      if (geometry === spar) expect(below).toBeGreaterThan(10);
    }
  });

  it('encloses the mainmast where it passes through the wardroom', () => {
    // §14.14's glowing mast: below the deck the tube must lose the sky and
    // take the wardroom's channels instead.
    const position = spar.getAttribute('position');
    const sky = spar.getAttribute(SKY_VISIBILITY_ATTRIBUTE);
    const direct = spar.getAttribute(PORTAL_DIRECT_ATTRIBUTE);
    const bounce = spar.getAttribute(PORTAL_BOUNCE_ATTRIBUTE);
    let enclosed = 0;
    let lit = 0;
    let sawHatchDirect = 0;
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i);
      const y = position.getY(i);
      if (Math.abs(z - MAINMAST_Z) > 0.6) continue;
      if (y < 2.0 || y > 3.4) continue; // inside the wardroom's band
      enclosed++;
      expect(sky.getX(i)).toBeLessThan(0.05);
      let total = 0;
      for (let p = 0; p < 4; p++) {
        total += direct.getComponent(i, p) + bounce.getComponent(i, p);
      }
      // The wardroom is honestly dim — one grating-covered hatch feeding
      // ~60 m² of surface — so the bar is "carries the room's light", not a
      // brightness opinion. Zero would mean the tube missed the bake.
      if (total > 1e-4) lit++;
      if (direct.getComponent(i, CHANNEL_HATCH) > 0.005) sawHatchDirect++;
    }
    expect(enclosed).toBeGreaterThan(10);
    // Every enclosed tube vertex takes the room's light...
    expect(lit).toBe(enclosed);
    // ...and the side of the tube facing the hatchway sees it directly.
    expect(sawHatchDirect).toBeGreaterThan(enclosed * 0.2);
  });
});
