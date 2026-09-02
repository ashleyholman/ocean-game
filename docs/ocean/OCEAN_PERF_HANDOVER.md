# Ocean perf lane — handover for its own session

The cloud-cache round (docs/clouds/CLOUD_CACHE_REPORT.md, commit 513fe5a) took the frame
from 80–105 ms to ~17–19 at 2560x1440 on the M2. What remains is mostly the
ocean: **~13.4 ms measured** (ocean.mesh hidden vs shown, GPU-fenced, day,
calm-ish sea). Everything else combined — gas sky, cloud composite + bake
bands, raft, stars, foam sim, spindrift, shadows — is ~4.5 ms. This lane was
scoped and deliberately left untouched; Ash's bar for it: **zero look risk,
verifiable by pixel-diff**, not by eye.

## Original cost hypothesis (now measured by the component sweep below)

The ocean fragment (`src/scene/Ocean.ts`, FRAGMENT_SHADER) per pixel:

1. **Two full analytic atmosphere evaluations.** `skyRadiance(R)` for the
   mirror sample and `skyRadiance(viewDir)` for the haze — each is the whole
   single-scatter model (viewPathInscatter, multi-scatter field, ozone,
   several exp/pow chains). Likely the biggest single item.
   - Fix shape: a small equirect LUT (e.g. 256x128 half-float) regenerated
     when the sun moves — the gas sky is angularly smooth *except* the Mie
     aureole near the sun, which matters in reflections (glitter context).
     Either keep an analytic aureole term on top of the LUT, or accept the
     LUT resolution and diff it. GRAPHICS_TODO's "prefiltered sky+cloud
     environment cubemap" item is the same idea grown up (mips for
     roughness); a flat LUT is the cheap first step.
   - The `uSkyHemi` lobe blend already replaces much of the mirror sample at
     high roughness/far field, so errors hide well; the near-field calm-water
     mirror is where a diff would show them.
   - STATUS: landed on master (8221024) as a 256×128 per-frame LUT, worth a
     measured ~3–5 ms. Its look validation against the analytic sky — the
     near-field mirror at low sun, where the Mie aureole lives — has NOT been
     diff-recorded and is tracked as Ash's own separate task. It is explicitly
     outside the residual-loop optimization round's scope.

2. **The 48-slot residual wave loop** (`residualWaveGradient` in
   shaders/lib.ts): runs NUM_WAVES=48 iterations per pixel reading uniform
   arrays, even though `uResidualMaxK` and the Nyquist fade gate most slots
   to nothing. Production slot order is stable for sea-state morphing, **not**
   globally wavelength-sorted. A true active prefix therefore needs a separate
   residual-only sorted table, or explicit long/short wavelength banks, while
   leaving the vertex/buoyancy slot order untouched.
   The vertex loop (`evaluateWaves`) also runs 48 but vertex count is only
   ~166k — fragment first.

3. **Detail octaves** (5 on desktop, analytic-derivative gradient noise per
   octave with Nyquist fades) and **foam** (two texture samples + breakup
   octaves). Probably smaller; measure before touching.

## Component sweep landed (2026-07-31)

The dedicated continuation document is
`docs/ocean/OCEAN_RESIDUAL_WAVE_PERF_HANDOVER.md`. It contains the corrected renderer
mental model, full measurements, ranked optimization candidates, implementation
risks and the recommended next-session experiment.

Follow-up landed 2026-07-31 (commit 0ec855a): three structural probes of the
unchanged 48-slot scan — branchless selects, texelFetch parameters, dynamic
loop bound — acquitted the loop's execution and retired the dynamic-bound
compiler risk. Verdicts, timings and the implementation round's mandate are in
that document's §13 and §12; a new implementation session starts from its §12
checklist.

