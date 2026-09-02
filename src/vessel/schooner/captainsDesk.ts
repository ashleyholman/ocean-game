import type { FittingSolid } from './deckFittings';
import { belowDecksSpace } from './deckInterior';
import { drawnIn, framedTarget, frameToShip, placeInRoom } from './roomFitting';
import type { InteriorFitting, PieceFrame, RoomPlacement } from './roomFitting';
import type { InteractableBox } from '../../player/Interactables';
import { v3 } from './shipwright';

/**
 * The captain's chart desk, the rack over it, and the chair you sit in.
 *
 * WHY IT IS ON THE PORT SIDE, AND WHY THAT IS NOT THE REASON THE PLAN GAVE
 * -----------------------------------------------------------------------
 * `SHIP_BELOW_DECKS_PLAN.md` §4.1 asks for exactly this piece — *"chart desk and
 * drawers along the port side facing inboard with a seat in front of it"* — and
 * justifies it out of §6: furniture goes under the low peripheral portions
 * because 1.85 m of standing height exists only on the central strip, with
 * 1.55–1.70 m tapering at the sides.
 *
 * **That justification does not survive being measured against the ship as
 * built, and it is worth saying so here rather than repeating it.** The cabin's
 * deckhead is 1.83–2.00 m above the sole out at x = 1.2 m, and the lined side is
 * the *same* half-width at the sole as at head height at every station in the
 * room — those topsides are plumb. There is no low peripheral portion in the
 * captain's cabin. A man can stand up against the port lining with his hat on.
 *
 * The desk is on the port side anyway, and the surviving reason is the better
 * half of §4.1: **the centreline is the only route from the door to the stern
 * windows, and it is kept clear.** Furniture against a side is furniture out of
 * the way. The plan reached the right arrangement through a claim about the
 * room that this hull does not make.
 *
 * WHY THE SITTER FACES THE WALL
 * -----------------------------
 * Because that is what a desk is, and because the wall is the interesting part.
 * A chart desk against the ship's side is not a table you sit around — you sit
 * at it, facing outboard, with the pigeonholes at eye level and the desk top
 * under your hands. It also means the thing the seated camera
 * frames is a *composed* surface — rack, sconce, cloth, whatever is on the top —
 * rather than an empty room. A desk facing the cabin would frame the door.
 *
 * WHAT THE TAPER DOES TO IT, AND WHAT NOT TO DO ABOUT IT
 * ------------------------------------------------------
 * The cabin narrows 0.11 m of half-breadth per metre of length, so a 1.30 m desk
 * standing square and pushed hard against the side touches at its after corner
 * and stands 0.149 m off at its forward one.
 *
 * **Do not fill the gap.** A previous pass read "flush against the wall" as
 * "close the wedge" and scribed a 32-slice filler into it. Ash's verdict:
 * *"you just added a giant wedge behind the desk instead of moving the actual
 * furniture against the wall — looks completely wrong."* He is right, and the
 * mistake is worth naming because it is seductive: the filler was correct
 * joinery, correctly measured, solving a problem nobody had.
 *
 * **Move the furniture, which is the other half of that sentence.** The desk now
 * says `align: 'side'` and lies along the lining at 6.6°, which is what a person
 * does when they shove a desk into a curve. Hard against the wall it touches
 * near its middle and stands 13–15 mm off at its ends — the sagitta of the
 * side's own curve over 1.3 m, and as close as a straight carcase gets to a
 * curved wall. That remainder is the gap that is *allowed*: a freestanding desk
 * touching a curved wall at one point is what furniture in a real room looks
 * like, and no joinery goes behind it.
 *
 * The angle is not written down here. `roomFitting.sideTangentYaw` measures it
 * off the lining over this desk's own footprint, for the reason that module's
 * head gives at length: an angle typed into a fitting is a second source for
 * something the hull already knows.
 *
 * WHY EVERY DIMENSION IS A CONSTANT WITH A NAME
 * ---------------------------------------------
 * `D2`'s seated camera has to know where the seat is and where the desk top is,
 * and `D4`'s items have to be *on* that top. Those are three consumers of the
 * same four numbers, which is this project's oldest fault waiting to happen. So
 * the desk publishes `chartDeskGeometry()` — one resolved description that the
 * seat, the items and the loft all read — and nobody re-derives a height.
 *
 * **Those numbers are in the desk's own frame**, and the round that turned the
 * desk is the reason it is worth saying. A drawer front 10 mm proud of the
 * carcase, a fiddle 18 mm in from the edge, a book set back a hand's breadth
 * from the near lip: every sentence in this file is true along the desk and
 * meaningless along the ship. So the desk is drawn in its own coordinates and
 * `chartDeskGeometry().frame` puts it in the cabin — which is why turning it
 * changed the placement and not one dimension of the joinery. Anything that
 * needs a ship coordinate — the seated eye, the pointer's target — says so by
 * calling `frameToShip`, and there are four such places in the ship.
 */

// --- where the desk stands ----------------------------------------------------

/**
 * How far the desk's after end stands off the transom lining.
 *
 * **0.62, moved half a metre forward on Ash's eye.** It was 0.12 — hard aft,
 * on the argument that the four stern lights are the only daylight in the room
 * and the desk is where a man needs to see what he is doing. That argument was
 * built for a cabin with no lamp in it, and the lanterns-below round put one at
 * z = −6.4. Jammed into the after corner the desk was also cramped against the
 * narrowest part of the room and read as shoved there rather than fitted.
 *
 * Forward, it sits under its own lantern, in a wider part of the cabin, with
 * the stern lights over the sitter's shoulder instead of behind their back.
 *
 * The taper costs nothing to move: the standoff a fitted piece leaves against a
 * curving side is `taper × length`, so it is the same 0.12 m wherever along the
 * wall the desk stands. Not zero at the after end, because the cabin's after
 * "wall" is the counter and it rakes — `CABIN_AFT_Z` is its station at the
 * *sole*, and the lining leans away from it going up.
 */
