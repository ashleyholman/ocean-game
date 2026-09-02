import * as THREE from 'three';
import { DECK_FITTINGS, foreScuttleLid } from './deckFittings';
import type { FittingMaterial, FittingSolid } from './deckFittings';
import { SurfaceBuilder, addBox, addTube, jitter, makeRandom, rgbOf } from './shipwright';
import type { Rgb } from './shipwright';

/**
 * The deck furniture's triangles, lofted from the list in `deckFittings.ts`.
 *
 * Same division as the hull and the rig: that file decides where everything is
 * and what it is made of, this one turns it into geometry. Nothing here invents
 * a position, so moving the windlass a hand's breadth aft moves its bitts, its
 * whelps and its collider together.
 *
 * WHY THE FITTINGS HAVE THEIR OWN REGIONS
 * ---------------------------------------
 * The obvious economy is to draw them into the hull's `deck` region — one fewer
 * material, one fewer draw call — and it would be wrong twice over. The deck is
 * *scrubbed*: it is walked on, holystoned and salt-bleached, and its palette
 * entry says so at 0x8d7a5c with the heaviest jitter on the ship. A hatch
 * coaming is oiled oak that nobody scrubs, and the two are visibly different
 * timbers on any real vessel. Second, `Schooner.applyPalette` retints every
 * `ship:` mesh from a hull palette, and the palettes in `shipPalettes.ts` have
 * no entry for a bitt — the fittings would have been repainted to whatever the
 * planking became, or blanked to white.
 *
 * Two regions, not four: oak and wrought iron are what a working deck is made
 * of, and the rig's own regions are the precedent — `spar`, `rope`, `ironwork`,
 * `sailcloth` are materials rather than bands of height.
 *
 * WINDING
 * -------
 * `addTube` and `addBox` both pass `flip = true` internally, for the reason
 * `rigGeometry.ts` sets out at length: their grids run along the thing in rows
 * and around it in columns, which is the opposite of what `addGrid`'s winding
 * wants. Every primitive on this deck comes out of those two, so there is no
 * winding decision to make here.
 */

/**
 * The materials that appear on the weather deck — a strict subset of
 * `FittingMaterial`, and named as one so the compiler keeps them in step.
 *
 * The union widened for the captain's cabin (baize, brass, paper), and none of
 * the three has any business on a deck that is rained on. Writing this as
 * `= FittingMaterial` would have forced two dead palette rows and two dead
 * finishes on every table below; writing it as a fresh union of two strings
 * would have let the deck keep drawing a material the union no longer had.
 * `Extract` is the one spelling that is both narrow and derived.
 */
export type FittingRegion = Extract<FittingMaterial, 'timber' | 'ironwork'>;

export const FITTING_REGIONS: readonly FittingRegion[] = ['timber', 'ironwork'];

/** Deterministic, for the same reason the hull's timber is — `docs/project/ASSET_CREDITS.md`. */
const FITTING_SEED = 0x0dec4177;

export const FITTING_PALETTE: Record<FittingRegion, number> = {
  /**
   * Oiled oak. Deliberately darker and redder than the deck it stands on
   * (0x8d7a5c): deck planking is scrubbed pale and fittings are not, and that
   * difference is most of what makes a hatch read as an object on the deck
   * rather than as a pattern in it.
   */
  timber: 0x6a5232,
  /** The rig's own iron, because it is the same iron. */
  ironwork: 0x33353a,
};

const JITTER: Record<FittingRegion, number> = {
  // Plank to plank on a coaming, batten to batten on a grating. Generous,
  // because a grating of forty identical battens is the flattest thing aboard.
  timber: 0.08,
  ironwork: 0.05,
};

export interface FittingGeometrySet {
  geometries: Map<FittingRegion, THREE.BufferGeometry>;
  triangleCount: number;
}

class FittingBuilders {
  private readonly builders = new Map<FittingRegion, SurfaceBuilder>();

  get(region: FittingRegion): SurfaceBuilder {
    let b = this.builders.get(region);
    if (!b) {
      b = new SurfaceBuilder();
      this.builders.set(region, b);
    }
    return b;
  }

