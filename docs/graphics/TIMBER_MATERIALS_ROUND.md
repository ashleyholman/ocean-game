# The timber materials round

**Branch:** `claude/coord-materials`, off the integration branch.
**Switch:** `?timber=off|woods|grain|wear`. **Ships at `off`, and `off` is
byte-identical** — asserted, not asserted-ish: `tests/timber-finish.test.ts`
compiles a dressed material and an undressed one and requires the vertex and
fragment SOURCE STRINGS to be equal character for character, and the uniform
sets to match.

**How it started:** Ash, unprompted and more than once — *"the flat orange wood
is ugly."*

**Nothing here has been judged.** No claim below is about how the ship looks;
every one is a measurement, a piece of arithmetic, or a statement about what
was built. The verdict is §7.

---

## 0. What was asked for, and what was built

The round was scoped in four steps, cheapest first, each one possibly making the
next unnecessary.

| # | asked for | built? |
| --- | --- | --- |
| 1 | Re-derive the roughnesses under the light that actually exists now | **Measured. Answer: change nothing.** §2 |
| 2 | Differentiate the woods | **Built** — `?timber=woods`. §3 |
| 3 | Grain and tonal variation within a surface | **Built** — `?timber=grain`. §4 |
| 4 | Wear where wear happens | **Built** — `?timber=wear`. §5 |

Step 1 is the only part that is a **correction**. It produced no change to any
shipping number, and the reason it produced none is the most useful thing this
round found. Steps 2–4 are **taste**, entire, and are separated from step 1
below so the first can be taken and the rest refused — except that step 1 turns
out to *be* "take nothing", so what is actually on offer is: refuse the whole
round and keep one measurement, or take some tier of 2–4.

Two things were changed outside the switch and both are corrections. §6.

---

## 1. The complaint, in numbers

Both of Ash's words turned out to be measurable.

### "Orange" — seven woods, one hue

Every bare-timber surface on the ship, measured in sRGB HSL:

| surface | hex | hue° | sat | linear Y |
| --- | --- | --- | --- | --- |
| deck planking | `0x8d7a5c` | 36.7 | 0.210 | 0.2035 |
| companionway joinery | `0xa08258` | 35.0 | 0.290 | 0.2414 |
| cabin lining | `0xa08258` | 35.0 | 0.290 | 0.2414 |
| cabin sole | `0x6f5537` | 32.1 | 0.337 | 0.1015 |
| deck fittings (oak) | `0x6a5232` | 34.3 | 0.359 | 0.0933 |
| below-decks fittings (oak) | `0x5b452c` | 31.9 | 0.348 | 0.0666 |
| spars (pine) | `0xa88a5e` | 35.7 | 0.298 | 0.2731 |

**31.9° to 36.7°. Seven timbers inside 4.8 degrees of hue.** They differ in
lightness and in nothing else, which is what makes them read as one material at
seven exposures rather than as seven timbers. And they sit at saturation
0.21–0.36, which is a fresh-cut number: sea-weathered, scrubbed and
oiled-and-rained-on timber is a low-chroma material.

The cabin lining and the companionway joinery are **the same hex**, one for a
surface that has never been wet and one that is rained on — and they meet each
other at the companionway, which is the only place the identity is visible.

### "Flat" — every variation on this ship is a brightness scale

`jitter()` in `shipwright.ts` is the only variation any timber has ever had, and
it multiplies r, g and b by **one** factor. So no wood surface anywhere varies
in hue or in chroma, and none varies with position — the jitter is per plank,
per grid vertex or per solid, drawn from a seeded random and constant across
the piece. Swept across the whole vessel, exactly one surface in the ship has
spatially varying colour and it is the cabin floorcloth's walking track, which
is canvas.

A field of one hue at varying brightness is a flat sheet with uneven light on
it.

### And the deck is in the tone curve's shoulder

Measured over the ~99,000 deck pixels of one frozen frame (`--stand Waist
--look 140,-40`), in display levels of 255:

| sun | deck p05 | p50 | p95 |
| --- | --- | --- | --- |
| 12° | 45 | 75.3 | 109.1 |
| 30° | 125.8 | 183.5 | 197.7 |
| 60° | 134.8 | **214.5** | **217.4** |

The shoulder joins at 0.80 of display white — **204**. At 60° the top half of
the deck spans **three levels**. The ±10% plank jitter that is already authored
into the deck is arriving as one or two codes, because the deck is being
rendered nearly white. **Whatever is done to the timber, above about 50° of sun
the deck cannot carry variation at all.** That is an exposure finding, not a
material one, and it is not this round's to fix.

---

## 2. THE CORRECTION: the roughness was owed a re-derivation, and it says do nothing

### What was stale, and what was not

`Schooner.ts`'s `FINISH` table records the problem itself. The roughnesses were
chosen in the M1 round (`d984eaa`) when the ship carried her own hand-authored
sky probe at `ENV_INTENSITY = 0.3`; the world lighting round retired it for the
scene-wide probe at `envMapIntensity = 1`; **the ship has been reflecting the
sky at about 3.3× the strength every value in that table was fitted against.**

`dba7041` corrected the *painted exterior* by hand (+0.30, derived off a
percentile sweep) and named the four regions it deliberately did not touch:
*"Deck, inboard bulwark, bottom and glazing are untouched — they were never in
the reflection complaint."* **Two of those four are the timber Ash is
complaining about.**

Dated against the lighting rebuild (`3a42934`, 2026-08-02 15:36), the actually
stale set is smaller than it looks:

| table | authored | stale? |
| --- | --- | --- |
| `FINISH` painted exterior | `dba7041`, 18:39 | re-derived already |
| `FINISH` deck 0.94, inboardBulwark 0.85, belowWaterline 0.95, glazing 0.25 | `d984eaa`, day before | **STALE — never re-derived** |
| `FINISH` deckJoinery, interiorSole, interiorLining | 2026-08-09/10 | after the rebuild |
| `RIG_FINISH` | `ff5d9c8`, 22:33 same day | after the rebuild |
| `FITTING_FINISH`, `INTERIOR_FITTING_FINISH` | 2026-08-05 and later | after the rebuild |
| `shipPalettes.ts` overrides 0.38–0.58 | same round as the colours | **STALE — see §6** |

### The instrument

`tools/export-timber-finish.mjs`, new and committed. It is `dba7041`'s hand
measurement written down: name a region and a scene, and it masks the region's
pixels (one frame with the mesh, one without, the difference), then sweeps
roughness reporting p05/p50/p95/sd of the **environment specular term**, the
**direct specular term** (the sun's and the lantern's lobe), and the **finished
picture**, all over that one mask. Percentiles and not means, for the reason
`dba7041` gives — *"a mean cannot see a hot-spot and the mean is what said
'roughness does nothing' for an afternoon"*.

```
node tools/export-timber-finish.mjs --region deck --stand Waist --look 140,-40 --sun 30
```

### The measurement

**The deck** (`ship:deck`, 98,885 px, ships at 0.94):

| sun | roughness | env spec p95 | beauty p50 | beauty p95 |
| --- | --- | --- | --- | --- |
| 30° | 0.55 | 54.3 | 180.5 | 193.9 |
| 30° | 0.95 | 43.9 | 183.5 | 197.7 |
| 12° | 0.55 | 39.6 | 76.3 | 109.1 |
| 12° | 0.95 | 24.0 | 75.3 | 109.1 |
| 60° | 0.55 | 70.2 | 213.8 | 219.4 |
| 60° | 0.95 | 52.2 | 214.5 | 216.8 |

**The inboard bulwark** (38,483 px, ships at 0.85, sun 30°): beauty p50 moves
43.1 → 44.7 across 0.55 → 0.95.

**The cabin lining** (198,504 px, ships at 0.72, sun 3°, lamp lit): beauty p50
moves 27.6 → 28.0 across 0.45 → 0.95.

**Across three regions and four sun elevations, the entire plausible roughness
range moves the finished picture by at most 1.6 display levels of 255.**