const DESK_OFF_TRANSOM = 0.62;

/** Fore-and-aft length of the carcase. */
const DESK_LENGTH = 1.30;

/**
 * Depth of the desk, athwartships.
 *
 * A chart is folded to about 0.55 m on this desk and a man needs his elbows, so
 * 0.60 m is the working number. It also has to leave the room its width: at the
 * desk's after end the cabin's half-breadth is 1.15 m, so 0.60 m of desk leaves
 * a 1.70 m clear strip between the desk's inboard face and the starboard
 * lining. The walker is 0.52 m across. Nobody is squeezing past anything.
 */
const DESK_DEPTH = 0.60;

/**
 * Height to the top of the carcase.
 *
 * Writing height, which is lower than a dining table and higher than a desk you
 * type at: 0.76 m puts the top a hand's breadth under the elbow of a seated man
 * on a 0.44 m seat. The two numbers are a pair and moving one alone is what
 * makes a desk look like a bench.
 */
const DESK_HEIGHT = 0.76;

/** Thickness of the top slab. */
const DESK_TOP_THICKNESS = 0.045;

/**
 * The fiddle rail round the desk top.
 *
 * **The most useful 35 mm on the ship and the reason anything can be left on
 * this desk at all.** A fiddle is the raised lip a vessel's furniture carries so
 * that its contents stay aboard when she rolls, and without one the honest
 * answer to "what happens to the book on the desk" is that it is on the sole.
 * It is also what makes the top read as a *ship's* desk in a single glance,
 * which no amount of correct proportion does.
 */
const FIDDLE_HEIGHT = 0.035;
const FIDDLE_THICKNESS = 0.018;

/**
 * How much timber shows round the leather skiver.
 *
 * **0.095 rather than the 0.022 the baize had, and that 22 mm is the whole
 * reason Ash asked what the green was.** A writing surface *let into* a desk is
 * a panel inside a broad border, and the border is what says "let into" — with
 * 22 mm of edge the cloth covered 81 % of the top and the object it most
 * resembled was a card table.
 *
 * At 95 mm the skiver takes about half the top, which is the proportion a real
 * one has, and there is a hand's breadth of bare oak all the way round to rest
 * a wrist on and to take the dividers.
 */
const SKIVER_MARGIN = 0.095;
const SKIVER_THICKNESS = 0.005;

/**
 * The knee-hole: where in the desk's length a seated man's legs go.
 *
 * Measured from the desk's after end. 0.66 m of clear opening is a comfortable
 * seat — narrower and you sit askew — and putting it aft rather than amidships
 * puts the sitter nearest the stern windows, which is the whole reason the desk
 * is at this end of the room.
 */
const KNEE_FROM_AFT = 0.16;
const KNEE_WIDTH = 0.66;

/** Thickness of the carcase's standing panels. */
const CARCASE_PANEL = 0.032;

/** How far the plinth is set back under the carcase. */
const PLINTH_SETBACK = 0.05;
const PLINTH_HEIGHT = 0.09;

/** Three chart drawers in the bank forward of the knee-hole. */
const DRAWER_COUNT = 3;
const DRAWER_FRONT_PROUD = 0.010;

// --- what the rest of the round reads -----------------------------------------

/**
 * The desk, resolved — the single description the loft, the seat and the desk's
 * items all read.
 *
 * Everything downstream of the desk needs two or three of these numbers and
 * none of them may compute its own. The seat's eye height is derived from
 * `seatY`; the items sit on `topY`; the camera looks at `focusX/focusZ`. Each of
 * those is one arithmetic slip away from a book floating a centimetre over a
 * desk, and the slip would be invisible in every test that did the same
 * arithmetic to check it.
 */
export interface ChartDeskGeometry {
  /**
   * The desk's own frame. Everything below is measured in it, and this is what
   * turns those measurements into places in the cabin.
   */
  readonly frame: PieceFrame;
  /** Inboard face of the carcase — the edge the sitter's chest is against. */
  readonly xInboard: number;
  /** Outboard face, hard against the lining at the desk's tightest station. */
  readonly xOutboard: number;
  readonly zAft: number;
  readonly zForward: number;
  /** The cabin sole under it. */
  readonly soleY: number;
  /** Top of the timber slab. Things on the desk stand on this. */
  readonly topY: number;
  /** Top of the baize, which is what a book actually rests on. */
  readonly clothY: number;
  /** Inside face of the fiddles: the rectangle anything on the desk lives in. */
  readonly wellXLo: number;
  readonly wellXHi: number;
  readonly wellZAft: number;
  readonly wellZForward: number;
  /** Centre of the knee-hole, fore-and-aft — where the chair goes. */
  readonly kneeZ: number;
  /** Clear opening of the knee-hole. */
  readonly kneeZAft: number;
  readonly kneeZForward: number;
}

let cached: ChartDeskGeometry | null = null;

/** The desk's placement, resolved once against the room as she is drawn. */
function deskPlacement(): RoomPlacement {
  return placeInRoom({
    space: 'cabin',
    from: 'aft',
    offset: DESK_OFF_TRANSOM,
    length: DESK_LENGTH,
    hand: 'port',
    // Lying along the lining rather than square with the keel. See this
    // module's head, and `roomFitting.ts`'s, for the whole of why.
    align: 'side',
    inboard: 0,
    width: DESK_DEPTH,
    height: DESK_HEIGHT,
  });
}

export function chartDeskGeometry(): ChartDeskGeometry {
  if (cached) return cached;
  const p = deskPlacement();
  const topY = p.yHi;
  const kneeZAft = p.zAft + KNEE_FROM_AFT;
  cached = {
    frame: p.frame,
    xInboard: p.xLo,
    xOutboard: p.xHi,
    zAft: p.zAft,
    zForward: p.zForward,
    soleY: p.yLo,
    topY,
    clothY: topY + SKIVER_THICKNESS,
    wellXLo: p.xLo + FIDDLE_THICKNESS,
    wellXHi: p.xHi - FIDDLE_THICKNESS,
    wellZAft: p.zAft + FIDDLE_THICKNESS,
    wellZForward: p.zForward - FIDDLE_THICKNESS,
    kneeZ: kneeZAft + KNEE_WIDTH / 2,
    kneeZAft,
    kneeZForward: kneeZAft + KNEE_WIDTH,
  };
  return cached;
}

