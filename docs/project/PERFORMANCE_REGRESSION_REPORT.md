# Cross-revision GPU performance report

> Historical report recovered on 2026-08-09 from Codex snapshot
> `b4ef4f2`. The original 99 raw JSON files lived in the ignored
> `perf-results/` directory of retired worktree `d6d4` and were not retained
> when that worktree was removed. The measurement summaries and methodology
> below are intact; the restored harness will create a fresh result feed. The
> recoverable numeric summary is also preserved in
> `evidence/performance/2026-08-03-summary.json`.

## 2026-08-09 master refresh

### Verdict

The cool-machine rebaseline reproduces both old anchors, so the host has not
become generally slower. The current master endpoint `f3d542c` is nevertheless
slower than the previously benchmarked master `38440b5` in every representative
scene. The central day case rose from **14.013 ms to 17.006 ms**: **+2.994 ms,
+21.4%**. The rough case rose by **+3.963 ms, +22.1%**.

This is a real regression in the dashboard contract, but it does not by itself
reproduce the reported live-game fall from roughly 30–33 FPS to 20–22 FPS. The
dashboard freezes presentation state and measures a fixed 2560×1440 backing
store; its current central result is about 58.8 GPU-fenced FPS. Resolution,
live simulation, sustained thermals, or another gameplay-only path still has to
explain the rest of the observed absolute gap.

### Rebaseline and current endpoint

Each value is the mean of two alternating round medians.

| Scenario | Recovered `38440b5` | Fresh `38440b5` | Current `f3d542c` | Current vs fresh prior | Change % |
|---|---:|---:|---:|---:|---:|
| Day · production · medium | 14.069 | 14.013 | 17.006 | +2.994 | +21.4% |
| Sunset · production · medium | 13.381 | 13.400 | 16.306 | +2.906 | +21.7% |
| Night · production · medium | 13.706 | 13.638 | 15.681 | +2.044 | +15.0% |
| Day · calm · medium | 13.206 | 12.756 | 14.988 | +2.231 | +17.5% |
| Day · rough · medium | 17.919 | 17.938 | 21.900 | +3.963 | +22.1% |
| Day · production · close | 14.725 | 14.506 | 15.300 | +0.794 | +5.5% |
| Day · production · high | 13.213 | 13.094 | 15.031 | +1.938 | +14.8% |

The older cloud-cache anchor `513fe5a` also reproduced: fresh values differ
from the recovered seven-scenario baseline by at most 0.35%. Six of seven fresh
`38440b5` values are within 1.5% of the recovered baseline; calm is 3.4% faster.
That is strong evidence that the short-run machine baseline is still valid.

Current central attribution is ocean **9.254 ms**, vessel with ocean hidden
**1.288 ms**, and vessel-and-lights-only **0.788 ms**. At `38440b5` those values
were **6.996 ms**, **0.842 ms**, and **0.700 ms**. The full-scene vessel toggle
is negative on current master because hiding the vessel exposes more expensive
water pixels; it is not evidence that the vessel is free.

### Localised changes

The complete first-parent sweep covered **55 revisions × 2 reversed rounds =
110 raw points**. It found the right candidate regions, but the 22-minute run
heated the M2 enough that its absolute curve is not valid for adjacent-commit
ranking: the same `38440b5` revision measured 14.05 ms at the cool start and
20.31 ms at the hot end. Short four-round alternating brackets established the
following accounting instead.

| Boundary | Mean/robust change | Interpretation |
|---|---:|---|
| `38440b5` → `5a90393` | +0.506 ms | Cumulative cost across the early ship/deck/terrain interval; no large single cliff survived short-run checking |
| `7bcbd8b` | +0.350 ms | Camera composition change; requested distance stays 34 m but actual altitude rises 8.75→12.87 m, increasing measured ocean cost |
| `7bcbd8b` → `4c64b9f` | +0.281 ms | Small cumulative wake/sailing cost before the wake repair merge |
| `0de168d` | **+0.619 ms** | Wake repair/Kelvin pattern; robust median after one thermally invalid final pair, with ocean contribution +0.592 ms and vessel-only flat |
| `ee69193` | **+1.178 ms** | Largest confirmed cliff: ocean-look shader/optics work; ocean contribution +1.327 ms, draw calls/triangles and vessel-only cost flat |

The known intervals sum to **+2.934 ms**, leaving only about **+0.060 ms** of
the +2.994 ms endpoint regression across the two unbracketed tails. A retry of
the post-wake tail was rejected after the same revision climbed from 15.99 ms
to 29.13 ms as the host throttled; its first cool adjacent pair was effectively
flat. The evidence therefore supports three actionable causes: the ocean-look
shader is the dominant regression, the wake-repair shader is second, and the
vessel-aware camera's changed composition is third.

