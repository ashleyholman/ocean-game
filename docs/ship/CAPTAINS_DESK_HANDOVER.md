# The captain's desk — round handover

Branch `claude/captains-desk-interaction-9d1b8f`, four commits, with master
merged in at `a7370d0` (the lanterns-below round). **Not merged into master.**
Suite green (1142 passing), `tsc --noEmit` clean, `npm run build` clean.

## How to look at it

```bash
npm run dev
```

Then `?interiorView=desk` opens **seated at the desk**. The composition is
fixed, so walking aft and down the companionway for every screenshot of it was
a tax on looking at the thing at all. Standing up leaves you in the cabin on
your feet; `V` still returns to the exterior.

**Look at it at night first.** The voyage opens at 19:02 local and the cabin
lamp will not have been struck yet; wind the clock into the dark and the lantern
lights itself, which is when the joinery is at its best. `?debug` gives the
slider, or in the console:

```
__drift.world.state.worldSecondsPerRealSecond = 0     // hold the clock
__drift.world.state.worldInstantUtcSeconds += 3600*3  // into the night
__drift.setLamps('on')                                // or wait for auto
```

Then wind back to noon to see the daytime case, which is the one still open —
see below. `__drift.captainsSeat`, `__drift.currentActions()`,
`__drift.lampsDebug()` and `__drift.adaptationDebug()` are all on the debug
surface.

## What landed

| | |
| --- | --- |
| **D1** | Chart desk, chart rack, chair. Three new materials: brass, baize, paper. |
| **D2** | Sitting and standing. `SeatedStation`, and it is not a camera mode. |
| **D3** | `ActionBar` — 0–2 contextual actions, same DOM on desktop and touch. |
| **D4** | `deskItems.ts`, a pointer pick in ship-local space, and the focus overlay. |
| **D5** | YE OLDE SAILING MANUAL: three spreads, one of them the points-of-sail plate. |

Controls: walk up to the chair and **Space** to sit. Seated, **click** an item
to open it (**tap** on touch), the arrows or a **swipe** turn pages, and
**Space** or **Esc** shuts the book. Space again stands you up. Every one of
those is also a button in the bar at the foot of the picture.

## The lanterns arrived, and they answer most of it

Master gained the lanterns-below round while this branch was out
(`a7370d0`), and it is merged in here (`e7edd12`). **The cabin lamp hangs at
x = 0.55, z = −6.4 — directly over the desk's forward end**, and clear of the
chart rack, which stops at z = −6.78. That is luck rather than design; if either
moves, check it again.

**Lit, at night, the desk reads.** The brass corner-pieces on the book and the
drawer rings go gold, the baize is a green cloth instead of near-black, the
paper label and the leaf edges are bright, and the barometer is a pale dial in a
brass bezel. The three materials this round added do the jobs they were added
for. Ash was right that this was what the desk was waiting for.

### A correction to this document's own headline number

The first version of this handover led with *"the seated view meters 0.11
against a target of 1.5 — it wants 13.7× and gets 1×"*, and treated that as the
measure of whether you can see the desk. It is not.

With the lantern lit at night the meter reads **0.0815** — *lower* than the
0.109 it read at noon with no lamp — while the picture is plainly brighter. The
adaptation meter tracks the **portal/daylight channels** and does not see the
lamp's direct point light at all. So the 13.7× figure is a true statement about
how much daylight reaches that corner and a misleading one about the view, and
it should not be quoted as the latter.

### What is genuinely still open: the desk by day

Under the shipping `auto` policy the cabin lamp is out at noon, and forcing it
`on` in daylight does almost nothing — `litLevel` is gated to 0.1 and
`renderEmission` to 0.008. So **the daytime desk is exactly as dim as it was
before the merge.**

That is the lantern round's own policy and it is defensible: a lamp is struck
when the light fails. But a captain working charts at noon in a room with four
small stern lights would light one, and the desk is now a concrete thing to
judge that against rather than an argument in the abstract. Ash's call, and it
belongs to the lamp policy rather than to this round.

## Things measured that contradict the plan

