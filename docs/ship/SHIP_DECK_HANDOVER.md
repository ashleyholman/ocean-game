# M3, the walkable deck — round report and handover

**Status: the body walks, and the deck is furnished. Section 6 is what is left.**

Two slices. The first put a player on the schooner — she walks bow to stern,
climbs to the quarterdeck and looks around from a real eye height, with the
collision model derived from the ship rather than typed out beside it. The
second put the working structure under her feet: cargo hatch, bilge pump, mast
partners, windlass, the bowsprit's heel, and the tiller with its swept arc.
Section 8 is the second slice's report; sections 1–5 are the first's and still
hold. Section 6 is now the remainder of M3, revised.

Read `docs/ship/SHIP_ROUND_HANDOVER.md` for the milestone ladder and `docs/ship/SHIP_SPEC.md` for
the vessel. This document covers what M3's first slice built, what it found, and
what the next session should pick up.

---

## 1. What landed

| File | What it is |
|---|---|
| `src/vessel/schooner/deckSurface.ts` | The walkable deck as a **surface**. Levels, camber, the counter's rake inverted, and the quarterdeck ladders. |
| `src/vessel/schooner/deckObstacles.ts` | Every solid a walker can hit, derived from the rig's own lists, plus the index the walk tests against. |
| `src/player/DeckWalker.ts` | The body: ship-local, gravity from the vessel's transform, step, slide, footprint. |
| `src/debug/DeckPanel.ts` | `TOOLS → Deck & walking`. Sliders, collision overlay, five stations to stand at, live readout. |
| `tests/ship-deck.test.ts` | 18 tests: mesh against surface, ladder round trip, source completeness, walk invariants, reachability. |

Changed outside the deck: the embodied camera takes an injected eye anchor;
`InputController` tracks held movement keys; `hullForm.ts` gained
`counterStationZ` and owns the counter's shear; `shipGeometry.ts` samples the
deck surface instead of describing its own.

**The loft came out bit-identical** when the deck surface moved out of it —
checked by hashing every region's vertex buffer before and after. The ladders
are the only new hull geometry in the round.

### The architecture, in one line

`shipGeometry.ts` draws the deck by sampling `deckSurface.ts`; `DeckWalker`
stands on the deck by querying `deckSurface.ts`. Neither describes it. That is
the same contract `hullForm.ts` already holds with the flotation model, and it
is the round's one non-negotiable: a floor that the renderer and the collision
model each describe separately fails the way `rig.ts` failed when it carried its
own guess at where the bulwark was — except that the player walks *through* the
disagreement instead of looking at it.

`DeckWalker` knows nothing about the schooner. It takes a `DeckEnvironment` —
"what is the floor here" and "what is solid" — which the schooner satisfies from
the two files above.

---

## 2. The faults this round found

Every one of these was invisible to the suite that existed when the round
started.

**The embodied camera was inside the hull.** `EYE_ANCHOR` is the raft
castaway's eye, derived on paper from a seated figure: local y 0.905. On the
schooner that is 2.9 m below the walking deck and 1.4 m below the sea. `V`
aboard her put the camera in the dark, and nothing gated the toggle — it was
reachable in the shipped build. An anchor that is a constant of one vessel
cannot be a constant of the camera.

**The counter's shear means a position is not a station, and that bit four
separate things.** Abaft z = −6.2 and above the waterline, the ship's side and
deck are carried up to 0.79 m aft of the station they belong to. In turn:

- the deck query had to invert it — and the obvious fixed-point iteration
  **oscillates** rather than converging, because the shear's ramp reaches
  0.6 m/m under the quarterdeck. Five passes left it 0.3 m out, which read as
  the after end of the quarterdeck not being deck at all. Bisection.
- the rope-versus-hull check was written in station coordinates, so it had a
  blind spot exactly over the counter — which is where the main sheet crosses
  the rail.
- the bulwark check that already existed had the same blind spot and had been
  reading rail sections from the wrong part of the ship for every rope over the
  quarter.
- the stern caprail's inboard edge was inset along the transom's *raked* normal,
  which lifted it 45 mm and moved it 139 mm forward — the rail was a plank
  tipped up toward the deck.

`counterStationZ` in `hullForm.ts` is the one inversion now. Anything that knows
only where it is and needs to ask the hull a question goes through it.

**A deck break is two surfaces, not one.** The quarterdeck is 0.55 m higher and
0.07 m narrower each side than the waist, and a single-level lookup answered "no
deck" in that 0.07 m — a hole at the foot of the riser, exactly one vertex wide
in the drawn mesh, which is where it was found. Levels are a union; the highest
that admits the query wins.

**The ladders were drawn backwards, and the test that would have caught it
excluded them.** `stairTreadIndexAt` maps a position to a tread and
`stairTreadZ` maps a tread to a position; they were written separately and were
not inverses, so the walker climbed a correct flight while the timber descended
toward the quarterdeck with its tallest step stranded on the deck. The
mesh-versus-surface test skipped the ladder footprint. **An exclusion in a test
is where the next fault will live.**

