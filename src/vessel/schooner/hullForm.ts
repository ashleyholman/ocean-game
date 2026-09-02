/**
 * The schooner's canonical hull form.
 *
 * `docs/ship/SHIP_SPEC.md` section 2 fixes the principal dimensions and section 4 fixes
 * the hydrostatics the shape must produce. This file is the shape: a faired
 * parametric hull that generates a conventional table of offsets — half-breadths
 * at a grid of stations and waterlines — which is how a hull of this period was
 * actually drawn, and which gives the displacement integral and the visible mesh
 * one common source.
 *
 * WHY PARAMETRIC AND NOT A HAND-TYPED TABLE
 * -----------------------------------------
 * A hand-typed table cannot be faired, cannot be re-solved when a constraint
 * moves, and cannot record *why* a number is what it is. The constraints here
 * genuinely interact: the captain's-cabin headroom (spec section 6) is a
 * consequence of the sheer line and the deck camber, and the displacement is a
 * consequence of the bilge fullness and the run. Changing one by hand and
 * re-typing 300 offsets is how a hull stops being fair.
 *
 * COORDINATES
 * -----------
 * Matching the shared `BuoyantBody` convention:
 *
 *   +x  port        +y  up, **zero at the moulded baseline**
 *   +z  forward (bow)      −x  starboard
 *
 * THE SIDE LABELS — amended 2026-08-05 (finding W1, `docs/sailing/SAILING_ROUND_HANDOVER.md`)
 * -----------------------------------------------------------------------------
 * This block used to read "+x starboard", and every side word in the vessel
 * sources followed it. That labelling was a mirror image of the world: the
 * render frame's compass (east = +x, north = −z, matching the astronomy, the
 * geodesy and every sea direction) is right-handed and physically correct, and
 * in it a +z-facing bow at model yaw zero points south — which puts +x on the
 * vessel's PORT side. Positive yaw swings the bow toward +x: a turn to port,
 * `heading = 180° − yaw` at zero frame offset. The 2026-08-05 relabel flipped
 * the words only; no geometry, physics value or drawn pixel changed, which the
 * regenerated evidence proves by differing only in renamed labels. Do not
 * "fix" a side word back by reasoning — check it against this block, and if it
 * matters, against the sun.
 *
 * The moulded baseline is the top of the keel amidships, not its bottom. The
 * fair body and its table of offsets remain in this coordinate system while the
 * keel, forefoot and deadwood in `backbone.ts` hang below it at negative y.
 * `DESIGN_DRAUGHT` is therefore the moulded draught; navigational draught to the
 * deepest timber is reported by `navigationalDraught()` in `backbone.ts`.
 *
 * `BuoyantBody` does not care where the local origin sits — it solves the
 * equilibrium waterline as a local `y` and places the body so that waterline
 * lands on the sea.
 *
 * Longitudinally the hull runs from the sternpost at z = −7.75 to the stem at
 * z = +7.75: 15.5 m, the spec's "stem to sternpost". The bowsprit is not hull
 * and is not represented here.
 */

/** Stem to sternpost, metres. `docs/ship/SHIP_SPEC.md` section 2. */
export const HULL_LENGTH = 15.5;
export const HALF_LENGTH = HULL_LENGTH / 2;

/** Maximum beam, metres. */
export const MAX_BEAM = 5.0;
const MAX_HALF_BEAM = MAX_BEAM / 2;

/** Design draught, metres — the loaded waterline the spec fixes. */
export const DESIGN_DRAUGHT = 2.3;

/**
 * Longitudinal position of maximum beam.
 *
 * Slightly forward of midships. A full-bodied merchant hull of this period
 * carries its beam forward and fines away aft — "cod's head and mackerel tail" —
 * which is what gives the bluff working bow the spec asks for in section 3 while
 * keeping a clean run under the transom.
 */
const MAX_BEAM_Z = 0.75;

/** Half-breadth at the transom, at the height of maximum beam. */
const TRANSOM_HALF_BEAM = 1.34;

/** The stem is a post, not a surface: the sections converge to its siding. */
const STEM_HALF_BEAM = 0.065;

/**
 * Height above baseline at which each section reaches its maximum breadth.
 *
 * Just above the design waterline, which is where a working hull of this form
 * carries it: the topsides above are slabbed and slightly tumbled home, the
 * bilge below is turned hard enough to give the initial stability a shallow
 * hull of 5 m beam needs.
 */
const MAX_BEAM_Y = 2.62;

/**
 * Bilge fullness exponent. 1 is a straight-sided V; larger is fuller, turning
 * the bilge harder and pushing volume down toward the keel.
 *
 * This is the principal displacement knob, and it is what was moved to land the
 * block coefficient in the band section 4 of the spec calls plausible for the
 * type. See `tests/ship-hydrostatics.test.ts`, which asserts the outcome rather
 * than the knob.
 */
const BILGE_FULLNESS = 4.2;

/** Fraction of maximum breadth lost at the deck edge to tumblehome. */
const TUMBLEHOME = 0.055;

/** How bluff the bow is. Larger holds the beam further forward. */
const BOW_BLUFF = 1.75;

/** How full the run is. Larger keeps volume aft toward the transom. */
const RUN_FULLNESS = 1.2;

// --- keel and the rise of floor --------------------------------------------

/** Height of the fair body above the baseline amidships — the keel rabbet. */
export const KEEL_Y = 0.16;

/** Forward of this the rabbet rises toward the stem. */
export const FORE_RISE_Z = 2.15;
/** Aft of this the rabbet sweeps up toward the transom. */
export const AFT_RISE_Z = -1.6;

