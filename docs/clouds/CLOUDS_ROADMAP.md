# Clouds — roadmap

The ordered plan for the cloud system: what to build, in what order, and why.
Design detail for the big structural items lives in
`docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`; this file owns the ORDER and the MANDATE.

## THE MANDATE — read this before deferring anything on cost

Ash, 2026-07-30, closing the cloud-volume work:

> "i was actually thinking, just build everything to look as good as possible,
> then once i'm happy, i can do a focused performance round — we might be able
> to find performance wins, cos we haven't really done much hardcore performance
> work yet since we did a lot of rendering changes. my task for you was really
> just to produce beautiful clouds."

> "right now i'm not going to stress about the technical challenge of
> performance optimisation if i'm not even happy with the scene. i want
> beautiful looking stuff, then i can worry about what i can keep to preserve
> perf."

**Make it beautiful. Then Ash decides what to keep.** Performance is a separate,
later round, and no cloud work should be shaped by it.

Concretely, for a session picking this up:

- **Do not open by building performance machinery.** Not the instrumentation
  below, not a budget, not an optimisation. Open by making the clouds look
  better.
- **Do not defer a visual improvement because it might be expensive.** Build the
  good-looking version, write down what it probably costs, and move on. "Might
  cost 2×" is not a reason to ship the worse-looking option.
- **Do not silently pick the cheap variant of a technique.** If there is a
  cheap-and-worse and a dear-and-better form, take the better one and note the
  fork. The perf round can trade back later; it cannot un-ship a compromise
  nobody recorded.

This mandate exists because I got it wrong. Two pieces of my own over-caution
are in the repo and are hereby **superseded**:

- the "gated on profiling" framing on the Worley item in `docs/graphics/GRAPHICS_TODO.md`, and
- the "prefer designs that are cheap by construction" line in
  `docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`.

Both were written because I could not measure GPU cost, and I therefore declined
to spend it. The cost was *unknown*, not known-bad, and what I declined was the
largest available quality win. Wrong trade.

Two caveats, which are not licence to be reckless:

- **Do not regress correctness for looks.** Sky/sea agreement, the CPU-mirror
  parity (enforced by `tests/shader-source.test.ts`), and the band-limiting that
  stops the layer aliasing are all load bearing. The aliasing hunt cost a whole
  round; do not undo it. `stability()` in `tools/cloud-evidence.js` is the check.
- **Keep expensive things behind an existing quality lever** (`CLOUD_MARCH`,
  `OceanQuality`), so the perf round has knobs to turn rather than code to
  rewrite. This is cheap to do while building and expensive to retrofit.

## Where it stands now

The layer is a marched volumetric field: a 2D weather map (coverage + column
height, sampled once per pixel), a 3D lump field eroded out of a per-column
height profile, a bottom-to-top view march with multiple-scattering octaves,
per-cloud sun geometry, and regional threshold modulation for size variety.
Clouds sit at 1100–3300 m and are roughly 1:1 in aspect.

**The clouds now move and evolve, and there is a second deck.** That round is
written up in `docs/clouds/CLOUD_MOTION_REPORT.md`; the short version, because it changes
what the remaining items mean:

- The field runs on a **cloud clock** integrated from canonical world time, so
  it stops with a paused world, drifts with a running one and fast-forwards
  under the time slider. It is not a frame-delta integration any more.
- The weather-map fbm has a **third noise axis**, so silhouettes are born,
  deform and dissolve rather than only translating. Octave rates double with
  frequency: tufts boil, the sky's organisation drifts.
- A **cirrus deck at 8.4 km**, unmarched, anisotropic, ice-lit — roadmap item 3,
  taken early because a second deck is what makes "moving" read as depth. It
  rides a stronger, more veered wind than the low deck.

Visual gaps, in the order this roadmap takes them: bland lump shape (1), one
cloud type per deck (2), polite sunward silhouettes (4). Item 3 is done.

## 1. Worley for the lump field — the biggest single quality lever on form