The `ee69193` shader adds wave-scale sky occlusion, sparkle redistribution,
rough-water Fresnel handling, detail-shape/value work, and additional wake-foam
breakup logic. The bracket cannot price those subfeatures individually, but it
does place the cost in the ocean fragment path rather than geometry. The next
useful optimisation campaign should A/B those ocean-look controls inside the
same revision before changing unrelated ship code.

### Thermal caveat and retained data

The long history run and one later bracket demonstrate substantial sustained
thermal sensitivity on this host. That does not invalidate the cooled endpoint
or short stable brackets; it does mean long uninterrupted campaigns must be
split into cooled chunks or interpreted only as candidate-finding passes. The
dashboard now warns when repeated-round spread reaches 1 ms and orders master
history by first-parent position.

All **164 raw JSON files** from this refresh are retained under `perf-results/`
and labelled as separate dashboard datasets, including the thermally rejected
diagnostic bracket. The compact accepted summary is in
`evidence/performance/2026-08-09-summary.json`.

## 2026-08-03 historical campaign

Measured 2026-08-03 on Apple M2, from cloud-cache baseline `513fe5a` to
`38440b5`.

## Result in one sentence

The current game is substantially faster than the cloud-cache baseline in
every tested view: the central day case fell from **24.675 ms to 14.069 ms**
(-10.606 ms, **-43.0%**), even after adding the schooner, lighting work,
geometry shadows, camera work and full rig.

The recent features did add measurable cost after the fastest intermediate
revision. The largest verified late costs are direct geometry shadowing of the
water (about **+0.75 ms** by day) and the complete rig (about **+0.59 ms** in
the representative day view). These are much smaller than the earlier ocean
optimisations.

## Measurement contract

- Real standalone Chrome: `--headless=new --enable-gpu --use-angle=metal
  --window-size=1600,1000`.
- App bootstrap at a desktop viewport, followed by a measured 1280×720 CSS
  render surface at DPR 2.
- Verified **2560×1440** WebGL drawing buffer.
- Verified desktop ocean grid: **165,888 ocean triangles**.
- Synchronous render batches fenced with 1×1 `readPixels`; no `gl.finish()`.
- `PIXEL_PACK_BUFFER` explicitly unbound before each fence. This is necessary
  after async world-lighting readback was introduced; otherwise `readPixels`
  can return immediately without fencing the GPU.
- Canonical world time paused at the report's fixed day, sunset and night
  instants (`t0=1768532100`, offsets +21.6 h, +17 h and +10 h).
- Presentation waves and foam frozen during timed samples.
- Explicit production, calm and rough seas and explicit close, medium and high
  camera positions.
- Two endpoint rounds in alternating revision order. Each displayed endpoint
  value below is the mean of the two round medians.

The host preflight inventory was recorded with every JSON result. The user had
cleared active competing game/browser sessions; several idle OS/application
GPU helpers remained visible, so the run was deliberately not made with
`--strict-preflight`.

## Recalibrating the old cloud-cache number

The `CLOUD_CACHE_REPORT.md` figure of about 17.9 ms for day did **not**
reproduce in the standalone Metal launch. The corrected `513fe5a` day result
was exactly **24.675 ms** in both endpoint rounds.

An initial cross-revision attempt did produce a lower baseline, but inspection
showed that old revisions had selected the mobile 160×160 ocean grid because a
1280×720 Chrome outer window exposes only about 1280×633 of content during app
bootstrap. Newer revisions honour `quality=desktop`, making that first matrix
internally inconsistent. Those files were quarantined under
`perf-results/rejected/startup-mobile-quality/`, launch size was changed to the
documented 1600×1000, and a geometry assertion was added before all results in
this report were collected.

The remaining difference from 17.9 ms should be treated as a historical
environment/harness difference, not a current regression. The original report
was produced in an agent browser pane; this report uses the later documented
standalone Chrome Metal process and verifies the bootstrap tier, drawing
buffer, fence and scene geometry in every accepted result.

## Baseline versus current

