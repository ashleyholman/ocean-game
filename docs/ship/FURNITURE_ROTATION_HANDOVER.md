# Furniture rotation — the placement model learns to turn a piece

Branch `claude/furniture-rotation-placement-6a970c`, off master `83dbb0e`.

The ask: *"our placement model for furniture needs to support rotation so that
our captain's desk can be rotated to fit better along that angled wall of the
captain's room."*

## What it does

A fitting can now say `align: 'side'` in its `RoomAnchor`, meaning *lie along the
wall you are against*. The angle is **not authored** — `sideTangentYaw` measures
the lining's own slope over that piece's footprint and height band, for the
reason `roomFitting.ts` has always given about anchors: an angle typed into a
fitting is a second source for something the hull already knows. Move the
bulkhead or change the sections and the furniture turns with them.

The captain's desk and the chart rack over it are the two pieces using it.

## The measurement

The cabin's port lining runs from 1.136 m of half-breadth at the transom to
1.564 m at the forward bulkhead — 0.11 m per metre of length, and it is a curve,
not a straight taper.

| | worst gap behind the desk |
|---|---|
| square, hard against the lining | **0.149 m** at the forward corner |
| lying along it at 6.6° | **0.015 m**, and it touches near the middle |

The residue is the sagitta of the side's own curve over 1.30 m of carcase.
`sideTangentYaw` takes the **chord** between the stations the piece's ends land
on, not the tangent at its middle: the tangent would bury both ends in the
timber. That last 15 mm stays — it is the gap Ash said was allowed when he
rejected the scribed filler. No joinery goes behind the desk.

## Where the rotation had to reach

Five places, and the round is mostly about the fact that it is five:

1. **`FittingSolid`'s box** gained an optional `yaw`. Absent means square, which
   every other box aboard is. What makes the optional field safe is that no
   reader unpacks a box by hand any more — `boxAxes`, `boxCorners` and
   `solidBounds` are the only ways a box becomes points.
2. **`shipwright.addBox`** builds the basis for the drawn triangles. It and
   `boxAxes` must agree; `ship-interior.test.ts` proves it by measuring every
   emitted vertex against the solids the list gave the loft.
3. **`deckObstacles`** carries the yaw into `ObstacleShape` and turns the
   column's segment. This cost almost nothing, and not by luck: a column was
   already a segment with a radius rather than a rectangle, because that made a
   raked mast the same problem as an upright one.
4. **`roomFitting`** gained `PieceFrame` — everything inside a fitting is drawn
   in the piece's own coordinates and converted once. This is why turning the
   desk changed no dimension of its joinery: "0.032 m of panel at the after end"
   is the same sentence at any angle. `framedBox` / `framedBar` / `framedTarget`
   are the three conversions.
5. **`InteractableBox`** gained a yaw too. See the finding below.

`Datum` also gained `'centre'`: the rack is positioned by where its middle has to
be (over the sitter), and saying that as a face offset would have made an author
compute the turned footprint — the derived quantity the module exists to own.

## Three findings

**A player in the landing could already sit down in the captain's chair, through
the bulkhead.** `REACH` is 2.2 m and the cabin is 3.5 m long; measured on master,
a body anywhere in the first **0.30 m** of the landing was within reach of the
chair's target. `ship-interior.test.ts` had a test for exactly this and it passed,
because the point it stood at was 50 mm past the edge of the band. Turning the
desk swung the standing volume 0.086 m forward — correct geometry — and widened
the band to 0.50 m, which is how it surfaced.

Fixed at the source rather than by tuning the target: `Interactable.within` is an
optional volume a body must be in for a row to be offered at all, and the chair's
is the cabin. It is a **veto, not a second target** — inside the room the reach
and the cone are exactly what they were, so nothing about sitting down feels
different. Every closure leaves it out, because a hatch is worked from either
side of the deck it is cut in.

**The fit is solved on samples, so the sample count is load-bearing.** At the
nine-per-edge density `sideLimitOver` uses for a *reported* limit, the desk's
outboard face went 0.03 mm into the lining between two samples. Harmless here and
it scales with the square of the spacing, so it would not have stayed harmless on
a longer piece against a tighter curve. `SIDE_FIT_SAMPLES` is 33 for the limit a
piece is actually pushed up against.

**Aiming beat standing, and it did not.** `pick`'s own comment says a box the
ray genuinely enters "always wins", and that was written as *scores zero* — which
is not the same thing once something else can score zero for another reason. A
body inside a target volume is nought degrees off it and nought metres from it,
so it tied with whatever was being aimed at and took the tie on distance. The
captain's chair is the volume that shows it: its target is a metre of clear sole
you walk through to reach the desk, the cabin's lantern hangs over that same
sole, and pointing **straight up at the lantern** from the centreline abreast the
desk offered the chair. Aiming harder could not help, which is what makes it a
fault in the ranking rather than a target that wants shrinking.

An entered box now outranks an occupied one. The underfoot cone is untouched and
still does what it was written for — a hatch you are standing on and *not*
looking at is offered without aiming, because then there is nothing entered to
outrank it. `ship-interior.test.ts` covers both halves, and the first half fails
on the old ranking.

## Not done

- **Nothing but the cabin's furniture turns.** The wardroom's chests and the
  forecastle's berths are still indicative blocks in the plan drawing, not built
  pieces. When they are built, `align: 'side'` is there.
- **No authored angle.** There is deliberately no way to say "turn this piece 30°"
  — a corner cupboard or a cot across a quarter would want one, and it can be
  added with the reason that asked for it beside it.
- **`tools/plot-below-decks.mjs`** now draws the desk and its chair from
  `chartDeskGeometry()`. The rest of the cabin's furniture in that drawing is
  still hand-typed and still stale.

## Ash's eye is owed on

The desk at 6.6° in the room, standing and seated. The seated composition is
unchanged by construction — the eye and its heading both go through the desk's
frame — but that is an argument, not a verdict.
