# Graphics TODO

Parked graphics work, with enough context that a future round can pick any
item up cold. Started 2026-07-30 at the close of the aliasing hunt (see the
commit `The TV static was the clouds` for the diagnosis this grew out of).
The lab's **Clouds** checkbox (ocean laboratory → environment) is the
diagnostic lever for most of it: it removes the cloud layer from the dome,
the lighting means and the sun occlusion in one move.

## Known leaks — small, visible if you look for them

### The overcast mirror still reflects a clear-sky aureole

The water's mirror sample is `skyRadiance(R)` — the gas sky only, by
design (drawn cloud shapes on wavy water read as oil-slick rings near and
static far, so cloud radiance enters as the hemispheric mean instead).
Consequence: under heavy overcast the water toward the sun's azimuth keeps
a faint warm glow from the reflected Mie aureole, even while the disc is
hidden and the glitter is gated off. Mostly masked by the hemisphere
blend; visible on calm water if you hunt for it.

Fix shape: scale the Mie in-scatter share of the mirror sample by
`sunCloudTransmittance` (already a uniform in the ocean material), or fold
this into the environment-cubemap item below, which supersedes it.

### Stars shine through overcast — **FIXED**

> **Done in the night-sky round** (`docs/graphics/NIGHT_SKY_ROUND_REPORT.md`),
> recorded here 2026-08-16 by the correctness-and-truth round. The star pass
> samples the displayed cloud cache's exact sparse-atlas address per star and
> converts the sky's *appearance* alpha into a *beam* transmittance:
> `STAR_CLOUD_BEAM_POWER = 5` in `src/scene/StarField.ts`, applied as
> `(1 - alpha)^k`. A wisp reporting alpha 0.3 still passes about a sixth of a
> star; the densest alpha the bake can write — 0.935 at the zenith — passes
> about one part in a million. The fix went further than this item asked for:
> a cheap global cover × opacity factor was the shape proposed here, and what
> landed is per-star and per-direction, so extinction, the twilight arch and
> cloud all shrink a star's glare along with its core. It did not need a
> weather round.

Star visibility is driven by `limitingMagnitude` (sun elevation + moon
penalty) and knows nothing of clouds: a fully overcast night still shows a
full starfield. Fix shape: dim per star by cloud transmittance toward its
direction (the CPU cloud port in `TimeOfDay` makes this a one-line query),
or a cheap global factor from cover × opacity. Belongs with a weather
round.

### `CLOUDS_IN_HAZE` is a branch that cannot fire

Found while marching the cloud field, not fixed — the fix is a composition
decision rather than a bug fix.

`Ocean.ts` looks up `skyWithClouds(viewDir)` for the atmospheric-perspective
blend, guarded by the desktop-only `CLOUDS_IN_HAZE` define, and the comment
says the clouds "must be here, or the sea's rim would meet a clear-sky haze
under a clouded dome". But `viewDir = -V` is the direction from the camera
*down to the water point*, so its `y` is negative for every water pixel a
camera above the surface can see, and `cloudLayer()` early-outs at
`dir.y < 0.004`. The desktop path has therefore been rendering the mobile
path's clear-sky haze all along, and `OceanQuality.cloudsInHaze` buys nothing.

Fix shape: sample the haze at the *horizon* direction in the same azimuth
(`normalize(vec3(viewDir.x, small positive, viewDir.z))`) rather than at the
downward view ray, which is what "the sky the sea's rim meets" actually means.
That changes the horizon's colour under cloud, so it wants Ash's eye on it.

### Sun occlusion was one number for the whole sea

**Implemented for ocean direct light on 2026-08-18; visual/perf verdict open.**
`sunCloudTransmittance` remains the observer's integrated solar-disc statistic.
Inside 3.2 km, non-neutral weather now replaces it locally with one cloud-slab
ray-midpoint density sample per water pixel. The sample gates the existing shared
direct-sun path, so glitter, body sun, crest scatter and foam cannot disagree.
It contains no march or texture allocation; neutral/zero and the far horizon
return exactly to the old scalar. Vessel/deck lighting remains on that scalar.

**Worth more now than when this was written.** The gaps move: the cloud field
runs on a clock derived from canonical world time, and at the default rate the
deck crosses 160 m of sea per real second. A static patchy-light pattern would
have been decoration; a moving one is the cue itself. See
`docs/clouds/CLOUD_MOTION_REPORT.md`, and note that the sample must ride `uCloudEvolve` as
well as `uCloudOffset` or the pools will slide without ever changing shape.
The implementation reads both, and its CPU/source tests lock that coupling.

## Architecture upgrades — do when wanted, not when idle

### Prefiltered sky+cloud environment cubemap

If directional cloud reflections in glassy water are ever wanted (a cloud
bank glinting at the right azimuth on a calm sea), the honest mechanism is
image-based lighting: render the shared sky shader — clouds included —
into a small cubemap with a mip chain, and sample it with
roughness-matched mips in the water. Anti-aliasing falls out of mip
filtering; sky and sea still cannot disagree because the cubemap is
rendered from the same GLSL; and it likely *saves* fragment cost by
replacing the per-pixel analytic sky evaluation. Machinery: render
target, update cadence, mip generation. Supersedes the aureole leak above
and would let clouds back into reflections safely.