// --- the desk -----------------------------------------------------------------

export function chartDesk(): InteriorFitting {
  const d = chartDeskGeometry();
  const { span, rod } = drawnIn(d.frame);
  const solids: FittingSolid[] = [];
  const carcaseTop = d.topY - DESK_TOP_THICKNESS;

  // --- the carcase ---------------------------------------------------------
  // Three standing panels: the after end, the knee-hole's forward cheek, and
  // the forward end. The drawer bank fills between the last two.
  //
  // **They collide and the knee-hole does not, and that difference buys nothing
  // for the walker** — which is worth stating here because the first version of
  // this comment claimed the opposite. The top slab below is also a collider and
  // it spans the whole length, so the band the knee-hole opens is closed 0.72 m
  // up regardless; a 1.75 m body was never going to fit under a desk. The gap is
  // real geometry a player can see into and put their knees in when seated, and
  // that is all it is. See `INTERIOR_FITTING_KINDS.chartDesk`.
  const panels: Array<[number, number]> = [
    [d.zAft, d.kneeZAft],
    [d.kneeZForward, d.kneeZForward + CARCASE_PANEL],
    [d.zForward - CARCASE_PANEL, d.zForward],
  ];
  for (const [zLo, zHi] of panels) {
    solids.push(span(d.xInboard, d.xOutboard, d.soleY + PLINTH_HEIGHT, carcaseTop, zLo, zHi, 'timber', true));
  }

  // The plinth under the standing panels, set back so the carcase reads as
  // standing on something rather than growing out of the floor. Not a collider:
  // it is inside the panels' own footprint in x and 0.09 m tall, so a body
  // stopped by the panel above can never reach it.
  for (const [zLo, zHi] of panels) {
    solids.push(
      span(
        d.xInboard + PLINTH_SETBACK,
        d.xOutboard,
        d.soleY,
        d.soleY + PLINTH_HEIGHT,
        zLo,
        zHi,
        'timber',
        false,
      ),
    );
  }

  // The bank between the two forward panels: carcase behind, drawer fronts on
  // the inboard face. Collides, because it is solid furniture.
  const bankZAft = d.kneeZForward + CARCASE_PANEL;
  const bankZForward = d.zForward - CARCASE_PANEL;
  solids.push(
    span(d.xInboard, d.xOutboard, d.soleY + PLINTH_HEIGHT, carcaseTop, bankZAft, bankZForward, 'timber', true),
  );
  solids.push(
    span(
      d.xInboard + PLINTH_SETBACK,
      d.xOutboard,
      d.soleY,
      d.soleY + PLINTH_HEIGHT,
      bankZAft,
      bankZForward,
      'timber',
      false,
    ),
  );

  // Drawer fronts, proud of the carcase with a bead of shadow between them.
  // Three chart drawers: shallow, wide and long, which is the only shape a
  // folded chart goes into flat.
  const bankTop = carcaseTop;
  const bankFoot = d.soleY + PLINTH_HEIGHT;
  const drawerPitch = (bankTop - bankFoot) / DRAWER_COUNT;
  for (let i = 0; i < DRAWER_COUNT; i++) {
    const yLo = bankFoot + drawerPitch * i + 0.006;
    const yHi = bankFoot + drawerPitch * (i + 1) - 0.006;
    solids.push(
      span(
        d.xInboard - DRAWER_FRONT_PROUD,
        d.xInboard + 0.004,
        yLo,
        yHi,
        bankZAft + 0.012,
        bankZForward - 0.012,
        'timber',
        false,
      ),
    );
    // A brass ring on each. Drawn as a short tube on the drawer's centre,
    // lying in the fore-and-aft plane so it reads as a pull rather than a knob.
    const ringZ = (bankZAft + bankZForward) / 2;
    const ringY = (yLo + yHi) / 2;
    solids.push(
      rod(
        v3(d.xInboard - DRAWER_FRONT_PROUD - 0.004, ringY, ringZ - 0.055),
        v3(d.xInboard - DRAWER_FRONT_PROUD - 0.004, ringY, ringZ + 0.055),
        0.010,
        0.010,
        'brass',
        false,
      ),
    );
  }

  // --- the top -------------------------------------------------------------
  solids.push(span(d.xInboard, d.xOutboard, carcaseTop, d.topY, d.zAft, d.zForward, 'timber', true));

  // The leather skiver, let into the top inside a broad timber border. Thin,
  // and standing on the slab rather than sunk into it: a rebate is four more
  // boxes for a 5 mm shadow line nobody will ever be at the right angle to see.
  solids.push(
    span(
      d.wellXLo + SKIVER_MARGIN,
      d.wellXHi - SKIVER_MARGIN,
      d.topY,
      d.clothY,
      d.wellZAft + SKIVER_MARGIN,
      d.wellZForward - SKIVER_MARGIN,
      'leather',
      false,
    ),
  );

  // The fiddles, all four sides.
  //
  // **The outboard one is not redundant with the lining**, and a round spent
  // finding that out the hard way is worth a sentence. The desk is a rectangle
  // and the ship's side is not: laid along the lining it touches near its middle
  // and stands 15 mm off at its worst corner, which is what a real desk shoved
  // against a curved wall does and is exactly as close as it can get. Without
  // this rail the outboard edge is an open gap a chart slides down. Turning the
  // desk shrank that gap from 149 mm to 15 mm and did not close it, which is a
  // rail is what a fiddle is for and a filler is what Ash rejected.
  //
  // Run long and lapped at the corners rather than butted — `pumpWell`'s
  // lesson, §11.3's coaming lesson: four coincident faces are four dark seams.
  const fiddleTop = d.topY + FIDDLE_HEIGHT;
  solids.push(
    span(d.xInboard, d.xInboard + FIDDLE_THICKNESS, d.topY, fiddleTop, d.zAft, d.zForward, 'timber', false),
  );
  solids.push(
    span(d.xOutboard - FIDDLE_THICKNESS, d.xOutboard, d.topY, fiddleTop, d.zAft, d.zForward, 'timber', false),
  );
  solids.push(
    span(
      d.xInboard + FIDDLE_THICKNESS / 2,
      d.xOutboard - FIDDLE_THICKNESS / 2,
      d.topY,
      fiddleTop,
      d.zAft,
      d.zAft + FIDDLE_THICKNESS,
      'timber',
      false,
    ),
  );
  solids.push(
    span(
      d.xInboard + FIDDLE_THICKNESS / 2,
      d.xOutboard - FIDDLE_THICKNESS / 2,
      d.topY,
      fiddleTop,
      d.zForward - FIDDLE_THICKNESS,
      d.zForward,
      'timber',
      false,
    ),
  );

  return {
    name: 'chartDesk',
    kind: 'chartDesk',
    solids,
    // Not standable. See `INTERIOR_FITTING_KINDS.chartDesk`: a 0.76 m panel a
    // player can climb onto is a player standing on the furniture with their
    // head in the beams, and then a body that has to be got back down.
    standable: null,
  };
}

