import {
  DESIGN_DRAUGHT,
  HALF_LENGTH,
  deckAtSideY,
  railSection,
  deckCrownY,
  floorYAt,
  halfBreadthAt,
  walkingDeckY,
} from './hullForm';
import { DECK_STAIRS, deckLevelAt, deckStandAt, levelWalkingY } from './deckSurface';
import type { DeckLevel } from './deckSurface';

/**
 * The schooner's rig, as a graph.
 *
 * `docs/ship/SHIP_SPEC.md` section 7.3 makes this a contract rather than a style note:
 * *"the rigging is a topology graph of real attachment points, not a pile of
 * cylinders that happen to look like rope"*. So this file is the graph — named
 * points in ship-local space, spars that run between them, and standing rigging
 * that connects them. It knows nothing about meshes; `rigGeometry.ts` lofts it,
 * exactly as `shipGeometry.ts` lofts `hullForm.ts`.
 *
 * WHY THE GRAPH AND NOT DIRECT GEOMETRY
 * -------------------------------------
 * Two things need it. The sails round replaces each sail *surface* with a
 * deformable one bent to the same named points, so nothing else has to move.
 * And a rope whose ends are named cannot drift off the fitting it belongs to
 * when a spar is retuned — the same property `hullForm.ts` gives the hull.
 *
 * COORDINATES
 * -----------
 * Ship-local, shared with the hull: +z forward (stem at +7.75), +x to port,
 * +y up from the moulded baseline. The design waterline is y = 2.30.
 *
 * HOW THIS SAIL PLAN WAS ARRIVED AT
 * ---------------------------------
 * The first version had the right parts in the wrong places, and an
 * orthographic flat drawing (`src/debug/rigLayoutSheet.ts`) is what made that
 * legible — under real light and perspective the faults read as shading. Held
 * against reference plans it had four that mattered:
 *
 * 1. **The three headsails read as one.** Their heads were at 13.15, 14.60 and
 *    20.40 — two almost together and then a 5.8 m jump — so the flying jib was
 *    an enormous triangle with the other two nested inside it, 77% overlapped.
 *    Real practice steps the heads evenly and keeps the areas comparable; the
 *    flying jib is the *smallest* headsail, not the largest.
 * 2. **The square topsail was set below the gaff foresail's peak**, so 37 m² of
 *    square sail occupied the same band as 37 m² of gaff sail and the gaff cut
 *    straight through the cloth. The topsail belongs entirely on the topmast,
 *    above the gaff peak, with daylight between them.
 * 3. **Two headsail clews landed abaft the foremast**, so their cloth passed
 *    through the mast and through the foresail.
 * 4. **The masts were dead vertical.** Nothing says schooner faster than rake.
 *
 * The trim staircase below is the fix for the last of the intersections: with
 * every sail sheeted to the same angle they are all coplanar, and coplanar
 * sails on one mast necessarily interpenetrate. Sheeting them progressively —
 * the aftmost hardest — is both correct trim and what pulls them apart in 3D.
 */

// --- masts: where they stand and how far they lean ---------------------------

/**
 * Longitudinal positions of the two mast partners — where each mast passes
 * through the deck.
 *
 * Fixed by `massModel.ts`, which has weighed spars at these stations since M0.
 * Moving one is a hydrostatics change, not a modelling preference. Note that
 * these are the *partners*, not the steps: a raked mast's heel is not under its
 * deck hole.
 */
export const MAINMAST_Z = -1.9;
export const FOREMAST_Z = 4.1;

/** Height of the deck partners, where the rake is measured from. */
const PARTNER_Y = 4.0;

/**
 * Rake, radians aft. The main rakes harder than the fore, which is the
 * traditional arrangement and reads as deliberate rather than as error.
 */
const FORE_RAKE = (4.0 * Math.PI) / 180;
const MAIN_RAKE = (5.5 * Math.PI) / 180;

interface MastAxis {
  partnerZ: number;
  rake: number;
}

const FORE_AXIS: MastAxis = { partnerZ: FOREMAST_Z, rake: FORE_RAKE };
const MAIN_AXIS: MastAxis = { partnerZ: MAINMAST_Z, rake: MAIN_RAKE };

/**
 * Where a mast's axis is at height `y`.
 *
 * Rake is measured about the deck partner so that changing it never moves the
 * hole in the deck — the one point on a mast that a walkable deck has an
 * opinion about.
 */
function mastZAt(axis: MastAxis, y: number): number {
  return axis.partnerZ - (y - PARTNER_Y) * Math.tan(axis.rake);
}

/**
 * Depth of floor timbers plus keelson above the rabbet, metres.
 *
 * The masts step on the keelson, not on the deck — 2.4 m of extra lever arm on
 * 526 kg of mainmast, and the mass model places that timber as though it were
 * stepped much higher. See `rigMassAudit()`.
 */
const KEELSON_DEPTH = 0.55;

/** Height of a mast step above the baseline at `z`. */
export function mastStepY(z: number): number {
  return floorYAt(z) + KEELSON_DEPTH;
}

// --- mast heights ------------------------------------------------------------

/**
 * Head of the main topmast above the baseline.
 *
 * 22.0 − 2.30 = 19.7 m above the design waterline, inside the spec's 19–20 m
 * band and deliberately not at its top: she is a working expedition schooner,
 * and section 3 forbids "implausibly tall or thin spars".
 */
export const MAIN_TOPMAST_HEAD_Y = 22.0;

/** Head of the fore topmast, leaving bare stick above the topsail yard. */
export const FORE_TOPMAST_HEAD_Y = 21.3;

/** Head of the mainmast proper — the cap, where the topmast is fidded. */
export const MAIN_CAP_Y = 15.15;

/**
 * Head of the foremast proper.
 *
 * Lowered from 14.60: at that height the fore cap was 96% of the main's, and
 * the schooner cue — a shorter mast forward — barely landed. The fore is still
 * heavy for its height because it carries the yards.
 */
export const FORE_CAP_Y = 14.05;

/**
 * Length of the doubling — cap down to hounds, where the topmast heel is fidded.
 *
 * The topmast does not begin where the lower mast ends. It overlaps it, held
 * between the trestletrees at the hounds and the cap above, and that overlap is
 * what carries the load. Drawing the two as one continuous stick end to end is
 * the single most common way a rig reads as a toy.
 */
const DOUBLING = 1.45;

export const MAIN_HOUNDS_Y = MAIN_CAP_Y - DOUBLING;
export const FORE_HOUNDS_Y = FORE_CAP_Y - DOUBLING;

/**
 * How far abaft its lower mast a topmast is fidded.
 *
 * A z offset, not an x one — on a fore-and-aft rig the topmast is fidded abaft,
 * so the two sticks are side by side in profile, which is the view the doubling
 * has to read in.
 */
const TOPMAST_FID = 0.17;

/** How far to one side a stay's standing part leads, clear of a fidded topmast. */
const MASTHEAD_EYE_OFFSET = 0.22;

/** How far along the main boom the sheet's bail sits, from the gooseneck. */
const MAIN_SHEET_BOOM_FRACTION = 0.66;

function foreTopmastZAt(y: number): number {
  return mastZAt(FORE_AXIS, y) - TOPMAST_FID;
}

function mainTopmastZAt(y: number): number {
  return mastZAt(MAIN_AXIS, y) - TOPMAST_FID;
}

// --- spar diameters ----------------------------------------------------------

/**
 * Mast diameters, metres, at the partners and at the head.
 *
 * The mainmast's mean radius of 0.145 is `massModel.ts`'s, and it is a volume of
 * timber rather than a guess: 14.5 m at that radius is 0.96 m³ of pine, 526 kg.
 * A mast tapers from its partners upward, so these two figures bracket that mean
 * rather than replacing it. `rigMassAudit()` checks the volume that results.
 */
const MAINMAST_R_PARTNERS = 0.175;
const MAINMAST_R_HEAD = 0.108;
const FOREMAST_R_PARTNERS = 0.166;
const FOREMAST_R_HEAD = 0.102;
const TOPMAST_R_HEEL = 0.095;
const TOPMAST_R_HEAD = 0.052;

const BOWSPRIT_R_HEEL = 0.155;
const BOWSPRIT_R_HEAD = 0.078;
/** Boom radii, exported so a furl bundle can be a sleeve over the spar. */
export const BOOM_R_MID = 0.098;
export const BOOM_R_END = 0.062;
const GAFF_R_THROAT = 0.082;
const GAFF_R_PEAK = 0.048;
const YARD_R_SLING = 0.088;
const YARD_R_ARM = 0.038;

// --- the trim staircase ------------------------------------------------------

/**
 * How far each sail is sheeted from the centreline, radians.
 *
 * She is drawn sailing, and a sail on the centreline is not drawing — it is
 * being dried. But the important property here is that these differ. Sheeting
 * everything to one angle makes every sail on a mast coplanar, and coplanar
 * sails intersect: the first version put 30% of the fore staysail's area
 * *inside* the foresail, not as a depth-sorting artefact but as actual shared
 * space.
 *
 * The order is also correct trim — the aftmost sail is sheeted hardest, and
 * each headsail forward of it is eased a little further.
 *
 * Fixed, not driven. The wind heading belongs to the sea state and it moves;
 * making the rig follow it is sailing work with its own round.
 */
const DEG = Math.PI / 180;
export const SHEET_MAIN = 26 * DEG;
export const SHEET_FORE = 30 * DEG;
export const SHEET_STAYSAIL = 33 * DEG;
export const SHEET_JIB = 35 * DEG;
export const SHEET_FLYING_JIB = 37 * DEG;
export const SHEET_FISHERMAN = 40 * DEG;

/**
 * How far the yards are braced round from athwartships.
 *
 * THE POINT OF SAIL IS A SILHOUETTE DECISION, NOT A SAILING ONE
 * -------------------------------------------------------------
 * Fore-and-aft sails and square sails read from opposite poses. Close-hauled —
 * gaffs at 14–19°, yards braced 29° — the gaff sails show nearly their full
 * area from abeam and the square topsail is edge-on and invisible. Running, it
 * is the other way round.
 *
 * `docs/ship/SHIP_SPEC.md` section 3 makes that a decision rather than a preference: *"at
 * distance she must be immediately recognisable by two masts, a long bowsprit,
 * fore-and-aft working sails and a single square topsail forward."* The topsail
 * is one of four named cues and the only one a close-hauled pose throws away —
 * on the first close-hauled draft it disappeared completely from the broadside
 * shot at 55 m.
 *
 * So she is drawn on a broad reach: gaffs eased to 26–30°, yards braced to 15°.
 * Both sail types keep most of their projected area from abeam, the two angles
 * still describe one coherent apparent wind, and it is the point of sail an
 * expedition schooner spends her life on anyway.
 */
const BRACE_ANGLE = 15 * DEG;

/**
 * The authored trim angles, exported for the S4 control surface: these are
 * the values the drawn rig is baked at, the defaults `SailingControls`
 * starts from, and the fixture trims the frozen-trim (S2) evidence was
 * generated against. Live trim re-runs the same constructors these feed.
 */
export const AUTHORED_BRACE_ANGLE = BRACE_ANGLE;

/**
 * Swing a point about the vertical axis through a mast or a tack.
 *
 * Positive angle carries an after-pointing spar's end to port, and carries
 * an athwartship yard's port arm forward — which is how a yard braces with
 * the wind on the starboard side. One rotation serves both because it is the same
 * rotation.
 */
function swingAbout(
  x: number,
  z: number,
  pivotZ: number,
  angle: number,
): { x: number; z: number } {
  const dz = z - pivotZ;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - dz * s, z: pivotZ + x * s + dz * c };
}

// --- the bowsprit ------------------------------------------------------------

/**
 * Steeve of the bowsprit — the angle it rises above horizontal, radians.
 *
 * Eased from 13° to 10°: a flatter bowsprit spreads the three headsail tacks
 * further apart in height as well as in length, which is half of what stops
 * them stacking on top of one another.
 */
const BOWSPRIT_STEEVE = 10 * DEG;

/** Where the bowsprit's heel is fixed, between the riding bitts. */
const BOWSPRIT_HEEL_Z = 5.15;

/**
 * How far the bowsprit reaches beyond the stem, metres, measured along the spar.
 *
 * Section 3 wants her recognisable at distance by "two masts, a long bowsprit" —
 * one of only four silhouette cues named, and the only horizontal one. She
 * carries both a jib and a flying jib off this one spar rather than setting a
 * separate jibboom, which is the restrained answer for a vessel this size.
 */
const BOWSPRIT_OUTBOARD = 4.6;

// --- booms and gaffs ---------------------------------------------------------

/**
 * Height of each boom's gooseneck above the baseline.
 *
 * Raised from 5.24 / 5.10, which put the main boom 0.87 m over the quarterdeck —
 * crawling height, not ducking height — and left the fife rail abaft each mast
 * standing straight through the boom above it. A boom has to clear the deck
 * furniture at its own mast before anything else, because that is where it is
 * lowest and where the crew work.
 *
 * THE MAIN WENT UP AGAIN WHEN SHE GOT A TILLER
 * --------------------------------------------
 * 5.75 left 1.38 m over the helm and 1.23 m at the quarterdeck break, and once
 * M3 put a tiller on the quarterdeck that stopped being a comfort question. A
 * helmsman has to *stay* under the boom while it comes across — he cannot step
 * aside, because the thing he is holding is the reason he is there — and a body
 * is 1.75 m. At 1.38 m he is not ducking, he is kneeling, and the collision
 * model would not have let him stand at the helm at all once M6 lets the boom
 * come amidships.
 *
 * The geometry behind it: the boom is **pivoted over the waist and sweeps the
 * quarterdeck, which is 0.55 m higher**. A gooseneck set comfortably for the
 * deck it stands on is half a metre too low for the deck it works over, and no
 * amount of peaking the boom fixes the part nearest the mast. So the gooseneck
 * carries the quarterdeck's rise: 6.15 is 2.25 m over the waist deck at the
 * mast, high for a gaff boom and *because* of the raised deck abaft it.
 *
 * Costs 0.40 m off the mainsail's luff, about 5% of her largest sail. That is
 * the trade, and it is Ash's: "you need to fix the sail plan to make manning the
 * helm possible while that boom swings."
 *
 * The fore gooseneck is untouched. Its boom is 5.07 m over the flat waist and
 * clears 1.39 m at its worst, which is a duck — and nobody has to stand still
 * under it.
 */
const MAIN_GOOSENECK_Y = 6.15;
const FORE_GOOSENECK_Y = 5.6;

/** Peak angles, radians above horizontal. */
const MAIN_PEAK_ANGLE = 39 * DEG;
const FORE_PEAK_ANGLE = 38 * DEG;

/**
 * Boom and gaff lengths, metres.
 *
 * A gaff runs about 0.7 of its boom. The fore gaff was 4.50 against a 5.07 boom
 * — 0.89 — and that excess is what drove its peak up to 15.81 and straight
 * through the square topsail above it. At 3.40 the peak lands at 14.89 and
 * leaves a metre of daylight under the topsail's foot.
 */
const MAIN_BOOM_LENGTH = 8.6;
const MAIN_GAFF_LENGTH = 5.9;
const FORE_BOOM_LENGTH = 5.07;
const FORE_GAFF_LENGTH = 3.4;

/**
 * A boom's end rides above its gooseneck: the topping lift holds it up.
 *
 * Per boom, because the two work over different decks. Raising a gooseneck lifts
 * the whole boom and costs luff — the sail's whole hoist — while peaking it up
 * lifts only the after half and costs a corner of the foot. The main needs its
 * clearance *aft*, over the quarterdeck and the helm, so it takes the cheaper
 * lever there and 0.95 buys 0.09 m at the helm for a tenth of what the same
 * clearance would have cost in luff. 6.3° above horizontal, against 4.8°.
 *
 * The fore boom keeps 0.72. It works over the flat waist, where the clearance
 * problem is at its own gooseneck and peaking it up would do nothing.
 */
const MAIN_BOOM_RISE = 0.95;
const FORE_BOOM_RISE = 0.72;

// --- yards -------------------------------------------------------------------

/**
 * TWO yards on the foremast, which is what a single square topsail wants.
 *
 * A LESSON ABOUT CENTURIES
 * ------------------------
 * This carried three yards until the second pass: a bare course yard low on the
 * lower mast, and the topsail bent between two closely-spaced yards up on the
 * topmast. That arrangement has a name — the **double topsail** — and it was
 * invented in the 1850s, some seventy years after this ship. `docs/ship/SHIP_SPEC.md`
 * section 2 dates her 1765–1780.
 *
 * It got there by accident rather than by choice. The topsail was originally set
 * too low, the fore gaff's peak cut through it, and the fix applied was to move
 * the sail *up* the topmast until it cleared. But a gaff and a square sail do not
 * compete for height — they compete for space, and they are never in the same
 * space, because the square sail is set forward of the mast and the gaff sail
 * abaft it. Moving the topsail up bought clearance in the one dimension where
 * there was no conflict, and cost 16 m² of the sail the whole rig type is named
 * after. The right fix was to move it *forward*, which is `YARD_FORWARD_OF_MAST`
 * below.
 *
 * WHAT IS DRAWN NOW
 * -----------------
 * The period arrangement, and the one the bare yard was always implying:
 *
 * - a **lower yard**, fixed, crossed on the lower mast, which the topsail's
 *   clews haul down to. It is no longer decorative — section 7.4's rule against
 *   decoration applies to spars as much as to rope, and a yard with nothing
 *   bent to it and nothing sheeted to it was in breach of it.
 * - a **topsail yard**, hoisting, on the topmast, which the head is bent to.
 *
 * The sail spans the whole gap between them: 6.65 m on the hoist against the
 * 3.10 m it had, and 40 m² against 24.8. Section 3 names the square topsail as
 * one of only four things she must be recognisable by at distance, and at the
 * old size it read as a handkerchief on a schooner.
 */
/**
 * The lower yard is slung immediately under the fore trestletrees, and that is
 * what pins its height.
 *
 * It was at 11.75 when it was a bare spar and nothing depended on where it sat.
 * Now the topsail's foot is spread by it, so its height *is* the sail's foot, and
 * two things bracket it from opposite sides:
 *
 * - it must be **below the fore crosstrees** (12.60), because a yard is slung on
 *   the lower mast by a truss under the top. Above them it would be on the
 *   topmast, which is the double-topsail arrangement all over again.
 * - it must be **as high as that allows**, because everything set on a stay
 *   forward of this mast has to pass under the topsail's foot, and the lower it
 *   hangs the more of the fore triangle it takes.
 *
 * The last 0.10 m of it was bought for the fore gaff. The gaff's throat is on the
 * mast at 12.25 and the topsail's foot is `YARD_FORWARD_OF_MAST` ahead of it, so
 * the two are closest right there — and once that standoff had to come down to
 * 0.26 to keep the jib out of the sail, the only clearance left to give the gaff
 * was vertical.
 */
const LOWER_YARD_Y = 12.45;
const LOWER_YARD_HALF_SPAN = 3.9;

/**
 * The topsail yard, and why nothing may attach to the mast below it.
 *
 * The topsail owns the topmast from the cap up to here; the two headsail stays
 * own everything above (19.7 and 21.05). A stay leaving the mast from *behind* a
 * set square sail has to cut out through the cloth to get anywhere, and on the
 * first pass one did: the jib's head was at 17.60, halfway up the hoist, for 16
 * crossings with the jib and 16 with the flying jib. No camber would have fixed
 * it — the fault was in the order things were stacked on the stick.
 *
 * That constraint forces the headsail fan uneven, which is correct for the type.
 * Assert comparable *areas*, never even spacing.
 */
const TOPSAIL_YARD_Y = 18.20;
const TOPSAIL_YARD_HALF_SPAN = 2.95;

/**
 * How much of a yard the sail is bent to.
 *
 * Never all of it. The yardarms project beyond the cloth, and that projecting
 * orange stub is a large part of what reads as "square rig" rather than as a
 * rectangle hung between two lines.
 */
const CLOTH_ON_YARD = 0.88;

/**
 * How far out the lower yard the topsail's clews are hauled, as a fraction of
 * its half span.
 *
 * A topsail's foot is not bent to anything. Its two clews are hauled down and
 * outboard to the lower yardarms by the sheets, and the foot hangs loose between
 * them — which is why the sail is a trapezoid wider at the bottom than the top,
 * and why the lower yard has to be there at all. The sheet reeves through a
 * sheave in the yardarm, so the cloth stops a little short of the very end.
 */