**Flat treads against a cambered deck read as crooked.** The deck is crowned
1/50 of its beam, 90 mm across the half-breadth. Every tread was perfectly
horizontal, and horizontal was the fault: a flat plane agrees with a curved deck
along one line and tilts away from it everywhere else. Treads carry the deck's
camber now.

**`fifePin(rail, index, side)` — `side` did not mean side.** It multiplied an
offset that was already signed, so `side: -1` on an inboard index returned a pin
to *starboard*. (Side words in this story are the pre-W1 mirrored labels of
their day — the 2026-08-05 relabel in `hullForm.ts` flipped every side word in
the vessel sources; the geometry is unchanged.) The comment directly above
those pins says they belay to port,
"the weather side, because everything is sheeted to starboard and a fall hanging
down the lee side would lie inside the sails". They were hanging exactly there:
the main halyard's fall and the fisherman's sheet fall both passed through the
main boom, one through the mainmast as well. **Same family as `Sail.side`, which
was documented "+1 to starboard" and bellied every fore-and-aft sail to
windward. A sign is not a side until something checks it.** The same function
also drew each pin twice — eight meshes in four places.

**The main sheet passed through the quarter rail, and the check said it was
clear because it measured the wrong rope.** It sampled the straight line between
the ends, and only the centreline. A main sheet is 34 mm thick and sags 18% of
its length. Measured as the rope that is *drawn* — `riggingRunPoint`, the curve
the loft sweeps its tube along, probed at the rope's surface — it was 31 mm
inside the caprail. **Test the thing that is drawn, not the idealisation it was
built from.**

**A developer slider could take the keyboard hostage.** A focused
`input[type=range]` consumes the arrow keys and swallows the rest, so moving one
slider stopped the walk with no visible cause. Controls release focus now, and
the keydown filter no longer treats a slider as a text field.

**A clamp that binds silently is indistinguishable from a dead control.** The
field-of-view slider showed the number it asked for rather than the number it
got, and the vertical guard band pinned it over two thirds of its travel. Both
are fixed: the band is 40–90°, and the panel reports the vertical it actually
received beside the horizontal it requested.

---

## 3. The checks that are now standing

Three of these are *categories* of check the suite did not have, which is the
rig round's lesson applied: an intersection suite keyed to one list stops
covering the ship the moment geometry lands in a different list.

- **Mesh against surface** (`ship-deck.test.ts`). The loft samples 140 stations
  by 8 columns and applies the rake as it places each vertex; `deckStandAt`
  inverts that rake to answer a continuous query. Two different computations,
  one surface, so agreement is a result rather than a tautology. Checking the
  walker against `deckStandAt` instead would prove nothing — they are the same
  expression.
- **Source completeness** (`ship-deck.test.ts`). Every exported collection in
  `rig.ts` is either collidable or explicitly not, with a reason, and the test
  enumerates the module. Adding a new list fails until someone has decided
  whether a person can walk into it.
- **Rope against spar** (`ship-rig.test.ts`). A rope may END on a spar, and that
  excuse is available only when the nearby endpoint is *measurably* on that
  spar. Found fourteen; eleven fixed, three listed with measured depths (9, 13
  and 25 mm, all at a crowded masthead).
- **Rope against the ship** (`ship-rig.test.ts`). The drawn, sagging rope of its
  real thickness against the planking, the bulwark and the caprail, in placed
  coordinates.
- **Belaying room** (`ship-rig.test.ts`). A pin is a thing you take turns of
  rope around: a hand's width to its neighbour and to the stanchion.
- **Walk invariants** (`ship-deck.test.ts`). Never off the deck from six starts
  in sixteen directions; never inside a solid; the ladder climbs and the bare
  break does not; and a flood fill driven through the walker's own move routine
  proving the waist, the forecastle, the quarterdeck, the helm and both gangways
  reach one another.

---

## 4. The numbers, and who chose them

Everything in the first column is a slider in `TOOLS → Deck & walking` or
`TOOLS → Graphics`. The shipped values are Ash's, found by walking her.

| | value | note |
|---|---|---|
| Eye height | 1.62 m | on a 1.75 m stature; the boom clearances were measured against it |
| Body radius | 0.26 m | |
| Walk speed | 3.0 m/s | brisk; she is 15.5 m and a slower body is always in transit |
| Response | instant | a ramp on a body already carried by a heaving deck reads as the deck's lag |
| Step smoothing | 0.12 s | the *eye* lags the feet on a step up; the body's height still snaps |
| Step up | 0.32 m | |
| Step over | 0.40 m | clears the sheet horses, which `rig.ts` says are meant to be stepped over |
| Heel slip | 0.35 | fraction of gravity's in-plane pull that reaches the walker |
| Look sensitivity | 3.5× | fields of view per screen-width of drag |
| Field of view | 112° horizontal | ~76° vertical at 16:9. Wider than the 90–105 convention; the edge distortion that usually argues against it did not appear, because a deck's geometry near the frame edge runs fore-and-aft |
| Roll / pitch follow | 0.65 / 0.65 | **not** the raft's 0.10 / 0.20 — see below |
| Heave follow | 1.0 | |
| Sun shadow strength | 0.5 | |