  finish(): FittingGeometrySet {
    const geometries = new Map<FittingRegion, THREE.BufferGeometry>();
    let triangleCount = 0;
    for (const region of FITTING_REGIONS) {
      const b = this.builders.get(region);
      if (!b || b.isEmpty) continue;
      geometries.set(region, b.toGeometry());
      triangleCount += b.triangleCount;
    }
    return { geometries, triangleCount };
  }
}

/**
 * Circumferential resolution of a round fitting.
 *
 * Eight. These are hand-worked timber and hammered iron a metre from the eye,
 * not turned cylinders: a pump tube or a windlass barrel drawn with eight facets
 * reads as an octagonal baulk, which is what it would actually be. The rig uses
 * ten for its spars because a mast is seen against the sky where a silhouette's
 * facets show.
 */
const FITTING_SIDES = 8;

/**
 * The material of a solid, if this deck draws that material — and a throw if it
 * does not.
 *
 * **The failure this guards against is silence.** `FittingMaterial` widened for
 * the captain's cabin and the deck's region list did not, so a deck fitting
 * authored in brass would ask `FittingBuilders` for a builder it has no palette
 * row for. Without this, the honest-looking outcomes are all bad: an
 * `undefined` colour paints black, and a builder that quietly does nothing
 * makes the piece *vanish* — geometry that is missing rather than wrong, which
 * is the hardest kind to notice and the hardest to search for.
 *
 * A throw at build time names the fitting's material and the list it is missing
 * from, at the one moment somebody can act on it.
 */
function deckRegionOf(material: FittingSolid['material']): FittingRegion {
  if (material === 'timber' || material === 'ironwork') return material;
  throw new Error(
    `a deck fitting is made of ${material}, which the weather deck does not draw: ` +
      `FITTING_REGIONS is [${FITTING_REGIONS.join(', ')}]. Either the piece belongs ` +
      'below decks, or this deck needs a palette row and a finish for it.',
  );
}

function addSolid(out: FittingBuilders, solid: FittingSolid, colour: Rgb): void {
  const builder = out.get(deckRegionOf(solid.material));
  if (solid.kind === 'box') {
    addBox(builder, solid.centre, solid.half, colour, solid.yaw);
  } else {
    addTube(builder, solid.a, solid.b, solid.radiusA, solid.radiusB, FITTING_SIDES, 1, colour);
  }
}

export function buildDeckFittingGeometry(): FittingGeometrySet {
  const out = new FittingBuilders();
  const random = makeRandom(FITTING_SEED);
  const base: Record<FittingRegion, Rgb> = {
    timber: rgbOf(FITTING_PALETTE.timber),
    ironwork: rgbOf(FITTING_PALETTE.ironwork),
  };

  for (const fitting of DECK_FITTINGS) {
    for (const solid of fitting.solids) {
      const region = deckRegionOf(solid.material);
      addSolid(out, solid, jitter(base[region], random, JITTER[region]));
    }
  }

  return out.finish();
}

/**
 * The fore scuttle's lid, in one state, as its own geometry.
 *
 * **Two geometries, one visible at a time**, exactly as the hatchway's boards
 * are built and for the same reason set out in `buildHatchwayBoardGeometry`.
 * It is drawn here and not with the interior fittings because a scuttle lid
 * stands *on the weather deck*: put in an interior region it would take
 * `INTERIOR_SKY_VISIBILITY`, be culled with the rooms, and mark the interior
 * stencil — so the sea would draw over a lid lying in open daylight.
 *
 * Its own seed, so adding the lid does not renumber the jitter of every fitting
 * built after it and silently repaint the whole deck.
 */
export function buildForeScuttleLidGeometry(open: boolean): FittingGeometrySet {
  const out = new FittingBuilders();
  const random = makeRandom(FITTING_SEED ^ 0x5c07713);
  const base: Record<FittingRegion, Rgb> = {
    timber: rgbOf(FITTING_PALETTE.timber),
    ironwork: rgbOf(FITTING_PALETTE.ironwork),
  };
  for (const solid of foreScuttleLid(open).solids) {
    const region = deckRegionOf(solid.material);
    addSolid(out, solid, jitter(base[region], random, JITTER[region]));
  }
  return out.finish();
}