const TOPSAIL_CLEW_ON_YARD = 0.9;

/**
 * How far forward of the mast's axis a yard is slung, metres.
 *
 * A yard is not on the mast, it is held to it by a truss that stands it off —
 * and that standoff is the only thing keeping the square sail's cloth clear of
 * the stick. **It is also the only thing separating the square topsail from the
 * fore gaff**, now that the two overlap in height as they do on a real rig.
 *
 * SQUEEZED FROM BOTH SIDES, WHICH IS WHY IT IS AN ODD NUMBER
 * -----------------------------------------------------------
 * Bigger is not safer. The sail has to clear the mast and the gaff *behind* it,
 * which wants this large; and it has to stay out of the **jib**, which wants it
 * small — because the jib's stay is set up on the fore topmast, and the topmast
 * is fidded 0.17 m abaft the lower mast, so the jib's head starts 0.05 m *behind*
 * the lower mast's axis. A stay that begins behind a set square sail has to cut
 * out through it, and the further forward this sail stands, the lower down the
 * jib crosses it. At 0.36 the two genuinely intersected.
 *
 * 0.26 is where both are satisfied. It was found by sweeping, because the two
 * surfaces run nearly parallel where they meet and the gap does not vary
 * monotonically with anything — a point-sampled distance of 0.05 m turned out to
 * be a real crossing, which is why the edge-versus-triangle test is the one that
 * decides this and not a nearest-point measurement.
 *
 * `tests/ship-rig.test.ts` measures the results against the surface that is
 * actually drawn — belly included, every spar separately — rather than against a
 * flat quad through the corners.
 */
const YARD_FORWARD_OF_MAST = 0.24;

// --- the graph ---------------------------------------------------------------

export interface RigPoint {
  x: number;
  y: number;
  z: number;
}

function p(x: number, y: number, z: number): RigPoint {
  return { x, y, z };
}

/**
 * A spar: a tapered round timber between two points. The taper between them is
 * linear, which is what a spar shaped by eye and adze actually is.
 */
export interface Spar {
  name: string;
  heel: RigPoint;
  head: RigPoint;
  heelRadius: number;
  headRadius: number;
}

export function sparLength(spar: Spar): number {
  return Math.hypot(
    spar.head.x - spar.heel.x,
    spar.head.y - spar.heel.y,
    spar.head.z - spar.heel.z,
  );
}

/** Volume of timber in a spar, m³ — a truncated cone. */
export function sparVolume(spar: Spar): number {
  const a = spar.heelRadius;
  const b = spar.headRadius;
  return (Math.PI * sparLength(spar) * (a * a + a * b + b * b)) / 3;
}

/** Centroid of a truncated cone, as a fraction of its length from the heel. */
export function sparCentroidFraction(spar: Spar): number {
  const a = spar.heelRadius;
  const b = spar.headRadius;
  const denom = a * a + a * b + b * b;
  if (denom < 1e-12) return 0.5;
  return (a * a + 2 * a * b + 3 * b * b) / (4 * denom);
}

export function sparCentroid(spar: Spar): RigPoint {
  const t = sparCentroidFraction(spar);
  return p(
    spar.heel.x + (spar.head.x - spar.heel.x) * t,
    spar.heel.y + (spar.head.y - spar.heel.y) * t,
    spar.heel.z + (spar.head.z - spar.heel.z) * t,
  );
}

/**
 * Where a mast stands at one height, and how thick it is there.
 *
 * **The wardroom's mess table butts on the mainmast and the forecastle's hinged
 * table hangs on the foremast, so furniture below decks has to be able to ask a
 * spar where it is two decks under the partners.** It must not ask
 * `MAINMAST_Z`: that is the station at the *partners* by construction — see
 * `mastZAt` — and both masts rake, so at the wardroom's sole the mainmast is
 * 0.21 m forward of it. A fitting that took −1.9 for the answer would be built
 * a fifth of a metre inside the mast and nothing would throw.
 *
 * Read off the same `SPARS` entry the loft draws and the obstacle index slices,
 * and `y` is clamped to the spar's own range rather than extrapolated: a
 * question about a mast below its step has no honest answer and the heel is the
 * nearest true one.
 */
export function mastSectionAt(name: string, y: number): { z: number; radius: number } {
  const spar = SPARS.find((candidate) => candidate.name === name);
  if (!spar) throw new Error(`no spar named ${name}`);
  const rise = spar.head.y - spar.heel.y;
  const raw = Math.abs(rise) < 1e-9 ? 0 : (y - spar.heel.y) / rise;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  return {
    z: spar.heel.z + (spar.head.z - spar.heel.z) * t,
    radius: spar.heelRadius + (spar.headRadius - spar.heelRadius) * t,
  };
}

// --- derived positions -------------------------------------------------------

const MAIN_STEP_Y = mastStepY(MAINMAST_Z);
const FORE_STEP_Y = mastStepY(FOREMAST_Z);

const BOWSPRIT_HEEL_Y = walkingDeckY(BOWSPRIT_HEEL_Z) + 0.34;
const BOWSPRIT_RUN = HALF_LENGTH - BOWSPRIT_HEEL_Z + BOWSPRIT_OUTBOARD;
const BOWSPRIT_END_Z = BOWSPRIT_HEEL_Z + BOWSPRIT_RUN * Math.cos(BOWSPRIT_STEEVE);
const BOWSPRIT_END_Y = BOWSPRIT_HEEL_Y + BOWSPRIT_RUN * Math.sin(BOWSPRIT_STEEVE);

function alongBowsprit(t: number): RigPoint {
  return p(
    0,
    BOWSPRIT_HEEL_Y + (BOWSPRIT_END_Y - BOWSPRIT_HEEL_Y) * t,
    BOWSPRIT_HEEL_Z + (BOWSPRIT_END_Z - BOWSPRIT_HEEL_Z) * t,
  );
}

const MAIN_GOOSENECK_Z = mastZAt(MAIN_AXIS, MAIN_GOOSENECK_Y);
const FORE_GOOSENECK_Z = mastZAt(FORE_AXIS, FORE_GOOSENECK_Y);

/**
 * How far below the hounds each gaff's throat rides, metres.
 *
 * **A GAFF HAS TO BE ABLE TO SWING, AND THIS IS WHAT DECIDES IT.**
 *
 * It was 0.35, and at 0.35 neither gaff could move: a gaff rises aft from its
 * throat at about 1.1 m aft per metre of rise, so 0.35 m below the hounds it
 * reaches the *trestletrees* — the fore-and-aft members the topmast is fidded
 * between — about 0.34 m abaft the mast, at exactly their height. The spar
 * passed through them. Ash spotted it as **the big wooden bar across the top of
 * the sail could not swing**, on both masts, and he is right: it could not.
 *
 * Nothing caught it because no test compared a *spar* with a *top*. The sails
 * are checked against the tops now, and so are the gaffs.
 *
 * At 0.70, with the trestletrees shortened to 0.70 m fore-and-aft, each gaff
 * passes about 0.12 m clear beneath them. The two numbers are a pair: a longer
 * top needs a lower throat, and the tops cannot simply be lengthened again
 * without re-deriving this. There is a test that measures the clearance rather
 * than trusting it.
 *
 * Costs 0.35 m off the head of each gaff sail. Cheap for two spars that work.
 */
const THROAT_BELOW_HOUNDS = 0.7;

const MAIN_THROAT_Y = MAIN_HOUNDS_Y - THROAT_BELOW_HOUNDS;
const FORE_THROAT_Y = FORE_HOUNDS_Y - THROAT_BELOW_HOUNDS;
const MAIN_THROAT_Z = mastZAt(MAIN_AXIS, MAIN_THROAT_Y);
const FORE_THROAT_Z = mastZAt(FORE_AXIS, FORE_THROAT_Y);

const MAIN_BOOM_END_Y = MAIN_GOOSENECK_Y + MAIN_BOOM_RISE;
const FORE_BOOM_END_Y = FORE_GOOSENECK_Y + FORE_BOOM_RISE;

/** A gaff's two ends: jaws on the mast, peak swung out to its sheet. */
export interface GaffPose {
  throat: RigPoint;
  peak: RigPoint;
}

/**
 * Where a gaff lies at a given hoist — and why the hoist has to reach the
 * spar at all.
 *
 * A gaff sail does not shrink in place when it comes down. The halyards run,
 * **the gaff itself descends**, and the cloth gathers on the boom underneath
 * it. Modelling the hoist as a compression of the cloth alone left the gaff
 * peaked over a sail that had fallen away from it, and dragged the sail's clew
 * below the boom it is bent to — the fault Ash saw on the first furl.
 *
 * So the hoist moves two things and the cloth simply follows them:
 *
 * - the **jaws** slide down the mast, from the throat to the gooseneck, on the
 *   mast's own raked line (`mastZAt` is linear in height, so this is the line
 *   and not an approximation of it);
 * - the **peak** drops with them, its angle above horizontal easing from the
 *   sail plan's peak angle to the boom's own rise.
 *
 * At hoist 0 that puts the gaff lying along its boom with the jaws at the
 * gooseneck — exactly where `rigGeometry.ts` draws the furled bundle — so the
 * bottom of the hoist and the furled state are one picture rather than a pop.
 *
 * The reef fixed points ride the same curve, and that is not a compromise:
 * reefing a gaff sail *is* lowering the gaff by the depth of the reef band and
 * tying the new foot down to the boom. One fraction honestly describes both
 * evolutions.
 */
function gaffPoseAt(
  axis: MastAxis,
  throatY: number,
  gooseneckY: number,
  gaffLength: number,
  peakAngle: number,
  boomLength: number,
  boomRise: number,
  sheet: number,
  hoist: number,
): GaffPose {
  // Full hoist takes the authored arithmetic untouched. Interpolating with
  // t = 1 is not bitwise the same as not interpolating, and every S2/S3
  // fixture and evidence file is pinned to these exact numbers.
  const jawY = hoist >= 1 ? throatY : gooseneckY + (throatY - gooseneckY) * hoist;
  const jawZ = mastZAt(axis, jawY);
  const stowedAngle = Math.atan2(boomRise, boomLength);
  const angle =
    hoist >= 1 ? peakAngle : stowedAngle + (peakAngle - stowedAngle) * hoist;
  const swung = swingAbout(0, jawZ - gaffLength * Math.cos(angle), jawZ, sheet);
  return {
    throat: p(0, jawY, jawZ),
    peak: p(swung.x, jawY + gaffLength * Math.sin(angle), swung.z),
  };
}

// Swung out to their sheeted angles about their own masts, and lowered to
// their hoists. Each is a named function of sheet and hoist so S4's live trim
// can re-run the same construction at a commanded state — at the authored
// angle and full hoist the result is bit-identical to the baked node, by
// shared arithmetic rather than by test tolerance (though a test pins it too).
function mainGaffAt(sheet: number, hoist = 1): GaffPose {
  return gaffPoseAt(
    MAIN_AXIS,
    MAIN_THROAT_Y,
    MAIN_GOOSENECK_Y,
    MAIN_GAFF_LENGTH,
    MAIN_PEAK_ANGLE,
    MAIN_BOOM_LENGTH,
    MAIN_BOOM_RISE,
    sheet,
    hoist,
  );
}
function foreGaffAt(sheet: number, hoist = 1): GaffPose {
  return gaffPoseAt(
    FORE_AXIS,
    FORE_THROAT_Y,
    FORE_GOOSENECK_Y,
    FORE_GAFF_LENGTH,
    FORE_PEAK_ANGLE,
    FORE_BOOM_LENGTH,
    FORE_BOOM_RISE,
    sheet,
    hoist,
  );
}
function mainBoomEndSwungAt(sheet: number): { x: number; z: number } {
  return swingAbout(0, MAIN_GOOSENECK_Z - MAIN_BOOM_LENGTH, MAIN_GOOSENECK_Z, sheet);
}
function foreBoomEndSwungAt(sheet: number): { x: number; z: number } {
  return swingAbout(0, FORE_GOOSENECK_Z - FORE_BOOM_LENGTH, FORE_GOOSENECK_Z, sheet);
}

const MAIN_GAFF = mainGaffAt(SHEET_MAIN);
const FORE_GAFF = foreGaffAt(SHEET_FORE);
const MAIN_PEAK = MAIN_GAFF.peak;
const FORE_PEAK = FORE_GAFF.peak;
const MAIN_BOOM_END = mainBoomEndSwungAt(SHEET_MAIN);
const FORE_BOOM_END = foreBoomEndSwungAt(SHEET_FORE);

/**
 * Each yard stands off the stick it is actually slung on.
 *
 * Tried the other way — both measured from the lower mast's rake line, so the
 * sail hangs in one plane parallel to the stick — on the theory that the aft
 * tilt was costing clearance at the lower masthead. It cost nothing there and
 * carried the sail's head 0.17 m forward straight into the jib. Measured, not
 * reasoned: the tilt is not the problem it looks like.
 */
function yardArms(
  y: number,
  halfSpan: number,
  topmast: boolean,
  brace: number = BRACE_ANGLE,
): { port: RigPoint; starboard: RigPoint; sling: RigPoint } {
  const axisZ = (topmast ? foreTopmastZAt(y) : mastZAt(FORE_AXIS, y)) + YARD_FORWARD_OF_MAST;
  const s = swingAbout(halfSpan, axisZ, axisZ, brace);
  const t = swingAbout(-halfSpan, axisZ, axisZ, brace);
  return {
    port: p(s.x, y, s.z),
    starboard: p(t.x, y, t.z),
    sling: p(0, y, axisZ),
  };
}

const LOWER_YARD = yardArms(LOWER_YARD_Y, LOWER_YARD_HALF_SPAN, false);
const TOPSAIL_YARD = yardArms(TOPSAIL_YARD_Y, TOPSAIL_YARD_HALF_SPAN, true);

/**
 * The clews, hauled out along the lower yard.
 *
 * They lie on the lower yard's own line — that is what "hauled down to the
 * yardarm" means — so they take the same brace angle the yard does and the foot
 * of the sail stays square to it.
 */
const TOPSAIL_CLEWS = yardArms(
  LOWER_YARD_Y,
  LOWER_YARD_HALF_SPAN * TOPSAIL_CLEW_ON_YARD,
  false,
);
const TOPSAIL_HEAD_CLOTH = yardArms(
  TOPSAIL_YARD_Y,
  TOPSAIL_YARD_HALF_SPAN * CLOTH_ON_YARD,
  true,
);

/**
 * Heads of the three headsails: one at the lower masthead, two above the topsail.
 *
 * The first version had 13.15, 14.60, 20.40 — two nearly together and then a
 * 5.8 m jump, which made the flying jib a quarter of the entire sail plan with
 * the other two hidden inside it. Even steps fixed that, but even steps put the
 * jib's head inside the square topsail, and a stay cannot leave a mast from
 * behind a set sail.
 *
 * So the spacing is compressed above the topsail rather than even, which is what
 * a topsail schooner's headsail fan actually looks like: the square sail takes
 * the middle of the rig, and the headsails take what is above and below it.
 *
 * THE FORE STAY CAME DOWN OFF THE MASTHEAD, AND HAD TO
 * ----------------------------------------------------
 * `STAYSAIL_HEAD_Y` was `FORE_CAP_Y` — the fore masthead, which is where a
 * schooner's fore stay is normally set up, and which was safe for exactly as
 * long as the square topsail lived above it on the topmast. Returning the
 * topsail to its full hoist put the masthead *inside* the sail's height band,
 * and what follows from that is not negotiable:
 *
 *   at the cap, the topsail's cloth stands about 0.70 m forward of the mast's
 *   axis — 0.30 of yard standoff plus 0.40 of belly — and the stay's head stands
 *   0.55 m forward of it.
 *
 * The stay's head is therefore **behind** the cloth, and a stay that begins
 * behind a set square sail has to cut out through it to reach the bowsprit. That
 * is precisely the fault section 4 of the handover records for the jib, arriving
 * from the other side. Neither knob reaches it: clearing the stay by 0.15 m
 * would need a camber under 0.03, which is a board and not a sail, and doing it
 * with standoff alone would want 0.85 m of truss — a crane on the masthead.
 *
 * So the fore stay is set up **below the topsail's foot**, and the whole fore
 * triangle passes under the yard. That is the same rule the jib and the flying
 * jib already obey from above — *nothing attaches to the mast between the
 * topsail's yards* — and the fore stay was the last thing still breaking it.
 * It costs the staysail 2.4 m of luff, which is the price of the topsail being
 * the size its own rig type is named for. See the headsail-fan note in
 * `tests/ship-rig.test.ts`.
 */
const STAYSAIL_HEAD_Y = LOWER_YARD_Y - 0.25;
const JIB_HEAD_Y = 19.7;
const FLYING_JIB_HEAD_Y = 21.05;

/**
 * How far forward of the mast's axis a headsail stay is set up, metres.
 *
 * Not on the axis. A stay is shackled to a band on the *forward* face of the
 * masthead, because forward is the only direction it pulls. A band is a hoop
 * round the timber, so this number is the mast's own radius and a little more —
 * 0.12 against 0.102 at the fore cap and 0.060 up at the jib's head. Close
 * enough that the stay visibly *starts on the stick*.
 *
 * A DODGE THAT OUTLIVED THE THING IT WAS DODGING
 * ----------------------------------------------
 * This was **0.55**, which is not a band on a masthead — it is half a metre of
 * daylight with nothing in it. It got there honestly: with the stays on the axis
 * the jib's head started behind the square topsail's plane and its cloth had to
 * come forward through the sail to reach the bowsprit, 12 crossings, and neither
 * easing the brace nor flattening the camber touched it. Standing the stays off
 * forward of the sail fixed it.
 *
 * Then the topsail was returned to its full hoist, and in the course of that
 * every stay was moved out of the sail's height band for a better reason — the
 * fore stay is set up *below* the lower yard, and both jib heads are *above* the
 * topsail yard. Nothing needs dodging any more. What was left was three stays
 * ending half a metre in front of a mast they no longer touched, with a large
 * square sail filling the gap, so the whole head rig read as hanging in space.
 * **Ash caught it by eye on the first drawing.**
 *
 * The general shape of that mistake is worth more than the fix: a workaround
 * that is invisible while the thing it works around is present, and absurd the
 * moment that thing moves. Section 7.4's rule — every rope ends at a thing —
 * catches it if you apply it to the *upper* end of a stay as well as the lower.
 */
const STAY_FORWARD_OF_MAST = 0.12;

/**
 * A stay set up on the fore TOPMAST lands **on the timber**, so its standoff is
 * the mast's own radius at that height and nothing more.
 *
 * A BAND, NOT A STANDOFF
 * ----------------------
 * This was 0.44 for a while, to hold the jib's cloth clear of the square
 * topsail, and the standoff was made "legible" by drawing a short pendant from
 * the mast out to each stay head.
 *
 * **That pendant was nonsense and Ash said so.** A pendant only carries load
 * along its own line; drawn horizontal, square across the direction the stay
 * pulls, it holds nothing — the stay head would swing down under the sail's
 * weight until the pendant came in line with the load. Dressing a fictional
 * coordinate in a rope does not make the coordinate real; it just makes the
 * fiction load-bearing in the drawing and not in the physics.
 *
 * Then it was a flat 0.12, which was better and still left 0.06 m of daylight
 * at the flying jib's head, because the topmast has tapered to 0.053 m up
 * there. A band is a hoop *round the stick*, so the only honest value is the
 * stick's radius — which changes with height. It is computed, not chosen.
 */
function topmastStayForward(y: number): number {
  const heel = FORE_HOUNDS_Y - 0.55;
  const t = Math.min(Math.max((y - heel) / (FORE_TOPMAST_HEAD_Y - heel), 0), 1);
  return TOPMAST_R_HEEL + (TOPMAST_R_HEAD - TOPMAST_R_HEEL) * t;
}

const STEMHEAD = p(0, walkingDeckY(HALF_LENGTH - 0.2) + 0.5, HALF_LENGTH - 0.1);
const JIB_TACK = alongBowsprit(0.62);
const FLYING_JIB_TACK = alongBowsprit(1);

/** Upper ends of the two topmast stays — on the timber, at the mast's radius. */
const JIB_STAY_HEAD = p(
  0,
  JIB_HEAD_Y,
  foreTopmastZAt(JIB_HEAD_Y) + topmastStayForward(JIB_HEAD_Y),
);
const FLYING_JIB_STAY_HEAD = p(
  0,
  FLYING_JIB_HEAD_Y,
  foreTopmastZAt(FLYING_JIB_HEAD_Y) + topmastStayForward(FLYING_JIB_HEAD_Y),
);