**The head model is per-body, not per-project.** The raft's 0.10 / 0.20 / 0.90
came from an argument about a seated castaway with nothing to hold and no frame
of reference, and it does not transfer: a player standing on a deck with a rig
overhead and a rail against the horizon reads a tilt as *the ship* moving.
`WALKING_STABILISATION` is the standing model; the raft keeps its own.

Sun shadows at half is a first-person argument specifically: the sails are tall
and sway, so every shadow on the planking is moving continuously, and a
hard-edged moving shadow a metre from the eye is far more present than the same
shadow seen from outside the hull.

---

## 5. Tools

- **Dev server `drift-deck`, fixed port 5197.** Fixed on purpose: the default
  `drift` config uses `autoPort`, so any link from it dies on restart.
- **`TOOLS → Deck & walking`** — body, walk, look, head, a wireframe overlay of
  the collision *columns* (the approximation, not the geometry it came from, so
  a collider fatter than its timber is visible as exactly that), five stations
  to stand at, and a readout measured after the body moved.
- **Controls**: `V` aboard, `WASD`/arrows to walk, drag to look. The gaze
  follows the pointer; invert flips both axes.

**A trap that cost an hour:** when the browser pane's tab is backgrounded,
`document.visibilityState` is `hidden` and `requestAnimationFrame` stops, while
screenshots keep returning the last painted frame. The app looks live and is
frozen — readouts empty, walker still, `V` apparently dead — because DOM events
still fire but nothing steps. Check `document.visibilityState` before believing
any "it does not respond" symptom.

---

## 6. What is left in M3

Items 1–3 are done — section 8. What remains, in the order I would take it.

1. **Ash's verdict on the arrangement.** The fittings are built, tested and
   period-defensible; whether they *read* is his eye, not the suite's. The
   specific things I would look at first are listed at the end of section 8.
2. **The head model in a seaway.** 0.65 / 0.65 / 1.0 was settled in moderate
   conditions. `ship-hydrostatics.test.ts` already asserts M3's comfort gate
   — under 26° of roll in `CURRENT_MODERATE`, under 10° in `WIND_CHOP` — but
   nobody has *stood* on her in `SOUTHERN_OCEAN_ROUGH`.
3. **First-entry touch HUD hint.** Touch walking is now implemented: aboard the
   schooner, a left-side drag walks and a simultaneous right-side drag looks;
   cinematic orbit and pinch are unchanged. The convention is intentionally
   invisible for this input slice, so a later UI pass must teach it when the
   player first enters embodied view — ideally a short left/right instruction
   plus transient thumb markers, shown once rather than permanent controls.
4. **A player-facing field-of-view setting.** The slider is a developer control
   and persists nothing. It is the one graphics setting people genuinely differ
   on.
5. **Three rope-versus-spar fouls**, 9/13/25 mm, listed in `ship-rig.test.ts`
   with their measured depths so they cannot get worse quietly.
6. **The helmsman stands under the main boom at 1.31 m.** Period-true, and
   currently harmless because the boom is drawn sheeted 26° to port and the
   centreline at the helm is clear. It becomes real the moment M6 lets the boom
   come amidships, and it should be a decision rather than a discovery.
7. **The dressing pass.** `docs/ship/SHIP_SPEC.md` section 8 also asks for casks, a
   restrained number of barrels, lashed sailcloth, spare spars, rope coils at
   their working stations, chests, a small lashed dinghy, a binnacle, a stern
   lantern and a skylight. Deliberately not in this round: it is loose gear, and
   loose gear is what M6 will want to move, lash and wet. The companionways want
   M4's below-deck to exist first.

Not in M3, but the deck surface will have to grow for it: **M4 needs a second
floor.** The contract answers one height for any (x, z), because on an open deck
there is one. A cabin under a deck means two, plus a ceiling that stops a player
standing up through the quarterdeck. That is the real structural work in M4,
more than the cabin's furniture is.

---

## 7. Acceptance

M3's gate in `docs/ship/SHIP_ROUND_HANDOVER.md` is: *a player can walk bow to stern and
around both masts without snagging; no collision gaps; motion is comfortable in
`CURRENT_MODERATE` and survivable in `WIND_CHOP`.*

The first two are met and tested — the reachability fill proves bow-to-stern and
both gangways, and the invariants prove no gaps. The third is met by the
hydrostatics gate and by Ash walking her, in moderate conditions only.

498 tests pass. The two `ship-hydrostatics` free-decay tests that used to fail in
a full run and pass alone were never flaky: they are 14,400 physics steps inside
a 5-second default timeout. They have 30 seconds now.

---

## 8. The second slice: the deck furnished