/** Height of the fair body at the stem, above baseline. */
export const STEM_FLOOR_Y = 3.2;
/** Height of the fair body at the transom — the transom's lower edge. */
export const TRANSOM_FLOOR_Y = 2.28;

/**
 * Shape of the rabbet's rise to stem and transom. Above 1 the rise begins
 * gently and steepens toward the ends, producing a curved forefoot and run
 * rather than M1's diagonal cuts. The rise points move inboard to keep the fair
 * body's volume and coefficients in their established bands; the separate
 * straight keel in `backbone.ts` preserves the vessel's long working run.
 */
const END_RISE_EXPONENT = 1.7;

// --- sheer ------------------------------------------------------------------

/**
 * Deck at side, above baseline, at the sheer's low point. Freeboard amidships
 * is therefore 3.82 − 2.30 = 1.52 m: enough for the "practical but not
 * excessive" bulwark the spec asks for, without a wall of topside.
 */
const DECK_AT_SHEER_LOW = 3.82;
/** Where the sheer is lowest — aft of amidships, as drawn on vessels of the type. */
const SHEER_LOW_Z = -1.5;
/** Rise of the sheer line forward of its low point, at the stem. */
const SHEER_RISE_FORWARD = 0.66;
/** Rise of the sheer line aft of its low point, at the transom. */
const SHEER_RISE_AFT = 0.34;

/**
 * Camber of the deck: crown at the centreline above the deck at side, as a
 * fraction of the local beam. 1/50 is the traditional figure and it is not
 * decorative here — spec section 6 spends it on cabin headroom.
 */
export const DECK_CAMBER_RATIO = 1 / 50;

/**
 * Rise of the quarterdeck above the main deck. Spec section 6 fixes this at
 * 0.45–0.55 m: enough to stand under aft, short of the stern castle the spec
 * forbids in section 3.
 *
 * At the top of that band, and not by preference. At 0.50 the cabin's *forward*
 * end — where the sheer has not yet risen toward the transom — came out at
 * 1.802 m of clear height, short of the 1.85 the spec requires on the centreline
 * strip. The remaining 50 mm had to come from somewhere, and the quarterdeck is
 * the only term still inside its own tolerance.
 */
export const QUARTERDECK_RISE = 0.55;

/** Forward edge of the raised quarterdeck. */
export const QUARTERDECK_FORWARD_Z = -2.4;

/**
 * Rise of the forecastle above the main deck, and where it begins.
 *
 * Spec section 3 asks for "a subtly raised forecastle" and section 3 also forbids
 * anything that reads as a castle, so this is a step, not a deck: 0.22 m, enough
 * to break the sheer's monotony forward and give the windlass its own level.
 *
 * It plays no part in the cabin headroom solve — that binds aft, on
 * `QUARTERDECK_RISE` — so unlike the quarterdeck this figure is free.
 */
export const FORECASTLE_RISE = 0.22;
export const FORECASTLE_AFT_Z = 4.6;

/**
 * Height of the walking surface above the deck at side at `z`.
 *
 * The one place the three deck levels are decided. Both the mesh and the deck's
 * mass in `massModel.ts` read it, so a raised deck cannot be drawn without being
 * weighed.
 */
export function deckLevelRise(z: number): number {
  if (z <= QUARTERDECK_FORWARD_Z) return QUARTERDECK_RISE;
  if (z >= FORECASTLE_AFT_Z) return FORECASTLE_RISE;
  return 0;
}

/** Height of the walking surface above the baseline at `z`, at the side. */
export function walkingDeckY(z: number): number {
  return deckAtSideY(z) + deckLevelRise(z);
}

/**
 * Bulwark height above the deck, metres.
 *
 * 0.90 m on the working deck: waist-high on a standing figure, which is the
 * "practical but not excessive" of spec section 3 — real protection when she is
 * down to her rail, without the wall of topside the spec warns against.
 *
 * 0.80 m on the quarterdeck, because the quarterdeck is already 0.55 m up and a
 * full-height bulwark there would put the rail at eye level for whoever is on
 * the tiller. The 0.45 m step this leaves at the break is not an artefact — the
 * break of the quarterdeck is a feature of the type, and it is one of the things
 * that reads as period from a distance.
 */
export const BULWARK_MAIN_HEIGHT = 0.9;
export const BULWARK_QUARTERDECK_HEIGHT = 0.8;

/**
 * The bulwark and caprail, as dimensions of the **vessel** rather than of a mesh.
 *
 * These lived in `shipGeometry.ts`, which is the loft — so anything that was not
 * the loft had to guess at them, and `rig.ts` did: it placed every fitting on the
 * rail against `halfBreadthAt(z, deck) − 0.14`, a hardcoded stand-in for a wall
 * that is 0.09 m thick, tumbles home as it rises, and is capped by a rail 0.07 m
 * proud of `bulwarkTopY` and overhanging 0.028 m each side.
 *
 * The consequences were exactly what a wrong description of a real object gives
 * you: sheet fairleads buried inside the caprail's timber, ropes emerging from
 * the planking, and pin rails standing off the wall they are supposed to be
 * bolted to. Ash reported it four times in different words before the cause
 * turned out to be that two files disagreed about where the wall was.
 *
 * One description of one object — the same contract `hullForm.ts` already holds
 * with the flotation model. `shipGeometry.ts` imports these now; nothing
 * re-derives them.
 */
export const BULWARK_THICKNESS = 0.09;
/** How fast the bulwark keeps tumbling home above the deck edge, m per m. */
export const BULWARK_TUMBLE_RATE = -0.11;
/** Caprail: how far it overhangs each face, and how thick it is. */
export const CAPRAIL_OVERHANG = 0.028;
export const CAPRAIL_THICKNESS = 0.07;