/**
 * **A HEADSAIL'S HEAD IS NOT THE TOP OF ITS STAY.**
 *
 * The stay runs to the masthead; the sail is hoisted part-way up it and there is
 * bare stay above. Every photograph of the type shows it — Ash sent three, and in
 * all of them the jibs' heads stop well short of the topmast while the stays
 * carry on past them.
 *
 * This is the thing that finally separated the jib from the square topsail, and
 * it is the *only* fix that separated them by a real margin rather than a
 * whisker. The two had been forced into each other by a false premise: that the
 * jib's cloth had to reach the point where its stay was set up. Once it does not,
 * the sail begins where the stay is already a metre forward of the mast, which is
 * a metre forward of the topsail — and nothing has to be traded to get it.
 *
 * Everything else tried against this conflict was a compromise between two things
 * that both wanted to be somewhere else: the yard's truss standoff (a one-step
 * window, 0.13 m at the masthead), the topsail yard's height, the jib's tack, the
 * camber, the stay standoff, and a fake pendant. **All of them were negotiating
 * over a constraint that was not real.** When a geometry problem only has bad
 * answers, the premise is usually wrong.
 *
 * It also fixes something that was recorded as a separate finding: the flying jib
 * was the *largest* headsail, which `rig.ts` itself said was backwards. Taking
 * the heads down the stays cuts the two outer sails hardest, and the fan comes
 * out in the order real practice puts it.
 */
const HEADSAIL_HEAD_ON_STAY = 0.28;

function headsailHead(stayHead: RigPoint, tack: RigPoint): RigPoint {
  const t = HEADSAIL_HEAD_ON_STAY;
  return p(
    stayHead.x + (tack.x - stayHead.x) * t,
    stayHead.y + (tack.y - stayHead.y) * t,
    stayHead.z + (tack.z - stayHead.z) * t,
  );
}

/**
 * A headsail's clew, swung out about its own tack.
 *
 * Sheeted, and forward of the foremast. The first version put the fore
 * staysail's clew 1.70 m *abaft* the foremast, so a third of the sail lay
 * inside the foresail and inside the mast itself.
 */
function headsailClew(tack: RigPoint, y: number, z: number, sheet: number): RigPoint {
  const swung = swingAbout(0, z, tack.z, sheet);
  return p(swung.x, y, swung.z);
}

/**
 * The staysail's clew is led further aft than it was — 4.6 → 4.15 before the
 * sheeting swing.
 *
 * It lost 2.25 m of luff when the fore stay came down off the masthead, and the
 * foot is the only direction it can take any of that back — 9.6 m² to 11.4. A
 * sailmaker handed a sail that had lost its hoist would do exactly this.
 *
 * The clew still has room to go further aft: the closest approach to the
 * foresail is 0.57 m and did not move when the clew did, so that pair is held
 * somewhere other than here. It stops at 4.15 because 11.4 m² is enough to keep
 * the three headsails comparable, not because anything is in the way — if this
 * sail ever needs to grow again, aft is open.
 */
/**
 * The un-swung clew placements (height, and fore-and-aft position before the
 * sheeting swing) — named so live trim can re-run `headsailClew` at a
 * commanded sheet angle from the same numbers the drawn rig uses.
 */
const STAYSAIL_CLEW_Y = 6.0;
const STAYSAIL_CLEW_Z = 4.15;
const JIB_CLEW_Y = 7.2;
const JIB_CLEW_Z = 5.9;
const FLYING_JIB_CLEW_Y = 8.6;
const FLYING_JIB_CLEW_Z = 7.4;

const STAYSAIL_CLEW = headsailClew(STEMHEAD, STAYSAIL_CLEW_Y, STAYSAIL_CLEW_Z, SHEET_STAYSAIL);
const JIB_CLEW = headsailClew(JIB_TACK, JIB_CLEW_Y, JIB_CLEW_Z, SHEET_JIB);
const FLYING_JIB_CLEW = headsailClew(FLYING_JIB_TACK, FLYING_JIB_CLEW_Y, FLYING_JIB_CLEW_Z, SHEET_FLYING_JIB);

/**
 * The fisherman's three corners — and why it lives entirely aloft.
 *
 * The first attempt tacked it down at y = 6.4, near deck level, which is where
 * a fisherman's tack goes on a vessel whose foresail is small. Hers is not: its
 * luff ran diagonally straight through the gaff foresail, 1.3 m of cloth inside
 * cloth at (1.27, 9.85, 0.09), and its foot crossed the foresail again near the
 * foremast.
 *
 * So it sits where the reference plans put it on a rig like hers: above the
 * fore gaff's peak entirely, filling the triangle between the two topmasts,
 * which is the hole it was added to fill in the first place. Its clew sheets
 * forward of the mainmast rather than aft to the main boom — a real one goes
 * aft, but a real one is cloth and can lie against the mainsail. This one is a
 * rigid surface, and a rigid surface that lies against another is a surface
 * that passes through it.
 */
/**
 * A point on the main topmast stay, by height.
 *
 * The fisherman's luff *is* this stay — that is what a staysail is, and the
 * first version floated it beside the stay instead of on it.
 */
function alongMainTopmastStay(y: number): RigPoint {
  const top = p(0, MAIN_TOPMAST_HEAD_Y, mainTopmastZAt(MAIN_TOPMAST_HEAD_Y));
  const foot = p(0, FORE_CAP_Y, mastZAt(FORE_AXIS, FORE_CAP_Y));
  const t = (MAIN_TOPMAST_HEAD_Y - y) / (MAIN_TOPMAST_HEAD_Y - FORE_CAP_Y);
  return p(0, y, top.z + (foot.z - top.z) * t);
}

const FISHERMAN_HEAD_Y = 21.0;
const FISHERMAN_TACK_Y = 15.7;
const FISHERMAN_HEAD = alongMainTopmastStay(FISHERMAN_HEAD_Y);
const FISHERMAN_TACK = alongMainTopmastStay(FISHERMAN_TACK_Y);

/**
 * The clew, brought **below its own tack** — where a clew goes.
 *
 * It was at 17.4, which is 1.7 m *above* the tack at 15.7. The handover recorded
 * that as a known oddity of the placeholder; Ash read it off the drawing as the
 * sail having no reason not to flop, and asked whether it only holds that shape
 * with wind in it. He is right, and the reason is legible: a sail whose foot
 * slopes *upward* from tack to clew has nothing pulling that corner down, and
 * the sheet dropping vertically past it was doing no work in the direction the
 * sail needs.
 *
 * At 13.9 the foot slopes down and aft from the tack, the sheet leads aft and
 * down to a station moved back to −5.2 to receive it, and the three corners
 * describe a sail that would set rather than one that happens to be drawn
 * inflated. The fisherman is still the roughest sail aboard — its luff occupies
 * only the upper part of its stay and a rigid surface cannot lie against the
 * foresail the way cloth does — but its corners are now in the right order.
 */
const FISHERMAN_CLEW_Y = 14.4;
const FISHERMAN_CLEW_Z = -2.2;
const FISHERMAN_CLEW = headsailClew(FISHERMAN_TACK, FISHERMAN_CLEW_Y, FISHERMAN_CLEW_Z, SHEET_FISHERMAN);

/**
 * The block on the mainmast its sheet leads to — abaft the clew and below it,
 * which is the direction a sheet has to pull.
 *
 * Forward face of the mast, so the fall does not lie inside the mainsail abaft
 * it. The clew is the sail's own corner, so the rope starts *on* the cloth
 * rather than near it — which is the other half of what Ash asked for.
 */
const FISHERMAN_SHEET_BLOCK_Y = 13.0;

/**
 * The main gaff topsail — the triangle that was missing over the mainsail.
 *
 * WHY IT IS HERE AT ALL
 * ---------------------
 * `docs/ship/SHIP_SPEC.md` section 7.1 listed six sails and this was not one of them.
 * Section 7.2 removes the square *main* topsail and gives the reason — square
 * topsails belong on the foremast — but a **gaff** topsail is a fore-and-aft
 * sail on the same stick and nothing excluded it. The result was five metres of
 * bare main topmast standing over the largest sail in the plan, and the biggest
 * remaining hole in the broadside silhouette. Every reference plan of the type
 * fills it. Section 7.1 is amended; see the note there.
 *
 * HOW A GAFF TOPSAIL IS CUT
 * -------------------------
 * Three corners, and each is held by something that already exists:
 *
 * - the **head** is hoisted up the topmast, stopping short of the truck because
 *   the halyard sheave, the topmast stay and both backstays are set up there;
 * - the **tack** is hauled down close to the gaff jaws, just above the
 *   mainsail's own throat;
 * - the **clew** is hauled out along the gaff toward the peak, so the sail's
 *   foot lies along the spar below it.
 *
 * That last one is what makes it a *gaff* topsail rather than a jib-headed one:
 * the gaff is its foot spar, so the sail is bound to the mainsail's trim and
 * swings with it. The clew stops short of the peak because the sheet reeves
 * through a block out there and needs somewhere to go.
 */
const MAIN_TOPSAIL_HEAD_Y = 21.4;

/**
 * The tack, hauled down close to the gaff jaws — which is where it belongs.
 *
 * IT SPENT A ROUND AT 15.35, ABOVE THE MASTHEAD, AND THAT WAS A MISREAD
 * ---------------------------------------------------------------------
 * The peak halyard runs from a span on the gaff to a block at the masthead, and
 * with the tack at the jaws the two are in the same swung plane: the halyard's
 * inboard end is 1.63 m above the sail's tack, so the rope lies *inside* the
 * sail's triangle for most of its length. Measured, not guessed — closest
 * approach 0.015 m against a rope of 0.012 m radius.
 *
 * The answer taken then was to tack the sail to the topmast above the cap, which
 * is a real cut (a topsail set flying) and put the whole halyard underneath the
 * foot. It also opened a wedge of daylight **2.35 m deep at the throat**, closing
 * to 0.03 m at the peak, and Ash's eye went straight to it against photographs
 * of the type: a working gaff topsail's foot lies along its gaff, and the gap is
 * the first thing that says a rig is wrong.
 *
 * WHY THE HALYARD WAS THE THING TO MOVE, AND WHY ONE END WAS NEVER ENOUGH
 * -----------------------------------------------------------------------
 * A previous attempt offset the masthead block 0.22 m to starboard and moved the
 * closest approach by 0.004 m. That is not evidence the halyard cannot be
 * moved — it is evidence that **moving one end of a chord tilts it and leaves
 * the middle where it was.** Swept properly, with the tack back at the jaws:
 *
 *     masthead block alone, 0.10 → 0.40 m to starboard    0.028 → 0.035 m
 *     gaff span alone, 0.06 → 0.18 m to starboard        0.010 → 0.009 m
 *     foot carried higher off the gaff, 0.3 → 0.6 m   0.014 → 0.024 m
 *     block 0.25 **and** span 0.12                    **0.094 m**
 *
 * Both ends together translate the whole run to starboard instead of pivoting it,
 * and
 * 0.094 m is eight times the rope's own radius. Physically that is the ordinary
 * arrangement and always was: **peak halyards are rigged on one side, and the
 * topsail bellies to the other.** See `PEAK_HALYARD_PORT`.
 *
 * The sail grows from 11.54 m² to 15.46 m² — 27% of the mainsail rather than
 * 20%, which is the proportion the type carries.
 */
const MAIN_TOPSAIL_TACK_Y = MAIN_THROAT_Y + 0.3;

/** How far out the gaff the clew is hauled, as a fraction of throat to peak. */
const MAIN_TOPSAIL_CLEW_ON_GAFF = 0.95;

/**
 * How far abaft the topmast's axis the luff is set up, metres.
 *
 * A gaff topsail is hoisted **abaft** its topmast — the hoops or hanks are on
 * the after side, because that is the side the sail is on. Putting the head and
 * tack on the axis instead would run the luff straight down the middle of the
 * timber, and the sail would need an exemption from the mast-crossing test to
 * pass. Section 3.3 of the handover is about what lives inside exemptions: the
 * square topsail had one on a very similar-sounding argument and it hid the
 * topmast piercing the cloth at two points.
 *
 * Here the argument would have been sound — a gaff topsail's luff genuinely is
 * attached along the stick, exactly as the mainsail's is to the mast below.
 *
 * AND THAT IS WHY 0.18 WAS WRONG
 * -------------------------------
 * Dodging the exemption bought a clean test and a **visible gap**: the topmast
 * is 0.088 m in radius at the tack, so the sail's lower corner hung 0.09 m off
 * the stick, holding onto nothing. Ash saw it straight away — *the triangle sail
 * above the main sail has no connection to the aft mast from its bottom tip.*
 *
 * A gaff topsail is hooped to its topmast. The cloth touches the stick, and the
 * honest thing is to say so and take the exemption, exactly as the mainsail
 * below it already does for the identical reason. **Avoiding an exemption is not
 * worth introducing a lie about where the sail is.** The luff sits on the
 * timber's after face, so the sail is bent to the mast and looks it.
 */
const MAIN_TOPSAIL_ABAFT_MAST = 0.085;

/**
 * How far the foot is carried clear of the gaff, metres.
 *
 * The clew is hauled out to the gaff and the foot lies along it — on a real
 * vessel, against it. Ours cannot: the mainsail's head *is* that gaff, so a foot
 * lying on the spar is a corner sitting exactly on another sail's edge, and the
 * two surfaces cross there. That is the fisherman's problem in miniature and the
 * same note applies — a rigid surface that lies against another is a surface
 * that passes through it. Carried clear, it reads as a sail bent to a jackstay,
 * which is also true.
 */
const MAIN_TOPSAIL_ABOVE_GAFF = 0.22;

/**
 * A point along the main gaff, by fraction from its jaws to its peak.
 *
 * Takes the whole gaff rather than its peak alone: once the hoist lowers the
 * spar, the jaws move too, and a fraction measured from a fixed throat would
 * slide every fitting on the gaff off it.
 */
function alongMainGaffAt(t: number, gaff: GaffPose): RigPoint {
  return p(
    gaff.throat.x + (gaff.peak.x - gaff.throat.x) * t,
    gaff.throat.y + (gaff.peak.y - gaff.throat.y) * t,
    gaff.throat.z + (gaff.peak.z - gaff.throat.z) * t,
  );
}

/** A point along the main gaff at the authored trim, fully hoisted. */
function alongMainGaff(t: number): RigPoint {
  return alongMainGaffAt(t, MAIN_GAFF);
}

const MAIN_TOPSAIL_HEAD = p(
  0,
  MAIN_TOPSAIL_HEAD_Y,
  mainTopmastZAt(MAIN_TOPSAIL_HEAD_Y) - MAIN_TOPSAIL_ABAFT_MAST,
);
const MAIN_TOPSAIL_TACK = p(
  0,
  MAIN_TOPSAIL_TACK_Y,
  mainTopmastZAt(MAIN_TOPSAIL_TACK_Y) - MAIN_TOPSAIL_ABAFT_MAST,
);
const MAIN_TOPSAIL_CLEW = {
  ...alongMainGaff(MAIN_TOPSAIL_CLEW_ON_GAFF),
  y: alongMainGaff(MAIN_TOPSAIL_CLEW_ON_GAFF).y + MAIN_TOPSAIL_ABOVE_GAFF,
};

// --- named points ------------------------------------------------------------

/**
 * Every attachment point the rig knows by name.
 *
 * Sails, standing rigging and running rigging address these rather than
 * carrying their own copies of a coordinate. The sails round bends real cloth
 * to the same names.
 */
export const RIG_NODES: Record<string, RigPoint> = {
  // mastheads and doublings
  mainStep: p(0, MAIN_STEP_Y, mastZAt(MAIN_AXIS, MAIN_STEP_Y)),
  mainHounds: p(0, MAIN_HOUNDS_Y, mastZAt(MAIN_AXIS, MAIN_HOUNDS_Y)),
  mainCap: p(0, MAIN_CAP_Y, mastZAt(MAIN_AXIS, MAIN_CAP_Y)),
  mainTopmastHead: p(0, MAIN_TOPMAST_HEAD_Y, mainTopmastZAt(MAIN_TOPMAST_HEAD_Y)),
  foreStep: p(0, FORE_STEP_Y, mastZAt(FORE_AXIS, FORE_STEP_Y)),
  foreHounds: p(0, FORE_HOUNDS_Y, mastZAt(FORE_AXIS, FORE_HOUNDS_Y)),
  foreCap: p(0, FORE_CAP_Y, mastZAt(FORE_AXIS, FORE_CAP_Y)),
  /**
   * Where a stay from aft actually lands on the foremast.
   *
   * Beside the mast, not on its axis. Both of these come from *aft*, and the
   * fore topmast is fidded aft of the lower mast (`TOPMAST_FID`), so a stay run
   * to the axis meets the topmast before it reaches the masthead and buries its
   * last 0.1 m inside it — visible from the deck as rope entering wood.
   *
   * Offsetting forward only makes it worse: then it crosses the topmast *and*
   * the lower mast. Sideways is the answer, and it is also what the ship does —
   * a stay's eye is seized round the masthead and the standing part leads to
   * one side of whatever is fidded there.
   */
  foreHoundsEye: p(-MASTHEAD_EYE_OFFSET, FORE_HOUNDS_Y, mastZAt(FORE_AXIS, FORE_HOUNDS_Y)),
  foreCapEye: p(-MASTHEAD_EYE_OFFSET, FORE_CAP_Y, mastZAt(FORE_AXIS, FORE_CAP_Y)),
  foreTopmastHead: p(0, FORE_TOPMAST_HEAD_Y, foreTopmastZAt(FORE_TOPMAST_HEAD_Y)),

  // head rig
  bowspritHeel: p(0, BOWSPRIT_HEEL_Y, BOWSPRIT_HEEL_Z),
  stemhead: STEMHEAD,
  /**
   * Where the bobstay lands on the stem — near the water, not on the stemhead.
   * Its whole job is to oppose the upward pull of the headsails, and it can only
   * do that with a long lever below the spar.
   */
  stemFoot: p(0, DESIGN_DRAUGHT + 0.85, HALF_LENGTH - 0.42),
  bowspritMid: JIB_TACK,
  bowspritEnd: p(0, BOWSPRIT_END_Y, BOWSPRIT_END_Z),

  // booms and gaffs
  mainGooseneck: p(0, MAIN_GOOSENECK_Y, MAIN_GOOSENECK_Z),
  mainBoomEnd: p(MAIN_BOOM_END.x, MAIN_BOOM_END_Y, MAIN_BOOM_END.z),
  /**
   * Where the main sheet is hooked to the boom — inboard of its end.
   *
   * A boom 7.8 m long sheeted 26° off the centreline has its end 3.8 m outboard
   * and 2 m abaft the transom, on a hull 2.3 m in half-breadth. A sheet from
   * *there* to a horse on the centreline crosses the quarter rail on the way in,
   * and it did: 57 mm inside the caprail's outer edge, which is what Ash saw
   * from the deck.
   *
   * Real ones are not hooked to the end either, and for this reason. The bail
   * goes well inboard, which brings the lead down inside the rail and also stops
   * the sheet trying to bend the boom's weakest section.
   *
   * 0.66 rather than the 0.74 this started at. The first attempt was measured
   * against the rope's *centreline*, along the straight line between its ends —
   * and a main sheet is 34 mm thick and sags 18% of its length, so it was still
   * 31 mm inside the caprail with the check reporting clear. Two-thirds along
   * the boom is where a bail goes anyway.
   */
  mainBoomSheetBlock: boomFraction(MAIN_GOOSENECK_Y, MAIN_GOOSENECK_Z, MAIN_BOOM_END, MAIN_BOOM_END_Y, MAIN_SHEET_BOOM_FRACTION),
  mainThroat: p(0, MAIN_THROAT_Y, MAIN_THROAT_Z),
  mainPeak: p(MAIN_PEAK.x, MAIN_PEAK.y, MAIN_PEAK.z),
  foreGooseneck: p(0, FORE_GOOSENECK_Y, FORE_GOOSENECK_Z),
  foreBoomEnd: p(FORE_BOOM_END.x, FORE_BOOM_END_Y, FORE_BOOM_END.z),
  foreThroat: p(0, FORE_THROAT_Y, FORE_THROAT_Z),
  forePeak: p(FORE_PEAK.x, FORE_PEAK.y, FORE_PEAK.z),

  // yards: the fixed lower yard, and the hoisting topsail yard above it
  lowerYardSling: LOWER_YARD.sling,
  lowerYardArmPort: LOWER_YARD.port,
  lowerYardArmStarboard: LOWER_YARD.starboard,
  topsailYardSling: TOPSAIL_YARD.sling,
  topsailYardArmPort: TOPSAIL_YARD.port,
  topsailYardArmStarboard: TOPSAIL_YARD.starboard,
  // The head is bent to the topsail yard, inside its arms. The clews are hauled
  // out along the lower yard and are the only things holding the foot — hence
  // the name: they take sheets, and the sheet test looks for exactly this word.
  topsailClothHeadPort: TOPSAIL_HEAD_CLOTH.port,
  topsailClothHeadStarboard: TOPSAIL_HEAD_CLOTH.starboard,
  topsailClewPort: TOPSAIL_CLEWS.port,
  topsailClewStarboard: TOPSAIL_CLEWS.starboard,

  // headsail heads and clews
  staysailHead: p(
    0,
    STAYSAIL_HEAD_Y,
    mastZAt(FORE_AXIS, STAYSAIL_HEAD_Y) + STAY_FORWARD_OF_MAST,
  ),
  jibStayHead: JIB_STAY_HEAD,
  flyingJibStayHead: FLYING_JIB_STAY_HEAD,
  jibHead: headsailHead(JIB_STAY_HEAD, JIB_TACK),
  flyingJibHead: headsailHead(FLYING_JIB_STAY_HEAD, FLYING_JIB_TACK),
  staysailClew: STAYSAIL_CLEW,
  jibClew: JIB_CLEW,
  flyingJibClew: FLYING_JIB_CLEW,

  // the fisherman, between the masts
  fishermanHead: FISHERMAN_HEAD,
  fishermanTack: FISHERMAN_TACK,
  fishermanClew: FISHERMAN_CLEW,
  /**
   * The block the fisherman's sheet turns through, on the mainmast.
   *
   * On the mast's **starboard cheek**, not dead ahead of it. Centred, the fall it
   * leads to had to cross the mast to reach any pin on the rail abaft it, and
   * did — 0.1 m inside the stick. A cheek block is what a real one is, and which
   * cheek is a choice: starboard, the same side the halyard falls come down, which is
   * the side the sails are not on.
   */
  fishermanSheetBlock: p(
    -0.24,
    FISHERMAN_SHEET_BLOCK_Y,
    mastZAt(MAIN_AXIS, FISHERMAN_SHEET_BLOCK_Y) + 0.1,
  ),

  // the main gaff topsail, over the mainsail
  mainTopsailHead: MAIN_TOPSAIL_HEAD,
  mainTopsailTack: MAIN_TOPSAIL_TACK,
  mainTopsailClew: MAIN_TOPSAIL_CLEW,
};

