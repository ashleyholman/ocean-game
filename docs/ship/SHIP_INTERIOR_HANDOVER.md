# M4, below decks — the structural slice, and what it found

Ash asked for M4 in the shape M3 recommended: **structure first, stop for his
eye.** The two-storey surface contract, the companionway, and the cabin as a
bare lit volume — not the furniture. This is what landed and what it turned up.

Branch `claude/shipbuilding-m4-a32572`, worktree, dev server **`drift-cabin`**
on fixed port **5217**.

---

## 1. What landed

- **`deckInterior.ts`** — a new module owning everything below decks: the cabin
  sole's plan, the deckhead, the companion ladder, and the coaming.
- **The one-height rule is gone.** `schoonerStandAt(x, z, reachY)` picks the
  highest floor at or below the asking body's reach, and returns a `ceilingY`
  with it.
- **The companionway** — a 1.7 m × 0.84 m opening in the quarterdeck, coamed on
  three sides, with a seven-riser flight down to the sole.
- **The cabin, drawn** — sole, deckhead and beams, both bulkheads, the ship's
  sides, the ladder, and the lining of the cut through the deck.
- **Interior lighting, first pass** — a `skyVisibility` term on the world PBR
  material, and daylight down the companionway as a real spot.
- **`ship-interior.test.ts`** — 26 tests. Suite is green.

She walks bow to stern, down the ladder, across the cabin, and back up.

---

## 2. The blocker M3 named, and how it was relaxed

`deckSurface.ts` answers one height per (x, z). M3 could live with that because
every surface it added stood *on* the deck — a hatch lid, a grating, a tread —
so "the highest surface that admits the query wins" was right. A cabin sole is
**lower** than the deck above it and that rule puts a body standing in the cabin
on the quarterdeck, through two metres of timber.

The relaxation is the smallest one that is still true:

```
standAt(x, z, reachY)   // reachY = the body's feet + whatever it can step up
```

and the floor is the highest candidate at or below that, falling back to the
*lowest* when the body is under all of them — a body below every floor is
falling, and it must be falling toward something.

Three things about the shape of it are worth keeping:

- **The height is not optional.** A defaulted `reachY` would quietly hand back
  M3's single-storey answer at every call site that had not been thought about.
- **The ship is told the reach, not the rule.** Step-up stays in `WalkerTuning`,
  so a second kind of body needs nothing in the vessel.
- **`ceilingY` is not optional either, and open sky is `Infinity`.** A consumer
  that has to ask "is this one of the open ones" is a consumer that will forget
  to. `Infinity` composes: `ceilingY - y >= anything` is true outdoors with no
  branch anywhere downstream.

The dependency shape M3 warned about held: `deckInterior` imports `deckSurface`,
and the union lives in `deckObstacles`, which already imported both.

---

## 3. The faults this round found

### 3.1 The cabin's headroom was measured against a deck that is not drawn

`hullForm.cabinHeadroomAt` built the deck's camber from `deckCrownY`, which spans
`maxHalfBeamAt` — the hull's widest half-breadth, down at the turn of the bilge.
The deck is not lofted over that. `deckSurface.ts` lofts it over `deckHalfWidth`,
the inboard face of the bulwark up at the walking surface. At the cabin those are
1.95 m and 1.69 m of half-beam.

So the reported headroom ran **9–16 mm above the height a head actually meets**,
all the way along the cabin. That matters because the number it protects is a
bound: `SHIP_SPEC.md` §6 sets 1.85 m of clear standing height on the centreline,
`ship-hydrostatics.test.ts` asserted it, and **the true figure at the forward
bulkhead is 1.841 m**. The guard passed because it was measuring the wrong
surface.

|                        | claimed | drawn  |
|------------------------|---------|--------|
| forward bulkhead −3.40 | 1.8518  | 1.8414 |
| mid cabin −5.00        | 1.9176  | 1.9077 |
| after bulkhead −6.60    | 2.0274  | 2.0113 |

**Neither this nor the sole-area function was a slip in the arithmetic. Both
were in the wrong module.** A question about the room under the quarterdeck has
to be asked of the quarterdeck as it is drawn, and `hullForm.ts` cannot import
the file that draws it — `deckSurface.ts` imports *it*. Written there, the only
way to answer at all was to build a second expression for the same surface.
Moving them across the dependency made the right answer the available one.

**The 9 mm is recorded, not bought back.** Buying it back means lowering the sole
or raising the quarterdeck's rise, and both are hull decisions with hydrostatic
tails — `CABIN_SOLE_Y` carries cabin weights in `massModel.ts`. **Ash's call.**

The sole area moved with it: 11.34 m² was the shell's answer, **9.37 m² is the
room's**, because the deck overhead is 0.13–0.26 m narrower each side than the
hull is at sole level. Still inside the spec's band.

### 3.2 A descending body's head is above the deck for the whole ladder

The flight first ran the full length of the opening, its foot hard against the
after coaming. **The walker got stuck on the third tread down**, grounded, with
nothing reporting a fault.

The reason is a geometry the deck round never had to think about: a body is
1.75 m and the coaming rises 0.50 m from the deck, so the coaming is a solid
inside the body's own height band for the entire descent bar the last step — and
a solid is something the walker keeps a body's radius away from. Foot against the
coaming, the lowest treads were inside that radius and could not be reached.

`COMPANION_LANDING_DEPTH` is the fix: the flight stops a body's radius short and
you step *down* off it onto open sole, by which point your head is below the deck
and the coaming has left your band. **This is M3's "a clearance rule must be
measured at the height the thing actually is", in a place nobody had looked**: a
coaming reads as a kerb, something you are beside; for the two seconds you are on
the ladder it is a thing at your ear.

The coaming's 0.50 m is set by the same argument from the other end. The usual
0.30 m is *inside* the walker's 0.40 m step-over, so it would have been a kerb
you stride across into a two-metre hole.

### 3.3 Two light leaks, and what actually found them

Both were at the junction of the ship's side and the deckhead, and both were a
hard blue line the length of the cabin on screen.

1. **60 mm.** The deckhead was lofted to the *sole's* half-width while the wall
   ran out to the *deck's*, leaving a slot round the whole room with no
   under-surface over it. A deck lofted as a one-sided surface is invisible from
   below, so what came through the slot was the sky. **M2's finding again: an
   open-ended surface reads as transparency, not as a hole.** Fixed by
   `cabinRoofHalfWidthAt` — one expression for one edge.
2. **9 mm.** The strips of deckhead beside the opening were lofted from their two
   endpoints alone, so their outboard edge was a straight **chord** under a deck
   that curves, while the wall followed the loft's own stations. The two surfaces
   agreed exactly where they were measured and parted between them. This is the
   doctrine `hullLongitudinalSamples` already states in `shipGeometry.ts` — one
   station lattice, subsets shared — and not following it cost a leak.

**The instrument that found both was the render, not a test.** The method worth
keeping: screenshot, then raycast through the offending pixel and ask the scene
what is behind it. `mcp__Claude_Browser__javascript_tool` with `THREE.Raycaster`
off `window.__drift` does it in one call.

### 3.4 The sea was drawn inside the cabin — **FIXED, stencil mask**

Looking down the open companionway you see **blue water on the cabin sole.**

It is not a hole. It is the ocean mesh, confirmed by raycast: the first hit is
`ocean.mesh` at ship-local y ≈ 2.57–2.63, **inside the room**, 0.12–0.18 m above
the sole.

`CABIN_SOLE_Y` is 2.45 and the design waterline is 2.30, so the sole has 0.15 m
of margin — and a wave crest is far more than that. The ocean is one unbounded
surface with no notion of being inside a hull, which is the same architectural
gap the M1 round recorded as *"the sea does not acknowledge solid bodies at
all"*, now seen from the other side of the planking.

It could not be fixed by moving the sole. 2.45 is set by what is under it —
ballast on the floors at 0.62, stores to about 2.0 — and it is already only
0.15 m above the DWL. The hold's floor has to go *lower*, around 2.0, which is
permanently below the waterline, so whatever went in had to serve the whole
interior rather than this one room.

**What landed: `scene/interiorStencil.ts`.** The interior draws after the rest of
her and marks a stencil where it survives the depth test; the ocean refuses to
draw over the mark.

```
ship exterior, rig, fittings   renderOrder -2
the interior, marking stencil  renderOrder -1
the ocean, rejected on the mark renderOrder  0
```

**The depth test does the work that would otherwise need a volume.** An interior
surface only marks the stencil if it is *actually the nearest thing at that
pixel*, because the exterior has already written depth. From outside, the shell
covers the cabin, the interior fails depth, nothing is marked, and the sea draws
exactly as it always did. Down the open companionway the sole is nearest, the
mark lands, and the sea is kept out. No second geometry pass and no interior
volume to build and keep in step with the loft.

**Why not a cutout in the ocean's shader.** `discard` is a *static* property of a
shader: the driver sees it in the source and marks the pipeline "may discard", so
visibility can no longer be resolved before shading. On the tile-based deferred
GPUs this runs on that defeats hidden-surface removal for the entire draw,
whether or not any fragment ever discards — paying across the whole screen, on
the frame's most expensive shader, to save a patch of pixels the opaque hull was
already hiding for free. A stencil test is fixed-function, does not depend on
shader output, and so can always run *before* shading. It rejects the same
fragments and keeps HSR intact.

`stencil: true` had to go on the renderer; it was explicitly off.

**The one artefact, and it is inherent to the technique.** A stencil is a
screen-space test with no depth of its own, so it also rejects ocean that is
legitimately *in front of* a marked pixel. Concretely: a wave crest between the
camera and the open companionway would be punched through, showing the cabin
sole. The hatch is 2.2 m above the waterline and 0.84 m wide, so it needs a big
sea and an external camera looking at the quarterdeck past a crest. No
screen-space mask can be depth-correct; this is the price, and it is worth
knowing before it gets diagnosed as something else.

**Not measured, and there is an experiment owed.** The claim that this is cheaper
than a shader cutout is from the architecture, not from a benchmark. The
alternative — testing each ocean fragment's own world position against the hull's
interior volume — is **depth-correct and has no artefact at all**, which the
stencil cannot be. Whether it is worth its cost is an open question with a plan
attached: **`docs/ocean/OCEAN_INTERIOR_CUTOUT_HANDOVER.md`**.

---

## 4. The lighting, and what it does not do yet

Everything in this game assumed you were outdoors. **The world probe is a single
spherical harmonic sampled from the open sky and every surface receives all of
it** — so the cabin came out lit exactly as brightly as the quarterdeck two
metres over it.

`WorldPbrParameters.skyVisibility` is the missing term: a scalar on the SH
irradiance, 1 everywhere else, `INTERIOR_SKY_VISIBILITY = 0.14` below decks. It
is deliberately **not** the intensity knob `Schooner.ts` forbids — that note said
"if she needs an exception now, the exception is a bug in the world lighting",
and enclosure being absent from the model is exactly that.

Daylight down the companionway is a real spot light, driven by the same ambient
radiance the probe carries, so it reddens at sunset and dies at dark without
knowing what time it is. When the lantern becomes the room's light, this going
out is what hands over.

**A/B it live** — same frame, no reload, which matters because a lighting verdict
is only valid under the transform it was taken through:

```js
window.__drift.vessel.group.traverse(o => { if (o.isMesh && o.material.userData?.skyVisibility) o.material.userData.skyVisibility.value = 1; });
```

### What is still wrong, measured