### Temporal AA (or supersampling) as the endgame

Every remaining sparkle — sun glitter at grazing angles, the marginal
band of each noise octave between "resolved" and "retired" — is the
irreducible noise of one shading sample per pixel through nonlinear
radiance. Input-side band-limiting (which the ocean now does thoroughly)
cannot remove it, only supersampling or temporal accumulation can. TAA is
the industry answer: sub-pixel camera jitter + history reprojection +
rejection heuristics; real machinery, ghosting risks, big payoff. A
cheaper stopgap exists in the current codebase: the adaptive-resolution
policy could be allowed to run *above* native DPR on strong GPUs and let
the downsample average samples.

The cloud round found a second, independent reason to want it, with measured
numbers, and Ash has since said it is on the table: see **Temporal
anti-aliasing** under "Cloud work" below.

## Calibration debt

These were set by reasoning, not by measurement against reference footage,
and deserve a tuning pass with A/B captures:

- **REJECTED FOR SHIPPING 2026-08-17:** the scotopic operator's look constants
  (`scene/scotopic.ts`), retained only behind non-zero `?scotopic=` and separated into
  what was measured, what was derived and what was chosen — full working in
  [NIGHT_VISIBILITY_PART_A.md](NIGHT_VISIBILITY_PART_A.md).
  - **Measured**, from a probe driving the real `TimeOfDay` through the real
    tone curve: every display luminance the constants are placed against (night
    sky 0.0035, night sea 0.0054, horizon band 0.0107, lamp globe 0.700, lamp
    core 0.993) and every adaptation luminance in the rod ramp.
  - **Derived, not chosen**: `SCOTOPIC_LIFT_SCALE` (fixed by continuity at the
    knee — it is `KNEE_HI^(1−1/γ)` and nothing else will make the join C1), and
    the rod ramp's two anchors (civil twilight −6° → 5.6e-3 and nautical
    twilight −12° → 1.696e-3, read off this pipeline's own exposure meter).
  - **Chosen, and awaiting Ash's eye**: `SCOTOPIC_KNEE_HI` 0.08,
    `SCOTOPIC_KNEE_LO` 0.004, `SCOTOPIC_LIFT_GAMMA` 2.0,
    `SCOTOPIC_DESATURATION` 0.8, `SCOTOPIC_ACUITY_LOSS` 0.35,
    `SCOTOPIC_ACUITY_CLAMP` 0.02 and `SCOTOPIC_ROD_TINT` (a ~10 000 K blue-grey;
    the Purkinje shift is real but V'(λ) is a scalar efficiency, not a
    chromaticity, so no derivation was available and this is the film
    convention). Ash chose **0%**, now the runtime, module and A/B default;
    `?scotopic=<0..1>` and the graphics-panel slider retain the lab comparison.