> **This item is wrong, and it was tried. Read `docs/clouds/CLOUD_SHAPE_FINDINGS.md` first.**
> Worley was implemented correctly and changed almost nothing visible, because
> density is exactly proportional to coverage — so the lump field cannot move a
> cloud's outline at all, whatever basis it uses. The round was thrown out. The
> findings document has the algebra, the measurements, and what the actual next
> piece of work is (a genuinely 3D density field, not a 2D one times a height
> profile).

Cloud *shape* is the most artificial thing left. The current `cloudLumps` is a
domain-warped fbm of value noise: its lobes are soft, rounded and bland. Worley
— distance to the nearest scattered feature point — gives convex caps with
creases at cell boundaries, which is cumulus cauliflower by construction. It is
what Nubis and essentially every shipped volumetric cloud since uses.

**Do not reach for `abs(2v - 1)` (Musgrave's billow) to get creases instead.**
It was tried here for two passes and abandoned: `abs()` folds the field about
its mean, laying concentric rings around every extremum — procedural marble, and
Ash reported it as exactly that. A domain warp sheared the rings apart and left
thin dark seams, because where the fold hits zero the erosion peaks along a
curve and no warping removes a zero. Creases must come from cell boundaries, not
from a fold.

**The fork — a design decision, not merely a cost one.**

- **(a) Evaluate analytically.** A correct 3D Worley octave searches the 3×3×3 =
  27 neighbouring cells (a feature point jittered inside its own cell can be the
  nearest one from a cell away on each axis). Against `vnoise3`'s 8 lookups,
  inside a loop that runs `CLOUD_MARCH` times per pixel, that is roughly double
  the lump field's cost. Keeps the codebase's deliberately texture-free noise
  philosophy and keeps the CPU mirror straightforward. Cheap 8-probe variants
  exist but can miss the true nearest point, which shows as cell-boundary
  discontinuities — check any such variant against `stability()`.
- **(b) Bake it into a 3D texture.** What Nubis actually does: a 128³ RGBA volume
  plus a 32³ detail volume, generated offline, so at runtime it is a texture
  fetch rather than 27 hashes. Much cheaper at runtime and the industry norm. It
  breaks the analytic-noise principle, adds generation machinery and an asset,
  and makes the CPU mirror awkward — `TimeOfDay.ts` would need the same volume in
  memory or an analytic approximation of it, and the parity test exists precisely
  because those drifting apart is silent.

**Take (a).** It is the better-looking-per-unit-risk option, it keeps the mirror
honest, and it needs no new machinery. Under the mandate, do not pre-emptively
choose (b) on cost grounds — (b) is the perf round's escape hatch, not this
round's starting point.

**Scope:** medium. **Risk:** aliasing — Worley carries more high-frequency
content than value noise, so it needs the same Nyquist fade treatment as the
existing lump and puff terms.

## 2. Cloud TYPE within a deck — most compositional payoff per line

Ash: *"Isn't there different types of clouds that are formed at different
altitudes and different sizes?"* Yes — and **type variety within one deck reads
as altitude variety to the eye**, which is why this sits ahead of item 3 even
though item 3 is the literal answer.

Add a type channel to the weather map and let `cloudProfile` interpolate between
per-type height gradients: stratus (low, flat, wide), cumulus (the present
curve), cumulonimbus (fills the slab, anvil near the top). No second march, no
layer stack, and it is exactly the hook the weather round wants — a weather state
maps to (coverage, type, precipitation) per region and the rest follows.

**Scope:** small-to-medium. **Risk:** low. Design in
`docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`.

## 3. ~~Multi-altitude decks — a cirrus layer above the cumulus~~ — DONE, THEN DELETED

<!-- Corrected 2026-08-17 (WX1). The cirrus deck was built and then removed in
commit 35d866f (2026-07-31) on look — "smeared pale bands rather than fibres" —
and no `CIRRUS_*` constant survives in the shaders. There is one deck. Marking
this DONE has already misled one specification: a high deck for weather is a
build, not a re-use. What survives is the recipe, in
`CLOUD_STRUCTURE_HANDOVER.md` and the three corrections in
`CLOUD_MOTION_REPORT.md`, and the reason it was cut was never cost. -->

Landed in the motion round; see `docs/clouds/CLOUD_MOTION_REPORT.md`. Built as designed —
unmarched sheet at 8400 m, anisotropic field, ice optics, low deck composited
over it — with three things the design did not anticipate, all of them recorded
in the report:

- The anisotropy has to be **split**: a mildly stretched envelope carrying a
  heavily stretched filament field. All the stretch in the envelope gives
  straight-edged bands a hundred kilometres long.
- The filament field needs a **hard window** (`CIRRUS_COMB`), not just a
  multiply, or the deck is a veil with ripples rather than fibres with sky
  between them.
- The Nyquist fade has to be **per axis**. The roadmap's warning that its
  Nyquist behaviour would differ was right, and understated: one isotropic
  figure against a 7:1 field either retires the deck while it is still resolved
  or lets the comb alias into ruled dashes. It did the latter, on the first
  sunset.

A mid deck (altocumulus) remains unbuilt and remains the least valuable of the
three.

## 4. Fire — low-sun silhouette and blaze

Carried from the graphics round. The mechanism is in place and measures right (a
thin edge scatters ~17× a core head-on at `mu ≈ 1`) but the balance is polite: a
low sun behind a thick core should read much darker, and the rim much brighter.
Levers are `CLOUD_SUN_GAIN`, the isotropic multiple-scattering octave weight and
`CLOUD_ESCAPE`.

**Scope:** small in code, large in judgement — a sit-with-Ash tuning pass, not a
unilateral landing. Best done *after* item 1, since Worley changes what the
silhouettes look like.

## 5. Supporting: GPU timing instrumentation — **BUILT**

> Marked 2026-08-16 by the correctness-and-truth round. This item is done:
> `src/render/GpuProfiler.ts` uses `EXT_disjoint_timer_query_webgl2` with
> asynchronous readback, honours the `disjoint` flag, and buckets per pass via
> `beginPass`/`endPass`. Because passes nest (the sky dome contains the cloud
> bake) it measures a rotating cumulative *prefix* over a six-frame cycle and
> differences adjacent prefixes, rather than trying to bracket nested draws with
> one query object.
>
> The headless recipe is in `docs/graphics/SHADOW_ROUND_HANDOVER.md`: headless
> Chrome with `--enable-gpu --use-angle=metal`, paired interleaved blocks, and a
> capture server. A visible window costs about 3x, so a windowed number is not a
> datapoint. The problem described below is solved; what is still owed is a quiet
> machine to run the instrument on.

Ash asked for this specifically — *"it needs to involve building that system and
i can test what my framerate is"* — so it is on the roadmap. But it is a
**support tool, not a gate and not an opener.** Build it whenever it is
convenient, or when Ash wants a number; do not start a cloud session with it, and
do not let its absence stop items 1–4.

**The problem it solved.** `gl.finish()` does not synchronise in the agent
browser, so wall-clock timing around a draw is meaningless — not noisy,
meaningless. Measured evidence: in one alternating A/B run a *cloudless* dome
came back at 18 ms while the cloudy dome came back at 0.07 ms in the same run.
Physically impossible, so the channel is untrustworthy. Every "perf is
unmeasured" note in these docs traces to this one fact.

**What to build.** `EXT_disjoint_timer_query_webgl2` — real GPU timestamps around
draws instead of CPU wall-clock around a lie. Minimum useful version:

- a helper that brackets a draw in a timer query and reads the result back a
  frame or two later (results are asynchronous — never block on them),
- per-pass buckets, at least sky dome / ocean / rest, because "the frame costs
  18 ms" is not actionable and "the dome costs 6 of it" is,
- the `disjoint` flag honoured: if the GPU reports a disjoint event the sample is
  garbage and must be dropped — exactly the discipline wall-clock timing lacks,
- surfaced in the existing render-stats overlay so Ash reads it in the running
  game, and exposed on `SimHandle` so harnesses can log it.

**Scope:** small — a self-contained module plus an overlay line. **Risk:** the
extension is unavailable in some browsers (Safari has been patchy); degrade to
showing nothing rather than showing numbers that lie.

**Precedent:** Ash's earlier instruction was "leave perf tuning out of scope —
but just instrument for now", so this is that, finally done properly.

## 6. Temporal AA — its own round, and it makes clouds cheaper *and* better

Ash has said explicitly that TAA is on the table. Full write-up under "Temporal
anti-aliasing" in `docs/graphics/GRAPHICS_TODO.md`, with the literature's measured numbers. The
short case: it unlocks per-pixel ray-start jitter, which recovers the structure a
low step count throws away — 8 steps + jitter + TAA matches a 128-step reference.
So `CLOUD_MARCH` could *drop* to 3–4 while looking better: a quality win and a
perf win at once. It also fixes the residual ocean sparkle the aliasing hunt
could not remove.

> **Two corrections, 2026-08-16 (correctness-and-truth round), neither of which
> changes the recommendation.**
>
> *An ocean TAA already exists.* `src/render/OceanTemporalResolve.ts`, opt-in
> behind `?oceanTaa=1` and off by default, verified image-correct under all
> three depth modes by the terrain round. What is absent is the **global/cloud**
> TAA this item is about — nothing reprojects the sky or the cloud march — so
> the item stands, but "no TAA in this codebase" is not the reason to want it.
>
> *The step numbers are stale.* `CLOUD_MARCH_STEPS` is **192**, on both quality
> presets, and the march runs once per cache texel in the bake rather than per
> screen pixel. A drop "to 3–4" was arithmetic against a per-pixel 8. The shape
> of the win survives — a temporal jitter buys steps back — but the ratio must be
> re-derived against the bake, and per-pixel jitter is precisely what had to be
> deleted here (see `docs/clouds/CLOUD_SHAPE_FINDINGS.md`): at cache-texel rate
> it magnified into a comb instead of resolving. A cloud TAA's jitter has to be
> temporal across bake sweeps.

Sequencing: TAA before item 1 would make item 1 cheaper, but TAA is a bigger,
riskier round (ghosting, reprojection, disocclusion). Under the mandate, do not
block clouds on it.

## 7. Smaller cloud-adjacent items

All written up in `docs/graphics/GRAPHICS_TODO.md`; listed so the roadmap is complete.

- **Patchy sun occlusion on the water** — bright pools sweeping the sea as gaps
  track across the sun line. Probably the best cheap item in the whole list for
  "weather over water" feel, and it is cloud work, not ocean work.
- ~~**Stars through overcast** — a fully overcast night shows a full starfield.~~
  **FIXED** in the night-sky round; marked 2026-08-16. The star pass samples the
  displayed cloud cache per star and raises transmittance to
  `STAR_CLOUD_BEAM_POWER = 5` (`src/scene/StarField.ts`), converting the sky's
  appearance alpha into a beam transmittance. The densest cloud the bake can
  write passes about one part in a million of a star.
- **`CLOUDS_IN_HAZE` is unreachable** — the desktop branch cannot fire because
  `viewDir` points down at the water. The fix changes the horizon's colour under
  cloud, so it wants Ash's eye.
- **Overcast mirror keeps a clear-sky aureole** — superseded if the sky+cloud
  environment cubemap ever happens.

## What the later performance round should look at

Recorded so the beauty-first decision stays auditable rather than a blank
cheque. **Nothing below should shape items 1–4.**

- Real per-pass numbers first, from item 5. The known worst case is Safari: 30
  FPS at 34.6 ms while drawing a quarter of the panel's pixels — measured
  *before* any volumetric cloud work.
- `CLOUD_MARCH` step count, especially paired with TAA and jitter.
- Worley (a) → (b), the baked-volume escape hatch.
- The prefiltered sky+cloud environment cubemap, which likely *saves* fragment
  cost by replacing the per-pixel analytic sky evaluation, and would let clouds
  back into water reflections safely.
- The adaptive-resolution policy, which currently only walks down; on a strong
  GPU it could run above native DPR and let the downsample average samples.
- The ocean shader itself, which was the GPU-bound thing before clouds got
  expensive.