- **One side of the cabin is much brighter than the other.** Checked properly:
  it is not the sun (identical with the sun's intensity zeroed) and not the
  env map (identical at `envMapIntensity` 0.14). It is **the sky SH's own
  directionality surviving the scale** — the two walls have opposite normals, so
  one samples the sunward hemisphere and the other the far side, and 0.14 scales
  the level without touching the ratio. Physically an enclosed room should not
  be receiving a scaled copy of the open sky's distribution at all.
- **`skyVisibility` is a constant where the real quantity varies over the
  surface.** The sole under an open hatch sees a lot of sky; the corner behind
  the ladder sees none. Baked per-vertex sky visibility is the honest form. What
  stands in for the gradient meanwhile is the companionway's own light.
- **0.14 is a first number and wants Ash's eye.** Too high and the room is the
  quarterdeck with a lower ceiling; too low and it is a black box with a bright
  hole in it. §9 asks for the interior to be *warmer and lighter than the dark
  exterior* and calls that contrast the point of the room.

---

## 5. What the tests can and cannot do

`ship-interior.test.ts` has two ray-based seal guards, and **their limits were
measured rather than assumed** — by putting each fault back and re-running:

| fault | caught |
|---|---|
| deckhead lofted to the sole's width (60 mm) | yes |
| deckhead edge as a chord (9 mm) | **no** |

A 9 mm slot a metre away subtends half a degree; the finest fan in these tests is
1.15° apart. What the renderer does with 1280 columns of pixels, a few thousand
rays do not. The guards catch a room that is *gross-open* — a panel missed, an
edge lofted to the wrong width, a builder that stopped early — which is the
failure that survives a casual look, and they are worth having for that and not
for more. The comment in the file says so; do not let it drift into claiming
otherwise.

There is also a guard on the guard (`is firing at real geometry`), because every
number in a ray test is a filter and a filter that is slightly wrong gives a test
that fires at nothing and passes forever.

`INTERIOR_SOURCES` is the enumerating guard for below-decks geometry, in the
pattern `OBSTACLE_SOURCES` and `FITTING_KINDS` already hold: adding a kind of
object fails a test until someone has decided whether a person can walk into it.

**One silent-clipping fault fixed while passing:** `INDEX_Y_LO` in
`deckObstacles.ts` was a literal 3.0, chosen when the deck was the lowest floor
aboard. The sole is at 2.45. It is derived from `CABIN_SOLE_Y` now — a literal
would have gone on discarding cabin furniture from the *index* while
`DECK_OBSTACLES` still listed it, so nothing would have looked wrong anywhere.

---

## 6. The numbers, and who chose them

| | value | set by |
|---|---|---|
| `COMPANION_AFT_Z` | −5.40 | the tiller sweeps the centreline to −5.82 at any helm |
| `COMPANION_FORWARD_Z` | −3.70 | the cabin's forward bulkhead is −3.40; the flight's head needs sole under it |
| `COMPANION_HALF_BREADTH` | 0.42 | 0.26 m body radius plus clearance both sides |
| `COMPANION_LANDING_DEPTH` | 0.45 | §3.2 — a body radius, plus margin |
| `COMPANION_RISERS` | 7 | 2.03 m drop / 0.32 m step-up = 6.4, so 7; six would be climbable one way only |
| `COMPANION_COAMING_HEIGHT` | 0.50 | above the walker's 0.40 m step-over |
| `CABIN_LINING_THICKNESS` | 0.06 | frame, spirketting and ceiling planking |
| `INTERIOR_SKY_VISIBILITY` | 0.14 | **first pass, unjudged** |

The ladder's **head is forward and it descends aft**, so its foot lands in the
middle of the sole with the stern ahead rather than against the forward bulkhead.
The coaming is therefore open forward, and that is the one thing here a seaman
would argue with — a companion facing forward scoops anything that comes aboard.
A hood closes it, and a hood is furnishing. **Reversing it is two constants** in
`deckInterior.ts`; the flight, the coaming, the loft and the light all read them.

---

## 7. What M5 / the furnishing slice inherits

> **Superseded in part.** The floor plan the furnishing slice should be built
> against was agreed on 2026-08-10 and is written up in
> **`docs/ship/SHIP_BELOW_DECKS_PLAN.md`**, with a scale drawing. It answers the
> two open questions below — the cabin runs aft to the transom, and the §10
> spaces are specified — and adds a platform deck over the hold that turns the
> middle of the ship into a room. Read it before this section's open list.

**Not built, and deliberately:** every furnishing in `SHIP_SPEC.md` §9 — the box
berth, the chart desk and drawers, the stern bench, the sea chest, the washstand,
the gimballed lantern, the shelving and the personal objects.

**Open questions worth Ash's answer before the furnishing slice:**

- ~~The sea through the sole (§3.4)~~ — **CLOSED**, stencil mask.
- **The cabin stops 1.2 m short of the transom.** `CABIN_AFT_Z` is −6.6 and the
  hull carries usable width at sole level right aft to −7.80 (half-breadth 1.27
  at the transom, floor at 2.28 — below the sole). The rudder stock comes up at
  −7.75, which is the honest reason for a lazarette abaft the cabin. **But §9
  asks for stern windows and "water audible beyond the stern", and the transom is
  where stern windows go.** Either the cabin runs aft to about −7.4 and the
  windows are real, or they become quarter windows in the topsides and the
  after 1.2 m is steering gear. This changes the room.
- **`INTERIOR_SKY_VISIBILITY` and the one-bright-wall problem** (§4).
- **The 9 mm of headroom** (§3.1).

**Other spaces** — mate's berth, crew accommodation, galley, hold — are not
started. `SHIP_SPEC.md` §10 wants them as believable volume at low detail, and
the hold's shallow area under the cargo hatch is the one a player sees. The
walker's `crouchHeight` and the eye-ducking in `eyeY()` were built for those and
**never fire in the cabin**, which clears 1.84–2.01 m against a 1.75 m body.
They are untested against a space that is actually low.

---

## 8. Tools

- Dev server **`drift-cabin`**, port **5217**.
- **TOOLS → Deck & walking** has four new stations: **Companion** (on deck at the
  head of the flight), **Cabin**, **Ladder foot**, alongside Helm. The panel's
  readout now carries a `headroom` line — clear height and the deckhead's own
  height, or `open sky`.
- Driving the walk from the Browser pane still does not work (rAF stops between
  tool calls). Place with the station buttons, then set
  `cameras.embodied.lookYaw` / `lookPitch` and snap
  `cameras.transition.elapsed = cameras.transition.duration` so the dolly does
  not eat the screenshot.

---

# 9. M4's furnishing slice — the arrangement, built

Ash asked to continue against the agreed layout, and this is what landed on
2026-08-10. `docs/ship/SHIP_BELOW_DECKS_PLAN.md` is the plan and now also the
record of what the build changed in it; this section is what the code does and
what it cost. **825 tests green.** Dev server **`drift-cabin`**, port **5221**.

## 9.1 What landed

- **Four rooms on three floors, joined bow to stern.** Captain's cabin at 2.45
  running aft to the transom, the pantry-and-ladder landing at 2.45, the wardroom
  on a new platform deck at 1.80, the forecastle at 2.05, and a closed peak
  bulkhead with the sail room behind it. **49.32 m² of walkable floor against the
  9.37 m² M4 built**, and the areas match the plan's published figures to a
  decimetre because the plan's drawing tool and the ship read one width function.
- **`deckInterior.ts` is a table now.** `BELOW_DECKS_SPACES`, `BULKHEADS`,
  `INTERIOR_STEPS`, and width/headroom expressions that take a floor height
  instead of closing over `CABIN_SOLE_Y`. The cabin's own functions are kept as
  the specialisations they became, because the hydrostatics test measures that
  room by name.
- **Doorways, and steps through them.** Two treads at 0.217 m down at the −2.4
  bulkhead; one 0.25 m riser at +2.6, which is under the walker's step-up and so
  is drawn as the bulkhead's own sill rather than as a stair.
- **The hatchway is a shaft, deck to hold.** The weather deck is now genuinely
  cut at the cargo hatch — it was solid planking under the grating — and the
  platform's opening takes the same footprint directly under it, boarded flush
  and walked on. The cargo hatch's *plan* moved to `hullForm.ts` so the two
  openings cannot be typed twice.
- **The companion ladder is a ship's ladder.** 1.15 m opening at −4.15 → −3.0,
  seven risers at 0.287 m, tread 0.117 m, **71°** — in from the 54° Ash called a
  domestic stair. It lands in the landing with the cabin door 0.6 m aft of the
  foot, not in the middle of the room section 9 calls private.
- **Four stern windows in two pairs either side of a boxed rudder trunk**, with
  0.29 m reveals through the plumb lining to the raked transom. The exterior
  carried three, one of them on the centreline, looking at the back of a timber
  casing that did not exist yet.
- **The mass model's three known faults, closed.** Fresh water 9000 → 4800 kg
  (ballast 28.0 → 31.4 t, KG 1.936 → **1.887**, GM **0.660**); `belowDecks()`
  takes the floor instead of baking one; the bilge pump weighed where it is
  drawn; and the platform deck's own 0.86 t at y 1.71, which the ballast solve
  had never seen.

## 9.2 The faults this slice found

### The bulkheads were lofted to the room's width at the sole

A bulkhead drawn as a rectangle to the room's half-width *at the floor* is 0.1 m
short of the side lining at head height, because the hull opens outward as it
rises. **It is M4's 60 mm slot in its third place**, and it was found the same
way: a raycast sweep across the render, where two neighbouring columns hit the
lining and the ones between hit sky at 500 m. Lofted up the section now, with the
top row at the deck edge, so the bulkhead and the side lining are one x at every
row by construction.

### The passage cannot run down the centreline, because both masts do

`DOORWAY_OFFSET`. **Found by walking her, not by reading the plan**: she crossed
the wardroom, was pushed round the mainmast, and ended wedged between it and the
after bulkhead with no way aft. The mainmast is 0.5 m from that bulkhead and a
body needs 0.73 m to pass between them. The doors go 0.75 m to starboard aft and
to port forward, and `tests/ship-interior.test.ts` walks the whole dog-leg from
the forecastle to the transom.

### `INDEX_Y_LO` moved for the second time

It was a literal 3.0 when the deck was the lowest floor, then `CABIN_SOLE_Y −
0.2` when the cabin sole was. The platform is at 1.80. It is asked of the list of
rooms now. Both moves are the same fault caught before it bit: the clip discards
from the *index* while `DECK_OBSTACLES` still lists the object, so the wardroom's
bulkheads would have been drawn, classified collidable, covered by every
enumerating test, and walked straight through.

### The ocean cutout's conservative erosion has a boundary problem

Full write-up in `docs/ocean/OCEAN_INTERIOR_CUTOUT_HANDOVER.md` section 4. In
short: a per-cell minimum read with a nearest lookup is eroded 0.16 m narrower
than the room wherever a sole sits close to the turn of the hull, which put two
strips of open sea in the cabin's after corners. The field now carries a second
term that knows what it is for. The price is measured and pinned by a test.

### Two bands that had to move, and were not taste

`ship-hydrostatics.test.ts` held ballast under 38% of displacement; the agreed
water cut takes it to **38.45%**, which the plan predicted and Ash approved with
it. Raised to 42% with the figure pinned exactly. And `evidence/ship-sailing/helm-baseline.json`
was re-exported: the full-sail beam balance moved 4.2029° → 4.1871° because KG
moved. Both are consequences of a decision, not drift, and both say so where they
are written.

## 9.3 The 9 mm came back on its own

M4 recorded the cabin's clear height as **1.841 m at the forward bulkhead**
against spec section 6's 1.85, and left the 9 mm unbought because buying it meant
a hull change. Moving the forward bulkhead from −3.4 to −4.3 to make room for the
ladder's landing moved the room's tightest point aft, into where the sheer has
risen: the minimum is **1.874 m** and clears the spec outright. Nothing about the
hull changed. The room stopped being in the low place.

## 9.4 What is still open

The plan's section 7 is the live list. The three that matter most:

1. **Interior lighting, before any furniture is judged.** Unchanged from M4 and
   now four times the problem: `INTERIOR_SKY_VISIBILITY = 0.14` is a constant
   where the real quantity varies over the surface, and it scales the open sky's
   *directionality*, so one wall is brighter than the other for no physical
   reason. The wardroom and forecastle have no daylight of their own but the
   cargo hatch.
2. ~~**The crew have no way on deck.**~~ **BUILT — see section 18.** There is no
   clear 1.15 m on the *centreline* forward, which is what this said and what
   was true; offset to starboard it fits, and the patch it went into turned out
   to be the largest clear deck forward of the mainmast.
3. **The forecastle is 1.728 m at the sides against a 1.75 m body**, so the
   walker's duck fires for the first time. It has never been looked at.

---

# 10. Ash walked her, and found nine things

Ash went below on 2026-08-11 and reported what he saw, room by room. **Every one
of the nine was a real fault**, three of them shared a single cause, and one —
the companion ladder — was a hard blocker that the suite had been reporting as
fine for the whole of the furnishing slice.

The whole of this section is merged to master. **825 → 888 tests**, all green,
and the suite's wall-clock dropped from 86 s to 40 s on the way (§10.8).

Dev server **`drift-cabin-feedback`**, port **5225**.

## 10.1 The blocker: you could get up the ladder and not off it

> *"I smash straight into that horse peg thing and can barely move. I'm almost
> trapped at the top of the stairs… Completely broken."*

Mapped, not guessed. A body arriving at the head of the flight stood in a free
island **0.30 m by 0.20 m**, sealed on every side: the coamings outboard, the
hatch behind, and 0.48 m ahead of it the **main fife rail**. The only way out was
back down.

The rail sat at z = −2.52, from `partnerZ − 0.62` in `rig.ts`. The mainmast is at
−1.90 and the quarterdeck break at −2.40 — so the rail was 0.62 m abaft its own
mast and therefore *on the deck above it*, 1.2 m away and up a 0.55 m step from
the spar it serves. Nothing looked wrong, because a pin rail is a plausible
object on any deck. What it did was cork the companionway, which M4's furnishing
slice had moved forward to −3.00 without checking what was already standing on
the deck it now surfaced into.

**The rule is written against the deck now, not against a number.** A rail stands
abaft its mast *and on the mast's own level* — and where the level ends first it
comes forward instead. For the main that is 0.30 m forward, in the open waist
with the pump: the working cluster round the mainmast that
`SHIP_BELOW_DECKS_PLAN.md` §4.3 already describes from below. **The fore rail
does not move**; its mast and its 0.62 m are both on the waist deck.

**The first attempt at this fix was wrong and the suite caught it in a minute.**
Abaft the mast on the waist deck is not available either: the quarterdeck ladders
run the full width from x = 0.40 outboard between z −2.40 and −1.84, and the mast
stands in the 0.80 m channel between them. A 0.90 m board anywhere in that band
lands on the flights and closes the way *up*. `railAfterLimit` states that — a
flight of steps is not deck you can put a fitting on, even though `deckStandAt`
will happily report a height there.

## 10.2 Why no test had an opinion

`ship-deck.test.ts` floods the weather deck through `DeckWalker.attemptMove`, and
it had been reporting the quarterdeck reachable the whole time. Two reasons, both
worth keeping:

- **`attemptMove` pushes a body *out* of what it overlaps** — three passes, several
  columns at a time. That is the right routine for playing and the wrong one for
  proving a route exists: a grid probe gets squirted through gaps a player leaning
  on a key never finds.
- **A flood keyed only by cell cannot climb.** The sole runs underneath the whole
  companion flight, so a fill that spreads along it marks every tread's station at
  2.45 m and can then never climb the ladder it is standing under. The shipped
  fill has this shape and gets away with it only because the weather deck is
  single-storey.

`the way out of her` in `ship-interior.test.ts` is the guard: same floor query,
same columns, same footprint rule, **no push-out**, and keyed by (cell, height).
It is a lower bound on where a player can get, which is the direction a guard
should err in. Verified by putting the rail back — it fires.

## 10.3 One cause behind three complaints: the rooms asked the wrong module

> *"the door to the middle room is actually taller than the roof height… the door
> frame protrudes up over the deck."*

`spaceDeckheadY` asked `deckStandAt`, which answers **"what can a body stand on
here"** — and so must include things that stand *on* the deck. Today that is a
stair tread; tomorrow a hatch lid. Under the two quarterdeck ladders the
wardroom's *ceiling* was therefore the top of a staircase:

```
wardroom clear height    x=0.00   x=-0.75   x=-1.25
  at the aft bulkhead     1.925     2.277     2.256    <- 0.35 m that is not there
```

That bought a doorway head drawn 0.27 m proud of the weather deck, and — because
a deck lofted one-sided is invisible from below — a clear line of sight from the
landing to the sky through a doorway. Raycast from where Ash stood: first hit
`rig:sailcloth` at 6.1 m, then the sky at 500 m.

**It is `hullForm.cabinHeadroomAt` again**, which M4 recorded in the same words: a
question about the room asked of a module that cannot answer it, so the only
available answer was the wrong one. `deckSurface.deckOverheadAt` is the right
answer made available — the lofted planking, no stairs, nothing standing on it.
The fix both times was to add the expression, not to correct the arithmetic.

## 10.4 The daylight over the walls was two faults wearing one symptom

> *"the walls where the door is don't get fully sealed with the ceiling."*

**The 0.59 m one.** Every bulkhead was drawn to `bulkhead.roof` — deliberately
the *lower* of its two ceilings, which is right for the doorway and wrong for the
timber. The wardroom bulkhead stands under the quarterdeck break, so it stopped
0.59 m short of the landing's own deckhead across the full width of the ship.
`bulkheadRoofOn` gives each face its own side's room; the collider takes the
higher of the two.

**The 53–86 mm one.** `sidePanel` computed its top height *once*, at the deck
edge, and reused it for every column — a level line under a deck that crowns to
the centreline. All four bulkheads, widest exactly where someone standing in the
doorway is looking.

**Finding the first is how you stop looking for the second.** Both are fixed; the
lintel's top follows the camber too, which matters at the wardroom's door because
it is 0.75 m off the centreline and the camber falls 22 mm across the opening.

## 10.5 The lintel was a wall, and a lintel is a ceiling

Ash accepted the 1.263 m landing-to-wardroom door on the understanding that it is
what the arrangement honestly gives — the sill is the landing's 2.45 floor and
the waist deck's beams are at 3.725. **Drawn as a solid from the head upward it is
a wall with an unusable gap under it**, and the bow-to-stern walk stopped dead in
the doorway the moment the deckheads started telling the truth.

`doorwayHeadOver` states it as a ceiling instead, and the walker's own rules do
the rest with no new concept: `crouchHeight` lets a body through anything over
1.15 m, `eyeY` ducks the head under it, and a doorway genuinely too low is
refused — which is correct behaviour, not a bug.

The eye drops abruptly rather than over the approach, because the band is the
bulkhead's own thickness. The duck is unexamined work in any case (§10.9).

## 10.6 The beams, and the pegs

**Jagged beams.** Each was eight axis-aligned boxes with its top set to the deck
height at its own midpoint — a curve drawn as an 8-step staircase. The reasoning
was right and the remedy was a staircase.

Worth knowing: **the camber itself was never wrong.** The deck crowns 65 mm over a
3.25 m beam, which is ¼ inch to the foot — the traditional round of beam almost
exactly. A period beam is sawn or grown to that arc, sided ~4–5 in and moulded
~5 in, landing on a clamp at the ship's side. `addDeckBeam` sweeps a rectangular
section along the deck's own underside at constant moulded depth, which is that.
The top face is not drawn: it is flush against planking that is already a
surface, and two coincident faces are a z-fight rather than a beam.

**The two pegs through the roof** were the fife rails' stanchions, drawn from
`fife.y − halfSpan*0.1 − 1.02` — a length chosen to be comfortably longer than the
0.94 m rail height so the foot would certainly reach the planking. It reached
0.15 m past it. Free while the deck was the bottom of the world; a pair of pegs
hanging in the air the moment there were rooms under it. Both rails did it, the
main into the landing and the fore into the forecastle. The foot comes from
`deckStandAt` at the stanchion's own (x, z) now, and `FIFE_HEIGHT_ABOVE_DECK` is
exported for the same reason `HORSE_SAG` was.

## 10.7 The stern windows, and the wall that had to move with them

> *"even raising them a bit is still a problem. have we got something
> fundamentally wrong with our ship?"*

**No. The ship is right and the window was in the wrong place.** Measured:

| | |
|---|---|
| freeboard | 1.53 m amidships, 1.84–1.95 at the ends |
| cabin sole | 0.15 m **above** the DWL |
| platform sole | 0.50 m **below** it |
| heave in the production sea | 1.13 m range in Hs 1.16 m |
| pitch | ±5.5° against a 3.4° wave slope |

A lower deck sitting at about the waterline is period-normal — *Beagle*'s did —
and heave RAO ≈ 1 is *correct* for a 15.5 m hull on a 62 m swell. She rides it
because she should. The old sills were at bench height in a room whose floor is
at sea level, which is 0.83 m above the water, and their *heads* at 3.57 were
half a metre **below** a standing eye at 4.07. A man in that cabin had to stoop
to look at the sea, and every screenshot through them was solid water.

**The margin Ash saw was real and worse than the physics says.** Over 110 s of the
production sea the old sills came within **0.21 m** of the water — and the drawn
surface carries a further **0.157 m** of detail the buoyancy sampler never sees,
so what he watched came within about **0.05 m**.

Everything about the lights is derived now:

| | was | is | set by |
|---|---|---|---|
| sill | 3.13 | **3.693** | 1.25 m above the DWL |
| head | 3.57 | **4.243** | the deckhead less a beam and its lining |
| size | 0.34 × 0.44 | **0.302 × 0.550** | what is left between trunk and side |
| piers | 0.10 / 0.50, leftover | **0.110 throughout** | structural, shared equally |
| reveal | 0.29 | **0.04** | the lining's own thickness |

Clearance above the water: **min 0.21 → 0.87 m**, median 0.77 → 1.39.

**THE AFTER WALL RAKES NOW, AND THAT WAS NOT OPTIONAL.** The reveal from a plumb
lining to the glass grows 0.325 m for every metre of height, so there is no
window height above about 3.1 with a sane reveal while the wall is plumb:
**raising the lights *is* raking the wall.** A plumb bulkhead with a wedge of
dead counter behind it is right down at the tuck, where the counter actually is;
carried to the deckhead it was 0.67 m of the room given away. The cabin's after
end is the counter itself now — lined, with the ceiling carried aft over the
wedge and its two sides closed.

**The sole is untouched at 9.294 m²**, so the mass model, the hydrostatics and the
plan's published areas all stand. Only the wall above the floor moved.

The glass is raked with it. It was a flat quad at one z, near enough at 0.44 m
tall; at 0.55 m on an 18° rake sill and head are 0.18 m apart fore-and-aft and a
flat pane stands half proud of the planking and half sunk in.

**Deadlights are the period answer to the fear Ash actually had** — shutters
shipped over the glass in heavy weather, against being pooped. They are
furnishing and they are not built.

## 10.8 The interior cutout test took a minute, and did not need to

It probes a **961 × 241 grid — 231,601 points** — against a field that is
**105 × 49 = 5,145 texels**. Each texel therefore got probed about 45 times, and
each probe recomputed the *same* 25-point maximum over the same cell: **11.6
million calls** into the hull's own width functions to establish 5,145 distinct
numbers. Those functions are not cheap either — each bisects 24 times for the
deck station and 14 more for the counter.

The value is constant within a cell by construction, which is the reason the cell
is what gets asked. Memoised per cell: **52 s → 2.4 s**, same assertions, and the
whole suite went 86 s → 40 s. It had been flaking against the 60 s timeout
whenever the machine was busy.

## 10.9 What is open

**One-sided surfaces — the fault class this ship keeps finding, still live.**
Running the room seal sweep **front-face-only**, the way the renderer sees, gives
escapes clustered round the landing: surfaces a body below decks looks straight
through. The new sweep is **two-sided** — "a surface stops light whichever way it
faces" — and therefore *cannot* catch them; put §10.4's 0.59 m fault back and it
still passes, because the weather deck's break riser stands in the gap facing
forward, stopping a two-sided ray it would never stop a photon. **The right
instrument already exists**: `ship-rig.test.ts`'s `windingAgreement` caught two
winding errors in this round's own new geometry. A front-face sweep becomes the
guard once the surfaces are fixed.

**Two small triangles of daylight in the stern's after corners.** Much reduced
and not gone. Building the raked stern cost five successive seam fixes, each one
the same sentence — *two curves through the same endpoints are not the same
curve* — and the ceiling and the sides now read one shared edge polyline
(`wedgeEdge`). The last of it wants the render, not a test: a hairline subtends
less than the finest fan in these sweeps, which §5 already says in terms.

**Unchanged from before and still Ash's calls:** interior lighting before any
furniture is judged (§4 and §9.4); no crew scuttle forward; the forecastle's
1.728 m at the sides against a 1.75 m body, where the duck now fires and has
never been looked at; a door in the peak bulkhead; and the hold under the
hatchway boards, which is not modelled at all.

## 10.10 Instruments this round used

- **`window.__drift.deckWalker`** is exposed in dev now. Every below-decks fault
  here was found by putting the eye somewhere specific and raycasting what it
  sees, and the panel's station buttons only reach the places someone thought to
  name.
- **A free-space map** — for each (x, z), is a body of the walker's radius clear
  of every in-band column and on a floor it can reach? Printed as ASCII it showed
  the sealed island at the ladder head in one screen, which no amount of reading
  the code had.
- **Stepping the simulation synchronously** from the console (`sim.stepSimulation`
  in a loop) measures motion without needing rAF, which the Browser pane will not
  give between tool calls. That is how the window clearances were measured.

---

# 11. The layout round — the way in, and the way through

**Ash walked her again and reported movement rather than geometry.** Two
complaints, both about the route rather than about any measurement:

> at the moment, when I stand on the deck … left and right of the aft mast,
> there's two staircases … that's a little bit redundant … you walk up one of
> the sets of stairs, and then you go to the centre in order to descend to the
> lobby

> when you go through that door to the midship part of the interior … why did
> we build a staircase inside the room? … why don't we cut those stairs in
> here, into the floor of this lobby section, so that you step down and
> actually get a taller door

Both were right, and both were cases where the *code had written down its own
reasoning and the reasoning was incomplete* — not cases where a number was
wrong. That is the shape of this whole round and it is the thing worth carrying
forward.

## 11.1 What landed

**The wardroom well.** The flight between the landing and the wardroom moved
from inside the wardroom to inside the landing, descending forward to arrive at
the bulkhead already low. The doorway's sill is therefore the *lower* floor:

| | lintel | sill | clear opening |
|---|---|---|---|
| before | 3.713 | 2.450 | **1.263 m** |
| after | 3.713 | 1.800 | **1.850 m** (capped by `DOORWAY_HEIGHT`) |

The wardroom's own headroom just inside that door is **1.913 m**. So the only
crouch below decks was into a room you can stand up in, and it existed purely
because the 0.65 m of level change was spent on the far side of the wall.

**The companionway at the break.** Its head is now `QUARTERDECK_FORWARD_Z`
itself — you step off the waist deck you are already walking on, and the hole is
a bite out of the quarterdeck's forward edge rather than a hatch in the middle
of it. The port quarterdeck ladder is gone; the starboard one is the way to the
helm.

| | before | after |
|---|---|---|
| drop | 2.012 m | **1.446 m** (exactly `QUARTERDECK_RISE` less) |
| pitch | 71° | **~60°** |
| risers | 7 × 0.287 | 5 × 0.286 |
| treads | 6 × 0.117 | 5 × 0.213 |
| foot landing | 0.45 m | 0.45 m |

Both dimensions improved at once, which is worth stating plainly: **the
steepness was never a taste problem to be tuned. It was the quarterdeck's rise
being paid for twice.**

The opening also runs out to the ship's side — `xHi: 'side'` — so the bulwark's
inboard planking is its outboard coaming and there is no wedge of dead deck
between the two. 1.229 m across at the break, 1.071 m at its after end.

## 11.2 The fault class this round is about

**A bound written for a feature in the middle of a thing is silently wrong for
one that reaches its edge**, and nothing about the symptom points at the bound.
This cost *four* separate faults in one afternoon, in four files:

- `buildDecks` filtered openings with `zForward < segment.z1`. The companionway's
  head is that segment's forward limit, so it dropped out and **the deck was
  lofted straight across the hole** — with the lantern standing on it. The
  walker never agreed: `schoonerStandAt` reads `inCompanionway` and had been
  withdrawing the deck there the whole time. *A hole you fall through and cannot
  see is the same class of fault as a wall you can see through and walk past.*
- `spaceOpening` used a strict `<` at the room's forward bulkhead, so the
  landing was reported as having no opening at all: its deckhead was lofted
  across the shaft and its beams were spaced *through* it. Ash saw rafters in
  the way of the way down.
- `stepTreadIndexAt` refused on an exact bound while `inStepsWell` admitted on
  ±1e-6. **Three nanometres** of stations with no floor at all, at the lip of
  the stairs. The fallback below the quarterdeck *is* the quarterdeck, 2.0 m
  overhead, which `attemptMove` reads as a wall — so a body walked to the edge
  of the well and stopped dead with nothing reporting a fault. It only
  reproduced at strides that landed inside the gap; the guard sweeps stride
  length rather than trusting one.
- `flightHeadY` sampled 1 mm forward of the break, and `deckStandAt`
  deliberately admits a query within `BREAK_TOLERANCE` to *both* levels and
  answers the higher. The flight silently kept its old 2.01 m drop and surfaced
  as **0.40 m risers** — a ladder nobody can climb. `FLIGHT_HEAD_INSET` is
  derived from the tolerance now, not chosen.

## 11.3 What only an eye found

Every one of these passed the suite. Ash reported all of them by standing
somewhere and looking.

**A coaming cannot be a box.** The deck is sheered fore-and-aft *and* cambered
athwartships, so a level fitting touches it along exactly one line. He saw both
axes separately — the after run "aligned inboard, progressively more misaligned
outboard" is the camber; the inboard run "aligned at its aft end, misaligned
towards the fore end" is the sheer. M3 had already written this down for the
quarterdeck ladder's treads and it was not carried over. Each run is now
segmented and founded on the deck under *itself* for the collider, and drawn as
one continuous strip per face — because butted boxes put coincident end caps at
every joint, and coplanar faces are notches of z-fighting down the rail.

**The riser was one-sided.** The quarterdeck break runs from the waist at 3.88
to the quarterdeck at 4.45, and the landing's own deckhead is 4.27 — so its
lower 0.39 m stands *inside the landing at head height*, and from in there it
was a wall you looked straight through into daylight. This had been
mis-attributed once in writing, as the room-seal sweep not understanding the new
opening. It was not the sweep.

**The dark bar was two separate faces.** Matching the flight's ledge to the
deckhead fixed the walk, but a later inside-out inspection showed that the drawn
bulkhead still continued across the shaft above its collider and the generic
opening-lining routine drew another 130 mm ribbon across the open forward end.
Both faced aft, so both were black from the landing and invisible from the deck
side. The bulkhead is now cut above the penultimate tread — the same datum its
collider uses — with a closed sill and inboard jamb. The forward cut-edge ribbon
is omitted because the companion exits at the deck break and is open there.

**§10.4's 0.55 m of open air came back through one line.** `sidePanel` computed
`topAt` from its own room and then lofted to `bulkhead.roof` — deliberately the
lower ceiling, right for a doorway and wrong for timber. One line left behind
when the rest of that fix landed.

## 11.4 Where the walker and the timber must and must not agree

The split this round leaned on hardest, and the one to reach for next time:

- **The drawn wall and collider stop at the flight's second tread from the
  top inside the shaft.** The visible cut is closed across the bulkhead's
  thickness; everywhere outside the shaft the bulkhead remains full height.
  A body must
  be able to come within its own radius of the bulkhead plane while standing on
  the tread *below* the one it is stepping onto. Cap the solid at the top tread
  and it cannot — that is the eleven millimetres this cost once, measured
  against the walker's 0.40 m step-over.

`bulkheadSolids` and `buildInteriorBulkheads` therefore share the same cut
datum. A visible wall that collision ignores is still a wall to the player.

## 11.5 Numbers and constants this round moved

- `COMPANION_INBOARD_X` 0.63, `COMPANION_OUTBOARD_CLEARANCE` 0. The bulwark is
  the outboard coaming, so a non-zero clearance is exposed deck; its former
  0.02 m rendered as a black ledge and forced a bevel into the wall below.
  `COMPANION_X` and `COMPANION_HALF_BREADTH` are gone.
- `DeckOpening` carries `xLo` / `xHi`, and `xHi` may be `'side'`.
  `openingXLimits(opening, z)` therefore lives in `deckSurface.ts` — the file
  that owns where the deck edge is — and `deckOpeningAt` and `inCompanionway`
  moved with it.
- `DeckStair.sides`: the ladder stands on one hand now. This used to be implicit
  and the implication was "both".
- `InteriorSteps` names `sillY` (the floor *at* the bulkhead, which is what a
  sill is) and `farY`, either of which may be higher, plus `sillRun` — the flat
  before the door, which is `COMPANION_LANDING_DEPTH`'s lesson at a doorway.
- `WELL_OFFSET` 0.95, not `DOORWAY_OFFSET`: a well on 0.75 fouled the companion
  coaming by 100 mm. **That constraint died with the coaming and the number can
  go back to 0.75 if the room reads better for it.**
- `flightLedgeY`, `COMPANION_TREADS === COMPANION_RISERS`.

## 11.6 What is open

1. **The deck pump has no shaft.** Ash: *"it's located on the deck but doesn't
   have a shaft going all the way down. Wouldn't it need to connect
   somewhere?"* `SHIP_BELOW_DECKS_PLAN.md` §4.3 puts a pump well at z −1.35 in
   the wardroom; the deck pump was placed as a fitting and nothing joins them. A
   pump that does not reach the bilge is decoration. Not started.
2. **One-sided surfaces round the landing** — the standing open fault. The
   break riser was one of them and is fixed; a front-face-only sweep still finds
   others. Ash has seen it and deferred it deliberately.
3. **The companion hood.** The waist is the lowest part of the weather deck and
   green water runs to it. A companionway at the break is period-normal and the
   answer is joinery, not geometry: a hood over the head, drop boards in
   grooves, a sliding cover. The place is left for it; none of it moves a number
   in `deckInterior.ts`. Ash's call.
4. Unchanged and still open from §10.9: no crew scuttle forward; the forecastle
   at 1.728 m against a 1.75 m body; a door in the peak bulkhead; the hold under
   the hatchway boards; **interior lighting**, which `INTERIOR_SKY_VISIBILITY`
   still fakes with a constant.

## 11.7 The honest consequence of a tapering hatch

The opening follows the deck edge and the hull closes as it goes down, so a body
that enters hard against the bulwark and then walks *dead* straight arrives at
the bottom tread with its outboard shoulder past the lining, and stops. That is
what a tapering hatch is — a ladder is climbed, not fallen down in a straight
line — so the guard asserts that every entry has a *way* down, and the outboard
case drifts inboard as a hand would. Clamping the hole to the room below was
tried instead and is what left a sliver of planking outboard of the opening:
**the hole belongs to the deck.**

## 12. Companionway visual-repair handover — 11 August 2026

This state is **accepted for integration, not accepted as final polish**. The
companion arrangement is coherent enough to stop iterating on it in poor light;
small gaps and joins that do not yet read perfectly flush remain visible. The
next visual round should improve the lighting before deciding which of those
marks are geometry, shading, or simply surfaces disappearing into black.

### 12.1 What changed in the repair round

- **The ladder's position and walking contract did not change in this round.**
  The preceding layout round moved the companionway to the deck break and made
  the shorter five-tread flight. This repair rebuilt only its visible joinery:
  twenty floor-to-tread boxes became five closed, cambered timber tread boards
  carried by two closed raking cheeks. Ash likes this result. Preserve it as a
  ship's ladder; do not turn it back into a domestic staircase while working on
  the surrounding opening.
- **The outboard landing wall is now the bulwark's continuation.** The former
  20 mm clearance strip and short bevel were removed. One fair panel runs from
  the landing lining to the actual bulwark edge and uses the bulwark region's
  finish and lighting normal, including the short landing abaft the flight.
- **The two inside-only black blockers at the head are removed.** The transverse
  bulkhead's visible face now shares its cut datum with collision and closes its
  exposed sill and jamb. The generic forward deck-cut ribbon is omitted at the
  open deck break.
- **The coaming is closed joinery.** Its visible faces are continuous lofted
  strips founded on the sheered and cambered deck, with an underside and exposed
  forward end cap. It no longer renders as butted collider boxes or an open
  zero-thickness surface.
- **Interrupted deck beams remain real beams.** Only the span through the opening
  is omitted; the portions from the opening to the ship's sides remain in place.

The visible-joinery tests raycast the generated meshes from the same directions
that exposed these faults. They guard thin closed treads, the fair bulwark wall,
the clear ladder head, and the coaming's underside and forward end.

### 12.2 Deliberately left for the next round

1. **Lighting first.** `INTERIOR_SKY_VISIBILITY` is still a constant and the
   present interior/deck-break lighting makes finish continuity hard to judge.
   Establish useful ambient/daylight and exposure before another seam hunt.
2. **Minor gaps and non-flush joins.** Ash still sees some around the assembly,
   but they are no longer severe enough to block integration. Reinspect them
   under the improved lighting rather than compensating blindly with more
   overlapping faces.
3. The older open work in §11.6 remains open: the deck-pump shaft, other
   one-sided landing surfaces, companion hood, forward crew scuttle, forecastle
   headroom, peak door, and the hold beneath the hatchway boards.

## 13. Above-deck daylight baseline — 11 August 2026

The exposed deck now has the lighting baseline the interior round must inherit.
This did **not** retune the Sun, world probe, exposure, tone curve or ocean. The
fault was a missing transport term close to the ship: real pale planking returns
warm light into an inward bulwark or stair riser, while the renderer previously
gave a face turned away from the Sun only the distant open-world probe.

### 13.1 What landed

- `WorldPbrMaterial` accepts an optional local diffuse-bounce state. It adds
  true irradiance to the existing indirect-diffuse path and therefore appears
  in the existing term diagnostic rather than hiding in a new light.
- The schooner's local field is driven every frame by the cosine-weighted sky
  mean plus direct Sun projected onto the ship's current deck-up axis. The deck
  reflectance and an effective lower-hemisphere coverage of **0.42** return that
  light; no time-of-day curve or brightness gain is involved.
- Receiver orientation is analytic: an upward plank receives zero of its own
  lower-hemisphere bounce, a vertical wall receives one half, and an underside
  receives the full field. The participating regions are `deck`,
  `inboardBulwark`, and deck fittings. Rig and interior materials are excluded.
- The companionway coaming now owns the `deckJoinery` region. It keeps the same
  oiled-oak colour and finish as the cabin joinery, but receives full outdoor
  sky visibility and deck bounce because every visible face stands above the
  weather deck. It no longer inherits the cabin's 14% sky visibility merely
  because it was built by the interior geometry pass.
- Every exposed stair block now carries one sampled deck-timber colour around
  its tread, riser and both cheeks. The previous pale top plus dark-red sides
  were two authored finishes, not one material changing under the Sun.

### 13.2 Verification and boundary

Focused tests pin the hemisphere integral, live sun/sky derivation, shared
uniform state and all-face stair colour. The live term view was then judged at
noon and mid/late afternoon under front, back and both cross-light directions,
plus a high-cloud case. The direct-only view is unchanged and still goes black
on an away-facing face; the indirect-only view now keeps the red bulwark and
timber risers legible. That separation is the acceptance criterion: form stays
directional while material identity survives.

This is deliberately a low-frequency first bounce, not global illumination. It
does not resolve a shadow from one particular cleat, nor should it be extended
below decks as a uniform fill. The interior remains next: spatial portal
visibility and enclosed-room transfer must be built on top of this daylight
baseline.
---

# 14. The below-decks asset round — the pump, the hold, and a way to open things

Ash asked for three things and the fourth arrived on its own: fix the pump
shaft, model the hold, give the player a way to open something so the hold can
be seen — and, once you could get in, the walker turned out to have been lying
about where a head is.

Dev server **`drift-below-assets`**, port **5237**.

## 14.1 The pump did not need moving; it needed a well

Ash offered to relocate it. **It should not move**, and the reason is that the
missing thing was never the address. `PUMP_Z = MAINMAST_Z + 0.55` already agrees
with `SHIP_BELOW_DECKS_PLAN.md` §4.3, and a pump stands by the mast because the
mast step is the low point the water runs to.

What it had was 0.92 m of tube standing on the planking with a brake on it, and
nothing below. Measured:

| at the pump (x 0.55 port, z −1.35) | y |
|---|---|
| waist deck | 3.897 |
| wardroom deckhead | 3.717 |
| wardroom sole (platform) | 1.800 |
| the rabbet | 0.160 |

**3.74 m of missing shaft, 1.92 m of it standing in the wardroom.** Now drawn,
plus the **well** — the boarded trunk from the limbers to the platform with its
head 0.25 m proud of the sole, which is what makes the pump read as a pump
rather than as a pole through a floor. A well is not decoration: it is what
keeps cargo off the tube and what you sound to find out how much water she is
making, and `holdStow.ts` builds the stow round it.

`PUMP_X`, `PUMP_Z` and `PUMP_RADIUS` are exported and read by
`interiorFittings.ts`, so the two halves cannot part company. A test asserts
they meet — a gap there is invisible from both sides, because each file's own
tests would pass.

## 14.2 The hold, and the argument that decided whether you can get into it

Ash asked the right question and it exposed a bad answer of mine. Numbers, all
derived from `massModel.ts` and `hullForm.ts` rather than chosen:

| | |
|---|---|
| hull volume under the wardroom sole | 27.75 m³ |
| iron + water + provisions, at the plan's own stowed densities | 24.47 m³ |
| slack | 3.28 m³ |
| **iron ballast tops out at** | **y 0.880** |
| dunnage over it | 0.05 |
| **clear height in the working well** | **0.870 m** |

The hold is **88% full** — 139 mm of air if the slack is spread, which is what
"rammed solid" means. One place has room in it, because the hatchway has to be
kept clear to work the stow at all.

**Two mistakes were made reasoning about this and both are worth recording.**

1. *"1.21 m deep"* — arrived at by putting all 3.28 m³ under the hatch. Wrong,
   because it assumed the slack could be excavated to the rabbet. **You cannot
   dig a well in iron ballast.** The floor is the top of the iron at 0.880, and
   the ballast figure is *solved* to close Archimedes rather than chosen, so it
   is not ours to spend.
2. *"1.6 m of crawl"* against *"100 mm under the sole"* — quoted side by side as
   though they described one space. The first is the height of an **empty**
   hold (1.64 m rabbet to sole); the second is the top of a **full** one. Ash
   caught it. Both true, neither a place a person could be.

**The real question was never "is the hold too small".** It was *"is our
walker's crouch too tall"* — and it was. See §14.3.

The stow is drawn from the same arithmetic: ballast to 0.880, dunnage, then
casks in **two nested tiers** at 1.155 and 1.545, topping at 1.770. The cask is
0.45 m × 0.66 m, sized by two constraints that agree — two tiers have to fit
under 0.87 m, and eight people have to be able to strike it down a 1.5 m hatch
and manhandle it in a seaway. 96 of them.

## 14.3 `crouchHeight` was never the refusal, and the eye was ducking the wrong bone

Two faults in `DeckWalker`, both found by trying to get into the hold.

**The refusal.** `crouchHeight = 1.15` was the threshold below which a move was
refused, while its own comment said it refused only when a gap "stops being a
space a person could get through at all". 1.15 m is a *squat* — upright on your
haunches with your head up — which is nowhere near that. **Ash settled it by
measurement rather than argument: he shuffled under a 0.68 m desk.** Refusal is
`crawlHeight = 0.75` now; `crouchHeight` keeps its old meaning as the height
below which you move at `crawlSpeed` 0.9 m/s. Additive — no existing space in
the ship falls between the two, so nothing changed behaviour except that the
hold became enterable.

**The eye.** `eyeY()` clamped the eye to `ceilingY − headClearance`, with
`headClearance = 0.06`. That treats the eye as the top of the head. There is
**0.13 m of skull above it** on a 1.75 m body with a 1.62 m eye, so the crown
was passing through the deck beams anywhere with under 1.81 m of headroom — the
forecastle at the sides (1.728), the landing (1.755), the cabin's sides. The
clamp is to the crown now. In the hold's 0.87 m well the eye sits at **0.68 m**,
which is Ash's desk almost exactly.

`headroom()` and `posture()` are on the walker so speed, the panel and the tests
cannot disagree about which of the three a body is in.

## 14.4 Space is "use", and the sail moved to R

Ash's call. Space was `onToggleSail` — a *global* verb with no target, which
does not survive an interior: the boards, the cabin door, the sea chest, the
chart drawers and the deadlights are all "open", and a key per object is not a
control scheme. So Space asks a question and the answer is whatever is under the
crosshair within reach. **The codebase already had the right shape on touch —
*tap the sail to raise it* — and this generalises it.**

`Interactables.ts` is the mechanism (registry, reach pick, ray-box);
`shipInteractables.ts` is what this vessel has; `UsePrompt.ts` is the one line
of interface, which appears **only when something is in reach** and names the
verb. On touch it is the button that does it. Contextual rather than a
persistent FAB because a button that is greyed out most of the time teaches that
the control is usually useless, where one that appears in front of something
teaches the opposite in a single showing.

### The fault that made the first version unusable

**`REACH` is measured from the eye, and the eye is 1.62 m above the floor.**
1.6 m of reach therefore cannot touch the deck a body is standing on. Worse, a
ray aimed at a 24 mm board on that floor enters its slab **2.20 m** away however
close you stand, because almost all the distance is the drop rather than the
walk. Every floor-level object in the ship would have been unreachable.

Fixed twice over, and both halves are the honest quantity: `REACH` is 2.2 m
measured from the eye, and the boards' *aiming* volume is knee-high rather than
board-thick. **A target is where a hand would go, not where the timber is.**

## 14.5 The boards had to become real before they could be lifted

They were six boxes merged into the hull's `interiorSole` buffer — right for a
floor, impossible for a thing that lifts, since a merged geometry has no handle
on any one of its parts. They are a fitting now, with two geometries (shut, and
stacked abaft the opening) and one visible at a time.

**And the sole had no hole in it.** The wardroom's floor was lofted straight
across the hatchway with the boards laid decoratively on top, so the first
attempt at lifting them revealed *solid planking*. `buildSpaceSole` carries a
list of cuts now rather than the single steps well it was written for. **This is
the failure mode a decorative surface always has: it reads correctly right up
until the thing it stands in for has to do something.**

## 14.6 The lining, and a sightline that did not stop where the room did

With the hatch open you looked down and saw **sky**. Raycast through the
offending pixels: nothing nearer than 500 m, and the one near hit was at
**z = 3.60** — forward of the hold's own bulkhead at 2.60.

Below the soles the only thing drawn was `buildShell`, the hull's *outside*,
lofted one-sided — so the whole under-floor volume was transparent. It had cost
nothing while there was nowhere to look from. **The first thing that changes
when a floor becomes an opening is which surfaces are load-bearing for the
illusion.**

The first fix lined only the wardroom's stations, which is where the hold is.
That was not enough and the reason is the lesson: **a sightline does not stop at
the room it started in.** `buildUnderFloorLining` runs the whole ship now, every
space plus the peak.

## 14.7 A detail budget is an argument about viewing distance

The casks were drawn at six facets, with a comment arguing that a cask is seen
in near darkness at two metres so the count matters and the silhouette does not.
True of looking *down* at the stow; false the moment a body could crawl in among
it, where the nearest cask is half a metre from the eye and reads as a hexagonal
crate. Eight now, ~2,300 triangles, for the only objects in the ship a player's
face gets this close to.

## 14.8 `INDEX_Y_LO` moved for the third time

Literal 3.0 when the deck was the lowest floor; `CABIN_SOLE_Y − 0.2` when the
cabin sole was; the list of rooms when the platform was. The hold's floor is
0.93 and its casks reach to 0.71, all under the platform's 1.80 — so the entire
stow would have been drawn, classified collidable, covered by the enumerating
tests, and walked straight through, in the one place where the cargo is the only
thing between a body and the rest of the hold. It is asked of the lowest surface
a body can be *on* now, which is what it always meant.

## 14.9 The anchoring system

`interiorFittings.ts`. A fitting says *which room, which bulkhead it stands off,
which hand, and how far in*; `placeInRoom` resolves it against
`deckInterior.ts`'s tables. Move the captain's door and the furniture anchored
to that bulkhead moves with it.

The rule worth the module on its own is `sideLimit`: a box against the ship's
side gets the **tightest** half-width over its own footprint *and its own height
band*, because the side leans and a clearance is only true at the height it was
measured at. That is M4's 60 mm deckhead slot, the furnishing slice's 0.1 m
bulkhead and §10.4's level line — three rounds, one sentence. Authors do not get
the choice.

## 14.11 Ash was trapped in the hold, and four things were wrong

> *"i got stuck in the hold, couldnt get out. the stairs don't work... at first i
> got stuck standing in the hold, couldnt see in it, but couldnt get out. didnt
> have ducked view. then i realised, i have to hit space to put the boards back
> over the top... thats not a pleasant position, being trapped in there with the
> boards on top."*

Every part of that was a real fault, and **three of the four were committed by
the person writing §14.6 about that exact fault class.**

### The flight was unclimbable, and only the top tread was reachable

Every tread was given `HOLD_SOLE_Y` as its ceiling. Measured:

| tread | clear | |
|---|---|---|
| 1.22 | 0.58 m | refused |
| 1.51 | 0.29 m | refused |
| 1.80 | 1.96 m | ok, and unreachable from below |

**A tread inside the hatchway has the shaft over it, not the floor it passes
through.** Fifth instance, and the flight also ran *aft out of the opening*,
which is the deeper error: a stair needs run, and run is the one thing a
hatchway has none of — every centimetre aft is a centimetre under solid
planking. **It is a vertical ladder now, on Ash's call**, three rungs at 0.29 m
inside the hatchway's after end, and its rungs carry the shaft's ceiling.

### Landing under an open hatch stood you up, with your eye above the floor

`throughHatch` reported the deck two floors up for a body standing in the
opening. Physically defensible — your head really would be up through the hole
— and it plays terribly: the eye goes to 2.55 against a sole at 1.80, so you
drop into the hold and find yourself **looking at the wardroom, unable to see
the room you are standing in.** Removed. The hold is ducked everywhere; the
place a body straightens up is the ladder, which is something you step onto on
purpose.

### The boards remain one toggle from either side

The earlier safety rule hid the lay action below the sole. That prevented one
kind of trap, but it also made the second Space press disappear after a player
opened the hatch and fell through. The hatchway is now the aiming target in
both states and from either side: look into it to lift or lay the boards. A
player who lays them from the hold can aim up and lift them again, so the action
stays reversible instead of being silently unavailable.

Opening the boards also no longer clamps the eye to crawl height in that frame.
The feet fall with a deliberately gentle acceleration while the presented body
folds into its crawl posture over the same movement. On the way out, the rung
steps retain their collision heights while the camera blends them into a
slower continuous climb-and-stand.

The ladder surfaces are published only while the boards are lifted. Laying the
boards from inside the hold therefore closes the route as well as the picture:
the body can crawl to the foot but cannot acquire a rung until it looks up and
lifts the boards again.

### A cask stood between the body and the ladder

`lastContact = stow[76]`. The working well was carved by testing each cask's
**centre**, and a cask is 0.66 m long, so one centred 0.19 m abaft the well
reached into the ladder's own footprint. **A point test standing in for a volume
test** — the ocean cutout's §4 erosion fault from the other side. Invisible in
the render, because a cask leaning into the working space is what a real stow
looks like, and wrong only to a body trying to get past.

### The guard that should have caught all of it

`can be left again` asserted every riser was inside the step-up and that the top
tread met the sole. **Both were true of a flight nobody could climb.** Arithmetic
about a ladder is not the claim that a body gets up it, and a floor query answers
"is there a step here" rather than "can a body reach it" — which is the only
question Ash was asking.

It drives `attemptMove` now, from the middle of the hold to the wardroom's sole,
and reports where it stopped and on what. Verified by putting the cask fault
back: *"never got out of the hold; stopped at z=0.85 on stow[76]"* — the exact
symptom, from the test.

## 14.12 The floor of the wardroom was not there, and the floor of the hold was invented

Two more from Ash, both from being down in the hold and looking.

### A sole is one-sided, so from underneath it is not there

> *"when i'm ducked in the hold, i can't see the floor of the wardroom at all.
> is that another one-sided bug? i'd expect that my view was cut off by the
> floor, but it appears like the floor disappears."*

It is, and it is the **sixth** instance. A raycast up from the hold went
through the platform at 1.80 and hit the wardroom's own deckhead at 3.87:

```
under solid sole, aft of the hatchway   interiorLining @ 3.87
under solid sole, outboard              interiorLining @ 3.91
```

`buildSpaceSole` drew one sheet wound to face up. Every room's *ceiling* is a
separate surface built for the room below it, and the hold is not one of the
rooms, so nothing drew the underside of the platform.

**Both faces come off the same rows now**, offset by the planking's thickness
and wound the other way — deliberately one code path, because the openings cut
in that surface are worked out once and an underside built from a second copy
of that list is a second chance to disagree about where the hatchway is. The
underside goes in `interiorLining` rather than `interiorSole`: the top of a
floor is scrubbed planking, the underside is bare joinery nobody has holystoned.

**It cost nothing until the hold could be occupied.** The first thing that
changes when a floor gets a room under it is that its underside becomes real —
which is §14.6's lesson about openings, one storey down.

### There was a wooden floor at the bottom of the hold, and there should not be

> *"i thought we were either going to be standing on barrels, or the iron at the
> base... whatever we're standing on, it should be plausible for its depth...
> deliberate and intentional 'floor' design."*

Right on both counts. `DUNNAGE_THICKNESS` was 0.05 m drawn as **one full-width
slab at a single height** — dunnage is loose battens under cargo, and a
continuous timber sheet across the bottom of a hold reads as a deck that has no
business being there.

What is underfoot is now stated rather than defaulted:

| | |
|---|---|
| iron ballast, solved | tops at **0.880** |
| loose boards in the working space only | 0.030 |
| **a body stands at** | **0.910** |
| clear to the sole | **0.890 m** — still a crawl |

The cargo has been broken out of the working well down to the ballast, so what
is under you is **pig iron**, with a few boards thrown over it because nobody
kneels on castings for an afternoon. Outside the well there is no floor at all:
the stow is solid to within 139 mm of the sole, which is the honest reason a
body cannot wander the hold.

The ballast's top is drawn as **pigs where it can be seen and as a mass where it
cannot** — a pig is a 60 kg casting about a forearm long, and a hold's floor is
a rubble of them wedged between frames; drawn as one smooth box it reads as a
moulded tray, and the working well is the only place a face gets close enough to
tell. The battens under the stow are runs with gaps, which is what dunnage is.

## 14.13 The hold was one cavern, and its ceiling was a sheet of paper

> *"from the hold, i can see into the bow, with the fore mast coming through it.
> is that intentional? it looks like a big empty space. is that part of the hold
> or not?"*

**It is not, and the plan had already answered it.** `SHIP_BELOW_DECKS_PLAN.md`
§4.5 gives the space under the forecastle to the **cable tier** and the space
under the cabin and landing to the **bread room and lazarette**. Three
compartments; the hold is only the middle one. It read as one continuous cavern
because §14.12's under-floor lining runs the whole ship — which it must, to stop
a ray — and nothing divided it.

Bulkheads now close the hold at the platform's own stations, so the hold below
*is* the wardroom above and the two cannot drift apart. They are lofted up the
hull's section rather than run as rectangles to the width at the floor, because
the hull opens outward as it rises and a rectangle sized at the bottom leaves a
slot at the top — the furnishing slice's 0.1 m fault, where a slot in a bulkhead
is a view into the next compartment. Verified by ray: every look forward now
stops at **z = 2.60**.

> *"can the floor have some thickness to it? the wardroom floor looks like a thin
> sheet of paper."*

It was 0.05 m of planking and nothing else, which is all a sole ever needed to
be. A platform deck is planking **on beams**, and from below the beams are the
whole of what you see.

### The beam depth had to be derived, and picking it by eye broke the hold

Chosen freehand at 0.12 m it made the hold uninhabitable, silently: clear height
under the beams came to **0.720 m** against the 0.75 m a body will enter, while
the walker went on reporting 0.89 because it was still measuring to the
*planking*. Drawn timber and collider disagreeing is this project's standing
fault, and a scantling picked by eye is how you arrive at it.

`PLATFORM_BEAM_DEPTH` is `DECK_BEAM_DEPTH / 2` now — which is what `massModel.ts`
already scantles this structure at, *half the weather deck's*, because it carries
people and stores where the deck carries seas.

Everything downstream falls out of it:

| | |
|---|---|
| beams | 0.090 deep, underside **1.660** |
| **cask diameter, derived** | `(HOLD_DECKHEAD_Y − CASK_BED_Y) / (1 + √3/2)` = **0.402** |
| stow top | **1.660** — flush with the beams by construction |
| clear under the beams | 0.750 — too low to enter |
| clear under the hatchway | **0.890** |

**The cask was 0.45 m measured against the sole rather than against the beams**,
so the top tier stood 0.12 m up inside the timber the moment the beams appeared.
That is the same mistake as measuring headroom to the planking: `spaceDeckheadY`
exists because a room is measured under a beam, and a stow is stowed under one.
The number it gives is a 47-litre rundlet — *more* plausible for eight people
striking casks down a 1.5 m hatch than the hogshead it replaced.

### And so the walkable hold is the hatchway's own footprint

A beam is interrupted where a deck is cut and nowhere else, so the opening is
the one part of the hold with full height under it. That is not a restriction
invented to keep the player somewhere — it is what a hold is: cargo rammed to
the beams, and the only clear space is the hatchway you struck it down through.

## 14.14 What is open

1. **The furniture itself.** The anchoring system is built and proved on the
   pump's well; none of `SHIP_SPEC.md` §9's furnishings exist yet.
2. **THE MASTS ARE LIT AS THOUGH THEY WERE OUTDOORS, IN EVERY ROOM BELOW
   DECKS.** Measured off the live materials:

   ```
   ship:interiorSole      skyVisibility = 0.14
   ship:interiorLining    skyVisibility = 0.14
   interior:timber        skyVisibility = 0.14
   rig:spar               skyVisibility = 1
   ```

   The mainmast passes through the wardroom and the foremast through the
   forecastle and the stow, and both are **about seven times brighter than the
   room around them** — the pale column in every below-decks screenshot in this
   section. Correct geometry, wrong light.

   **Not fixed here, deliberately.** A mast is one continuous tube from the
   keelson to the masthead in a merged geometry, so there is no mesh to name;
   splitting it at deck level would be a geometry change made to serve a
   lighting model that is about to be replaced. §4 already says the honest form
   is **baked per-vertex sky visibility**, and that solves this case for free
   along with the sole-under-an-open-hatch case it was written for. This is a
   note for that round, and it is *this* round's geometry that made it
   impossible to miss.
3. Unchanged and still open from §11.6: one-sided surfaces round the landing
   (Ash has deliberately deferred this), the companion hood, no forward crew
   scuttle, the forecastle at 1.728 m, a door in the peak bulkhead, and
   **interior lighting**, which `INTERIOR_SKY_VISIBILITY` still fakes with a
   constant. Note that the interior reads *well* at midday — an earlier claim
   in this document that it was too dark to judge was a time-of-day error.

---

# 15. The interior lighting round — light through the openings, and the leak that was hiding under it

Ash reported the round's own symptom in one sentence: *at midday the port-side
wall of the captain's cabin reads as lit timber and the starboard wall reads
as black, and they are the same material.* §4 had already diagnosed half of
it. This round replaced the model, and in doing so found that the documented
fault had been sharing its symptom with an undocumented one twice its size.

Branch `claude/ship-interior-lighting-5d0a5a`, dev server
**`drift-interior-light`** (autoPort). **1021 tests green.**

## 15.1 What landed

- **`interiorLight.ts`** — the portal/room light graph. Every opening the ship
  has, read off the tables that built it: the companionway (with its open
  break face), the cargo hatch under its grating (transmittance derived from
  the batten scantlings: 0.287), the four stern lights through period glass
  (0.65, a stated approximation), the hatchway boards over the hold, and the
  three doorways. Rooms with areas and albedos measured off the arrangement,
  and a radiosity solve over the room graph — the landing's light leaks
  through the wardroom door, the wardroom's through the forecastle door, to
  convergence, because it is a linear solve and not a hop count.
- **`interiorLightBake.ts`** — the per-vertex bake: cosine-weighted form
  factors to the vertex's own room's openings (adaptive quadrature, held
  against a Monte Carlo reference to ~1%), doorway glow and the room's
  ambient bath folded per channel. Two vec4 attributes and a scalar; the
  masts take the same bake with a sky ramp at the partners, which closed
  §14.14's glowing-mast fault — `rigGeometry` gives the two lower masts rows
  every 0.3 m (a two-row tube cannot carry a per-vertex enclosure attribute)
  and moved them to the static loft half, where timber that never moves
  always belonged.
- **`WorldPbrMaterial` carries four portal channels** — irradiance and
  timber-tinted bounce per family of opening, published per frame from the
  live SH probe plus the sun's beam flux (bounce only; the beam itself stays
  the shadow map's job, so nothing is counted twice). The interior reddens at
  sunset and dies at dark with no clock, exactly as the companion spot did —
  and the spot itself is retired to the legacy half of the A/B.
- **`setPortalLightMix(0)`** on `window.__drift` restores the legacy constant
  — same frame, no reload — including the spot and the old unscaled
  environment reflection. The A/B is exact.
- **Eye adaptation** (`INTERIOR_EYE_ADAPTATION_GAIN = 10`): an exposure term,
  not a light. With honest transport the cabin's ambient measures ~1% of the
  exterior — a real daylight factor for a room with four small lights — and a
  fixed outdoor exposure renders that black. Eyes adapt; the camera now does,
  low-passed over ~1.2 s going below and ~0.35 s coming up. Because it scales
  the finished frame, every relationship the model computes survives it.
- **Coarse portal culling**: above deck, when no opening's rectangle
  intersects the view frustum, nothing below decks renders — same graph, same
  rectangles, visibility and illumination travelling the same holes.
  `setInteriorCullingEnabled(false)` on `__drift` for A/B. The win today is
  small; it is the scaffolding for the furnishing round's detail.

## 15.2 THE LEAK: `sunLight.shadow.intensity = 0.5`

**Ash found it with his eyes in a term view: every interior surface whose
normal tilted sunward was lit, every other jet black — the cosine signature
of an unoccluded directional light.** The shadow round had set the sun's
shadow to remove only *half* the beam, as a stand-in for short-range
interreflection that did not exist then. On deck that softening reads as
shade. Below decks it means **the hull only stops half the sun**: the walls
lean with the hull's flare, so at midday one side wall of the cabin took
direct sun through the planking and the other took none. Most of the
"one wall lit, one wall black" was never the sky model at all.

Both halves of the bounce that 0.5 stood in for are real terms now — the deck
field (§13) above, the room transfer below — so the shadow is physical
(1.0) as of this round, on Ash's call. **If the deck now reads harsh under
swaying sail shadows, that is an above-deck retune to take separately, not a
reason to put the leak back.**

Two more shadow faults fixed under it:

- **A one-sided surface is invisible to a back-face shadow pass.** Every loft
  on this ship is one-sided, so the deck wrote no depth of its own and
  the sun landed on surfaces a hand's breadth under the deckhead. All ship
  materials now render both faces into the map (`shadowSide = DoubleSide`) —
  §3.3's "an open-ended surface reads as transparency", one pass deeper.
- **The glazing no longer casts.** A shadow map is opaque and glass is not;
  a casting pane would strike the one beam the cabin is owed — a low sun
  through the stern lights.

## 15.3 What the model deliberately does not do

- Sharp beams belong to the shadow-mapped sun (through real holes, under the
  grating's real battens). The portal system is the soft sky and everything
  after the first bounce.
- Within-room occlusion (the pump well shading a corner) is below its
  frequency band, same argument as §13's deck bounce.
- The chain's directionality resolves one hop deep: light through a doorway
  arrives "from the doorway", not biased toward the stair behind it.
- A very long room would need splitting into two cells; no current room does.

## 15.4 Open, and wanting Ash's eye

1. **`INTERIOR_EYE_ADAPTATION_GAIN = 10` is a first number.** Too low and the
   rooms are moody; too high and the noon deck seen up the companionway
   burns. A better form exists if the constant will not settle: meter the
   solved room ambient and derive the gain per frame, the way the sky meter
   already works.
2. **The above-deck shadow retune** (§15.2) — full-strength shadows plus the
   deck bounce, judged on deck under sail.
3. **The cabin at noon is honestly dim** — four small windows aft. Its hour
   is a low sun astern, when the windows flood it. If Ash wants noon warmth
   beyond what adaptation gives, the honest lever is paint (period cabins
   were often painted pale for exactly this reason), not a gain.
4. The furnishing round inherits per-room culling (split the merged interior
   geometry by room) when there is weight worth culling.

The night round's pickup is **`docs/ship/NIGHT_LIGHTING_HANDOVER.md`**.

## 15.5 Ash walked her — the follow-up round's worklist

Ash reviewed on 2026-08-12, same session, and the round merged to master with
his feedback recorded here rather than acted on. Verdicts first: **the
captain's cabin reads realistically dark; the wardroom reads as a nice
in-between; the exposure change crossing the deck line ("it's cool") stays.**
Then the faults, each with as much diagnosis as the code could give before
the session closed:

1. **The wardroom-well steps are black — CAUSE FOUND, unfixed.** The well is
   cut *down into* the landing's sole (treads at y 1.80–2.45, z −2.4…−3.35),
   and `interiorLight.lightRoomAt` admits the landing only at
   `y ≥ soleY − 0.03` with soleY 2.45 — so every tread vertex resolves to no
   room and bakes to zero. Exactly "maybe they weren't marked".
   `deckInterior.inStepsWell`/`onInteriorSteps` already know the footprint;
   teach `lightRoomAt` to admit a well's band to its room, and note the
   general rule: **every future cut below a sole (wells, ladder pits) needs a
   room assignment or it bakes black.** A guard test should sweep
   `INTERIOR_STEPS` treads for nonzero response.
2. **The landing reads too orange and too uniformly bright next to the very
   dim cabin; Ash wants the two rooms closer.** His own diagnosis is the
   right one: the room-uniform ambient bath hands the whole landing the
   average of a room dominated by one very bright opening. Candidates, in
   order: (a) a spatial gradient on the bath — modulate per vertex by
   proximity/visibility to the room's dominant portal instead of one flat
   number (the direct form factor is already baked and is a serviceable
   proxy for where the first bounce concentrates); (b) the global
   `bounceTint` is one warm timber colour applied to ALL bounced flux — at
   noon the landing's budget is mostly white sun, and tinting it all makes
   orange; consider tinting only a albedo-weighted fraction or deriving
   per-room tints; (c) check the doorway transfer into the cabin is not
   under-carried (the cabin's dimness is partly honest — small windows — but
   the gap Ash sees is bigger than the solve predicts it should feel).
3. **The forecastle is nearly pitch dark.** Partly honest — it is the one
   room with NO sky opening (the missing crew scuttle is a standing §9.4
   item, and cutting it is period-correct and would solve this properly) —
   but "completely dark" wants the numbers checked: its only light is the
   wardroom doorway, and both the doorway-glow form factors and the
   `transfer` coupling for that hop deserve a numeric audit before deciding
   the scuttle is the whole answer.
4. **The foremast glows near the forecastle deckhead ("tip of the mast is
   lit").** The spar ramp in `bakeSparPortalLight` is
   `smoothstep(deckY − 0.05, deckY + 0.2, y)` — it starts 5 cm BELOW the
   planking, and with rows every 0.3 m the interpolation band glows inside
   the room. Move the ramp fully above the planking (e.g. +0.05…+0.30) so
   the interior side of the partners is exactly zero.
5. **"Plank-looking things in the ceiling lit up like daylight" in the
   forecastle.** Almost certainly the mast fault's cousin on non-portal
   geometry: deck fittings (`fitting:*` materials carry no portal path and
   full sky) whose feet reach below the planking near the bow — the windlass
   and bitts stand right there. §10.6 fixed exactly this for the fife-rail
   stanchions by founding feet on `deckStandAt`; audit the bow fittings the
   same way, or bake the fittings too. Ash will mark the offenders with the
   new ray inspector (in master, landed after this branch forked).
6. **The dark-red paint crushes to near-black wherever it is dimly lit —
   cabin stern wall, and above deck too.** Not new this round but now
   conspicuous: `inboardBulwark`-family reds sit at a few percent linear
   luminance, and below the tone curve's toe they read black, not red. This
   is a palette/toe interaction to investigate under the term views — the
   candidate levers are the paint (raise the red's luminance) or accepting
   it — NOT a lighting gain.
7. **Two pre-existing strobing artefacts, flagged while walking:** a dark
   moving pattern on the upward faces of the framing round the wardroom-well
   steps, and a "crazy strobing" on the border of the hatch opening seen
   from the wardroom looking up (not the moving sail shadows — something
   else, likely coincident-face z-fighting in the opening's lining). Both
   predate this round; both are ray-inspector work.

Also inherited by the next session: the branch forked before the **ray
inspector** landed on master — the merge brings the tool and this round
together for the first time; lean on it for items 5 and 7.

# 16. The daylight follow-up — the instrument, the meter, and the gradient

Branch `claude/interior-daylight-below-deck-cb610f`, worked 2026-08-13 after
Ash's fresh-eyes report reversed a §15.5 verdict: **the captain's cabin at
14:00 is too dark after all** ("almost pitch black... doesn't feel
realistic"), the forecastle darker still. A look verdict is hour- and
heading-dependent; neither §15.5's "reads realistically dark" nor this
round's numbers survive being quoted without their conditions.

## 16.1 What the diagnosis measured, before anything moved

Live at 14:00 (clear sun; all figures scale together under cloud):

| where                    | irradiance | vs. exterior deck |
|--------------------------|-----------:|------------------:|
| exterior deck            | ~6.0       | 1×                |
| landing sole             | ~0.34      | 1/18              |
| wardroom sole            | ~0.12      | 1/50              |
| captain's-cabin wall     | ~0.010     | 1/600             |
| forecastle, mid-room     | ~0.0006    | 1/50,000          |

The transport is honest — the cabin radiosity solve matches an
integrating-sphere hand-check, and 0.66 m² of glazing against 43 m² of
surface is a 1.6% glazing ratio — so the failing piece was the CAMERA:
`INTERIOR_EYE_ADAPTATION_GAIN = 10`, one global constant for rooms two
decades apart. §15.4.1 had already named the better form.

## 16.2 What landed, in order

1. **The agent inspection harness** — Ash's standing directive ("infra infra
   infra"), built first and used to verify everything after it.
   `docs/graphics/AGENT_INSPECTION.md` is the pickup doc:
   `npm run inspect:view -- --time 14 --stand cabin --look 180,0 --shot
   --grid 16x9` gives a deterministic settled frame plus machine-readable
   lighting; `window.__driftInspect` carries the probe (per-surface term
   ledger with baked-vs-model comparison and a CPU sun-occlusion ray; the
   ray-grid "semantic screenshot"). `DeckWalker.setHeld` exists because the
   settle seconds of heel slip poured a placed body down the open
   companionway. The probe found two §15.5-item-5 offenders on its first two
   outings, with coordinates.
2. **§15.5 item 1** — well treads admitted to the room the flight stands in,
   stated over `INTERIOR_STEPS`; guard test sweeps every tread.
3. **§15.5 item 4** — spar ramp fully above the planking (+0.05..+0.30);
   zero-sky-below-partners is an invariant test now.
4. **§15.5 item 5** — deck fittings bake under a binary planking rule (on or
   above keeps full sky, below takes the room; a windlass foot given the
   spars' ramp would read as dirt); the inboard bulwark's below-deck reach
   takes the same bake; the deck-bounce term is gated by baked sky
   visibility (it is an outdoor term, and the partners glowed with it
   through the deckhead).
5. **The metered eye** — `eyeLightMeterAt`: light arriving at the eye
   position, from the same rectangles and solve the surfaces use, one
   continuous field bilge to masthead. gain = clamp(3.0/meter, 1, 80),
   log-smoothed with the old asymmetric taus. The binary below-decks flag
   and its deck-line exposure jump are gone. The meter sees through
   doorways one recursion deep — the one-hop glow put a measured 8× seam at
   the cabin door plane. Night adaptation above deck is wired and OFF
   (`setNightAdaptation`) pending a night-session verdict.
6. **§15.5 item 2, the gradient half** — a second baked bounce attribute
   redistributes each channel's bath by a distance kernel around that
   channel's own inflows, normalised to the room mean (a redistribution,
   not a light). Per channel, so the cabin's window-bath concentrates aft
   while its door-bath concentrates forward — two gradients in one vec4.

## 16.3 The switches, for judgment

All same-frame, all independent; the CLI takes the same as flags:

    __drift.setAdaptationMode('metered'|'gaze'|'fixed')  default metered
    __drift.setBathGradientMix(0 | 1)                default 1
    __drift.setPortalLightMix(0 | 1)                 unchanged
    __drift.setNightAdaptation(true | false)         default false
    __drift.adaptationDebug()                        meter / target / gain

'gaze' (added on Ash's ask, same session) meters the cosine cone along the
VIEW instead of the position — frame-metering feel: staring into the dark
cabin from the landing opens the exposure before the step through (measured
×2.5 → ×21 at the cabin door), at the price of pumping on dark corners. The
doorway recursion stays position-aimed (what shines through a door is the
room beyond, not the slice aligned with your view).

The Graphics panel ("interior eye adaptation") carries the dials live:
mode select, meter target (lower = every room honestly dimmer — Ash's
"cabin adjusted a little too much" is this dial, try ~1.5), gain cap, and
the darken/brighten response times, with a meter/target/gain readout.
Measured at 14:00: landing ×2.6, wardroom ×22, cabin ×34, forecastle at the
cap and still honestly dark.

## 16.4 What the round found and did not fix

- **The chink at the deck break**: the inboard bulwark is visible from the
  wardroom over the landing's deckhead (probed at vessel (1.77, 3.95,
  −3.11)). Its lighting is honest now (portal-baked, and the bright patch
  that remains is the real sun beam down the companionway striking dark-red
  paint), but the gap itself is §15.5-item-7 geometry work.
- **The forecastle aft bulkhead leaks light round its whole perimeter** —
  visible at gain ~75, same family as b72babe's sealed wardroom bulkhead.
- **Clipped warm colours go pink** through the tone curve's bleach (the
  sun-struck red bulwark, the grating mouth at high gain). Colour-pipeline
  territory; the toe strength was already an open question there.
- **The forecastle still wants its scuttle** (§9.4): the cap times a room
  that meters 1/50,000 is still dark, correctly. The scuttle can join
  CHANNEL_HATCH (sky-up family) — geometry, solve and rebake, no new
  channels.
- **Item 6** (dark reds crush black when dim, clip pink when lit) is now
  isolated cleanly in the metered cabin view: pale lit walls, void-black
  stern wall. A palette/toe decision, not a gain.
- **Item 2's colour half** (the one warm `bounceTint` painting the noon
  beam orange) is untouched — judge the gradient first, then decide.
- **Item 7's strobing artefacts** — untouched, ray-inspector/probe work.
- Perf: the meter is ~tens of µs CPU per frame and the bake carries one
  more vec4 (~1.6 MB); the bake-budget test passes, nothing else measured.

`tests/zz-interior-audit.test.ts` is the diagnosis dump (writes
/tmp/interior-audit.txt) — delete before merge.

## 16.5 Ash's second walk — the dials chosen, and the model's real limits

Ash walked her again the same day, picked the shipped defaults (gaze mode,
target 1.5, cap ×40, floor 0.25, darken 0.55 s, brighten 0.25 s — now the
constants in `Schooner.ts`), and his verdict on the adaptation is: **still
broken — needs much more work.** The dials cannot fix what follows; these
are model problems, and they are the next session's round:

1. **Night, in the cabin: the sky through the stern windows reads
   sunset-bright.** The gain multiplies whatever the openings carry — at
   night that is the night sky ×40. The interior gain and the sky's own
   authored night exposure know nothing about each other, so dark-adapting
   the room un-darkens the night. The fix direction: the meter and gain
   need to live in absolute scene units against TimeOfDay's exposure curve,
   with a ceiling that never renders a visible sky patch brighter than the
   sky system authored it (or the visible-sky term excluded from
   amplification entirely — which is roughly what eyes do: scotopic gain
   does not make the moon look like the sun).
2. **Afternoon, in the cabin looking out the aft windows: the sea view is
   badly overexposed.** Ash wants the camera to compensate down for a
   bright view — the ocean through the window at roughly deck exposure.
   That needs gain < 1 (the clamp currently stops at 1) AND a meter that
   can see the view's RADIANCE, not just incident light: the window rects
   are small, so their cosine contribution to the gaze cone is tiny even
   when they fill the view with bright sea. Candidate forms: weight portal
   contributions by solid angle × source radiance (a view-luminance
   estimate) rather than irradiance; or bite the bullet and meter the
   rendered frame (GPU log-luminance reduction — the real AAA loop). The
   frame meter subsumes complaint 1 as well.
3. **Night, in the landing looking up the stairs: the night sky is bright;
   walk up the ladder and it snaps dark.** Same root as 1 seen from below:
   inside, the cap ×40 amplifies the night sky visible through the hole;
   crossing the outdoors boundary drops gain to 1 and the sky falls back to
   its authored darkness. The above-the-opening = outdoors rule (§16.4's
   fix, b1bdd04) keeps the transition itself seamless in DAYLIGHT, where
   gain is 1 on both sides; at night the two sides disagree by the whole
   gain. Whatever fixes 1 fixes this — the sky must render at one exposure
   from both sides of a hole.

The through-line for the pickup: the current design treats interior
adaptation as a bolt-on multiplier over a day-tuned base exposure, clamped
at ≥1. Night broke both assumptions in one walk. The next round should
either unify interior gain with the scene's exposure metering (one meter,
absolute units, gain free to go below 1), or move to true frame metering
with the model meter kept as the deterministic test oracle. The harness can
capture night conditions deterministically (`--time 22 --stand cabin ...`),
so the whole complaint set is reproducible without waiting for dusk.

# 17. The room-lift round — the lie moves off the camera and onto the walls

Branch `claude/below-deck-lighting-approach-b2e1bf`, 2026-08-13, designed
WITH Ash before a line moved (his ask, after §16 arrived undiscussed). The
diagnosis that reframed §16.5: all three complaints are one defect — a
gain ≥ 1 multiplying the WHOLE FRAME over a day-tuned exposure. Fixed,
metered and gaze only differ in how they choose the number; night broke
where the number is applied. And the reason no other game shows this: they
cheat the lighting, not the camera — interiors are lit non-physically
bright so their exposure barely moves. Our transport is honest (cabin
1/600, forecastle 1/50,000 of deck) and the camera was asked to bridge the
whole gap alone.

## 17.1 The design

'room-lift', the fourth adaptation mode and this branch's default: the
camera retires to exactly ×1 and each room's baked daylight is multiplied
by a FIXED per-room constant on the surfaces. The lie is "the openings are
bigger than they are" — told on the walls, never on the camera:

- The sky/sea through a window is not a portal-lit surface: it renders at
  the scene's own exposure from every viewpoint. §16.5 items 1 and 2 die
  structurally — the night sea through the stern panes stays night, the
  afternoon sea reads at deck exposure (verified frames, harness).
- No frame multiplier means no seam at the deck opening — item 3.
- The sun's shadow-mapped beam and the LANTERN arrive through three's
  light loop, not the portal sum: neither is lifted. The lantern round's
  night look is untouched by any dial position (the camera modes multiply
  the lamp-lit night frame by up to ×40; this mode cannot).
- Deliberately NOT normalised against current light — Ash's night question
  settled it. A lift that divides by the room's meter is the
  ×40-on-the-night-sky failure reborn on the walls. Constants, tuned by
  eye in daylight; night inherits them, and ×4 of a moon-slither is still
  a slither. Dusk needs no handover: the channels dim, the rooms follow.

## 17.2 The plumbing

`aRoomIndex` baked per vertex (0 = outdoors pinned at ×1, rooms 1.. in
`LIGHT_ROOM_ORDER` — append, never reorder), resolved with the same nudged
lookup as `vertexLightResponse` so a vertex can never carry one room's
light and another room's lift. Vertex stage:
`vWorldRoomLift = mix(1.0, uRoomLift[int(aRoomIndex+0.5)], uRoomLiftMix)`;
fragment multiplies only `worldPortalLight`. The mix rides the mode
switch: every camera mode holds it at 0 and renders the pre-lift picture
bit for bit. Slider moves are uniform writes — no rebake. The surface
probe carries `baked.roomLift` (corner-resolved then interpolated, exactly
as the varying) and folds it into the portal terms, so the ledger keeps
matching the pixels. Program cache key bumped to `world-pbr-4`.

Dials: Graphics panel "Lift · <room>" ×1–40 live per room;
`__drift.setRoomLift('cabin', 14)`, `__drift.roomLifts()`;
CLI `--adaptation room-lift|metered|gaze|fixed`. The panel shows the dial
rows the MODE owns: room-lift gets the lifts, the camera modes get the
meter's target/cap/floor/taus — positions persist across the A/B, only
the rows come and go (Ash's ask; a console mode switch moves the panel
too, the sync lives in the update path). SHIPPED DEFAULTS ARE ASH'S OWN
PICKS from the first tuning walk (2026-08-13): cabin ×14, landing ×2.5,
wardroom ×4, hold ×6, forecastle ×20 — forecastle a placeholder pending
its scuttle, his note.

## 17.3 Evidence and what is open

Verified at 14:00 and 22:00 (cabin, wardroom, ladder foot, shaft): the
A/B pairs show gaze nuking the day sea to white and lifting the night sea
to daylight blue through the same panes room-lift renders honestly.
`tests/interior-room-lift.test.ts` holds the index encoding, the bake
agreement, the dial clamps, the shader wiring, and camera = exactly 1.

Open, and inherited unchanged: the void-black stern wall around the
windows (item 6, palette/toe — present in every mode, MORE visible now
that the walls beside it are lit); the forecastle scuttle (§9.4 — no dial
rescues a room with no opening); the chink at the deck break (item 7
geometry); the doorway contrast between rooms with different lifts (a
dial question first, a blend question only if dials can't settle it).
New and small: the worktree needed `node_modules` symlinked from the
parent checkout before `inspect:view` would run — the tool resolves Vite
from its own root.

## 17.4 Ash's tuning walk — the verdict, and the dusk finding

Verdict: "definitely much better. I like how stable it is." His dials
shipped (§17.2). The walk surfaced the round's real open finding: **near
sundown the cabin goes very dark while the deck is still bright and the
sky out the window still LOOKS bright** — morning, sun astern, the cabin
was well lit; evening, sun forward, near-black. He read it as the model
sensing a sky brightness different from the one he perceives. Measured
(harness digest, default heading):

    07:00  sun intensity 6.95, elev ~24°, astern half:
           windows channel E 0.877, bounce 3.870
    19:00  sun intensity 0.30, elev ~0.5°, forward half:
           windows channel E 0.127, bounce 0.113   (~30× down)

Two stacked causes, both real:
1. **Azimuth**: the windows channel's beam term dies by cosine when the
   sun crosses to the forward half — the aft glazing honestly admits no
   beam. This half is physics, and it is heading-relative (wear ship and
   the evening cabin floods again).
2. **Horizon extinction vs display compensation**: at 19:00 the sun's
   own intensity is 23× down. The DECK stays legible because the scene
   exposure curve rises and the sky keeps its saturated colours — the
   compensations that make "still plenty bright above deck" true never
   reach a constant-lifted room. This is the one burden fixed constants
   cannot carry, known and accepted at design time.

Candidate fixes if a future round takes it (NOT built, Ash's call):
a gentle authored sun-elevation curve scaling the lifts (scene-driven,
slow, no pumping — the "escape hatch" named at design); a sea-reflection
term into the windows channel (a low sun forward still glitters off the
water astern); or the gameplay answer he already named — lamps lit below
as the day dies, which the lantern round built for. Item also noted from
the walk, unrelated to lighting: the flat uniform orange timber wants a
materials/textures pass some round.

## 17.5 The dusk diagnosis — Ash's eye was right, and the SH is the liar

Ash chose "diagnose before fixing", and the diagnosis CONFIRMED his
perception as measurement, not adaptation-folklore. Method: the three
cabin captures (07:00 / 14:00 / 19:00, same stand and look) pane-pixel
metered, sRGB decoded, tone curve inverted at each hour's applied
exposure (`applyToneCurve` bisection) — the drawn sky's SCENE-LINEAR
radiance behind the panes — set against the windows channel the frames
were lit by. Dump script: `zz-dusk-honesty.test.ts` (scratchpad; restore
into tests/ to re-run). Results, morning/evening:

    pane sky as DISPLAYED (what the eye compares):   4.0x
    pane sky SCENE-LINEAR (the drawn sky itself):    3.0x
    windows channel E (what the model sampled):      6.9x
    windows channel with beam:                      34.4x

    channel-E : drawn-sky-L norm — 14:00 = 2.04 (baseline),
    07:00 = 2.57 (inflated x1.26), 19:00 = 1.11 (STARVED x1.84)

Factored: of the 34x collapse Ash stood in, ~5x is the sun beam dying by
cosine (honest, heading-relative), ~3x is the drawn sky honestly dimming
astern, and ~2.3x is MEASURED MODEL DISHONESTY — the order-2 SH cannot
hold a sunset's solar concentration without starving the anti-solar
directions (the `max(0)` clamp in `sampleWorldShIrradiance` marks the
regime), and at dusk the stern windows face exactly the starved side.
Morning is flattered by the same mechanism (circumsolar glow inside the
windows hemisphere).

The fix ladder this implies, for the next round to take in order:
1. **Portal-aimed sky sampling** (the honesty fix): the panes frame a
   NARROW solid angle — sample the drawn sky's radiance through the
   portal directions (small quadrature) instead of the SH hemisphere at
   the portal plane. Kills the starvation and the flattery in one move;
   the instrument above is its acceptance test (the norm should sit flat
   across hours). Estimated effect: dusk windows channel rises ~1.8x —
   "really really dark" becomes "dark".
2. **Then the look decision from an honest base**: the remaining ~15x
   (beam x sky) is real physics; whether dusk-below wants the authored
   elevation curve on the lifts or lamps lit below is Ash's call once
   the transport stops lying.

## 17.6 The fix was built, and its first measurement REFUTED §17.5's mechanism

Read §17.5's mechanism claim, then this, in that order — the correction is
the round's most important artefact. The map-integral path was built
exactly as specced: `equirectCosineIrradiance` (the projection's exact
integral, same texel directions and band solid angles),
`WorldLighting.sourceIrradiance` over the readback pixels with a
direction cache, `samplePortalSkyIrradiance` as the bus, probe gain
riding along, `--portal-sky map|sh` / panel checkbox / `__drift` as the
same-frame A/B. Then the A/B was measured on the live sky — the SAME
quantity both ways, which §17.5 never did:

    windows channel E   map      sh       delta
    07:00               0.8836   0.8767   +0.8%
    14:00               0.7687   0.7683   +0.05%
    19:00               0.1267   0.1279   -0.9%   (up channel -2.5%)

**The L2 probe was not starving anything.** Nine coefficients carry the
cosine-convolved irradiance of this sky essentially exactly (the classic
Ramamoorthi–Hanrahan result; a synthetic-morphology sweep confirmed
smooth skies err only ~5%, and compact spikes INFLATE anti-solar rather
than starve it — see the portal-sky tests). §17.5's error was inferring
reconstruction error from a NORM DRIFT between two different quantities:
channel E is a hemisphere integral (dark sea and the full aft-sky
gradient included), the pane figure is a narrow patch of sky well above
the horizon. At dusk those diverge HONESTLY — composition, not lies. The
measured numbers in §17.5 all stand; the attribution does not.

What remains true and shipped: the map path stays the default because it
is the exact integral at identical cost (cache-absorbed, refreshes ≤1/s),
it is immune to any future spiky-sky regime the basis genuinely cannot
hold, and the 'sh' A/B side is the standing proof of equivalence. What
changed for the roadmap: **the "honesty fix" lane for dusk is closed —
measured closed.** The dusk cabin is dark because the physics says so,
about ~5x beam x ~3x sky patch x ~2.3x hemisphere composition, and the
remedies are the two §17.4 already named: the authored sun-elevation
curve on the lifts, or lamps below. Ash's call, from a base now proven
honest twice over.

Method note for future rounds: a norm between two DIFFERENT quantities
drifting across conditions is a hypothesis, not a diagnosis. Attribution
needs the same quantity measured both ways — build the second path, run
the A/B, and be ready for it to acquit the accused. This one did, and
the fix's value turned out to be the proof, not the pixels.

---

# 18. The fore scuttle — the crew get a way on deck of their own

Standing item since §9.4, carried unbuilt through four rounds: *"the crew have
no way on deck."* The forecastle held four berths and a galley, was reached only
by walking aft through the wardroom, and was the one room aboard with **no sky
opening at all** — which is why every lighting round in a row ended by noting
that it metered about 1/50,000 of the deck and was correctly, hopelessly dark.

It is cut, and it works. Dev server **`drift-scuttle`**, autoPort.

## 18.1 Ash pointed, the ship agreed

Ash marked the spot by eye with the ray inspector before anything was measured
— five rays, three from inside the forecastle and two on the planking above —
and described the concept rather than the coordinates: *"an opening in the
corner of the ceiling and a ladder down the wall to the corner of the
forecastle."*

The measurement afterwards found the patch he had pointed at is the **largest
unobstructed deck on the ship forward of the mainmast**:

| bound | station | what stands there |
| --- | --- | --- |
| aft | z = 2.39 | cargo hatch's forward coaming |
| forward | z = 4.29 | foremast |
| inboard | x = −0.41 | fore fife rail's starboard stanchion (z = 3.48 only) |
| outboard | x = −1.87…−1.96 | headsail pin rail on the bulwark |

1.46 m athwartships by 1.90 m fore and aft, with nothing in it. §9.4's objection
— *"there is no clear 1.15 m on the centreline forward"* — was true and was
about the **centreline**. Offset to one hand it fits, and a scuttle offset to one
hand is period-normal rather than a compromise: a scuttle is not a companionway.

Starboard, because the wardroom doorway is at `DOORWAY_OFFSET` to port. The two
ways into the forecastle now sit one each side of its after bulkhead.

**One thing in the sketch could not be built as drawn.** Hard in the corner is
through the deck *beam ends*, where they land on the shelf. A real scuttle sits
between two beams with a carling each side, so the hole stands 0.25 m off the
ship's side — which `buildSpaceDeckhead` already draws correctly once the
opening exists.

## 18.2 The coaming, the rail it turned into a kerb, and the 90 mm that settled it

Built with a 0.20 m coaming first. The walk suite found what that costs inside a
minute, and **the mechanism is general enough to be worth naming**:

> A body standing on a raised lid is 0.20 m taller than the deck says it is, and
> the walker's step-over test is measured from its feet. The headsail pin rail
> 0.22 m outboard stands 0.39–0.50 m above the planking — solid from the deck,
> and *under the step-over height from the lid*. So the lid turned the ship's own
> rail into a kerb: the walker climbed the hatch, strode over the rail it could
> not otherwise pass, and came down outboard of it.

`tests/ship-deck.test.ts` caught it as a body 0.145 m inside
`headsailPinRailStarboard[4]` on one heading of sixteen, against a required
0.304. **Any raised standable surface within a stride of the bulwark does this.**
It is not a fact about scuttles, and the next fitting placed near a rail should
be checked against it.

The first fix was to delete the coaming and let the lid in flush — which is
genuinely better joinery for a 1.46 m gangway crossed twice by anyone going
forward, and is what Ash asked for when he asked whether the lid sticks up.

**Flush is not available on this deck, and the number that settled it is
0.090 m — the deck's own fall across the scuttle's footprint.** Measured: the
planking rises 53 mm with the sheer over the hatch's length and 39 mm with the
camber across its breadth, and the two add on a diagonal. A flat lid over that
is flush at exactly one corner and 90 mm wrong at the far one, whichever datum
it takes:

- set to the **lowest** perimeter point — the cargo hatch's rule, and right
  there because its lid is *stepped onto* — it sat 20 mm **under** the planking
  at the scuttle's own centre;
- set to the **highest**, it floated a 40 mm slot at the low end, and that slot
  was a light leak rather than a cosmetic one: probed from the dark forecastle,
  the bright thing at the head of the shaft was the frame's inner face seen up
  through the gap;
- split into planks, the slope runs in two axes and strips only help in one —
  four of them leave 62 mm fore-and-aft or 54 mm athwartships.

**Which is what coamings are for.** A coaming is the level rim a flat cover needs
over a deck that has none; the reason is naval architecture rather than
ornament, and this ship's cargo hatch already records the derived half of it.

So the coaming is back at **0.16 m** — enough to clear the 90 mm fall, half the
walker's 0.32 m step-up, and well under the cargo hatch's 0.28 because this one
is stepped *over* on a gangway rather than walked *to* across open deck. The two
faults it caused are fixed at their sources instead:

1. **The kerb.** `FORE_SCUTTLE_X` moved from −1.30 to **−1.10**. The lid's
   nearest point now stands 0.292 m from the closest pin rail against the
   0.260 m a body needs to touch it, so no part of the lid is within reach of
   the rail at all. `keeps the lid out of a body's reach of the ship's rail`
   asserts the rule directly, so the *why* survives; the walk sweep proves the
   behaviour.
2. **The glow.** See §18.5b — the coaming's inner faces stand above the planking
   and are correctly daylit, and a soffit closes the deckhead from below so the
   room never has a line to them.

## 18.3 What was built

- **`DECK_OPENINGS` gains `foreScuttle`** — 0.75 m square, centred x = −1.10,
  z = 3.00. Everything downstream is derived from that one entry: the deck's
  cutout, the opening lining, the forecastle deckhead's hole and its carlings,
  the interior beam spacing, and the portal-culling test all picked it up with
  no further edits, which is the arrangement `hullForm.ts` was reorganised for.
- **A coaming and a hinged lid on its forward edge**, so a sea over the bow
  presses it onto the coaming instead of taking it off. Two geometries, one visible —
  the hatchway boards' pattern. Standing open it is 0.89 m of oak on end, well
  over the 0.40 m step-over, and it collides: being in the way is what an open
  hatch cover is for.
- **`foreScuttleLid` as a `ClosureName`**, shut at the start of a voyage, worked
  with Space through `SHIP_INTERACTABLES` — *"Open the scuttle" / "Shut the
  scuttle"*. It really is a door, so it gets a door's verb; the boards earned
  theirs by genuinely not being one.
- **A seven-rung ladder**, 1.972 m of rise at 0.282 m a rung against the walker's
  0.320 m step-up, spiked to the after coaming — 25 mm off the forecastle's own
  after bulkhead, which is flat, plumb and structural where the ship's side at
  this station is none of the three. Ash's "down the wall" corner, reached by the
  one face that can take the spikes. Its rungs are published as surfaces **only
  while the lid is up**, the hold ladder's rule.
- **Rungs carry `Infinity` as their ceiling**, not a shaft ceiling. A body on
  this ladder has open sky over it, which is the whole difference between a
  scuttle out of a room and a hatchway between two decks — the walker stands up
  as it climbs out of the forecastle, and stays ducked climbing out of the hold.
- **`--open <names>` on `tools/inspect-view.mjs`**, because a capture of a hatch
  wants the ship in a stated state and the only way to see one open was to walk
  over and press Space.

## 18.4 Two landmines disarmed on the way past

Both were `DECK_OPENINGS.find(o => !o.covered && …)` — a filter that read as a
description of the companionway while the companionway was the only uncovered
opening aboard, and whose whole body is companion-specific
(`companionTreadY`, `COMPANION_TREADS`). The fore scuttle is the second
uncovered opening. Had it landed on a bulkhead station, both would have handed
it a companion tread to stand on. They name the companionway now.

Same shape as the bound that has already cost this ship three faults: **a
predicate written for the only member of a set stops being true when the set
gets a second member, and nothing about the symptom points at the predicate.**

## 18.5 The forecastle is a lit room now

Measured with `eyeLightMeterAt` at midday channels:

| point | before | after |
| --- | --- | --- |
| under the scuttle (−1.10, 3.00) | 0.007 | **0.855** |
| the peak, forward (0, 5.80) | 0.012 | 0.063 |
| the cabin, for scale | 0.076 | 0.076 |

Under its own hatch the forecastle is now brighter than the captain's cabin by
11×, and the far end is still the dimmest lived-in place aboard — which is the
honest shape of one 0.75 m opening 2.8 m away, and is pinned by the rewritten
ordering test rather than left to drift.

The "before" column is the wardroom doorway's own coupling, measured by building
the model with the scuttle's portal removed. It matters because it is what the
shut lid must return the room to — see §18.5b — and because it is **re-measured
whenever the scuttle moves**: the first set was taken at x = −1.30 and the
under-hatch figure changed by a third when the hatch went inboard to −1.10.

## 18.5b Shutting the lid darkens the room — the fifth channel, and the soffit

Ash's verdict on the first cut: *"The forecastle should not be lit by the hatch
opening if the hatch is closed."* It had two causes, and they had to be fixed
separately because they live in different systems.

### The light channel

The scuttle first shared `CHANNEL_HATCH`, so the lid did nothing at all — the
runtime's only lever on a portal is the value it publishes for that portal's
channel, and `CHANNEL_HATCH` also carries the cargo hatch.

The obvious cheap fix — gate that channel **per room**, using the `aRoomIndex`
the bake already writes — was tried on paper and is measurably wrong. The
forecastle's light *before* the scuttle existed also arrived on
`CHANNEL_HATCH`, coupled through the wardroom doorway, and it is not nothing:

| point | pre-scuttle | with the scuttle, lid up |
| --- | --- | --- |
| under the hatch | 7.4e-3 | 8.6e-1 |
| mid room | 2.9e-2 | 1.6e-1 |
| the berths, forward | 1.2e-2 | 6.1e-2 |
| *the cabin, for scale* | *7.6e-2* | *7.6e-2* |

A room gate would have taken that away too, so shutting the lid would have made
the forecastle **blacker than the ship had ever drawn it**. `CHANNEL_BOARDS`
could not be borrowed either, and for a reason worth recording: it is not a sky
opening at all. Its irradiance is *re-radiated* — grating-filtered sky plus the
wardroom's own solved ambient, summed over every other channel at runtime — so
a hole looking straight up at the sky cannot use it.

**So `CHANNEL_SCUTTLE` was added, and `LIGHT_CHANNELS` is 5.** The cost was the
reason not to, and it turned out to be one attribute rather than three: four
channels fitted three `vec4`s exactly, and the obvious widening (three `vec4`s
plus three `float`s) spends three attributes and three varyings to carry three
numbers. **`aPortalChannel4` is one `vec3` holding the fifth channel's direct,
bounce and bounce-gradient side by side** — 12 bytes a vertex, one varying after
the gradient mix collapses it to two components. A channel's three terms are
always wanted together and never wanted per-channel-across-terms, so packing by
channel rather than by term is the shape that fits.

The gate now returns the room to its pre-scuttle numbers to within 0.2%, and
`shuts the forecastle back to its doorway-lit dark, and no darker` asserts
exactly that against the measured baseline. The after rooms do not move — except
the wardroom, which gains ~2% with the scuttle open because it shares a doorway
with the forecastle. That one is honest and is asserted as a bounded gain rather
than as "unchanged".

**Two traps this sprung, both from a length written as a literal:**

1. `VertexLightResponse` typed its three arrays as `[number, number, number,
   number]` — accurate while there were four channels, and a trap at five: the
   tuple pinned the length while every consumer iterated `LIGHT_CHANNELS`, so
   index 4 came back `undefined` and each `reduce` produced `NaN`. Nine tests
   failed with `expected NaN to be less than 1.35` and none named the array.
2. The test fixtures wrote `[6.0, 6.0, 0.7, 0.0]` by hand, with the same result.
   They are built by `channelLuminances({...})` now, sized from the constant, so
   an unnamed channel contributes an explicit zero.

**A length that has to agree with a constant should be written in terms of it.**

### The soffit

Gating the channel left the room dark and one thing still bright: a wedge at the
head of the shaft. Probed rather than guessed, it was `fitting:timber` at vessel
(−1.30, 4.075, 2.625) — the coaming's inner face. Everything up there stands
*above* the planking, so `bakeFittingPortalLight` gives it full sky, correctly;
what was wrong is that the deckhead is cut and the room was looking straight up
at sunlit oak. The §15.5 item-5 family.

`foreScuttleSoffit` is the honest object: **with the cover on, the underside of
the cover is the ceiling**, so an interior-region panel closes the hole from
below, baked enclosed and lit by the forecastle's own portals. Lid up, it is not
drawn and the shaft is honestly daylit.

It took three sizes, and the last two failures are the useful ones. A flat panel
at the deckhead's *centre* height sits below the ceiling at one end — the same
0.090 m fall, one storey down — and that end is a slot. Spanning the deckhead's
own range still left a shallow sight line that **grazed the panel's top corner
by about two millimetres** and rose into the shaft beyond it. *A plug that stops
inside the hole can always be got past by some angle.* It is carried from the
lowest deckhead to the highest walking surface now, filling the deck's whole
thickness.

The guard is a ray sweep from ~2,900 eye positions and directions in the
forecastle, and it measures **barycentrically interpolated baked sky
visibility**, not the mesh's name and not the face's maximum. Both weaker
predicates were tried and both were wrong: the name flags the foremast partner
(a real but separate §15.5 item), and the face max flags every box face crossing
the deck line, which is the accepted shadow-line interpolation band. The test
was checked against a deliberately removed soffit and does fail without it.

## 18.6 What the scuttle costs, measured

- **The outboard sliver is 0.321 m**, against a 0.520 m body. It is not a
  gangway and cannot be made one: the strip is 1.46 m and the coaming is 0.89 m
  of it. It is also not a trap — nothing that narrow can be entered.
- **The route forward on the starboard hand survives, inboard.** 0.655 m of
  clear deck from the coaming's inboard edge to the centreline, with the fife
  rail and the foremast both clear of it. Better than §9.4 predicted and better
  than the round was scoped for: the fife rail turned out to be *forward* of the
  hatch rather than beside it.
- **Shut, it is a 0.162 m step onto the lid and over** — half the walker's
  0.32 m step-up, and reachable from every point of its border because the
  coaming's height is measured from the lowest planking round it.
- Open, the standing lid closes the outboard side entirely and you go round to
  port.

---

# 19. Closures as a kind — the pattern, and the two bugs it exposed

Ash, after walking the scuttle:

> "when it's shut, you can't go through it. Instead you walk over it, and
> likewise if you're underneath, you can't go up through it. And then when it's
> open, you can go through it. And that should be standard for all of our doors
> and hatches … should we have some kind of code reusability, like with
> polymorphism or whatever? What's a good pattern here?"

## 19.1 The pattern, and why it is not a class per hatch

**The variation is not in the closures. It is in the systems that read them.**
Four systems care, and each has one rule it applies to *every* closure:

| system | its one rule |
| --- | --- |
| `deckObstacles.schoonerStandAt` | shut is floor, open is a hole with footholds |
| `Schooner.syncClosures` | draw the state the ship is actually in |
| `shipInteractables` | offer the verb, from every side it can be worked |
| `closures.ts` | hold one boolean, and reset it |

A class per hatch inverts that. `ForeScuttle.standAt`, `ForeScuttle.syncMeshes`,
`ForeScuttle.pick` would put four systems' logic inside each closure — so the
walker's rule about floors gets written once per hatch, and the fifth hatch gets
it subtly wrong. It is this ship's oldest fault wearing a new hat: **two sources
for one fact**, except the fact is a *rule* rather than a dimension.

So: **`SHIP_CLOSURES`, a table of descriptions, and each system iterates it
applying its own rule once.** A row says where its barrier lies, what a body
stands on while it is shut, where the footholds are, which meshes belong to
which state, what verb it takes and which sides it is worked from. Adding a
cabin door is adding a row; the walker, the renderer and the prompt pick it up
unedited. Same device as `DECK_OPENINGS`, `OBSTACLE_SOURCES`, `FITTING_KINDS`
and `INTERIOR_FITTING_KINDS` — and the same payoff the scuttle already got when
one `DECK_OPENINGS` entry produced the loft, the cutout, the deckhead and the
culling for nothing.

The parts that genuinely differ per closure are small pure functions in each row
— a lid panel here, a stack of boards there. **Behaviour that varies goes in a
function; rules that do not vary stay with the system that owns them.**

`closures.ts` keeps the booleans and gains no imports: that is the property that
lets every system read the state without a cycle, so it cannot also be the file
that knows where a lid is.

## 19.2 The invariant, asserted over the whole table

`every closure aboard, shut and open` sweeps `SHIP_CLOSURES` rather than naming
hatches, so a new row is covered the moment it exists.

**Every assertion is a difference between the two states**, and that is not
stylistic. The first draft asserted absolutes — *"shut, there is floor at or
above the closure's own level"* — and passed with the scuttle's own surface
deleted, because the **deck** satisfies it while the hatch is shut. Each
assertion was then checked by breaking the thing it guards:

| break | what failed |
| --- | --- |
| publish footholds through a shut closure | both hatches: *"offers a foothold through itself while shut"* |
| stop withdrawing the floor when open | *"still holds a body up at its own floor while open"* |
| offer one target box instead of two | *"offers only one side when shut"* |
| remove the ladder rate caps | *"is stridden up rather than climbed"* — 35 m/s against a 1.8 bound |

## 19.3 Two real bugs the sweep found

**The ladder could not be climbed at all.** Spiked flush to the after coaming,
25 mm off the forecastle's after bulkhead — which reads well, is where a
shipwright would put the spikes, and is unusable. The bulkhead is a collider; a
body is a cylinder of radius 0.26, so its centre cannot come within 0.26 m of
the bulkhead's forward face at 2.63 and is pushed to z ≥ 2.89. The rungs ran
2.625–2.865. **The walker was shoved forward off the ladder on the first frame,
found no foothold, and fell 2 m to the sole.** Every rung was correctly spaced,
correctly published and correctly gated; the body simply could not stand on one.
It stands `FORE_SCUTTLE_LADDER_STANDOFF` = 0.205 m forward now — toe room, which
a real ladder also has.

**You could walk straight across the open scuttle.** The top rung sat exactly
level with the planking, because the rise divided the drop by the rung count —
which is what the hold's ladder does, and is harmless there because its hatchway
is 1.8 m long against a 0.26 m ladder. This shaft is 0.75 m and the ladder is
0.32 m of it, so a top rung at deck height floored nearly half the opening at
deck height. Dividing by rungs + 1 stops the top rung one rise *below* the deck:
stepping in drops the body 0.25 m into the hole — head at deck level, feet on
the ladder, which is where a body entering a scuttle is.

## 19.4 The prompt: a cone, not a ray

> "I found it quite fiddly getting the action text to appear when I was nearby
> the scuttle. I had to slowly step around a few different directions."

The pick was a strict ray-box hit, which asks the player to put a crosshair on a
thing at their feet. Standing beside the scuttle the eye is 1.17 m above the lid
and about 0.7 m out — nearly 60° below the horizon, on a deck that is heaving.
**The target was never small; the aim was.**

It is a cone now, scored by how near the centre of view a thing is: a box the ray
genuinely enters scores zero and always wins; a box within **50°** is offered;
and a box the body is **standing over** is offered on a **110°** cone, because a
hatch under your feet should not need aiming at. Range is measured to the
nearest point of the box rather than to the ray's entry — what decides whether a
hand can reach a hatch is how far away it is, not where a line crosses it.

Verified in the pane: standing beside the shut scuttle looking **dead level**,
with the hatch not even in frame, the prompt reads "Open the scuttle · Space".

## 19.5 Both sides

`Interactable.box` became `boxes` — plural, because a hatch has two. You could
previously open the scuttle, climb down it, and find no way to close up behind
you. Sides are separate boxes rather than one tall box spanning both, because
the volume between them is the deck: a single box would offer the action to a
body standing *inside the planking*, and would reach through a shut lid.

## 19.6 Ascent and descent

Two directions that were two different accidents:

- **Up** was an ordinary step per rung, so the body arrived at the top of a
  seven-rung ladder in about a tenth of a second and only the camera lagged — a
  teleport with a smear on it.
- **Down** was empty air: the body fell at 9.81 m/s² while the camera spent the
  distance at the authored 4.2, so it trailed from behind the planking.

`WalkerTuning.ladderSpeed` = **1.2 m/s** caps the *body's* own vertical rate in
both directions, which is what makes the camera's job trivial — it has almost
nothing to catch up on because nothing teleported. About 1.6 s from the
forecastle sole to the planking. A sixth of each rung's rise is still allowed to
lag, so a constant rate reads as rungs rather than as a lift.

**The flag marks the position, not the rungs.** Pacing only the footholds left
the last part of every descent as a fall: a body steps off the ladder into the
rest of the hatchway and the floor under it is the sole two metres down, an
ordinary surface. Being *inside an open hole* is what paces a climb, so
`schoonerStandAt` marks every stand in an open shaft `climbable`.

# 20. The cabin lantern — the dusk remedy, chosen and built

## 20.1 The decision

§17.6 closed the honesty lane and left two remedies for the dusk-dark
cabin: an authored sun-elevation curve on the lifts, or lamps lit below.
Ash chose LAMPS (2026-08-14). The reasoning that framed the choice, kept
here because it prunes a branch a future round might regrow: the curve
cannot encode the real shape of the problem — half the collapse is
azimuthal (the beam dies when the sun crosses forward, and wearing ship
brings it back), and an elevation curve is dawn/dusk symmetric, so it
over-brightens the already-flooded morning to rescue the evening. It is
also the species of lie this thread just spent two rounds killing: a
sourceless gain, now on the walls instead of the camera. And it does
nothing after sundown, where a lamp carries dusk INTO night in one move.

## 20.2 The design — the lamp answers to the room, not the sky

`InteriorLamp` (src/scene/InteriorLamp.ts) hangs the deck lantern's own
assembly — `buildLanternAssembly`, extracted from `Lamp` as pure code
motion — from a deckhead hook on a chain. The deck lamp's latch and
daylight rolloff run on sun elevation and sky ambient; a cabin lamp
competes with the ROOM, so both run on the cabin's own portal daylight:

    signal = luminance( Σ_p transfer[cabin][p] · (E_p + S_p) ) × lift_cabin

— the same J the boards' ambient-spill uses, times the room-lift dial
(deliberately the DIAL, not the mix-weighted lift: the camera modes are
legacy A/Bs, and a mode flip that also flipped the lamp would compare
two changes at once). Feed-forward by construction: the channels contain
no lamp light, so the lamp cannot see itself and cannot flicker against
its own contribution. Because the signal carries the beam term, heading
is in it — sail the sun astern and the flooded evening cabin puts its
own lamp out.

Measured on the baseline sheet (default heading, lift ×14), the signal
runs 07:00 0.160 · 14:00 0.047 · 17:00 0.032 · 18:00 0.022 · 19:00
0.005 · 22:00 0.0001. The latch strikes below 0.034 and releases above
0.043 (Ash's walk moved both up from the first cut's 0.022/0.035 —
"on a little earlier, off a little later" — so 17:00 is lit and the
morning holds longer; note 14:00's 0.047 now clears the off threshold
by only ~10%, a margin the calibration test watches); the rolloff is
(signal/0.012)^-2 clamped at 1 — full flame by 19:00, ~0.14 at the
17:00 strike, ~0.6% forced-on at 07:00. The flame's own emissives are
never suppressed: daylight does not dim a flame, it only drowns what
the flame lights. Intensity 1.6 (deck's 1.9 trimmed for an enclosed
room) × trim 1.25 (Ash's dial, pending the chart desk), range 4.5 m so
the falloff ends inside the hull.

The round's second real finding, caught by the first night capture: the
authored exposure curve keeps rising after sundown (×1.27 at 19:00,
×5.06 by 22:00) to hold the DECK legible under a dark sky, and it
multiplied the lamp-lit cabin into one flat clipped orange box. The
deck lantern lives happily under that curve because half its sphere is
spent on the sea; a close timber room returns every photon. So the
flame's illumination divides the curve back out past its 19:00
calibration point — `EXPOSURE_REFERENCE`, fed the frame's authored
exposure through the presentation context (`sceneExposure`, composed
minus any camera-adaptation gain, same A/B-stability argument as the
lift dial). The claim this buys is one no fixed intensity can make
under a moving exposure: the lamp-lit room looks the SAME at 19:30 and
at 03:00, which is true of real lamp-lit rooms. This is §17.4 item 2
answered — the compensations that kept the deck legible never reached
a constant-lifted room, and now the lamp carries them for the room it
owns.

One latch subtlety, found by the harness: hysteresis is path-dependent
by design, and two paths reach the same hour. The page boots at the
opening-voyage hour, the latch fires in that darker room, and a jumped
clock then inherits a state its own hour never walked — the first A/B
sheet showed the lamp lit at 14:00 on exactly this. The latch now seeds
itself from the signal alone on its first tick (a new lamp has no
memory), and `reseedLatch()` lets the capture host re-derive it after
jumping the clock; inside the band the reseeded answer is the day
side's — out.

## 20.3 The plumbing and the dials

Mounted in the Schooner ctor at (0.55, deckhead, −6.4): PORT-aft
(model +x is port, per stations.ts — §20.5's "starboard" was wrong and
is corrected here), off the stern-window sightline and the walking
line, over the corner SHIP_SPEC §9 gives the chart desk; hung from `spaceDeckheadY` so a
re-lofted deck carries the hook. The signal is derived at the end of
`publishPortalLight`; the lamp updates right after it, post-`pose`.
It deliberately does NOT feed the ocean/sail lamp consumers — the sea
has no line of sight to a flame inside the hull.

Dials: Graphics panel "cabin lantern" section (Flame auto/on/off, trim
×0–3, cap-occlusion shadow); `__drift.setCabinLamp / setCabinLampIntensity
/ setCabinLampShadow / cabinLampDebug()`; harness `--cabin-lamp
auto|on|off`, `--cabin-lamp-shadow 0|1`, and the digest now prints a
`cabin lamp:` line with mode/lit/emission/signal. Shadow ships OFF; when
enabled, the assembly's cap and crown (newly exposed as `metalTop`)
cast on LANTERN_SHADOW_LAYER so the vented cap stops the flame painting
a bullseye on the deckhead 0.4 m up — the object shades its own light.
Both lamps also gained `snapLit()`, and the host snaps them with the
eye: a settled frame must not depend on how many frames the settle took.

Tests: `interior-lamp.test.ts` (14) — latch hysteresis and seeding,
rolloff anchors, exposure compensation anchors, emission split, shadow
lifecycle, and a calibration test that recomputes the signal table
through the live transfer solve, so if a rebake moves the scale the
thresholds fail loudly instead of silently lighting the lamp at noon.
1090 green.

## 20.4 Open, and wanting Ash's eye

- The look itself: A/B pairs at the cabin stand, 07/14/17/18/19/22,
  auto vs off, plus shadow pairs at 19:00 and 22:00 —
  `evidence/inspect/lamp-ab-*`. The flame trim, thresholds and the
  shadow verdict are his walk's to move.
- The lamp lights the NIGHT cabin too (22:00, full flame in a black
  room). That is the "lamps lit as the day dies" answer working as
  named, but the below-decks night look is new — his call whether it
  stays always-auto or wants a player action (Space at the lamp, the
  lantern round's precedent).
- Other rooms: wardroom/forecastle/hold have no lamp. Same class, new
  hooks, one signal each — deferred until the cabin look is blessed.
- The walker can walk through the hanging lamp (no collider, head
  height on the port side). Judge in the walk; the transom corner
  is the fallback hang.
- A true gimbal mount waits for the furniture round (§9's chart desk);
  the chain hang is the hung-lamp reasoning the deck davit already
  carries.
- Perf: shadow-off adds one point light (unmeasured, expected noise);
  shadow-on pays six 256 px faces only while lit — measure before
  shipping ON. In the pairs the shadow's visible win is the rudder
  trunk throwing a true shadow across the transom lining; the room
  turns dimensional. Worth its faces is his call.
- The semantic grid cannot see the lamp: the analytical probe models
  portal/sun/sky terms, not three's point lights. The PNGs are the
  evidence for this round; extending the probe is a tooling item.

## 20.5 Ash's first walk — six findings, all landed same-day

His list, and what each became (2026-08-14, second commit):

1. **"Floating at beam height, aligned with no beam."** True — the hook
   hung from `spaceDeckheadY`, which is a HEIGHT, not a beam. Now
   `lampPlacement.lampHangPoint` snaps every hang to the nearest FULL
   deck beam via `deckBeamHangPoint` (shipGeometry — mirrors the beam
   loop exactly, skipping interrupted beams over openings), and seats
   the strap on the beam's drawn soffit (`spacePlankingY − moulded`).
   Snapping to full beams keeps lamps out of every hatchway by
   construction. Note for tests: `spaceDeckheadY` samples the walker's
   INSET roof station, the drawn beam its own z — the sheer puts a few
   cm between them; assert a band, not an inequality.
2. **"Does it swing?"** It does now: chain and lantern pivot in a swing
   group at the hook's eye; a damped pendulum (ω = √(g/L) ≈ 0.8 Hz,
   ζ = 0.12) tracks apparent down in the ship's frame, fed world-down
   per frame from the inverse ship quaternion. `snapLit` also parks the
   swing — captures must not catch it mid-arc.
3. **"Occlusion shadows are jet black."** While the shadow is active a
   quarter of the flame moves to an unshadowed FILL light at the flame
   (`SHADOW_FILL_FRACTION` — the room's first bounce, told cheaply);
   flux is conserved, and both halves ride `renderEmission`, so a cold
   or drowned lamp fills nothing (his explicit ask).
4. **"Lamps for the other rooms."** One per walked room now — cabin,
   landing, wardroom, forecastle (`LAMP_ROOMS`, `Schooner.interiorLamps`)
   — each on its own room signal from the same transfer solve. Shared
   policy constants: the signal is "what the walls show", which is
   room-independent. The FORECASTLE, having no opening, fails all day
   and its lamp honestly burns at noon (measured signal 0.003 at 14:00,
   lamp lit) — the windowless room answer, not a bug. Panel section is
   now "lanterns below" (one policy, all four); harness flags renamed
   `--lamps` / `--lamps-shadow` (old names alias); digest prints one
   line per room; `__drift.setLamps/lampsDebug`.
5. **"Space to toggle, like the boards."** The interactables registry
   grew a `lamp:` namespace: a reach box per lantern from the same
   placement table, verb "Light/Put out the lantern", dispatching to
   the vessel's lamps instead of closure state (`LampInteractionState`;
   `SHIP_INTERACTABLES` itself is unchanged, so the closure-name
   assertion stands). The override rides ON TOP of auto and expires
   when the latch next changes its own state: douse at night → out
   until the morning release; light at noon → burns until the evening
   strike. `reseedLatch` clears it (a jumped clock has no hand either).
6. **Thresholds and trim** — see §20.2's updated numbers.

Still open after this round: shadow A/B verdict and its perf (now up
to FOUR lit lamps × six faces — measure before shipping ON); the swing
is unit-tested but its FEEL is unjudged (damping and ω are constants
at the top of InteriorLamp); the walker still clips the hanging lamps
(no collider); the landing/wardroom/forecastle hang spots are first
guesses wanting his eye; the forecastle lamp lives near the mast
column, which shades it dramatically — possibly good, his call.

## 20.6 The second walk — verdicts and five more, landed

Ash's verdicts from the walk: the look holds, occlusion shadows are
IN (shipped on — the night frame with five lit lamps is still
unmeasured; the panel checkbox is the escape), flame trim ×1.7 is the
dial (raised from his own 1.25 the day before — a dial verdict lasts
until the next walk, plan for that). His five items and what they
became:

- **Lamps are LAMPS now, not rooms** (`LAMP_HANGS`, id-keyed): the
  wardroom carries two — the longest space below left its far end dark
  on one flame — both on the wardroom's one signal. Everything
  downstream keys by lamp id (`lamp:wardroom-aft` etc.); `lampsDebug`
  reports the room per lamp.
- **The chain interlocks.** The first cut laid the tori nearly flat and
  evenly spaced — a stack of washers on a wire. Now: vertical rings in
  alternating perpendicular planes, spacing DERIVED from the interlock
  bound (2(R−r)−r), so each ring's edge sits inside its neighbour by
  construction; the top link turns 90° to pass through the hook's eye.
- **The forecastle lamp moved forward** (nearZ 4.4 → 5.5, snapping to
  the beam by the fore bulkhead): its first spot sat by the foremast,
  whose column swallowed half the room in shadow; forward of the mast
  the whole fore bulkhead works as a bounce card. The mast still
  shades aft-of-mast honestly — that half of the room has the
  companion light and its own doorway.

The lesson worth a line: with occlusion shadows on, LAMP PLACEMENT IS
LIGHTING DESIGN — a lamp beside a mast paints the room with the mast.
The hang table is where that design lives, and moving a hang is one
number.

Follow-ups from the same walk, landed: the BAIL'S FEET now land in the
cap's slope (the old wider arch floated its ends in the air beside the
lid; the fix is in the SHARED assembly, so the deck lantern's bail
dropped too and gained a connecting link to its davit eye — night look
verified unchanged); and wardroom-aft sat EXACTLY on the bilge pump's
shaft (PUMP_X 0.55, PUMP_Z −1.35 — the chain ran through the pump),
dodged to port pending Ash's ray marks. HIS RAY MARKS ARE PENDING: two
wardroom hangs and a second forecastle lamp, recorded in his session's
ray recorder — the "Copy ray set" JSON is the handoff; place from
those `vesselPoint`s when they arrive.

## 20.7 The ray marks, and the beam the helper threw away

Ash's marks arrived as a `drift-inspection-ray-set` — deckhead clicks,
so each `hit.vesselPoint` IS the hook he wants. All three now sit
within 3 cm of his click, and every one matched a beam SOFFIT to the
millimetre in y, which is the tell that he was clicking timber rather
than guessing at planking:

    wardroom-fore  x  1.0415  z  1.0979 → beam z 1.100 (moved 0.002)
    wardroom-aft   x −0.9245  z −0.9133 → beam z −0.900 (moved 0.013)
    forecastle     x −1.0052  z  4.1711 → beam z 4.143 (moved 0.028)

**The finding — a real bug his mark exposed.** The forward wardroom
mark first snapped a FULL METRE aft. `deckBeamHangPoint` rejected any
beam crossing an opening outright, but §14.13's own rule is that such a
beam is *interrupted, not deleted*: it stops at the carlings and
carries on to the ship's side. At x = 1.04 that beam is solid oak, and
Ash had clicked it. The gap test is now per-x — the carlings' widened
gap, exactly as `addDeckBeam` cuts it — with a regression test that
asserts the same station is available outboard and unavailable on the
centreline. The shape of the fault is the one this ship keeps finding
(§14.11): **a bound written for the middle of a thing is wrong at its
edge.** Here the "thing" was a beam and the edge was its outboard half.

What the marks bought, beyond obedience: both wardroom lamps and the
forecastle lamp now hang ~1 m off the centreline instead of ~0.5 m,
which kills the two faults he was pointing at — wardroom-aft was
hanging dead on the bilge pump's shaft, and the forecastle lamp was
0.5 m from the foremast (now 1.0 m, and the room lights across instead
of into a column). Clearances measured: 1.14–1.17 m from the side at
flame height in the wardroom, 0.86 m in the forecastle; 1.5 m from the
pump axis.

Note the forecastle stayed at ONE lamp: his "let's go back to this one"
came with a single ray, read as returning that lamp to its marked spot
rather than adding a second. Trivially reversible — one row in
`LAMP_HANGS` — if he meant the other.

Correction carried from §20.5: **model +x is PORT** (stations.ts, W1),
so the cabin and wardroom-fore lamps are to port and wardroom-aft and
the forecastle to starboard. The earlier text said the opposite.

## 20.8 HANDOVER: the lamp-shadow cost, unmeasured and owed

Deliberately not measured in the build session — Ash's call, so the
machine could be quiet for it. **Occlusion shadows SHIP ON, on an
unmeasured cost.** That is the one debt this thread carries.

**The question.** What does a night frame below decks cost with the
lamps' shadows on, versus off? Worst case is five lit lamps × six cube
faces = **30 shadow passes**, each redrawing `LANTERN_SHADOW_LAYER`
(the vessel's own geometry, never the ocean) at 256×256.

**What is already known without a GPU.** `syncShadowState` gates on
`renderEmission > 1e-4`, so daylight pays nothing at all: the faces
exist only while a flame contributes. The rooms light on their own
signals, so the realistic worst case is a night frame with every room
lit — which is also the frame a player spends real time in. The fill
light is shadowless and costs one extra point light, not six faces.

**The harness gap, and it is the real work.** `tools/perf/suites.mjs`
builds every scenario from TIMES × SEAS × CAMERAS, and all three
CAMERAS are exterior orbital rigs (`distanceM`/`altitudeM`). There is
**no below-decks stand and no lamp switch in the scenario shape**, so
`npm run perf:revisions` as it stands cannot ask this question. Two
honest ways:

1. **Extend the suite** (preferred, reusable): add a stand-based camera
   variant (walker placement, as `tools/inspect-view.mjs --stand`
   already does) and a scenario option that sets `lampsShadow`, then
   let the existing paired-attribution machinery do the A/B. The URL
   passthrough already exists on the app side — `lamps` and
   `lampsShadow` are live `InspectionHost` params.
2. **Bespoke paired run** reusing `tools/perf/browser-harness.js`'s
   fence protocol against two URLs that differ only by
   `lampsShadow=0|1`.

Either way the contract is the one in `tools/perf/README.md` and the
`headless-chrome-gpu-benchmark` note: headless Chrome with
`--enable-gpu --use-angle=metal`, 1280×720 at DPR 2 with the 2560×1440
backing store asserted, **adjacent alternating A/B blocks** (never two
long runs), `readPixels` fences and no `gl.finish()`. A visible window
costs ~3× and invalidates the number.

**Scenarios worth the time**, all at 22:00 production sea:
cabin stand looking aft; wardroom stand (two lamps in frame);
forecastle stand; and one exterior deck frame, which should be
unchanged — the deck lantern's own shadow predates this thread and is
the control that proves the rig is measuring what it claims.

**The decision it feeds.** If the cost is material, three mitigations
in order of preference, none built:
1. **Shadow only the room the eye is in.** `updateInteriorVisibility`
   already resolves that per frame, and a lamp two bulkheads away
   contributes nothing a player can see. This is the big win and it is
   cheap — a `setShadowEnabled` per lamp driven by the same query.
2. Halve the map to 128 px. At 4.5 m range on hull-scale geometry the
   penumbra is already soft (`radius` 1.25) and the fill hides the
   rest.
3. Ship shadows OFF and keep them as the panel A/B — the look Ash
   signed off on would change, so this is the last resort, not the
   first.

Until measured, the escape hatch is the Graphics panel's "Occlusion
shadows" checkbox and `__drift.setLampsShadow(false)`.

## 20.9 The scuttle proved the policy, without being told about it

Merging master (§18's fore scuttle) into this branch was the design's
first real test, because the scuttle is exactly the event the
room-driven policy was built for and nothing in the lamp code knows it
exists. The forecastle stopped being windowless. Measured at 14:00,
forecastle stand:

    scuttle SHUT   signal 0.0032   lamp LIT    (the room is still dark)
    scuttle OPEN   signal 0.5599   lamp OUT    (~173x, well over the
                                                0.043 off threshold)

A sun-elevation lamp — the deck lantern's rule, the obvious one — would
have burned through both, because the sun is the same in each. The
signal comes from the transfer solve, so a fifth channel appearing in
`LIGHT_CHANNELS` and a closure gating it were carried without a line of
lamp code changing. **This is the argument for scene-driven policy over
authored curves, made by a feature built on another branch.**

Merge notes for the next reader: `Interactable` grew plural `boxes()`
(a closure is worked from either side); the lamps supply ONE box each,
because a hanging lamp has only the room it hangs in. The lamps are
also the first workable thing aboard that is NOT a closure — nothing
opens — which is why they arrive by the `lamp:` namespace rather than
as rows in `SHIP_CLOSURES`. Section numbering: master's fore-scuttle
and closures rounds took 18 and 19, so this round renumbered to 20.

---

# 21. The wardroom and the forecastle are furnished

Branch `claude/coord-ship-next`, off master `ba087c1`. The two rooms that were
standing, walkable and empty now have the pieces `SHIP_BELOW_DECKS_PLAN.md`
§4.3 and §4.4 name in them, built to `roomFitting.ts`'s anchors and gated by
walking rather than by reading.

`src/vessel/schooner/wardroomFurniture.ts` and `forecastleFurniture.ts` are the
two new modules; `interiorFittings.ts` lists them, which is what gets them the
loft, the collider index and the portal bake for nothing.

## 21.1 What is standing, with its real numbers

**The wardroom** (21.0 m², sole 1.800, z −2.400 → +2.600):

| piece | station | athwartships | height |
|---|---|---|---|
| mess table | z −1.488 → −0.150, **1.338 m** | 0.84 m on the centreline | top 0.740 |
| form, starboard | the table's whole length | 0.50 → 0.78 | seat 0.420 |
| form, port | z −1.120 → −0.150, **0.970 m** | 0.50 → 0.78 | seat 0.420 |
| surgeon's cabin | z +0.650 → +2.570, 1.92 m | partition at −0.810, **1.251 m inside** | to 1.860 |
| mate's cabin | z +0.650 → +2.570, 1.92 m | partition at +1.262, **0.799 m inside** | to 1.860 |
| chests and stores, each hand | z −2.370 → −0.150, 2.22 m | 0.38 m deep on the lining | 0.600 |

**The forecastle** (12.6 m², sole 2.050, z +2.600 → +6.200):

| piece | station | athwartships | height |
|---|---|---|---|
| galley hearth | z +2.630 → +3.450 | 1.280 → the lining, **0.70 m** | top 0.860, flue to the beams |
| galley dresser | z +3.486 → +4.250 | 0.42 m deep on the starboard lining | bench 0.880, shelves to 1.500 |
| crew berths, each hand | z +4.388 → +6.088, **1.70 m** | 0.62 m on the lining, laid over **24.6°** | tiers at 0.420 and 1.180 |
| hinged table at the foremast | z +3.718 → +4.398 | **0.54 m** on the centreline | top 0.720 |
| sea chest, port | abreast the mess table | 0.44 m deep on the lining | 0.430 |
| sea chest, starboard | against the after bulkhead, outboard of the scuttle | 0.44 m deep | 0.430 |

Doors: each officer's cabin has a 0.70 m opening in its inboard partition with
a 1.800 m head, and a leaf hooked back inside against the partition. **They are
not closures and do not shut.** A closure is a thing four systems have a rule
about (`shipClosures.ts` §19); a cabin door that only changes what can be seen
into is not one of those yet, and open is the state a door at sea is in anyway.

## 21.2 Four fixtures decided this arrangement, and none of them existed when §4 was drawn

This is the round's one general lesson. §4.3 and §4.4 are three years of good
reasoning about a hull, and every block in them was drawn before the things
that now occupy the same volume. In order of how much they cost:

**1. The wardroom's forward lantern took the mate's cabin's width.** Every full
deck beam forward of z +0.1 in the wardroom is cut by the hatchway, so the only
deckhead in the room's forward two thirds that will carry a hook is the beam
stub outboard of the carlings — which is where Ash's own ray mark put
`wardroom-fore`, at x +1.042, and it is the same deckhead the port cabin wants.
The lamp kept it. `cabinPartitionX` stands the mate's partition clear of
`LAMP_REACH_HALF` of the hook, so his cabin is **0.799 m inside against the
surgeon's 1.251**, and the plan's symmetrical 1.25 m pair is not available at
all. The surgeon has the wide one, which is the right way round because §4.3
puts his chest in his.

**Ash: this is the one decision in the round I would most like reversed.** Move
`wardroom-fore` 0.26 m outboard or 0.6 m aft and the mate's cabin becomes a
walk-in room like the surgeon's. I did not move it because it is your own ray
mark and a lamp you placed by eye outranks a cabin I placed by arithmetic.

**2. The fore scuttle took the dresser's place.** §4.4 puts the dresser
"opposite" the galley; the scuttle's ladder now stands there (x −1.100, z
+2.830 → +3.150). The dresser is on the same hand and one station forward,
placed off `FORE_SCUTTLE_Z` so it moves if the scuttle does.

**3. The doorway offsets took the galley's inboard face.** `DOORWAY_OFFSET` put
the door to the wardroom 0.75 m to port, on the same after bulkhead the hearth
wants. The hearth's inboard face is derived from the jamb, not eyeballed clear
of it.

**4. The pump well took half the port form.** The well's boards run z −1.540 →
−1.160 at x 0.36 → 0.74, inside the port form's footprint, so that form is
0.97 m against the starboard one's 1.34. The two benches at a mess table being
different lengths is the room being honest about what is in it.

## 21.3 The mainmast is not at z −1.9, and the mess table found out

`MAINMAST_Z` is the station at the **partners**. Both masts rake, so at the
wardroom's sole the mainmast is at −1.688 — 0.21 m forward of where §4.3 draws
it — and its after face is at −1.518. A mess table butted to −1.9 + 0.175 would
have been a fifth of a metre inside the mast with nothing throwing.

`rig.mastSectionAt(name, y)` is the fix: where a spar stands at one height and
how thick it is there, off the same `SPARS` entry the loft draws and the
obstacle index slices. The wardroom's table and the forecastle's hinged leaf
both ask it. **Anything else built against a mast below decks should.**

## 21.4 The berth flat is anchored to the bow, and `placeInRoom` said so

The first cut anchored the crew berths abaft the foremast and `placeInRoom`
threw: `4.458..6.237 against the room's 2.600..6.200`. The reason is worth
keeping because it is invisible in an anchor — **a piece laid along a wall
reaches further fore-and-aft than its own length.** At 24.6° a 1.70 m berth
takes 1.85 m of station, and the 0.15 m the turn eats is exactly the clearance
an author does not think to budget.

So the berths are anchored to the peak bulkhead — they are the one thing in the
forecastle whose length cannot give — and the dresser, the chests and the table
are fitted into what is left abaft them, off `crewBerthAftZ()`.
`roomFitting.placementSpanZ` is new and publishes the swept stations, because a
fitting placed off another fitting had no honest way to ask where the first one
ends.

The taper the berths are laid on is the sharpest in the ship: **0.49 m of
half-breadth per metre**, four times the captain's cabin. Square against that a
berth would stand 0.9 m off the planking at one end. The two stacks make a V in
plan, which is what a forecastle looks like.

## 21.5 The fault that was not geometry: a chunky box got a phantom half-metre

**Found by walking, and it is the round's best catch.** A body climbing out of
the hold stopped 0.53 m short of the hatchway it was standing directly under,
held by `wardroomTable[5]` — a table more than a metre away.

`deckObstacles.buildColumns` carried a box into the index as one capsule along
its longer horizontal axis, and a capsule's cap reaches past the timber by its
own radius. That is documented and deliberate, and it is *true for the weather
deck*: every box up there is a coaming or a rail, 0.09 m wide, so the phantom is
45 mm. The mess table is 0.84 × 1.34, so its phantom was **0.42 m off each
end** — not a tolerance, a second table.

Fixed where boxes become columns, not by reshaping furniture round it: a box is
now sliced across its width into strips no wider than `MAX_BOX_CAP_REACH`
(0.06), and the phantom is that instead. The strips touch exactly rather than
overlapping, so the union is still the rectangle plus a margin — same guarantee,
same direction of error. Anything already thinner than a strip gets one and is
unchanged, which is every box aboard before this round.

**This is the inverse of the fault this area keeps producing.** Past rounds
found collider problems dressed as geometry; this was a collider problem that
would have been *solved* as geometry — by splitting a table top into boards
until the ghost went away — and the drawn ship would have carried the scar.

## 21.6 What the gates are, and two faults they caught

`tests/ship-interior.test.ts`, "the wardroom and the forecastle are furnished",
keyed to the **rooms** rather than to the piece list so a tenth fitting is
covered without being named. Eleven tests: both lists carry every piece; the
hatchway's footprint is clear at every level; the fore scuttle's shaft and
climb are clear; every doorway's clear opening is empty; every corner is inside
its room's lining at the height it is actually at and under its own beams;
every berth and seat has the headroom to be used; every collidable solid's
corners are inside the columns its own index entry produced and nothing else
is; nothing is inside a lantern's swing; no lane is narrower than the ship's own
doorways; both rooms walk bow to stern; the two hands mirror; the published
frames are asserted rather than commented; and the furniture's timber fits
inside the joinery the ballast solve already carries.

Two of them failed on first run, and both were real:

- **The forecastle's lantern swung into the starboard upper bunk.** 0.208 m
  from the hook against `LAMP_REACH_HALF` of 0.22. Two things fixed it: the
  berths are 1.70 m rather than 1.75, and the lee boards are **let into the
  bunk front rather than standing 28 mm proud of it** — which is better joinery
  anyway, a proud lee board being a shin on the only lane to the bunks.
- **The galley's iron top overhung its own footprint** by 20 mm into a
  narrowing side and went 3 mm into the lining. `sideLimitOver`'s own rule —
  a clearance is only true at the station it was taken.

## 21.7 The lanes, measured

A lane is stated as the run of **centre** positions a 0.52 m body may take, so
0.18 m of lane is a 0.70 m doorway — the tightest opening the ship already asks
a player through.

| | tightest lane | where |
|---|---|---|
| wardroom | **0.320 m** | z −1.20, between the port form and the chest run |
| forecastle | **0.250 m** | z +4.55, between the hinged leaf and the berth flat |

The forecastle figure sized the hinged leaf. At the 0.86 m the plan's drawing
implies, the only way to the bunks closed to **0.03 m** — connected on paper,
wedged in practice. It is 0.54 m now. If Ash wants a bigger crew table the
lever is the berths, not the leaf.

Three routes are walked rather than asserted: the forecastle door to the bunk
flat and back, the scuttle's foot to the galley, and the wardroom's forward
door to its after door in both directions.

**The wardroom's through route dog-legs and cannot do otherwise.** The after
door is 0.95 m to starboard, the forward door 0.75 m to port, and the mess
table is on the centreline between them — and the centreline abaft the mainmast
is *not passable at all*: a body keeps 0.435 m from the mast and 0.26 m from
the bulkhead, and there is 0.68 m between them. So a body crosses in the
0.80 m of clear sole between the table and the officers' cabins, which is what
`CROSSING_CLEAR` is and why the mess table's length is what the room leaves it
rather than a number.

## 21.8 The mate's cabin is a bed-place, and there is a test that says so

At 0.799 m inside, the mate's cabin will not take a 0.62 m berth *and* a 0.52 m
body. So his berth is drawn the full width of the room it is in and his door
opens onto its lee board — a **standing bed-place**, which is what §2's own
*Beagle* precedent describes: "sleeping spaces marked off along one side".

The surgeon's cabin is a room: 1.251 m inside, 0.63 m of floor beside the bunk,
and the walk goes in and out of it.

There is a test asserting the mate's cabin **cannot** be entered. That is
deliberate: if the lantern ever moves and the cabin is widened, that test should
fail and be deleted by the round that widened it, rather than the asymmetry
quietly surviving as a thing nobody remembers the reason for.

## 21.9 Mass: reconciled, not added

No new mass items. `massModel.ts` has weighed a lump of joinery in each of these
rooms since before either was furnished, so the question this round owed was
whether what was built fits inside what was already carried.

Counting a board as solid and a carcase as a shell of 22 mm boards — which is
what a locker, a chest and a bunk front are; a carcase is one box in the drawing
and six boards in the ship:

| | built | already carried |
|---|---|---|
| wardroom furniture | **1010 kg** | 1800 kg (`joinery, wardroom` + `expedition equipment and chests`) |
| forecastle furniture | **801 kg** | 1670 kg (`joinery, forecastle` + `galley hearth`) |

Both inside, so the KG in `SHIP_BELOW_DECKS_PLAN.md` §3 stands and the
hydrostatics are untouched. `npm run test:slow:ship-physics` is green. Taking
the drawn boxes for solid timber instead would weigh the wardroom at 2.4 t,
which is the trap in this measurement and is why the estimator is written down.

## 21.10 Two small moves in shared code, and why

- **`PUMP_WELL_HALF` and friends moved from `interiorFittings.ts` to
  `deckFittings.ts`**, beside the pump's own station. The wardroom's port form
  is cut short by the well — a derived station, per the doctrine — and a
  furniture module cannot import the list it is itself listed in. Same cycle
  `placeInRoom` left that file for.
- **`roomFitting.lowestDeckheadOver` is exported** rather than being sampled by
  hand a fourth time. The hanging locker and the tell-tale compass each wrote
  their own nested loop, and the compass's comment already records that fault
  being found once.

## 21.11 What is owed to Ash's eye

I cannot certify any of this looks right. Precisely what wants a verdict:

1. **The mate's cabin as a bed-place** — §21.2 item 1. The one thing I would
   change if the lantern may move.
2. **The forecastle's hinged leaf at 0.54 m.** It is a two-man board. Four
   hands eating at it in two sittings is the honest reading of §4.4, but it is
   small, and the lever is the berths.
3. **The crew berths' 24.6° V.** It is what the bow does and it is what a
   forecastle looks like in plan, but it is a lot of turn and nothing like it
   exists elsewhere aboard.
4. **The mess table's 1.338 m** — four at a sitting, and its head against the
   mainmast, which I think is the best-looking derived dimension in the round.
5. **Contrast.** Everything below decks is `timber` at 0x5b452c against lining
   of much the same value. The galley is the one piece with a second material
   doing real work (`ironwork` at 0x2e2a26) and it reads; the officers'
   partitions are oak on oak in an unlit room and I suspect they will not.
   This is the "material is about what is behind it" problem and I have not
   solved it — no new palette rows were added.
6. **1.70 m berths.** Short, period-correct, and forced by the room.

## 21.12 What I found and did not fix

- **The wardroom's after bay is nearly a dead end.** The centreline abaft the
  mainmast is impassable (§21.7), so the two after-bay pockets connect to each
  other only by going forward round the mess table. That is the ship's own
  geometry, not the furniture's, and it predates this round — but the furniture
  is what makes it noticeable, and a player will feel it.
- **The galley has no Charley Noble.** The flue rises to the deckhead and stops.
  A stack through the weather deck is a deck fitting, a cutout and arguably a
  closure, and it was not this round's. As built the pipe reads as going
  through the beams; from on deck there is nothing.
- **Nothing below decks can be sat on or slept in.** The mess forms, the sea
  chests and six berths are geometry with no interactions. The captain's chair
  is still the only seat with a state. Every one of these is a place where "an
  entered box outranks an occupied one" would need thinking about again.
- **`spaceSideHalfWidthAt` is capped by the deck's own half-width above about
  0.3 m in the forecastle**, so the room's "side" forward is the deck edge and
  not the hull. It is conservative in the safe direction for furniture, but it
  means the flare of the bow sections between the sole and 0.3 m is invisible
  to `sideLimitOver` — a piece with a plinth could legitimately be wider than
  it is allowed to be. Not chased.
- **`OBSTACLE_COLUMNS` grew** with the strip fix and the new furniture, and the
  walker scans them linearly each move. **Unmeasured, deliberately** — the
  machine is thermally throttled and Ash runs cold passes separately. If it ever
  matters, the index wants bucketing by station, not fewer strips.

# 22. The furniture is usable, and the stern lights have shutters

Branch `claude/coord-ship-next`, on top of §21. The round that furnished the
wardroom and the forecastle closed with *"nothing below decks can be sat on or
slept in — six berths and two forms with no interactions"*, and
`CAPTAINS_QUARTERS_HANDOVER.md` had been carrying the deadlights as "the obvious
next piece" since the quarters round. Both are built.

`npm test` green — 1242 passing, up from 1186 — and `npm run build` clean.
**No performance measurement was taken**; see §22.11.

## 22.1 What you can now do, and where

Eleven stations. One `SeatedStation`, one state, one table.

| station | room | verb | eye |
|---|---|---|---|
| chart desk chair | cabin | Sit at the chart desk | 0.42, 3.67, −6.60 |
| mess form, port | wardroom | Sit at the mess table | 0.58, 3.00, −0.64 |
| mess form, starboard | wardroom | Sit at the mess table | −0.58, 3.00, −0.64 |
| sea chest, port | forecastle | Sit on the chest | 1.68, 3.26, 3.88 |
| captain's berth | cabin | Turn in | −0.83, 3.26, −6.99 |
| surgeon's berth | wardroom | Turn in | −1.81, 2.57, 2.26 |
| mate's berth | wardroom | Turn in | 1.72, 2.57, 2.26 |
| crew berths ×4 | forecastle | Turn in to the lower/upper berth | ±0.82, 2.75 / 3.51, 5.78 |

Plus a twelfth thing that opens: **the deadlights**, one closure for all four
stern lights, worked from the cabin — *"Ship the deadlights"* / *"Unship the
deadlights"*.

## 22.2 It is the desk's machinery, widened — not a second way to sit

`CAPTAINS_DESK_HANDOVER.md` was the brief's named precedent and the round is
mostly the arithmetic of obeying it.

- **`seatState.ts` holds a name, not a boolean.** One chair is the only
  arrangement a boolean survives; eleven booleans can all be true at once, which
  is a body in six beds. `isSeatedAtDesk()` is gone and
  `isStationOccupied('deskChair')` is what the drawn chair reads.
- **`shipStations.ts` is new and is the closure table's shape**, deliberately —
  names in `seatState.ts` (no imports, load-bearing), descriptions in
  `shipStations.ts`, exactly the `closures.ts` / `shipClosures.ts` split.
- **`shipInteractables.ts` iterates three tables now** — closures, lamps,
  stations — where the chair had been a hand-typed row. Nothing about how the
  registry works changed.
- **One `SeatedStation`, whose pose asks which station the body is in.** Eleven
  controllers would be eleven things that could each be seated at once, all
  writing the same eye, and the last one to `step` would win.
- **`seatedBody.ts` is new**: the body's own dimensions and the two pose
  builders. `SEATED_EYE_ABOVE_SEAT` lived in `captainsDesk.ts` because the chair
  was the only seat aboard; copied into four modules it is the two-sources fault
  with the extra twist that a sitter 0.78 m tall in one room and 0.76 m in the
  next is a room that changes size when you walk into it.

## 22.3 A form is not a chair, and three things followed from it

1. **Both sitters take the middle of the *short* form.** The forms are 1.34 m
   and 0.97 m — the pump well took 0.37 m off the port one — so "the middle of
   the form" is two stations a third of a metre out of line, eating past one
   another's shoulders. The only station both forms share is the middle of the
   shorter, and the two places now face each other across the table.
2. **One station per form and not two.** A form seats two; two targets 0.6 m
   apart both fall inside the 50° aim cone from every standing position in the
   lane, so the player would be choosing between two identical prompts. The
   second place is where a crewman sits.
3. **You aim at the bench, not at the floor in front of it.** The chair does the
   opposite and `deskChairTarget` gives the reason — a chair is a scatter of
   19 mm legs under a 0.36 m board, and aiming at it is the fiddly-scuttle
   failure. A form is 1.34 × 0.28. The target is the seat and the sitter over
   it, sole to 0.60 m above the board, so a standing eye 0.6 m away meets it at
   45° down rather than 60°.

## 22.4 What "use a berth" means, and the seam that was left

**A pose and a view. Nothing else, and deliberately.**

Lying is `lyingPose`: the eye 0.16 m over the mattress, 0.26 m in from the head
board, aimed along the body toward the feet and pitched **40° up**. What a body
in a bunk looks at is the deckhead. 40° is not straight up — that is a
photograph of planking — it is up and along the bed, so the beams cross the top
of the frame and the room past your own feet crosses the bottom. The cone is
±80° of yaw and −5°/+75° of pitch: a head on a bolster, wide enough to roll into
the room over the lee board or against the ship's side, not wide enough to face
your own pillow.

In every berth aboard that lands the eye a few centimetres **above the lee
board** and well below whatever is over it, which is the geometry of lying in a
bunk: you can see out, and you cannot sit up.

**No time passes and no fatigue is modelled.** The verbs are "Turn in" and
"Turn out" rather than "Sleep" for that reason — nothing below decks makes time
pass, and a verb that promised it would be a promise the world cannot keep. The
provisioning and pacing work is unaccepted and that decision is theirs.

**The seam, stated so a future round does not have to look for it.**
`ShipStation.kind` is `'seat' | 'berth'`, and `kind === 'berth'` is the
predicate a time-skip attaches to. Seven rows already carry it, each with a
correct pose and a room; a round that wanted "sleep until dawn" adds an effect
to the berth rows and touches nothing else in this file. The two-clocks note in
`docs/` applies — a watch below is charged to the crew's clock, not the boat's.

## 22.5 Head aft, head forward, and why `lyingPose` takes them in that order

Six berths sleep head-forward and the captain's sleeps head-aft, each for a
reason written beside the bolster that draws it: the crew's is forward away from
the noise of the mess, the officers' is forward because the door is aft and a
man sleeps with his feet toward it, and the captain's is aft because the stern
lights are and because his bookshelf's underside is 0.51 m over the *foot* of
his mattress.

So `LyingIn` takes `zHead` first and `zFoot` second, and the head-end is stated
at each bed rather than assumed once. A builder that guessed would have been
right six times and put the captain's skull inside his own bookshelf the
seventh, with his feet on the pillow, and **nothing would have thrown.** There
is a test — "aims every lying body down its own bed" — that reads each berth's
own head and foot out of its placement and asserts the look direction agrees to
within 0.97 of a dot product.

## 22.6 The deadlights

**One closure for four shutters**, because they are shipped as a set when it
comes on to blow — that is what the word means — and because `CHANNEL_WINDOWS`
is one channel for all four panes. Four rows would be four verbs offering a
distinction the room cannot show.

- **`open` means the lights are open and the boards are stowed**, which is the
  same polarity as every other row, and she starts that way. A voyage that
  opened with the deadlights in would be a cabin with four boards over its
  windows in fair weather.
- **They stow in the stern lockers**, directly under the lights, which is what
  those lockers are for and why they are 0.48 m deep — so there is one drawn
  state and it is hidden when unshipped. The fore scuttle's soffit is the same
  one-state case and got there first.
- **`barrier: null`, the first closure aboard to use it.** A barrier is what a
  closure does underfoot and the table's invariant — shut is floor, open is a
  hole with footholds — is a sentence about a hole in a deck. Nobody walks
  through a stern light.
- **`ShipClosure.within` is new and only the deadlights fill it.** Every hatch
  leaves it out because a hatch is worked from either side of the deck it is cut
  in. A deadlight has one side. `REACH` alone happens to be enough here — the
  nearest a body can stand outside the cabin is 3.5 m from the transom — and
  that is exactly the argument `Interactable.within` was written to refuse: a
  distance can be wrong about a wall and a volume cannot.

They are **lofted, not fittings**, and that is this file's own third case: the
after wall rakes 18°, so a 0.55 m light is 0.18 m of station from sill to head,
and a plumb board across it would stand 90 mm proud at one edge and 90 mm inside
the planking at the other. `FittingSolid` has a yaw and no pitch.
`cabinJoinery.addSternDeadlights` draws them on the wall's own normal.

### The light gate, measured

One line in `Schooner.publishPortalLight`, the same shape as the hold's boards
and the fore scuttle's lid, placed before the wardroom-ambient sum for the
scuttle's documented ordering reason — which matters *more* here, because the
cabin's ambient genuinely does couple through its door into the landing.

Metered with `eyeLightMeterAt`, as a percentage of the daylight lost:

| | at the lights | mid cabin | at the desk |
|---|---|---|---|
| midday | 65 % | 21 % | 33 % |
| sun astern | 94 % | 69 % | 81 % |

**Two shapes of sky, because one of them understates it badly.** At noon the
stern lights carry 0.7 against the deck openings' 6.0 — they face away from the
sun and the cabin is lit mostly through its own door — so shipping the shutters
costs mid-cabin only a fifth. With the sun astern the same act takes seven
tenths. A test quoting only the first would let a cosmetic shutter through; one
quoting only the second would fail the day somebody re-tuned the noon sky. Both
are asserted. The wardroom does not move at all and the landing loses 2 %.

The shutters also **cast**, which is the other half of shipping one: the channel
is the sky's soft light through the opening, and the sun's own beam comes
through the same hole as a shadow-mapped directional. A deadlight that gated the
channel and not the beam would darken the cabin and leave four rectangles of
sunlight lying across the sole.

### Legible as shut, which is the contrast problem §21.11 could not solve

That section's sixth item: *"the officers' partitions are oak on oak in an unlit
room and I suspect they will not read"*. A shutter is the same problem with a
worse consequence — a state you cannot see is a state you cannot tell you are
in.

The answer is that **a deadlight is fitting timber, not lining**. Measured on
the two palette entries, the board is at 0.28 relative luminance against the
lining's 0.52 — a little over half — so it is a dark rectangle in a pale wall
rather than a slightly different pale one. On top of it go two **iron**
strongbacks across the grain (0.17) and a **brass** grip in the middle, which
`INTERIOR_FITTING_PALETTE` describes as the one thing below decks whose job is
to find what light there is and hand it back. Three values against the wall's
one, standing 0.050 m proud of the lining with real returns to catch the
lantern, and 0.034 m proud of the architrave round the opening. 160 triangles
for all four.

By day it is legible for a second reason needing no palette at all: the thing it
replaced was a hole with the sea in it.

**This is asserted, not judged.** The test compares palette luminances and
counts materials; whether it *looks* shut is §22.10's first item.

## 22.7 Three faults found by sweeping the pick, two of them older than this round

The station work needed a sweep of what the reach pick offers from where, and
the sweep found these. All three are fixed.

1. **The port sea chest faced the ship's side.** `xInboard` is `xLo` to port and
   `xHi` to starboard, so facing inboard is the frame's −x to port and +x to
   starboard, and the first cut had it the other way round: the sitter looked at
   the planking from 0.1 m. This is `washstand`'s inversion from the quarters
   round, in a pose instead of a piece of joinery. **Mine, and caught by a
   test that now fails on the flip.**
2. **The cabin lantern could be lit through a bulkhead.** `lampInteractables`
   has always said *"a hanging lamp is worked from the room it hangs in — there
   is no other side to reach it from"*, and never enforced it: the cabin's lamp
   hangs 1.86 m from a body standing just inside the landing, inside `REACH`.
   Every lamp row now carries `within: roomVolume(hang.room)`, which is the
   sentence the comment was already making. **Predates this round.**
3. **The fore scuttle could be opened from inside the surgeon's cabin.**
   `foreScuttleUnderBox` is `FORE_SCUTTLE_Z ± 0.45` and the scuttle stands
   0.40 m forward of the forecastle's after bulkhead, so 0.05 m of that box sat
   on the *wardroom* side of the wall — and a body anywhere in the surgeon's
   cabin was within a metre of it. Measured: from (−1.5, 1.4), looking forward,
   the offer was "Open the scuttle", through a bulkhead and a partition.
   **Predates this round, and it is only half fixed — see §22.11.**

## 22.8 Two more, in shared machinery

- **`ShipClosure.initiallyOpen` was dead and is deleted.** Nothing read it;
  `closures.INITIAL` is what `resetClosures` and a fresh voyage use. Two sources
  for one fact with one of them ornamental — and the deadlights are what would
  have made them disagree, being the first closure aboard that does *not* start
  shut. A round that set the ornamental copy and left the real one would have
  shipped a cabin that begins the voyage dark.
- **A fresh `SeatedStation` spent its first 0.55 s climbing out of the keel.**
  `step` returns early only when the body is up *and* the move is over, and
  `settle` started at 0 — so before anybody had sat down it ran the *rising*
  branch, easing the embodied eye out of `(0, 0, 0)` toward the body. Invisible
  in the orbit the game opens in; half a second of the eye coming up out of the
  ballast for anything that starts embodied. `settle` starts finished now.
- **`SeatedStation.step` asks for the pose inside the branch that uses it.** The
  rising branch never wanted it, and with the pose now being "whichever station
  the body is in" — which standing up clears — asking on the way *out* is a
  question with no answer.

## 22.9 What is gated, and how each gate was checked

`tests/ship-interior.test.ts`, "every station a body can take", keyed to
`SHIP_STATIONS` rather than to eleven named seats, so a twelfth is covered the
moment it exists. Per station: the eye is in its own room and inside the ship's
own side at its own station (**the frame is asserted, not commented**); there is
something over the eye and it is at least 0.30 m up, found by sweeping every
drawn solid rather than by asking the deckhead — a hand in a lower bunk has the
upper bunk's boards 0.46 m over him and the deckhead 1.56 m up is the wrong
number; the eye is inside no solid, fitting or bulkhead; and the station is
offered from its own approach and **never from another room**, swept over a grid
of standing eyes through all four spaces looking six ways from each.

Then, once each: every lying body is aimed down its own bed and pitched up;
every sitter has his table within half the embodied field and faces inboard;
the officers' berths cannot be reached from the wardroom floor outside their own
cabins (**a partition is a wall the reach pick has never heard of** — measured
before `within`: 0.75 m from a body with its back against his partition to the
surgeon's mattress, straight through the boards); and one body holds one station at a time, driven through the registry
because **Space cannot be tested with synthetic key events** and a previous
round found that out.

Each was checked by breaking the thing it guards. Flipping the chest's `facing`
fails the facing test with *"crewChestPort has its table 150° off the centre of
view"*; changing the captain's berth `within` to the landing fails the sweep
with *"captainsBerth offered from the landing at −1.8,−4.2"*; registering the
deadlight meshes on the wrong state list fails the visibility test.

The deadlights get five of their own, plus the metering in
`tests/interior-light.test.ts` and the mesh pair in
`tests/interior-light-runtime.test.ts`.

**Walked in the running app, on this branch's own dev server**, which is the
only part of this that is not arithmetic: every one of the eleven stations
answers from the spot the arrangement gives it, the mate's berth is *not*
offered from the middle of the wardroom, and standing at the transom — inside
the chart chair's own floor target — and aiming at the glass offers the
deadlights, ships them, shows all three shutter meshes and offers to unship
them. **An entered box outranks an occupied one, in the real app.**

## 22.10 What is owed to Ash's eye

I cannot certify how any of it looks or feels. In the order worth trying:

1. **A shipped deadlight, at night, with the cabin lamp lit.** This is the one
   thing in the round whose whole justification is a contrast argument, and
   §21.11 flagged the problem it is answering. `__drift.setLamps('on')`, wind
   the clock into the dark, stand at the transom and ship them. If it reads as
   "the windows have gone" rather than "a board is over each window", the answer
   is more brass or a lighter board, not more geometry.
2. **The same, at noon.** The daylight case should be obvious — a bright hole
   becomes timber and the room drops a third — and it is the case the metering
   says is weakest mid-cabin.
3. **Turning in.** Any bunk. The question is whether 40° up and 0.16 m over the
   mattress reads as lying down or as a camera in a box. The crew's upper berth
   is the best test: 0.80 m of deckhead over the eye, and you can see the whole
   forecastle past your own feet.
4. **The captain's berth specifically**, because it is the one that sleeps the
   other way round. You should wake looking *forward* down your own bed at the
   cabin door, with the stern lights behind your head where you cannot see them.
   If that reads as wrong, the fix is the bed's, not the pose's.
5. **Sitting at the mess.** Two forms facing each other across a 1.34 m table
   with the mainmast at its head; 15° down, a 100° cone. §21.11's item 4 called
   the table the best-looking derived dimension in that round and this is the
   view of it.
6. **The port sea chest at 1.09 m from the crew's table.** It is the seat §21's
   own text calls "the seat at" that table, and it is a long reach for a meal.
   The lever is the berths, not the chest.
7. **The verbs.** "Turn in" / "Turn out" against "Sit" / "Stand up". Period, and
   they deliberately do not promise sleep.

## 22.11 What I found and did not fix

- **The fore scuttle is still reachable from the surgeon's cabin.** §22.7's
  third item is half fixed: the box no longer *sits inside* the wardroom, but
  `REACH` is 2.2 m from the eye and a body 1.2 m abaft the bulkhead is still
  inside it. The clean fix does not exist in the current vocabulary —
  `Interactable.within` is a single box, and what this row needs is "the
  forecastle **or** the open deck", which is a union. `roomVolume('forecastle')`
  happens to contain a body standing on deck over it, but only because that box
  is 4 m tall, and a round that tightened `roomVolume` would silently break
  working the scuttle from on deck. **It wants a plural `within`, one per side,
  the way `boxes()` is already plural for the same reason.**
- **The wardroom's aft lantern stands between a body and the starboard form.**
  It hangs at x −0.924, z −0.900, over that lane. Measured over thirty standing
  positions along the lane, the bench is offered from twenty-five; at the five
  around z −1.2 the line of sight to the seat passes through the lamp and the
  lamp is what you are offered. That is the lantern being physically in the way
  — you step a pace along the form — and it is §21.2's *"the wardroom's forward
  lantern took the mate's cabin's width"* wearing a different hat. Both are the
  same underlying question: whether Ash's ray marks may move.
- **Standing in the mate's doorway puts your head inside the forward lantern's
  reach box.** Aiming at the bunk still wins — entered outranks occupied — but
  looking anywhere else in that doorway offers the lamp.
- **No station on the starboard sea chest.** It stands at z +2.62 → +3.47 with
  its inboard face at x −1.53, and the fore scuttle's ladder is spiked to the
  bulkhead at x −1.10 across z +2.83 → +3.15. A seated man's knees reach about
  0.25 m off the chest, which is 0.18 m *inside* the ladder. The port chest has
  a station and this one does not, and the asymmetry is measured rather than an
  oversight.
- **No station on the stern lockers.** `CAPTAINS_QUARTERS_HANDOVER.md` records
  Ash's call that you stand to look out of the stern lights, and that still
  governs. The lockers were built 0.48 m rather than 0.42 m so a seated eye
  would clear the sill by 17 mm, so the geometry is there if he changes his
  mind.
- **The seated look stops 0.4 mrad short of the pose it eases to.** The eye's
  *position* lands exactly — the final frame clamps `settle` and lerps at t = 1
  — but the look does not, because `isSettling` is false on that same frame and
  the clamp takes over from the ease. A fortieth of a degree; the fix is a
  change to how the settle ends, which is a feel change and not mine to make.
- **`OBSTACLE_COLUMNS` is unchanged by this round and still unmeasured.** §21.12
  flagged it; nothing here adds a collider — the deadlights are `collides:
  false` and no station publishes a standable surface — so the number it left is
  the number it still is. **No performance measurement was taken at all**: the
  machine is thermally throttled and Ash runs cold passes separately. What this
  round adds to the frame is three draw calls and 160 triangles, drawn only
  while the shutters are shipped.
- **The wardroom's after bay is still nearly a dead end**, §21.12's first item,
  0.68 m where a body needs 0.695. Unchanged and still true.

## 23. Second interaction audit after the gaze/reach/storey overhaul

The follow-up in `SHIP_ROUND_HANDOVER.md` §20.11 replaced the single room veto
with a reach volume on each target face. This pass audited the resulting player
surface as one registry rather than revisiting only the three reported views.
It supersedes §22.11's fore-scuttle item: the surgeon's-cabin leak is closed by
the per-face `reachableFrom` records now in production.

### 23.1 The target matrix

`tests/ship-interaction-selection.test.ts` names every row derived into the
production registry and fails when either table gains a row without a working
approach:

| kind | unique actions | target/state cases exercised |
|---|---:|---:|
| closures | 4 | 12 — every target face, open and shut |
| lamps | 5 | 5 |
| stations | 13 | 15 — eleven furniture faces and both shroud/mast pairs |
| **total** | **22** | **32** |

Every case builds the full competing registry. The look vector is aimed at the
authored target from a real standing approach, so the assertion proves the
looked-at reachable object wins rather than merely proving it exists in
isolation. Separate cases keep the two sides of the hold hatchway and fore
scuttle working in both states, aim from the mate's doorway and beneath the
forecastle lamp while the eye is already inside the lamp target, and reject
direct within-`REACH` looks from the wrong room or vertical storey.

### 23.2 Two metadata faults found and fixed

1. **The underside of each hatch was still an approach volume pretending to be
   a target.** `hatchwayUnderBox` and `foreScuttleUnderBox` were 1.4 m tall — the
   whole shaft a body occupies — even though `reachableFrom` now describes that
   approach independently. The hold regression landed the eye at the exact
   centre of that tall box; because occupancy is deliberately not gaze, looking
   straight up returned no action at all. Both underside targets are now thin
   0.16 m face slabs at the closure plane. The hold/forecastle volumes retain
   the approach, and both legitimate sides remain selectable open and shut.
2. **A room began half a metre below its own sole.** That tolerance belonged to
   a body/step query, not an eye volume. At `(1.0, 1.50, 1.4)` the eye was below
   the wardroom sole but admitted to the wardroom reach volume, and the forward
   lantern was 1.67 m away through intact planking. The lower tolerance is now
   0.03 m, symmetric with the deckhead tolerance. It keeps settling arithmetic
   harmless without annexing the storey underneath.

No priority exception was added to `Interactables.pick`. The exhaustive
standing-grid audit found no remaining reachable case in which occupancy beat
an exact entered target. The known places where one target wins a ray to
another are real sight-line occlusions — most notably the wardroom lamp in
front of part of the starboard form and one berth tier in front of the other
from the far side — and remain arrangement/visibility facts rather than picker
special cases.

### 23.3 Browser verdicts recorded during this audit

The coordinated live browser pass supplied three resolved visual/interaction
verdicts:

- **Captain's berth curtain:** the action is gaze-selected; activating it draws
  the opaque pleated curtain, changes the prompt to **Draw back**, and the cloth
  visibly screens the berth. Accepted.
- **Surgeon's berth complaint path:** from
  `stand = (-1.15, 1.5, 1.8)`, `look = (48°, -38°)`, the berth is visible and
  the prompt is **Turn in**, not the hatchway boards. Accepted.
- **Washstand basin:** from `stand = (0, -5.55, 2.45)`,
  `look = (35°, -30°)`, it reads as a hollow bowl with an inner wall and drain.
  Accepted.

These are visual verdicts, not claims made by the arithmetic suite. No separate
browser pass was needed for the code corrections above.

## 24. Player-action audit beyond the ship registry

The registry matrix in §23 is exhaustive for standing ship interactables, but
it is not the whole input surface. This follow-up traced every producer that can
put an object verb or prompt in front of a player, including the diagnostic raft
and the generic vessel/input runtime.

### 24.1 Inventory and classification

| path | player-facing kind | spatial contract |
|---|---|---|
| `currentActions` → `reachHit` | standing ship object | embodied gaze cone + `REACH` + target-side reach volume; §23 |
| captain's desk cursor | seated desk object | exact pointer ray + `REACH` + embodied `deskChair` station |
| raft mast tap | drift-sail object | projected mast hit + `REACH` from embodied eye |
| `climbWalkEntry` | deliberate locomotion into shrouds, no prompt | weather-deck reach volume + 0.45 m body distance + movement toward the gang |
| close an open desk page | nested state/back action | page must be open; no world object is selected |
| leave a seat, berth or climb | occupied-state/back action | the one occupied station owns the verb |
| R sail command, M mute, V view, movement keys | global controls | intentionally not object picks |
| Sailing/World/Deck panels, raft lab, globe and armed inspector | explicit UI/developer controls | screen controls or diagnostic capture, not player-world objects |

The production schooner's sails have no player object action outside the
registry: the sailing panels/crew command its real rig. The schooner viewer
retains global R because its diagnostic translation still consumes the legacy
drift-speed command, but it publishes no raft mast segment and now receives no
object-tap callback or touch hint. The diagnostic raft implements
`updateTrimPickTargets`, so it is the sole owner of the mast-tap affordance.

### 24.2 Two non-registry scope leaks fixed

1. **Every occupied station counted as the captain's desk.** The pointer gate
   asked only whether the shared `SeatedStation` was seated. After the
   multi-station overhaul that includes both forms, every berth and both
   climbs; switching to the exterior camera also left it live. A sufficiently
   aligned cursor ray could therefore open a desk object remotely, with no
   distance ceiling. It now requires all three facts — seated, the authoritative
   occupied station is `deskChair`, and the camera is embodied — and the strict
   ray is capped at the same 2.2 m eye reach as the standing picker.
2. **A mast tap was a screen hit without a body.** Projected size prevented a
   kilometre-away target but did not establish an embodied player or a reach
   distance. The tap now rejects cinematic mode and measures the camera eye to
   the live world-space mast segment before applying the existing pixel hit.
   That segment is clipped to the camera's visible near/far interval before it
   is projected, so looking down until the masthead passes behind the eye does
   not throw away a base that remains plainly on screen. R remains global and
   unchanged. Splitting `onTapSail` from
   `onToggleSail` also stops the schooner viewer advertising a physical target
   it does not have.

`tests/player-object-actions.test.ts` pins the captain's-desk station/mode
policy, strict ray and reach limit, plus the runtime raft-only callback wiring.
`tests/camera.test.ts` drives real pointer events against projected mast
segments: an aimed embodied tap inside reach works, an off-target or distant
tap does not, cinematic tapping does not, and R still works from cinematic
view. The existing `tests/ship-aloft.test.ts` walk-entry cases remain the proof
for both gangs, toward/away motion and the weather-deck level gate.
