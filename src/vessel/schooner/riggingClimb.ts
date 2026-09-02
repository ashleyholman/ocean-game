import { EMBODIED_PITCH_MAX, EMBODIED_PITCH_MIN } from '../../camera/cameraTuning';
import { DEFAULT_WALKER_TUNING } from '../../player/DeckWalker';
import type { SeatPose } from '../../player/SeatedStation';
import { deckStandAt } from './deckSurface';
import { railSection } from './hullForm';
import {
  EYE_ABOVE_RUNG,
  FUTTOCK_STAVE_Y,
  LOOKOUT_Z_AFT,
  foreRungsY,
  LOOKOUT_DECK_Y,
  LOOKOUT_HALF_SPAN,
  foreGangFoot,
  foreGangGapAt,
  futtockAt,
  futtockRungY,
  lookoutEye,
} from './lookout';
import { RATLINE_SPACING } from './rig';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * Going aloft, as an authored path in the ship's frame.
 *
 * `docs/ship/SHIP_SPEC.md` §15 and `SHIP_ROUND_HANDOVER.md` §3.4 settle the
 * architecture before this file exists: *"a ladder volume or spline attached to
 * the ship's reference frame — not physical hand placement on individual ropes,
 * not deforming rope traversal, not IK, not collision with every ratline"*, and
 * §3.4 adds "Decided; do not relitigate at M5." So this is a spline, and the
 * only question it answers is where the eye is at each point along it.
 *
 * THE SPLINE IS THE EYE'S PATH, NOT THE BODY'S
 * --------------------------------------------
 * That is the whole of what "no IK" buys, and it is worth stating because the
 * alternative reading costs a round. A foot path would need a body above it, a
 * body needs a posture, a posture aloft is a lean, and a lean is the inverse
 * kinematics the handover ruled out. What a player has is an eye; what the ship
 * has is rungs. So the anchors below carry **both**: an `eye`, which is what the
 * camera is given, and a `hold`, which is the piece of the ship a body would
 * have its weight on at that moment.
 *
 * The holds are not decoration. They are what makes "the climb is continuous"
 * a measurable claim rather than a look: `tests/ship-aloft.test.ts` walks the
 * whole ladder — deck, caprail, every drawn ratline of the gang, the futtock
 * stave, the futtock rungs, the planking — and asserts no two consecutive holds
 * are further apart than a body can step. The rungs come from `RATLINES`, so a
 * spacing change in `rig.ts` fails this rather than quietly leaving a gap.
 *
 * WHERE THE EYE SITS RELATIVE TO THE ROPES, AND WHY IT MATTERS
 * ------------------------------------------------------------
 * `EYE_OUTBOARD_OF_SHROUDS` puts the eye **outside** the plane of the gang, so
 * every rung, both shrouds and the mast beyond them are between the player and
 * the ship. That is not a flourish: it is the only arrangement in which the
 * climb is visible at all. Facing outboard from a point outboard of the rigging
 * there is nothing in shot but sea, and a nine-metre traverse with no near
 * geometry reads as a lift rather than a climb. It is also what a body does —
 * you climb the outside of the weather rigging and lean into it.
 *
 * That single fact decides the pose's facing too. See `climbPose`.
 *
 * PORT AND STARBOARD ARE ONE EXPRESSION WITH A SIGN
 * -------------------------------------------------
 * Both gangs are drawn, both are climbable, and neither is typed out twice.
 * `xLo` and `xHi` invert across the centreline and a mirrored pair written by
 * hand is exactly where that gets forgotten — the captain's quarters round paid
 * for that lesson and it is written into the handover as a standing rule.
 */

/** +1 is port, −1 is starboard, the same sign the rest of the hull uses. */
export type ClimbSide = 1 | -1;

export const CLIMB_SIDES: readonly ClimbSide[] = [1, -1];

/**
 * How far outboard of the shroud plane the eye rides, metres.
 *
 * A climber's chest is against the ropes and their head is above their hands,
 * so the eye stands off the plane by rather less than a body's depth. 0.22 m
 * keeps the near rungs about two hand-breadths from the lens — outside the
 * 0.06 m near plane by a wide margin — and keeps the whole gang in shot.
 */