| File | What it is |
|---|---|
| `src/vessel/schooner/deckFittings.ts` | Every fitting as data, in **placed** coordinates. Solids, materials, what collides, what you stand on. |
| `src/vessel/schooner/deckFittingGeometry.ts` | The loft. Two regions — oiled oak and wrought iron. |
| `shipwright.ts` | Gained `addTube`, `addBox` and `frameFor`, moved out of `rigGeometry.ts` where they were private. They are the primitive layer that file exists to be. |

What is aboard: a **cargo hatch** amidships with a 0.28 m coaming and a grating
you stand on; a **bilge pump** at the mainmast with its brake and discharge; a
**partner** collar at each mast; a **windlass** across the forecastle on its bitt
heads; the **bowsprit's heel** bitted, chocked, bolstered down to the planking
and gammoned to the stemhead with an iron band; and the **tiller**, socketed in
the rudder head, with the arc it sweeps kept clear by test.

Scope was Ash's call at the top of the round: working fittings only, and **no
capstan** — `docs/ship/SHIP_SPEC.md` section 8 names a windlass and riding bitts and no
capstan, and on a 15.5 m hull a capstan is a second anchor machine standing in
the waist against a spec line that says do not dress her as a pirate set.

### 8.1 The architecture

`deckFittings.ts` is the single description and it is in **placed** coordinates
throughout — where a thing is, which is what a walker, a camera and a collision
test all work in. Every height in it comes through one function, `standOn`,
which asks `deckStandAt` and throws rather than inventing a plausible number.

Three consumers, none of them describing anything: the loft draws it, the
obstacle index derives colliders from the pieces that declare themselves solid,
and `schoonerStandAt` in `deckObstacles.ts` composes the walker's floor as the
union of the deck and any fitting top.

**The union lives in `deckObstacles.ts` and not in `deckSurface.ts`, and that is
dependency rather than taste.** A fitting must ask the deck how high it is before
it can say how high its own lid is, so a deck surface that also knew about
fittings would close the ring.

A standable panel is the *cheap* half of the problem M4 has to solve: a panel is
**higher** than the deck, so "the highest surface that admits the query wins"
answers it — the rule `deckStandAt` already uses across the three levels. A cabin
sole is **lower** than the deck above it, and that rule cannot answer it at all.

`FITTING_KINDS` is `OBSTACLE_SOURCES` for the furniture, and it had to be a
separate guard: that one enumerates `rig.ts` and would have gone on passing
forever while a whole second module of solid objects grew beside it. **A
completeness check is only complete about the thing it enumerates.**

### 8.2 What the round found

**The tiller's length is solved, and the first solve did not bind.** Her counter
is 1.20 m in half-breadth abreast the rudder head against 2.27 m amidships, and
it narrows in exactly the direction the tip travels — so the reach at full helm
and the deck's width at the station it reaches are two curves that cross, and the
crossing is the length. Measured against `deckHalfWidth` the constraint never
bound and the solve returned its own upper bound, because **`deckHalfWidth` is
the wall where it meets the floor and the tiller never sweeps there**: it runs
0.30 m up at the socket and 0.95 m at its end, and the bulwark tumbles home
0.11 m per metre, so at the tip the planking stands 0.10 m further inboard than
the deck it is measured over. That is the rig round's fault — a fitting placed
against a wall that was not there — arrived at from the other direction. Against
the wall at the tiller's own height: **2.00 m of tiller at 35° of helm**, with
0.10 m of air to the planking at the binding point.

**The tiller was not a rigid bar.** The first version recomputed its rise from
the deck under each swept point, which made it bend upward as the helm went over
and put its tip 1.37 m above the planking at full helm. A tiller is a bar in a
socket: its height above the deck is a property of the bar, and the helm rotates
it about the stock.

**The main sheet horse had to move, and height clearance could not save it.** At
z = −7.0 it stood 0.35 m forward of the rudder stock, in the middle of the sweep.
The bar itself would have passed under the tiller by 35 mm; its traveller block
hangs a sheave 0.13 m above the bar and would not have. And even a taller tiller
does not clear it, because **the sheet is a rope crossing the arc** — vertical
where the tiller is horizontal. It is now abaft the rudder head at z = −8.05,
across the counter, which is where a tiller-steered gaff vessel carries it: the
boom overhangs the transom by two metres and the sheet drops to it. Narrowed to
±0.62 from ±0.72, because the counter is narrower there and the old span left
0.45 m to the planking — the gangway rule's own threshold, met by 3 mm.

**A horse stood on the deck of the station it shared a number with.**
`horseAt` read `walkingDeckY(z)` — a parameter-station function — against a `z`
that is a placed position, and over the counter those differ. The main horse's
feet were buried 33 mm in the planking. Third instance of the round's
transferable finding.

**The gangway test measured the deck with the expression `deckSurface.ts` exists
to delete.** `halfBreadthAt(z, deckAtSideY(z) - 0.02) - 0.14` — the same
second description of the deck's edge that `rig.ts` once carried, against a wall
0.09 m thick that tumbles home. It agreed with the real surface to about 40 mm
amidships, so nothing ever caught it; moving the horse abaft the shear made it
answer **−0.14 m** of half-breadth at a station where the deck is 1.17 m wide. A
test that derives the truth its own way cannot check the code.