/** A point a fraction of the way from a boom's gooseneck to its end. */
function boomFraction(
  heelY: number,
  heelZ: number,
  end: { x: number; z: number },
  endY: number,
  fraction: number,
): RigPoint {
  return p(end.x * fraction, heelY + (endY - heelY) * fraction, heelZ + (end.z - heelZ) * fraction);
}

export function rigNode(name: string): RigPoint {
  const node = RIG_NODES[name];
  if (!node) throw new Error(`rig: no such node "${name}"`);
  return node;
}

// --- spars -------------------------------------------------------------------

function yardSpars(
  name: string,
  arms: { port: RigPoint; starboard: RigPoint; sling: RigPoint },
  scale = 1,
): Spar[] {
  return [
    {
      name: `${name}Port`,
      heel: arms.sling,
      head: arms.port,
      heelRadius: YARD_R_SLING * scale,
      headRadius: YARD_R_ARM * scale,
    },
    {
      name: `${name}Starboard`,
      heel: arms.sling,
      head: arms.starboard,
      heelRadius: YARD_R_SLING * scale,
      headRadius: YARD_R_ARM * scale,
    },
  ];
}

export const SPARS: readonly Spar[] = [
  {
    name: 'mainmast',
    heel: rigNode('mainStep'),
    head: rigNode('mainCap'),
    heelRadius: MAINMAST_R_PARTNERS,
    headRadius: MAINMAST_R_HEAD,
  },
  {
    name: 'mainTopmast',
    heel: p(0, MAIN_HOUNDS_Y - 0.55, mainTopmastZAt(MAIN_HOUNDS_Y - 0.55)),
    head: rigNode('mainTopmastHead'),
    heelRadius: TOPMAST_R_HEEL,
    headRadius: TOPMAST_R_HEAD,
  },
  {
    name: 'foremast',
    heel: rigNode('foreStep'),
    head: rigNode('foreCap'),
    heelRadius: FOREMAST_R_PARTNERS,
    headRadius: FOREMAST_R_HEAD,
  },
  {
    name: 'foreTopmast',
    heel: p(0, FORE_HOUNDS_Y - 0.55, foreTopmastZAt(FORE_HOUNDS_Y - 0.55)),
    head: rigNode('foreTopmastHead'),
    heelRadius: TOPMAST_R_HEEL,
    headRadius: TOPMAST_R_HEAD,
  },
  {
    name: 'bowsprit',
    heel: rigNode('bowspritHeel'),
    head: rigNode('bowspritEnd'),
    heelRadius: BOWSPRIT_R_HEEL,
    headRadius: BOWSPRIT_R_HEAD,
  },
  {
    name: 'mainBoom',
    heel: rigNode('mainGooseneck'),
    head: rigNode('mainBoomEnd'),
    heelRadius: BOOM_R_MID,
    headRadius: BOOM_R_END,
  },
  {
    name: 'mainGaff',
    heel: rigNode('mainThroat'),
    head: rigNode('mainPeak'),
    heelRadius: GAFF_R_THROAT,
    headRadius: GAFF_R_PEAK,
  },
  {
    name: 'foreBoom',
    heel: rigNode('foreGooseneck'),
    head: rigNode('foreBoomEnd'),
    heelRadius: BOOM_R_MID,
    headRadius: BOOM_R_END,
  },
  {
    name: 'foreGaff',
    heel: rigNode('foreThroat'),
    head: rigNode('forePeak'),
    heelRadius: GAFF_R_THROAT,
    headRadius: GAFF_R_PEAK,
  },
  // The lower yard is the heavier stick: it is fixed, it takes the topsail's
  // sheets at its arms, and it is the long horizontal that reads as square rig
  // from a mile off. The topsail yard hoists, so it is lighter.
  ...yardSpars('lowerYard', LOWER_YARD, 1.15),
  ...yardSpars('topsailYard', TOPSAIL_YARD, 0.9),
];

// --- crosstrees and tops -----------------------------------------------------

/**
 * The trestletrees and crosstrees at each hounds.
 *
 * Structural, not dressing: they are what the topmast is fidded between and what
 * the topmast shrouds spread to. `docs/ship/SHIP_SPEC.md` section 5 also wants a "modest
 * foremast lookout", which is this platform at the fore — M5 stands on it.
 *
 * THE TOP GOES ABAFT THE MAST, AND IT HAD TO BE TOLD TO
 * -----------------------------------------------------
 * These were centred on the mast, so the fore top projected 0.72 m *forward* of
 * the axis — straight through the square topsail, whose cloth stands only 0.36 m
 * forward. Ash saw it as **wood coming out of the front of the sail from
 * behind**, which is exactly what it was: the platform's leading edge, 0.29 m
 * proud of the cloth.
 *
 * Nothing caught it because every intersection test in `ship-rig.test.ts`
 * checked sails against `SPARS`, and the tops are not spars — they are their own
 * list. A whole category of solid object was outside the coverage. There is a
 * test for it now.
 *
 * The fix is also the truth: a top exists to carry the topmast, and on a
 * fore-and-aft rig the topmast is fidded **abaft** the lower mast
 * (`TOPMAST_FID`). So the trestletrees reach aft to hold it, and forward only far
 * enough to seat on the hounds. `FORWARD_OF_MAST` below is what a real one
 * projects ahead of the stick, and it is small.
 */
const TOP_FORWARD_OF_MAST = 0.12;

/** Centre a top so it reaches `TOP_FORWARD_OF_MAST` ahead of its own mast. */
function topCentreZ(axis: MastAxis, y: number, length: number): number {
  return mastZAt(axis, y) + TOP_FORWARD_OF_MAST - length * 0.5;
}
export interface Crosstrees {
  name: string;
  y: number;
  z: number;
  halfSpan: number;
  length: number;
  thickness: number;
}

export const CROSSTREES: readonly Crosstrees[] = [
  {
    name: 'mainCrosstrees',
    y: MAIN_HOUNDS_Y,
    z: topCentreZ(MAIN_AXIS, MAIN_HOUNDS_Y, 0.6),
    halfSpan: 0.62,
    length: 0.6,
    thickness: 0.085,
  },
  {
    // Wider at the fore: this one is the lookout, and section 5.4 does the
    // arithmetic on what standing here costs in a seaway.
    name: 'foreCrosstrees',
    y: FORE_HOUNDS_Y,
    z: topCentreZ(FORE_AXIS, FORE_HOUNDS_Y, 0.7),
    halfSpan: 0.85,
    length: 0.7,
    thickness: 0.09,
  },
];

/**
 * The proportions a top's members are drawn at, as fractions of `thickness`.
 *
 * **These were six literals inside `rigGeometry.addCrosstreeSet`, and M5 is what
 * made that a fault rather than a shorthand.** A lookout platform is planking
 * laid *on* the crosstree arms, so where its walking surface is is decided by
 * how high the arms stand — a number that lived only inside the loft. Copying
 * `thickness * 0.9 + thickness * 0.55` into the platform would have been the
 * two-sources-for-one-fact fault this hull has paid for six times, with the
 * particular twist that the second copy is a *floor* and the drift would be a
 * body standing in the air or inside the timber.
 *
 * The values are exactly what the loft drew before; `ship-rig.test.ts` measures
 * the drawn triangles, so a slip here is not a matter of trust.
 */
export const TOP_PROPORTIONS = Object.freeze({
  /** How far off the centreline each trestletree stands. */
  trestleOffset: 1.6,
  /** Half-breadth of a trestletree. */
  trestleHalfBreadth: 1.0,
  /** Half-depth of a trestletree — it is thicker than it is wide. */
  trestleHalfHeight: 0.7,
  /** How far above the top's own y the crosstree arms are laid. */
  armRise: 0.9,
  /** Half-thickness of an arm. */
  armHalfHeight: 0.55,
  /** Half-length of an arm, fore-and-aft. */
  armHalfDepth: 0.8,
  /** How far each arm sits from the top's centre, as a fraction of `length`. */
  armInsetOfLength: 0.3,
});

/**
 * Where each crosstree arm's centre lies, fore-and-aft.
 *
 * Two arms, after first. The order is the fact a platform needs: its after edge
 * is the after arm's after face, because planking is carried by the beams under
 * it and does not hang past the last one.
 */
export function crosstreeArmZ(top: Crosstrees): readonly [number, number] {
  const inset = top.length * TOP_PROPORTIONS.armInsetOfLength;
  return [top.z - inset, top.z + inset];
}

/**
 * Upper surface of a top's crosstree arms — what a platform is laid on.
 *
 * Not `top.y`. The arms stand proud of the trestletrees, and `top.y` is the
 * height of the *trestletrees'* centreline. Ask this, never the difference.
 */
export function crosstreeArmTopY(top: Crosstrees): number {
  return top.y + top.thickness * (TOP_PROPORTIONS.armRise + TOP_PROPORTIONS.armHalfHeight);
}

/** Underside of the same arms — the clearance a swinging gaff has to keep. */
export function crosstreeArmUnderY(top: Crosstrees): number {
  return top.y + top.thickness * (TOP_PROPORTIONS.armRise - TOP_PROPORTIONS.armHalfHeight);
}

/** One top by name. Throws rather than returning undefined into arithmetic. */
export function crosstrees(name: string): Crosstrees {
  const found = CROSSTREES.find((top) => top.name === name);
  if (!found) throw new Error(`rig has no top named ${name}`);
  return found;
}

// --- standing rigging --------------------------------------------------------

export type RiggingKind =
  | 'shroud'
  | 'stay'
  | 'backstay'
  | 'bobstay'
  | 'sheet'
  | 'halyard'
  | 'lift'
  | 'brace';

/**
 * One run of standing rigging, named end to named end.
 *
 * `from` and `to` are node names — never coordinates. That is the whole point of
 * the graph: a rope cannot be left hanging in space by a spar that moved.
 */
export interface RiggingRun {
  name: string;
  from: string;
  to: string;
  kind: RiggingKind;
  diameter: number;
}

export interface ChannelSeat {
  name: string;
  x: number;
  y: number;
  z: number;
}

/**
 * How far the channels project beyond the hull, metres — measured from the hull
 * surface at the channel's own height.
 *
 * The first version measured from `maxHalfBeamAt`, which is the section's widest
 * point down at y = 2.62, a third of a metre below the water. Up at the sheer the
 * hull has narrowed and tumbled home, so the channels came out 0.58 m clear of
 * the ship: planks floating in the air alongside her, with the chain plates
 * hanging off them into nothing.
 */
const CHANNEL_PROJECTION = 0.34;

/** Half-breadth of the hull at `z`, at height `y` — the surface a fitting lands on. */
function hullSideAt(z: number, y: number): number {
  return halfBreadthAt(z, y);
}

/**
 * Height of the channel: just below the sheer, and below the bulwark rather than
 * on it. The shrouds then lead up *outside* the bulwark, which is what gives
 * them their spread and what stops the deadeyes reading as posts on the rail.
 */
function channelY(z: number): number {
  return deckAtSideY(z) - 0.12;
}

/** Height on the topside where a chain plate bolts home. */
function chainPlateFootY(z: number): number {
  return deckAtSideY(z) - 0.55;
}

/** Deadeye spacing along a channel, metres. */
const DEADEYE_SPACING = 0.38;

const MAIN_SHROUD_PAIRS = 3;
const FORE_SHROUD_PAIRS = 3;

function channelSeats(
  mastName: string,
  mastZ: number,
  pairs: number,
  side: 1 | -1,
): ChannelSeat[] {
  const seats: ChannelSeat[] = [];
  // The channel sits just abaft the mast and runs aft: shrouds lead aft of the
  // mast they support, which is what stops them fouling the gaff as it swings.
  const first = mastZ - 0.55;
  for (let i = 0; i < pairs; i++) {
    const z = first - i * DEADEYE_SPACING;
    const y = channelY(z);
    const x = side * (hullSideAt(z, y) + CHANNEL_PROJECTION);
    seats.push({
      name: `${mastName}Channel${side > 0 ? 'Port' : 'Starboard'}${i}`,
      x,
      y,
      z,
    });
  }
  return seats;
}

export const CHANNEL_SEATS: readonly ChannelSeat[] = [
  ...channelSeats('main', MAINMAST_Z, MAIN_SHROUD_PAIRS, 1),
  ...channelSeats('main', MAINMAST_Z, MAIN_SHROUD_PAIRS, -1),
  ...channelSeats('fore', FOREMAST_Z, FORE_SHROUD_PAIRS, 1),
  ...channelSeats('fore', FOREMAST_Z, FORE_SHROUD_PAIRS, -1),
];

for (const seat of CHANNEL_SEATS) {
  RIG_NODES[seat.name] = p(seat.x, seat.y, seat.z);
}

/** Where a seat's chain plate bolts to the topside — on the hull, not beside it. */
export function chainPlateFoot(seat: ChannelSeat): RigPoint {
  const y = chainPlateFootY(seat.z);
  return p(Math.sign(seat.x) * hullSideAt(seat.z, y), y, seat.z);
}

/** Where the channel plank meets the hull, inboard of the seat. */
export function channelRoot(seat: ChannelSeat): RigPoint {
  return channelRootAt(seat.z, Math.sign(seat.x) as 1 | -1);
}

/**
 * Where a swept channel plank meets the hull at an arbitrary station.
 *
 * The deadeyes provide only three authored seats, while the plank extends past
 * both end seats. Its inner edge therefore has to ask the hull at every segment
 * rather than hold the narrowest seat's x for the whole run. The latter buried
 * the forward half through the lining deeply enough to be visible from the
 * wardroom and landing.
 */
export function channelRootAt(z: number, side: 1 | -1): RigPoint {
  const y = channelY(z);
  return p(side * hullSideAt(z, y), y, z);
}

const SHROUD_DIAMETER = 0.036;
const STAY_DIAMETER = 0.044;

function shroudRuns(mastName: string, pairs: number): RiggingRun[] {
  const runs: RiggingRun[] = [];
  for (const side of ['Port', 'Starboard'] as const) {
    for (let i = 0; i < pairs; i++) {
      runs.push({
        name: `${mastName}Shroud${side}${i}`,
        from: `${mastName}Channel${side}${i}`,
        to: `${mastName}Hounds`,
        kind: 'shroud',
        diameter: SHROUD_DIAMETER,
      });
    }
  }
  return runs;
}

export const STANDING_RIGGING: readonly RiggingRun[] = [
  ...shroudRuns('main', MAIN_SHROUD_PAIRS),
  ...shroudRuns('fore', FORE_SHROUD_PAIRS),

  // Three headsails need three stays, stacked outward along the bowsprit and
  // upward on the fore rigging — the arrangement that makes the staysail, jib
  // and flying jib a fan rather than three sails in one place.
  {
    name: 'foreStay',
    from: 'staysailHead',
    to: 'stemhead',
    kind: 'stay',
    diameter: STAY_DIAMETER,
  },
  {
    name: 'jibStay',
    from: 'jibStayHead',
    to: 'bowspritMid',
    kind: 'stay',
    diameter: STAY_DIAMETER,
  },
  {
    name: 'flyingJibStay',
    from: 'flyingJibStayHead',
    to: 'bowspritEnd',
    kind: 'stay',
    diameter: STAY_DIAMETER * 0.85,
  },
  /**
   * The spring stay — mainmast head to foremast head.
   *
   * This is what stays the mainmast forward on a two-masted schooner, and the
   * reason there is no lower main stay running down to the foremast's foot: that
   * run would pass straight through the foresail, which occupies the whole space
   * between the two masts.
   */
  {
    name: 'springStay',
    from: 'mainHounds',
    to: 'foreHoundsEye',
    kind: 'stay',
    diameter: STAY_DIAMETER,
  },
  /**
   * The main topmast stay — down and *forward* to the foremast head.
   *
   * It ran truck to truck, main topmast head to fore topmast head, which is
   * very nearly horizontal at the very top of the rig and is not a thing any
   * schooner does. A stay's job is to resist the mast being pulled aft, and a
   * horizontal one has almost no leverage to do it with; it also looks like a
   * washing line strung between two poles. Real ones run diagonally down to the
   * foremast head, which is where this one goes now — and it is the stay the
   * main topmast staysail is bent to, so the sail rides on it rather than
   * floating beside it.
   *
   * The spring stay below, between the two lower mastheads, is the horizontal
   * one and is correct: it is a strut in compression between the mastheads,
   * a different job entirely.
   */
  {
    name: 'mainTopmastStay',
    from: 'mainTopmastHead',
    to: 'foreCapEye',
    kind: 'stay',
    diameter: STAY_DIAMETER * 0.85,
  },

  // Backstays take the pull of the topmasts aft, to the channels' after ends.
  {
    name: 'mainBackstayPort',
    from: 'mainTopmastHead',
    to: `mainChannelPort${MAIN_SHROUD_PAIRS - 1}`,
    kind: 'backstay',
    diameter: SHROUD_DIAMETER,
  },
  {
    name: 'mainBackstayStarboard',
    from: 'mainTopmastHead',
    to: `mainChannelStarboard${MAIN_SHROUD_PAIRS - 1}`,
    kind: 'backstay',
    diameter: SHROUD_DIAMETER,
  },
  {
    name: 'foreBackstayPort',
    from: 'foreTopmastHead',
    to: `foreChannelPort${FORE_SHROUD_PAIRS - 1}`,
    kind: 'backstay',
    diameter: SHROUD_DIAMETER,
  },
  {
    name: 'foreBackstayStarboard',
    from: 'foreTopmastHead',
    to: `foreChannelStarboard${FORE_SHROUD_PAIRS - 1}`,
    kind: 'backstay',
    diameter: SHROUD_DIAMETER,
  },

  // The bobstay holds the bowsprit *down* against the lift of the headsails.
  // Without it the head rig is a lever with nothing opposing it, and its absence
  // is one of the things that reads as wrong before anyone can say why.
  {
    name: 'bobstay',
    from: 'bowspritEnd',
    to: 'stemFoot',
    kind: 'bobstay',
    diameter: STAY_DIAMETER,
  },
];

