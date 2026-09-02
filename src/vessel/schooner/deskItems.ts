import type { FittingSolid } from './deckFittings';
import { chartDeskGeometry } from './captainsDesk';
import { framedBar, framedBox, framedTarget } from './roomFitting';
import { v3 } from './shipwright';
import type { InteractableBox } from '../../player/Interactables';

/**
 * The things lying on the captain's desk, and what happens when you pick one up.
 *
 * WHY A TABLE, AGAIN
 * ------------------
 * This is the third table in the ship built to the same rule — `SHIP_CLOSURES`
 * for the hatches, `INTERIOR_FITTING_KINDS` for what stands in a room, and now
 * this — and the rule is the one worth restating: **one row, read by every
 * system that has an opinion about the thing.** A desk item is drawn by the
 * loft, picked by the pointer, named by the label under the cursor, and opened
 * by the focus layer. Four systems. Written as four lists, the first thing to
 * happen would be a book you can see and cannot click, or a click on a book
 * nobody drew.
 *
 * WHERE AN ITEM SAYS IT IS
 * ------------------------
 * Inside the desk's **well** — the rectangle bounded by the fiddles — and never
 * in ship coordinates. `chartDeskGeometry()` publishes that rectangle and the
 * height of the cloth, so moving the desk moves everything on it, and an item
 * cannot end up floating a centimetre over the baize because two places
 * computed the same top. Same doctrine as `RoomAnchor`, one storey down.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * A general "usable object" system. There are two objects on this desk — the
 * sailing manual and the marine timekeeper — and they share exactly the fields
 * this table carries: geometry, pointer target, label and focused view. A map,
 * log or octant can add what it turns out to need when one actually lands. A
 * table with columns nobody fills is how the closure table would have ended up
 * with a chair in it.
 */

/** Every item on the desk. */
export type DeskItemName = 'sailingManual' | 'chronometer';

/**
 * Which full-screen view an item opens.
 *
 * A name rather than a component, because the geometry must not know what the
 * interface is made of. `deskItems.ts` is imported by the ship's loft, which
 * has no business reaching a DOM module — and the day one of these opens
 * something that is not a book, this stays a string and the focus layer grows a
 * branch.
 */
/**
 * Which face opens. A superset of the desk's own items since WX1: the glass
 * hangs on the lining rather than lying on the desk, but it is picked from the
 * chair with the same cursor and opens into the same overlay, so it shares this
 * union rather than growing a second one.
 */
export type DeskItemView = 'manual' | 'chronometer' | 'barometer';

export interface DeskItem {
  readonly name: DeskItemName;
  /**
   * What it is called, in the words the player sees under the cursor.
   *
   * Shouted, because the joke is the point. Ash asked for "YE OLDE SAILING
   * MANUAL" and the capitals are load-bearing: it is a title stamped on a cover
   * rather than a description of an object, and a sentence-case version of it
   * is not funny.
   */
  readonly label: string;
  readonly view: DeskItemView;
  readonly solids: readonly FittingSolid[];
  /** What the pointer tests against. */
  readonly box: InteractableBox;
}

// --- the manual ---------------------------------------------------------------

/**
 * The book, closed, lying square in front of the chair.
 *
 * Sized as a folio a chart is folded into rather than as a novel: 0.30 m from
 * the spine to the fore-edge and 0.22 m across, 55 mm of boards and leaves. It
 * takes half the depth of the desk, which is what a book that matters looks
 * like on a desk that has one.
 */
const BOOK_DEPTH = 0.30;
const BOOK_WIDTH = 0.22;
const BOARD_THICKNESS = 0.011;
/**
 * The block of leaves.
 *
 * 0.052 rather than the 0.037 this started at, for a reason that only shows up
 * in the seated view: a book lying on a desk is seen almost edge-on, so its
 * thickness is nearly all of the silhouette it has. At 55 mm overall it read as
 * a mat with a pale stripe down it. At 74 mm it reads as a book, which is also
 * about right for a folio somebody actually uses.
 */
const LEAVES_THICKNESS = 0.052;

/**
 * How much bigger than the book the pointer's target is.
 *
 * **Generous, and for a different reason than `REACH`'s cone was.** A standing
 * player aims with their whole head and the cone forgives them; a seated player
 * aims with a cursor, which is exact — so the forgiveness has to be in the
 * target instead. 25 mm all round is about a fingertip on a phone at this
 * distance, and there is nothing else on the desk for it to steal from.
 */