| Scenario | `513fe5a` | `38440b5` | Change | Change % |
|---|---:|---:|---:|---:|
| Day · production · medium | 24.675 | 14.069 | -10.606 | -43.0% |
| Sunset · production · medium | 38.644 | 13.381 | -25.262 | -65.4% |
| Night · production · medium | 24.606 | 13.706 | -10.900 | -44.3% |
| Day · calm · medium | 23.606 | 13.206 | -10.400 | -44.1% |
| Day · rough · medium | 33.212 | 17.919 | -15.294 | -46.0% |
| Day · production · close | 19.962 | 14.725 | -5.237 | -26.2% |
| Day · production · high | 16.725 | 13.213 | -3.513 | -21.0% |

All figures are GPU-fenced milliseconds per frame; lower is better. The rough
sea is still the heaviest current representative case at about 17.9 ms
(approximately 56 FPS if GPU-fenced frame time were the only limit).

## Where the time changed

The feature-boundary smoke pass used the same day/production/medium scene at
every revision. Important boundaries were repeated with day, sunset and night.

| Revision | Change | Day ms | Interpretation |
|---|---|---:|---|
| `513fe5a` | cloud-cache baseline | 24.61–24.68 | Corrected standalone baseline |
| `4c1f3d9` | sample-time cloud-cache advection | 24.99 | +0.31 ms day; fixes the baseline's 38.64 ms sunset outlier |
| `795cc69` | documentation-only boundary | 24.89 | Confirms the advection result |
| `8418c4d` | tile cloud cache + profiler | 26.98 | About +2.09 ms day from its immediate measured parent |
| `0f9ae83` | 48-minute world clock | 26.59 | Near-flat with canonical time paused |
| `8221024` | sky-radiance cache for ocean | 24.15 | -2.44 ms from previous boundary |
| `5cb290e` | sparse cloud tile storage | 23.65 | -0.50 ms |
| `f316e0e` | immediate pre-optimisation boundary | 23.76 | Confirms intervening probes/docs are neutral |
| `24c3aa8` | residual ocean optimisation | 15.53 | **-8.24 ms**, largest general win |
| `d984eaa` | visible schooner M1 | 15.26 | Essentially flat after intervening work |
| `8b65e6e` | detail-cache comparison harness | 15.29 | Essentially flat on corrected desktop tier |
| `f5ebace` | promote faithful ocean detail cache | 12.98 | **-2.29 ms** |
| `8395110` | stabilize embodied haze cost | 12.46 | -0.51 ms |
| `e15939d` | decomposed lighting terms | 12.74 | +0.28 ms day; mixed by time of day |
| `3096f1d` | shadow direct water light with geometry | 13.49 | **+0.75 ms day**, +0.83 sunset, no night penalty |
| `3350698` | pre-rig hull/camera state | 13.41 | Near-flat interval |
| `ff5d9c8` | complete rig | 14.00 | **+0.59 ms day**, +0.39 sunset, +0.60 night |
| `38440b5` | current sail plan | 14.05 smoke / 14.07 endpoint | Near-flat after rig |

The earlier apparent +5 ms regression at `8b65e6e` was entirely an invalid
mobile-to-desktop tier transition in the first harness version. On a consistent
desktop grid it is only about +0.03 ms relative to the nearby repeated M1
measurement, while the promoted detail cache is a large win.

## Time-of-day evidence

| Revision | Day | Sunset | Night |
|---|---:|---:|---:|
| `4c1f3d9` | 24.988 | 24.650 | 24.800 |
| `795cc69` | 24.888 | 24.650 | 24.800 |
| `8418c4d` | 26.975 | 26.525 | 26.700 |
| `0f9ae83` | 26.588 | 26.588 | 26.588 |
| `8221024` | 24.150 | 24.450 | 24.038 |
| `5cb290e` | 23.650 | 23.663 | 23.688 |
| `f316e0e` | 23.762 | 23.663 | 23.663 |
| `24c3aa8` | 15.525 | 15.400 | 15.412 |
| `d984eaa` | 15.262 | 15.225 | 14.988 |
| `f5ebace` | 12.975 | 13.063 | 13.037 |
| `8395110` | 12.463 | 12.088 | 12.400 |
| `e15939d` | 12.738 | 11.912 | 13.250 |
| `3096f1d` | 13.488 | 12.738 | 13.100 |
| `3350698` | 13.412 | 12.850 | 13.150 |
| `ff5d9c8` | 14.000 | 13.238 | 13.750 |

The geometry-shadow cost disappearing at night is strong causal evidence that
the regression belongs to direct solar water lighting, rather than merely
coinciding with that commit.

The baseline's unusually expensive sunset case is also localized: sample-time
cloud-cache advection at `4c1f3d9` takes sunset from 38.64 to 24.65 ms while
leaving day near 25 ms. The later tile-cache/profiler boundary adds about 2 ms
at all three times rather than causing that original sunset-specific cost.