### Why, and this is the part worth keeping

Two separate mechanisms, and both are structural rather than accidental.

1. **Outdoors, the lobe is already wider than the sky's own variation.** At
   0.55 the GGX reflection of a sky this smooth is already close to its cosine
   mean, which is what the diffuse term delivers anyway. The regions where
   roughness *did* bite were dark: at 3% albedo the specular is most of the
   pixel. The deck is 28% albedo, its diffuse term measures 121 against a
   specular of 30, and roughness moves ~20% of that 30 — 2% of the pixel.
2. **Below decks there is no environment specular at all.** Measured exactly
   zero on the lining at every roughness, and it is by design: the portal path
   scales `getIBLRadiance` by the baked sky visibility, which is 0 in an
   enclosed room. The only lobe left is the lantern's, and it measures p95 of
   about 5 levels across the whole wall and **does not respond to roughness**.

That second one contradicts a comment. `FINISH.interiorLining = 0.72` says *"a
lantern needs something to glance off or the room reads flat at exactly the hour
it is meant to be at its best"*. The glance is 5 levels at the 95th percentile
and 0.72 is not what decides it. Recorded in §8 as a finding, not fixed.

### The verdict on step 1

**No shipping roughness moves.** 0.94, 0.85, 0.95 and 0.25 stand — not because
they are right in some deep sense, but because **nothing distinguishable
depends on them**, which is a stronger reason than the one they had before
(which was "nobody complained about them").

And it redirects the round: **the flatness cannot be answered by finish.**
Everything that follows is a colour and variation change, which is to say
taste, which is to say Ash's.

---

## 3. TASTE, step 2: `?timber=woods` — six timbers, held at luminance

Each wood is authored as a **hue and a saturation**, and its HSL lightness is
*solved* by bisection so that its linear luminance matches the value it replaces.

| key | was | hue° | sat | becomes | Y error |
| --- | --- | --- | --- | --- | --- |
| `deckPlanking` — holystoned, salt-bleached | `0x8d7a5c` 36.7/0.21 | 43 | 0.14 | ~`0x857c66` | <1% |
| `weatherJoinery` — oiled oak, rained on | `0xa08258` 35.0/0.29 | 38 | 0.20 | ~`0x978465` | <1% |
| `cabinLining` — oiled oak, never wet | `0xa08258` 35.0/0.29 | 27 | 0.27 | ~`0xa6805f` | <1% |
| `cabinSole` — scrubbed deal | `0x6f5537` 32.1/0.34 | 41 | 0.21 | ~`0x635941` | <1% |
| `deckOak` — fittings on deck | `0x6a5232` 34.3/0.36 | 33 | 0.25 | ~`0x65533d` | <1% |
| `holdOak` — bare oak below | `0x5b452c` 31.9/0.35 | 26 | 0.19 | ~`0x55473a` | <1% |

Read the hue column down the page: **26, 27, 33, 38, 41, 43** where the
canonical column is 31.9–36.7. That spread is the change. Every wood also loses
chroma, and the cabin lining is deliberately left as the most saturated of the
six — `SHIP_SPEC` §9 says the cabin's whole point is that it reads warmer than
the exterior, and desaturating the ship without protecting that would answer the
complaint by taking the room's character with it.

### Why luminance is held, and why it is not a dodge

It keeps every quantity derived from these hexes valid: `interiorLight.ts` bakes
`SOLE_ALBEDO`, `LINING_ALBEDO` and `HOLD_ALBEDO` as **module-level constants**
off the canonical palette, the deadlight round's legibility argument is a
luminance ratio (0.28 against 0.52), and the portal bake is a reflectance model.
A hue move survives all of them; a brightness move would silently invalidate all
three. It also makes the A/B a question about colour rather than a brightness
change wearing colour's clothes. `tests/timber-finish.test.ts` asserts the
match to within 2%.

### How it is applied — one line per material, not thirty in the builders