**A box collider cut its own corners.** `buildColumns` inscribed a capsule in
each box — segment stopping a radius short of the half-length — so the cap
clipped all four corners: 19 mm on a hatch coaming, and a corner is exactly where
a body walking a diagonal meets a fitting. It runs the full half-length now and
costs a radius of extra reach off each end, which is the direction this model is
documented to err in.

**A level hatch on a sheered deck is two different steps.** She rises 85 mm over
the hatch's own 1.98 m, so the coaming stands 0.28 m proud aft and 0.195 m
forward. Both are steps a body takes; an assertion that treated it as one number
failed first.

### 8.3 Numbers, and what set them

| | value | what set it |
|---|---|---|
| Hatch coaming | 0.28 m | bounded by `stepUp` = 0.32: taller and the lid is an island in the working deck. Asserted against the walker's tuning, not against 0.32 written twice. |
| Hatch opening | 1.80 × 1.50 m | the waist at z = 1.4, its widest, leaving 1.41 m of gangway each side |
| Windlass | z = 4.86, barrel 0.52 m proud | the only place it fits — see below |
| Bowsprit bitts | z = 5.35, ±0.30 m | straddling the sprit at its own radius, chocked to it |
| Tiller | 2.00 m, 35° helm, 0.30 → 0.95 m up | solved against the bulwark at its own height |
| Main horse | z = −8.05, ±0.62 m | abaft the rudder head; span from the counter's half-breadth |
| Rudder stock | z = −7.75 | derived: the sternpost's head at the after perpendicular, `TRANSOM_FLOOR_Y` |

**The forecastle's centreline is deliberately closed, and the hull chose it.**
The break is at z = 4.6, the bowsprit's heel at z = 5.15, and from the heel
forward the sprit's underside runs 0.12–0.34 m over the planking the whole way —
so nothing at all stands under it. That leaves 0.55 m of clear deck and the
windlass fills it. She is crossed forward by the 0.90 m gangways outboard of the
bitt heads, and the reachability fill proves the head is still reachable. This is
the honest answer to "is she cramped because she is 15.5 m, or because of what is
standing on her": forward, it is the bowsprit, and its line is not moveable — it
was pinched against the jib geometry in the rig round.

### 8.4 What I would look at first, with Ash's eye

Nothing here is a test failure. They are the things I would not sign off myself.

- **The bilge pump's brake.** It lies forward and down from the pump head and
  from some angles reads as a bent pole rather than a lever. A pump brake at rest
  might be better shipped upright, or athwartships.
- **The mast partners.** A tapered collar 0.075 m proud. In the mast's own shadow
  it can read as a dark lump rather than as wedged timber.
- **The tiller's length.** 2.00 m is what the counter permits at 35° of helm, and
  on a 5.35 m quarterdeck it looks short. The trade is explicit and either end of
  it is defensible: a longer tiller costs helm angle. Both numbers are one
  constant each.
- **The fitting timber's colour**, 0x6a5232 against the deck's 0x8d7a5c —
  deliberately darker and redder, because deck planking is scrubbed and fittings
  are not.

### 8.5 A trap worth knowing

The Browser pane reports `document.visibilityState === 'hidden'` between tool
calls, so `requestAnimationFrame` stops and **the walker does not move for
dispatched key events** — `movementAxes()` reads 1 while the body stays put.
Screenshots still force a paint, so the scene looks live and is frozen. This is
the same trap section 5 records, met from a different direction: it is not just
"it does not respond", it is any test of *motion* driven from outside the page.

---

## 9. Ash's first walk of the furnished deck

Nine reports. Four of them were one fault in a primitive.

**Every round object aboard was an open pipe.** `addTube` drew the wall and no
end discs, and with front-face culling that does not read as a hole — it reads as
**transparency**: the near wall draws, the far wall's inside is culled, and you
look through the end of a solid baulk of oak into the sky. Ash found it on the
bowsprit, the tiller, the pump, the pump's brake and the mast partners in one
pass, which is what a fault in a primitive looks like from the deck. It had been
there since the rig round and nothing had ever stood close enough to a spar's end
to see it.

`addTube` caps both ends now, from the same rings the wall uses so a disc cannot
sit off the timber it closes. Rope and ratlines opt out: they end inside blocks,
coils and eyes, and there are 78 ratlines.

The first capped build had **all 488 discs wound backwards**, and
`ship-rig.test.ts`'s winding check said so on the first run. That is twice that
test has caught the same class of fault, and the third time on this ship that a
quantity depending on local ordering has come out reversed from an argument that
sounded right. **`tests/ship-deck.test.ts` now carries the same measured check
for the fittings**, plus a closure check — no edge used an odd number of times,
which is what an open tube end *is*, stated as a property rather than as a
screenshot.

