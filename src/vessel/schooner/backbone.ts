import {
  AFT_RISE_Z,
  DESIGN_DRAUGHT,
  FORE_RISE_Z,
  HALF_LENGTH,
  KEEL_Y,
  STEM_FLOOR_Y,
  TRANSOM_FLOOR_Y,
  floorYAt,
} from './hullForm';
import { HullSection } from './hullSection';
import type { Offset } from './hullForm';

/**
 * The schooner's backbone: keel, forefoot, deadwood, sternpost — and the rudder that hangs
 * on it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The offsets table in `hullForm.ts` describes the **moulded** hull: the fair
 * surface the planking is bent around, which begins at the rabbet — `floorYAt`.
 * That is the correct meaning for a table of offsets and it is what the
 * displacement integral consumed for the whole of M0.
 *
 * But a ship is not only her moulded body. Below the rabbet runs a solid timber
 * backbone: a keel under the flat of the run, deadwood filling the rise aft, the
 * forefoot knee and stem forward, and the rudder abaft the sternpost. That
 * timber is under water at the design draught, and it displaces. M0 gave it mass
 * (`massModel.ts` carried it as three lumps) and no volume — a body that weighed
 * something and pushed back with nothing.
 *
 * The error is about 3.6% of displacement. Small, and it does not stay small:
 * volume at fixed draught is ballast, ballast is KG, and KG is GM and the roll
 * period. See `docs/ship/SHIP_SPEC.md` section 4.2.
 *
 * WHY IT IS GEOMETRY AND NOT A CORRECTION FACTOR
 * ---------------------------------------------
 * A scalar "appendage allowance" would have closed the displacement error in one
 * line. It would also have been a second description of the ship — and M1 is
 * about to *draw* this timber. A drawn keel and a fudge factor cannot be checked
 * against each other; a drawn keel and a profile function can only disagree if
 * someone edits one of them. So the backbone is a profile, and the same profile
 * yields the volume it displaces (here), the mass of oak in it
 * (`backboneMassItems`), and the shape M1 lofts.
 *
 * COORDINATES
 * -----------
 * As `hullForm.ts`: +x port, +y up from the moulded baseline at the top of
 * the keel, +z forward. The timber below the fair body consequently extends to
 * negative y. The backbone lies on the centreline, so its sections are simple
 * rectangles of the local siding.
 */

/**
 * Siding — the athwartships thickness of the keel and deadwood, metres.
 *
 * 0.35 m for a 15.5 m vessel framed for ocean work. It is not a free parameter:
 * it is set by the frames it has to take the heels of, and it is the same
 * dimension `massModel.ts` used for the keel baulk before this file existed.
 */
const BACKBONE_SIDING = 0.35;

/** Siding at the extremities, where stem and sternpost taper. */
const END_SIDING = 0.26;

/**
 * Aft end of the flat keel — the heel of the sternpost.
 *
 * The post rakes aft as it rises, from here to the sternpost head at the after
 * perpendicular, where it meets the underside of the counter at
 * `TRANSOM_FLOOR_Y`. 1.15 m of rake over 2.28 m of height is about 27°, which is
 * the rake a transom-sterned vessel of this type carries.
 */
const STERNPOST_HEEL_Z = -6.6;

/**
 * Forward end of the flat keel — the foot of the stem.
 *
 * Forward of this the forefoot sweeps up to the stem head. Note this is *aft* of
 * `FORE_RISE_Z`, where the moulded body starts to rise: the backbone is still a
 * flat keel under the first part of the rise, which is exactly the wedge of
 * timber a forefoot knee is.
 */
const STEM_FOOT_Z = 4.4;

/**
 * Shape of the stem's forward face between the keel and the stem head.
 *
 * Above 1 the foot stays low and the stem sweeps up late, giving the full
 * forefoot the spec's "broad, rounded working bow" wants (section 3). Below 1 it
 * cuts away into a yacht's hollow entry, which is the wrong vessel.
 *
 * This is the one backbone parameter M1 will want to touch, because it is the
 * stem profile anyone actually looks at. It is cheap to move: the whole forefoot
 * is about 0.5 m³, so a full unit of exponent is worth well under 0.2% of
 * displacement. Re-run `tests/ship-hydrostatics.test.ts` after moving it, but do
 * not expect to have to re-fair anything.
 */
const STEM_RAKE_EXPONENT = 1.25;

/** Mean thickness of the rudder blade, metres. */
const RUDDER_THICKNESS = 0.14;

/** Moulded keel depth below the rabbet, metres. */
export const KEEL_DEPTH = 0.38;

/** Additional keel depth at the sternpost heel, metres. */
export const KEEL_DRAG = 0.35;

/**
 * Underside of the straight keel over its flat run.
 *
 * The rabbet rises toward both ends, but the keel does not follow it: the wedge
 * between the two is the forefoot forward and deadwood aft. Drag runs from zero
 * at the stem foot to `KEEL_DRAG` at the sternpost heel, putting lateral area
 * aft without burying the forefoot.
 */