## Ocean and ship attribution

Paired visibility toggles estimate the ocean at about **21.24 ms** in the
corrected baseline and **7.07 ms** at HEAD in the central day view. The totals
and toggles are not strictly additive on a tile GPU, but the direction and
scale agree with the commit history: ocean work is the source of the large net
improvement.

The current schooner is measured three ways because hiding a vessel can expose
expensive water pixels and make a real draw cost look negative:

- Full-scene net vessel delta: about **0.41 ms**.
- Vessel delta with ocean hidden: about **0.78 ms**.
- Vessel-and-lights-only direct draw/shadow estimate: about **0.67 ms**
  (preferred direct estimate).

At the pre-rig `3350698` boundary, the vessel-only median was about 0.45 ms;
at `ff5d9c8` it was about 0.63 ms. The rig therefore explains part of its
~0.59 ms full-frame increase, with the remainder plausibly coming from
shadow/background interactions and measurement granularity.

## Southern Ocean rough · mid-afternoon history

A follow-up unattended campaign measured the rough sea across **28 feature
boundaries × 2 alternating rounds = 56 accepted points**. The state was fixed
at mid-afternoon local time on the canonical summer date, `SOUTHERN_OCEAN_ROUGH`, medium camera, 2560×1440,
with canonical time paused and solar elevation 64.7°.

| Revision | Two-round median average | Change from prior listed boundary |
|---|---:|---:|
| `513fe5a` | 28.256 ms | baseline |
| `795cc69` | 28.594 ms | +0.338 ms |
| `8418c4d` | 30.694 ms | +2.100 ms |
| `0f9ae83` | 30.406 ms | -0.288 ms |
| `8221024` | 28.069 ms | -2.337 ms |
| `f316e0e` | 27.538 ms | -0.531 ms |
| `24c3aa8` | 18.981 ms | **-8.556 ms** |
| `8b65e6e` | 18.219 ms | -0.762 ms across intervening boundaries |
| `f5ebace` | 16.175 ms | **-2.044 ms** |
| `8395110` | 15.375 ms | -0.800 ms |
| `def9b52` | 15.488 ms | +0.113 ms |
| `432f984` | 15.981 ms | +0.494 ms |
| `e15939d` | 16.188 ms | +0.206 ms across intervening boundaries |
| `3096f1d` | 17.194 ms | **+1.006 ms** |
| `3350698` | 17.106 ms | -0.088 ms across intervening boundaries |
| `ff5d9c8` | 17.719 ms | **+0.613 ms** |
| `38440b5` | 17.806 ms | +0.088 ms |

HEAD is **10.450 ms faster than baseline (-37.0%)** in this case. The two HEAD
rounds were 17.875 and 17.738 ms; baseline was 28.288 and 28.225 ms, so the
endpoint result is stable under reversed run order.

Paired attribution puts the rough-afternoon ocean at about 24.88 ms in the
baseline and 10.58 ms at HEAD. The preferred vessel-only estimate is about
0.62 ms at HEAD. At the rig boundary it rises from about 0.21 ms (`3350698`)
to 0.67 ms (`ff5d9c8`), consistent with the 0.61 ms full-frame increase.

This campaign strengthens the earlier conclusions: the residual-ocean and
detail-cache changes dominate the gains; direct water shadowing is the largest
late regression and costs about 1.0 ms in rough afternoon light; the rig is the
next clear cost at about 0.6 ms.

## 2026-08-03 conclusions

1. Recent features did not erase the ocean optimisation gains. HEAD is 21–65%
   faster than the cloud-cache baseline across every representative scene.
2. `24c3aa8` is the largest performance win in this history; `f5ebace` is the
   second major win.
3. The clearest late regression is direct geometry shadowing of water:
   approximately 0.75 ms in the production sea and 1.0 ms in rough afternoon
   conditions when direct sunlight is active.
4. The complete rig costs approximately 0.6 ms in the representative scene;
   the current whole ship draw/shadow workload is around 0.7 ms in isolation.
5. Rough water remains the current worst representative case at ~17.9 ms. If a
   60 FPS target is strict, rough-sea ocean/shadow work is the best next lane.
6. Any future historical run must retain the 1600×1000 bootstrap window and
   desktop-geometry assertion. Buffer resolution alone is not sufficient to
   prove equal quality across old revisions.

Fresh raw JSON is written under `perf-results/`; the live dashboard reads those
files without modifying them. The original raw feed described by this historical
report was not recoverable from the retired worktree. Re-run commands and
harness details are in `tools/perf/README.md`.