// --- the rack over it ---------------------------------------------------------

/**
 * How far above the sole the rack's underside sits.
 *
 * **Set by two clearances that pull opposite ways.** It has to leave working
 * room over the desk top — a chart is opened on that surface and a hand goes
 * over it — which wants it high; and its pigeonholes have to be at the seated
 * eye rather than above it, which wants it low. The desk top is 0.76 m up and
 * the seated eye is about 1.22 m, so 1.10 m leaves 0.34 m of clear lining over
 * the top and puts the eye level with the rack's lower shelf, looking slightly
 * up into the holes. That is the composition the seated camera frames.
 */
const RACK_SILL = 1.10;
const RACK_HEIGHT = 0.44;
const RACK_DEPTH = 0.24;
const RACK_LENGTH = 0.88;
const RACK_PANEL = 0.018;
/** Pigeonholes across the upper tier. */
const PIGEONHOLES = 4;

/**
 * Where the rack sits, **measured from the desk and not from the transom.**
 *
 * The offset was once `0.14` — its own independent distance off the after
 * bulkhead, which happened to put it over the desk while the desk was also hard
 * aft. Moving the desk half a metre forward left the rack exactly where it was,
 * hanging over nothing, with the desk out from under it. That is this file's own
 * doctrine broken in this file: **two sources for one position.**
 *
 * So it is asked of the sitter. `from: 'centre'` exists for this: what a rack
 * over a desk has to satisfy is that its *middle* is over the head of the person
 * at the desk, and saying that as a distance to its near face would mean
 * computing the rack's own turned footprint — the derived quantity
 * `roomFitting.ts` exists so that nobody computes.
 *
 * **Asked of the seated eye, in the ship's z, not the desk's.** The desk is at
 * an angle now, so a station taken at the knee-hole and a station taken at the
 * head that leans over it are 12 mm apart along the lining. Small, and the wrong
 * 12 mm to spend: what this rack is *for* is being the thing in the middle of
 * the seated view, so the point it is centred on is the point that view is taken
 * from.
 */
function rackOffTransom(): number {
  return captainsSeatPose().z - belowDecksSpace('cabin').zAft;
}

export function chartRack(): InteriorFitting {
  const p = placeInRoom({
    space: 'cabin',
    from: 'centre',
    offset: rackOffTransom(),
    length: RACK_LENGTH,
    hand: 'port',
    // Screwed to the lining, so it lies along it — and a rack that did not
    // would stand 0.10 m off the timber at one end while the desk under it
    // stood 0.013 m off at both, which is a joint nobody would cut.
    align: 'side',
    inboard: 0,
    width: RACK_DEPTH,
    sill: RACK_SILL,
    height: RACK_HEIGHT,
  });
  const { span, rod } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  const shelfY = p.yLo + RACK_HEIGHT * 0.42;

  // Back against the lining, two ends, top, bottom and the middle shelf.
  solids.push(span(p.xHi - RACK_PANEL, p.xHi, p.yLo, p.yHi, p.zAft, p.zForward, 'timber', false));
  for (const [zLo, zHi] of [
    [p.zAft, p.zAft + RACK_PANEL],
    [p.zForward - RACK_PANEL, p.zForward],
  ] as const) {
    solids.push(span(p.xLo, p.xHi, p.yLo, p.yHi, zLo, zHi, 'timber', false));
  }
  for (const [yLo, yHi] of [
    [p.yLo, p.yLo + RACK_PANEL],
    [shelfY, shelfY + RACK_PANEL],
    [p.yHi - RACK_PANEL, p.yHi],
  ] as const) {
    solids.push(span(p.xLo, p.xHi, yLo, yHi, p.zAft, p.zForward, 'timber', false));
  }

  // Dividers in the upper tier, making the pigeonholes.
  const holeZ0 = p.zAft + RACK_PANEL;
  const holeZ1 = p.zForward - RACK_PANEL;
  for (let i = 1; i < PIGEONHOLES; i++) {
    const z = holeZ0 + ((holeZ1 - holeZ0) * i) / PIGEONHOLES;
    solids.push(
      span(p.xLo, p.xHi, shelfY + RACK_PANEL, p.yHi - RACK_PANEL, z - 0.007, z + 0.007, 'timber', false),
    );
  }

  // Rolled charts in two of the four holes, and a third lying on the lower
  // shelf. **Paper is the only pale thing below decks** and this is where it
  // earns the material: a rack of empty dark holes is a bookcase in the dark,
  // and three light cylinders in it is a chart rack.
  // **They rest on the shelf**, and until Ash pointed at them they did not: the
  // roll's *axis* was put at the vertical middle of the pigeonhole, so two
  // 20 mm cylinders hung in the air with daylight under them. A cylinder lying
  // on a surface has its axis one radius above it, not half a hole above it —
  // which is obvious stated, and invisible in code that reads
  // `(floor + ceiling) / 2` and looks like it is centring something.
  const holePitch = (holeZ1 - holeZ0) / PIGEONHOLES;
  const shelfTop = shelfY + RACK_PANEL;
  for (const hole of [0, 2]) {
    const centreZ = holeZ0 + holePitch * (hole + 0.5);
    for (const [dz, radius] of [
      [-0.021, 0.020],
      [0.019, 0.017],
    ] as const) {
      solids.push(
        rod(
          v3(p.xLo + 0.012, shelfTop + radius, centreZ + dz),
          v3(p.xHi - RACK_PANEL - 0.01, shelfTop + radius, centreZ + dz),
          radius,
          radius,
          'paper',
          false,
        ),
      );
    }
  }
  // A fourth roll lying on the lower shelf, tucked back against the rack's own
  // back panel.
  //
  // **This was a 0.64 m roll standing at the front of the shelf and it read as
  // a strip light.** Paper is by far the palest material below decks, which is
  // the whole reason it is worth having — and it means a long straight run of
  // it, lying across the front of the one composition the player sits and looks
  // at, is not a chart but a glowing bar. Short, and pushed to the back where
  // the shelf's own shadow falls on it: 0.26 m of roll reads as a rolled chart
  // precisely because it is short enough to have ends.
  solids.push(
    rod(
      v3(p.xHi - RACK_PANEL - 0.055, p.yLo + RACK_PANEL + 0.023, p.zAft + 0.20),
      v3(p.xHi - RACK_PANEL - 0.055, p.yLo + RACK_PANEL + 0.023, p.zAft + 0.46),
      0.023,
      0.023,
      'paper',
      false,
    ),
  );

  return { name: 'chartRack', kind: 'chartRack', solids, standable: null };
}