const EYE_OUTBOARD_OF_SHROUDS = 0.22;

/**
 * How far the eye is above the caprail while a body is astride it, metres.
 *
 * Lower again: one leg is over the rail and the body is folded. This is the
 * lowest posture on the climb and it is the moment the ship's side goes past
 * the lens.
 */
const EYE_ASTRIDE_RAIL = 1.3;

/** How far the eye is above the planking while coming over the rim, metres. */
const EYE_OVER_RIM = 1.3;

/** How far in from the corner a foot lands, coming over the edge, metres. */
const RIM_FOOTHOLD_INSET = 0.1;

/**
 * How far outboard of the platform's edge the eye is while a body is on the
 * futtocks, metres.
 *
 * Outboard only, and directly over where the futtocks land — which is the after
 * edge, for the reason `futtockHeads` gives. A head has to get past the edge of
 * a platform to arrive on top of it, and 0.15 m is what that costs.
 *
 * **Small, and it took three measurements to learn why the generous value was
 * worse.** This corner of the ship is the busiest half metre on her: the fore
 * topmast backstay comes down through it to the after deadeye, and the fore gaff
 * at full ease sweeps up under it. Leaning 0.20 m out and 0.11 m aft put the eye
 * 92 mm from the backstay and 71 mm from the gaff's timber — both outside the
 * 0.06 m near plane and both, on any honest reading, a spar in the player's
 * face. Straight out over the futtocks it is 227 mm and 134 mm, and the
 * after-outboard stanchion is 0.15 m away, which is a hand on the rail rather
 * than a post through the screen.
 *
 * The lesson generalises and is worth the paragraph: **aloft, "give it more
 * room" is a direction, not a quantity.** There was more room; it was in the
 * other direction.
 */
const RIM_LEAN = 0.15;

/**
 * How far inboard of the bulwark's inner face a body stands to start.
 *
 * A body's own radius, and 0.06 m of daylight so the walker is not authored
 * standing in the planking it is stopped by.
 */
const CLIMB_START_INBOARD = DEFAULT_WALKER_TUNING.radius + 0.06;

/** What a body has its weight on at an anchor. */
export type HoldKind = 'deck' | 'caprail' | 'ratline' | 'stave' | 'futtockRung' | 'planking';

export interface ClimbAnchor {
  readonly name: string;
  /** Where the camera is — what the spline interpolates. */
  readonly eye: Vec3;
  /** What the body has its weight on there. */
  readonly hold: Vec3;
  readonly holdKind: HoldKind;
}

/**
 * The fore-and-aft station of the deck end: the middle of the gang.
 *
 * A gang's three deadeyes span 0.76 m of channel, and a body starting the climb
 * stands in the middle of them, which is what `foreGangFoot` is the mean of.
 */
function gangStationZ(side: ClimbSide): number {
  return foreGangGapAt(side, foreGangFoot(side).y).z;
}

/**
 * The eye of a body whose feet are on the gang at `holdY`.
 *
 * **The gang is asked about the feet and not about the eye**, and the difference
 * is not subtle: a shroud gang converges on the masthead, so asking it where it
 * is 1.48 m higher up puts the eye that much further inboard than the body it
 * belongs to. The first cut of this file did exactly that and the top of the
 * climb came out *inside the foremast* — 103 mm inside it — because at an eye
 * height of 13.08 m the gang's own line has run past the hounds at 12.60 and is
 * being extrapolated out the other side. A body is vertical; its head is over
 * its feet; the standoff and the rise are applied to where the feet are.
 */
function gangEyeAt(side: ClimbSide, holdY: number): Vec3 {
  const gang = foreGangGapAt(side, holdY);
  return v3(gang.x + side * EYE_OUTBOARD_OF_SHROUDS, holdY + EYE_ABOVE_RUNG, gang.z);
}

export { foreRungsY };