const TARGET_PAD = 0.025;

/**
 * What the boards are bound in.
 *
 * **Not baize, and the first version was — which made the book invisible.** The
 * desk's writing surface is 0.36 m² of green cloth and the book lies in the
 * middle of it; bound in the same material it was a green rectangle on a green
 * rectangle, and the only part of it a player could see was the pale edge of
 * the leaves. Nothing was wrong with the geometry and nothing would have shown
 * up in a test: it was drawn exactly where it was asked for, in a colour that
 * happened to be the colour of the thing behind it.
 *
 * Leather over boards is what a working manual is bound in anyway, and the
 * interior's timber is the nearest thing this palette has to dark leather. The
 * lesson is the cheap one and worth writing down: **an object's material is a
 * statement about what is behind it, not only about what it is.**
 */
const BINDING = 'timber' as const;

/** Side of a brass corner piece. */
const CORNER = 0.05;

function bookPlacement(): { xLo: number; xHi: number; zLo: number; zHi: number; y: number } {
  const d = chartDeskGeometry();
  // Square in front of the chair, which is the knee-hole's own centre — so the
  // book follows the seat rather than sitting where it was typed.
  const zMid = d.kneeZ;
  // Set back from the desk's inboard edge by a hand's breadth, so there is
  // somewhere to rest a wrist and the fiddle is not what a player clicks.
  const xLo = d.wellXLo + 0.10;
  return {
    xLo,
    xHi: xLo + BOOK_DEPTH,
    zLo: zMid - BOOK_WIDTH / 2,
    zHi: zMid + BOOK_WIDTH / 2,
    y: d.clothY,
  };
}

/**
 * A box on the desk, in the desk's own frame.
 *
 * **A book lies square on the desk it is on, not square with the keel**, which
 * is the whole reason this goes through the frame rather than building a solid
 * itself. It is also the reason the dimensions above did not change when the
 * desk turned: a spine along the edge nearest the window and a label inset
 * 70 mm from the boards are both facts about the book.
 */
function span(
  xLo: number,
  xHi: number,
  yLo: number,
  yHi: number,
  zLo: number,
  zHi: number,
  material: FittingSolid['material'],
): FittingSolid {
  return framedBox(
    chartDeskGeometry().frame,
    xLo,
    xHi,
    yLo,
    yHi,
    zLo,
    zHi,
    material,
    // **Nothing on this desk is ever a collider.** Everything here is inside
    // the desk's own footprint, and the desk is solid to its top — so a body
    // stopped by a book would have had to be standing inside the desk first.
    false,
  );
}

/** A round desk item in the desk's own frame, paired with `span`. */
function bar(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radiusA: number,
  radiusB: number,
  material: FittingSolid['material'],
): FittingSolid {
  return framedBar(
    chartDeskGeometry().frame,
    v3(ax, ay, az),
    v3(bx, by, bz),
    radiusA,
    radiusB,
    material,
    false,
  );
}