**The hatch could only be climbed from part of its edge.** The lid was level from
the crown at the hatch's middle, and the deck is neither level nor flat: she rises
85 mm over the hatch's length and falls 18 mm across its breadth to the camber, so
the after outboard corners stood **0.334 m** below the lid against a 0.32 m step.
Two corners of four were unreachable. The coaming is set from the **lowest** deck
around its own perimeter now, so the tallest step onto it is the coaming height by
construction. Two tests: the worst step anywhere on the perimeter, and a body
walking on from sixteen headings.

**The windlass's gudgeon reached neither thing it joins.** It started 0.02 m
outboard of the barrel's end and stopped 0.06 m short of the bitt — a 20 mm stub
in a 20 mm gap. Two numbers that were never checked against each other. It now
runs from inside the barrel to the bitt's face, and the whelps run the barrel's
full length instead of stopping short and leaving a bare collar at each end.

**The bowsprit's heel ended in mid-air.** Ash asked directly whether it was meant
to front up against something. It is — a bowsprit is in compression and every
headsail pulls it forward — so there is a step abaft the heel now, from the
planking to over the sprit's top, that the heel butts into. The test tells the
step from the bolsters by which side of the heel they are on, not by a name.

**The gap between the quarterdeck ladders was a trap.** 1.6 m of nothing between
two flights, with the mainmast in the middle of it: wide enough to walk into and
too short to climb. `xInboard` is 0.40 in from 0.80, which is the mast's collider
radius plus a body's — squeeze past the mast and you are already on the timber.
The old test asserted `xInboard > 0.7` and `>= mainFife.halfSpan`, which justified
the number beside it and was wrong about why: the fife rail is abaft the break and
never constrained the flight at all.

**Head stabilisation is 0.40 / 0.40 / 1.0**, down from 0.65 by Ash's call. The
0.65 was settled on a bare deck; with a hatch, a windlass and a tiller in shot
there is far more near geometry holding still relative to the planking, so the
ship's motion reads from the scene and the head carries less of it.

**The bulwarks are not two colours.** `addMirrored` hands the same colour array to
both sides, so port and starboard are identical by construction and no hull paint
changed this round. What reads as a second colour is the *outboard* topsides
(0x3a2f27, near-black tarred timber, which takes a blue sky at a grazing angle)
seen past the bow where the deck narrows, against the inboard bulwark's warm red.

**The main boom is too low to stand under at the helm, and that is a rig
decision.** Measured: the boom's underside is **1.39–1.43 m** over the quarterdeck
across the tiller's whole reach — and 1.39 m with the boom amidships, where it
matters. A 1.75 m body does not fit. It does not bite today because she is drawn
sheeted 26° to port, so the boom is 1.8 m off the centreline at the helm and
the reachability fill gets there; it becomes real the moment M6 lets the boom
come in. Ducking at the helm is period-true and 1.39 m is low even by that
standard. The fix is to raise the main gooseneck or peak the boom, both of which
move the mainsail's luff and were pinched against the fisherman and the topsail in
M2 — so it belongs to a rig round, with a number: **+0.36 m of gooseneck buys
standing headroom.**

Still open from §8.4: the pump's brake, and the mast partners.

---

## 10. The boom over the helm

Ash's call after §9: *"You need to fix the sail plan to make manning the helm
possible while that boom swings. Some ducking is ok if it's necessary and
period-correct."*

### What the measurement actually said

The 1.31 m in §6 was the wrong number in two ways, and re-measuring changed which
problem this was.

The existing headroom check measured `boomYAt(z) - 0.098 - walkingDeckY(z)`, and
`walkingDeckY` answers for a **parameter** station against a placed z — the same
blind spot that has now bitten this ship seven times — *and* for the deck **at the
side**, which is 90 mm below the crown a body walks along. Both errors flatter the
clearance. Measured against `deckStandAt`, the truth was:

| | as drawn | amidships |
|---|---|---|
| main boom, worst | **1.23 m at z = −2.4** | 1.23 m |
| main boom, over the helm | 1.38–1.44 m | 1.38–1.44 m |
| fore boom, worst | 1.39 m at z = 3.9 | 1.39 m |

So the worst point on the ship was not the helm at all — it was the **quarterdeck
break**, where the deck steps up 0.55 m under a boom that is still near its
gooseneck. And the clearance is nearly *constant* down the whole quarterdeck,
because the boom rises 0.084 m per metre aft and the deck rises 0.065.

### Why the helm is a different question from the rest of the deck

Everywhere else, ducking is period-true and fine: you see it coming, you bend, you
keep walking. The helm is the one station where a body **cannot step aside** —
the thing he is holding is the reason he is there — and the boom crosses over him
every time she goes about. At 1.38 m that is not a duck, it is a kneel, and the
collision model would have refused to let him stand there at all the moment M6
lets the boom come amidships.

### The geometry, and the two levers

**The boom is pivoted over the waist and sweeps the quarterdeck, which is 0.55 m
higher.** A gooseneck set comfortably for the deck it stands on is half a metre
too low for the deck it works over. That is the whole problem, and it is why this
is the second time the main gooseneck has been raised for headroom.

