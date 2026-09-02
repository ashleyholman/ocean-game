# Cloud structure — handover for a dedicated round

Written 2026-07-30 at the close of the cloud-volume work, at Ash's request:

> "They all appear to be at the same altitude. Isn't there different types of
> clouds that are formed at different altitudes and different sizes? ... if
> there's some obvious things you can do, and this is all laying a foundation
> for weather system to use for cloud layers and things, then I think we should
> do it. But if it's a large scope, I'd rather you document it in a handover,
> and then I could start a new session on the cloud structure kind of thing."

It is a large scope. This is the design document for that session;
**`docs/clouds/CLOUDS_ROADMAP.md` is the authority on ordering** and carries Ash's
beauty-first mandate. If the two disagree, the roadmap wins.

> **The DECK half of this document has been built.** The cirrus layer, the
> layer-stack composite and the cloud clock that moves both decks landed in the
> motion round — see `docs/clouds/CLOUD_MOTION_REPORT.md`, which also records the three
> places the design below turned out to be wrong (the anisotropy must be split
> between envelope and filament; the filament field must be windowed to zero;
> the Nyquist fade must be per axis). The TYPE half, section 1 below, is still
> open, and the report's section 7 revises its expected payoff downward.

## What already landed, so the round does not redo it

The layer is now a genuine volumetric field, marched. Read
`docs/graphics/GRAPHICS_ROUND_HANDOVER.md` ("CLOUD VOLUME") for the full account; the parts
that matter architecturally:

- **`cloudDensity(wp, h, cov, tower, erode, oct2)`** in `shaders/lib.ts` is the
  density hook. It takes a *world position and a normalised height*, which is
  the signature a multi-layer system wants.
- **The 2D field is a weather map, read once per pixel** (`cloudCoverAt`, `cell`,
  `puff` -> `cov` and `tower`). This is the Nubis split, and it is the seam a
  cloud-TYPE channel plugs into.
- **`cloudProfile(h, tower)`** is already a per-column height-gradient function.
  Per-*type* gradients are a generalisation of this one function, not a rewrite.
- **`CLOUD_MARCH`** is an `OceanQuality` field compiled into both the dome and
  the ocean, so per-layer step budgets have a precedent to follow.
- Everything is mirrored in `TimeOfDay.ts` and the mirror is enforced by
  `tests/shader-source.test.ts`. **Any new constant must go in both files and
  into that test**, or the scene is lit by clouds that are not on screen.

One "obvious thing" was taken rather than deferred, because it answers the
*sizes* half of Ash's question for a handful of lines:
`CLOUD_REGION_SCALE`/`CLOUD_REGION_SWING` modulate the coverage THRESHOLD with
a very low-frequency field, so the sky has crowded deep regions, lanes of small
tufts and open holes instead of one uniform cloud size. Threshold modulation
gets size *and* depth variety at once, because the threshold sets both coverage
and column height.

## What the round is for

Real cloud altitude is a three-deck system, and the eye knows it:

| deck | altitude | types | character |
|---|---|---|---|
| low | 0–2 km | cumulus, stratocumulus, stratus | convective lumps, flat bases, opaque |
| mid | 2–7 km | altocumulus, altostratus | dappled rows, thinner, greyer |
| high | 5–13 km | cirrus, cirrostratus, cirrocumulus | ice, fibrous streaks, translucent, no billows |

The current system is one low deck, 1100–3300 m. That is why the sky reads as
one altitude: it *is* one altitude.

## Recommended architecture

**Two mechanisms, and they are not interchangeable — this is the main design
point of the round.**

### 1. Cloud TYPE within a deck — a weather-map channel

This is how Nubis does stratus/cumulus/cumulonimbus, and it needs no second
march. Add a type channel to the weather map (a second low-frequency 2D field,
or reuse the region field), and make `cloudProfile` interpolate between height
gradients:

- stratus: density low in the slab, flat, wide, near-uniform
- cumulus: the present curve — flat base, dome closing by `cloudTop(tower)`
- cumulonimbus: fills the slab, anvil flare near the top

Cheap, big payoff, and it is the foundation the weather round wants: a weather
state maps to (coverage, type, precipitation) per region and everything else
follows. **Do this first.** It may be most of what Ash is asking for, because
type variety within one deck reads as variety of altitude to the eye.

### 2. Genuinely different DECKS — a layer stack

One slab cannot span 1–13 km: eight march steps over 12 km resolves nothing,
and the lighting and parallax of cirrus and cumulus have nothing in common.
So a second (and optionally third) layer, composited.

Composite order matters and is easy to get backwards: for an upward view ray
the LOW deck is nearest the camera, so it composites *over* the high deck.
Premultiplied throughout (`cloudLayer` already returns premultiplied), so it is
`result = high; result = low.rgb + result * (1 - low.a)`.

**The high deck should NOT be marched.** Cirrus is a sheet a few hundred metres
thick — a single sample through it is not an approximation, it is the correct
model, and it is what keeps the second layer nearly free. It needs:

- its own slab constants (say 8000–8600 m) and its own `CLOUD_SCALE`, much
  larger cells: cirrus streaks run tens of kilometres