/**
 * THE BAROMETER, AND WHY THERE IS NOT ONE
 * ---------------------------------------
 * There was, through four positions, and it is cut. The record is worth more
 * than the object was.
 *
 * A ship's aneroid belongs in a captain's cabin — it is the one instrument
 * aboard worth looking at every day — so it went on the lining over the desk.
 * Built with its brass case inboard of its paper dial, which showed a seated
 * player only the dark back of the instrument. Turned round, it became a plain
 * pale disc, and Ash's report was the whole verdict: *"what is the white circle
 * on wall?"* Given a face — a proud bezel, a recessed dial, a hand, a boss — it
 * became a *correct* instrument hanging 0.34 m below a 0.24 m shelf, which is a
 * shadow no amount of face detail escapes. Moved onto open lining forward of
 * the rack, where the lamp reaches, it landed 51° off the seated centre against
 * a half-field of 43°: lit, legible, and out of frame.
 *
 * **The lesson is that it had nowhere to go, and that is a fact about the room
 * rather than a fault in the object.** The one wall a seated player looks at is
 * the wall the rack is on, the rack shades everything under it, and either side
 * of the rack is outside the view. Every fix moved it between those three
 * problems.
 *
 * If it comes back it should come back as a thing that *does* something — a
 * dial that reads the weather the sailing model already has, which would make
 * it worth turning your head for. As static geometry in a place that cannot
 * light it, it was a white circle nobody could name, and Ash naming it as one
 * is the measurement.
 */

// --- the chair ----------------------------------------------------------------

/**
 * Seat height, and it is a pair with `DESK_HEIGHT`.
 *
 * 0.44 m against a 0.76 m top is 0.32 m of thigh-to-elbow, which is the
 * proportion every writing desk ever built has. It is also what sets the seated
 * eye, and therefore the whole composition of the seated view — see
 * `CaptainsSeat`.
 */
export const CHAIR_SEAT_HEIGHT = 0.44;
const CHAIR_SEAT_HALF_X = 0.205;
const CHAIR_SEAT_HALF_Z = 0.195;
const CHAIR_SEAT_THICKNESS = 0.036;
const CHAIR_LEG_RADIUS = 0.019;
const CHAIR_BACK_HEIGHT = 0.46;

/**
 * How far inboard the chair comes when it is drawn out to sit in.
 *
 * Enough that a body fits between the chair back and the desk's inboard face,
 * which is what 0.52 m of walker plus the seat's own depth asks for. It is also
 * the distance the seat travels back under the desk when the sitter stands, and
 * `INTERIOR_FITTING_KINDS.deskChair` is why that matters: tucked is the only
 * state that exists while anybody is walking about.
 *
 * **0.42, tucked in, on Ash's eye** — *"chair position more forward close to
 * the table so you're tucked in."*
 *
 * This was 0.60, and the 0.60 was a measurement rather than a taste: at the
 * 0.50 m a real chair takes, the seated view spans 67° against an embodied
 * field of 62°, so something had to be cropped and it was the near half of the
 * desk. Backing the chair off bought the whole composition into frame.
 *
 * It also read as sitting a long way from your own desk, which is what Ash saw.
 * The measurement was right and the conclusion was wrong: the fix for a view
 * that does not fit is not to move the body away from the thing it is looking
 * at — it is to **lean over it**, which is what a person at a desk actually
 * does. `SEATED_LEAN` is that, and it lets the chair go back where a chair
 * belongs. The near lip of the desk is now genuinely out of frame, and so is
 * the near lip of any desk you are working at.
 */
const CHAIR_DRAW_OUT = 0.42;

/**
 * Where the seat's centre is, in each of its two states — **in the desk's own
 * frame**, because a chair drawn out from a desk comes out perpendicular to the
 * desk rather than athwartships.
 *
 * That distinction is the whole reason this stayed one number after the desk
 * turned: "0.42 m back from the desk's inboard face" is a fact about the desk,
 * and it is only a fact about the ship's x while the two agree.
 */