- **Raising the gooseneck** lifts the whole boom and costs **luff** — the sail's
  entire hoist.
- **Peaking the boom** lifts only the after half and costs a **corner of the
  foot**.

The main needs its clearance aft, so it takes both, weighted toward the cheaper
one: `MAIN_GOOSENECK_Y` 5.75 → **6.15**, and `BOOM_RISE` splits into
`MAIN_BOOM_RISE` **0.95** (6.3° above horizontal, from 4.8°) and
`FORE_BOOM_RISE` 0.72, unchanged. The last 0.09 m at the helm came from the rise
for about a tenth of what the same clearance would have cost in luff.

| | before | after |
|---|---|---|
| helm station, boom amidships | 1.38 m | **1.87 m** (body 1.75) |
| quarterdeck break | 1.23 m | 1.63 m |
| fore boom, worst | 1.39 m | 1.39 m |

Cost: **0.40 m off the mainsail's luff**, about 5% of her largest sail. The fore
boom is untouched — it works over the flat waist, its worst point is at its own
gooseneck where peaking it up would do nothing, and nobody has to stand still
under it.

### What now holds it

- `ship-deck.test.ts` — **the helm can be manned with the boom amidships**, at
  more than a body's standing height, over the whole station a hand needs to hold
  the tiller through its sweep. The boom is un-swung from the **drawn spar**
  rather than read off the rig's constants, so `SHEET_MAIN` can change and the
  test still asks about the boom that exists.
- `ship-rig.test.ts` — headroom along the whole deck, measured from
  `deckStandAt`, floor 1.25 m: a duck, not a crawl.
- `ship-deck.test.ts` — **headroom over the cargo hatch's grating**, which is a
  floor 0.28 m up that did not exist when the rig's check was written. The fore
  boom amidships leaves **1.54 m** over it. Recorded, not fixed: Ash's rule in
  reverse — nobody has to stand on a cargo hatch while she goes about, and you
  step off. Raising the fore gooseneck is the fix if it ever matters, at the same
  kind of cost.

---

## 11. The gaff topsail's foot, and a one-ended experiment

Ash, looking at the broadside: *"the upper sail above the mainsail, the bottom of
it doesn't really come close at all to the top of the mainsail… when I look at
pictures of topsail schooners, they often have no giant gap."*

He was right, and the reason it was there is worth keeping.

### What it was

The main gaff topsail was tacked at **15.35**, 0.20 m above the mast cap, instead
of down at the jaws. That left a wedge of daylight **2.35 m deep at the throat**,
closing to 0.03 m at the peak, and a sail of 11.54 m² — 20% of the mainsail,
where the type carries nearer 30%.

It was deliberate. With the tack at the jaws, the sail, the gaff and the peak
halyard are all in the same swung plane, and the halyard's inboard end is 1.63 m
above the sail's tack: the rope runs *inside* the sail's triangle for most of its
length, 0.015 m from the cloth against a rope of 0.012 m radius. The M2 round
tried four times to route around it, concluded that "the clearance never came
from lateral offset at all — moving the block 0.22 m further to starboard changed the
distance by 0.004 m", and raised the tack instead.

### Why that conclusion was wrong

**It was drawn from a one-ended experiment.** A halyard is a chord: move one end
and it pivots about the other, and the middle — which is where the cloth is —
barely stirs. Swept properly, with the tack back at the jaws:

| | closest approach |
|---|---|
| masthead block alone, 0.10 → 0.40 m to starboard | 0.028 → 0.035 m |
| gaff end alone, 0.06 → 0.18 m to starboard | 0.010 → 0.009 m |
| foot carried higher off the gaff, 0.3 → 0.6 m | 0.014 → 0.024 m |
| **both ends: 0.32 m at the mast, 0.12 m at the gaff** | **0.094 m** |

Moving both ends *translates* the run instead of pivoting it. **An offset that
"does nothing" may be an offset that was only ever applied at one end of the
thing being offset.**

### What landed

- Tack back to `MAIN_THROAT_Y + 0.3` — hauled down close to the jaws.
- The peak halyard rigged **down the weather side**, using fittings that already
  existed: `mastheadBlock`, which hangs a block off a masthead's starboard side on
  a strop, and a new `gaffStarboardBlock`, shackled to the gaff's starboard side.
  The gaff offset is perpendicular to the spar *in plan*, not along −x — the gaff
  is swung 26°, and taking −x would slide the block along the spar as well as off
  it, which is how two of the earlier attempts ended up with fittings that held
  onto nothing.

That is also just what the rig already says everywhere else: **the falls belay to
starboard, the weather side, because everything is sheeted to port.** The topsail
bellies to leeward and the halyard runs down its weather face.

| | before | after |
|---|---|---|
| gap at the throat | 2.35 m | **0.30 m** |
| gap at the peak | 0.03 m | 0.03 m |
| topsail area | 11.54 m² | **15.46 m²** (27% of the mainsail) |
| peak halyard to cloth | 0.44 m under the foot | **0.113 m** clear, 9× its radius |