/**
 * The named anchors, in order from the deck to the lookout.
 *
 * Eight, and §15 asks for exactly this shape — "climb-start, one or more
 * transitions, and lookout-standing". The six in the middle are the places the
 * *kind* of climbing changes: over the rail onto the rigging, up the gang, out
 * onto the futtocks, and over the rim. Nothing here is a waypoint added to
 * smooth a curve; the curve is smooth because the gang is a straight line and
 * collinear control points reproduce it exactly.
 *
 * THE LAST THREE ARE WHERE ALL THE DIFFICULTY IS
 * ----------------------------------------------
 * `shroudHead` is the last anchor on the vertical part of the ladder, and it is
 * a rung below the stave rather than at it, so that the whole gang stretch is
 * a body standing straight up over its own feet. From `futtockStave` the eye is
 * already **outboard of the platform's rim**, because that is what a body on
 * futtock shrouds is: leaning back with its head outside the top it is climbing
 * onto. `FUTTOCK_STAVE_Y` explains why that lean has to have happened before the
 * eye reaches the planking, and why the stave's height is derived from a body's
 * own eye rather than chosen for looks.
 */
export function climbAnchors(side: ClimbSide): readonly ClimbAnchor[] {
  const z = gangStationZ(side);
  const rail = railSection(z);
  const startX = side * (rail.innerX - CLIMB_START_INBOARD);
  const deck = deckStandAt(startX, z);
  if (!deck) throw new Error('the fore shrouds have no deck at their foot');

  const rungs = foreRungsY(side);
  const entryY = rungs.find((y) => y > rail.capY);
  if (entryY === undefined) throw new Error('no ratline stands above the caprail');
  const gangRungs = rungs.filter((y) => y > rail.capY && y <= FUTTOCK_STAVE_Y);
  const headY = gangRungs[Math.max(gangRungs.length - 3, 0)];
  const midY = gangRungs[Math.floor(gangRungs.length / 2)];

  const railEye = v3(side * rail.capOuterX, rail.capY + EYE_ASTRIDE_RAIL, z);
  // Where a foot lands coming over: inboard of the after-outboard corner by a
  // hand's breadth in both directions, so the first thing a body stands on is
  // planking rather than its own edge.
  const rim = v3(
    side * (LOOKOUT_HALF_SPAN - RIM_FOOTHOLD_INSET),
    LOOKOUT_DECK_Y,
    LOOKOUT_Z_AFT + RIM_FOOTHOLD_INSET,
  );
  const leanX = side * (LOOKOUT_HALF_SPAN + RIM_LEAN);
  const leanZ = LOOKOUT_Z_AFT;
  const stave = foreGangGapAt(side, FUTTOCK_STAVE_Y);
  const stand = lookoutEye(side);

  return [
    {
      name: 'climbStart',
      eye: v3(startX, deck.y + DEFAULT_WALKER_TUNING.eyeHeight, z),
      hold: v3(startX, deck.y, z),
      holdKind: 'deck',
    },
    {
      name: 'railCrossing',
      eye: railEye,
      hold: v3(side * (rail.capOuterX + rail.capInnerX) * 0.5, rail.capY, z),
      holdKind: 'caprail',
    },
    {
      name: 'shroudFoot',
      eye: gangEyeAt(side, entryY),
      hold: foreGangGapAt(side, entryY),
      holdKind: 'ratline',
    },
    {
      name: 'shroudMid',
      eye: gangEyeAt(side, midY),
      hold: foreGangGapAt(side, midY),
      holdKind: 'ratline',
    },
    {
      name: 'shroudHead',
      eye: gangEyeAt(side, headY),
      hold: foreGangGapAt(side, headY),
      holdKind: 'ratline',
    },
    {
      name: 'futtockStave',
      // Outboard already: the body has swung out onto the futtocks and its head
      // is outside the top. It has to be — see `FUTTOCK_STAVE_Y`.
      eye: v3(leanX, FUTTOCK_STAVE_Y + EYE_ABOVE_RUNG, leanZ),
      hold: stave,
      holdKind: 'stave',
    },
    {
      name: 'topRim',
      eye: v3(leanX, LOOKOUT_DECK_Y + EYE_OVER_RIM, leanZ),
      hold: rim,
      holdKind: 'planking',
    },
    {
      name: 'lookoutStand',
      eye: stand,
      hold: v3(stand.x, LOOKOUT_DECK_Y, stand.z),
      holdKind: 'planking',
    },
  ];
}