Implementation follow-up, also 2026-07-31: the wavelength-ordered residual
active window is complete and is now the default in this change set. At a
3370×1628 drawing buffer, two full-ocean A-B-B-A repetitions reduced complete
GPU frame time from 33.40→23.40 ms and 35.60→24.33 ms: **10.01–11.27 ms**, or
**30.0–31.7%**. The production medium category probe needs only 2.53 individual
components per ocean pixel on average instead of scanning 48; the production
maximum-high view averages 12.84. See
`docs/ocean/OCEAN_RESIDUAL_WAVE_PERF_HANDOVER.md` §14 for the algorithm, six-scenario
matrix, parity result and validation record.

The next ocean lane is now specified in that document's §15: first re-baseline
the five-octave detail stack inside the new full active shader, then measure its
per-pixel live-octave distribution, try an exact active-prefix plus aggregate
variance suffix, and use a periodic prefiltered gradient/normal texture only if
the exact restructuring is too small. It also records the still/motion
validation bar and the subsequent foam → base-optics order.

The graphics panel now has compile-time ocean switches plus an automated
component sweep. It freezes the world, waves, camera and adaptive-resolution
walk; warms every shader variant for 24 frames; then records 12 complete raw
GPU-prefix rotations. The report leads with whole-frame deltas because only the
ocean shader changes between each counterfactual and its named parent. The
signed ocean-prefix estimate remains beside it as a noisier cross-check.

Two repeated sweeps at a **3370×1628** drawing buffer (fixed DPR 2) measured:

| counterfactual addition | whole-frame cost |
|---|---:|
| 48 vertex waves under a flat fragment | below the ~1 ms measurement floor |
| base water optics above the flat 48-vertex shader | 3.1–3.9 ms |
| 48 residual slots | **17.3–17.5 ms** |
| 5 detail octaves | 3.6–5.2 ms |
| foam fragment work | 1.2–2.2 ms |
| analytic gas sky instead of the LUT, net of LUT generation | 3.2–5.4 ms |

These rows are not additive: GPU latency hiding and interaction between shader
regions make the complete cached-sky ocean cheaper than the sum of isolated
marginals. The repeated residual result is nevertheless unambiguous.

A second residual variant kept the complete 48-slot band-limit and
lost-variance scan but compiled out direction fetch, phase dot product, cosine
and gradient accumulation. It measured **17.85 ± 0.68 ms**, versus
**17.50 ± 0.56 ms** for the full residual path in the same sweep. The
difference (-0.34 ± 0.62 ms) is noise. The expensive part is therefore the
48-slot per-pixel scan — uniform reads, smoothsteps, branches and variance
bookkeeping — not the trigonometry. The next performance lane should implement
an exact active window / wavelength-bank scheme that skips slots incapable of
contributing at a pixel, with a zero-diff image test. Do not spend time
approximating `cos()` first.

The always-visible render stats keeps wall-clock frame interval as its headline,
then reports two independent profiles:

- synchronous main-thread wall time for world + lighting, raft + camera, foam +
  spray, ocean preparation, sky + scene preparation, Three.js render
  submission, and the uncategorised callback remainder;
- asynchronous rotating GPU prefix timings for the whole frame, foam
  simulation, the
  current cloud-cache bake band, the combined gas-sky/cloud-dome draw, the
  monolithic ocean draw, and the remaining scene.

CPU and GPU totals overlap and must not be added. `render submit` is the CPU
duration of `renderer.render()`, not the ocean shader's execution; it can also
include a driver wait if the GPU queue is saturated. The GPU profiler measures
one cumulative prefix per rendered frame, rotates through the buckets, and
receives each result several frames later. Directly isolating a draw forces
tile-based GPUs to flush and can make even a tiny draw report most of the frame.
Adjacent raw prefixes from the same six-frame rotation are therefore paired
first; their difference is smoothed afterwards, avoiding false small-pass
timings from subtracting independently smoothed streams. Both profiles are
smoothed independently.