export function sailingManual(): DeskItem {
  const p = bookPlacement();
  const leavesLo = p.y + BOARD_THICKNESS;
  const leavesHi = leavesLo + LEAVES_THICKNESS;
  const topLo = leavesHi;
  const topHi = topLo + BOARD_THICKNESS;

  // The leaves are inset from the boards on three sides, which is the whole
  // silhouette of a bound book: the boards overhang, and the square of shadow
  // that leaves is what says "cover" rather than "block of wood".
  const inset = 0.008;

  return {
    name: 'sailingManual',
    label: 'YE OLDE SAILING MANUAL',
    view: 'manual',
    solids: [
      span(p.xLo, p.xHi, p.y, p.y + BOARD_THICKNESS, p.zLo, p.zHi, BINDING),
      span(
        p.xLo + inset,
        p.xHi - inset,
        leavesLo,
        leavesHi,
        p.zLo + inset,
        p.zHi - inset,
        'paper',
      ),
      span(p.xLo, p.xHi, topLo, topHi, p.zLo, p.zHi, BINDING),
      // The spine, running along the fore-and-aft edge nearest the window, full
      // height of the block so the leaves do not show through it.
      span(p.xLo, p.xHi, p.y, topHi, p.zLo, p.zLo + 0.018, BINDING),
      // **The label pasted on the front board**, and it is what makes this read
      // as a book at all. Bound and cornered but otherwise bare, the top board
      // is a brown rectangle lying on a desk — the seated eye sees it almost
      // flat-on and there is nothing on it to say which way is up or what it
      // is. A pale panel on a dark cover is how such a book is titled, and it
      // is the one mark on this desk that a player will read as writing without
      // a single letter being drawn.
      span(
        p.xLo + 0.07,
        p.xHi - 0.07,
        topHi,
        topHi + 0.0012,
        p.zLo + 0.055,
        p.zHi - 0.055,
        'paper',
      ),
      // Brass corner pieces, all four. A working book at sea is bound with them
      // — they are what stops the corners going soft in a wet locker — and on
      // this desk they are the only thing that will ever catch a light.
      ...([p.xLo, p.xHi - CORNER] as const).flatMap((cx) =>
        ([p.zLo + 0.018, p.zHi - CORNER] as const).map((cz) =>
          span(cx, cx + CORNER, topHi, topHi + 0.003, cz, cz + CORNER, 'brass'),
        ),
      ),
    ],
    // Padded in the book's own axes and turned with it, which is what makes the
    // 25 mm above mean 25 mm on every edge. Squared up to the ship it would be
    // 25 mm on two of them and 45 on the others — free today, with one object on
    // this desk, and not free the moment a second one lands beside it.
    box: framedTarget(
      chartDeskGeometry().frame,
      p.xLo - TARGET_PAD,
      p.xHi + TARGET_PAD,
      p.y - TARGET_PAD,
      topHi + TARGET_PAD,
      p.zLo - TARGET_PAD,
      p.zHi + TARGET_PAD,
    ),
  };
}

// --- the chronometer ----------------------------------------------------------

/**
 * The longitude watch and its fitted travelling case.
 *
 * **A three-tier gimballed box is the familiar answer and the wrong date.** It
 * became the standard form around 1800. In this vessel's 1765–80 window an
 * expedition lucky enough to carry a reliable timekeeper has something like
 * Larcum Kendall's K1 or K2: a very large pair-cased watch, issued for trials,
 * lying in a protective case. K1 was completed in 1769 and Cook took it to sea
 * in 1772, which makes this a rare government instrument rather than generic
 * ship's equipment — exactly the story an expedition schooner can support.
 *
 * The case is open because a closed mahogany box says nothing at all from the
 * seated view. The round metal body and pale face do the identifying now; no
 * false gimbal ring or later nested box is needed.
 */
const TIMEKEEPER_CASE_X = 0.185;
const TIMEKEEPER_CASE_Z = 0.160;
const TIMEKEEPER_BASE = 0.038;
const TIMEKEEPER_LID_HEIGHT = 0.145;
const TIMEKEEPER_WATCH_RADIUS = 0.058;

/**
 * The marine timekeeper in its case, on the desk beside the manual.
 *
 * WHY IT IS ON THE DESK AND NOT ON A BRACKET
 * ------------------------------------------
 * A chronometer wants to be still, out of the sun and where the man who winds it
 * every morning will not forget it, which argues for a fitted bracket on the
 * bulkhead. It is on the desk because of what selecting it costs: the desk has a
 * pointer, a hover label, a pick in ship-local space and a focus layer, all of
 * them built for this and all of them **seated only**. A bracket on the lining
 * would need a standing pick that does not exist, for an object that is better
 * looked at sitting down anyway.
 *
 * WHY IT OPENS
 * ------------
 * Because it cannot be read otherwise, and Ash said so before it was built: the
 * dial is 0.13 m across, seen from 0.6 m at a 27° downward glance, and a minute
 * hand at that scale is two pixels. The manual's argument exactly — *a thing
 * that takes up the screen is not a thing in the room* — and the same overlay
 * carries both.
 *
 * WHAT IT IS FOR
 * --------------
 * The one instrument aboard that is honestly useful today. It keeps Greenwich
 * time while the sun over the ship keeps local time, and the difference between
 * those two is the ship's longitude — which is not a game mechanic yet, and is
 * the actual reason a vessel of this period carried one at all. The world model
 * has a UTC clock and a longitude already; the dial reads them rather than
 * inventing anything, which is the whole difference between this and the
 * barometer that was cut from the desk round for having nothing behind it.
 */