- **`SHIP_BELOW_DECKS_PLAN.md` §6 is wrong about the captain's cabin.** It
  promises 1.55–1.70 m of headroom "tapering at the sides", and uses that to
  justify putting furniture there. Measured, the deckhead is 1.83–2.00 m above
  the sole out at x = 1.2 m, and the lined side is the **same** half-width at
  the sole as at head height at every station in the room — those topsides are
  plumb. There is no low peripheral portion. The desk is still on the port side,
  for §4.1's other reason: the centreline is the route from the door to the
  stern windows and it is kept clear.
- **`placeInRoom`'s lean term does nothing in this room.** What it does instead
  is the fore-and-aft taper: 1.136 m of half-breadth at the transom against
  1.564 m at the forward bulkhead, 0.12 m per metre of length. A 1.30 m desk
  hard on the timber aft stands 0.12 m off it forward, and that gap is
  deliberate.
- **The desk's knee-hole is not a hole as far as a body is concerned.** The top
  slab collides across the whole length, so the gap only exists below 0.72 m and
  the walker is a 1.75 m cylinder. The first version of that comment claimed the
  opposite; it is corrected in `INTERIOR_FITTING_KINDS.chartDesk`.

## What was deliberately left out

- **More desk items.** The table takes them; this round ships one. A map, a log
  and a sextant each want a `view` and probably a field or two this row does not
  have, and a table with columns nobody fills is how the closure table would
  have ended up with a chair in it.
- **Working drawers.** Drawn, not opened.
- **Knots on the plate.** Ash's call, and the right one: the polar baseline the
  plate would have to read is stale (the slow suite is red on it), and a number
  printed in a period manual is a promise the model has to keep for as long as
  the drawing exists.
- **A physical opening book, page-turn geometry, or a camera push-in on the
  item.** The overlay cross-fades over a dimmed frame instead.
- **Anything mechanical.** The manual teaches; it never steers.

## Faults found by looking, and worth remembering

1. **The barometer was built back-to-front** — brass case inboard of the paper
   dial, so the only thing a seated player could ever see was the dark back of
   the instrument. A *fixed* view is seen from exactly one direction; there was
   no reason to guess which.
2. **The chart on the rack's lower shelf read as a strip light.** 0.64 m of the
   palest material below decks, lying across the front of the one composition
   the player sits and looks at.
3. **The book was invisible.** Bound in baize, lying in the middle of 0.36 m² of
   green baize. It was drawn exactly where it was asked for, in the colour of
   the thing behind it, and nothing would have failed a test. **An object's
   material is a statement about what is behind it, not only about what it is.**
4. **The seated view did not fit the field.** At the chair's natural 0.50 m of
   draw-out the composition spans 67° against an embodied field of 62°, and what
   got cropped was the near half of the desk — the half the items are on. The
   chair now draws out 0.60 m, which is measurement, not taste.
5. **The chair was a trap.** Seated, the reach pick is deliberately dead, so the
   one-line prompt named nothing and Space did nothing: you could sit down and
   not get up. That is what forced D3 forward, and the fix is structural —
   `currentActions()` is one list that both the bar and the key read.

## The merge worth knowing about

`shipInteractables.ts` conflicted, and the conflict is the interesting kind:
**two rounds arrived at the same wall independently.** The lantern round found
that the interactable registry could not describe a thing that is not a closure
— *"the lamps are the one kind of workable thing aboard that is NOT a closure"* —
and solved it with a `lamp:` name prefix plus a switch inside the registry's
single `isOpen`/`toggle` window. The desk round hit it with a chair and moved
the accessor onto the row instead.

Only one survives, and it is not the prefix — the seat would have been the third
branch of that switch. Rows now own their own accessor and effect,
`lampIdOfInteractable` is deleted (nothing outside that file used it), and the
`lamp:` namespace stays as a name with no machinery under it.
`buildShipInteractables` takes `{ lamps, seat }` rather than one positional
dependency.

## Files worth reading first

- `src/vessel/schooner/captainsDesk.ts` — the joinery, and why it is where it is
- `src/vessel/schooner/roomFitting.ts` — the anchor vocabulary, moved out of
  `interiorFittings.ts` and given a `sill` for wall-hung pieces
- `src/player/SeatedStation.ts` — why sitting is not a camera mode
- `src/vessel/schooner/deskItems.ts` — the item table
- `src/ui/sailingPlate.ts` — the plate, and where its angles come from