export function chairSeatCentre(drawnOut: boolean): { x: number; y: number; z: number } {
  const d = chartDeskGeometry();
  // Tucked, the seat is under the desk top with its back just clear of the
  // desk's inboard edge — which is what "pushed in" means and is why the back
  // does not foul the top.
  const tuckedX = d.xInboard + CHAIR_SEAT_HALF_X - 0.10;
  return {
    x: drawnOut ? tuckedX - CHAIR_DRAW_OUT : tuckedX,
    y: d.soleY + CHAIR_SEAT_HEIGHT,
    z: d.kneeZ,
  };
}

/**
 * How far a seated man's eye is above the seat he is on.
 *
 * 0.78 m. Sitting height — crown to seat — is about 0.90 m for a 1.75 m man,
 * which is the walker's own `standingHeight`, and the eye is a little under a
 * hand below the crown. It is derived from the same body the walker is rather
 * than picked, because a seated eye that does not match the standing one makes
 * the room change size when you sit down.
 */
const SEATED_EYE_ABOVE_SEAT = 0.78;

/**
 * How far the sitter's head is forward of the seat, over the desk.
 *
 * **A body at a desk is not a body sitting upright on a chair**, and until this
 * existed the seat had to choose between the two: either the chair stood off
 * far enough to frame the desk, or it tucked in and the eye was too far back to
 * see anything but the far half. Ash asked for both — *"head position more
 * forward over the table, chair position more forward close to the table"* —
 * and they are only in tension while the eye is nailed to the seat.
 *
 * 0.10 m of lean, which is about what a shoulder travels when you come forward
 * to read something. It is applied to the eye alone: the chair, the knees and
 * the collider are all still where the chair is.
 */
const SEATED_LEAN = 0.10;

/**
 * The seated view at the chart desk: where the eye goes, and how far it turns.
 *
 * WHERE IT LOOKS
 * --------------
 * Outboard, at the lining, over the desk. That is the whole reason the desk
 * faces that way — see this module's head — and it is what puts the rack, the
 * charts and whatever is on the top into one frame.
 *
 * Pitched down 27°, and **the frame is the desk rather than the wall.**
 *
 * The old 14° was centred to fit the desk *and* the whole rack into one 62°
 * field, which it did — at the cost of sitting the captain half a metre back
 * from his own desk, which is what Ash saw. Tucked in and leaning, the
 * geometry simply will not hold both: the desk alone now runs from 29° below
 * the horizon at its far edge to 65° at its near one, and the rack's head is
 * 29° above. That is 94° of subject and there are 62° to put it in.
 *
 * So the aim goes to the work. At 27° down the field covers 4° above the
 * horizon to 58° below it: the whole book, nearly the whole desk, and the
 * rack's lower shelf across the top of the frame. The pigeonholes and the
 * pigeonholes are above it — which is where things on a wall are when you are
 * writing, and the seat's cone lets you look up at them whenever you want.
 *
 * HOW FAR IT TURNS
 * ----------------
 * 75° either way — the widest cone that cannot end up facing away from the
 * desk. It reaches the stern windows aft, the length of the desk forward, and
 * the cabin door over your shoulder; it does not reach the wall behind you.
 * Pitch runs from 55° down (your own hands) to 35° up (the deckhead beams).
 *
 * **This is the one place in the file that leaves the desk's frame**, and it has
 * to: a camera is placed in the world. Both halves are converted — the position
 * through `frameToShip`, and the heading by adding the desk's own yaw — and
 * getting either without the other is the failure worth naming, because each
 * alone still puts a captain at a desk. Position only, and he faces the lining
 * at a slight angle and the composition skews. Heading only, and he sits square
 * to the room looking past the corner of a desk that is not where he is aimed.
 */
export function captainsSeatPose(): {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  yawRange: number;
  pitchLo: number;
  pitchHi: number;
} {
  const d = chartDeskGeometry();
  const seat = chairSeatCentre(true);
  // Leaned toward the desk, which is outboard: the desk's local +x runs to
  // port, so the lean is a *positive* step in the desk's frame. Getting this
  // sign wrong would sit the captain further from his own desk the harder he
  // leaned.
  const eye = frameToShip(d.frame, seat.x + SEATED_LEAN, seat.z);
  return {
    x: eye.x,
    y: seat.y + SEATED_EYE_ABOVE_SEAT,
    z: eye.z,
    // The camera looks down its own −Z, so a yaw of −π/2 faces +x, which is
    // port; the desk's yaw turns it onto the desk's own outboard normal. Check
    // it at zero and the desk is square and this is the old constant.
    // `DeckWalker.step` and `Interactables`' pick both read the same convention.
    yaw: -Math.PI / 2 + d.frame.yaw,
    pitch: (-27 * Math.PI) / 180,
    yawRange: (75 * Math.PI) / 180,
    pitchLo: (-55 * Math.PI) / 180,
    pitchHi: (35 * Math.PI) / 180,
  };
}

/**
 * Where a player has to be standing to be offered the chair.
 *
 * **Not the chair's own box, and that is the same lesson the hatchway boards
 * taught.** The chair is a scatter of 19 mm legs and a 36 mm seat board 0.44 m
 * off the sole; aiming at it means looking down at a thin thing near your feet,
 * which is precisely the failure Ash reported at the fore scuttle. The target
 * is the volume a person *stands in* to sit down: the clear floor inboard of
 * the desk, from the sole to standing eye height, so anyone in front of the
 * chair looking anywhere near it is offered the seat.
 *
 * One box, unlike a hatch's two, because a chair has one side you sit down
 * from — you do not climb over a desk to reach it.
 *
 * **Turned with the desk, and it had to be.** You stand square to the thing you
 * are about to sit at, so the volume is the desk's; the first pass squared it up
 * to the ship and that upright bounding box reached 0.13 m further forward than
 * the standing space does, which was enough to offer the seat to a player in the
 * landing through the cabin bulkhead. `InteractableBox.yaw` records that.
 */