export function chronometer(): DeskItem {
  const d = chartDeskGeometry();
  // Forward of the book, hard against the fiddle at the desk's outboard edge —
  // where a thing that must not be knocked about actually goes. Not centred on
  // the knee-hole: the sitter's hands work in the middle of the desk.
  const xLo = d.wellXHi - TIMEKEEPER_CASE_X - 0.03;
  const xHi = xLo + TIMEKEEPER_CASE_X;
  const zLo = d.wellZForward - TIMEKEEPER_CASE_Z - 0.10;
  const zHi = zLo + TIMEKEEPER_CASE_Z;
  const y = d.clothY;
  const baseTop = y + TIMEKEEPER_BASE;
  const lidTop = baseTop + TIMEKEEPER_LID_HEIGHT;
  const watchX = (xLo + xHi) / 2;
  const watchZ = (zLo + zHi) / 2;
  const watchTop = baseTop + 0.030;

  const solids: FittingSolid[] = [
    // A shallow mahogany travel case, lined with dark leather so the metal watch
    // and enamel face separate from the timber desk.
    span(xLo, xHi, y, baseTop, zLo, zHi, 'timber'),
    span(
      xLo + 0.014,
      xHi - 0.014,
      baseTop,
      baseTop + 0.004,
      zLo + 0.014,
      zHi - 0.014,
      'leather',
    ),
    // The open lid against the outboard fiddle, with its lining facing the
    // sitter. It still gives the interaction a case to shut without pretending
    // the watch is a later boxed chronometer.
    span(xHi - 0.016, xHi, baseTop, lidTop, zLo, zHi, 'timber'),
    span(
      xHi - 0.019,
      xHi - 0.016,
      baseTop + 0.014,
      lidTop - 0.014,
      zLo + 0.014,
      zHi - 0.014,
      'leather',
    ),
    // Large metal pair case and white enamel dial. A vertical bar is a capped
    // cylinder, which is precisely the solid round watch wanted here; unlike
    // the old fake gimbal it does not lay a cylinder across the thing it means
    // to outline.
    bar(
      watchX,
      baseTop + 0.004,
      watchZ,
      watchX,
      watchTop,
      watchZ,
      TIMEKEEPER_WATCH_RADIUS,
      TIMEKEEPER_WATCH_RADIUS,
      'brass',
    ),
    bar(
      watchX,
      watchTop,
      watchZ,
      watchX,
      watchTop + 0.003,
      watchZ,
      TIMEKEEPER_WATCH_RADIUS - 0.009,
      TIMEKEEPER_WATCH_RADIUS - 0.009,
      'paper',
    ),
    // Winding pendant and two fixed hands. The full-screen face carries the
    // working reading; these marks only make the object legible in the room.
    bar(
      watchX,
      baseTop + 0.012,
      watchZ - TIMEKEEPER_WATCH_RADIUS - 0.010,
      watchX,
      baseTop + 0.030,
      watchZ - TIMEKEEPER_WATCH_RADIUS - 0.010,
      0.012,
      0.010,
      'brass',
    ),
    bar(
      watchX,
      watchTop + 0.006,
      watchZ,
      watchX + 0.030,
      watchTop + 0.006,
      watchZ + 0.010,
      0.003,
      0.003,
      'ironwork',
    ),
    bar(
      watchX,
      watchTop + 0.007,
      watchZ,
      watchX - 0.012,
      watchTop + 0.007,
      watchZ + 0.040,
      0.0025,
      0.0025,
      'ironwork',
    ),
  ];

  return {
    name: 'chronometer',
    label: 'THE MARINE TIMEKEEPER',
    view: 'chronometer',
    solids,
    box: framedTarget(
      d.frame,
      xLo - TARGET_PAD,
      xHi + TARGET_PAD,
      y - TARGET_PAD,
      lidTop + TARGET_PAD,
      zLo - TARGET_PAD,
      zHi + TARGET_PAD,
    ),
  };
}

/** Everything on the desk. */
export function deskItems(): readonly DeskItem[] {
  return [sailingManual(), chronometer()];
}
