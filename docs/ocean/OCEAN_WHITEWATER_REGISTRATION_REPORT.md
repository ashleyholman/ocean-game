# Ocean whitewater — registration defect, evidence harness, and the gain decision

**Status: fix implemented and verified; the coverage gain is now an open visual
decision.** Written 2026-08-01, working from
`docs/ocean/OCEAN_VIOLENCE_RENDERING_HANDOVER.md`, on branch
`claude/ocean-violence-storm-legibility-8c371d`.

The handover asked for Phase 0 (an evidence harness) and a first Phase 1
experiment. Phase 0 is built. It immediately found something Phase 1 has to be
rewritten around.

---

## 1. What the handover got right, and the one thing it did not

Every structural claim in the handover checks out against the code. The bounded
Gerstner surface really does deny breaking crests a breaking silhouette
(`Waves.ts` explicitly caps `Σ Q·A·k` below folding). The spindrift really is
sub-metre and short-lived by design. The Southern preset really does carry
18 m/s, 6.41 m combined `Hs` and 6.01% calculated whitecaps. The documentation
drift in `presets.ts` was real and is now corrected.

What the handover could not see from the running app is that **the persistent
whitewater system was not merely illegible. It was switched off.**

`§4.3` reads "physically calibrated but not perceptually legible". The
measurement says otherwise: with the foam layer toggled on and off at a fixed
sun, wave clock and camera, foam changed **0.55% of water pixels** in the
production view and **0.08%** at the horizon. In the near half of the frame it
was 0.03%. Raising the foam strength sixty-fourfold moved that to 0.64% — proof
that the multiplier was not the problem, because the branch that draws foam was
not being entered at all.

---

## 2. The defect

`FoamField` stores its two levels as toroidal windows in wave-parameter space.
Injection maps texel to parameter as `p = origin + (uv - 0.5) * extent`, and the
ocean's lookup inverts exactly that. Outside the window the repeat wrap is a
tiled copy of water that is not there, so `Ocean.ts` fades each level out by
distance from the window centre — correctly, and unforgivingly.

The window centre was the accumulated surface drift: Stokes drift plus the
wind's drag on the surface, `windAdvection × windSpeed`, which is **1.35 m/s**
in the Southern preset. So the window walked away from the raft at 1.35 m/s
while the fade stayed nailed to it.

| | distance | time from a reset |
|---|---:|---:|
| Near level starts fading | 110 m | 81 s |
| Near level fully gone | 170 m | 126 s |
| Far level fully gone | 700 m | 8.6 min |

Worse, the drift was wrapped into `[0, 1536)` rather than about zero, so the
typical offset was 768 m — past the far fade edge — and a fresh warm-up
(40 simulated seconds of injection) usually *started* most of a wrap out.

Measured on the running app: `uFoamOrigin` was at `(38, 1521)` while the raft
sat at parameter `(0, 0)`. That puts `nearUv` at −3.48 and `farUv` at −0.50, so
both fades evaluated to zero. The entire persistent field — near and far,
active and residual — was multiplied by nothing. What remained was the
statistical far-field term and an instantaneous crest term with a metres-wide
footprint fade.

Zeroing the origin by hand, with no other change, moved bright desaturated
water from 5.3% to 72.3% in the same frame.

**This is the reason the Southern Ocean looks benign.** It is not a tuning
deficit and no amount of foam gain could have reached it.

### 2.1 Two smaller defects found alongside

- **`FoamField.readLevel` read the wrong stride.** The targets are `RGFormat`
  — two half-float words per texel — and the readback indexed them as four. It
  decoded every second texel and reported the entire second half of the field
  as empty, at exactly half the true mean. Any diagnostic built on it would
  have concluded the field was sparse when it was dense.
- **The freshness term carried the pre-calibration gain.** `fresh` was built as
  `field.x * 1.35 * 40.0 / coverage` while `coverage` used the recalibrated 3.1
  — so the numerator ran about thirteen times the denominator and freshness
  pinned at 1 almost everywhere. Every whitecap in every sea rendered at the
  fresh albedo with alpha never below 0.65, and foam could not visibly age. It
  now uses the same gain as the coverage line, and includes the live crest term:
  a crest breaking in this frame is the freshest whitewater there is.