/**
 * Every hold on the ladder, in order — the anchors' own, plus every drawn rung
 * between them.
 *
 * This is the list the continuity gate walks, and it is derived rather than
 * typed: the ratlines come from `RATLINES` and the futtock rungs from
 * `futtockRungY()`, so a change to `RATLINE_SPACING` in `rig.ts` shows up here
 * as a gap a body cannot step rather than as nothing at all.
 *
 * The rungs *below* the caprail are deliberately not on it. They are drawn —
 * a gang is rattled down to its channel — but they are outboard of the bulwark
 * at chest height from a boat alongside, which is what they are for. A body
 * already on deck goes over the rail.
 */
export interface ClimbHold {
  readonly at: Vec3;
  readonly kind: HoldKind;
}

export function climbHolds(side: ClimbSide): ClimbHold[] {
  const anchors = climbAnchors(side);
  const rail = anchors[1];
  const out: ClimbHold[] = [
    { at: anchors[0].hold, kind: 'deck' },
    { at: rail.hold, kind: 'caprail' },
  ];
  for (const y of foreRungsY(side)) {
    // Up to the stave and no further, and **not including it**: the stave is
    // seized across the gang *at* a ratline's height, so a rung and a stave at
    // the same height are one hold and not two. The gang goes on being rattled
    // down above it — a man bound for the masthead itself keeps climbing — but
    // the climb leaves the vertical there and the holds say what the spline
    // says.
    if (y <= rail.hold.y || y >= FUTTOCK_STAVE_Y - 1e-9) continue;
    out.push({ at: foreGangGapAt(side, y), kind: 'ratline' });
  }
  out.push({ at: foreGangGapAt(side, FUTTOCK_STAVE_Y), kind: 'stave' });
  for (const y of futtockRungY()) {
    // Midway across the futtock pair, which is where a foot goes on a rung
    // seized between two ropes.
    out.push({ at: futtockRungHold(side, y), kind: 'futtockRung' });
  }
  const rim = anchors[anchors.length - 2];
  out.push({ at: rim.hold, kind: 'planking' });
  const stand = anchors[anchors.length - 1];
  out.push({ at: v3(stand.hold.x, LOOKOUT_DECK_Y, stand.hold.z), kind: 'planking' });
  return out;
}

function futtockRungHold(side: ClimbSide, y: number): Vec3 {
  // The futtocks splay fore-and-aft from one foot to two heads, so the middle of
  // a rung is the mean of the two — asked of the same function the loft draws
  // them with, rather than reconstructed here from the same three numbers.
  const forward = futtockAt(side, y, 0);
  const aft = futtockAt(side, y, 1);
  return v3((forward.x + aft.x) / 2, y, (forward.z + aft.z) / 2);
}

/** The step from the deck over the caprail — the one hold-to-hold gap that is
 * not a rung, and the only one allowed to be a stride rather than a step. */
export const RAIL_CROSSING_ALLOWANCE = 1.05;

/** Anything else: a rung's spacing, with room for the diagonal of one. */
export const RUNG_STEP_ALLOWANCE = RATLINE_SPACING + 0.24;

// --- the spline --------------------------------------------------------------

/** Samples per anchor span. Enough that the arc-length table is exact to ~1 mm. */
const SAMPLES_PER_SPAN = 48;

interface ClimbCurve {
  readonly points: readonly Vec3[];
  /** Cumulative arc length at each sample, starting at zero. */
  readonly arc: readonly number[];
  readonly length: number;
}

const curves = new Map<ClimbSide, ClimbCurve>();

