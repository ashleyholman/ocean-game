# The cloudless band above the horizon

**2026-08-03. Diagnosed, fixed, benchmarked, and rejected on look.**

The code is on the tag `rejected/horizon-cloud-band-2026-08-03`. Nothing from it
is on master. The diagnosis below is sound and the defects are all still
present; the cure is not one to repeat.

---

## 1. What Ash saw

> "what's that light coloured layer we have in the sky just above the horizon?
> it seems to step over the clouds and actually we see no clouds in that band.
> i think in real life, clouds continue all the way down to the horizon."

The light-coloured layer is not a layer. It is the sky's own **pale horizon
band** — the multiple-scattering term in `inscatter()`, whose stated job is to
paint that blue-white strip, shaped by `AM_VIEW_CAP`. Nothing is drawn over the
clouds. The clouds are simply absent below about three degrees of elevation, so
the bare sky shows through, and the deck's lower edge reads as a step.

Ash was right about the reality. A cumulus base at 1100 m stays above the
geometric horizon out to 118 km, and everything beyond about 30 km is crammed
into the bottom two degrees — real skies show a crowded, low-contrast, hazy mat
all the way to the waterline.

## 2. Three causes, not one

Three multiplicative fades kill the deck near the horizon, in `cumulusDeck` and
its mirror in `cloudBake`. Evaluated in the cache raster they are baked into:

| elevation | distance to deck | `cloudRes` | `haze` | product |
|---|---|---|---|---|
| 20° | 6.4 km | 1.00 | 0.76 | 0.76 |
| 10° | 12.7 km | 1.00 | 0.59 | 0.59 |
| 5° | 25 km | 0.90 | 0.35 | 0.31 |
| 4° | 32 km | 0.45 | 0.27 | 0.12 |
| 3° | 42 km | **0.00** | 0.17 | **0.00** |
| ≤2° | 63 km+ | 0.00 | 0.07 | 0.00 |

**a. `cloudRes` fades the deck to ZERO below its Nyquist limit — the binding
cause.** Hard zero under ~3.2°. The fade exists for a good reason (point-sampling
a field whose cells are smaller than a texel is the TV-static bug that cost a
whole round), but *unresolvable cloud is not absent cloud*. Fading to
transparent is the wrong limit.

**b. The haze is a uniform-slab `exp(-t · β)`.** Marine aerosol lives in the
boundary layer, roughly an exponential with a 1.2 km scale height, and a ray
reaching a cloud base at 1100 m leaves most of it behind in the first kilometre.
The uniform form over-hazes the entire sky: 41% of a cloud's radiance removed at
ten degrees, where the honest figure is about 16%.

**c. The projection is flat-earth, with a `max(dir.y, 0.016)` clamp.** `t = z/y`
diverges at the horizon, so it had to be clamped — which pins every direction
below 0.92° to a single distance. Azimuth still varies there and elevation does
not, so the deck at 0.92° is **extruded straight down to the waterline as pale
vertical curtains**. They were invisible only because (a) and (b) had already
zeroed the band. The moment the band was drawn at all, they were the first thing
in it.

Cause (c) was found by experiment, not by reading: a probe that removed only
`cloudRes` produced obvious vertical streaks, and changing the clamp floor from
0.016 to 0.002 — with nothing else touched — removed them completely.

## 3. What was built

**Spherical geometry.** `cloudShellDistance(z, y)` solves
`(R+z)² = R² + t² + 2Rty`, giving `t = √((Ry)² + 2Rz + z²) − Ry`. Finite and
continuous down to `y = 0`, where it returns 118 km for the base and 206 km for
the top. No clamp needed, so no curtains. `cloudRayAltitude` gives the marched
sample its curved altitude, which matters once a low ray covers tens of
kilometres.

**Mean-field density.** `cloudMeanDensity(h, threshold)` stands in for the shape
field once a texel is wider than the cells it samples, cross-faded by the old
`cloudRes` inverted. Past the limit it never evaluates `cloudShape` or
`cloudLumps`, so a band step costs a gradient and a `pow` instead of six 3D
noise evaluations — the band's texels came out roughly **3× cheaper** than
ordinary sky texels.

> The fit had to be **measured, not derived.** The obvious analytic route — treat
> the fbm as Gaussian and integrate the density ramp against it — is accurate
> near the field's mean and badly wrong in the tail, which is exactly where the
> default cover threshold sits. Measured against the real field it came out
> **4.4× too dense at `uCloudCover` 0.70**, and gave a nonzero mean at thresholds
> the bounded field can never reach. A shaped ramp least-squares fitted to the
> measured mean over a (threshold, gradient) grid held residuals under 0.03 in
> density units, with an exact zero past the field's own maximum.