- The moon's dials after Part B — full working in
  [NIGHT_VISIBILITY_PART_B.md](NIGHT_VISIBILITY_PART_B.md).
  - **Walk-through presentation correction:** the disc is now 1.40° across
    (2.62× life size) and uses continuous rough-sphere lighting rather than a
    softened binary phase stencil. This changes no moonlight-energy path.
  - **Measured**: `MOON_SKY_POWER` 1.0 solved from a linear response to hit the
    acceptance clause (12.14x on `ambientRadiance`, gate 10x);
    `MOON_AMBIENT_RATIO_PEAK` 11.3.
  - **Derived, not chosen**: `MOON_IRRADIANCE_SCALE` (the sun's, scaled by the
    moon's share of sky power — the moon's key-to-fill was 41:1 and is now
    4.80:1 against the sun's 6.85:1); the star penalty's `1.25*log10(B)`
    (background-limited detection, not surface brightness); the retinal
    twilight/moon anchors in `scotopic.ts`, which are textbook cd/m2.
  - **Chosen, and the one most likely to be wrong**: `moonSpecularGain` 0.09,
    which holds the moonglade's on-screen brightness where it was rather than
    letting it grow with a moon that is now fourteen times stronger. The
    physical answer is ~0.645. Deliberately conservative because a moonglade
    that bright was already tried at 3.5 and rejected by eye.
  - **A two-point fit, labelled as one**: the `sin^0.4` elevation term on the
    star penalty, fitted to the marginal fill measured at 10 and 40 degrees.
  - **Re-audited without Part A's lift:** the shipping display sea is sRGB 17
    moonless and 52 full-moon at 40°, remains monotone across phase/elevation,
    and stays about 17× below the lantern. No moon constant needed retuning.
- The sun's ambient fill spikes **2.4x as it crosses 26 degrees elevation** —
  seven ambient samples point-sampling a `g = 0.94` aerosol lobe. FIXED behind
  `?sunDomeMean=1`, **default off** and gated byte-identical when off, because
  the fix moves daylight and Part A's bit-identical clause was not Part B's to
  spend. Registered for `tools/ab-sheet.mjs`; awaiting Ash's A/B. See
  [NIGHT_VISIBILITY_PART_C.md](NIGHT_VISIBILITY_PART_C.md).
  - **Underneath both fixes was the seven-direction ambient set. Now replaced**,
    behind `?fibonacciAmbient=1` — 256 cosine-weighted Fibonacci directions,
    default off, byte-identical off, registered for the sheet. See
    [AMBIENT_SET_ROUND.md](AMBIENT_SET_ROUND.md). It costs nothing (the probe
    already evaluates and caches those 256 directions; the ON arm *removes*
    seven sky evaluations a frame) and it moves the fill about 5% darker by day,
    4% at night, and up to ±15% under cloud — toward the converged integral in
    every case, since the old estimator's cloud error is a wander not a level.
    **Recommendation: retire `sunDomeMean` once Ash has A/B'd it**, because the
    Fibonacci set alone beats it and beats the two of them together.
  - **Still open from that round**: `1/(2π)` is the exact lobe normalisation for
    a *uniform* hemisphere mean and the wrong one for a *cosine-weighted* one —
    it should be `max(l·up, 0)/π`. Costs ≤5% in the fill and is smooth, so it is
    invisible, but it is now the largest error left in the estimator, and it
    applies to the MOON's unconditional fix as well. Fixing it moves the night.
- **OPTIONAL ARM ONLY:** `CALIBRATION_TARGET_MARGIN_CODES` = 24
  (`scene/displayCalibration.ts`) — how
  far above the player's MEASURED black floor the night sea's mean should sit.
  **Chosen**, and now the only pure-taste number left in the night thread:
  everything else in Part C is either measured by the player or derived by
  inverting the operator. It has no consumer at the shipped 0% strength and the
  Settings entry is hidden; judge it only if the observer arm is reconsidered.
- `CrestSpray`'s `uStrength` 2.1 — fitted by eye against `SOUTHERN_OCEAN_ROUGH`
  in daylight, on a path where the spray shader **never tone-maps at all**. The
  daylight fit is intact, but the scotopic pass gives spray the tone curve at
  night for the first time and takes it from +0.4 sRGB codes to about +11. See
  finding 3 in the Part A report; wants a look at a rough sea after dark.

- `fwidth(R)` reflection blend window `0.02–0.20` rad, ceiling `0.85`
  (`Ocean.ts`, reflection stage) — how aggressively under-sampled
  reflections collapse to the hemispheric mean.
- Cloud-layer resolution window `0.25–0.75` cells/pixel
  (`shaders/lib.ts`, `cloudLayer`) — where drawn clouds fade; only the
  dome consumes this now (see the `CLOUDS_IN_HAZE` item above), but it
  shapes the last degrees above the horizon. Since the march, the measure
  it is applied to is widened by `CLOUD_TOP / CLOUD_MID` so it is sized
  for the last step rather than the midline.
- The cloud field's own shape constants — `CLOUD_SHEAR` (700, 420 m of
  lean across the slab), `CLOUD_TOP_MIN` 0.30, `CLOUD_TOWER_RANGE` 0.24,
  `CLOUD_ESCAPE` 0.95, `CLOUD_SPAN_CELLS` 1.30, `CLOUD_LUMP_FREQ`
  (a 450 m lobe), `CLOUD_WARP` 0.85, `CLOUD_ERODE_BASE`/`CLOUD_ERODE_TOP`
  0.45/1.70, `CLOUD_REGION_SCALE`/`CLOUD_REGION_SWING` 0.22/0.11,
  `CLOUD_SUN_GAIN` 1.5 and the three multiple-scattering octave weights.
  Every one was reasoned to and then looked at, not measured against
  reference footage. `CLOUD_SUN_GAIN` and the isotropic octave in
  particular set the silhouette contrast at a low sun, which is the "fire"
  item the graphics handover still carries.

## Cloud work — see docs/clouds/CLOUDS_ROADMAP.md for the order

These are the individual items. `docs/clouds/CLOUDS_ROADMAP.md` is the authority on
sequencing and carries Ash's beauty-first mandate; if the two ever disagree,
the roadmap wins.

The motion round (`docs/clouds/CLOUD_MOTION_REPORT.md`) added a cloud clock, shape
evolution and a cirrus deck. It changes the cost baseline every item below is
measured against: a clear-sky pixel now costs about twice what it did, and a
cloudy one about the same.

### GPU timing instrumentation — the thing that would end "perf is unmeasured"

> **BUILT.** Recorded 2026-08-16 by the correctness-and-truth round; this item
> is history, not work. `src/render/GpuProfiler.ts` implements exactly what is
> specified below: `EXT_disjoint_timer_query_webgl2`, asynchronous readback, the
> `disjoint` flag honoured so garbage samples are dropped, per-pass buckets via
> `beginPass`/`endPass`, and silent degradation where the extension is missing.
> It went further than the spec in one place that matters — nested passes cannot
> be timed with a single query object, so it measures a rotating *cumulative
> prefix* across a six-frame cycle and differences adjacent prefixes to attribute
> cost, which is why the numbers survive a scene where the sky dome contains the
> cloud bake.
>
> The headless recipe that drives it on a quiet GPU is written up at
> `docs/graphics/SHADOW_ROUND_HANDOVER.md` §"Measuring": headless Chrome with
> `--enable-gpu --use-angle=metal`, paired interleaved A-B-B-A blocks, and a
> capture server. **A visible window costs about 3x, so a windowed number is not
> a datapoint.**
>
> Every note in this file and in `docs/clouds/` that says perf is unmeasured
> *because `gl.finish()` lies* is describing a solved problem. The instrument
> exists; what is still owed is the quiet machine to run it on.