/**
 * Centripetal Catmull–Rom through the anchors.
 *
 * Centripetal rather than uniform because the anchor spacing is wildly uneven —
 * 0.6 m over the rail, 3.5 m up the gang — and uniform Catmull–Rom answers that
 * with a loop in the short span. Centripetal is the parameterisation that
 * provably has no cusp and no self-intersection whatever the spacing, which is
 * the property a path a player is carried along has to have.
 *
 * The ends are handled by reflecting the first and last spans, so the curve
 * starts and ends exactly on `climbStart` and `lookoutStand` with the tangent
 * the anchors imply.
 */
function buildCurve(side: ClimbSide): ClimbCurve {
  const anchors = climbAnchors(side).map((a) => a.eye);
  const control: Vec3[] = [
    reflect(anchors[0], anchors[1]),
    ...anchors,
    reflect(anchors[anchors.length - 1], anchors[anchors.length - 2]),
  ];
  const points: Vec3[] = [];
  for (let i = 1; i + 2 < control.length; i++) {
    for (let j = 0; j < SAMPLES_PER_SPAN; j++) {
      const u = j / SAMPLES_PER_SPAN;
      points.push(catmullRom(control[i - 1], control[i], control[i + 1], control[i + 2], u));
    }
  }
  points.push(control[control.length - 2]);

  const arc: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    arc.push(arc[i - 1] + distance(points[i - 1], points[i]));
  }
  return { points, arc, length: arc[arc.length - 1] };
}

function curve(side: ClimbSide): ClimbCurve {
  let found = curves.get(side);
  if (!found) {
    found = buildCurve(side);
    curves.set(side, found);
  }
  return found;
}