/**
 * Outer half-breadth of the bulwark at height `y`.
 *
 * Floored at the siding of the stem. Without that the continued tumblehome
 * drives it *negative* over the last half-metre forward — the rail crosses the
 * centreline and the caprail's two faces swap sides, which renders as a twisted
 * ribbon at the stemhead.
 */
export function bulwarkOuterHalfBeam(z: number, y: number): number {
  const deck = deckAtSideY(z);
  const atDeck = halfBreadthAt(z, deck);
  return Math.max(atDeck + BULWARK_TUMBLE_RATE * Math.max(y - deck, 0), 0.03);
}

// --- the counter rake -------------------------------------------------------

/** Tangent of the transom's rake — 18° from vertical. */
export const COUNTER_RAKE_TAN = Math.tan((18 * Math.PI) / 180);
/** Forward limit of the shear. Forward of this the after body is untouched. */
export const COUNTER_SHEAR_START_Z = -6.2;

/**
 * How far aft a point at height `y` is carried by the transom's rake.
 *
 * Zero at and below the design waterline, always: the shear is keyed on height
 * rather than on length so that every vertex the water can reach at rest is the
 * hull form's own surface, and the drawn hull and the displacement integral can
 * never disagree. `shipGeometry.ts`'s header explains the consequence, and
 * `ship-geometry.test.ts` asserts it.
 *
 * THIS IS A FACT ABOUT THE COUNTER, NOT ABOUT THE LOFT
 * ---------------------------------------------------
 * It lived in `shipGeometry.ts`, which was fine while the shell was the only
 * thing sheared. It is not: the quarterdeck is carried aft by the same rake —
 * that overhang is where the taffrail is — so the walkable surface has to apply
 * it too. Two files applying their own copy of a shear is the shape of fault
 * that cost the rig round four reports, so it lives here with the rest of the
 * vessel's dimensions and both consumers import it.
 */
export function counterRakeShift(z: number, y: number): number {
  if (z >= COUNTER_SHEAR_START_Z || y <= DESIGN_DRAUGHT) return 0;
  const t = Math.min((COUNTER_SHEAR_START_Z - z) / (COUNTER_SHEAR_START_Z + HALF_LENGTH), 1);
  const ramp = t * t * (3 - 2 * t);
  return COUNTER_RAKE_TAN * (y - DESIGN_DRAUGHT) * ramp;
}

/**
 * The station a point ends up at, given where it actually is.
 *
 * The inverse of the counter's shear at a fixed height: everything else in this
 * file answers questions about a *station*, and anything that knows only where
 * it is in the world — a rope, a body, a query about whether the two are in the
 * same place — has to get from one to the other first. Abaft the shear, and
 * only above the waterline, they differ by up to 0.79 m.
 *
 * `NaN` when the placed z is abaft where even the sternpost's own timber
 * reaches at that height: there is no station there at all.
 *
 * Bisection rather than iteration, for the reason `deckSurface.ts` gives at
 * length: the shear's ramp is steep enough under the quarterdeck that the
 * obvious fixed point oscillates instead of converging.
 */