Ash pre-authorised relaxing the rope-versus-sail constraint for this sail. It was
not needed — the geometry cleared on its own, so there is no exemption and the
check still means what it says.

Two tests now hold it: the halyard clearance, plus an assertion that **both** ends
are off the centreline, because restoring either one puts the rope back in the
cloth; and a new one that the topsail's foot lies along the gaff, bounded at
0.40 m, which is the shape Ash was actually looking at and which nothing held
before.

---

## 12. M3 closed — what M4 inherits

M3 is done and merged to master. 580 tests.

### The contract M4 has to extend, and where it breaks

`deckSurface.ts` answers **one** height for any (x, z). `deckObstacles.ts`
composes the walker's floor as `deck ∪ fitting tops` — `schoonerStandAt` — and
that union is the *cheap* half of relaxing the one-height rule: a panel is
**higher** than the deck, so "the highest surface that admits the query wins"
answers it, which is the rule `deckStandAt` already used across the three levels.

**A cabin sole is lower than the deck above it, and that rule cannot answer it.**
M4 needs a floor *and* a ceiling, and a query that knows which of the two the
body is under. That is the round's real structural work, more than the cabin's
furniture is.

Note the dependency shape before moving anything: a fitting must ask the deck how
high it is before it can say how high its own lid is, so `deckFittings.ts` imports
`deckSurface.ts`, and the union lives in `deckObstacles.ts` because that module
already imports both. A deck surface that also knew about fittings would close
the ring. An interior will have the same shape.

### The structural guards, and what each one enumerates

Every one of these was written *after* a fault got past the previous set, and
each covers a category the last one could not see. If M4 adds a new kind of
object, expect to add the guard with it.

| guard | enumerates | fails when |
|---|---|---|
| `OBSTACLE_SOURCES` | every geometry list in `rig.ts` | a new list is neither collidable nor explicitly not, with a reason |
| `FITTING_KINDS` | every kind in `deckFittings.ts` | a fitting kind is unclassified, or classified and unused |
| mesh-against-surface | the drawn deck's vertices | the loft and `deckStandAt` disagree |
| draws-no-triangle-outside | the fitting meshes | the loft invents geometry the data does not describe |
| winding agreement | every rig and fitting triangle | a normal disagrees with its winding |
| closure | every fitting solid | an edge is used an odd number of times — an open end |
| rope endpoints | every running rope's two ends | a rope ends on nothing |
| block reach | every block and masthead eye | a block drifts out of a strop's reach of its spar |

**The doctrine behind them, in one line:** an intersection suite keyed to one
list stops covering the ship the moment geometry lands in a different list. Three
separate fixes drew fittings at one named list each and stopped; the fault only
died when a test enumerated *ropes* instead of *fittings*.

### The findings worth carrying forward

- **Measure the case that matters, not the case that is drawn.** The boom's
  headroom was measured where she is sheeted, not where a helmsman stands; the
  fore boom's clearance was measured at 30° out, not amidships where it binds;
  the topsail's halyard offset was measured at one end of a chord. All three
  read as "fine" and none of them were.
- **A clearance rule must be measured at the height the thing actually is.** The
  tiller solve used the deck's edge while the tiller sweeps 0.3–0.95 m up, where
  the bulwark has tumbled 0.10 m inboard.
- **An open-ended tube reads as transparency, not as a hole**, because front-face
  culling discards the far wall's inside. It hid on every spar since M2.
- **A quantity that depends on local ordering must be measured.** Cap winding
  came out inverted on all 488 discs from an argument that sounded right — the
  third time on this ship.
- **Where a thing is is not the station it belongs to**, abaft the counter's
  shear. Seven instances now. `counterStationZ` is the one inversion.
- **An exclusion in a test is where the next fault will live**, and **an old test
  can justify the number written beside it and be wrong about why** — the ladder
  gap test asserted a bound about a fife rail that was never in the flight.

### Known, recorded, not fixed

- Three rope-versus-spar fouls at the mastheads: 9, 13 and 25 mm, in
  `ship-rig.test.ts` with their depths.
- The fore boom leaves **1.54 m** over the cargo hatch's grating with the boom
  amidships — a duck, and you can step off a hatch. Held at 1.25 m.
- The pump's brake reads as a bent pole from some angles; the mast partners can
  read as dark lumps in the mast's own shadow.
- ~~**She has no wind indicator of any kind**~~ — **CLOSED 2026-08-06**, see
  `docs/ship/SHIP_WIND_CUES_HANDOVER.md`. She wears an ensign, a masthead pennant and a
  dogvane, fixed in shape and live in orientation from the instantaneous
  apparent wind. Telltales were considered and left out: a few centimetres of
  wool at this scale reads as render noise rather than as information.
- The suite times out under a *loaded* parallel run — different heavy
  physics-integration files each time, never an assertion. `--no-file-parallelism`
  is clean. `ship-hydrostatics` and `ship-horizontal-dynamics` carry explicit
  timeouts for the same reason.