function reflect(end: Vec3, inner: Vec3): Vec3 {
  return v3(2 * end.x - inner.x, 2 * end.y - inner.y, 2 * end.z - inner.z);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** Centripetal knot spacing: the fourth root of the squared chord. */
function knot(t: number, a: Vec3, b: Vec3): number {
  const next = t + Math.sqrt(distance(a, b));
  // Two coincident control points would make a zero-width knot span and divide
  // by nought; nothing aboard produces one, and a spline that silently returns
  // NaN is not something to leave to nothing aboard producing one.
  return next > t ? next : t + 1e-6;
}

function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;
  const a1 = mix(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
  const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
  const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
  const b1 = mix(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
  const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
  return mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
}

function mix(a: Vec3, b: Vec3, wa: number, wb: number): Vec3 {
  return v3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb);
}

/** How long the climb is, in metres of path. */
export function climbLength(side: ClimbSide): number {
  return curve(side).length;
}

/**
 * The eye at a fraction of the way up, by **arc length** and not by parameter.
 *
 * The distinction is the difference between a climb and a lurch: a spline's own
 * parameter runs fast through the long straight and slow round the corners, so a
 * body advanced at a constant rate in `u` would sprint up the gang and stall at
 * the rail. Advanced by arc length it moves at one speed, which is what a body
 * on a ladder does.
 */
export function climbEyeAt(side: ClimbSide, progress: number): Vec3 {
  const c = curve(side);
  const target = Math.min(Math.max(progress, 0), 1) * c.length;
  let lo = 0;
  let hi = c.arc.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (c.arc[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = c.arc[hi] - c.arc[lo];
  const t = span > 1e-9 ? (target - c.arc[lo]) / span : 0;
  return mix(c.points[lo], c.points[hi], 1 - t, t);
}

/** Where along the climb each named anchor falls, as a progress fraction. */
export function anchorProgress(side: ClimbSide): number[] {
  const anchors = climbAnchors(side);
  const c = curve(side);
  return anchors.map((anchor) => {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < c.points.length; i++) {
      const gap = distance(c.points[i], anchor.eye);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return c.arc[best] / c.length;
  });
}

/**
 * How fast a body goes up and down the rigging, metres of path per second.
 *
 * 1.05, against the 1.20 m/s `WalkerTuning.ladderSpeed` uses for the companion
 * ladder below. A shroud is not a companion ladder: the rungs are rope, they
 * give under a foot, and the gang narrows the whole way up. The whole traverse
 * is about ten metres of path, so this is roughly ten seconds from the deck to
 * the top, which is what it takes a man who is not showing off.
 *
 * **One rate in both directions**, which is the same decision `ladderSpeed`
 * records and for the same reason: two rates are two accidents. Coming down a
 * shroud faster than you went up is a thing a sailor does and a thing a camera
 * should not do.
 */
export const CLIMB_SPEED = 1.05;

/** Where the head is aimed as the climb begins: up the way it is going. */
const CLIMB_PITCH = (14 * Math.PI) / 180;

/** And on arrival: level, at the horizon it came up here to see. */
const LOOKOUT_PITCH = 0;

/**
 * Facing while climbing: inboard, at the rigging.
 *
 * The camera looks down its own −Z, so yaw 0 faces the ship's −z (aft) and +π/2
 * faces −x (starboard). Inboard from port is therefore +π/2, and one expression
 * covers both gangs — see `seatedBody.facingYaw`, which is where the four
 * quarter-turns are written down.
 */
function climbYaw(side: ClimbSide): number {
  return side * Math.PI * 0.5;
}

/**
 * Facing on arrival: off her own bow, and **deliberately not dead ahead**.
 *
 * The obvious answer is the bow, and looking at the ship is what says it is
 * wrong. The square fore topsail's foot is bent to the lower yard at 12.45 m and
 * its head is at 18.20, so from the fore top the cloth stands about half a metre
 * forward of the lookout's face and 2.7 m either side of her — **set, it is the
 * forward view.** Measured: 0.38 m at the worst brace on the port top, 0.42 m on
 * the starboard. That is true of the vessel rather than a fault in her; what
 * would be a fault is arriving at the masthead pointed at the back of a sail.
 *
 * 150° off the stern on her own side is the sector a lookout on a top actually
 * has — from the beam round toward the bow on the side she is standing, clear of
 * the cloth and clear of the doubling. The other bow belongs to the other gang,
 * or to whoever is on deck.
 */
function lookoutYaw(side: ClimbSide): number {
  return -side * LOOKOUT_BEARING;
}

const LOOKOUT_BEARING = (150 * Math.PI) / 180;

/**
 * How much of the climb the turn from one to the other takes.
 *
 * The last fifth, and it costs nothing, because `yawRange` is a half-turn either
 * way and therefore never clamps: the pose's facing is read only by the settle
 * on entry and by `snapToSeat`. A player who climbs up keeps whatever they were
 * looking at; one who is *placed* at the top — the review entry point, and
 * whatever a later round adds — arrives looking out rather than at the mast.
 */
const ARRIVAL_BEGINS = 0.8;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Turn from one bearing to another the short way round. */
function turnBy(from: number, to: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return from + delta * t;
}

/**
 * The pose at a point on the climb.
 *
 * FACING, AND WHY IT IS THE ONE THING THE POSE INSISTS ON
 * -------------------------------------------------------
 * Inboard on the way up, and off her own bow on arrival — `climbYaw` and
 * `lookoutYaw` each argue their own. The climbing half matters because the eye
 * rides outboard of the gang, so the ropes, the rungs, the mast and the whole
 * ship are on one side of it: face the other way and the climb is nine metres of
 * empty sea. Both are used only on a settle, and after that the cone below
 * leaves the head alone.
 *
 * WHY THERE IS NO CONE, WHICH IS A DECISION AND NOT AN OMISSION
 * -------------------------------------------------------------
 * Every other station aboard clamps the head, and `SeatPose.yawRange` calls the
 * width "the whole design" — a seated view that can spin is a chair in a room
 * that stopped existing. Aloft that argument inverts. A lookout's entire purpose
 * is to look everywhere, the accept-when asks in as many words for "an
 * unobstructed horizon and a view down over the deck", and a clamp that dragged
 * the view round as the pose turned would be a camera moving by itself at the
 * one place on the ship where the player is least able to brace against it.
 * So the range is a full half-turn either way and the pitch limits are the
 * embodied camera's own: the station holds the body and declines to hold the
 * head.
 */
export function climbPose(side: ClimbSide, progress: number): SeatPose {
  const eye = climbEyeAt(side, progress);
  const arriving = smoothstep(ARRIVAL_BEGINS, 1, progress);
  return {
    x: eye.x,
    y: eye.y,
    z: eye.z,
    yaw: turnBy(climbYaw(side), lookoutYaw(side), arriving),
    pitch: CLIMB_PITCH + (LOOKOUT_PITCH - CLIMB_PITCH) * arriving,
    yawRange: Math.PI,
    pitchLo: EMBODIED_PITCH_MIN,
    pitchHi: EMBODIED_PITCH_MAX,
  };
}

/** The lookout's own stance, which is the climb at the top of itself. */
export function lookoutPose(side: ClimbSide): SeatPose {
  return climbPose(side, 1);
}

// --- what a hand points at, and where it may point from ----------------------

/**
 * The gang, as a thing to aim at from the deck.
 *
 * It is the **rigging** and not a patch of deck, and that is the rule this ship
 * has already paid for twice: *an entered box outranks an occupied one*. A
 * target laid on the planking at the foot of the shrouds would be a volume a
 * body stands in on its way to the rail, so it would win the pick against
 * anything a player was actually pointing at — which is precisely how the
 * captain's chair came to eat the cabin's lantern. The shrouds are outboard, up,
 * and nothing walks through them.
 *
 * The box runs from the deadeyes at the channel to head height on the ropes, and
 * from just inboard of the bulwark to just outboard of the deadeyes, so it can
 * be entered by a ray from a body standing inboard of the rail.
 *
 * **`xLo` and `xHi` invert across the centreline** and are ordered by `Math.min`
 * rather than by hand. Writing `xLo: 1.90, xHi: 2.70` and negating both is how
 * the starboard row ends up with `xLo` greater than `xHi`, which is a box that
 * contains nothing and an interactable that silently never appears.
 */
export function shroudTarget(side: ClimbSide): {
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
} {
  const foot = foreGangFoot(side);
  const z = foot.z;
  const rail = railSection(z);
  const inner = side * (rail.innerX - 0.05);
  const outer = side * (Math.abs(foot.x) + 0.18);
  return {
    xLo: Math.min(inner, outer),
    xHi: Math.max(inner, outer),
    yLo: foot.y - 0.1,
    yHi: rail.capY + TARGET_ABOVE_RAIL,
    zLo: z - GANG_TARGET_HALF_SPREAD,
    zHi: z + GANG_TARGET_HALF_SPREAD,
  };
}

/** How far up the ropes the target reaches above the caprail, metres. */
const TARGET_ABOVE_RAIL = 1.25;

/**
 * Half the target's fore-and-aft span.
 *
 * The three deadeyes are 0.38 m apart, so the gang's footprint is 0.76 m wide;
 * this is that, plus a hand's width at each end for the shrouds' own diameter.
 */
const GANG_TARGET_HALF_SPREAD = 0.44;

/**
 * Where a body has to be standing for the offer to be made at all.
 *
 * `REACH` is 2.2 m and the ship is 4.4 m across the waist, so a body at the
 * *other* rail is very nearly within arm's length of these shrouds through the
 * whole width of the vessel — and a body one deck down in the forecastle is
 * nearer still through the planking. Every row in this table names a volume for
 * that reason; this one names the quarter of the weather deck the gang is on.
 */
export function shroudApproach(side: ClimbSide): {
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
} {
  const foot = foreGangFoot(side);
  const deck = deckStandAt(side * (railSection(foot.z).innerX - CLIMB_START_INBOARD), foot.z);
  const deckY = deck ? deck.y : foot.y;
  const outboard = side * (Math.abs(foot.x) + 0.4);
  return {
    // From the centreline outboard: a body on the wrong side of the ship is not
    // going up this gang, and the ship has no beam to spare for ambiguity.
    xLo: Math.min(0, outboard),
    xHi: Math.max(0, outboard),
    yLo: deckY - 0.4,
    yHi: deckY + 2.6,
    zLo: foot.z - APPROACH_HALF_LENGTH,
    zHi: foot.z + APPROACH_HALF_LENGTH,
  };
}

/** How far fore-and-aft of the gang a body may stand and still be offered it. */
const APPROACH_HALF_LENGTH = 1.4;