// --- running rigging ---------------------------------------------------------

/**
 * The ropes that work the sails, as opposed to the ones that hold the masts up.
 *
 * `docs/ship/SHIP_SPEC.md` section 7.4 asks for these by name and sets the standard:
 * *"Every important rope connects functional components. Do not scatter
 * decorative ropes."* The first version of this rig had none of them, and the
 * result was a set of sails hanging in trimmed positions with nothing visibly
 * holding them there — most obviously at the clews, the free after corners,
 * which had no sheet on them at all. A clew with nothing on it does not hold a
 * shape; it flogs.
 *
 * So every line here runs between two things that exist. A sheet starts at a
 * clew and ends at a lead on the rail. A topping lift starts at a boom end and
 * ends at the masthead that carries it. Nothing is here because rope looks good.
 */

/**
 * THE WALL WAS DESCRIBED TWICE, AND THIS FILE HAD THE WRONG COPY
 * --------------------------------------------------------------
 * There used to be an `inboardFaceAt()` here that returned
 * `halfBreadthAt(z, deck) − 0.14`: a hardcoded stand-in for the bulwark, taken
 * at *deck* height. The real wall is 0.09 m thick, keeps tumbling home as it
 * rises, and is capped by a rail 0.07 m proud of `bulwarkTopY` that overhangs
 * 0.028 m on each side — all of which lived in `shipGeometry.ts` where nothing
 * outside the loft could read it.
 *
 * So every fitting on the rail was placed against a wall that was not there.
 * Fairleads ended up *inside* the caprail's timber, falls emerged from the
 * planking, and the pin rails stood off the face they are bolted to. Ash
 * reported it four separate times, in four different words, and each round I
 * moved the fitting a few centimetres instead of asking why the ship disagreed
 * with itself about where its own side was.
 *
 * `railSection()` in `hullForm.ts` is the single description now. Nothing in
 * this file guesses at the hull any more.
 */

/**
 * Where a sheet turns over the rail — a fairlead **on top of the caprail**.
 *
 * A sheet does not end at the ship's side. It comes in from the clew, turns
 * through a sheave or a bullseye on the rail, and runs on to something a hand
 * can reach. The first version stopped the rope dead at the outer edge of the
 * bulwark, which is a rope disappearing into the planking.
 *
 * IT WAS STILL GOING THROUGH THE PLANKING, ONE STEP FURTHER IN
 * ------------------------------------------------------------
 * The fix for that put the fairlead at the bulwark's **inboard** face and 0.06 m
 * *below* its top — that is, inside the ship and under the rail. Every headsail
 * clew is sheeted outboard of the bulwark, so the straight line from clew to
 * fairlead entered the planking from outside and came out inside it. The rope
 * ended at a thing, and got there by passing through a solid wall.
 *
 * The turn is on the crown of the rail now, so the rope comes in from outboard,
 * over the top, and down to its pin — which is what a fairlead on a rail is and
 * what makes the run legible without any tracing. **Ash caught this by eye.**
 *
 * AND THEN IT WENT THROUGH THE PLANKING A THIRD TIME
 * ---------------------------------------------------
 * Putting the turn at the *middle* of the rail's width fixed the run coming in
 * from the clew and broke the one going on to the pin: the fall descends from
 * the crown to a pin inboard of the wall, so starting it half a rail-width
 * outboard drove it back through the inner face, 0.060 m deep. Ash checked and
 * it was still wrong.
 *
 * **The verification was the actual failure.** The check written to prove this
 * fixed only matched runs whose names ended in `Sheet`, and every one of these
 * ropes has a second half named `SheetFall`. It reported "passes entirely above
 * the rail" for a set of ropes it had never looked at. A test that silently
 * covers less than it claims is worse than no test, which is section 3 of the
 * handover almost verbatim — and this time I wrote it.
 *
 * The turn is at the rail's **inboard edge**: outboard of it the rope is above
 * the crown, inboard of it the rope is inside the ship, and neither half touches
 * timber. `ship-rig.test.ts` now sweeps *every* run against the bulwark solid
 * rather than a name-matched subset.
 */
function sheetFairlead(z: number, side: 1 | -1 = 1): RigPoint {
  const rail = railSection(z);
  // On the caprail's inboard edge. Outboard of this the rope is above the rail;
  // inboard of it the rope is inside the ship. It is the one line on the whole
  // section where a turn touches timber without either half entering it.
  return p(side * rail.capInnerX, rail.capY, z);
}

/**
 * Where it is finally made fast: a belaying pin on the pin rail, inside the
 * bulwark and a little abaft the fairlead.
 *
 * This is the end of the rope's journey and the reason the rope exists — every
 * working line on her ends at a pin a crew member can throw off in a hurry.
 */
function sheetPin(z: number, side: 1 | -1 = 1): RigPoint {
  const zPin = z - 0.55;
  const rail = railSection(zPin);
  // On the pin's own axis — 0.045 in from the planking, which is where
  // `rigGeometry.ts` seats the belaying pins — so the rope ends *on* the pin
  // rather than a centimetre beside it. Both read `railSection` at this z, so
  // both follow the bow's curve together.
  return p(side * (rail.innerX - 0.045), rail.capY - 0.42, zPin);
}

/**
 * The fife rail: a timber on stanchions abaft each mast, carrying the pins the
 * halyards belay to.
 *
 * Every mast needs one. A halyard is hauled by several hands and then made fast
 * within reach of the mast it serves, and this is the thing it is made fast to.
 */
export interface FifeRail {
  name: string;
  z: number;
  y: number;
  halfSpan: number;
  pins: number;
}

/**
 * How high the rail's board rides above the deck at its own station, metres.
 *
 * Exported for the reason `HORSE_SAG` is: the loft has to put the stanchions'
 * feet on the planking, and a dimension only the placement knows is a dimension
 * the loft will guess at. It guessed 1.02 and was 0.15 m out.
 */
export const FIFE_HEIGHT_ABOVE_DECK = 0.94;

/**
 * Half the fife rail's width.
 *
 * 0.45, down from 0.72. The complaint was never the pin count — it was the
 * footprint: a 1.44 m board on stanchions, athwart a deck 4.5 m wide at that
 * station, in the one place people have to pass the mast. 0.90 m of rail still
 * carries four pins with room for a made-up coil on each, and gives back 0.54 m
 * of gangway. The stanchions move with it, because they are placed from this.
 */
const FIFE_HALF_SPAN = 0.45;

/** How far in from the board's end its stanchion stands. */
const FIFE_STANCHION_INSET = 0.09;
/** Clear air between the outermost pin and the stanchion beside it. */
const FIFE_PIN_STANCHION_GAP = 0.13;
/** How far off the centreline the innermost pin sits. */
const FIFE_PIN_INBOARD_MARGIN = 0.1;

/** How far abaft its mast a fife rail stands, when there is deck for it. */
const FIFE_ABAFT_MAST = 0.62;

/**
 * How far forward of its mast a rail stands when it cannot go abaft.
 *
 * Closer than the 0.62 abaft, and both bounds are real: the board's own 0.06 m
 * of half-siding plus the mast's 0.141 m collider leaves 0.10 m of daylight at
 * 0.30, and going further forward walks the rail into the bilge pump at z=-1.35.
 */
const FIFE_FORWARD_MAST = 0.3;

/**
 * The after limit for a rail on `level`: its own end, or the head of a stair.
 *
 * A flight of steps is not deck you can put a fitting on top of, even though
 * `deckStandAt` will happily report a height there — that is the same question
 * the room deckheads had to stop asking. So a rail's "is there room abaft the
 * mast" test is against the timber, not against the walking surface.
 */
function railAfterLimit(level: DeckLevel): number {
  let limit = level.z0;
  for (const stair of DECK_STAIRS) {
    const top = Math.min(stair.zTop, stair.zBottom);
    const bottom = Math.max(stair.zTop, stair.zBottom);
    if (bottom < level.z0 || top > level.z1) continue;
    limit = Math.max(limit, bottom);
  }
  return limit;
}

/**
 * A fife rail stands by its mast, on the deck the mast is on.
 *
 * THE RULE, AND THE TRAP IT CLOSES
 * --------------------------------
 * This was `partnerZ - 0.62` flat. Abaft is the right instinct — a gaff
 * mainsail's throat and peak halyards fall abaft the mast and are made fast
 * within reach of it, and the fore rail sits there still. But the mainmast
 * stands 0.50 m forward of the quarterdeck break, so 0.62 m abaft of it is
 * **over the break, on the deck above**, and that is where the main rail was
 * put: on the quarterdeck, 1.2 m from the mast it serves and up a 0.55 m step
 * from it.
 *
 * Nothing looked wrong, because a pin rail is a plausible object on any deck.
 * What it actually did was seal the companionway. M4's furnishing slice moved
 * the ladder's head forward to z = -3.00, which left the rail 0.48 m ahead of a
 * body climbing out of the hatch, with the coamings either side and the hole
 * behind: **you could get up the ladder and you could not get off it.** Ash
 * found it by trying to walk out of his own ship.
 *
 * WHY FORWARD, AND NOT SIMPLY BACK ONTO THE WAIST DECK
 * ---------------------------------------------------
 * Because the waist deck abaft the mainmast is a staircase. The quarterdeck
 * ladders run the full width from x = 0.40 outboard between z = -2.40 and
 * -1.84, and the mast itself stands in the 0.80 m channel between them. A
 * 0.90 m board anywhere in that band lands on the flights and closes the way
 * up — which is what the first attempt at this fix did, and what
 * `ship-deck.test.ts` caught within a minute of it landing.
 *
 * So the main rail goes 0.30 m *forward* of its mast, in the open waist, with
 * the pump beside it: the working cluster round the mainmast that
 * `SHIP_BELOW_DECKS_PLAN.md` section 4.3 describes from the other side of the
 * deck. The centreline route aft now ends at the rail and you pass it either
 * side, which is what you do with a fife rail.
 *
 * The height comes from the level rather than from `walkingDeckY(z)` alone: the
 * two differ by exactly the level's rise, which is the 0.55 m this is about.
 */
function fifeRailFor(axis: MastAxis, name: string): FifeRail {
  const level = deckLevelAt(axis.partnerZ);
  const abaft = axis.partnerZ - FIFE_ABAFT_MAST;
  const z = abaft >= railAfterLimit(level) ? abaft : axis.partnerZ + FIFE_FORWARD_MAST;
  if (z < level.z0 || z > level.z1) {
    throw new Error(`fife rail ${name} at z=${z.toFixed(2)} is off the ${level.name} deck`);
  }
  return {
    name,
    z,
    y: levelWalkingY(z, level) + FIFE_HEIGHT_ABOVE_DECK,
    halfSpan: FIFE_HALF_SPAN,
    pins: 2,
  };
}

export const FIFE_RAILS: readonly FifeRail[] = [
  fifeRailFor(MAIN_AXIS, 'mainFife'),
  fifeRailFor(FORE_AXIS, 'foreFife'),
];

/**
 * A named pin on a fife rail: `index` counts outboard from the centreline on the
 * given side, 0 being the innermost.
 *
 * **`side` did not mean side.** It multiplied an offset that was already signed
 * — `spacing * (index + 1) − halfSpan`, negative for the inboard half of the
 * rail — so `side: -1` on an inboard index returned a pin to *port*. The
 * halyard falls carry a comment saying they belay to starboard, the weather side,
 * "because everything is sheeted to port and a fall hanging down the lee
 * side would lie inside the sails". They were on the port side, hanging
 * exactly there: both fell through the main boom, and the fisherman's fall
 * through the mainmast as well. That is the fault Ash saw from the deck.
 *
 * Same family as `Sail.side`, whose old doc literally read "+1 to starboard"
 * (a pre-W1 mirrored-label wording; today's labels would say port) and bellied
 * every fore-and-aft sail to windward. A sign is not a side until something
 * checks it.
 *
 * The spacing is a fraction of the **half**-span, per side. Spacing it by the
 * full span instead put the outer pin at 0.96 m on a rail whose timber stops at
 * 0.72 — a belaying pin standing in mid-air, which is what Ash saw next.
 */
export function fifePinX(rail: FifeRail, index: number, side: 1 | -1): number {
  // Spread between the centreline and the stanchion, not out to the board's
  // end. A pin is a thing you take three turns of rope around and then coil the
  // rest onto — it needs a hand's width of clear air beside it, and the outer
  // pin had 60 mm to the stanchion, which is not enough to get a fist into.
  const inner = FIFE_PIN_INBOARD_MARGIN;
  const outer = fifeStanchionX(rail, 1) - FIFE_PIN_STANCHION_GAP;
  const span = Math.max(outer - inner, 0.05);
  return side * (inner + (span * index) / Math.max(rail.pins - 1, 1));
}

/** Where a fife rail's stanchion stands, from the board's own half-span. */
export function fifeStanchionX(rail: FifeRail, side: 1 | -1): number {
  return side * (rail.halfSpan - FIFE_STANCHION_INSET);
}

function fifePin(rail: FifeRail, index: number, side: 1 | -1): RigPoint {
  return p(fifePinX(rail, index, side), rail.y + 0.1, rail.z);
}

/**
 * The sheet horse: an iron bar arched across the deck that a boom's sheet block
 * travels on.
 *
 * Without it the main sheet ends at a point in the air over the planking. The
 * horse is what lets the boom swing from one side to the other without anyone
 * handing the sheet across, and it is a conspicuous piece of deck ironwork.
 */
export interface SheetHorse {
  name: string;
  z: number;
  y: number;
  halfSpan: number;
}

/**
 * How far the bar dips at midspan, metres.
 *
 * A horse is arched — higher at its ends — so the block does not have to climb
 * as the boom swings out. **This lived only inside `rigGeometry.ts` as a number
 * in a lambda**, which meant nothing that reasoned about where the bar *is*
 * could see it, and the sheet's turning point was placed as though the bar were
 * straight. Exported now, and both the loft and the block read it.
 */
export const HORSE_SAG = 0.07;

/** Radius of the bar itself, metres. */
export const HORSE_RADIUS = 0.022;

/**
 * A horse stands on the deck where it *is*, not on the deck of the station it
 * shares a number with.
 *
 * This read `walkingDeckY(z)`, which answers for a parameter station, against a
 * `z` that is a placed position — the counter's shear then carried the deck up
 * to 0.79 m aft of the station under the main horse, and its feet were buried
 * 33 mm in the planking. It is the same blind spot the first slice of M3 found in
 * the rope-versus-hull check and in the bulwark check: over the counter, where a
 * thing is is not the station it belongs to. `deckStandAt` takes a placed
 * position and inverts the rake, which is exactly the question being asked.
 *
 * The height is taken at the horse's **feet** rather than on the centreline,
 * because that is where the iron meets the timber and the deck is crowned 90 mm
 * across its half-breadth.
 */
function horseAt(z: number, name: string, halfSpan: number): SheetHorse {
  const foot = deckStandAt(halfSpan, z);
  if (!foot) throw new Error(`sheet horse ${name} stands off the deck at z=${z}`);
  return { name, z, y: foot.y + 0.34, halfSpan };
}

/**
 * Half-spans are set by the deck, not by the boom.
 *
 * The main horse started at ±1.15 m on a quarterdeck only ±1.32 m wide inboard
 * of the bulwark — 0.17 m of gangway each side, which is not a gangway. A horse
 * is shin-high and meant to be stepped over, but it should not span the ship.
 *
 * THE MAIN HORSE IS RIGHT AFT BECAUSE THE TILLER IS NOT
 * -----------------------------------------------------
 * It was at z = -7.0, which is 0.35 m forward of where the rudder stock comes
 * up through the counter — so it stood in the middle of the tiller's sweep. The
 * bar itself would have passed under by 35 mm; the traveller block that rides it
 * would not, because the block hangs its sheave 0.13 m above the bar and the
 * tiller's underside is 0.35 m over the planking there. Anything a helmsman
 * swings would have struck it on the first turn of the wheel she does not have.
 *
 * Abaft the rudder head is where a tiller-steered gaff vessel puts her main
 * horse anyway: across the counter, clear of the helm, with the sheet dropping
 * to it from a boom that overhangs the transom by two metres. It is the tiller
 * that has the prior claim on the quarterdeck — `docs/ship/SHIP_SPEC.md` section 8 is
 * explicit that the tiller "must sweep a mechanically plausible arc and occupy
 * real working space" — and the horse is the thing with somewhere else to be.
 *
 * `ship-deck.test.ts` holds the arc clear of every solid aboard, so this cannot
 * quietly come back.
 */
export const SHEET_HORSES: readonly SheetHorse[] = [
  // 0.62 rather than the 0.72 it carried amidships of the rudder head. The
  // counter is 1.17 m in half-breadth where it stands now against 1.27 m where
  // it stood before, and the same bar there would have left 0.45 m to the
  // planking — the gangway rule's own threshold, met by three millimetres.
  horseAt(-8.05, 'mainHorse', 0.62),
  horseAt(-0.6, 'foreHorse', 1.25),
];

/**
 * The traveller block that rides each horse and carries the boom sheet.
 *
 * An iron shackle round the bar, and a block hung in it. `shackleY` is where it
 * grips the bar — the bar's own midspan, arch included — and `y` is the sheave
 * the rope turns through. The two rope runs both terminate at the sheave, so the
 * turn happens inside a drawn object.
 */
export interface SheetBlock {
  name: string;
  z: number;
  /** Height of the sheave: what the sheet's two parts meet at. */
  y: number;
  /** Height at which the shackle rides the bar. */
  shackleY: number;
}

/** Where the bar actually is at midspan, allowing for the arch. */
function horseMidspanY(horse: SheetHorse): number {
  return horse.y - HORSE_SAG;
}

function sheetBlockSheave(horse: SheetHorse): RigPoint {
  return p(0, horseMidspanY(horse) + 0.13, horse.z);
}

export const SHEET_BLOCKS: readonly SheetBlock[] = SHEET_HORSES.map((horse) => ({
  name: `${horse.name}Block`,
  z: horse.z,
  y: sheetBlockSheave(horse).y,
  shackleY: horseMidspanY(horse),
}));

/**
 * Sheets are led well aft of their clews.
 *
 * A sheet that drops straight down from the clew holds nothing — it has to pull
 * *aft* as well as down, because aft is the direction the sail's drive wants to
 * take the clew. The lead is what converts one into the other.
 */
/**
 * Where each sheet is led and belayed. Three points per rope, not two: the clew,
 * the fairlead it turns through, and the pin it is made fast to.
 */
/**
 * The fisherman is **not** in this list any more — it sheets to the mainmast.
 *
 * It used to run its clew down to a pin on the rail like the three headsails,
 * and the result was a rope dropping some four metres past a sail corner at an
 * angle that explained nothing about why the corner was where it was. Ash's read
 * was that the sail had no reason not to flop, and that the sheet ought to go
 * *sideways to the after mast* instead. That is right and it is what the sail
 * wants: a main-topmast staysail sets between the masts, and the thing aft of it
 * to pull its clew against is the mainmast.
 */
const SHEET_STATIONS = [
  { name: 'staysail', z: 2.6 },
  { name: 'jib', z: 3.5 },
  { name: 'flyingJib', z: 4.35 },
] as const;

/**
 * The fairleads a sheet turns through, as a list the loft can build fittings on.
 *
 * A rope that changes direction does it *at something*. Without a drawn bullseye
 * these turns were bare vertices on the rail — Ash's reading was that the sheets
 * "disappear into the top rail", which is what a rope does when it meets a
 * surface and there is nothing there to meet. Same fault, same fix, as the
 * traveller blocks on the sheet horses.
 */
export const SHEET_FAIRLEADS: readonly string[] = SHEET_STATIONS.map(
  (s) => `${s.name}Fairlead`,
);