export function counterStationZ(zPlaced: number, y: number): number {
  if (zPlaced >= COUNTER_SHEAR_START_Z) return zPlaced;
  let lo = -HALF_LENGTH;
  let hi = COUNTER_SHEAR_START_Z;
  // A millimetre of tolerance at the aftmost station, for the reason
  // `deckSurface.deckParamZ` gives at its own boundary: the placed z of the
  // transom *is* this bound, so anything that stops at the transom lands
  // exactly on it, and a value that has been through a subtraction and back
  // does not survive that exactly. Without it the cabin's after edge is NaN
  // on some stations and a hull half-breadth on the next.
  const aftmost = lo - counterRakeShift(lo, y);
  if (zPlaced < aftmost) return zPlaced < aftmost - 1e-3 ? NaN : lo;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (mid - counterRakeShift(mid, y) < zPlaced) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** The rail's cross-section at `z`: where a fitting bolted to it actually goes. */
export interface RailSection {
  /** Outer face of the bulwark planking at the top of the wall. */
  outerX: number;
  /** Inboard face of the bulwark planking at the top of the wall. */
  innerX: number;
  /** Underside of the caprail — the top of the planking. */
  topY: number;
  /** The caprail's own upper surface, which is what things stand on. */
  capY: number;
  /** The caprail's edges, which overhang the planking on both sides. */
  capOuterX: number;
  capInnerX: number;
}

export function railSection(z: number): RailSection {
  const topY = bulwarkTopY(z);
  const outerX = bulwarkOuterHalfBeam(z, topY);
  const innerX = Math.max(outerX - BULWARK_THICKNESS, 0);
  return {
    outerX,
    innerX,
    topY,
    capY: topY + CAPRAIL_THICKNESS,
    capOuterX: outerX + CAPRAIL_OVERHANG,
    capInnerX: Math.max(innerX - CAPRAIL_OVERHANG, 0),
  };
}

/** Top of the bulwark — the underside of the caprail — above the baseline. */
export function bulwarkTopY(z: number): number {
  const height =
    z <= QUARTERDECK_FORWARD_Z ? BULWARK_QUARTERDECK_HEIGHT : BULWARK_MAIN_HEIGHT;
  return walkingDeckY(z) + height;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Maximum half-breadth of the section at `z`, ignoring height. */
export function maxHalfBeamAt(z: number): number {
  if (z >= MAX_BEAM_Z) {
    const u = clamp((z - MAX_BEAM_Z) / (HALF_LENGTH - MAX_BEAM_Z), 0, 1);
    return (
      STEM_HALF_BEAM +
      (MAX_HALF_BEAM - STEM_HALF_BEAM) * Math.sqrt(Math.max(1 - Math.pow(u, BOW_BLUFF), 0))
    );
  }
  const v = clamp((z + HALF_LENGTH) / (MAX_BEAM_Z + HALF_LENGTH), 0, 1);
  return (
    TRANSOM_HALF_BEAM +
    (MAX_HALF_BEAM - TRANSOM_HALF_BEAM) * (1 - Math.pow(1 - v, RUN_FULLNESS))
  );
}

/** Height above baseline where the fair body begins at `z` — the rise of floor. */
export function floorYAt(z: number): number {
  if (z >= FORE_RISE_Z) {
    const u = clamp((z - FORE_RISE_Z) / (HALF_LENGTH - FORE_RISE_Z), 0, 1);
    return KEEL_Y + (STEM_FLOOR_Y - KEEL_Y) * Math.pow(u, END_RISE_EXPONENT);
  }
  if (z <= AFT_RISE_Z) {
    const u = clamp((AFT_RISE_Z - z) / (HALF_LENGTH + AFT_RISE_Z), 0, 1);
    return KEEL_Y + (TRANSOM_FLOOR_Y - KEEL_Y) * Math.pow(u, END_RISE_EXPONENT);
  }
  return KEEL_Y;
}

/** Deck at side, above baseline, at `z`. The sheer line. */
export function deckAtSideY(z: number): number {
  const u = (z - SHEER_LOW_Z) / HALF_LENGTH;
  const rise = u >= 0 ? SHEER_RISE_FORWARD : SHEER_RISE_AFT;
  const span = u >= 0 ? (HALF_LENGTH - SHEER_LOW_Z) / HALF_LENGTH : (HALF_LENGTH + SHEER_LOW_Z) / HALF_LENGTH;
  const t = clamp(Math.abs(u) / span, 0, 1);
  return DECK_AT_SHEER_LOW + rise * t * t;
}

/** Deck at the centreline, above baseline, at `z` — deck at side plus camber. */
export function deckCrownY(z: number): number {
  return deckAtSideY(z) + maxHalfBeamAt(z) * 2 * DECK_CAMBER_RATIO;
}

/**
 * Half-breadth of the hull at longitudinal position `z` and height `y`.
 *
 * Zero below the rise of floor and above the deck at side. Between them the
 * section runs from the keel through a turned bilge to maximum breadth just
 * above the waterline, then tumbles home slightly to the deck edge.
 */
export function halfBreadthAt(z: number, y: number): number {
  if (Math.abs(z) > HALF_LENGTH) return 0;
  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  if (y <= floor || y > deck) return 0;

  const bMax = maxHalfBeamAt(z);
  if (y <= MAX_BEAM_Y) {
    const u = clamp((y - floor) / Math.max(MAX_BEAM_Y - floor, 1e-6), 0, 1);
    return bMax * (1 - Math.pow(1 - u, BILGE_FULLNESS));
  }
  const t = clamp((y - MAX_BEAM_Y) / Math.max(deck - MAX_BEAM_Y, 1e-6), 0, 1);
  return bMax * (1 - TUMBLEHOME * t * t);
}

/** One point on a station's offset curve. */
export interface Offset {
  /** Height above baseline, metres. */
  y: number;
  /** Half-breadth at that height, metres. */
  halfBreadth: number;
}

/**
 * Sample a station's offsets from the rise of floor to the deck at side.
 *
 * `steps` controls how finely the section curve is captured. The curve is
 * smooth and monotonic below the maximum breadth, so this converges quickly;
 * the default is generous rather than tuned, because the cost is paid once at
 * construction and never in the physics loop.
 */
export function stationOffsets(z: number, steps = 28): Offset[] {
  const floor = floorYAt(z);
  const deck = deckAtSideY(z);
  const offsets: Offset[] = [];
  if (deck <= floor) return offsets;

  for (let i = 0; i <= steps; i++) {
    const y = floor + ((deck - floor) * i) / steps;
    offsets.push({ y, halfBreadth: halfBreadthAt(z, y) });
  }
  return offsets;
}

/**
 * Station spacing for the flotation model, metres.
 *
 * Preserved from the proven station-resolution rule: `BuoyantBody`
 * settled on 0.40 m because at 0.64 m a 1.5 m wave fell below Nyquist and
 * aliased into a spurious low-frequency pitching moment worth about 40% of
 * measured peak pitch. That argument is about absolute spacing against the
 * sea's shortest components — `MIN_WAVELENGTH` is 3.5 m, and microChop can put
 * real geometry near 1.1 m — so it transfers to a longer hull as a spacing, not
 * as a station count.
 *
 * 39 stations over 15.5 m gives 0.397 m, retaining the proven sampling margin.
 */
export const STATION_COUNT = 39;
export const STATION_SPACING = HULL_LENGTH / STATION_COUNT;

/** Longitudinal position of station `i`, from the sternpost forward. */
export function stationZ(i: number): number {
  return -HALF_LENGTH + STATION_SPACING * (i + 0.5);
}

/**
 * The table of offsets, as a conventional grid: one row per station, one column
 * per waterline. This is the artefact the rest of the round reads — the mesh
 * lofts through it, the flotation integrates it.
 */
export interface OffsetTable {
  /** Longitudinal position of each station, metres. */
  stations: number[];
  /** Height above baseline of each waterline, metres. */
  waterlines: number[];
  /** `halfBreadths[station][waterline]`, metres. */
  halfBreadths: number[][];
}

/** Build the offsets table at a given waterline spacing. */
export function buildOffsetTable(waterlineSpacing = 0.25): OffsetTable {
  const stations: number[] = [];
  for (let i = 0; i < STATION_COUNT; i++) stations.push(stationZ(i));

  const topY = Math.max(...stations.map(deckAtSideY));
  const waterlines: number[] = [];
  for (let y = 0; y <= topY + 1e-9; y += waterlineSpacing) waterlines.push(y);

  const halfBreadths = stations.map((z) =>
    waterlines.map((y) => halfBreadthAt(z, y)),
  );

  return { stations, waterlines, halfBreadths };
}

// --- below decks -------------------------------------------------------------

/**
 * THE THREE FLOORS, AND WHY THERE ARE THREE
 * -----------------------------------------
 * `docs/ship/SHIP_BELOW_DECKS_PLAN.md` is the agreed arrangement and the argument
 * for it. In short: the round that produced it asked, for the first time, how
 * much of the hold the stores actually need — 30.1 m³ against 32.4 m³ under
 * y = 2.00 — and found 1.70 m of unused air over the cargo along the widest five
 * metres of the ship. A floor put into that air is a **platform deck**, which
 * would be wrong on a working schooner in trade and is the *defining* move of an
 * expedition conversion. `docs/ship/SHIP_SPEC.md` section 1 already says she was
 * bought into that service; HMS *Beagle* is the precedent the arrangement copies.
 *
 * The heights are here rather than in `deckInterior.ts` for the reason
 * `CABIN_SOLE_Y` always was: a floor is a fact about the hull, two files need
 * each one, and `deckInterior` already imports `deckSurface`, so an arrow the
 * other way would close a ring.
 */

/**
 * Height of the after sole — the captain's cabin and the landing — above the
 * baseline.
 *
 * Set by what is under it, not by what is wanted above it: ballast sits on the
 * floors at 0.62 and the bread room and lazarette stow above that to about 2.0,
 * so the sole cannot go lower without displacing the very weight that makes her
 * stand up. 2.45 clears the stores and puts the sole 0.15 m above the design
 * waterline, which is also what keeps the stern windows above the sea.
 */
export const CABIN_SOLE_Y = 2.45;

/**
 * The platform deck over the hold.
 *
 * 1.80 and not the free 2.00, and that was Ash's call against a measured cost.
 * At 2.00 the stores fit with 2.3 m³ to spare but the room is 1.73–1.86 m, which
 * is head-down at the sides. 1.80 gives 1.84–2.06 and takes 4.7 m³ of stowage,
 * paid for by cutting fresh water from 281 days of endurance to 150 — which
 * swaps casked water at ~640 kg/m³ effective for iron at 4200 down on the floors
 * and **drops KG by 38 mm**. She gets the room and gets stiffer. See
 * `massModel.ts`, where the water item and the ballast solve carry it.
 */
export const PLATFORM_SOLE_Y = 1.8;

/**
 * The forecastle's sole.
 *
 * Higher than the platform because the rise of floor is under it: at z = +6.2
 * the hull's own bottom is at 1.91, so a floor at 1.80 would be *inside the
 * timber* over the forward third of the room. 2.05 stands clear of it and leaves
 * the cable tier underneath, which is where `massModel.ts` already puts the
 * anchor cable.
 */
export const FORECASTLE_SOLE_Y = 2.05;

/**
 * Moulded depth of the deck beams overhead, and the part of it that is plank
 * rather than beam.
 *
 * The two together are what a room's clear height takes off the deck, so the
 * *beams* hang to exactly the height the headroom is measured at and the ceiling
 * between them is 0.13 m higher. The split used to live in `shipGeometry.ts`,
 * with a note that only the loft needed to know where the seam is — which was
 * true until a bulkhead had to reach it. A bulkhead fits *between* the beams and
 * lands on the planking; stopping it at the beam line leaves a 0.13 m slot along
 * the top of every wall below decks, which is a light leak the length of the
 * ship.
 */
export const DECK_BEAM_DEPTH = 0.18;
export const DECK_PLANK_THICKNESS = 0.05;

/**
 * Placed z of the transom at height `y` — where a floor laid at that height
 * runs out aft.
 *
 * The transom rakes, so "the after end of the ship" is a different number at
 * every height: 7.75 m at and below the waterline, 7.80 at the cabin sole, 8.55
 * at the taffrail. Anything that wants to stop *at the transom* has to ask at
 * its own height, and before this existed the only alternative was to stop short
 * of it and call the difference a lazarette.
 */
export function transomPlacedZ(y: number): number {
  return -HALF_LENGTH - counterRakeShift(-HALF_LENGTH, y);
}

/**
 * The inverse: the height at which the transom stands at placed `z`.
 *
 * Exact rather than solved, because the shear's ramp is saturated at the after
 * perpendicular — `t` reaches 1 exactly at `-HALF_LENGTH` — so the shift is
 * linear in height there and inverts in closed form. Everywhere else on the
 * counter the ramp is a smoothstep and `counterStationZ` has to bisect.
 */
export function transomHeightAt(zPlaced: number): number {
  return DESIGN_DRAUGHT + (-HALF_LENGTH - zPlaced) / COUNTER_RAKE_TAN;
}

/**
 * The bulkhead stations, aft to forward, in **placed** z.
 *
 * `CABIN_AFT_Z` is the transom itself. It was −6.6, which left 1.2 m of hull
 * abaft the room and made section 3's promised stern windows impossible — the
 * transom is where stern windows go, and the exterior was drawing three of them
 * into a space the cabin did not reach. The rudder stock comes up vertically at
 * z = −7.75 while the transom rakes aft 18°, so it stands inside the after end
 * and wants a boxed casing, with the windows in two pairs either side of it.
 */
export const CABIN_AFT_Z = transomPlacedZ(CABIN_SOLE_Y);

/**
 * The cabin's forward bulkhead.
 *
 * −4.3 and not further forward: the companion ladder and the clear sole a body
 * steps off it onto have to fit between here and the wardroom's bulkhead, and
 * they take 1.9 m. It was −3.4, with the companionway landing in the middle of
 * the captain's room — and section 9's first word about that room is "private".
 */
export const CABIN_FORWARD_Z = -4.3;

/**
 * The platform's after bulkhead, which is **the quarterdeck break**.
 *
 * Not a coincidence and not written twice: the break is where the deck overhead
 * steps up 0.55 m, so it is where the room under it changes character, and a
 * bulkhead anywhere else would leave a strip of wardroom with a much taller
 * ceiling than the rest. Derived, so that moving the break moves the bulkhead
 * rather than leaving the two 0.55 m apart in height and agreeing in z.
 */
export const PLATFORM_AFT_Z = QUARTERDECK_FORWARD_Z;

/**
 * The platform's forward bulkhead, and the forecastle's after one.
 *
 * Free — nothing structural falls here. +2.6 is where `massModel.ts` already
 * weighs the galley hearth, and a galley belongs against the forecastle's after
 * bulkhead, so the two agree by having been chosen for the same reason.
 */
export const PLATFORM_FORWARD_Z = 2.6;

/** The peak bulkhead: forward of it is the sail room and boatswain's store. */
export const FORECASTLE_FORWARD_Z = 6.2;

// --- the openings through the weather deck -----------------------------------

/**
 * A hole cut through the weather deck.
 *
 * The plans live *here*, with the rest of the vessel's fixed dimensions, and not
 * in any of the three files that need them. The deck has to know where the holes
 * in itself are; the interior has to know where its ladders and hatchways come
 * down; and `deckFittings.ts` has to know where to frame a coaming. If any of
 * them owned a number the other two would import it, and `deckInterior` already
 * imports `deckSurface` — a second edge on that arrow closes a ring.
 *
 * **The cargo hatch's plan moved here from `deckFittings.ts`, and that is what
 * made the platform's hatchway possible at all.** A full water cask is 400–500
 * kg and is lowered on a whip from a stay: it has to fall down one straight
 * vertical line from the sky to the stow, through the deck's opening and the
 * platform's at once. Hatchways on successive decks were aligned for exactly
 * this. With the footprint owned by the fitting, the only way to put an opening
 * under it was to type the same three numbers again — which is the fault this
 * ship has been bitten by in every round since the rig.
 */
export interface DeckOpening {
  readonly name: 'companionway' | 'cargoHatch' | 'foreScuttle';
  /** Aft and forward limits, placed z. */
  readonly zAft: number;
  readonly zForward: number;
  /**
   * Limits across the beam, port-positive.
   *
   * **This was `xCentre` and `halfBreadth`, and before that just `halfBreadth`
   * about the centreline.** Every opening on this ship used to be amidships,
   * and the loft, the cutout, the stencil and the walker each said
   * `Math.abs(x) <= halfBreadth` in their own words — four places quietly
   * agreeing about a fact none of them owned. Moving one hatch off the middle
   * found all four; letting its outboard side follow the planking found that a
   * *pair of numbers* was the next thing assuming too much.
   *
   * `xHi: 'side'` means the opening runs out to the ship's side and the
   * bulwark's inboard face is its outboard coaming. The limit is therefore a
   * function of station, so `openingXLimits` lives in `deckSurface.ts` — the
   * file that owns where the deck edge is — and not here.
   */
  readonly xLo: number;
  readonly xHi: number | 'side';
  /**
   * Gap left to the bulwark when `xHi` is `'side'`.
   *
   * The edge still follows the curved side; this optional inset is only for a
   * fitting which has a separate timber or reveal between its cut and the
   * bulwark. A side that uses the bulwark itself as its coaming must be zero.
   */
  readonly outboardClearance?: number;
  /**
   * Is something a body can stand on lying over it?
   *
   * The distinction is the whole of what a walker needs: a covered opening is
   * floor and the deck under it never comes up, while an uncovered one is a hole
   * to fall down and the deck has to be withdrawn as a candidate. The cargo
   * hatch carries a grating in its rebate; the companionway carries a ladder.
   */
  readonly covered: boolean;
}

/**
 * The companionway that the after accommodation is entered through.
 *
 * WHERE IT IS, AND WHAT SET THE BOUNDS
 * ------------------------------------
 * It was −5.40 to −3.70 and it came down in the middle of the captain's cabin.
 * It now lands in the pantry-and-ladder space forward of that room, with the
 * cabin door aft of the foot.
 *
 * **The length is 1.15 m and it is not a taste decision.** It was 1.70, which
 * put the flight at 54° — a domestic stair, as Ash named it, where a ship's
 * ladder is 60–70°. The 2.01 m drop and the walker's 0.32 m step-up force seven
 * risers regardless, so tread depth is the only free dimension: the landing a
 * body steps off into takes `COMPANION_LANDING_DEPTH` of the opening and the six
 * treads share what is left. 1.15 m gives back 0.55 m of quarterdeck.
 *
 * The tiller used to set the aft end: it sweeps the centreline to z = −5.82 at
 * any helm, and the old opening stopped 0.38 m short of that. Moving forward
 * leaves 1.67 m between the tip and the coaming, so that constraint is now
 * slack rather than binding — but it is still the reason the opening can never
 * go back aft.
 *
 * The rake does not reach here — `COUNTER_SHEAR_START_Z` is −6.2 — so placed and
 * parameter z are the same number across the whole opening and nothing in the
 * companionway has to invert anything.
 */
export const COMPANION_AFT_Z = -3.7;
export const COMPANION_FORWARD_Z = QUARTERDECK_FORWARD_Z;

/**
 * Centre of the opening across the beam — **to port, and no longer amidships**.
 *
 * WHY IT LEFT THE CENTRELINE, AND THE QUARTERDECK ALTOGETHER
 * ---------------------------------------------------------
 * Ash walked her and reported the movement rather than the geometry: to get
 * below you climbed a ladder from the waist onto the quarterdeck, walked to the
 * middle of it, and went straight back down through a hatch — up in order to go
 * down, with two ladders at the break doing one ladder's work.
 *
 * Heading the flight at the break instead spends the quarterdeck's own rise
 * before the descent starts. The drop was 2.012 m from the quarterdeck; from
 * the waist it is 1.44 m, which is exactly `QUARTERDECK_RISE` less, and that
 * pays for the whole complaint at once:
 *
 * - the flight relaxes from **71° to ~60°**, the middle of a ship's ladder's
 *   range rather than the top of it;
 * - it keeps the full `COMPANION_LANDING_DEPTH` at the foot, which is what made
 *   it walkable at all, and still lands a body facing the cabin door with 0.6 m
 *   to walk to it;
 * - the quarterdeck gets its middle back — 1.15 m of opening and a 0.50 m
 *   coaming out of the helm's floor;
 * - and the port ladder at the break becomes the way *down* instead of a second
 *   way up. See `DECK_STAIRS`, which now stands on one hand only.
 *
 * **Port, and the choice is Ash's**: the helm ladder stays to starboard. The
 * centreline was never available for either — the mainmast is 0.5 m forward of
 * the break and the main fife rail 0.12 m abaft it, which is the same fact that
 * put two ladders here in the first place.
 *
 * 1.05 spans 0.63 to 1.47. Inboard it clears the mast's own keep-out (0.44 m
 * for a 0.26 m body), outboard it stops 0.41 m short of the deck edge.
 */
export const COMPANION_INBOARD_X = 0.63;

/**
 * Gap between the opening's outboard side and the bulwark's inboard face.
 *
 * **There is no outboard coaming, and that is the point.** A straight coaming
 * at a fixed x stood against a deck edge running 1.879 at the break to 1.694
 * aft, so it left a wedge of deck 0.33 m tapering to 0.14 — never walkable
 * against a 0.52 m body, and visibly out of parallel with the ship's side.
 *
 * Zero because the bulwark itself is the outboard coaming. The former 0.02 m
 * "construction lining" left a real strip of deck between the cut and the
 * wall. Seen from the landing it was a black ledge directly under the bulwark,
 * exactly where one continuous side should have been; it also forced the wall
 * below to kick sideways through a short bevel to meet the rail. The fair wall
 * now stays inside the shell at its foot and terminates on the bulwark itself,
 * so no clearance strip is needed or wanted.
 */
export const COMPANION_OUTBOARD_CLEARANCE = 0;

/**
 * Half-width of the opening, metres.
 *
 * The body is a cylinder of 0.26 m radius, so 0.42 leaves 0.16 m of clearance
 * each side going down. A historically tight companionway would be 0.35, and at
 * that width a player who is not perfectly centred scrapes both coamings on the
 * way through, which reads as the ship being badly made rather than as the ship
 * being small.
 */
export const COMPANION_HALF_BREADTH = 0.42;

/**
 * The cargo hatch, amidships in the waist.
 *
 * The waist is the only part of her wide enough: 2.27 m of half-breadth at
 * z = 1, against 1.80 m on the quarterdeck and less forward. It is also the only
 * place a hatch belongs — cargo goes down where the hold is deepest and where a
 * stay tackle from either masthead can plumb it.
 */
export const CARGO_HATCH_Z = 1.4;
export const CARGO_HATCH_HALF_LENGTH = 0.9;
export const CARGO_HATCH_HALF_BREADTH = 0.75;

/**
 * The fore scuttle: the crew's own way on deck, offset to starboard.
 *
 * WHY IT IS NOT ON THE CENTRELINE
 * -------------------------------
 * Because the centreline forward is spoken for, three times over. The cargo
 * hatch's coaming ends at +2.39, the fore fife rail crosses at +3.48 and the
 * foremast stands at +4.10, which leaves 0.66 m of clear run against the 1.15 m
 * a companionway needs. `SHIP_BELOW_DECKS_PLAN.md` section 7 recorded that as
 * unbuildable and left the forecastle reached only through the wardroom — a
 * room with four berths in it and no way out of its own.
 *
 * Offset to one side is the period answer rather than a compromise: a scuttle
 * is not a companionway, and plenty of vessels of the type put theirs beside
 * the fife rail because that is where the deck was free.
 *
 * WHY STARBOARD, AND WHY HERE
 * ---------------------------
 * The patch bounded by the cargo hatch coaming aft, the pin rail outboard, the
 * fife rail inboard and the foremast forward is the largest unobstructed deck
 * on the ship forward of the mainmast: **1.46 m athwartships by 1.90 m fore
 * and aft**, with nothing standing in it. Ash marked it by eye with the ray
 * inspector before any of it was measured, which is the second time this round
 * that the ship chose the position and the file only wrote it down.
 *
 * Starboard because the doorway from the wardroom is at `DOORWAY_OFFSET` to
 * port: the two ways into the forecastle end up one each side of its after
 * bulkhead instead of fighting for the same corner.
 *
 * WHY IT IS 0.25 m OFF THE SHIP'S SIDE
 * ------------------------------------
 * Ash's sketch put it hard in the corner. It cannot go there, and the reason is
 * structural rather than a clearance: the deck beams land on the shelf where
 * the deck meets the side, and a hatch cut into the corner is a hatch cut
 * through the beam *ends*. A real scuttle sits between two beams with a carling
 * each side, which is what `buildSpaceDeckhead` already draws for an opening
 * and why the outboard coaming stops short of the planking.
 *
 * WHAT IT COSTS
 * -------------
 * The starboard gangway, at this station, whenever the lid is up. 0.75 m of
 * opening in a 1.46 m strip cannot leave a walkable margin either side, and no
 * arrangement of the two exists — the alternative was a smaller scuttle, which
 * buys 0.1 m of dead deck and loses a hatch a body fits through. Shut, the
 * coaming is a 0.20 m step-over, the same height as the forecastle break the
 * walker already handles. Open, you go round to port. `ship-deck.test.ts`
 * measures both.
 */
export const FORE_SCUTTLE_Z = 3.0;
/**
 * How far off the centreline, to starboard.
 *
 * **It was −1.30, which is where Ash pointed, and it moved 0.20 m inboard for a
 * collision reason rather than a placement one.** The scuttle's lid is a raised
 * standable surface, and the walker's step-over test is measured from a body's
 * feet: standing on the lid, the headsail pin rail on the bulwark came under
 * that threshold, so the walker used the hatch as a mounting block and strode
 * over the ship's own rail. At −1.10 the lid's outboard edge stands 0.37 m from
 * the rail's axis against the 0.305 m a body needs to touch it, so no part of
 * the lid is within reach of the rail at all. `ship-deck.test.ts`'s walk sweep
 * is the guard; see `deckFittings.ts` for the full account.
 *
 * The route forward on this hand survives — it runs *inboard* of the scuttle,
 * where 0.66 m of deck is clear all the way past, because the fore fife rail
 * turns out to be forward of the hatch rather than beside it.
 */
export const FORE_SCUTTLE_X = -1.1;
/** Clear opening, square: a scuttle is a hole you drop through, not a stair. */
export const FORE_SCUTTLE_HALF_BREADTH = 0.375;

export const DECK_OPENINGS: readonly DeckOpening[] = [
  {
    name: 'companionway',
    zAft: COMPANION_AFT_Z,
    zForward: COMPANION_FORWARD_Z,
    xLo: COMPANION_INBOARD_X,
    xHi: 'side',
    outboardClearance: COMPANION_OUTBOARD_CLEARANCE,
    covered: false,
  },
  {
    name: 'cargoHatch',
    zAft: CARGO_HATCH_Z - CARGO_HATCH_HALF_LENGTH,
    zForward: CARGO_HATCH_Z + CARGO_HATCH_HALF_LENGTH,
    xLo: -CARGO_HATCH_HALF_BREADTH,
    xHi: CARGO_HATCH_HALF_BREADTH,
    covered: true,
  },
  {
    name: 'foreScuttle',
    zAft: FORE_SCUTTLE_Z - FORE_SCUTTLE_HALF_BREADTH,
    zForward: FORE_SCUTTLE_Z + FORE_SCUTTLE_HALF_BREADTH,
    xLo: FORE_SCUTTLE_X - FORE_SCUTTLE_HALF_BREADTH,
    xHi: FORE_SCUTTLE_X + FORE_SCUTTLE_HALF_BREADTH,
    // **Not `covered`, even though a lid lies on it most of the time.** The
    // flag answers whether something a body can stand on is lying over the
    // opening *permanently* — the cargo hatch's grating sits in its rebate and
    // never moves. A lid that opens is the walker's business and is asked of
    // `closures.ts` at the moment of the question, because a hatch you can see
    // shut and fall through is the one failure mode this has to not have.
    covered: false,
  },
];

/** The fore scuttle, by name. Throws rather than returning the wrong hatch. */
export function foreScuttleOpening(): DeckOpening {
  const found = DECK_OPENINGS.find((opening) => opening.name === 'foreScuttle');
  if (!found) throw new Error('no foreScuttle in DECK_OPENINGS');
  return found;
}

/** The companionway, by name. Throws rather than returning the wrong hatch. */
export function companionOpening(): DeckOpening {
  const found = DECK_OPENINGS.find((opening) => opening.name === 'companionway');
  if (!found) throw new Error('no companionway in DECK_OPENINGS');
  return found;
}

/**
 * The cabin's headroom and its sole area used to be computed here, and both were
 * wrong in the same way. They now live in `deckInterior.ts`.
 *
 * `cabinHeadroomAt` built the deck's camber out of `deckCrownY`, which spans
 * `maxHalfBeamAt` — the hull's widest half-breadth at a station, down at the
 * turn of the bilge. The deck is not lofted over that. `deckSurface.ts` lofts it
 * over `deckHalfWidth`, the inboard face of the bulwark up at the walking
 * surface, and at the cabin those are 1.95 m and 1.69 m of half-beam. So the
 * headroom this file reported ran 9–16 mm above the height a head actually
 * meets, and the sole area integrated a half-breadth 0.13–0.26 m wider than the
 * room can be, because the topsides tumble home above the maximum beam at 2.62
 * and the deck overhead is narrower than the hull at the sole.
 *
 * Neither was a slip in the arithmetic. **Both were the wrong module.** A
 * question about the room under the quarterdeck has to be asked of the
 * quarterdeck as it is drawn, and this file cannot import the file that draws it
 * — `deckSurface.ts` imports *this* one. Written here, the only way to answer at
 * all was to build a second expression for the same surface, and a second
 * expression for one surface is the fault this ship has been bitten by in every
 * round since the rig. Moving them across the dependency made the right answer
 * the available one.
 *
 * The constants above stay: where the cabin *is* is a fact about the hull.
 */