Every "perf could not be measured" note in these documents traces to one fact:
**`gl.finish()` does not synchronise in the agent browser**, so wall-clock
timing around a draw is not noisy, it is meaningless. Evidence: in one
alternating A/B run a *cloudless* sky dome came back at 18 ms while the cloudy
dome came back at 0.07 ms in the same run. Physically impossible.

Fix: `EXT_disjoint_timer_query_webgl2` — real GPU timestamps around draws.
Minimum useful version is a helper that brackets a draw in a timer query and
reads the result back a frame or two later (asynchronous; never block), per-pass
buckets (sky dome / ocean / rest — "the frame costs 18 ms" is not actionable,
"the dome costs 6 of it" is), the `disjoint` flag honoured so garbage samples are
dropped, surfaced in the render-stats overlay and exposed on `SimHandle` for
harnesses. Small, self-contained. Degrade to showing nothing where the extension
is missing (Safari has been patchy) rather than showing numbers that lie.

**It is not a gate.** Ash: *"right now i'm not going to stress about the
technical challenge of performance optimisation if i'm not even happy with the
scene."* Build it when convenient or when Ash wants a number; do not open a
session with it and do not let its absence defer visual work. See
`docs/clouds/CLOUDS_ROADMAP.md`.

### Temporal anti-aliasing — RECOMMENDED, and Ash has NOT ruled it out

Correcting the record: an earlier note in `docs/graphics/GRAPHICS_ROUND_HANDOVER.md` said
ray-start jitter was "deliberately not taken", which read as settled policy.
It was not Ash's decision — it was mine, taken because no TAA existed in this
codebase at the time, and Ash has since said explicitly that TAA is on the table and
they may run a round for it. So, plainly: **the literature's recommended
configuration for volumetric clouds requires TAA, and this renderer should
probably have it.**

> **Half of this is now out of date, and only half.** Corrected 2026-08-16 by
> the correctness-and-truth round. An ocean TAA *does* exist —
> `src/render/OceanTemporalResolve.ts`, opt-in behind `?oceanTaa=1`
> (`src/runtime/RuntimeOptions.ts`), off by default, and the terrain round
> confirmed it renders correctly under all three depth modes. What remains
> genuinely absent is the **global/cloud** TAA this item is actually asking for:
> nothing reprojects the sky or the cloud march, so the literature's "8 steps +
> jitter + TAA" configuration is still unavailable and the argument below stands
> unchanged. The blanket phrasing "no TAA exists in this codebase" was the false
> part; the recommendation was not.

What the measurements in the literature actually say (Toft, Bowles &
Zimmermann 2016, `arxiv.org/pdf/1609.05344`, 1920x1080 on a GTX 1080):

| configuration | draw time |
|---|---|
| full res, 128 raymarch steps | 297.7 ms |
| half res, 128 steps | 128.0 ms |
| half res, 8 steps | 2.3 ms |
| half res, 8 steps + jitter | 7.5 ms |
| half res, 8 steps + jitter + TAA | 7.5 ms |
| quarter res, 8 steps + jitter + TAA | 2.4 ms |

The mechanism: a per-pixel random offset to the march's START position means
neighbouring pixels sample different depths in the volume, which recovers the
structure a low step count throws away — at the cost of a very noisy image.
TAA then resolves that noise temporally. The two are a package; jitter alone
is strictly worse-looking than no jitter for a still frame, which is why this
round did not take it in isolation.

Two things this codebase would gain beyond clouds:

- The whole residual sparkle the aliasing hunt could not remove — see
  "Temporal AA (or supersampling) as the endgame" above — is the same problem.
  One TAA implementation pays for both.
- The cloud march could then run at 3-4 steps instead of 8 and look *better*
  than it does now, which is a large net perf win rather than a cost.
  > **Both numbers are stale.** Corrected 2026-08-16. The march is
  > `CLOUD_MARCH_STEPS = 192` (`src/scene/Ocean.ts`), on both quality presets,
  > and it does not run per screen pixel at all — it runs once per cache texel
  > in the bake. The *shape* of the argument survives (a temporal jitter buys
  > steps back) but the ratio does not, and the thing to spend down would be the
  > bake's budget, not a per-pixel one.

A breadcrumb for that round, updated by the cloud-cache round: the march no
longer runs per screen pixel anywhere. CloudDome.ts bakes cloudBake()'s
factored accumulators into camera-visible tiles of a direction-indexed
equirect (a guarded tile cycle every 60 rendered frames), and the dome relights
them per frame with cloudLayerCached(). The bake compiles the default
`CLOUD_MARCH_DITHER 1.0`
— its grain lives at cache-texel rate and bilinear magnification is its
resolve; the ocean's `0.0` compile survives only in that material's
unreached cloudLayer code. When TAA lands, the dither becomes temporal
(IGN + frame index) across bake sweeps, and the bake's 96-step budget is
the place to spend down — at one sweep per second it is no longer the
frame's bottleneck, but it is still most of what a sweep costs.