/**
 * Every node where a rope turns or ends on a **block** — a thing hung off a
 * spar — rather than on the timber itself.
 *
 * THE THIRD TIME THIS FAULT HAS BEEN FOUND BY EYE
 * -----------------------------------------------
 * The sheet horses got their traveller blocks because two rope segments meeting
 * at a shared point "read as two ropes ending at a corner". The headsail sheets
 * got their bullseyes because without them the turns "disappeared into the top
 * rail". Both fixes drew a fitting at one named list of nodes and stopped there —
 * and five more nodes went on turning and terminating on nothing, because
 * nothing enumerated *rope ends* as a category.
 *
 * Ash found the fisherman's: "the rope back from the clew doesn't actually
 * contact the aft mast or anything physical where it kinks, it just kinda kinks
 * in mid air." It hangs 0.14 m clear of the mainmast. So do the two masthead
 * blocks, and so — newly, from moving the peak halyard onto the weather side —
 * do both of its ends.
 *
 * This is the list, and `ship-rig.test.ts` now enumerates every endpoint of every
 * running rope and requires it to be on a spar, at a block named here, at a
 * belaying pin, or bent to a sail's own corner. A rope that ends anywhere else
 * fails until somebody says what it is holding onto.
 *
 * The loft finds what each block hangs from by asking the spars which is
 * nearest — so a block follows the timber it is strapped to rather than carrying
 * a second copy of where that timber is.
 */
export const RIG_BLOCKS: readonly string[] = [
  // Halyard falls turn here, on a strop round the masthead.
  'mainMastheadBlock',
  'foreMastheadBlock',
  // The peak halyard's two ends, both carried to the current weather side so
  // the gaff topsail can stay tacked at the jaws. See `mainGaffSpan`.
  'mainPeakBlock',
  'mainGaffSpan',
  // The fisherman's sheet turns on the mainmast's forward face and runs down.
  'fishermanSheetBlock',
];

/**
 * Where a stay's eye is seized round a masthead, standing to starboard of whatever
 * fidded there.
 *
 * The same fault as the blocks, found by the same test. The eyes stand 0.11 m
 * clear of the foremast's timber and nothing was drawn at them, so the spring
 * stay and the main topmast stay both ended *beside* the mast rather than on it.
 * The comment on `foreHoundsEye` already said "a stay's eye is seized round the
 * masthead" — the seizing simply was never drawn.
 */
export const MASTHEAD_EYES: readonly string[] = ['foreHoundsEye', 'foreCapEye'];

/**
 * The boom sheets belay at the rail beside their horse, not across the deck.
 *
 * They used to run forward from the horse to the fife rail — the main's fall
 * crossed 4 m of quarterdeck on the centreline at 0.40 m above the planking,
 * which is a trip wire down the middle of the walking surface. A hauling part
 * belays close to the block it comes off.
 */
const BOOM_SHEET_STATIONS = [
  { name: 'mainBoomSheet', z: -6.0 },
  { name: 'foreBoomSheet', z: -1.15 },
] as const;

/**
 * Pin rails on the inboard face of the bulwark.
 *
 * WHAT EACH FITTING IS FOR, BECAUSE THE OLD ARRANGEMENT COULD NOT SAY
 * -------------------------------------------------------------------
 * A sheet needs two things and they are not the same thing:
 *
 * - a **fairlead** on the caprail, which is where the rope *changes direction*
 *   from leading aft along the sail to leading down into the ship;
 * - a **pin**, which is where it is *made fast* and where a hand throws it off.
 *
 * Both are real and both are needed. What was not defensible was the housing:
 * three separate boards, one per headsail, each carrying **three** pins for one
 * rope. Ash asked what the boards were for if the rope already passed through a
 * fitting, and why six of the nine pins held nothing. Fair questions, and the
 * honest answer was that the pin count was decoration.
 *
 * One rail now, with exactly one pin per rope that belays to it, and each pin is
 * drawn where its rope actually ends rather than at an even spacing that happens
 * to be nearby. `pinZs` replaced a `pins: number` count for that reason — the
 * count let the drawn pins and the roped pins disagree, which is the same
 * two-descriptions fault as the bulwark itself.
 */
export interface BulwarkPinRail {
  name: string;
  z: number;
  side: 1 | -1;
  y: number;
  halfLength: number;
  /**
   * The port rail this one mirrors, if it is the starboard twin (S4). A
   * real ship carries pin rails both sides; a sheet belays to whichever
   * side its clew is hauled to, and the other rail's pin stands spare. The
   * pin-per-rope test counts roped pins against the *port* rails only and
   * asserts each twin matches its partner.
   */
  mirrorOf?: string;
  /** Where each pin goes, in ship z — one per rope made fast here. */
  pinZs: readonly number[];
  /**
   * The board's seat, **swept along the wall it is bolted to**.
   *
   * A rail is not a point and a ship is not straight, so a rail cannot be
   * described by one position. This used to be exactly that — a single centre —
   * and `rigGeometry.ts` drew a straight box from it, which stood out through
   * the planking at the bow and buried itself aft.
   *
   * The path lives here, with the rest of the graph, rather than being
   * re-derived in the loft. That is not tidiness: a test that computed the seat
   * the same way the loft did could never catch the loft getting it wrong, and
   * one did exactly that a few hours ago. `ship-rig.test.ts` checks *this*.
   */
  seats: readonly RigPoint[];
}

/** Where the board sits against the wall at `z` — the one description of it. */
export function pinRailSeat(z: number, side: 1 | -1): RigPoint {
  const section = railSection(z);
  return p(side * (section.innerX - 0.045), section.capY - 0.48, z);
}

function pinRailSeats(z: number, halfLength: number, side: 1 | -1): RigPoint[] {
  const SEGMENTS = 12;
  const seats: RigPoint[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (i + 0.5) / SEGMENTS;
    seats.push(pinRailSeat(z - halfLength + halfLength * 2 * t, side));
  }
  return seats;
}

/** The three headsail sheets share one rail forward, a pin each. */
const HEADSAIL_PINS = SHEET_STATIONS.map((s) => sheetPin(s.z).z);

const PORT_PIN_RAILS: readonly BulwarkPinRail[] = [
  headsailRail(),
  ...BOOM_SHEET_STATIONS.map((s) => {
    const pin = sheetPin(s.z);
    return {
      name: `${s.name}PinRail`,
      z: pin.z,
      side: 1 as const,
      y: pin.y,
      halfLength: 0.24,
      pinZs: [pin.z],
      seats: pinRailSeats(pin.z, 0.24, 1),
    };
  }),
];

/** The starboard twin of a port rail — same timber, mirrored wall. */
function mirrorPinRail(rail: BulwarkPinRail): BulwarkPinRail {
  return {
    name: `${rail.name}Starboard`,
    z: rail.z,
    side: -rail.side as 1 | -1,
    y: rail.y,
    halfLength: rail.halfLength,
    mirrorOf: rail.name,
    pinZs: rail.pinZs,
    seats: pinRailSeats(rail.z, rail.halfLength, -rail.side as 1 | -1),
  };
}

export const BULWARK_PIN_RAILS: readonly BulwarkPinRail[] = [
  ...PORT_PIN_RAILS,
  ...PORT_PIN_RAILS.map(mirrorPinRail),
];

function headsailRail(): BulwarkPinRail {
  const z = (Math.min(...HEADSAIL_PINS) + Math.max(...HEADSAIL_PINS)) / 2;
  const halfLength =
    (Math.max(...HEADSAIL_PINS) - Math.min(...HEADSAIL_PINS)) / 2 + 0.22;
  return {
    name: 'headsailPinRail',
    z,
    side: 1,
    y: sheetPin(SHEET_STATIONS[1].z).y,
    halfLength,
    pinZs: HEADSAIL_PINS,
    seats: pinRailSeats(z, halfLength, 1),
  };
}

Object.assign(
  RIG_NODES,
  Object.fromEntries(
    [...SHEET_STATIONS, ...BOOM_SHEET_STATIONS].flatMap((s) => [
      [`${s.name}Fairlead`, sheetFairlead(s.z)],
      [`${s.name}Pin`, sheetPin(s.z)],
    ]),
  ),
);

/**
 * How far off the mast a masthead block hangs.
 *
 * 0.32 m: the mainmast is 0.175 m in radius at the partners and less aloft, and
 * a gaff's throat fitting stands proud of it — so this is the mast, the ironwork
 * and a hand's width, which is what a strop and a block actually come to.
 */
const MASTHEAD_BLOCK_OFFSET = 0.32;

/** A block hung off one side of a masthead, clear of the axis. */
function mastheadBlock(axis: MastAxis, y: number, side: 1 | -1 = -1): RigPoint {
  return p(side * MASTHEAD_BLOCK_OFFSET, y, mastZAt(axis, y));
}

/**
 * How far off the gaff's axis a block shackled to its starboard side hangs.
 *
 * A block's own half-breadth plus its shackle. The gaff is about 0.065 m in
 * radius here, so the sheave sits a little clear of the timber — which is what a
 * block on an eyebolt looks like, and is the whole reason the halyard has a side
 * at all. See the note on `mainGaffSpan`.
 */
const PEAK_HALYARD_GAFF_STARBOARD = 0.12;

/**
 * A point off the **starboard** side of the main gaff, at fraction `t` along it.
 *
 * The offset is perpendicular to the gaff *in plan*, not along −x: the gaff is
 * swung 26° to port, so its starboard side runs partly aft. Taking −x instead
 * would slide the block along the spar as well as off it, which is how the
 * earlier attempts ended up with fittings that held onto nothing.
 */
function gaffStarboardBlockAt(
  t: number,
  distance: number,
  gaff: GaffPose,
): RigPoint {
  const at = alongMainGaffAt(t, gaff);
  const dx = gaff.peak.x - gaff.throat.x;
  const dz = gaff.peak.z - gaff.throat.z;
  const span = Math.hypot(dx, dz) || 1;
  // Rotate the in-plan direction a quarter turn to starboard.
  return p(at.x - (-dz / span) * distance, at.y, at.z - (dx / span) * distance);
}

/** The cheek block on whichever side of the gaff is weather-side at this trim. */
function gaffWeatherBlockAt(
  t: number,
  distance: number,
  gaff: GaffPose,
  trimRad: number,
): RigPoint {
  return gaffStarboardBlockAt(
    t,
    -weatherSideForTrim(trimRad) * distance,
    gaff,
  );
}

function gaffStarboardBlock(t: number, distance: number): RigPoint {
  return gaffStarboardBlockAt(t, distance, MAIN_GAFF);
}

/** The side opposite a fore-and-aft sail's signed live trim. */
function weatherSideForTrim(trimRad: number): 1 | -1 {
  return trimRad >= 0 ? -1 : 1;
}


Object.assign(RIG_NODES, {
  /**
   * The peak halyard: **one rope, gaff to masthead, rigged down the weather side.**
   *
   * FIVE ATTEMPTS, AND THE FOUR THAT FAILED WERE MEASURING ONE END
   * --------------------------------------------------------------
   * It began as `mainPeak` → `mainCap`: a single line from the gaff's end to the
   * masthead. Fine until a gaff topsail went in above the mainsail, because a
   * peak halyard rises from the gaff to the masthead and that is the definition
   * of the triangle a gaff topsail occupies. It passed 0.015 m from the cloth.
   *
   * Attempt two moved the *masthead* coordinates to starboard and gained 0.004 m.
   * Attempts three and four tried to make that offset legible — a two-legged span
   * with the block in its bight, then a block on a strop — and produced a
   * three-way junction in mid-air and a kink a foot short of the mast. The round
   * concluded that "the clearance never came from lateral offset at all" and
   * raised the sail's tack above the block instead, which put the whole halyard
   * under the foot and opened 2.35 m of daylight between the gaff and the sail.
   *
   * **That conclusion was drawn from a one-ended experiment.** A halyard is a
   * chord: move one end and it pivots, and the middle — which is where the cloth
   * is — barely stirs. Swept properly, with the tack back down at the jaws:
   *
   *     masthead block alone, 0.10 → 0.40 m to starboard    0.028 → 0.035 m
   *     gaff end alone, 0.06 → 0.18 m to starboard        0.010 → 0.009 m
   *     both together, 0.32 at the mast and 0.12 at the gaff   **0.094 m**
   *
   * Eight times the rope's own radius, from moving both ends of the chord instead
   * of one. **An offset that "does nothing" may be an offset that was only ever
   * applied at one end of the thing being offset.**
   *
   * It is also what the rig does anyway: the topsail bellies to leeward and the
   * halyard runs down its weather face. Both ends use real fittings —
   * `mastheadBlock`, on a strop at the masthead, and the cheek block shackled to
   * the gaff. The authored pose uses their starboard pair. Live trim selects the
   * mirrored pair from the same trim that swings the gaff, so a tack cannot
   * leave the halyard behind on what just became the cloth's leeward face.
   */
  /**
   * Where the peak halyard is made fast to the gaff: a block shackled to the
   * spar's weather side, not sitting on top of it. The baked pose is starboard;
   * the live overlay selects the other cheek after a tack.
   */
  mainGaffSpan: gaffStarboardBlock(0.8, PEAK_HALYARD_GAFF_STARBOARD),
  /** The weather-side masthead block; baked starboard, mirrored by live trim. */
  mainPeakBlock: mastheadBlock(MAIN_AXIS, MAIN_CAP_Y - 0.4),
  /**
   * The sheave of the traveller block, which is what the sheet actually turns
   * through — not a bare point in the air above the bar.
   *
   * TWO FAULTS, ONE CAUSE
   * ---------------------
   * This was `horse.y + 0.06`, and the bar's own midspan is `horse.y − 0.07`
   * because of the arch (`HORSE_SAG`, which until now was a number buried in a
   * lambda in `rigGeometry.ts` where nothing could read it). So the rope's turn
   * floated **0.108 m clear of the bar's surface**, touching nothing.
   *
   * And even sitting on the bar it would have been wrong, because two rope
   * segments meeting at a shared node read as two ropes ending at a corner, not
   * as one rope rounding a turn. A real sheet does not bend on the bar at all —
   * it reeves through a **block** that travels on it. Drawing the block is what
   * makes the corner a fitting instead of a kink, and it is the reason the turn
   * belongs above the bar rather than on it.
   *
   * So the height is nearly what it was, and now there is something there.
   * `SHEET_BLOCKS` below is that something.
   */
  mainHorse: sheetBlockSheave(SHEET_HORSES[0]),
  foreHorse: sheetBlockSheave(SHEET_HORSES[1]),
  // The authored falls belay to starboard, then the live overlay selects the
  // opposite pins when the sails cross. A leeward fall lies inside the cloth.
  mainFifePin: fifePin(FIFE_RAILS[0], 0, -1),
  foreFifePin: fifePin(FIFE_RAILS[1], 0, -1),
  /**
   * The fisherman's sheet belays outboard of the halyard fall.
   *
   * Its block hangs on the mainmast's forward face and the rail is abaft the
   * mast, so the fall has to get past the stick. The inner pin is not far enough
   * outboard to do that — it left 0.1 m of rope inside the mainmast — and the
   * outer one is, which is also the order they would be belayed in: the fall
   * that comes from furthest outboard takes the outboard pin.
   */
  fishermanFifePin: fifePin(FIFE_RAILS[0], 1, -1),

  /**
   * The blocks a fall and a topping lift are rove through at the hounds.
   *
   * Offset to the weather side, off the mast's axis. A fall that starts *on* the axis has
   * to cut through everything gathered there on its way down — the gaff jaws
   * sit at the throat, 0.7 m below the hounds, and the boom's gooseneck below
   * that — so it foul[ed] the gaff by 40 mm and, before the pins were moved to
   * their proper side, the boom and the mast as well. Real ones hang from a
   * block on a strop round the masthead, which is exactly this offset.
   *
   * Starboard in the baked pose, because the sail and both spars swing to port.
   * `trimmedRigNodePositions` mirrors both block and belaying pin after a tack.
   */
  mainMastheadBlock: mastheadBlock(MAIN_AXIS, MAIN_HOUNDS_Y - 0.15),
  foreMastheadBlock: mastheadBlock(FORE_AXIS, FORE_HOUNDS_Y - 0.15),
});


const SHEET_DIAMETER = 0.026;
const HALYARD_DIAMETER = 0.024;