- a **different field**: strongly anisotropic (stretch the domain 4–8x along
  the upper wind) to get fibrous streaks rather than lumps. The existing
  `cloudFbm` with a scaled/rotated domain is enough; no 3D field needed.
- **different lighting**: ice, not water. Very strong forward scatter (cirrus
  goes incandescent within ~20 degrees of the sun), near-white, essentially no
  self-shadowing, and low optical depth so the blue shows through everywhere.
  Do NOT reuse the cumulus multiple-scattering octaves — the whole point of
  those is thick cloud, and cirrus is the opposite regime.
- its own Nyquist fade. It is higher, so `t` is larger at a given elevation and
  the projection compresses harder near the horizon. Expect to retune.

A mid deck (altocumulus) is the least valuable of the three; skip it unless
the weather round wants an overcast state.

## Traps, all of them paid for already

- **A 2D field translated with height is not a 3D field.** It is a sheared
  extrusion, every march step draws the same silhouette offset, and the result
  is visibly stacked cut-outs. This exact mistake shipped for one session here.
- **Do not use `abs(2v - 1)` (Musgrave's billow) as a shape basis at high
  contrast.** It folds the field about its mean and lays concentric rings —
  procedural marble — around every extremum, plus thin dark seams along the
  fold's zero set that a domain warp cannot remove. See the Worley item in
  `docs/graphics/GRAPHICS_TODO.md`.
- **Measure a noise basis's distribution before tuning anything that consumes
  it.** Value noise clusters hard around its mean; `abs()` of it clusters near
  zero. A field used outside its measured p05..p95 acts as a near-constant
  offset and looks completely inert while quietly changing the image.
- **An erosion term must be commensurate with what it erodes**, and must be
  scaled by coverage or it eats the soft silhouette fringe and leaves a hard
  matte — the "cut out and pasted on another photo" look, measured at 22 px of
  ramp before the fix.
- **Perf cannot be measured in the agent browser.** `gl.finish()` does not
  synchronise; a cloudless dome "measured" 18 ms. Any cost claim needs Ash's
  hardware or the timer-query instrumentation described in `docs/clouds/CLOUDS_ROADMAP.md`.
  > **The instrument was built.** Marked 2026-08-16. `src/render/GpuProfiler.ts`
  > (`EXT_disjoint_timer_query_webgl2`, disjoint honoured, per-pass prefix
  > rotation) measures GPU time properly, driven headlessly per the recipe in
  > `docs/graphics/SHADOW_ROUND_HANDOVER.md` — headless Chrome with
  > `--enable-gpu --use-angle=metal`, paired interleaved blocks. `gl.finish()`
  > is still useless; "cannot be measured" no longer follows from that. What is
  > owed is a quiet machine, not a tool.
  **This is NOT a reason to prefer cheaper designs.** An earlier draft of this
  line said to "prefer designs that are cheap by construction over designs that
  need profiling to justify", and Ash has overruled that: build for looks, and
  let a later performance round decide what to trade back. Where a design is
  *both* cheaper and more correct — an unmarched cirrus deck, because cirrus
  really is a thin sheet — take it for the correctness, not the cost.
- **GLSL has no hoisting and the TypeScript mirror does.** A constant declared
  after its use passes `tsc` and the whole suite and renders a black screen.
  There is a declaration-order guard in `tests/shader-source.test.ts`.
- **No backticks in GLSL comments.** They terminate the template literal. Also
  guarded by a test; still caught me twice.

## Tooling

`tools/cloud-evidence.js` — load against a running dev server:

```
node tools/capture-server.mjs evidence/clouds 5205
```

then in the console at `?capturePort=5205`:

```js
const cl = await import('/tools/cloud-evidence.js');
const h = await cl.install();
h.hold();                       // stop the render loop so the canvas holds a view
h.setSolar(16.5);               // local apparent solar hours
h.show(0, 14, 55);              // azimuth FROM THE SUN, elevation, fov
await h.shot('name.jpg');       // POST to the capture server
h.stability();                  // rms display levels per frame of cloud drift
h.edgeProfile(0.5);             // ramp width and saturation across each edge
```

It aims relative to the SUN rather than a compass, so an A/B compares the same
lighting geometry rather than the same bearing, and it pins the drift offset so
before/after look at the same clouds.

Two traps in the harness itself: the Browser pane must be VISIBLE or rAF is
throttled and the canvas never sizes past 1x1; and pick a free capture port —
5199/5200/5201/5202 are all held by servers from earlier worktree sessions, and
POSTing to a stale one silently writes into another worktree's evidence
directory.

## Reference

- Nubis (Guerrilla): `guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine`
  — the weather-map + height-gradient + 3D-noise architecture everything else
  descends from. `nubis-cubed` is the 2023 evolution to true voxels.
- Toft, Bowles & Zimmermann 2016, `arxiv.org/pdf/1609.05344` — step counts,
  jitter, TAA, and the analytic step integration. Has real timings.
- Hillaire 2016 (Frostbite) — the multiple-scattering octave approximation the
  current lighting uses.
- `jpgrenier.org/clouds.html` — a practical implementation with a weather
  texture, curl noise and temporal reconstruction.