---

## 3. Why the old calibration could not have caught this

The shipped gain was measured by counting bright, desaturated water pixels and
comparing to Monahan. At a 48-degree sun, **35% of the water in a Southern
frame passes that test with the whitewater layer entirely disabled.** It is
specular glitter. Across the whole gain ladder, that count moves from 35.0% to
41.3% — six points of signal on a thirty-five point floor — while a
difference-based measurement of the same frames moves from 0.3% to 34.3%.

A bright-pixel count is not a foam measurement in this renderer. So
`oceanViolenceMetrics` measures foam by rendering the frame twice, with the
layer on and off, and attributing only what changed. The glitter floor is
reported alongside every figure rather than being silently included in it.

---

## 4. The fix

Drift is a property of the water, not of the storage. The window is now
centred on the observer and stays there; the drift is applied to the field's
*contents* by an advection pass that samples the previous field at an offset and
ages it in the same operation. The levels are double-buffered for it, which
costs 320 kB across both.

Verified over time, which is the thing the old code failed at: 120 simulated
seconds of the Southern sea, with drift accumulating to 203 m — well past the
170 m that used to erase the near field — and foam area holding between 44% and
81% as the wave phase and gusts move it. `foam.origin` stays at zero by
construction. The lab readout now prints both, labelled, so the next person can
see at a glance which one is supposed to move.

All 331 tests pass. No test covered this and none of the natural ones would
have: it is a registration defect between a texture window and a fade, visible
only in a rendered frame after a minute of simulated time. The guard that
replaces a test is the evidence sheet.

---

## 5. What was built

| Piece | What it is |
|---|---|
| `src/debug/oceanViolenceMetrics.ts` | Difference-based foam area, glitter floor, connected-component structure of the foam mask, crest occlusion of the horizon. Pins the render size, because a hidden browser tab collapses the drawing buffer to 1×1 and every ratio still reports itself as 100%. |
| `Ocean.setDebugView` | Compile-time diagnostic outputs: exact water silhouette, foam alpha, coverage, the raw field, and the near-level fade — the last of which shows this defect directly. |
| `src/debug/oceanViolenceContactSheet.ts` | Five seas × four views, pinned sun and wave clock, foam warmed before every shutter, each frame measured as well as photographed. Plus the gain ladder. |
| `Ocean.setFoamCoverageGain` | The coverage gain as a uniform, with a lab slider. |
| Lab controls | Coverage gain, debug view, and buttons for both captures. |

Evidence written to `evidence/`: `violence-before`, `violence-after`,
`ocean-violence-gain-ladder`, each as a PNG contact sheet plus a text report and
a JSON of every metric.

Three harness bugs were found and fixed while building it, all of which had
produced confident, wrong numbers: the water mask counted the sky (the sky dome
is brighter than any "is this bright" threshold, so water came out as 99.8% of
the frame and every column read as occluded); the camera never left embodied
mode because the interactive path animates a one-second transition and the
harness steps the world by zero seconds; and the raft was never re-settled
between sea states, which put several "low waterline" frames under the water.

---

## 6. Cost

**+0.20 ms of ocean pass at the heaviest gain, on an M2 at 2560×1353.** About
2% of the 9.4 ms the ocean already costs.

| | ocean pass, A unregistered | B registered | paired B−A |
|---|---:|---:|---:|
| gain 3.1 (heaviest rung) | 9.421 ms | 9.616 ms | **+0.196 ms** (sd 0.156, n=24) |
| gain 0.4 | 9.395 ms | 9.538 ms | **+0.110 ms** (sd 0.121, n=24) |

So the whole ladder spans 0.09 ms. **Performance does not constrain the look
decision** — pick the rung that reads as a gale.

### How it was measured, and one that did not work