export const RUNNING_RIGGING: readonly RiggingRun[] = [
  // --- sheets: clew, fairlead, pin -----------------------------------------
  // Three points, because that is how many a real sheet has. The first version
  // ran clew straight to the rail and stopped, so every rope aboard vanished
  // into the planking; the ones on deck vanished into the deck. A rope has to
  // end at a thing, and the things are built now — pin rails inside the
  // bulwark, fife rails abaft the masts, iron horses across the deck.
  ...SHEET_STATIONS.flatMap((s) => [
    {
      name: `${s.name}Sheet`,
      from: `${s.name}Clew`,
      to: `${s.name}Fairlead`,
      kind: 'sheet' as const,
      diameter: SHEET_DIAMETER,
    },
    {
      name: `${s.name}SheetFall`,
      from: `${s.name}Fairlead`,
      to: `${s.name}Pin`,
      kind: 'sheet' as const,
      diameter: SHEET_DIAMETER,
    },
  ]),

  // The gaff sails sheet from their boom ends to an iron horse across the deck,
  // then forward to a pin on the fife rail.
  {
    name: 'mainSheet',
    from: 'mainBoomSheetBlock',
    to: 'mainHorse',
    kind: 'sheet',
    diameter: SHEET_DIAMETER * 1.3,
  },
  {
    name: 'mainSheetFall',
    from: 'mainHorse',
    to: 'mainBoomSheetPin',
    kind: 'sheet',
    diameter: SHEET_DIAMETER * 1.1,
  },
  {
    name: 'foreSheet',
    from: 'foreBoomEnd',
    to: 'foreHorse',
    kind: 'sheet',
    diameter: SHEET_DIAMETER * 1.2,
  },
  {
    name: 'foreSheetFall',
    from: 'foreHorse',
    to: 'foreBoomSheetPin',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },

  // --- topping lifts: what holds a boom up when its sail is not full --------
  // Both are rove through the masthead block rather than landing on the mast's
  // own axis, for the reason `mainMastheadBlock` gives: the axis at that height
  // is where the gaff's jaws are.
  {
    name: 'mainToppingLift',
    from: 'mainBoomEnd',
    to: 'mainMastheadBlock',
    kind: 'lift',
    diameter: SHEET_DIAMETER,
  },
  {
    name: 'foreToppingLift',
    from: 'foreBoomEnd',
    to: 'foreMastheadBlock',
    kind: 'lift',
    diameter: SHEET_DIAMETER,
  },

  // --- halyards: what hauled each gaff up, still made fast ------------------
  // Peak and throat are separate on a gaff rig, and that is the whole trick of
  // one: hauling the peak harder flattens the sail without moving the throat.
  {
    name: 'mainPeakHalyard',
    from: 'mainGaffSpan',
    to: 'mainPeakBlock',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'mainThroatHalyard',
    from: 'mainThroat',
    to: 'mainHounds',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'forePeakHalyard',
    from: 'forePeak',
    to: 'foreCap',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'foreThroatHalyard',
    from: 'foreThroat',
    to: 'foreHounds',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  // …and the hauling parts, coming down to the pins where they are belayed.
  {
    name: 'mainHalyardFall',
    from: 'mainMastheadBlock',
    to: 'mainFifePin',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'foreHalyardFall',
    from: 'foreMastheadBlock',
    to: 'foreFifePin',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },

  // --- the fisherman's sheet: sideways to the mainmast, then down -----------
  {
    name: 'fishermanSheet',
    from: 'fishermanClew',
    to: 'fishermanSheetBlock',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },
  {
    name: 'fishermanSheetFall',
    from: 'fishermanSheetBlock',
    to: 'fishermanFifePin',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },

  // --- the topsail's own gear -----------------------------------------------
  /**
   * The sheets, which are what make the lower yard a working spar.
   *
   * A topsail's foot is held by nothing but these two. Each hauls its clew down
   * and outboard to the lower yardarm, reeving through a sheave in the arm — so
   * the rope is short, it ends at a thing, and the thing it ends at is the yard
   * that had no purpose before this. Without them the sail's foot is two corners
   * hanging in mid-air, which is what a bare course yard underneath was quietly
   * announcing.
   */
  {
    name: 'topsailSheetPort',
    from: 'topsailClewPort',
    to: 'lowerYardArmPort',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },
  {
    name: 'topsailSheetStarboard',
    from: 'topsailClewStarboard',
    to: 'lowerYardArmStarboard',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },
  /**
   * The tye: how a hoisting yard hoists.
   *
   * The topsail yard is not fixed the way the lower yard is — the sail is set and
   * handed by sending the yard up and down the topmast, and this is the rope that
   * does it. It leads from the yard's sling up to a sheave in the topmast head,
   * which is above the sail and therefore clear of the cloth the whole way.
   */
  {
    name: 'topsailTye',
    from: 'topsailYardSling',
    to: 'foreTopmastHead',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },

  // --- the main gaff topsail's gear -----------------------------------------
  /**
   * The halyard hoists the head; the sheet hauls the clew out and then **leads
   * back in along the gaff**, which is the part the first version left out.
   *
   * A sheet drawn only from the clew to the block at the gaff end is a 0.3 m
   * stub of rope hanging between two sails. Ash's question about it was the right
   * one — the *idea* is correct, a topsail sheet does haul its clew out to the
   * gaff end, but the drawing was a fragment of a rope rather than a rope. A real
   * one reeves through a sheave out there and its hauling part comes back in
   * along the spar to the jaws, where it is made fast within reach of the deck.
   * Drawing the lead is what makes the fragment legible as gear.
   *
   * That is section 7.4 read properly: "every important rope connects functional
   * components" is not satisfied by touching a component at each end if the run
   * between them is not the run the rope actually takes.
   *
   * Neither is led all the way to the deck. A fall running the length of the
   * main topmast and then the mainmast would pass through the mainsail on the
   * way — the same reason the fore topsail's tye stops at the masthead.
   */
  {
    name: 'mainTopsailHalyard',
    from: 'mainTopsailHead',
    to: 'mainTopmastHead',
    kind: 'halyard',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'mainTopsailSheet',
    from: 'mainTopsailClew',
    to: 'mainPeak',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },
  {
    name: 'mainTopsailSheetLead',
    from: 'mainPeak',
    to: 'mainThroat',
    kind: 'sheet',
    diameter: SHEET_DIAMETER,
  },

  // --- braces: what holds the yards at their angle --------------------------
  // They lead aft, and they lead *high* — to the main topmast rather than to the
  // deck — so they pass over the foresail instead of through it.
  {
    name: 'topsailBracePort',
    from: 'topsailYardArmPort',
    to: 'mainTopmastHead',
    kind: 'brace',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'topsailBraceStarboard',
    from: 'topsailYardArmStarboard',
    to: 'mainTopmastHead',
    kind: 'brace',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'lowerYardBracePort',
    from: 'lowerYardArmPort',
    to: 'mainHounds',
    kind: 'brace',
    diameter: HALYARD_DIAMETER,
  },
  {
    name: 'lowerYardBraceStarboard',
    from: 'lowerYardArmStarboard',
    to: 'mainHounds',
    kind: 'brace',
    diameter: HALYARD_DIAMETER,
  },
];

// --- ratlines ----------------------------------------------------------------

/** Vertical spacing of ratlines, metres — one comfortable rung. */
export const RATLINE_SPACING = 0.38;

/** Ratline diameter, metres. Lighter stuff than the shrouds they cross. */
export const RATLINE_DIAMETER = 0.017;

export interface RatlineRung {
  name: string;
  fromShroud: string;
  toShroud: string;
  y: number;
}

/**
 * The ratlines on one mast, as spans across a shroud gang.
 *
 * A rung is one line from the forward shroud to the after one at a constant
 * height, seized across every shroud between. At 0.38 m spacing a gang climbs
 * about 20 rungs, and there are four gangs.
 */
export function ratlineRungs(mastName: string, pairs: number): RatlineRung[] {
  const rungs: RatlineRung[] = [];
  for (const side of ['Port', 'Starboard'] as const) {
    const lower = rigNode(`${mastName}Channel${side}0`);
    const upper = rigNode(`${mastName}Hounds`);
    // Stop short of the hounds: the last two feet of a gang converge too tightly
    // to stand in, and real ratlines stop there too.
    const top = upper.y - 0.9;
    const start = lower.y + RATLINE_SPACING;
    for (let y = start, i = 0; y < top; y += RATLINE_SPACING, i++) {
      rungs.push({
        name: `${mastName}Ratline${side}${i}`,
        fromShroud: `${mastName}Channel${side}0`,
        toShroud: `${mastName}Channel${side}${pairs - 1}`,
        y,
      });
    }
  }
  return rungs;
}

export const RATLINES: readonly RatlineRung[] = [
  ...ratlineRungs('main', MAIN_SHROUD_PAIRS),
  ...ratlineRungs('fore', FORE_SHROUD_PAIRS),
];

// --- sails -------------------------------------------------------------------

export type SailName =
  | 'mainsail'
  | 'foresail'
  | 'foreStaysail'
  | 'jib'
  | 'flyingJib'
  | 'foreTopsail'
  | 'mainTopmastStaysail'
  | 'mainGaffTopsail';

/**
 * A sail, as the corners it is bent to.
 *
 * Three or four named nodes and nothing else. `rigGeometry.ts` bellies a static
 * surface between them; the sails round replaces that surface with a deformable
 * one bent to the same corners, and this list does not change.
 *
 * `camber` is the depth of the belly as a fraction of the sail's own width — the
 * one number that decides whether she reads as drawing or as hung out to dry.
 */
export interface Sail {
  name: SailName;
  /** Corner nodes, in order around the sail. */
  corners: readonly string[];
  camber: number;
  /**
   * Which way the belly falls — as a **sign on the patch normal**, not a
   * direction in the world.
   *
   * THIS COMMENT ONCE CLAIMED THE SIGN WAS A WORLD SIDE, AND THAT WAS THE BUG
   * (its literal words were "+1 to starboard, −1 to port" — pre-W1 mirrored
   * labels; in today's labels that intent reads "+1 to port")
   * ----------------------------------------------------------------------------
   * The belly is laid along the normal of the corner patch, and that normal's
   * direction falls out of the *order the corners are listed in*. Reverse a
   * sail's corner list and the same `side` value points the belly the opposite
   * way. So `+1` means port for some corner orderings and starboard for others,
   * and there is no way to know which by reading the number.
   *
   * Six sails were authored against that comment, all set to `+1` meaning
   * "port", and **all six bellied to starboard** — to windward, on a rig whose
   * every clew is sheeted to port. It is the identical shape of fault to
   * the winding bug in section 3.1 of the handover: a convention that reads like
   * a world direction, is actually a local one, and produces something that
   * looks almost right.
   *
   * There is no sign convention that fixes this, because the quantity genuinely
   * depends on corner order. What fixes it is measuring: `ship-rig.test.ts`
   * takes the drawn surface's centre, subtracts the flat patch's centre, and
   * asserts the difference points to leeward. **Set this by running that test,
   * never by reasoning about the sign.**
   */
  side: 1 | -1;
}

/**
 * She is drawn on the STARBOARD tack — wind over the starboard side, everything sheeted
 * out to port, every sail bellied to port.
 *
 * A vessel is on the starboard tack when the wind comes over her starboard
 * side, which puts her booms out to *port*; hers are out to port (`SHEET_MAIN`
 * and the rest are positive, and positive carries an after-pointing spar's end
 * to +x, the port side). The tack word here has flipped twice: an early comment
 * said "starboard tack", the rig round corrected it to "port tack" under the
 * pre-W1 mirrored side labels, and the W1 relabel (see `hullForm.ts`) restored
 * "starboard tack" — this time meaning it, in labels that agree with the
 * compass. Both earlier flips came from reasoning about a sign instead of
 * looking, which is not a coincidence.
 *
 * Eight sails now. `docs/ship/SHIP_SPEC.md` section 7.1 lists six, permits the main
 * topmast staysail conditionally, and has been amended to add the main gaff
 * topsail — see the note there and on `MAIN_TOPSAIL_HEAD_Y`.
 */
export const SAILS: readonly Sail[] = [
  {
    name: 'mainsail',
    corners: ['mainThroat', 'mainPeak', 'mainBoomEnd', 'mainGooseneck'],
    camber: 0.085,
    side: -1,
  },
  {
    name: 'foresail',
    corners: ['foreThroat', 'forePeak', 'foreBoomEnd', 'foreGooseneck'],
    camber: 0.085,
    side: -1,
  },
  // The fan of three forward: head, tack, clew. Heads step evenly up the fore
  // rigging; tacks step out along the bowsprit; clews all land forward of the
  // foremast and above the boom.
  {
    name: 'foreStaysail',
    corners: ['staysailHead', 'stemhead', 'staysailClew'],
    camber: 0.075,
    side: -1,
  },
  {
    name: 'jib',
    corners: ['jibHead', 'bowspritMid', 'jibClew'],
    camber: 0.07,
    side: -1,
  },
  {
    name: 'flyingJib',
    corners: ['flyingJibHead', 'bowspritEnd', 'flyingJibClew'],
    camber: 0.065,
    side: -1,
  },
  /**
   * The one square sail: head bent to the topsail yard, clews hauled out to the
   * lower yardarms, foot loose between them.
   *
   * A trapezoid wider at the foot than the head, because the lower yard is
   * longer than the topsail yard — that taper is most of what says "square rig"
   * in profile, and it only exists because the foot is spread by a *different*
   * spar from the head. It spans 11.75 → 18.40, which puts it squarely across
   * the fore gaff's height band, and that is correct: the gaff sail is abaft the
   * mast and this is forward of it. See `YARD_FORWARD_OF_MAST`.
   *
   * Its corners run starboard to port along the head, so the surface normal
   * derived from them points *aft* — and at `+1` the belly went aft too, 0.63 m
   * of it, straight into the topmast. The cambered cloth crossed the mast on its
   * way back and again on its way forward, so the stick appeared to skewer the
   * sail at two points.
   *
   * A square sail set and drawing bellies away from the wind, which is forward.
   * That is also the direction that clears everything abaft it, and the belly is
   * now doing real work: it carries the middle of the cloth well forward of the
   * doubling the sail has to pass.
   */
  {
    name: 'foreTopsail',
    corners: [
      'topsailClothHeadStarboard',
      'topsailClothHeadPort',
      'topsailClewPort',
      'topsailClewStarboard',
    ],
    /**
     * Flattened from 0.10 when the sail doubled in size, and the arithmetic is
     * the reason rather than the look.
     *
     * `camber` is a fraction of the chord, and for a square sail the chord is
     * its *width* — 6.1 m now against 5.4 m before. Holding 0.10 through that
     * change deepened the belly to 0.57 m and carried the middle of the cloth
     * 0.90 m forward of the mast's axis. The three headsail stays leave the
     * masthead 0.55 m forward of that axis (`STAY_FORWARD_OF_MAST`), so the
     * topsail's belly was reaching out through the fore staysail — 0.058 m
     * separation — and grazing the jib at 0.102 m.
     *
     * A drawing square sail on a broad reach with its sheets hauled taut is a
     * fairly flat sail; 7% is a working draft and 10% is a bag. The constraint
     * and the seamanship agree, which is the comfortable case.
     */
    camber: 0.07,
    side: -1,
  },
  {
    name: 'mainTopmastStaysail',
    corners: ['fishermanHead', 'fishermanTack', 'fishermanClew'],
    camber: 0.06,
    side: -1,
  },
  /**
   * The main gaff topsail. Head aloft, tack at the gaff jaws, clew out the gaff.
   *
   * Flatter than the sails below it — 5% — for two reasons that agree. A topsail
   * set in the clean air above a gaff sail is sheeted hard and stands nearly
   * flat, and the belly here falls across the space the fisherman occupies,
   * which is the one direction it has no room in. The measured gap to the
   * fisherman is the number that matters and it is in `ship-rig.test.ts`.
   *
   * It bellies with the mainsail, because it is bound to the mainsail's trim:
   * its foot lies on the same gaff and swings when that gaff swings.
   */
  {
    name: 'mainGaffTopsail',
    corners: ['mainTopsailHead', 'mainTopsailTack', 'mainTopsailClew'],
    camber: 0.05,
    side: -1,
  },
];

// --- the mass audit ----------------------------------------------------------

/** Density of pine and fir, kg/m³. Matches `massModel.ts`. */
const RHO_PINE = 550;

export interface RigMassItem {
  name: string;
  mass: number;
  /** Height of the centroid above the baseline. */
  y: number;
  z: number;
}

/**
 * What the drawn spars actually weigh, and where.
 *
 * `massModel.ts` has carried hand-entered rig masses since M0 — estimates made
 * before any spar existed — and M2 is the first time there is real geometry to
 * compare them against. `tests/ship-rig.test.ts` is where the comparison lives.
 */
export function rigMassItems(): RigMassItem[] {
  return SPARS.map((spar) => {
    const c = sparCentroid(spar);
    return {
      name: spar.name,
      mass: sparVolume(spar) * RHO_PINE,
      y: c.y,
      z: c.z,
    };
  });
}

/** Total spar mass and its centre of gravity. */
export function rigMassAudit(): { mass: number; y: number; z: number } {
  const items = rigMassItems();
  let mass = 0;
  let my = 0;
  let mz = 0;
  for (const item of items) {
    mass += item.mass;
    my += item.mass * item.y;
    mz += item.mass * item.z;
  }
  if (mass < 1e-9) return { mass: 0, y: 0, z: 0 };
  return { mass, y: my / mass, z: mz / mass };
}

/** Height of the main truck above the design waterline — the spec's own check. */
export function mainTruckAboveWaterline(): number {
  return MAIN_TOPMAST_HEAD_Y - DESIGN_DRAUGHT;
}

/**
 * How far the main boom reaches past the sternpost, metres.
 *
 * Measured along the spar, not as a z distance, because a boom eased out to a
 * broad reach has a shorter fore-and-aft projection than the same boom sheeted
 * amidships — the overhang would then read as a property of the trim rather
 * than of the vessel, and it is the vessel's.
 */
export function mainBoomOverhang(): number {
  const gooseneck = rigNode('mainGooseneck');
  return MAIN_BOOM_LENGTH - (gooseneck.z + HALF_LENGTH);
}

/** Clearance from the main boom's underside to the deck crown beneath it. */
export function mainBoomClearance(): number {
  const gooseneck = rigNode('mainGooseneck');
  return gooseneck.y - BOOM_R_MID - deckCrownY(MAINMAST_Z);
}

/**
 * How far the square topsail's cloth stands forward of the foremast's axis at
 * the fore gaff's throat — the height at which the two sails are closest.
 *
 * THIS REPLACED A HEIGHT MEASUREMENT, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------
 * The old function returned `topsail foot Y − gaff peak Y`: vertical daylight
 * between the two. It was a good test of the *first* fault, when the topsail was
 * set below the gaff peak and the two genuinely shared a band. It then became the
 * reason the topsail got pushed up onto the topmast into an 1850s double-topsail
 * arrangement, because the only way to raise that number is to raise the sail.
 *
 * A gaff and a square topsail overlap in height on every real rig of the type.
 * They do not overlap in *space*, because one is set abaft the mast and the other
 * forward of it. So the quantity that matters is fore-and-aft separation, and it
 * is a property of `YARD_FORWARD_OF_MAST`, not of how high the sail is hung.
 *
 * `tests/ship-rig.test.ts` carries the stronger version — the true minimum
 * distance from the drawn, bellied cloth to the gaff spar — and this is the
 * one-number summary of why that distance exists at all.
 */
export function topsailForwardOfGaff(): number {
  return YARD_FORWARD_OF_MAST;
}

/**
 * The tightest gap between the fore boom and the mainmast **anywhere in the
 * boom's swing**, timber surface to timber surface.
 *
 * This measured the boom where it happens to be *drawn* — sheeted 30° to
 * starboard — and reported the distance between two axes. Both are the wrong
 * question. Ash asked it directly, because it is a question he cannot answer by
 * eye until M6 makes the booms swing: "does the foresail boom have room to swing
 * past the aft mast?"
 *
 * Where it is drawn, the gap is 2.84 m; where it matters — amidships, pointing
 * straight aft — it is **0.815 m**, and that is the number this returns. A test
 * on the drawn position would have gone on passing while the amidships case
 * closed to nothing, which is the same fault as measuring the main boom's
 * headroom at the station she is drawn in rather than the one a helmsman stands
 * at.
 */
// --- live trim (S4) ----------------------------------------------------------
//
// The trim constants above are the *authored* pose. Live trim re-runs the
// same constructors — `swingAbout`, `headsailClew`, `yardArms`,
// `alongMainGaffAt` — at commanded angles, so at the authored angles every
// derived position is bit-identical to the baked node. Nothing here invents
// a second geometric truth.

/** Per-sail trim angles, radians, positive toward +x/port (the authored side). */
export interface RigTrimAnglesRad {
  mainsail: number;
  foresail: number;
  foreStaysail: number;
  jib: number;
  flyingJib: number;
  /** Brace: positive carries the port yardarm forward (the authored sense). */
  foreTopsail: number;
  /** The fisherman's fixed-magnitude sheet; only the sign is commanded. */
  mainTopmastStaysail: number;
}

/**
 * The hoists the *rig's own timber* depends on (1 = fully hoisted).
 *
 * Only the two gaff sails are here, and that is the whole point: their hoist
 * moves a spar, so the rig has to know it. Every other sail's hoist gathers
 * cloth onto fittings that do not move, which is `sailAero.ts`'s business
 * rather than this file's. A caller holding a hoist per sail satisfies this
 * type as it stands.
 */
export type RigHoistFractions = Readonly<Record<'mainsail' | 'foresail', number>>;

/** Both gaffs peaked — the pose the rig above is baked at. */
export const FULLY_HOISTED: RigHoistFractions = Object.freeze({
  mainsail: 1,
  foresail: 1,
});

/** The authored trims — the pose the rig above is baked at. */
export const AUTHORED_TRIM_RAD: Readonly<RigTrimAnglesRad> = Object.freeze({
  mainsail: SHEET_MAIN,
  foresail: SHEET_FORE,
  foreStaysail: SHEET_STAYSAIL,
  jib: SHEET_JIB,
  flyingJib: SHEET_FLYING_JIB,
  foreTopsail: AUTHORED_BRACE_ANGLE,
  mainTopmastStaysail: SHEET_FISHERMAN,
});

/** A mutable 3-vector for allocation-free corner derivation. */
export interface MutableRigPoint {
  x: number;
  y: number;
  z: number;
}

function setPoint(out: MutableRigPoint, x: number, y: number, z: number): void {
  out.x = x;
  out.y = y;
  out.z = z;
}

function copyPoint(out: MutableRigPoint, from: RigPoint): void {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
}

/** Corner counts per sail, in `SAILS` order — for sizing corner buffers. */
export function sailCornerCount(name: SailName): number {
  const sail = SAILS.find((s) => s.name === name);
  if (!sail) throw new Error(`rig: no such sail "${name}"`);
  return sail.corners.length;
}

/**
 * The live corners of one sail at the given trims, written into `out` in the
 * sail's `corners` order (the order the loft and the aero both consume).
 *
 * Fixed corners read the baked nodes; trim-driven corners re-run the same
 * constructors the baked nodes came from. The main gaff topsail takes the
 * *mainsail* trim — it is bound to the same gaff (design §5.1).
 *
 * The two gaff sails also take a hoist, because theirs moves the gaff itself
 * (`gaffPoseAt`): head on the descending spar, foot left exactly where the
 * boom is. Nothing gathers the cloth here — that is `gatherSailCorners`, and
 * for these two sails it now has nothing left to do.
 */
export function liveSailCorners(
  name: SailName,
  trims: Readonly<RigTrimAnglesRad>,
  out: readonly MutableRigPoint[],
  hoists: RigHoistFractions = FULLY_HOISTED,
): void {
  switch (name) {
    case 'mainsail': {
      const gaff = mainGaffAt(trims.mainsail, hoists.mainsail);
      const boomEnd = mainBoomEndSwungAt(trims.mainsail);
      copyPoint(out[0], gaff.throat);
      copyPoint(out[1], gaff.peak);
      setPoint(out[2], boomEnd.x, MAIN_BOOM_END_Y, boomEnd.z);
      copyPoint(out[3], rigNode('mainGooseneck'));
      return;
    }
    case 'foresail': {
      const gaff = foreGaffAt(trims.foresail, hoists.foresail);
      const boomEnd = foreBoomEndSwungAt(trims.foresail);
      copyPoint(out[0], gaff.throat);
      copyPoint(out[1], gaff.peak);
      setPoint(out[2], boomEnd.x, FORE_BOOM_END_Y, boomEnd.z);
      copyPoint(out[3], rigNode('foreGooseneck'));
      return;
    }
    case 'foreStaysail': {
      const clew = headsailClew(STEMHEAD, STAYSAIL_CLEW_Y, STAYSAIL_CLEW_Z, trims.foreStaysail);
      copyPoint(out[0], rigNode('staysailHead'));
      copyPoint(out[1], rigNode('stemhead'));
      copyPoint(out[2], clew);
      return;
    }
    case 'jib': {
      const clew = headsailClew(JIB_TACK, JIB_CLEW_Y, JIB_CLEW_Z, trims.jib);
      copyPoint(out[0], rigNode('jibHead'));
      copyPoint(out[1], rigNode('bowspritMid'));
      copyPoint(out[2], clew);
      return;
    }
    case 'flyingJib': {
      const clew = headsailClew(FLYING_JIB_TACK, FLYING_JIB_CLEW_Y, FLYING_JIB_CLEW_Z, trims.flyingJib);
      copyPoint(out[0], rigNode('flyingJibHead'));
      copyPoint(out[1], rigNode('bowspritEnd'));
      copyPoint(out[2], clew);
      return;
    }
    case 'foreTopsail': {
      const head = yardArms(
        TOPSAIL_YARD_Y,
        TOPSAIL_YARD_HALF_SPAN * CLOTH_ON_YARD,
        true,
        trims.foreTopsail,
      );
      const clews = yardArms(
        LOWER_YARD_Y,
        LOWER_YARD_HALF_SPAN * TOPSAIL_CLEW_ON_YARD,
        false,
        trims.foreTopsail,
      );
      copyPoint(out[0], head.starboard);
      copyPoint(out[1], head.port);
      copyPoint(out[2], clews.port);
      copyPoint(out[3], clews.starboard);
      return;
    }
    case 'mainTopmastStaysail': {
      const clew = headsailClew(
        FISHERMAN_TACK,
        FISHERMAN_CLEW_Y,
        FISHERMAN_CLEW_Z,
        trims.mainTopmastStaysail,
      );
      copyPoint(out[0], rigNode('fishermanHead'));
      copyPoint(out[1], rigNode('fishermanTack'));
      copyPoint(out[2], clew);
      return;
    }
    case 'mainGaffTopsail': {
      const gaff = mainGaffAt(trims.mainsail, hoists.mainsail);
      const onGaff = alongMainGaffAt(MAIN_TOPSAIL_CLEW_ON_GAFF, gaff);
      copyPoint(out[0], rigNode('mainTopsailHead'));
      copyPoint(out[1], rigNode('mainTopsailTack'));
      setPoint(out[2], onGaff.x, onGaff.y + MAIN_TOPSAIL_ABOVE_GAFF, onGaff.z);
      return;
    }
  }
}

/**
 * Every named node the live state moves, at the given trims and hoists — the
 * loft's overlay. Everything not in this record stands where the baked graph
 * put it.
 *
 * The gaffs' jaws and peaks are in here because the hoist lowers the spar, and
 * the spar table addresses them by name: `mainGaff` runs `mainThroat` →
 * `mainPeak`, so moving the two nodes carries the drawn timber, the peak
 * halyard's block on it, and the gaff topsail's clew with them.
 */
export function trimmedRigNodePositions(
  trims: Readonly<RigTrimAnglesRad>,
  hoists: RigHoistFractions = FULLY_HOISTED,
): Record<string, RigPoint> {
  const mainGaff = mainGaffAt(trims.mainsail, hoists.mainsail);
  const foreGaff = foreGaffAt(trims.foresail, hoists.foresail);
  const mainBoomEnd = mainBoomEndSwungAt(trims.mainsail);
  const foreBoomEnd = foreBoomEndSwungAt(trims.foresail);
  const topsailClewOnGaff = alongMainGaffAt(MAIN_TOPSAIL_CLEW_ON_GAFF, mainGaff);
  const lowerYard = yardArms(LOWER_YARD_Y, LOWER_YARD_HALF_SPAN, false, trims.foreTopsail);
  const topsailYard = yardArms(TOPSAIL_YARD_Y, TOPSAIL_YARD_HALF_SPAN, true, trims.foreTopsail);
  const clothHead = yardArms(
    TOPSAIL_YARD_Y,
    TOPSAIL_YARD_HALF_SPAN * CLOTH_ON_YARD,
    true,
    trims.foreTopsail,
  );
  const clothClews = yardArms(
    LOWER_YARD_Y,
    LOWER_YARD_HALF_SPAN * TOPSAIL_CLEW_ON_YARD,
    false,
    trims.foreTopsail,
  );
  const mainBoomEnd3 = p(mainBoomEnd.x, MAIN_BOOM_END_Y, mainBoomEnd.z);
  // Fore-and-aft cloth lies on the sign of its trim. Running gear which was
  // rigged down the weather side in the authored pose has to use the opposite
  // cheek after a tack; otherwise its fixed inboard end makes the rope sweep
  // through the sail while the outboard end follows the moving spar. The
  // fittings already exist on both sides. This selects them from the same trim
  // state that drives the cloth rather than introducing a second tack flag.
  const mainWeatherSide = weatherSideForTrim(trims.mainsail);
  const foreWeatherSide = weatherSideForTrim(trims.foresail);
  const fishermanWeatherSide = weatherSideForTrim(trims.mainTopmastStaysail);
  return {
    mainThroat: mainGaff.throat,
    mainPeak: mainGaff.peak,
    mainBoomEnd: mainBoomEnd3,
    mainBoomSheetBlock: boomFraction(
      MAIN_GOOSENECK_Y,
      MAIN_GOOSENECK_Z,
      mainBoomEnd,
      MAIN_BOOM_END_Y,
      MAIN_SHEET_BOOM_FRACTION,
    ),
    foreThroat: foreGaff.throat,
    forePeak: foreGaff.peak,
    foreBoomEnd: p(foreBoomEnd.x, FORE_BOOM_END_Y, foreBoomEnd.z),
    mainTopsailClew: p(
      topsailClewOnGaff.x,
      topsailClewOnGaff.y + MAIN_TOPSAIL_ABOVE_GAFF,
      topsailClewOnGaff.z,
    ),
    staysailClew: headsailClew(STEMHEAD, STAYSAIL_CLEW_Y, STAYSAIL_CLEW_Z, trims.foreStaysail),
    jibClew: headsailClew(JIB_TACK, JIB_CLEW_Y, JIB_CLEW_Z, trims.jib),
    flyingJibClew: headsailClew(
      FLYING_JIB_TACK,
      FLYING_JIB_CLEW_Y,
      FLYING_JIB_CLEW_Z,
      trims.flyingJib,
    ),
    fishermanClew: headsailClew(
      FISHERMAN_TACK,
      FISHERMAN_CLEW_Y,
      FISHERMAN_CLEW_Z,
      trims.mainTopmastStaysail,
    ),
    lowerYardArmPort: lowerYard.port,
    lowerYardArmStarboard: lowerYard.starboard,
    topsailYardArmPort: topsailYard.port,
    topsailYardArmStarboard: topsailYard.starboard,
    topsailClothHeadPort: clothHead.port,
    topsailClothHeadStarboard: clothHead.starboard,
    topsailClewPort: clothClews.port,
    topsailClewStarboard: clothClews.starboard,
    // The peak-halyard pair follows the gaff and changes cheek with its tack.
    mainGaffSpan: gaffWeatherBlockAt(
      0.8,
      PEAK_HALYARD_GAFF_STARBOARD,
      mainGaff,
      trims.mainsail,
    ),
    mainPeakBlock: mastheadBlock(MAIN_AXIS, MAIN_CAP_Y - 0.4, mainWeatherSide),
    // Topping-lift blocks and their falls use the weather-side fittings too.
    mainMastheadBlock: mastheadBlock(
      MAIN_AXIS,
      MAIN_HOUNDS_Y - 0.15,
      mainWeatherSide,
    ),
    foreMastheadBlock: mastheadBlock(
      FORE_AXIS,
      FORE_HOUNDS_Y - 0.15,
      foreWeatherSide,
    ),
    mainFifePin: fifePin(FIFE_RAILS[0], 0, mainWeatherSide),
    foreFifePin: fifePin(FIFE_RAILS[1], 0, foreWeatherSide),
    // The fisherman's sheet and fall remain together on the weather cheek.
    fishermanSheetBlock: p(
      fishermanWeatherSide * 0.24,
      FISHERMAN_SHEET_BLOCK_Y,
      mastZAt(MAIN_AXIS, FISHERMAN_SHEET_BLOCK_Y) + 0.1,
    ),
    fishermanFifePin: fifePin(FIFE_RAILS[0], 1, fishermanWeatherSide),
    // Headsail sheet leads live in port/starboard pairs on the bulwark; the
    // rope leads to whichever side the clew is sheeted to. The node NAMES
    // are stable — only the position jumps to the mirrored fitting — so
    // every rope keeps exactly one pin (the pin-per-rope contract) and the
    // spare fitting on the weather side is just drawn timber.
    ...Object.fromEntries(
      (
        [
          ['staysail', trims.foreStaysail],
          ['jib', trims.jib],
          ['flyingJib', trims.flyingJib],
        ] as const
      ).flatMap(([station, trim]) => {
        const z = SHEET_STATIONS.find((s) => s.name === station)!.z;
        const side = trim >= 0 ? (1 as const) : (-1 as const);
        return [
          [`${station}Fairlead`, sheetFairlead(z, side)],
          [`${station}Pin`, sheetPin(z, side)],
        ];
      }),
    ),
  };
}

/**
 * Apply a live trim to the graph **in place** and return the undo.
 *
 * `RIG_NODES` entries are shared object references: `SPARS` heads, sail
 * corner resolution, rigging run endpoints and block anchors all read the
 * same objects, so moving the ~20 trim-driven nodes moves everything the
 * loft derives from them. The undo restores the exact prior coordinates —
 * callers wrap a loft in apply/finally-restore so module state never leaks.
 * (Physics does not come through here: the aero derives its geometry purely
 * per substep. This path exists for the loft and for geometry tests.)
 */
export function applyRigTrim(
  trims: Readonly<RigTrimAnglesRad>,
  hoists: RigHoistFractions = FULLY_HOISTED,
): () => void {
  const moved = trimmedRigNodePositions(trims, hoists);
  const saved: Array<[RigPoint, number, number, number]> = [];
  for (const [name, position] of Object.entries(moved)) {
    const node = RIG_NODES[name];
    if (!node) throw new Error(`rig: overlay names unknown node "${name}"`);
    saved.push([node, node.x, node.y, node.z]);
    node.x = position.x;
    node.y = position.y;
    node.z = position.z;
  }
  return () => {
    for (const [node, x, y, z] of saved) {
      node.x = x;
      node.y = y;
      node.z = z;
    }
  };
}

// --- trim limits, derived from the rig ---------------------------------------

/**
 * Min distance from a sampled segment to another segment, minus clearance.
 * `tStart` skips the attachment end of the swinging spar: a gaff's jaws ride
 * *on* the mast and its throat sits just below the hounds where every shroud
 * converges, so the inboard fifth of the spar is legitimately near timber
 * and rope at every angle — the same reasoning as the sail suite's
 * mast-attachment exemption. The swing question is about the outboard length.
 */
function sweptSegmentClearance(
  a0: RigPoint | MutableRigPoint,
  a1: RigPoint | MutableRigPoint,
  b0: RigPoint,
  b1: RigPoint,
  clearance: number,
  tStart = 0,
): number {
  const ax = b1.x - b0.x;
  const ay = b1.y - b0.y;
  const az = b1.z - b0.z;
  const l2 = Math.max(ax * ax + ay * ay + az * az, 1e-12);
  let worst = Infinity;
  const SAMPLES = 40;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = tStart + (1 - tStart) * (i / SAMPLES);
    const px = a0.x + (a1.x - a0.x) * t;
    const py = a0.y + (a1.y - a0.y) * t;
    const pz = a0.z + (a1.z - a0.z) * t;
    let u = ((px - b0.x) * ax + (py - b0.y) * ay + (pz - b0.z) * az) / l2;
    u = Math.min(Math.max(u, 0), 1);
    worst = Math.min(
      worst,
      Math.hypot(px - (b0.x + ax * u), py - (b0.y + ay * u), pz - (b0.z + az * u)) - clearance,
    );
  }
  return worst;
}

