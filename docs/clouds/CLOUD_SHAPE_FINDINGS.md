# Cloud shape — findings from a failed round

Written 2026-07-30 at the close of the Worley round, which **did not deliver a
visible improvement and whose code was thrown out at Ash's instruction.** This
file is the only thing kept from it.

It exists because the round did establish two facts about the architecture that
are expensive to rediscover, and because the next person to be told "make the
clouds better" will otherwise spend their time in the same place this round did:
somewhere the work cannot be seen.

Read this before touching cloud shape. `docs/clouds/CLOUDS_ROADMAP.md` still owns the
ordering and Ash's beauty-first mandate.

## What was asked, and what happened

Ash asked for Worley noise in the lump field — item 1 of `docs/clouds/CLOUDS_ROADMAP.md`,
described there as "the biggest single quality lever on form". It was
implemented correctly and it changed almost nothing that could be seen. Ash's
verdict across three attempts:

> "they all look the same to me, just with slightly different woodgrain
> textures. shape is identical."

and on the final version, after the silhouette work and a lighting pass:

> "before looks better. the 'after' shot just looks like the dark patches got
> darker. they have the exact same shape and layout, despite you telling me that
> this was primarily a form-only change."

Both readings were correct. The roadmap's claim that the lump field was the
biggest lever on form was wrong, and the reason is geometric.

## FACT 1 — a term multiplied by coverage cannot change a cloud's outline

`cloudDensity` returns:

```
max(cov * profile - erode * d * cov, 0)   ==   cov * max(profile - erode * d, 0)
```

Density is **exactly proportional to coverage**. So the outline of a cloud is a
contour of the smooth 2D fbm, and the 3D lump field only scales what is inside
that envelope. Worley, value noise, Musgrave billow — the silhouette is
identical and only the interior shading differs. Any noise-basis work done in
`cloudLumps` is invisible in outline by construction.

**Unscaling the erosion from coverage does not fix it**, and this was measured
rather than assumed: `sqrt(cov)` and `mix(0.5, 1.0, cov)` both left the outline
visually unchanged. The fringe where `cov < 1` is only `CLOUD_EDGE_SOFT` wide in
`over` — a handful of pixels on screen — so modulating inside it moves the edge
by less than a pixel. Weakening the coverage scaling just slides the same smooth
contour inward: a slightly smaller blob, not a lumpier one.

What *does* move an outline is perturbing the **2D field itself** by an amount
comparable to its own excursion range, which displaces the whole contour bodily.
Subtracting two zero-mean Worley octaves from `over` before the threshold did
produce genuinely scalloped, notched, holed outlines. It was not enough on its
own to satisfy Ash, because it changes the outline LOCALLY while the cloud
positions and overall layout — which come from the unchanged `cloudFbm` weather
map — stay exactly as they were. **A local edge perturbation does not read as a
different sky.**

## FACT 2 — the flat-slab projection maps screen-vertical to DISTANCE

`t = CLOUD_MID / dir.y` puts an entire column at one distance, and the march
walks `h` from 0 to 1 at that distance with a horizontal `span` fudge. So moving
one pixel up the screen changes `dir.y`, changes `t`, and lands on a **different,
nearer column**.

Screen-vertical therefore maps to distance, not to height within a cloud. **No
cloud can show its own vertical extent at any step count, with any density
field.** This is why the layer reads as a flat ceiling and why no amount of
shape or lighting work removes that.

### The true ray march was built, and reverted

A genuine ray/slab traverse — enter at `CLOUD_BASE`, exit at `CLOUD_TOP`, weather
map read at each sample's own position — is the correct architecture and does
produce real parallax. It was reverted because it exposes a deeper problem it
cannot fix alone:

**The density field is `cov(x, z) * profile(h)`, which is column-shaped by
construction.** Honest parallax faithfully draws columns as vertical curtains.
Every cloud became a tapering stalactite hanging from the deck. Correcting the
aspect ratio (shallower slab, wider cells) reduced it but never removed it,
because the field really is an extrusion — the parallax was not wrong, the field
was.