`runWhitewaterCostBenchmark` parks `foam.origin` back at the offset the drift
used to leave it at, so the same shader takes the same branch it used to. No
second build, no compile-time variant: only the registration differs.

It cannot run in an agent's browser pane. That pane does not composite while
hidden, so GPU timer queries are never retired and the collector waits forever;
a `gl.finish()` wall-clock fallback there claimed 0.3 ms for a 2560×1440 frame
with volumetric clouds, which is not a believable number. Both were discarded.
The run above is a real headless Chrome window with `--enable-gpu
--use-angle=metal`, driven by `?perf=whitewater&gain=…`, which posts its table
to the capture server. The same benchmark is on a **Cost A/B** button in the lab.

The first version of it also produced nothing usable, and the way it failed is
worth keeping: four long A-B-B-A legs with the world running gave per-leg
medians of 5.47, 5.04, 4.88, 4.67 ms — a monotonic fall across the run, sd 2.4
to 3.0 ms per leg, with A and B indistinguishable inside a warm-up and thermal
trend an order of magnitude larger than the effect. What fixed it was freezing
everything that can differ between two samples — world clock, wave clock, foam
history, cloud cache — and **pairing**: 24 short alternations, each contributing
one adjacent A−B difference, so shared drift cancels rather than landing on
whichever leg went first. Per-pair sd fell from 1.32 ms to 0.16 ms.

### Where the work actually lands

Two branches gate the whitewater chain, and they moved very differently:

| | old | fixed |
|---|---:|---:|
| `coverage > 0.004` — breakup fBm, fine cut | 100% of water pixels | 100% |
| `alpha > 0.001` — relief noise, foam BRDF | 3.2% | 54.3% |

The outer branch is **unchanged**, which is the opposite of what I assumed
before measuring. The statistical far-field term alone already put coverage
above the threshold everywhere, so the three-octave breakup fBm and the second
fine-noise cut were being paid on every water pixel throughout — including on
every frame of the perf round. What the fix changes is the *values* through
that code, not whether it runs.

The inner branch is where the new cost is: the relief `noisedPeriodic`, the
four-light foam BRDF, the thin-edge translucency and the reflection term now run
on 54% of water pixels instead of 3%. That is the whole of the 0.20 ms, and it
is why the figure tracks the gain.

Two smaller items, both bounded by inspection: the advect pass adds one texture
fetch per texel across 81,920 texels at 12 Hz, which is about a million fetches
a second; and double-buffering the levels costs 160 kB.

**One consequence worth flagging beyond this round.** The ocean lane figures in
`docs/ocean/OCEAN_PERF_HANDOVER.md` were measured while the persistent foam field was being
faded to zero — so the foam BRDF was running on 3% of water pixels rather than
the ~54% the shipping design intends. Those numbers are optimistic by whatever
the bracket turns out to be, and the mobile path deserves the same check.

## 7. The decision waiting

The gain is unchanged at 3.1 so the registration fix can be judged on its own.
That value is now certainly wrong — it was fitted to a field that was being
faded to zero, using a metric that was mostly measuring the sun — and at 3.1 the
repaired Southern sea is too white.

`evidence/ocean-violence-gain-ladder.png` is four conditions across five gains.
Measured foam area for the production view: 2.2% at gain 0.2, 6.4% at 0.4,
13.1% at 0.8, 21.6% at 1.5, 34.3% at 3.1. The moderate control moves from 0.15%
to 0.85% across the whole ladder, so it does not inherit Southern storm loading
at any rung.

Note that screen-space foam area is not surface coverage — the far field is
foreshortened, so a 6% surface coverage occupies far more than 6% of a frame
seen from near the water. The Monahan figure of 6.0% for 18 m/s is context, not
a target, and the handover is right that a coverage number satisfied by flecks
is not the goal. The choice is which rung reads as a gale.

**This is a look decision and it is not mine to make.** Once a rung is chosen,
`FOAM_COVERAGE_GAIN` takes it and the round moves on to the handover's Phase 1
and 2 — with, for the first time, a whitewater layer that is actually on screen
to judge them against.