Every ship material is built `vertexColors: true` and then has
`material.color.setScalar(1)` applied, so the vertex attribute decides the colour
and the material colour is a free multiplier sitting unused. `dressTimber`
writes a **per-channel ratio** into it — exactly the mechanism
`Schooner.applyPalette` already uses for the palette sheet, and for the reason
it gives: a ratio retints the timber while preserving its plank-to-plank
variation *as a proportion of it*.

---

## 4. TASTE, step 3: `?timber=grain` — variation within a surface

Fragment-stage, procedural, no assets, spliced into `WorldPbrMaterial` only when
a material asks for it.

**Keyed to the piece's own geometry.** Every mesh on this ship is built directly
in the vessel's frame with no per-mesh transform, so the `position` attribute
*is* the ship frame: it rides with her through every roll without a matrix.
Screen space would crawl, world space would slide, and there are no UVs —
`SurfaceBuilder` writes position, normal and colour and nothing else.

The board's own frame is then resolved at the fragment: the run axis is
fore-and-aft (all this ship's timber is laid that way), the across axis is
`cross(normal, run)`, and a face whose normal *is* the run axis — a transom, a
bulkhead, the end of a plank — swaps to the athwartships run, which is how those
are actually planked. That resolution is what lets one set of numbers work on a
deck, a wall and the underside of a beam.

Four terms, all authored per timber in `timberFinish.ts`:

- **board tone** — a hash per board index across the run. Zero on the deck,
  which is already built as planks carrying the ship's heaviest vertex jitter; a
  second board term at a different pitch would beat against the first.
- **figure** — two octaves of value noise, fine across the run (20–28 cycles a
  metre) and stretched down it (under one). The coarse octave is four times
  longer and is what stops a fifteen-metre run of lining reading as one texture
  tiled.
- **chroma** — a warm/cool tilt riding the figure with the *opposite* sign to
  brightness, because late wood is both darker and warmer. This is the term
  that answers "every variation on this ship is a brightness scale".
- **roughness** — the same figure on `roughnessFactor`. Given §2 this buys
  almost nothing and is kept because it costs one multiply-add and is correct.

---

## 5. TASTE, step 4: `?timber=wear` — six places, signed

Six sites, every one derived from a named constant rather than typed as a
coordinate: the cargo hatch, the head of the companionway, the companion ladder
below, the quarterdeck ladder (starboard — `DECK_STAIRS` stands on one hand),
the tiller, and the caprail abreast the hatch.

**The sites are signed and that is the model.** A deck round a hatchway is
scuffed by feet to pale bare fibre; a handrail and a tiller are burnished dark
by hands and take a sheen. One unsigned wear term would have to pick one and be
wrong about the other. Positive darkens by up to 16% and drops roughness 0.20;
negative does both the other way.

It compiles only at this tier: the loop is a per-fragment cost with a
compile-time site count, so `?timber=grain` is not paying for it.

---

## 6. Two corrections outside the switch

1. **`shipPalettes.ts`'s candidate roughnesses carry +0.30.** They were fitted
   against the same 0.3-strength probe, and `dba7041` left them alone as "a
   comparison set that was judged as it stands". That reasoning has expired: the
   shipping hull now renders at 0.78–0.92 and the candidates at 0.38–0.58, so
   the sheet these options exist to draw was comparing a candidate paint against
   the shipping paint with four tenths of roughness between them as well.
   Whatever such a sheet showed, none of it was attributable to the colour. The
   same derived delta is applied, preserving each option's authored
   relationships. **This is a fix to a measuring instrument, not a look change:
   no option here is on a code path a player reaches.** It does change what a
   palette sheet looks like, which is why it is written down loudly.
2. **`Schooner.applyPalette` no longer strips the timber tint.** It reset
   unoverridden regions to white, which would have wiped the respec off the
   deck, lining, sole and joinery the moment a palette sheet was rendered.

---

## 7. The A/B sheets, and which of them may be believed

`?timber=` is a **page-load** switch in both halves — `woods` is read while the
vessel's materials are built, and `grain` changes shader source, which three's
program cache is not keyed on. So every sheet is one page per arm, and the
**cross-page control** is what says whether anything on it is attributable to
the switch. Registered in `src/debug/abSwitches.ts`, read back live by
`getTimberMode()`.

| sheet | scene | arms differ by | two pages at the SAME arm differ by | believable? |
| --- | --- | --- | --- | --- |
| `evidence/ab/timber-deck-low-sun` | Waist, 14° sun, down the deck | mean **3.00**/255, 38% of pixels | mean **0.0001**, 0.005% | **yes** — clears by ~30,000× |
| `evidence/ab/timber-wardroom` | Wardroom, unlit, 30° sun | mean **2.90**/255, 99% of pixels | mean **0.0115**, 1.1% | **yes** — clears by ~250× |
| `evidence/ab/timber-cabin-daylight` | Cabin, 28° sun, stern lights and lamp | mean **2.12**/255, 78% of pixels | mean **0.0587**, 4.7% | **yes** — clears by ~36× |
| `evidence/ab/timber-grain-diff` | Hatch, 32° sun, ×6 difference panel | — | not measured | diagnostic: shows WHERE the grain lands |
| `evidence/ab/timber-cabin-dusk-NOT-AN-AB` | Cabin, 2–8° sun, lamp lit | mean 2.01 | mean **2.98** | **NO — it FAILED its own control** |

Each directory holds the four arm frames, the composed sheet and a manifest with
the numbers.

### The cabin by lamplight cannot currently be A/B'd, and that is a finding

At 2° and again at 8° of sun, **two pages staged identically at the same arm
differ by more than the four arms differ from each other** — mean 2.98 against
2.01, on 94% of pixels. The tool failed it and refused to endorse it, which is
exactly what it is for. The cause is not the timber: at dusk the interior lamp
latch and the eye-adaptation meter are near their thresholds, and two page loads
land in different states. The dusk frames are kept, renamed so nobody mistakes
them for evidence.

**So: the cabin at dusk is the one scene the round most wanted and the one it
cannot show.** `timber-cabin-daylight` stands in for it — 28° sun, the stern
lights doing the work with the lamp still lit, and it clears its floor 36× — but
the dusk room is where the lantern is the only light, and that condition is
currently unphotographable as an A/B. Judge it by walking her.

### The determinism contract fails on deck, on the `off` arm

`verify` on the deck scene: *"same stage, re-shot: 0.406% of pixels, max
**2**/255"*, against a contract of ≤1. The same check in the wardroom passes at
max 1. It is the `off` arm — byte-identical to what shipped — so it is not this
round's, but something in a deck view with the rig in frame is not frozen by
`stage`. The M6 cloth's flogging clock is the obvious suspect. §8.

### What to look at to decide

1. **`timber-wardroom`** first — it is the strongest of the sheets and it is the
   room where the change is largest. `off` is one orange-brown box; watch the
   sole separate from the walls in `woods`, and the planks appear in `grain`.
2. **`timber-deck-low-sun`** — the deck goes from tan to a grey-buff. **This is
   the single dial most likely to want moving**: `deckPlanking.saturation`, now
   0.14 from 0.21. Raise it toward 0.18 if the deck reads as concrete; the
   luminance solver will re-fit the lightness on its own.
3. **`timber-grain-diff`** — the ×6 difference panel is the only place the grain
   is unambiguous. In the beauty frames it is deliberately subtle, and on the
   sunlit deck it is subtle *because the deck is at 214/255* (§1).
4. Then walk her: `npm run dev`, then `?timber=wear` against a plain reload.

---

## 8. Found, not fixed

1. **`interior:boards:*` and `interior:scuttleSoffit` are built wrong.** Both are
   constructed with `color: SHIP_PALETTE.base.interiorLining` and
   `roughness: FINISH.interiorLining.roughness`, and both comments say the piece
   takes the lining's timber. But the material colour is destroyed by
   `setScalar(1)` on the next line and the vertex attribute was filled from
   `INTERIOR_FITTING_PALETTE.timber`. **They render as fitting oak carrying the
   lining's finish** — a pairing that exists nowhere else aboard and that the
   comments say is not what was wanted. This round tints them as what they
   actually are rather than silently "fixing" a bug inside a look change.
2. **The interior roughnesses cannot do the job their comments claim.** §2: the
   environment specular term is identically zero below decks, and the lantern's
   lobe does not respond to roughness. `FINISH.interiorLining`'s reasoning is
   about a term that is not there.
3. **The deck sits in the tone curve's shoulder above ~50° of sun**, at 214/255
   with three levels between p50 and p95, and crushes the variation already
   authored into it. Exposure, not material.
4. **The ab-sheet determinism contract fails by one level on a deck view**, on
   the shipping arm. Suspect the M6 cloth clock (§7).
5. **The cabin at dusk is not reproducible across page loads** (§7) — the lamp
   latch and the adaptation meter. This blocks A/B evidence for the one room
   whose whole design is about lamplight.
6. **The spars share the complaint exactly** — pine at hue 35.7, saturation
   0.298 — and are untouched because another round holds the rig. `RIG_PALETTE`
   is one line away from joining the respec, and `windCueGeometry.ts:80`
   duplicates the spar's hex as a literal rather than importing it.
7. **The painted hull is untouched on purpose.** Topsides, wales, transom, boot
   top, trim and the inboard bulwark are a verdict Ash took under the current
   display transform (`962aec8`), after one that had already reversed. Moving it
   inside a timber round would be the third time that palette was changed by
   somebody who was looking at something else.
8. **`jitter()` is achromatic everywhere, including the rig, the cues and the
   sails.** The grain tier fixes it for six timbers in the fragment stage; the
   underlying helper still varies brightness only.

---

## 9. Performance — NOT MEASURED, and what a cold pass owes

**No performance measurement was taken.** The machine was thermally throttled
and the round was forbidden to benchmark. The grain is not free and the numbers
below are the ones a cold pass has to produce, per frame, at desktop tier:

- **`?timber=grain` against `?timber=off`.** The cost is per fragment on six
  materials: two `worldTimberNoise` evaluations, each eight hash calls, each
  three `fract` and a handful of multiplies — call it ~50 ALU on every timber
  pixel, plus two extra varyings interpolated. The worst frame is one where the
  deck fills the view (stand at the Hatch looking down); the cheapest is open
  water. Measure both.
- **`?timber=wear` against `?timber=grain`.** Adds a six-iteration loop with a
  `distance` and a `smoothstep` each — about 40 ALU more on the same pixels.
  The loop count is a compile-time define, so this is the cost of the *tier*,
  not of the round.
- **`?timber=woods` against `?timber=off` should be exactly zero** — it moves
  one uniform. If it is not zero, the measurement is wrong.
- **Program count.** Each tier splits three's program cache by define, so a
  session at `grain` compiles up to six more programs than `off`. Check first-
  frame hitching after a hard reload, not steady state.

Use the headless harness with `--enable-gpu --use-angle=metal` and paired
interleaved blocks (`docs/graphics/`'s benchmark note). A visible window costs
about 3× and no comparison may mix the two.

---

## 10. Files

| file | what |
| --- | --- |
| `src/vessel/schooner/timberFinish.ts` | the whole policy: modes, the six timbers, the luminance solver, the wear sites |
| `src/scene/WorldPbrMaterial.ts` | the grain: GLSL, the splice, `applyTimberGrain`, the anchor assertion |
| `src/vessel/schooner/Schooner.ts` | eight `setScalar(1)` call sites become `dressTimber`; `applyPalette` composes |
| `src/runtime/RuntimeOptions.ts`, `src/main.ts` | `?timber=`, applied before the vessel is built |
| `src/debug/abSwitches.ts` | the switch, with a live read-back |
| `src/vessel/schooner/shipPalettes.ts` | §6.1, the +0.30 correction |
| `tools/export-timber-finish.mjs` | the roughness instrument (§2) |
| `tests/timber-finish.test.ts` | 20 assertions, including byte-identity at `off` |