The overlay also prints the ocean shader's structural workload (`atmosphere ×2
· residual ×48 · detail ×5` on desktop). The three ocean items above still
share one fragment draw, so the overlay deliberately does not invent an
intra-shader millisecond split; that requires the counterfactual shader-variant
harness described below. The same rule applies to the cloud bake: its displayed
time includes the view traversal, the conditional sun-shadow ray from each
occupied sample, and cirrus. Those operations are interleaved inside
`cloudBake()`, so the overlay reports their exact shader workload (`view ×96 ·
sun ≤5/hit` on desktop) rather than fabricating separate timings. Cache
advection, three texture fetches, live relighting, and compositing happen in the
separately timed sky/cloud draw and are listed beneath it.

## How to measure (the harness that worked)

- `gl.finish()` does NOT synchronise in the agent browser (documented in
  GRAPHICS_TODO); fence with a 1x1 `readPixels` and time N renders around it.
- Drive frames synchronously via `__drift`: pin
  `renderer.setPixelRatio(2); renderer.setSize(1280, 720, false)` then
  replace `setPixelRatio` with a noop so the adaptive walk can't move it —
  and beware: a hidden pane loads with `innerWidth 0` and a **2x2 canvas**;
  always verify `gl.canvas.width` before trusting a number.
- Freeze the world (`world.state.worldSecondsPerRealSecond = 0`), pick
  instants via `world.setWorldInstantUtcSeconds(t0 + h*3600)` +
  `sim.refreshLighting()`; t0 1768532100: +21.6 h day, +17 h sunset, +10 h night.
- Attribute by toggling (`ocean.mesh.visible`, uniforms) and by recompiling
  with reduced defines (DETAIL_OCTAVES, FOAM_BREAKUP_OCTAVES...) — quality
  fields in OCEAN_QUALITY_DESKTOP.
- Captures: `node tools/capture-server.mjs <dir> <port>` — port 5199 may be
  held by another session's server; use a free one and POST
  `canvas.toBlob` to `/shot?name=`.
- Verification bar: render A, `readPixels` full frame, render B, diff —
  mean/max LSB + % over 2 LSB. The cloud round's factorization landed at
  mean 1.4 LSB for a *restructured* path; a LUT swap should aim comparable,
  and the residual-loop prefix should be **exactly** zero-diff.

## Also open, cloud-side (state at session end, 2026-07-30 late)

Sample-time advection LANDED (commit 4c1f3d9): per pixel, unproject to the
deck's plane, slide by (live drift − the displayed generation's bake
baseline), re-project, sample. The cache is now camera-local and tiled, but
the tiles are staged from one snapshot and published in one atomic 60-frame
swap, so differently aged tiles are never displayed together. The visible
region plus a 20-degree guard is the only part refreshed; see
`docs/clouds/CLOUD_TILE_CACHE_DESIGN.md`. Two hard-won calibrations still apply:

- `CLOUD_ADVECT_ALT 1350` (lib.ts): the advection altitude is the cloud
  BASE region, not the midline — the march's visible content is first-hit
  weighted, and midline advection undershot true motion by a measured
  1.67x, paying the shortfall back as a ~3.5 px pop at every swap. The
  1.67 was measured at ONE elevation band; if a residual pop shows at
  other elevations, this constant is the dial.
- `CLOUD_TILE_REFRESH_FRAMES` (cloudTileScheduler.ts): a stable guard set
  completes in at most 60 rendered frames. A newly exposed tile is filled with
  the current display snapshot, then joins the next common swap; any staging
  miss is caught up on the swap frame.
- `CLOUD_ADVECT_MAX 400` m is the scrub-replay window: drift inside it
  replays smoothly under the time slider; beyond it the sky holds still
  until the next synchronized generation rebases.

NOT yet confirmed by Ash's eye on a stable build (their session was
polluted by mid-refactor HMR bundles — always hard-reload before judging):
normal-play smoothness at day and sunset, the wind-crank stress, scrub
replay, and any residual swap pop. Crossfade remains the named fallback
for whatever non-translational residue survives (evolution, shadow-angle
ticks). Probe discipline for whoever verifies numerically: check row
variance before correlating (featureless rows read as zero shift), never
step the sim during a probe (the cinematic camera orbits), and distrust
cross-session comparisons (cloud fields diverge with wind gusts).