> **Superseded from "The bake compiles" onward.** Corrected 2026-08-16 by the
> correctness-and-truth round. `CLOUD_MARCH_DITHER` no longer exists in the
> codebase in any form: commit `35d866f` ("Delete the cirrus deck, march at 192,
> and retire the march dither") removed the interleaved-gradient offset outright
> rather than turning it down, because at cache-texel rate its grain was not
> resolving — it was being magnified ~1.8x into the woven comb across every
> cloud. Bilinear magnification was the problem, not the resolve. The step count
> rose from 96 to **192** to pay for the removal honestly, so the bake's budget
> is 192 and not 96.
>
> The paragraph's *conclusion* is unaffected and still correct: when TAA lands,
> a temporal jitter (IGN + frame index across bake sweeps) is the thing to add,
> and the bake's budget is where to spend it. That is what the shader now says
> at `src/scene/shaders/lib.ts` — "If TAA ever lands, a TEMPORAL jitter would be
> the thing to add — not this."
>
> See `docs/clouds/CLOUD_SHAPE_FINDINGS.md` for the closed-out comb analysis.

Machinery required: sub-pixel camera jitter on a Halton sequence, a history
buffer with reprojection by motion vectors, and rejection heuristics for
disocclusion. Known risks: ghosting behind the raft and on fast camera moves,
and the ocean's specular highlights are exactly the high-frequency content TAA
history handles worst. `jpgrenier.org/clouds.html` and Playdead's
reprojection talk (GDC 2016) are the practical references.

### Worley noise for the lump field

`cloudLumps` is a domain-warped fbm of 3D value noise. It started as
Musgrave's billow basis, `abs(2v - 1)`, on the reasoning that convex lobes
meeting in sharp creases is what cumulus shape wants — and that basis had
to be abandoned, which is worth knowing before anyone reaches for it again.
`abs()` folds the field about its mean, so every `v = 0.5` contour becomes a
crease with matched ridges either side: closed concentric rings around every
hill and valley, which is exactly how procedural marble is made. Ash saw it
immediately as "concentric swirls". A domain warp sheared the rings apart but
left thin dark seams, because where the fold hits zero the erosion peaks along
a curve and no amount of warping removes a zero. Plain fbm has no fold, hence
no rings and no seams; its lobes are softer than Worley's but they are honest.

Worley (distance to the nearest scattered feature point) is the real answer
and is what Nubis, and nearly every shipped volumetric cloud since, uses: it
gives convex caps with creases *without* a fold artefact, because the creases
are cell boundaries rather than level sets.

**It was deferred for the wrong reason, and that deferral is now overridden.**
An earlier draft of this item said to do it "behind a real measurement on Ash's
hardware", because a correct 3D Worley octave is 27 cell probes against value
noise's 8, inside a loop that runs `CLOUD_MARCH` times per pixel, and
`gl.finish()` does not synchronise in the agent browser so nothing could be
profiled. (That last clause is stale as of 2026-08-16: `src/render/GpuProfiler.ts`
measures GPU time properly, so "nothing could be profiled" is no longer the
reason — see the GPU-timing item above. The deferral was overridden anyway, so
nothing about this item changes.) Ash's direction is explicit: build for looks first, and treat
performance as a separate later round — see `docs/clouds/CLOUDS_ROADMAP.md`, which is the
authority on ordering. So: **build it, note what it probably costs, do not gate
it.**

There is a fork worth deciding deliberately rather than by default:

- **Evaluate analytically** — 27 probes, roughly double the lump field's cost,
  keeps the codebase's texture-free noise philosophy and keeps the CPU mirror
  straightforward. This is the recommended starting point. Cheap 8-probe
  variants can miss the true nearest point, which shows as cell-boundary
  discontinuities; check any such variant against the `stability()` probe in
  `tools/cloud-evidence.js`.
- **Bake a 3D texture** — what Nubis actually does (a 128³ RGBA volume plus a
  32³ detail volume, generated offline), so runtime is a texture fetch rather
  than 27 hashes. Much cheaper and the industry norm, but it breaks the
  analytic-noise principle, adds generation machinery and an asset, and makes
  the CPU mirror awkward: `TimeOfDay.ts` would need the same volume in memory or
  an analytic approximation of it, and the parity test exists precisely because
  those two drifting apart is silent. This is the perf round's escape hatch, not
  a first choice.

Whichever is taken, Worley's extra high-frequency content needs the same Nyquist
fade treatment as the existing lump and puff terms.

### ~~Cloud aspect ratio~~ — done

Ash approved changing it directly ("they were not deliberate choices before").
Landed: base 1500 -> 1100 m (where trade cumulus actually condense), top
3600 -> 3300 m, and cells 2083x1613 -> 1299x1010 m, taking a cumulus from
about 4:1 to near 1:1. `CLOUD_MID` moved 2550 -> 2200 m as a consequence and
nothing keyed to it cares: the sun-ray air mass at altitude shifts 4 %, the
sunset dip a tenth of a degree, the gas sky's own colour not at all.
- Slope-jitter gain `0.25` and clamp `0.30` (`Ocean.ts`, roughness stage)
  — how much measured per-pixel slope spread widens the specular lobes.
- Detail octave count, desktop `5` (`OCEAN_QUALITY_DESKTOP`). Chosen to put
  the drawn-slope / lobe-width ratio at 0.91 for the shipping moderate sea;
  `6` measures 1.58 with a 4.3 cm finest cell and is the obvious next thing to
  try, but it narrows the glitter lobe from 10.2° to 7.4° and so retunes the
  daylight sun path — wants an A/B before anyone takes it. **The frame cost of
  5 has not been measured on real hardware**: it was reasoned from the Nyquist
  fade (the fine octaves are dead past ~10 m) and verified only in a
  backgrounded browser tab, where frame pacing is forced and fps readings are
  meaningless. Check it on a warm desktop session before shipping.
- **Night visibility and moonlight were completed and visually dispositioned** —
  `docs/graphics/NIGHT_VISIBILITY_SPEC.md`, which must be built on this branch rather than on
  `main` (every measurement in it was taken after the airglow cut). It covers
  the scotopic-vision pass, its display calibration, and the moon retune. Ash
  rejected the first, so it ships at 0% and the calibration is opt-in only; the
  moon remains and was re-gated without the observer.
- **The night was deepened; the moon still needs the same treatment.**
  `NIGHT_BASE_GAIN = 0.25` (`shaders/lib.ts`, mirrored in `TimeOfDay.ts`) cuts
  the airglow floor to a quarter, and the exposure ceiling rose 2.3 → 3.0 so
  the meter can follow it down instead of the picture simply going dark. That
  bought about 2 stops of the missing range. **The moon did not get the same
  pass and badly needs one**: measured, a *full moon* moves the night ambient
  by 1.21× before the cut and 1.8× after, where reality is 100–300×. So a
  moonlit night and a moonless one still look nearly identical, which is the
  single most obviously wrong thing left in the night sky. `moonPower = 0.070`
  (`TimeOfDay.ts`) is the dial, and it interacts with `moonSpecularGain = 3.5`
  in the optics profile — raising one without the other will break the moon
  glitter's calibration.
- **The world spans 6.5 stops; the real one spans about eighteen.** Measured
  ambient radiance from `TimeOfDay` *before* the cut above: 2.88 at 60° sun,
  3.29e-2 at −25°. A ratio of 88. Everything authored as an absolute brightness
  therefore sits on a compressed axis, and nothing that is constant across the
  day can be right at both ends of it — the lamp was the first case where that
  bit, but it is not a lamp problem. Two related measurements worth keeping:
  - Between the lamp switching on (−5°) and deep night (−25°) the ambient
    falls by only 1.37× (0.45 stops), so the lamp is equally useful across the
    whole of night. The interval where it *should* be visibly taking over —
    +2° to −6° — is where ambient falls 13.6×, and the hysteresis switch sits
    inside it. So the switch is well placed, but the lamp arrives at full
    strength rather than growing into usefulness.
  - At noon the lamp's irradiance at 2 m is ~25% of ambient; a compression-
    consistent model (γ ≈ 0.36 from the stop counts above) would put it near
    10%. So daylight over-strength is under a stop — much less than it looks.
    What actually makes a daytime lamp read wrong is the specular peak, which
    is `D/(4·N·V) ≈ 250` and blows to white at any ambient level.
- Lamp-on-water gain, now DERIVED: `FLAME_INTENSITY × OCEAN_PER_DECK_IRRADIANCE`
  = 1.9 × 2.30 = 4.37 (`Ocean.ts`). The 2.30 is the measured ratio between the
  ocean's irradiance scale and three.js's light units, taken on the sun at 60°
  where both renderers are honest; it drifts below ~10° because the deck side
  carries a `^0.52` compression for the sail that the ocean does not. If that
  compression is ever revisited, re-measure.
- Near-surface scatter reflectance `LAMP_SCATTER = 0.008` (`Ocean.ts`). Set by eye
  against the night raft at 22:30 with a Graphics-panel slider ("Lamp on
  water"); the glitter term is calibrated so the column's core just blows
  while the body of it holds 2100 K, and the scatter so the water beside the
  raft is legible without becoming the old pedestal. Both want a pass against
  real lantern-on-water reference, and a look at a whitecap breaking inside
  the pool — the foam term has not been seen at a sea state that produces one
  within a few metres of the raft.

---

# Findings from the ship M1 round

> **The lighting work this section calls for HAS LANDED — read it as history.**
> Marked 2026-08-16 by the correctness-and-truth round, which found the whole
> section still reading as open work.
>
> The scene-wide probe that items 1-3 ask for is built and shipping. The world's
> indirect light is now an L2 spherical-harmonic probe for diffuse plus a PMREM
> for specular, both convolutions of one camera-independent source, published
> together by `WorldLighting` through
> `EnvironmentRuntime.refreshWorldLighting` and assigned as `scene.environment`
> at `envMapIntensity = 1` (`src/runtime/EnvironmentRuntime.ts`,
> `src/main.ts`). It replaced the two-colour `HemisphereLight`, and it applies
> to the whole scene rather than to nine ship materials.
>
> Consequently **"THE HACK THAT MUST BE REMOVED" below has been removed.** There
> is no `SkyProbe` class, no `ENV_INTENSITY`, no `* 2.2`, and no
> `src/ship/Ship.ts` — that file does not exist and its links below are dead.
> The vessel is `src/vessel/schooner/Schooner.ts`.
>
> **What is still owed is the re-judgement this section demanded**, and it is
> not bookkeeping. The section's own warning — "every look decision taken during
> M1 was made against a lighting model missing its largest term" — came true
> twice over: `Schooner.ts` records that the hull roughnesses were fitted
> against a 0.3-strength probe and have been reflecting the sky at 3.3x that
> strength ever since, and that the comment "at 0.72 there was almost no sheen"
> was "a true statement about a renderer that no longer exists". One pass of
> that has been re-derived; `shipPalettes.ts` has not. Re-running the contact
> sheet and judging the finish from scratch is a look verdict and belongs to
> Ash, not to a correctness round.

Written 2026-08-01 at the close of M1. **Point a new session at this section.**
Everything here was measured in the running app, not reasoned about — most of it
was found the slow way, by repeatedly blaming the wrong thing.

The trigger: the schooner's topsides rendered as a featureless black mass and
three rounds of palette changes could not fix it. The paint was never the
problem.

## 1. Nothing in this game has ever had a reflection map

`scene.environment` is `null` and no material carries an `envMap` — not the
ship's, not the raft's, not the figure's. Every solid object is lit by direct
light plus a `HemisphereLight` and nothing else.

**Why that is fatal for a hull and merely survivable for a raft.** A dark glossy
surface in daylight is mostly visible because of what is *reflected in it*. Strip
that away and all that is left is albedo times direct light, which on a vertical
face is very little. Measured on the schooner's topsides at noon, broadside:

| | Rendered pixel |
|---|---|
| Without a reflection probe | (13, 8, 5) |
| With one | (67, 60, 59) |

Same paint. The raft has almost no vertical surface, so it never showed.

**This is the root cause and the headline item for a graphics round.**

## 2. The hemisphere light is a two-colour stand-in for a sky we already model

`SkySystem` and `SkyRadianceLut` compute real sky radiance — the ocean uses it.
Object lighting ignores all of it and uses two hand-picked colours
([main.ts](src/main.ts), `skyFill`), driven by `ambientSkyColor` /
`ambientGroundColor`.

Proper fix: generate a probe from the sky model that already exists and use it
for both diffuse irradiance and specular, scene-wide, **replacing** the
hemisphere light rather than stacking on it. That fixes the raft and every
future object at the same time.

## 3. The water bounce is hand-authored constants

[TimeOfDay.ts:715](src/scene/TimeOfDay.ts:715) — "bounce off the water is dim,
cool and desaturated" — is a fixed ramp with a little sky chroma mixed in. It
does not know the sea state, the sun glitter, or the ocean's own computed water
colour sitting in `oceanOptics.ts`.

Currently it runs at **63% of sky radiance**, which is a defensible number for a
vertical surface near a daylit sea, so this is not the black-hull culprit. It is
still wrong in kind: the lower hemisphere should come from the ocean's real
optics, including the glitter path. Reflecting the actual glitter is a large part
of what makes a hull look like it is floating *in* water rather than on a blue
plane.

## 4. Ship meshes had shadows switched off — fixed

Shadow mapping is enabled and the sun casts, but all nine ship meshes had
`castShadow` and `receiveShadow` false. The bulwark did not shade the deck, the
hull did not shade itself, she threw nothing on the water. **Now on** in
`Ship.ts`. Worth auditing the rest of the scene the same way, and checking the
shadow camera's extent actually covers a 16 m vessel.

## 5. Vertical faces are starved by sun angle, not by ambient — check before blaming paint

Measured at 76° solar elevation:

| | Deck (up-facing) | Hull side (vertical) |
|---|---|---|
| Ambient | 0.936 | 0.763 |
| Direct sun | 6.842 | 1.728 |
| **Total** | **7.778** | **2.491** |

Ambient alone is only a 1.23× difference. The 3.12× total is almost entirely the
sun's angle — direct sun is 7.5× the whole ambient fill. **A hull side at noon is
supposed to be much darker than the deck.** Judging paint at noon, or with the
sun across the hull rather than on it, is how M1 produced three separate "too
dark" verdicts before anyone checked where the sun was.

## 6. The FLAT sea state looks wrong, and it is in nobody's test path

`FLAT` renders as a mirror-smooth plane and reads as obviously fake — no
micro-detail, no breakup, nothing for the eye to scale against. It is a debug
preset (zero amplitude) that gets used for beauty shots because it is the
obvious choice for "calm".

Two separate things to do: give `FLAT` enough surface detail to be *lookable* at
even with no waves, or accept it as diagnostic-only and make `DEAD_CALM` the
calm-water reference. The ship contact sheet has already moved to `DEAD_CALM`
for exactly this reason.

## 7. Exposure is unverified in this context

Tone mapping is on at `toneMappingExposure` 0.335. Nobody has checked whether the
dark end is being crushed by the curve rather than by the material. Worth doing
before any further palette judgement.

---

## THE HACK THAT MUST BE REMOVED — *removed; kept for the reasoning*

> **Done.** The world lighting round deleted `SkyProbe`, `ENV_INTENSITY` and the
> `* 2.2`, and replaced them with the scene-wide probe described at the head of
> this section. `src/ship/Ship.ts` no longer exists; the links in this subsection
> are dead. Left in place because the *diagnosis* is the durable part — a fill
> light standing in for 87% of the light on a surface, tuned by eye against a
> double-count, is a shape of mistake worth recognising again.

`SkyProbe` in `src/ship/Ship.ts` (deleted) was **a prop, not a lighting
model.** It existed so M1 could be looked at, and the graphics round should delete
it, not build on it.

What it does: builds a 128×64 equirectangular gradient — zenith, horizon, sea —
runs it through `PMREMGenerator`, and assigns the result as `envMap` on the
ship's nine materials only. Rebuilt when the sun moves 2°.

Why it is wrong:

- **It stacks on top of the `HemisphereLight` instead of replacing it**, so
  diffuse irradiance is counted twice. `ENV_INTENSITY` is 0.3 purely to stop her
  glowing — it is a fudge against a double-count, not a physical quantity.
- **It is supplying 87% of the light on the topsides.** The sun and the fill
  contribute almost nothing there. That is not a lighting model, it is a lamp.
- **The sky gradient is invented**, not sampled from `SkySystem`, and the sea
  half is invented rather than taken from the ocean's optics.
- **The `* 2.2` magnitude in [main.ts](src/main.ts)** where
  `updateEnvironment` is called was hand-tuned by eye in a browser console.
- **It is scoped to the ship only**, so the raft still has no reflections and the
  two objects are now lit by different models in the same scene.

Replacing it with a real scene-wide probe (items 1–3) makes all of that go away.

## What is safe to keep, and what must be re-judged

| Change | Status |
|---|---|
| Ship self-shadowing (`Ship.ts`, now `vessel/schooner/Schooner.ts`) | **Keep** — correct independently |
| `setAzimuth` on the cinematic camera | **Keep** — capture infra |
| `preserveDrawingBuffer` for the ship viewer | **Keep** — capture infra |
| Ship palette (`shipGeometry.ts`) | **Canonical/original.** Reverted to the values `docs/ship/SHIP_SPEC.md` §16 always specified. Unchanged from the first M1 build. |
| Topsides roughness 0.72 → 0.52 (and wales, transom, boot-top) | **Re-judge.** Tuned against the broken lighting. |
| `SkyProbe` + `ENV_INTENSITY` + the `* 2.2` | **Deleted** — done in the world lighting round |

**Every look decision taken during M1 was made against a lighting model missing
its largest term.** The palette, the roughness, the boot-top width, the pale
below-waterline finish — none of those verdicts should be trusted until items 1–3
are done. Re-run the contact sheet afterwards and judge again from scratch.

## Fixed during M1, recorded so it is not re-broken

**Two bodies were advancing one wave field.** `HullBuoyancy.update` calls
`waves.advance(step)` inside its substep loop, and with the ship viewer open both
the raft's body and the ship's body did it — measured at **8 advances per frame
against 4 physics substeps**, so the sea ran at double speed and every body
integrated against a surface that had jumped twice as far as it expected.

Fixed with `advancesWaveField` on `HullBuoyancyOptions`, default true. The raft
owns the field; `Ship` opts out. **Flip it the day she replaces the raft**, or
she will float on a frozen sea. Headless tests build their own field per body and
must keep the default — that is what the flag being a call-site option rather
than a baked-in constant is for.

## Regenerating the evidence

The canonical ship contact sheet — eight shots spanning angle, distance, sun
elevation, which side the sun is on, and sea state:

```
npm run capture-server            # writes into evidence/
# then open, in a *visible* window:
#   http://localhost:5173/?debug=ship&sheet=1
```

Shot list and capture code: [src/debug/shipContactSheet.ts](src/debug/shipContactSheet.ts).
`CANONICAL_SHIP_SHOTS` is the reference set — change it deliberately.
From the console at any time: `shipViewer.contactSheet()`.

**Aspect and lighting are independent axes, and the harness keeps them that
way.** A shot asks for an `aspect` (broadside / bow quarter / stern quarter) and
a `sunSide` (front / cross / back). The solver sets the sun by *elevation only*,
then orbits the camera to wherever the requested `sunSide` sits relative to the
sun's real bearing, then yaws the ship so the requested aspect still faces that
camera. The first version drove both off one camera angle and asked the clock to
supply the bearing — which the astronomy frequently cannot, so half the set came
out back-lit without saying so. Both are now measured and printed into every
label and into `evidence/ship-contact-sheet.txt`.

Three traps already paid for, all fixed in the harness:

- **A hidden or backgrounded tab collapses the canvas to 2×2 pixels.** The first
  working sheet was eight correctly-labelled rectangles of flat colour. The
  capture now pins its own framebuffer size and restores it afterwards, so it no
  longer depends on anyone watching.
- **`preserveDrawingBuffer` must be on** or the readback returns cleared frames.