So: **the true march needs a genuinely 3D density field first.** The threshold
has to be applied to a 3D field, not to a 2D field multiplied by a height
profile. That is the next real piece of cloud work and it is larger than it
looks — it changes the weather-map/height-gradient split that the whole Nubis
architecture in this codebase is built on.

Things the attempt established that a future one will need:

- The traverse needs a length cap (~18 km). The geometric segment is
  `CLOUD_THICK/dir.y`: 13 km at 15 degrees of elevation, 38 km at 5. Beyond the
  cap a fixed step budget lands on unrelated columns and averages them into mush
  that boils as the field drifts.
- Step count has to reach roughly **64** before the step banding ("combing")
  stops being visible. At 28 it is obvious.

  > **Superseded 2026-08-16** by the correctness-and-truth round, which was sent
  > to find out whether the comb survived the cloud cache. It does not, and the
  > count is the wrong unit to have written down.
  >
  > What that measurement really established is a step LENGTH. It was taken per
  > screen pixel against this same ~18 km cap, so 64 steps is about **280 m** at
  > the threshold and 640 m where it was obvious. Today `CLOUD_MARCH_STEPS` is
  > **192** (`src/scene/Ocean.ts:363`) and `CLOUD_STEP_MAX` is 150 m
  > (`src/scene/shaders/lib.ts:1017`), so the longest step any ray can take is
  > `CLOUD_REACH / 192` = **88.5 m**.
  >
  > The count is not directly comparable, because the march now runs in the
  > direction cache rather than per screen pixel, and the cache carries ~17
  > texels per degree of azimuth against a screen resolving 30 or more — so any
  > angular structure the bake writes is magnified ~1.8x on the way out. Banding
  > IS angular structure (iso-`seg` shells are iso-elevation bands), so the
  > per-pixel threshold has to be divided by that magnification before the
  > shipped march is measured against it: ~156 m rather than 280 m. 88.5 m
  > clears it by 1.8x.
  >
  > Two things worth keeping from the same look:
  >
  > * **`CLOUD_STEP_MAX` no longer binds.** It becomes the binding constraint
  >   only below ~114 steps, which `?cloudMarch=` can still reach (its floor is
  >   8). At the shipped count every elevation is sampled at the divided rate.
  >   `Ocean.ts`'s own note that "below about twenty degrees the step length hits
  >   `CLOUD_STEP_MAX`" describes the 96-step world and is corrected there.
  > * **The woven hatching was a different artefact and it is gone at source.**
  >   The march-start IGN dither that caused it was retired outright in commit
  >   `35d866f` ("Delete the cirrus deck, march at 192, and retire the march
  >   dither"), which raised the count to pay for the removal honestly. That
  >   commit touched no documents, which is precisely why the diagnosis kept
  >   being restated as open. If a dither ever returns it must be TEMPORAL and
  >   paired with TAA.
  >
  > `tests/shader-source.test.ts` ("marches finely enough that the step comb
  > cannot come back") derives the bound from the shipped constants and pins the
  > absence of a start dither in both traverses. **Not measured:** no capture was
  > taken — the round ran on a loaded machine under an explicit no-GPU-work
  > instruction. This is a bound, not a photograph.
- Per-step optical depth must be normalised by the step **count**, not by `dh`,
  or the march's geometric length leaks into the layer's opacity and low rays
  turn into a white wall.
- Sparser coverage makes the curtain artefact **worse**, not better: isolated
  columns are more visibly column-shaped than a crowded deck.

## Measurements worth keeping

Recorded so a later round does not have to re-derive them.

**The 27-cell Worley search is not optional.** Over 200k samples the cheap
2x2x2 probe returns something other than the true nearest distance at **30.4 %**
of points, overestimating by up to 1.01 cells (p95 of the error, where it errs at
all, is 0.39). The errors land on cell boundaries — exactly where the field must
be continuous — so they show as hard facets rather than averaging out. The
escape hatch is a baked 3D volume, not a smaller search.

**Worley's aliasing risk was overstated in the roadmap, and backwards.** Peak
gradient of the normalised lump field: Worley 2.47 per cell (2.06 unwarped)
against the value noise it replaced at 3.06. A distance field has slope 1 nearly
everywhere; value noise has flat lobe tops and occasional steep walls. Worley's
*mean* gradient is 2x higher, so more of the image sits near the band limit, but
its worst case is lower. `stability()` confirmed it: 0.069/0.074/0.092/0.112
across the four matrix views against master's 0.068/0.073/0.090/0.108.

**Field distributions**, for anything that consumes them. Raw `worley3` F1: mean
0.519, p05 0.230, p50 0.523, p95 0.800, max 1.147. The two-octave composite
`1 - d` runs p05 0.20–0.27 to p95 0.70–0.77 depending on how much of the second
octave survives, mean 0.481. Normalising with lo 0.235 / gain 2.0 gives a field
whose mean (0.492) and clamped fractions (7.6 % at zero, 8.0 % at one) match the
old value-noise field's (0.502, 7.5 %, 8.2 %) — which is what made the basis swap
erosion-neutral.

**Erosion must be multiplicative, not a flat subtraction.** `shape - erode*d`
deletes the top of every cloud once the slab is deep, because the erosion ramp
reaches its maximum exactly where the profile is closing toward zero. The sky
comes out as flat shredded lily-pads. `shape * max(1 - erode*d, 0)` keeps the
carve commensurate with the local density, and the `max()` preserves the ability
to cut real holes, which is why subtraction was chosen originally.

**Cost, finally measurable indirectly.** `gl.finish()` still does not
synchronise, but the **adaptive-resolution policy is a usable proxy**: the
resolution it settles at reports GPU headroom.

> **A direct instrument now exists**, marked 2026-08-16 — `src/render/GpuProfiler.ts`,
> headless recipe in `docs/graphics/SHADOW_ROUND_HANDOVER.md`. The proxy below is
> still a good cheap signal and the figures still stand as a record, but a cost
> claim no longer has to be indirect. Note the step counts here are from the
> per-screen-pixel era; the march is 192 in the cache now. `CLOUD_MARCH` 8 held 77 % of
native; 16 fell to 39 %; 28 held native resolution at 60 FPS in a 1280x720
window at 2x DPR. That is the first real cost signal this project has had on
clouds, and it is free.

## Harness traps that cost real time

- **The agent browser reports `innerWidth` 0 at module-evaluation time**, so
  `isSmallScreen` in `main.ts` latched TRUE and handed the session MOBILE quality
  — a 5-step cloud march instead of 8, three fbm octaves instead of four — with
  nothing in the image to say so. An hour went into diagnosing a "basis problem"
  that was a 5-step march. **This was a real latent bug, not only a harness
  quirk**: any embedder that evaluates the module before first layout shipped the
  mobile ocean to a desktop for the whole session. **FIXED** in the motion round
  — `main.ts` reads through to `window.screen` when the viewport reports zero —
  and confirmed live, in a pane that does report zero. The habit is still worth
  keeping: **assert `window.__drift.sky.material.defines` before believing a
  cloud screenshot.**
- **The 2x2 canvas is the same trap wearing a different hat, and it silently
  invalidates the adaptive-resolution cost proxy below.** A pane that has not
  laid out gives a 2x2 drawing buffer, and the policy then reports "holding
  native DPR" while drawing four pixels. Check
  `renderer.domElement.width/height` before believing any cost reading.
- The renderer canvas can come back **2x2 pixels** after a navigate if the pane
  has not laid out. `renderer.setSize(1280, 720, false)` forces it.
- **Patch `material.fragmentShader` from the console** and set `needsUpdate` to
  A/B a constant — far faster than edit-and-reload, and it is how every sweep
  here was done. Write floats as floats: GLSL rejects `const float x = 2;` and a
  JS template literal writes `2.0` as `"2"`.
- **No backticks in GLSL comments.** They terminate the template literal. There
  is a test for it and it still caught me twice in one session.

## Method note

Judge cloud shape work at **the game's own field of view and default coverage**.
A 24-degree zoom into a thick cloud mass at raised coverage made interior changes
look dramatic twice in this round; at normal view the same changes were
invisible. Interior form is only visible on clouds large enough to have an
inside, and the default sky is small tufts.

And the harder lesson, which is why this document is the only survivor: an A/B
that needs explaining is not an improvement. If a change has to be pointed out,
it has not cleared the bar.