interface SwingObstacle {
  a: RigPoint;
  b: RigPoint;
  radius: number;
}

/** Standing rigging and mast timber the swinging spars must clear. */
function swingObstacles(): SwingObstacle[] {
  const obstacles: SwingObstacle[] = [];
  for (const run of STANDING_RIGGING) {
    obstacles.push({ a: rigNode(run.from), b: rigNode(run.to), radius: run.diameter / 2 });
  }
  for (const spar of SPARS) {
    if (
      spar.name === 'mainmast' ||
      spar.name === 'foremast' ||
      spar.name === 'mainTopmast' ||
      spar.name === 'foreTopmast'
    ) {
      obstacles.push({
        a: spar.heel,
        b: spar.head,
        radius: (spar.heelRadius + spar.headRadius) / 2,
      });
    }
  }
  return obstacles;
}

/** Clearance margin beyond touching timber-to-rope, metres. */
const TRIM_LIMIT_MARGIN = 0.05;

/**
 * How far a boom-and-gaff pair can swing before spar meets standing rigging.
 * Swept on the port (+) side; the rig's standing plan is symmetric to within
 * the masthead eye offsets (0.14 m, treated as symmetric), so the starboard
 * limit is the mirror.
 */
function boomSwingLimitRad(which: 'main' | 'fore'): number {
  const obstacles = swingObstacles();
  const boomSpar = SPARS.find((s) => s.name === `${which}Boom`)!;
  const gaffSpar = SPARS.find((s) => s.name === `${which}Gaff`)!;
  const boomRadius = (boomSpar.heelRadius + boomSpar.headRadius) / 2;
  const gaffRadius = (gaffSpar.heelRadius + gaffSpar.headRadius) / 2;
  const gooseneck = rigNode(`${which}Gooseneck`);
  const boomEndY = which === 'main' ? MAIN_BOOM_END_Y : FORE_BOOM_END_Y;
  const boomEndAt = which === 'main' ? mainBoomEndSwungAt : foreBoomEndSwungAt;
  // Swept fully hoisted, and that is the binding case: measured, a lowered
  // gaff clears the standing rigging by *more* at every sheet angle (at hard
  // out, 0.05 m peaked against 0.34 m near struck), because it comes down
  // inside the cone the shrouds spread away from. `ship-rig.test.ts` measures
  // it rather than leaving it to this comment.
  const gaffAt = which === 'main' ? mainGaffAt : foreGaffAt;

  const STEP = 0.5 * DEG;
  let last = 0;
  for (let angle = 0; angle <= 120 * DEG; angle += STEP) {
    const boomEnd = boomEndAt(angle);
    const gaff = gaffAt(angle);
    const boomTip = { x: boomEnd.x, y: boomEndY, z: boomEnd.z };
    const throat = gaff.throat;
    const peakTip = gaff.peak;
    let clear = Infinity;
    for (const obstacle of obstacles) {
      clear = Math.min(
        clear,
        sweptSegmentClearance(
          gooseneck,
          boomTip,
          obstacle.a,
          obstacle.b,
          boomRadius + obstacle.radius + TRIM_LIMIT_MARGIN,
          0.1,
        ),
        sweptSegmentClearance(
          throat,
          peakTip,
          obstacle.a,
          obstacle.b,
          gaffRadius + obstacle.radius + TRIM_LIMIT_MARGIN,
          0.2,
        ),
      );
    }
    if (clear < 0) break;
    last = angle;
  }
  return last;
}

/** How far the yards brace before an arm meets the standing rigging. */
function braceSwingLimitRad(): number {
  const obstacles = swingObstacles();
  const STEP = 0.5 * DEG;
  let last = 0;
  for (let angle = 0; angle <= 90 * DEG; angle += STEP) {
    const lower = yardArms(LOWER_YARD_Y, LOWER_YARD_HALF_SPAN, false, angle);
    const upper = yardArms(TOPSAIL_YARD_Y, TOPSAIL_YARD_HALF_SPAN, true, angle);
    let clear = Infinity;
    for (const obstacle of obstacles) {
      for (const yard of [lower, upper]) {
        clear = Math.min(
          clear,
          sweptSegmentClearance(
            yard.sling,
            yard.port,
            obstacle.a,
            obstacle.b,
            YARD_R_ARM + obstacle.radius + TRIM_LIMIT_MARGIN,
          ),
          sweptSegmentClearance(
            yard.sling,
            yard.starboard,
            obstacle.a,
            obstacle.b,
            YARD_R_ARM + obstacle.radius + TRIM_LIMIT_MARGIN,
          ),
        );
      }
    }
    if (clear < 0) break;
    last = angle;
  }
  return last;
}

/**
 * The headsails have no hard spar stop: what limits a headsail sheet is
 * cloth fouling the adjacent stay, which is a *sail* question, not a spar
 * question. This cap is provisional; `tests/ship-rig.test.ts`'s trim
 * envelope sweep asserts the whole box is intersection-free, so if the cap
 * is too generous the sweep, not a player, finds it.
 */
const HEADSAIL_EASE_LIMIT_DEG = 60;

export interface TrimLimitDeg {
  readonly minDeg: number;
  readonly maxDeg: number;
}

/**
 * Mechanical trim limits, degrees, positive toward port — derived from the
 * rig's own geometry at module load (boom and gaff against shrouds and
 * stays; yardarms against the standing rigging), symmetric per the sweep
 * note above. The fisherman's "trim" is its fixed sheet magnitude, both
 * signs. The gaff topsail is slaved and carries the mainsail's limits.
 */
export const RIG_TRIM_LIMITS: Readonly<Record<SailName, TrimLimitDeg>> = (() => {
  const main = boomSwingLimitRad('main') / DEG;
  const fore = boomSwingLimitRad('fore') / DEG;
  const brace = braceSwingLimitRad() / DEG;
  const fisherman = SHEET_FISHERMAN / DEG;
  const limit = (deg: number): TrimLimitDeg =>
    Object.freeze({ minDeg: -deg, maxDeg: deg });
  return Object.freeze({
    mainsail: limit(main),
    foresail: limit(fore),
    foreStaysail: limit(HEADSAIL_EASE_LIMIT_DEG),
    jib: limit(HEADSAIL_EASE_LIMIT_DEG),
    flyingJib: limit(HEADSAIL_EASE_LIMIT_DEG),
    foreTopsail: limit(brace),
    mainTopmastStaysail: limit(fisherman),
    mainGaffTopsail: limit(main),
  });
})();

export function foreBoomClearance(): number {
  const gooseneck = rigNode('foreGooseneck');
  const end = rigNode('foreBoomEnd');
  const rise = end.y - gooseneck.y;
  const length = Math.hypot(end.x - gooseneck.x, rise, end.z - gooseneck.z);
  const run = Math.sqrt(Math.max(length * length - rise * rise, 0));
  const boom = SPARS.find((sp) => sp.name === 'foreBoom');
  const mast = SPARS.find((sp) => sp.name === 'mainmast');
  if (!boom || !mast) return Infinity;
  const clear = (boom.heelRadius + boom.headRadius) / 2 + (mast.heelRadius + mast.headRadius) / 2;

  let worst = Infinity;
  // Amidships is the tightest and swinging out only opens it, but the whole arc
  // is swept rather than assumed — the mast rakes aft, so which angle binds is a
  // result rather than something to reason about.
  for (let step = 0; step <= 60; step++) {
    const angle = (step * Math.PI) / 180;
    const tip = p(
      gooseneck.x + run * Math.sin(angle),
      gooseneck.y + rise,
      gooseneck.z - run * Math.cos(angle),
    );
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const bx = gooseneck.x + (tip.x - gooseneck.x) * t;
      const by = gooseneck.y + (tip.y - gooseneck.y) * t;
      const bz = gooseneck.z + (tip.z - gooseneck.z) * t;
      const ax = mast.head.x - mast.heel.x;
      const ay = mast.head.y - mast.heel.y;
      const az = mast.head.z - mast.heel.z;
      const l2 = ax * ax + ay * ay + az * az;
      let u = ((bx - mast.heel.x) * ax + (by - mast.heel.y) * ay + (bz - mast.heel.z) * az) / l2;
      u = Math.min(Math.max(u, 0), 1);
      worst = Math.min(
        worst,
        Math.hypot(
          bx - (mast.heel.x + ax * u),
          by - (mast.heel.y + ay * u),
          bz - (mast.heel.z + az * u),
        ) - clear,
      );
    }
  }
  return worst;
}