export function deskChairTarget(): InteractableBox {
  const d = chartDeskGeometry();
  const seat = chairSeatCentre(true);
  return framedTarget(
    d.frame,
    seat.x - 0.55,
    d.xInboard,
    d.soleY,
    d.soleY + 1.75,
    d.kneeZAft - 0.20,
    d.kneeZForward + 0.20,
  );
}

/**
 * The desk face a standing player looks at to take its chair.
 *
 * `deskChairTarget` remains the approach volume — where the body fits — and is
 * intentionally not selection geometry any more. Treating occupied floor as
 * gaze made the chair appear while looking through the cabin door or up at the
 * lantern. The carcase and top are the visible affordance; looking at either
 * while standing in the approach says "sit at the desk" without asking anyone
 * to sight a 19 mm chair leg near their boots.
 */
export function deskChairGazeTarget(): InteractableBox {
  const d = chartDeskGeometry();
  return framedTarget(
    d.frame,
    d.xInboard - 0.08,
    d.xOutboard,
    d.soleY + 0.32,
    d.topY + 0.12,
    d.zAft,
    d.zForward,
  );
}

export function deskChair(drawnOut: boolean): InteriorFitting {
  const d = chartDeskGeometry();
  // The chair belongs to the desk, so it is drawn in the desk's frame — it
  // faces the desk, it slides in and out along the desk's own axis, and a chair
  // standing square to the ship at a desk that is not would read as having been
  // knocked out of place.
  const { span, rod } = drawnIn(d.frame);
  const seat = chairSeatCentre(drawnOut);
  const solids: FittingSolid[] = [];

  // The seat board.
  solids.push(
    span(
      seat.x - CHAIR_SEAT_HALF_X,
      seat.x + CHAIR_SEAT_HALF_X,
      seat.y - CHAIR_SEAT_THICKNESS,
      seat.y,
      seat.z - CHAIR_SEAT_HALF_Z,
      seat.z + CHAIR_SEAT_HALF_Z,
      'timber',
      false,
    ),
  );

  // Four legs, raked out a little at the foot so the chair does not go over
  // when she rolls — which is the whole difference between a ship's chair and
  // a dining chair, and it costs nothing to draw.
  const rake = 0.035;
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const topX = seat.x + sx * (CHAIR_SEAT_HALF_X - 0.03);
      const topZ = seat.z + sz * (CHAIR_SEAT_HALF_Z - 0.03);
      solids.push(
        rod(
          v3(topX + sx * rake, d.soleY, topZ + sz * rake),
          v3(topX, seat.y - CHAIR_SEAT_THICKNESS, topZ),
          CHAIR_LEG_RADIUS * 0.85,
          CHAIR_LEG_RADIUS,
          'timber',
          false,
        ),
      );
    }
  }

  // Two stretchers athwartships, low down. A chair at sea is racked every time
  // she pitches and this is what stops it.
  for (const sz of [-1, 1] as const) {
    const z = seat.z + sz * (CHAIR_SEAT_HALF_Z - 0.03);
    solids.push(
      rod(
        v3(seat.x - CHAIR_SEAT_HALF_X + 0.02, d.soleY + 0.14, z + sz * rake * 0.6),
        v3(seat.x + CHAIR_SEAT_HALF_X - 0.02, d.soleY + 0.14, z + sz * rake * 0.6),
        CHAIR_LEG_RADIUS * 0.7,
        CHAIR_LEG_RADIUS * 0.7,
        'timber',
        false,
      ),
    );
  }

  // The back: two uprights off the inboard pair of legs and a shaped top rail.
  // Inboard, so that tucked, the back stands clear of the desk's edge instead
  // of inside its top.
  const backX = seat.x - CHAIR_SEAT_HALF_X + 0.026;
  const railY = seat.y + CHAIR_BACK_HEIGHT;
  for (const sz of [-1, 1] as const) {
    const z = seat.z + sz * (CHAIR_SEAT_HALF_Z - 0.03);
    solids.push(
      rod(
        v3(backX, seat.y - CHAIR_SEAT_THICKNESS, z),
        v3(backX - 0.03, railY, z),
        CHAIR_LEG_RADIUS,
        CHAIR_LEG_RADIUS * 0.85,
        'timber',
        false,
      ),
    );
  }
  solids.push(
    span(
      backX - 0.048,
      backX - 0.012,
      railY - 0.075,
      railY,
      seat.z - CHAIR_SEAT_HALF_Z + 0.01,
      seat.z + CHAIR_SEAT_HALF_Z - 0.01,
      'timber',
      false,
    ),
  );
  // A splat across the middle of the back, so it is a chair and not a frame.
  solids.push(
    span(
      backX - 0.038,
      backX - 0.018,
      seat.y + 0.13,
      seat.y + 0.30,
      seat.z - 0.085,
      seat.z + 0.085,
      'timber',
      false,
    ),
  );
  // A squab on the seat. The one soft thing in the room.
  solids.push(
    span(
      seat.x - CHAIR_SEAT_HALF_X + 0.012,
      seat.x + CHAIR_SEAT_HALF_X - 0.012,
      seat.y,
      seat.y + 0.022,
      seat.z - CHAIR_SEAT_HALF_Z + 0.012,
      seat.z + CHAIR_SEAT_HALF_Z - 0.012,
      'leather',
      false,
    ),
  );

  return {
    name: 'deskChair',
    kind: 'deskChair',
    solids,
    // Not standable, in either state. A 0.44 m seat is inside the walker's
    // 0.32 m step-up plus its own smoothing, so publishing it would make the
    // chair a thing you climb rather than a thing you sit in — and sitting is
    // an action with a verb, not a place you happen to end up standing.
    standable: null,
  };
}

// --- the glass ----------------------------------------------------------------