**Boundary-layer haze.** `cloudHazeTransmittance(y)` integrates an exponential
aerosol profile, with the grazing path bounded by the Chapman saturation
`√(πR/2H)` rather than diverging as `1/y`.

## 4. Why it was rejected

> "rather than the same kind of clouds continuing down to the horizon, that band
> looks completely different."

Correct, and the reason is structural rather than a tuning miss. Two compounding
mechanisms:

**Alpha saturates.** Over a grazing chord `1 − exp(−τ)` pins at 1 wherever the
cover field dips, and the fit is exactly 0 past threshold ~0.774. The band comes
out **near-binary** — solid wall or nothing, with only a narrow transition —
instead of a graded recession.

**The opaque parts are lit as if they were thin.** In the mean-field regime the
local density is ~0.015, spread over tens of kilometres. `cloudSunTau` integrates
that same small number along its ~1.4 km sun ray and returns ≈ 0.0001, so every
sample takes full multiple-scattering gain with no powder darkening, at maximum
radiance, while the view integral accumulates to α = 1. Fully opaque *and* fully
lit is a white wall.

**Mean density is the right answer for how much cloud lies along the ray and the
wrong answer for how shadowed that cloud is.** A statistical mean cannot look
like the same clouds continuing. If this is ever retried, it has to keep marching
the *real* field further down — more cache rows near the horizon, a supersampled
bake in those rows, or TAA — not substitute an average.

## 5. Measurements

**Cost.** Real Chrome driven over CDP; six interleaved reps per arm; pooled raw
GPU timer samples (n ≈ 550 per arm); 1280×713 at fixed device pixel ratio.

| | before | after | |
|---|---|---|---|
| GPU frame total (median) | 20.62 ms | 22.65 ms | +9.8% |
| cloud-cache bake | 10.48 ms | 11.28 ms | +7.7% |
| sky + cloud draw | 1.28 ms | 1.21 ms | −5% |
| observed fps | 41.1 | 37.6 | −8.5% |

A first pass cost +17–31% on the bake; coarsening the step once the field has
collapsed to its mean, with an early loop exit, brought it to +7.7%.

**The premise that the cache would have to grow was wrong.** The cloud cache is a
*direction* map — 6144×1280 over elevations −3.4°…90°, rows warped toward the
horizon by `v = t^0.6`. Tile rows 0 and 1 of 10 span −3.4°…2.95° and were already
allocated, resident, refreshed and baked *empty*. Drawing the band enlarges
nothing; only ~7% of dome texels newly shade.

**Coverage and the sea.** `uCloudCover` stayed 0.70 — the weather field is
bit-identical — but the *rendered* sky went from 10.7% to 13.0% covered, with
dome-mean cloud alpha +22.5%, essentially all of it below 6°. The water paid for
it: saturation −2.4% far, −1.8% mid, **−5.0% near**, luminance up. That is
precisely what the 41% → 14% cover tuning documented in `SkySystem.ts` was
protecting, and it means the "about 14%" in that comment is a statement about
the current fades as much as about the threshold.

## 6. Lessons worth keeping

**On the work.** Three rounds of fades had accumulated on top of each other, each
compensating for the one below. The haze constant was fitted against a
uniform-slab geometry; the resolution fade was covering for a projection that
could not reach the horizon; the horizon fade was covering for both. Fixing the
geometry alone bought 1–2°, because the next fade down was still binding — the
same pattern as the stale hull roughness. **A constant fitted against a wrong
model has to be re-derived when the model is fixed, not carried over.**

**On measuring.** Every one of these was real and cost time:

- A second game instance rendering in the Claude browser pane made an entire
  benchmark batch 2–3× off.
- `git stash` between A/B arms also stashes the `window.__drift` dev export the
  harness reads. Copy files between arms instead.
- devicePixelRatio 2 on this machine is bimodal (11.5 vs 24 fps within one arm,
  GPU power states). Use dpr 1 and pool raw `gpuProfiler.rawSamples` across reps
  rather than taking a median of per-run medians.
- Real Chrome over CDP is the only way to get GPU timings at all; the in-app
  browser pane throttles rAF when hidden, so the profiler never leaves warm-up.
- A coverage figure was reported from the CPU mirror — which runs point-sampled
  at `far = 0` — as though it described the *drawn* band. It did not. Same class
  of error as the rig round: the test measured the wrong object.

---

## Still open

The three defects in §2 are all still in the code. Nothing here was merged.

- Clouds still stop dead at ~3.2°, and the pale horizon band still shows through
  where they should be.
- The uniform-slab haze still removes ~41% of a cloud's radiance at ten degrees.
- The `max(dir.y, 0.016)` clamp still extrudes the deck below 0.92°, and will
  produce visible vertical curtains the moment anything draws cloud down there.