function keelBottomOverFlat(z: number): number {
  const t = clamp((STEM_FOOT_Z - z) / (STEM_FOOT_Z - STERNPOST_HEEL_Z), 0, 1);
  return KEEL_Y - KEEL_DEPTH - KEEL_DRAG * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Underside of the backbone at `z` — the bottom of the keel, and the outer faces
 * of stem and sternpost where they sweep up from it.
 *
 * The keel hangs below the moulded baseline: 0.38 m below the rabbet forward,
 * increasing by 0.35 m at the sternpost heel. At the ends the outer profile
 * sweeps upward from that keel line to the stem head and underside of the
 * counter.
 */
export function backboneBottomY(z: number): number {
  if (z > STEM_FOOT_Z) {
    const u = Math.min((z - STEM_FOOT_Z) / (HALF_LENGTH - STEM_FOOT_Z), 1);
    const foot = keelBottomOverFlat(STEM_FOOT_Z);
    return foot + (STEM_FLOOR_Y - foot) * Math.pow(u, STEM_RAKE_EXPONENT);
  }
  if (z < STERNPOST_HEEL_Z) {
    const u = Math.min((STERNPOST_HEEL_Z - z) / (HALF_LENGTH + STERNPOST_HEEL_Z), 1);
    const heel = keelBottomOverFlat(STERNPOST_HEEL_Z);
    return heel + (TRANSOM_FLOOR_Y - heel) * u;
  }
  return keelBottomOverFlat(z);
}

/** Actual loaded draught to the deepest timber, forward and aft. */
export function navigationalDraught(): { forward: number; aft: number; max: number } {
  const forward = DESIGN_DRAUGHT - backboneBottomY(STEM_FOOT_Z);
  const aft = DESIGN_DRAUGHT - backboneBottomY(STERNPOST_HEEL_Z);
  return { forward, aft, max: Math.max(forward, aft) };
}

/**
 * Top of the backbone at `z` — the rabbet, where the planking lands on it.
 *
 * This is `floorYAt` and must stay `floorYAt`: the backbone fills exactly the
 * space between its own underside and the bottom of the moulded body, so the two
 * volumes abut without gap or overlap by construction rather than by arithmetic.
 */
export function backboneTopY(z: number): number {
  return floorYAt(z);
}

/** Siding of the backbone at `z`, metres — tapering toward stem and sternpost. */
export function backboneSiding(z: number): number {
  if (z > STEM_FOOT_Z) {
    const u = (z - STEM_FOOT_Z) / (HALF_LENGTH - STEM_FOOT_Z);
    return BACKBONE_SIDING + (END_SIDING - BACKBONE_SIDING) * Math.min(u, 1);
  }
  if (z < STERNPOST_HEEL_Z) {
    const u = (STERNPOST_HEEL_Z - z) / (HALF_LENGTH + STERNPOST_HEEL_Z);
    return BACKBONE_SIDING + (END_SIDING - BACKBONE_SIDING) * Math.min(u, 1);
  }
  return BACKBONE_SIDING;
}

/** Cross-sectional area of the backbone timber at `z`, m². */
export function backboneAreaAt(z: number): number {
  const height = backboneTopY(z) - backboneBottomY(z);
  return height > 0 ? height * backboneSiding(z) : 0;
}

/**
 * Top of the rudder blade at `z` — the after face of the sternpost it hangs on.
 *
 * The blade fills the region between the raked post and the keel line produced
 * aft, which is where a rudder goes on a vessel with a post of this rake. It is
 * an idealisation: on the real thing the blade is abaft the post rather than
 * under it, and the two are only the same region because the post rakes. The
 * distinction is worth about a fifth of a cubic metre and it is not worth a
 * second coordinate system.
 */
export function rudderBottomY(): number {
  return backboneBottomY(STERNPOST_HEEL_Z);
}

export function rudderTopY(z: number): number {
  return z < STERNPOST_HEEL_Z ? backboneBottomY(z) : rudderBottomY();
}

/** Cross-sectional area of the rudder blade at `z`, m². */
export function rudderAreaAt(z: number): number {
  const height = rudderTopY(z) - rudderBottomY();
  return height > 0 ? height * RUDDER_THICKNESS : 0;
}

/** A rectangular slab on the centreline, as a section the clipper can immerse. */
function slab(bottomY: number, topY: number, width: number): HullSection | undefined {
  if (topY - bottomY < 1e-6 || width <= 0) return undefined;
  const half = width / 2;
  const offsets: Offset[] = [
    { y: bottomY, halfBreadth: half },
    { y: topY, halfBreadth: half },
  ];
  return new HullSection(offsets);
}

/**
 * The appendage sections at `z`: the backbone, and the rudder where there is one.
 *
 * Returned as separate sections rather than one merged polygon because they are
 * different widths and they stack vertically without touching — the rudder below
 * the sternpost's after face, the backbone above it.
 */
export function appendageSectionsAt(z: number): HullSection[] {
  const sections: HullSection[] = [];

  const rudder = slab(rudderBottomY(), rudderTopY(z), RUDDER_THICKNESS);
  if (rudder) sections.push(rudder);

  const backbone = slab(backboneBottomY(z), backboneTopY(z), backboneSiding(z));
  if (backbone) sections.push(backbone);

  return sections;
}

/** Which region of the backbone a station falls in, for reporting. */
export type BackbonePart = 'forefoot' | 'keel' | 'deadwood';

export function backbonePartAt(z: number): BackbonePart {
  if (z > FORE_RISE_Z) return 'forefoot';
  if (z < AFT_RISE_Z) return 'deadwood';
  return 'keel';
}