/** Case radius. A 0.21 m dial is what a wheel barometer of the period reads. */
const GLASS_RADIUS = 0.105;
/** How far the whole instrument stands off the lining. */
const GLASS_DEPTH = 0.075;
/** Centre height. Level with the seated eye, not with a standing one. */
const GLASS_CENTRE_Y = 1.30;

/**
 * THE BAROMETER, WHICH IS BACK, AND WHY IT WORKS THIS TIME
 * --------------------------------------------------------
 * The note above this one records four positions and a cut, and it ends: *"if
 * it comes back it should come back as a thing that does something — a dial
 * that reads the weather the sailing model already has."* WX1 is that weather,
 * so here it is. Three things are different, and all three are answers to what
 * was written down rather than another go at the same object.
 *
 * **It is not under the rack.** The fourth position — open lining forward of
 * the chart rack, where the lantern reaches — was the one that was lit and
 * legible and merely out of frame, at 51° against a seated half-field of 43°.
 * The frame is what changed: the seated view is wider now, so the position that
 * was correct and unusable is correct and usable. Nothing about it moved.
 *
 * **It is timber, not brass.** This is the recorded lesson of the whole cabin
 * and it nearly claimed this object twice. Brass sits at 0.217 against a lining
 * of 0.241 — an instrument the same value as the wall behind it, which is a
 * silhouette that does not exist. Paper at 0.495 against that lining is only
 * twice it, and twice it is *"what is the white circle on wall?"* So the case
 * is timber at 0.067, three and a half times darker than the lining, and the
 * dial is paper inside the case. Two edges instead of one: a dark disc against
 * a pale wall, and a pale face inside a dark disc. The brass is spent only on
 * the bezel and the hand, where it is a highlight and not a silhouette.
 *
 * **The hand does not move, and that is correct.** A ship's barometer carries a
 * set-hand: a brass pointer you turn by hand to mark where the glass stood when
 * you last looked, so that the next look tells you which way it has gone. That
 * is the hand modelled here, and a set-hand that never moves on its own is the
 * only kind there is. The *live* needle is in the instrument's face — open it,
 * as you open the chronometer — because a dial you must read to the tenth of an
 * inch is type, and type in a room is type you cannot read. `DeskFocus` settled
 * that argument for the manual and it settles it again here.
 */
function barometerPlacement(): RoomPlacement {
  return placeInRoom({
    space: 'cabin',
    from: 'centre',
    // Forward of the rack, clear of it by 0.13 m of open lining — enough that
    // the rack's shadow does not reach it and little enough that a seated head
    // turns to it rather than hunts for it.
    offset: rackOffTransom() + RACK_LENGTH / 2 + 0.13 + GLASS_RADIUS,
    length: GLASS_RADIUS * 2,
    hand: 'port',
    // Screwed flat to the lining, so its yaw is the lining's and not a number
    // anybody had to guess. The desk round's `align: 'side'` earns its keep on
    // every round object: a disc standing off a curved wall at one edge is a
    // joint that reads as a mistake even when nothing tests it.
    align: 'side',
    inboard: 0,
    width: GLASS_DEPTH,
    sill: GLASS_CENTRE_Y - GLASS_RADIUS,
    height: GLASS_RADIUS * 2,
  });
}

export function cabinBarometer(): InteriorFitting {
  const p = barometerPlacement();
  const { rod } = drawnIn(p.frame);

  // Port hand: `xHi` is the outboard side, against the lining. The instrument
  // is built from the wall inboard, the way it is screwed on.
  const atLining = p.xHi;
  const caseFront = atLining - 0.052;
  const bezelFront = atLining - 0.062;
  const dialFace = atLining - 0.060;
  const y = (p.yLo + p.yHi) / 2;
  const z = (p.zAft + p.zForward) / 2;

  const solids: FittingSolid[] = [
    // The turned timber case, and the whole reason the object has a silhouette.
    rod(v3(atLining, y, z), v3(caseFront, y, z), GLASS_RADIUS, GLASS_RADIUS, 'timber', false),
    // A proud brass bezel, tapering, catching the lantern along one rim.
    rod(v3(caseFront, y, z), v3(bezelFront, y, z), GLASS_RADIUS, GLASS_RADIUS - 0.006, 'brass', false),
    // The printed dial, recessed inside the bezel rather than flush with it.
    rod(v3(caseFront - 0.002, y, z), v3(dialFace, y, z), 0.086, 0.086, 'paper', false),
    // The set-hand: brass, off the vertical, and static on purpose.
    rod(
      v3(dialFace - 0.003, y, z),
      v3(dialFace - 0.003, y + 0.070, z + 0.030),
      0.004,
      0.003,
      'brass',
      false,
    ),
    // Its centre boss.
    rod(v3(dialFace - 0.006, y, z), v3(dialFace - 0.001, y, z), 0.010, 0.010, 'brass', false),
  ];

  return { name: 'cabinBarometer', kind: 'barometer', solids, standable: null };
}

/**
 * What the seated player's cursor tests against to open the glass.
 *
 * A hair larger than the case, because a 0.21 m disc across the cabin is a
 * small target and an instrument you have to hunt for with the mouse is an
 * instrument you stop looking at. Same shape as the desk's own items, so it
 * joins them in one pick list rather than needing a second mechanism.
 */
export function cabinBarometerTarget(): {
  label: string;
  view: 'barometer';
  box: InteractableBox;
} {
  const p = barometerPlacement();
  const pad = 0.02;
  return {
    label: 'THE GLASS',
    view: 'barometer',
    // Through `framedTarget`, so the box lies along the lining like the object
    // does. A bounding box would be slack in exactly the direction the piece is
    // turned — which here is straight into the lining and out through the hull.
    box: framedTarget(
      p.frame,
      Math.min(p.xLo, p.xHi) - pad,
      Math.max(p.xLo, p.xHi) + pad,
      p.yLo - pad,
      p.yHi + pad,
      p.zAft - pad,
      p.zForward + pad,
    ),
  };
}
