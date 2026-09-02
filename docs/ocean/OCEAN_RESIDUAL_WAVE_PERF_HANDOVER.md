# Residual-wave GPU performance — engineering handover

**Date:** 2026-07-31
**Measurement branch:** `codex/ocean-perf-instrumentation`
**Measurement base:** `8221024 Cache sky radiance for ocean shading`
**Integration note:** master later added
`5cb290e Make cloud tile cache sparse`.
**Status:** the wavelength-ordered active window is now implemented, measured,
and selected by default in this change set. Sections 1–13 preserve the evidence
and design constraints that led to it; section 14 records the implementation
and its results.

This is the self-contained handover for the next ocean-performance session.
Read it before changing wave counts, detail quality, the radial disc, or the
residual shader.

The older broad handover remains useful for the cloud-cache and timer-query
history:

- `docs/ocean/OCEAN_PERF_HANDOVER.md`
- `docs/clouds/CLOUD_CACHE_REPORT.md`
- `docs/graphics/GRAPHICS_ROUND_HANDOVER.md`

The conclusions below supersede the old estimate that residual-wave work was
only a roughly 1.5–1.7 ms opportunity.

---

## 1. Executive conclusion

At a fixed **3370×1628** drawing buffer, the current 48-slot residual-wave
fragment scan costs approximately **17.3–17.5 ms** as an isolated
counterfactual whole-frame delta.

The dominant cost is not the cosine or signed wave-slope reconstruction.
A diagnostic variant retained the complete band-limit and lost-variance scan
but compiled out direction lookup, phase dot product, cosine and gradient
accumulation:

| variant | delta above base water optics |
|---|---:|
| 48-slot classify/variance scan, no phase or cosine | 17.85 ± 0.68 ms |
| complete 48-slot residual path | 17.50 ± 0.56 ms |
| phase/cosine difference | -0.34 ± 0.62 ms (noise) |

The expensive operation is the complete per-wave bookkeeping scan repeated for
millions of visible ocean pixels:

- uniform parameter reads;
- geometry-LOD fade calculation;
- pixel-footprint/Nyquist fade calculation;
- branches;
- lost-slope variance accumulation;
- and, for the smaller active middle subset, phase/slope reconstruction.

The next optimization should try to replace 48 independent per-pixel
classifications with:

1. a residual-only representation ordered or banked by wavelength;
2. local per-pixel or per-annulus active boundaries;
3. individual evaluation only for the residual and smooth-transition window;
4. an aggregate variance total for waves proven fully sub-pixel;
5. no change to vertex displacement, CPU buoyancy, sea-state slot identity or
   accepted appearance.

This is a promising hypothesis, not a promised saving. The instrumentation has
proved the location of the cost. It has not proved that a dynamic active-window
shader will execute efficiently on WebGL2.

> **2026-07-31 follow-up (section 13):** three structural probes of the
> unchanged 48-slot scan have since been measured. Control flow, uniform-array
> access and loop unrolling are all ruled out as the hidden cost — the scan's
> price is the honest arithmetic of examining 48 slots per pixel. The
> active-window experiment above remains the right next step, and its largest
> implementation risk (a dynamic loop bound losing driver optimization) has
> been measured away.

> **2026-07-31 implementation result (section 14):** the experiment succeeded.
> At the same 3370×1628 drawing buffer, two complete A-B-B-A runs reduced the
> full frame by **10.01 ms (30.0%)** and **11.27 ms (31.7%)**. The active path
> is now the default. A settled frozen-frame control was exact; the active image
> was exact in one clean run and differed by one display LSB in one pixel out of
> 5,486,360 in another.

---

## 2. Correct mental model of the renderer

### 2.1 The mesh is a flat template, not a pre-baked ocean

The stored ocean geometry is a flat radial triangle disc. Every rendered frame
logically runs:

1. the vertex shader over the disc vertices;
2. triangle rasterization and interpolation;
3. the fragment shader over screen samples covered by the ocean.

The GPU may pipeline triangles internally, but it does not alternate
"wave-one vertex, wave-one fragment, wave-two vertex, wave-two fragment."
For a given vertex invocation the vertex shader sums the applicable wave
components, emits a displaced position and emits slope/Jacobian data. The
rasterizer interpolates those vertex outputs across each triangle. The fragment
shader consumes the interpolated result and adds finer shading information.

### 2.2 What “displacing the mesh” means

For each vertex, `evaluateWaves()` evaluates the wave field and changes the
vertex's actual world position:

```text
flat disc vertex
    + summed horizontal wave displacement
    + summed vertical wave displacement
    = rendered vertex position
```

It also emits the combined parameter-space gradient and horizontal Jacobian.
Those values are carried as varyings and interpolated across the triangle.

The approximately planar triangles are therefore a piecewise-linear
approximation to the curved water. Interpolated analytic gradients provide
smooth shading across those facets.

### 2.3 The three representations are per wave–pixel pair

The categories do not describe a pixel globally and do not describe a wave
globally. They describe one wave component at one rendered location.

The same two-metre wave can be:

- geometry-resolved near the observer;
- residual-slope-resolved at medium distance;
- statistically represented as roughness farther away.

The scale chain is:

```text
geometry-resolved wave slope
        +
per-pixel residual wave slope
        +
procedural detail gradient
        ->
final resolved surface normal

waves/detail below pixel resolution
        ->
lost slope variance
        ->
reflection roughness
```

#### Geometry-resolved

The local mesh has enough vertex samples over the wavelength. Vertex positions
and vertex gradients already include the wave, and interpolation is a good
approximation between them. The residual stage must not add it again.

“Already in the mesh” does **not** mean the screen pixel lands on a vertex. A
pixel inside a triangle receives barycentrically interpolated vertex outputs.

#### Residual-resolved

The triangle is too coarse to describe the wave's peaks and troughs, so the
vertex shader fades that component out of displacement/gradient. The triangle
can nevertheless cover many screen pixels. If several pixels span the
wavelength, the fragment shader can still evaluate its slope at each pixel and
use it for lighting.

This changes the normal but not the triangle's depth or silhouette.

#### Statistically unresolved

The water-surface area covered by one screen pixel contains too much of the
wave cycle for a single signed slope sample to be meaningful. Evaluating one
phase would alias and shimmer. Its mean signed slope is zero, but its slope
variance is not. The renderer therefore transfers its energy into roughness.

No wave should simply vanish. It is carried by geometry, residual slope or
statistical roughness, with smooth transitions between them.

### 2.4 The mesh is not present for buoyancy

The render mesh is essential for:

- screen coverage and rasterization;
- real displaced depth;
- crests, troughs, parallax and silhouette;
- world position, view direction and haze distance;
- occlusion and intersection with the raft;
- interpolated baseline gradient/Jacobian data.

The raft does **not** read the rendered mesh. CPU buoyancy evaluates the same
`WaveField` equations independently at sample points beneath the raft. The
render mesh and buoyancy share a definition; one is not an input to the other.

---

## 3. The radial disc is not the 17 ms problem

Desktop ocean quality currently uses:

- `rings = 288`;
- `sectors = 288`;
- `(rings + 1) × sectors = 83,232` vertices;
- `rings × sectors × 2 = 165,888` triangles;
- `OUTER_RADIUS = 20,000` metres.

The disc is observer-centred. Up close the observer centre is effectively the
raft; as the cinematic camera pulls away, the centre blends toward the
camera's ground position so geometry density follows the pixels.

`ocean.mesh.frustumCulled` is false, so the single mesh is submitted and its
vertices are processed even when many triangles leave the view. Triangle
clipping happens after vertex processing. Fragment shading, however, runs only
where rasterized ocean covers screen samples.

Consequences:

- the world-space area of the 20 km disc is not shaded metre by metre;
- increasing its physical radius with the same topology does not multiply
  fragment work by its square;
- the vertex stage pays for the fixed approximately 83k vertices;
- the fragment stage pays primarily for the number of screen pixels covered by
  water;
- the vertex-wave sweep measured below the approximately 1 ms measurement
  floor;
- the residual scan runs across millions of ocean pixels and is the priority.

Shrinking the disc is not the recommended performance intervention. It risks
exposing the rim in the cinematic camera while targeting the wrong stage.

---

## 4. What the current residual shader actually does

The implementation is `residualWaveGradient()` in
`src/scene/shaders/lib.ts`.

Simplified per-slot pseudocode:

```text
for each of 48 slots:
    read k and base amplitude
    if amplitude is zero:
        continue

    missing = mesh LOD fade at this local radius
    if missing is effectively zero:
        continue

    wavelength = 2π / k
    amplitudeMissingFromMesh = baseAmplitude × missing

    visible = pixel-footprint fade for this wavelength

    if visible and wavelength is inside the residual policy:
        evaluate direction, phase and cosine
        add signed gradient × visible
    else:
        force visible to zero

    droppedSlope = (1 - visible)
                 × amplitudeMissingFromMesh
                 × k
    lostVariance += 0.5 × droppedSlope²
```

The two local scale inputs are:

- `vLodRadius`: interpolated distance through the radial LOD policy, used to
  determine how much geometry has dropped;
- `footprint = max(fwidth(vParam.x), fwidth(vParam.y))`: the parameter-space
  water distance covered by a screen pixel, including perspective/grazing
  stretch.

Current geometry handoff is smooth rather than a hard category:

```text
missing = smoothstep(lodFadeStart, lodFadeEnd, localRadius)
```

Current residual-to-roughness handoff is also smooth:

```text
visible = 1 - smoothstep(0.25 × wavelength,
                         0.50 × wavelength,
                         pixelFootprint)
```

The exact optimizer must preserve both fades and the lost-variance accounting.

### 4.1 Why the “decision” is not one cheap `if`

Calling the bottleneck a category decision is shorthand and caused confusion.
Each slot examination includes parameter access, multiple arithmetic
expressions, smooth interpolation functions, branches and variance arithmetic.

At 3370×1628 there are 5.49 million framebuffer pixels. If ocean covers several
million, the shader performs on the order of hundreds of millions of slot
examinations per frame.

The fixed-function interpolation of vertex outputs is not the expensive part.

### 4.2 The roughness path is currently accumulated per wave per pixel

The shader does not run the complete reflection model 48 times. It accumulates
one scalar:

```text
lostVariance += contributionFromThisWave
```

After the loop, the combined variance widens the reflection lobe once.

The base slope variance of a fully unresolved wave is:

```text
E_i = 0.5 × (amplitude_i × k_i)²
```

That base quantity is independent of wave phase and direction. It can be
precomputed per component. If residual components are wavelength-ordered, a
cumulative energy table can answer the sum of a fully unresolved wavelength
range with two indexed reads instead of a loop:

```text
energy(i...j) = prefixEnergy[j] - prefixEnergy[i - 1]
```

The complete final roughness cannot be globally precomputed because `missing`
and `visible` are pixel-specific. Only blocks proven fully inside a category
can be aggregated. Smooth boundary components still need the original formula.

---

## 5. Instrumentation that now exists

The branch adds compile-time ocean counterfactuals and an automated profiler.

### 5.1 Manual graphics controls

The Graphics panel now exposes:

- cached gas-sky LUT;
- vertex wave slots: 0 / 12 / 24 / 36 / 48;
- residual wave slots: 0 / 12 / 24 / 36 / 48;
- residual phase/cosine on/off;
- detail octave count;
- foam fragment work on/off;
- flat-fragment baseline;
- `Run component sweep`;
- `Restore shipping`.

These controls intentionally recompile shader variants. A uniform runtime
branch would leave disabled instructions in the program and make attribution
ambiguous.

### 5.2 Automated sweep

`runOceanProfileProbe()`:

1. captures current shipping/diagnostic settings;
2. freezes presentation time, world time, waves, clouds and camera motion;
3. prevents adaptive-resolution changes;
4. applies one compile-time shader variant;
5. warms it for 24 presented frames;
6. restarts the GPU profiler;
7. records 12 complete unsmoothed six-frame prefix rotations;
8. reports mean and sample standard deviation;
9. restores the original shader and LUT state;
10. warms the restored shader and restarts normal profiling.

The report includes:

- whole-WebGL-frame timing;
- signed ocean-prefix timing as a noisier cross-check;
- delta against a named counterfactual parent;
- standard error of each whole-frame delta.

### 5.3 Why whole-frame delta is primary

Directly wrapping the ocean draw in a timer query forces tile-based GPUs to
flush deferred work and can make a small draw appear to consume most of the
frame.

The existing profiler therefore rotates cumulative frame-prefix endpoints
across adjacent frames and subtracts them. That produces an unbiased ocean
estimate over time, but raw adjacent-frame noise can make a small pass briefly
negative.

For the component sweep, only the ocean shader changes. A complete GPU-frame
query is therefore the more stable primary counterfactual measurement:

```text
component cost ≈ mean frame time with component
               - mean frame time of named parent variant
```

The signed ocean-prefix result stays in the report to detect contradictions.

---

## 6. Measured results

### 6.1 Conditions

- drawing buffer: **3370×1628**;
- URL parameter: `fixedDpr=2`;
- world/camera frozen;
- desktop quality;
- 24 warm-up frames per shader;
- 12 raw GPU-prefix rotations per row;
- two complete repeated sweeps;
- no browser console errors;
- shipping shader restored after each run.

The exact current local URL is:

```text
http://127.0.0.1:5179/?debug=graphics&fixedDpr=2
```

Run a server with:

```text
npm run dev -- --host 127.0.0.1 --port 5179
```

### 6.2 Stable ranges across the repeated sweeps

| counterfactual addition | measured whole-frame delta |
|---|---:|
| 48 vertex waves beneath a flat fragment | below approximately 1 ms / noise |
| base water optics above flat 48-vertex shader | 3.1–3.9 ms |
| 48 residual slots | **17.3–17.5 ms** |
| five detail octaves | 3.6–5.2 ms |
| foam fragment work | 1.2–2.2 ms |
| analytic gas sky instead of LUT, net of LUT generation | 3.2–5.4 ms |

The user's independent Chrome A/B at the same large resolution reported
roughly 30 ms with LUT off and 25 ms with it on, consistent with the measured
sky range.

### 6.3 Residual slot scaling

The final 12-rotation sweep measured:

| residual slots | delta above base optics |
|---|---:|
| 12 | 6.12 ± 0.62 ms |
| 24 | 9.63 ± 0.69 ms |
| 36 | 14.83 ± 0.64 ms |
| 48 | 17.50 ± 0.56 ms |

The earlier repeated sweep measured the 48-slot row at 17.27 ± 0.67 ms.

Shorter compile-time loops clearly reduce cost. This does **not** prove that a
per-pixel dynamic loop bound will receive the same optimization from the WebGL
driver/compiler.

### 6.4 Component costs are not additive

Do not sum isolated marginal rows and present the result as predicted shipping
time. Shader regions overlap latency, register pressure, texture latency and
execution resources. The complete cached-sky ocean was cheaper than the sum of
all isolated additions.

Use the rows to rank targets and evaluate one implementation against its exact
parent, not to construct a synthetic frame total.

### 6.5 Complete timing record — sweep A

This was the first automated end-to-end run:

- 3370×1628;
- fixed DPR 2;
- 24 warm-up frames;
- **8** raw rotations per row;
- whole-frame deltas below are calculated from the recorded means;
- the original UI at this point incorrectly emphasized ocean-prefix delta;
  this run exposed why that was too noisy for small counterfactuals.

| variant | GPU frame mean ± SD | frame delta vs parent | signed ocean prefix mean ± SD |
|---|---:|---:|---:|
| flat, 0 vertex waves | 9.44 ± 1.59 ms | baseline | -0.70 ± 1.67 ms |
| flat, 12 vertex waves | 10.64 ± 2.08 ms | +1.20 ms vs flat-0 | 0.79 ± 0.76 ms |
| flat, 24 vertex waves | 9.44 ± 1.85 ms | +0.00 ms vs flat-0 | -0.52 ± 2.10 ms |
| flat, 36 vertex waves | 9.23 ± 1.30 ms | -0.21 ms vs flat-0 | 1.03 ± 1.18 ms |
| flat, 48 vertex waves | 10.00 ± 1.72 ms | +0.56 ms vs flat-0 | 0.97 ± 1.65 ms |
| base water optics | 13.45 ± 1.94 ms | +3.45 ms vs flat-48 | 2.60 ± 1.39 ms |
| +12 residual waves | 17.63 ± 1.21 ms | +4.18 ms vs base | 8.59 ± 1.77 ms |
| +24 residual waves | 21.83 ± 2.03 ms | +8.38 ms vs base | 10.82 ± 4.39 ms |
| +36 residual waves | 27.11 ± 2.07 ms | +13.66 ms vs base | 16.24 ± 2.00 ms |
| +48 residual waves | 30.03 ± 1.08 ms | **+16.58 ms vs base** | 20.32 ± 1.89 ms |
| +1 detail octave | 14.44 ± 2.37 ms | +0.99 ms vs base | 4.76 ± 1.25 ms |
| +3 detail octaves | 16.24 ± 2.05 ms | +2.79 ms vs base | 4.62 ± 1.68 ms |
| +5 detail octaves | 17.59 ± 1.16 ms | +4.14 ms vs base | 8.05 ± 1.61 ms |
| +foam fragment | 16.02 ± 1.91 ms | +2.57 ms vs base | 5.68 ± 1.36 ms |
| full shipping ocean, cached sky | 33.67 ± 1.90 ms | +20.22 ms vs base | 22.57 ± 2.02 ms |
| full shipping ocean, analytic sky | 36.22 ± 1.54 ms | +2.55 ms vs cached | 27.59 ± 1.51 ms |

What this run established:

- residual cost scaled strongly with compile-time slot count;
- vertex rows were non-monotonic and inside the timing noise;
- detail and foam were measurable but much smaller than residual;
- the signed flat-ocean prefix could be negative;
- a longer sample run and whole-frame primary delta were required.

### 6.6 Complete timing record — sweep B

This was the refined repeated run:

- same 3370×1628 fixed-DPR scene;
- 24 warm-up frames;
- **12** raw rotations per row;
- whole-frame delta became the primary statistic;
- delta uncertainty was reported from both rows' sample standard deviations.

| variant | GPU frame mean ± SD | frame delta vs parent | signed ocean prefix mean ± SD |
|---|---:|---:|---:|
| flat, 0 vertex waves | 8.65 ± 1.11 ms | baseline | -0.35 ± 1.82 ms |
| flat, 12 vertex waves | 9.67 ± 1.69 ms | +1.02 ± 0.58 ms vs flat-0 | -1.13 ± 1.96 ms |
| flat, 24 vertex waves | 9.04 ± 1.51 ms | +0.39 ± 0.54 ms vs flat-0 | -0.56 ± 1.38 ms |
| flat, 36 vertex waves | 8.55 ± 1.28 ms | -0.10 ± 0.49 ms vs flat-0 | -0.67 ± 1.86 ms |
| flat, 48 vertex waves | 9.41 ± 1.70 ms | +0.76 ± 0.58 ms vs flat-0 | -0.83 ± 1.46 ms |
| base water optics | 12.55 ± 1.80 ms | +3.14 ± 0.71 ms vs flat-48 | 2.95 ± 1.12 ms |
| +12 residual waves | 16.53 ± 1.51 ms | +3.98 ± 0.68 ms vs base | 7.51 ± 2.54 ms |
| +24 residual waves | 20.83 ± 2.32 ms | +8.28 ± 0.85 ms vs base | 8.52 ± 5.59 ms |
| +36 residual waves | 25.40 ± 1.50 ms | +12.85 ± 0.68 ms vs base | 17.34 ± 1.17 ms |
| +48 residual waves | 29.83 ± 1.46 ms | **+17.27 ± 0.67 ms vs base** | 20.04 ± 1.85 ms |
| +1 detail octave | 15.08 ± 2.00 ms | +2.52 ± 0.78 ms vs base | 4.33 ± 1.63 ms |
| +3 detail octaves | 14.88 ± 1.64 ms | +2.32 ± 0.70 ms vs base | 6.41 ± 0.85 ms |
| +5 detail octaves | 16.12 ± 2.19 ms | +3.57 ± 0.82 ms vs base | 7.54 ± 1.95 ms |
| +foam fragment | 14.73 ± 2.24 ms | +2.18 ± 0.83 ms vs base | 4.97 ± 1.11 ms |
| full shipping ocean, cached sky | 31.50 ± 1.08 ms | +18.95 ± 0.61 ms vs base | 23.00 ± 0.91 ms |
| full shipping ocean, analytic sky | 36.85 ± 1.49 ms | +5.35 ± 0.53 ms vs cached | 26.89 ± 1.63 ms |

This run confirmed the residual result and aligned the LUT result with the
user's independent approximately 5 ms A/B.

### 6.7 Complete timing record — sweep C

This was the final run with the residual phase/cosine split:

- same 3370×1628 fixed-DPR scene;
- 24 warm-up frames;
- 12 raw rotations per row;
- one additional `48 residual classify/variance only` shader;
- shipping shader automatically restored afterward;
- browser console error count: zero.

| variant | GPU frame mean ± SD | frame delta vs parent | signed ocean prefix mean ± SD |
|---|---:|---:|---:|
| flat, 0 vertex waves | 9.25 ± 1.52 ms | baseline | -0.35 ± 1.31 ms |
| flat, 12 vertex waves | 8.78 ± 1.05 ms | -0.47 ± 0.53 ms vs flat-0 | -0.69 ± 1.65 ms |
| flat, 24 vertex waves | 8.85 ± 1.35 ms | -0.40 ± 0.59 ms vs flat-0 | -1.15 ± 1.43 ms |
| flat, 36 vertex waves | 9.03 ± 1.26 ms | -0.22 ± 0.57 ms vs flat-0 | -0.88 ± 1.13 ms |
| flat, 48 vertex waves | 8.47 ± 1.22 ms | -0.78 ± 0.56 ms vs flat-0 | -0.59 ± 1.38 ms |
| base water optics | 12.34 ± 1.54 ms | +3.87 ± 0.57 ms vs flat-48 | 2.66 ± 1.56 ms |
| +48 residual classify/variance only | 30.18 ± 1.77 ms | **+17.85 ± 0.68 ms vs base** | 19.19 ± 0.73 ms |
| +12 complete residual waves | 18.46 ± 1.47 ms | +6.12 ± 0.62 ms vs base | 7.93 ± 3.16 ms |
| +24 complete residual waves | 21.96 ± 1.83 ms | +9.63 ± 0.69 ms vs base | 11.79 ± 1.20 ms |
| +36 complete residual waves | 27.17 ± 1.60 ms | +14.83 ± 0.64 ms vs base | 16.97 ± 0.68 ms |
| +48 complete residual waves | 29.84 ± 1.20 ms | **+17.50 ± 0.56 ms vs base** | 20.62 ± 1.74 ms |
| phase/cosine portion of 48-slot result | — | **-0.34 ± 0.62 ms vs classify-only** | — |
| +1 detail octave | 15.41 ± 2.05 ms | +3.07 ± 0.74 ms vs base | 4.86 ± 0.98 ms |
| +3 detail octaves | 16.41 ± 1.49 ms | +4.08 ± 0.62 ms vs base | 6.36 ± 0.97 ms |
| +5 detail octaves | 17.58 ± 1.68 ms | +5.24 ± 0.66 ms vs base | 8.13 ± 1.88 ms |
| +foam fragment | 13.50 ± 1.81 ms | +1.16 ± 0.69 ms vs base | 3.57 ± 1.73 ms |
| full shipping ocean, cached sky | 31.92 ± 1.57 ms | +19.59 ± 0.64 ms vs base | 15.85 ± 11.57 ms |
| full shipping ocean, analytic sky | 35.07 ± 1.45 ms | +3.15 ± 0.62 ms vs cached | 24.33 ± 7.93 ms |

The final two full-shipping ocean-prefix rows demonstrate why the prefix is a
cross-check rather than the primary component statistic: their 7.93–11.57 ms
sample SD is much larger than the whole-frame SD, even though the whole-frame
deltas remain usable.

### 6.8 Cross-run delta comparison

This table is the shortest complete view of repeatability:

| isolated addition | sweep A, n=8 | sweep B, n=12 | sweep C, n=12 | interpretation |
|---|---:|---:|---:|---|
| flat vertex 48 vs 0 | +0.56 ms | +0.76 ms | -0.78 ms | below measurement floor; do not prioritize |
| base optics vs flat-48 | +3.45 ms | +3.14 ms | +3.87 ms | repeatable low-single-digit base |
| residual 12 vs base | +4.18 ms | +3.98 ms | +6.12 ms | material, noisier at low count |
| residual 24 vs base | +8.38 ms | +8.28 ms | +9.63 ms | material |
| residual 36 vs base | +13.66 ms | +12.85 ms | +14.83 ms | material |
| residual 48 vs base | **+16.58 ms** | **+17.27 ms** | **+17.50 ms** | dominant and highly repeatable |
| detail 1 vs base | +0.99 ms | +2.52 ms | +3.07 ms | run-order/systematic variation |
| detail 3 vs base | +2.79 ms | +2.32 ms | +4.08 ms | secondary target |
| detail 5 vs base | +4.14 ms | +3.57 ms | +5.24 ms | meaningful, visually load-bearing |
| foam fragment vs base | +2.57 ms | +2.18 ms | +1.16 ms | lower priority |
| full cached ocean vs base | +20.22 ms | +18.95 ms | +19.59 ms | stable complete interaction cost |
| analytic sky vs cached | +2.55 ms | +5.35 ms | +3.15 ms | worthwhile but systematic variation |

The strongest evidence in the entire session is the repeated residual-48 row:
16.58, 17.27 and 17.50 ms across progressively stronger sampling runs.

### 6.9 Live overlay orientation sample

Before the first sweep, the normal rotating-prefix overlay at 3370×1628 showed:

| live reading | value |
|---|---:|
| wall cadence | 28 FPS / 35.6 ms |
| GPU frame | 32.54 ms |
| GPU ocean | 22.85 ms |
| cloud bake | 2.42 ms |
| sky + clouds | 3.22 ms |
| scene + stars | 0.93 ms |
| foam simulation | 4.49 ms |
| CPU main | 1.34 ms |
| CPU ocean preparation | 0.01 ms |
| CPU render submission | 0.33 ms |

The independently smoothed pass rows can temporarily sum above the smoothed
frame because they come from rotating adjacent-frame prefix cycles. Treat this
as orientation, not an additive accounting identity.

It does, however, establish the CPU/GPU distinction: the approximately 17 ms
residual opportunity is GPU fragment work, not JavaScript or CPU ocean
preparation.

### 6.10 Independent and historical measurements

#### User's independent sky-LUT A/B

At 3370×1628 in Chrome:

```text
LUT off: approximately 30 ms ocean/render timing
LUT on:  approximately 25 ms
observed saving: approximately 5 ms
```

The controlled sweeps measured analytic-minus-cached net frame deltas of 2.55,
5.35 and 3.15 ms. The user A/B and the strongest controlled run agree that the
LUT is worth retaining. Inter-run systematics mean it should be described as a
roughly 3–5 ms win, not a universal constant.

#### Pre-LUT cloud-cache/ocean baseline

The prior cloud-cache round recorded, at 2560×1440 on the M2:

```text
pre-cache frame: 80–105 ms
post-cache frame: approximately 17–19 ms
ocean hidden-vs-shown estimate: approximately 13.4 ms
everything else combined: approximately 4.5 ms
```

Those measurements used a different scene/build/resolution and are not directly
comparable to the current 3370×1628 sweep. They correctly identified the ocean
as the next lane but incorrectly suspected analytic atmosphere would remain the
largest ocean item.

#### Historical residual wavelength-cut experiment

The earlier handover recorded, at approximately 3200×1800:

```text
all-48 residual visible-band estimate: approximately 2.1 ms of a 29 ms frame
aggressive 9 m residual cut estimate: approximately 0.4 ms
apparent saving: approximately 1.7 ms
```

The aggressive cut was visually unacceptable and did not remove the 48-slot
classification/variance scan. It is evidence about the visible signed-slope
band, not evidence about the cost of the complete scan. Do not reuse the
approximately 1.7 ms number as the active-window estimate.

### 6.11 Hypothesis and dead-end ledger

| hypothesis or proposed action | evidence collected | verdict |
|---|---|---|
| Analytic sky is the largest ocean cost | LUT saves roughly 3–5 ms; residual scan is roughly 17 ms | **Rejected as largest**, but LUT remains worthwhile and landed |
| The 48-wave vertex loop is a major target | Three flat-fragment sweeps were non-monotonic; 48-vs-0 ranged -0.78 to +0.76 ms | **Rejected / below measurement floor** |
| Cosine and phase reconstruction dominate residual cost | classify/variance-only 17.85 ± 0.68 ms vs full 17.50 ± 0.56 ms | **Rejected** |
| The complete 48-slot residual scan dominates | 16.58, 17.27, 17.50 ms in three runs | **Confirmed strongly** |
| Fewer compile-time residual slots help | 12/24/36/48 rows rise approximately monotonically to 17.5 ms | **Confirmed for compile-time variants** |
| A dynamic per-pixel loop bound will receive the same gain | not implemented; compiler/divergence unknown | **Untested — do not assume** |
| Cutting residual minimum wavelength is the free fix | old 9 m cut saved approximately 1.7 ms but changed appearance and retained scan | **Rejected as zero-risk fix** |
| Five detail octaves are negligible | 3.57–5.24 ms isolated marginal | **Rejected**; meaningful second target |
| Detail can simply be removed | prior aliasing study: native error vs SSAA fell from 13.3 to 3.5 display levels with detail removed, showing detail drives visible structure/aliasing | **Visually load-bearing; do not cut casually** |
| Foam fragment work is a major first target | 1.16–2.57 ms isolated marginal | **Lower priority** |
| Shrinking the 20 km disc attacks the dominant cost | vertex work is below measurement floor; fragment cost tracks ocean screen coverage, not square kilometres | **Not supported; wrong first target** |
| FFT directly fixes the measured bottleneck | phase/cosine is not dominant; FFT/cache architecture not tested | **Not a first fix; larger untested redesign** |
| Direct ocean draw timer queries give clean attribution | prior tile-GPU testing caused deferred-work flushes and inflated small draws | **Rejected measurement method** |
| `gl.finish()` is a reliable fence in the agent browser | prior testing found it did not synchronize reliably | **Rejected measurement method** |
| Signed ocean-prefix raw rows are sufficient alone | flat rows went negative; full rows reached 7.93–11.57 ms SD | **Rejected as primary counterfactual statistic** |
| Whole-frame delta is usable when only ocean shader changes | residual result repeated tightly across all runs | **Confirmed as primary statistic** |
| Isolated component deltas can be summed | isolated sum exceeds complete cached-ocean delta | **Rejected**; GPU interactions are non-additive |
| Residual active window + prefix variance is a real win | target cost proven, implementation not built | **Recommended next experiment, not yet confirmed** |
| Per-pixel branch divergence makes the scan expensive | branchless-select variant ran roughly 5–10× slower (§13) | **Rejected**; the early-outs are savings, keep them |
| ANGLE uniform-array translation makes the scan expensive | texelFetch variant +2.76 ± 0.58 ms vs shipping (§13) | **Rejected**; uniforms are the faster path |
| Compile-time unrolling is required for the loop's speed | uniform-bound variant +0.15 ± 0.61 ms vs shipping (§13) | **Rejected**; a dynamic loop bound is free — Priority A's biggest compiler risk retired |

### 6.12 Visual evidence that constrains “easy” cuts

The earlier native-resolution aliasing study compared each ablation against a
2×2 supersampled reference over the problematic 40–150 m water band:

| native variant | RMS display-level error vs SSAA |
|---|---:|
| shipping/native baseline | 13.3 |
| no detail octaves | 3.5 |
| no clouds in reflection | 11.4 |
| no residual swell | 13.4 |
| no foam | 13.4 |

These are **visual error metrics, not milliseconds**.

They show:

- detail is a major source of both desired small-scale normal structure and
  aliasing sensitivity;
- simply removing detail would materially change the image even though it
  looks attractive in a performance table;
- residual and foam ablations did not address that particular aliasing metric,
  but this does not mean they are visually unnecessary;
- performance changes must be validated in motion as well as still-frame diff.

---

## 7. Reconciliation with the old 1.5–1.7 ms estimate

Two related interventions were previously blurred together:

1. changing the residual wavelength policy so fewer waves receive visible
   signed-slope evaluation;
2. structurally avoiding the 48-slot scan for components whose outcome can be
   handled in bulk.

The earlier approximately 1.5–1.7 ms result belonged to the first type of
experiment. It retained the 48-iteration classification/variance loop and
removed only part of the apparently expensive wave evaluation. Aggressive
wavelength cuts also had visible consequences.

The second intervention was the intended zero-look-risk optimization, but its
cost had not been isolated. The new phase-off probe recreates the distinction:
removing direction/phase/cosine does not remove the 17 ms scan.

Therefore:

- the old number should not be used as the estimate for an active-window
  implementation;
- 17.5 ms is the total cost ceiling, not an expected saving;
- the recoverable fraction depends on active-window width, transition width,
  compiler behaviour, branch divergence and aggregation overhead;
- only an implementation benchmark can establish the saving.

---

## 8. Ranked optimization candidates

### Priority A — exact residual active window plus variance prefix sums

This is the recommended first experiment.

#### Core idea

Keep the stable production wave table exactly as it is for:

- vertex displacement;
- vertex gradients/Jacobian;
- CPU buoyancy;
- stable sea-state morph slot identity;
- foam injection and other shared consumers.

Create a second residual-only table ordered or banked by wavelength. It contains
the same parameters and phases but exists only to make the fragment-stage
scale ordering explicit.

For each pixel, derive:

- where geometry is fully carrying waves;
- the smooth geometry/residual transition;
- the individually residual-visible range;
- the smooth residual/roughness transition;
- the fully statistical short-wave range.

Then:

```text
fully geometry-resolved range:
    add nothing in residual stage

boundary + residual-visible range:
    evaluate original formula per component

fully sub-pixel and fully missing range:
    add aggregate prefix variance once
```

#### Why the outcome is still local

There is no global category per wave. `vLodRadius` and `footprint` differ per
pixel, so each pixel obtains different boundaries.

The potential saving comes from comparing two local scale values against an
ordered wavelength axis, rather than independently deriving the same category
for 48 arbitrarily ordered entries.

#### Exactness requirements

- preserve the original geometry fade;
- preserve the original Nyquist fade;
- evaluate partial boundary components individually;
- aggregate only components proven to have `missing = 1` and `visible = 0`
  within the original thresholds;
- preserve the same residual gradient;
- preserve lost slope variance;
- preserve global `uWaveAmp` and sea-state morphing;
- avoid double-counting anything already in `vGradient`;
- maintain unused/zero-amplitude slot semantics.

Changing summation order may introduce tiny floating-point differences even
when the mathematics is equivalent. The validation bar is strict pixel
equivalence, not necessarily bit identity if reordering makes the latter
impossible.

#### Major implementation risk

GLSL ES/WebGL2 compiler behaviour:

- a dynamic start/end index may force dynamic uniform-array indexing;
- a loop written as 48 iterations plus `if (i in range)` may still execute the
  full scan and save nothing;
- neighbouring pixels can choose different ranges, causing lane divergence;
- compiler unrolling and register pressure may dominate.

The prototype must inspect performance, not just source-level operation count.

### Priority B — radial annulus draw partitions

If a dynamic active window does not compile efficiently, partition the radial
geometry into a small number of ring/annulus draw ranges.

Each annulus has a conservative geometry-spacing range and can use a material
variant with a shorter compile-time residual candidate bank. The per-pixel
footprint fade remains for exact pixel-scale handoff.

Advantages:

- compile-time-short loops already measured as faster;
- neighbouring pixels in a draw share broadly similar geometry LOD;
- avoids fully dynamic loop bounds.

Risks:

- more ocean draw calls;
- shared boundary vertices may be submitted more than once;
- conservative banks may leave much of the scan in place;
- camera elevation/grazing footprint still varies within an annulus;
- exact fades must prevent seams;
- Three.js material and uniform ownership becomes more complex.

Start with very few partitions. The measured vertex cost leaves room for a
small amount of repeated vertex work if it removes substantial fragment work.

### Priority C — banded residual slope/variance textures

Precompute residual slope fields into one or more wavelength-band textures once
per frame, then sample them from the ocean shader.

With only 48 components, direct rendering into a few slope textures may be
simpler than an FFT:

```text
once per frame:
    evaluate components over a moderate regular grid

per ocean pixel:
    sample relevant band texture(s)
    blend using local LOD/footprint
```

Potential advantage: move repeated per-wave work from millions of framebuffer
pixels to a much smaller cache grid.

Risks:

- residual selection depends on geometry LOD and pixel footprint;
- a single combined texture cannot express all local band choices;
- several cascades/bands may be necessary;
- interpolation, periodicity, camera scrolling and cache origin become visible
  correctness concerns;
- texture generation and bandwidth may replace arithmetic rather than remove
  it;
- exact zero-diff output is unlikely.

Use only if the exact active-window/bank approach cannot recover enough.

### Priority D — cascaded FFT ocean or FFT residual field

An inverse FFT efficiently converts a regular frequency spectrum into a
regular spatial height/slope grid. It does not turn many waves into one wave;
it reuses structured arithmetic to produce the combined grid more efficiently.

An FFT can help only if the architecture changes from:

```text
millions of pixels × per-wave scan
```

to:

```text
generate moderate wave grids once per frame
+ cheap grid samples per visible pixel
```

It is not the recommended first fix because:

- the phase/cosine summation was not the measured bottleneck;
- current components have arbitrary directions/wavelengths and may not align
  exactly with FFT bins;
- regular FFT grids are periodic;
- a 20 km camera range normally requires multiple cascades;
- WebGL2 has no compute shaders, requiring ping-pong render passes;
- mip/band filtering remains necessary;
- exact CPU/GPU wave parity becomes harder;
- it is a renderer architecture change with visual risk.

FFT becomes attractive if the product later wants hundreds or thousands of
spectral modes, not merely a faster exact rendering of the present 48.

### Priority E — five-octave detail stack

Measured isolated marginal: **3.6–5.2 ms**.

This is the next substantial ocean shader target after residual work. Possible
directions include:

- cached/prefiltered normal-detail textures;
- fewer live analytic octaves plus variance/mip representation;
- distance/footprint-specialized variants;
- shared noise evaluations with foam where mathematically valid.

This area has known visual sensitivity: earlier aliasing investigations found
detail octaves dominate mid-distance sparkle. Do not reduce it casually.

### Priority F — foam fragment shading

Measured isolated marginal: **1.2–2.2 ms**.

Lower priority than residual/detail. Potential work:

- avoid jitter/noise work where both field levels and statistical coverage are
  provably absent;
- reuse detail-noise derivatives carefully;
- profile breakup and shading subregions separately before changing them.

The separate foam simulation pass is not included in this fragment marginal.

### Do not prioritize

- vertex-wave loop: below the approximately 1 ms measurement floor;
- shrinking the 20 km disc: wrong stage and cinematic risk;
- approximating `cos()` first: phase-off probe found no measurable win;
- cutting the residual wavelength band without visual review;
- reducing the canonical 48-wave budget: changes surface composition and can
  break the intended CPU/GPU/raft agreement;
- direct timer queries around the ocean draw on tile GPUs.

---

## 9. Recommended next-session experiment

### Step 1 — preserve the instrumentation baseline

Before optimization:

```text
git status --short --branch
npm test
npm run build
```

Current verified baseline (re-verified 2026-07-31 after the structural-probe
commit 0ec855a):

- 17 test files;
- 290 tests;
- production TypeScript/Vite build succeeds;
- no shader/browser console errors across all automated variants.

Commit the instrumentation separately from the optimization so the benchmark
harness remains independently reviewable and revertible.

### Step 2 — measure the actual active category distribution

Before designing the final representation, add a diagnostic category-count
variant. For each fragment, count:

- slots exiting as geometry-resolved;
- slots in geometry/residual transition;
- slots receiving signed residual slope;
- slots in residual/roughness transition;
- slots fully statistical;
- unused amplitude-zero slots.

Because WebGL2 lacks convenient global shader atomics, render normalized counts
to an offscreen diagnostic target or debug output and read back a pixel
histogram.

Measure at least:

- embodied/close camera;
- medium cinematic distance;
- maximum high bird's-eye camera;
- calm, production/default and strong sea states;
- representative horizon-heavy and downward-looking compositions.

This establishes the realistic active-window width and the possible ceiling
before building a complicated shader.

### Step 3 — build a CPU reference for ordered residual evaluation

Create a pure TypeScript reference implementation that:

- copies active components into wavelength order without changing canonical
  slot identity;
- calculates per-wave base slope energy;
- builds prefix energy totals;
- evaluates the proposed geometry/residual/roughness boundaries;
- computes gradient and lost variance;
- compares against brute-force current semantics over many randomized
  positions, LOD radii, footprints, sea states and transitions.

This should prove the mathematics before GLSL/compiler concerns enter.

### Step 4 — prototype the smallest GPU path

Try in this order:

1. per-pixel wavelength bounds with a genuinely shortened/dynamic loop —
   derisked by §13: a dynamic loop bound measured free against the constant
   one, so this path keeps its full theoretical saving;
2. if per-pixel divergence of the bound (still unmeasured) eats the gain, a
   small set of annular compile-time variants;
3. only then consider cached band textures.

Keep the original shipping shader available as an immediate compile-time A/B.

### Step 5 — validate appearance numerically

Freeze an identical frame and render current versus optimized shaders into
readable buffers.

Record:

- mean absolute RGB difference in display LSB;
- maximum difference;
- percentage of pixels above 1 LSB;
- percentage above 2 LSB;
- spatial diff images;
- separate near, mid, far and horizon crops.

Also compare:

- residual gradient before normal conversion where possible;
- accumulated lost variance;
- final roughness;
- daylight glitter;
- sunset reflection;
- high-camera corduroy/shimmer bands;
- moving-camera temporal stability.

The target is no perceptible difference and an extremely small numerical diff.
Do not accept a still-frame match that introduces motion shimmer.

### Step 6 — benchmark in alternating order

Avoid one long baseline block followed by one long optimized block. GPU thermal
and browser scheduling drift were visible between complete sweeps.

Use alternating or bracketed runs, for example:

```text
baseline A
optimized B
optimized B
baseline A
```

At each view/sea state:

- fixed drawing-buffer size;
- adaptive resolution disabled;
- world and camera frozen;
- warm both compiled shaders;
- use complete raw GPU-frame queries;
- repeat enough rotations to report mean, SD and delta standard error;
- retain the signed ocean prefix as a cross-check.

### Step 7 — decision gate

Land only if:

- mathematical/reference parity passes;
- pixel/motion validation passes;
- the measured gain is material and repeatable;
- CPU buoyancy and canonical wave slots remain untouched;
- transitions between sea states remain stable;
- the optimized shader restores/falls back cleanly.

If the dynamic active-window path saves little because of compiler behaviour or
lane divergence, do not keep complexity merely because its source code appears
more efficient. Move to annular variants or cached bands with fresh evidence.

---

## 10. Code map

Primary current files:

| file | responsibility |
|---|---|
| `src/scene/Ocean.ts` | radial geometry, ocean vertex/fragment shaders, profile defines |
| `src/scene/shaders/lib.ts` | `evaluateWaves()`, `residualWaveGradient()`, slope conversion |
| `src/scene/Waves.ts` | canonical CPU/GPU wave arrays, LOD fade radii, CPU evaluation |
| `src/ocean/spectrum.ts` | component construction and stable system/role ordering |
| `src/render/GpuProfiler.ts` | tile-safe rotating prefix timers and raw sample history |
| `src/render/OceanProfileProbe.ts` | variant list, sample statistics and report formatting |
| `src/debug/GraphicsPanel.ts` | manual ocean switches and sweep UI |
| `src/main.ts` | probe freeze, warm-up, collection and restore lifecycle |
| `src/ui/RenderStats.ts` | live structural workload and smoothed timing overlay |
| `tests/ocean-profile-probe.test.ts` | variant/statistics coverage |
| `tests/gpu-profiler.test.ts` | cumulative-prefix timing derivation |
| `tests/shader-source.test.ts` | selected shader invariants |

Important current facts:

- canonical production slot order is stable for morphing and is **not**
  globally wavelength-sorted;
- any residual sorting must be a separate render-only table;
- `NUM_VERTEX_WAVES` and `NUM_RESIDUAL_WAVES` are diagnostic compile-time
  limits on this branch;
- `OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE` removes signed phase/slope work while
  retaining classification/variance work;
- `OCEAN_PROFILE_DISABLE_FOAM` removes the whole ocean-fragment foam block;
- `OCEAN_PROFILE_FLAT` provides the minimal fragment baseline;
- `DETAIL_OCTAVES` is now adjustable by the diagnostic material settings;
- all diagnostic settings restore to the shipping 48/48/five-octave/foam/LUT
  configuration after the sweep.

---

## 11. Known caveats and traps

### Per-pixel categories are not global

Never describe a component as universally “in the mesh” or universally
“roughness.” Its representation depends on local mesh LOD and pixel footprint.

### “Does not contribute” needs qualification

- geometry-resolved waves contribute through interpolated vertex gradient;
- residual-visible waves contribute signed per-pixel gradient;
- sub-pixel waves contribute variance;
- only unused amplitude-zero slots truly contribute nothing.

The optimizer skips individual residual work, not physical energy.

### The stable wave table cannot simply be sorted

Sea-state morphing relies on stable system/role slot identity. Reordering the
canonical arrays can reset/misbind phases and break CPU/GPU parity. Build a
separate residual view/table.

### Prefix variance is only valid for fully classified blocks

Do not aggregate a block merely because its wavelengths are short. Prove the
original formula gives full `missing` and zero `visible` for that block at the
pixel. Evaluate transition components normally.

### Shader source simplicity does not predict GPU speed

Dynamic bounds, uniform-array indexing, unrolling, register pressure, branch
divergence and tile architecture can erase an apparent arithmetic reduction.
Trust the counterfactual timer.

### Raw ocean-prefix values can be negative/noisy

They are signed differences between cumulative endpoints on adjacent frames.
That is unbiased but noisy. Use whole-frame deltas when only one shader changes.

### Do not confuse wall cadence with GPU duration

FPS/frame interval includes presentation and browser scheduling. GPU queries
measure WebGL execution. CPU and GPU totals overlap and must not be added.

### Detail and residual visual roles overlap but are not interchangeable

Turning `DETAIL_OCTAVES` to zero does not disable residual waves. Residual waves
are the geometry field's dropped components; detail is a separate procedural
ripple stack.

---

## 12. Recommended handoff summary — implementation round starts here

The next engineer/session should begin with this claim:

> The ocean is fragment-bound. At 3370×1628, the exact 48-slot residual scan is
> a repeatable approximately 16.5–17.5 ms counterfactual cost. Removing phase
> and cosine does not reduce it, and the structural probes (§13) acquitted the
> loop's execution: branches, uniform access and unrolling are all innocent,
> and a dynamic loop bound is free. The cost is examining 48 slots per pixel.
> The implementation round builds the exact wavelength-ordered residual active
> window with aggregate prefix variance (§8 Priority A), measured against the
> existing compile-time profiler and validated with the frozen-frame diff
> harness.

### Session-start checklist

- `npm run dev` (or the `drift` launch entry), open
  `/?debug=graphics&fixedDpr=2`;
- graphics panel → "ocean GPU probe": **Run component sweep** reproduces the
  §6/§13 tables; **Verify loop variants** runs the frozen-frame pixel diff
  with its shipping-vs-shipping control row; **Restore default** and the
  sweep's own finally-restore both return to the active-window shipping shader;
- headless, the same entry points are `__drift.sim.runOceanProfileProbe` and
  `__drift.sim.runOceanResidualDiff`. In the hidden agent pane rAF is dead
  and timers are clamped to one second: install a MessageChannel-based rAF
  pump, kick it with a single screenshot, pace it near 45 ms, and trust only
  GPU-timer sweep deltas — readPixels-fenced wall times in a hidden pane
  carry ~100 ms of scheduler overhead per sync (§13.2);
- work order: §9 step 2 (category-distribution histogram, sizes the ceiling)
  → step 3 (CPU reference for the ordered evaluation) → the dynamic-window
  prototype (§9 step 4) → steps 5–7 validation, benchmark and decision gate.

### Implementation rules the probes bought

- keep the shipping loop's early-out structure inside whatever window
  survives — the branchless probe says forcing every slot through the full
  arithmetic is a 5–10× regression, so the early-outs are savings to
  preserve, not overhead to remove;
- keep the residual-only table in uniform arrays; the texelFetch path
  measured +2.76 ms worse;
- a dynamic start/end index is free — spend the design effort on deriving
  exact per-pixel window bounds, not on avoiding the dynamic loop;
- validation bar: the `texture` and `rolled` probes proved a restructured
  loop can be **bit-identical**, so aim for bit-identical. The active
  window's aggregated variance may reorder float summation and cost a
  last-ulp difference; if the diff harness reports anything other than
  exactly zero, the change needs Ash's explicit A/B sign-off before landing —
  anything softer than pixel-identical is not self-certifiable here.

Do not begin by:

- changing the visual wave band;
- changing the canonical 48-wave spectrum;
- shrinking the disc;
- replacing the whole renderer with FFT;
- optimizing vertex displacement;
- approximating trigonometry;
- removing the loop's early-outs or moving its parameters to textures (§13).

### Out of scope for this round

The cached gas-sky LUT the ocean's reflection reads (commit 8221024) landed
without a recorded pixel-diff, and it is definitionally not pixel-identical to
the analytic sky it replaced. Its look validation — the near-field calm-water
mirror around a low sun, where the Mie aureole's gradient lives — is
deliberately a **separate task Ash runs on its own**, not part of the
active-window round. Leave it alone here.

First measure the per-pixel category distribution, then prototype the smallest
exact active-window implementation and let the GPU timer decide whether it is a
real win.

---

## 13. Structural probe results — 2026-07-31 follow-up session

Before designing the active-window scheme, three cheap structural probes asked
whether the 17 ms was a pathology of how the loop executes rather than of what
it computes. Each probe recompiles `residualWaveGradient()` with identical
mathematics and a different structure, selected by
`OceanProfileSettings.residualLoopMode` (graphics panel: "Residual loop
structure"; sweep keys `residual-48-texture` / `residual-48-rolled`).

### 13.1 The probes

| mode | what it changes | hypothesis it tests |
|---|---|---|
| `branchless` | replaces the two per-pixel `continue`s and the phase branch with selects; every slot runs the full arithmetic | warp divergence from per-pixel branches is the cost |
| `texture` | fetches wave parameters with `texelFetch` from RGBA32F textures wrapping the same Float32Arrays the uniforms upload | ANGLE's uniform-array translation is the cost |
| `rolled` | hides the loop bound behind a uniform so the compiler cannot unroll | unrolling 48 bodies (register/instruction pressure) is the cost |

Correctness was proven first with the new frozen-frame diff harness
(`runOceanResidualDiff`, graphics panel: "Verify loop variants"), which
brackets the run with a shipping-vs-shipping control row. At 3370×1628, day:

- `texture`: **bit-identical** — every pixel matches shipping exactly;
- `rolled`: **bit-identical**;
- `branchless`: max 1 display LSB on 0.0001% of pixels (≈6 px of 5.5 M — the
  float edge at the 0.002 thresholds), mean 0.00000;
- control row: exactly identical, so the frozen frame was genuinely static.

### 13.2 Timings

Same automated sweep, 3370×1628, fixed DPR 2, day, world/camera frozen, 24
warm-up frames, 12 raw rotations (agent pane, hidden-tab rAF pump paced at
45 ms):

| variant | GPU frame | Δ vs base optics | Δ vs shipping loop |
|---|---:|---:|---:|
| base water optics | 10.43 ± 1.30 ms | — | — |
| + 48 residual, shipping loop | 26.76 ± 1.55 ms | +16.33 ± 0.59 ms | — |
| + 48 residual, classify/variance only | 26.44 ± 1.30 ms | +16.01 ± 0.53 ms | -0.32 (noise) |
| + 48 residual, `rolled` | 26.91 ± 1.43 ms | +16.48 ± 0.56 ms | **+0.15 ± 0.61 ms (noise)** |
| + 48 residual, `texture` | 29.52 ± 1.25 ms | +19.09 ± 0.52 ms | **+2.76 ± 0.58 ms (worse)** |
| + 48 residual, `branchless` | starves the sweep's 30 s sample deadline | — | **roughly 5–10× slower** (readPixels-fenced ≥100 ms/frame vs ~27) |

The rest of the sweep reproduced sweeps A–C within run-to-run systematics
(residual 12/24/36/48 → 4.21/8.23/13.25/16.33 ms; classify ≈ full; detail
0.97/2.60/3.68; foam 1.16; vertex rows at the noise floor; analytic sky
+2.93 vs cached).

### 13.3 What this settles

1. **The branches are load-bearing, not a divergence tax.** Forcing every slot
   through the full arithmetic with live intermediates was catastrophic —
   consistent with register-pressure collapse plus the loss of real per-pixel
   work-skipping. Never "optimize" this loop by removing its early-outs. The
   `branchless` mode is deliberately excluded from the automated sweep (it
   starves the sample deadline) and survives only as a manual panel mode.
2. **Uniform-array access is not the bottleneck.** The texelFetch path is
   measurably worse. Keep any new residual-only table in uniforms.
3. **Unrolling is not the bottleneck, and — the useful half of the result —
   a dynamic loop bound costs nothing.** The Priority A risk list said a
   dynamic start/end index might forfeit the compile-time loop's optimization;
   it does not. A per-pixel active window keeps its theoretical saving
   available. (The probe's bound is a uniform, so per-pixel divergence of the
   bound is still unmeasured — but the shipping loop's own branches already
   diverge per pixel and are what make it fast.)
4. Together with the near-linear slot scaling (~0.34 ms per examined slot),
   the scan's cost is the honest price of examining 48 slots at millions of
   pixels. There is no structural pathology to exploit. **The only way down is
   to examine fewer slots per pixel** — exactly Priority A (wavelength-ordered
   active window + prefix variance), with Priority B (annulus banks) as the
   fallback.

The measured order of the next experiment is unchanged: category-distribution
histogram (§9 step 2), CPU reference (§9 step 3), then the dynamic-window
prototype — now with its biggest compiler unknown retired.

---

## 14. Active-window implementation and results — 2026-07-31

The Priority A experiment is complete. It is a material GPU win and is selected
by default in `Ocean`; the original 48-slot canonical scan remains available as
the `shipping`/"legacy 48-slot baseline" diagnostic mode.

### 14.1 What was implemented

- `WaveField` maintains a second, render-only table containing active
  components in ascending wavenumber order. The canonical `waveA`/`waveB`
  arrays, slot identities, vertex displacement, CPU buoyancy and sea-state
  morphing are unchanged.
- The render table is rebuilt with a stable, allocation-free insertion sort
  when the spectrum or LOD spacing changes. Only its phase column is refreshed
  on ordinary animation frames.
- Each fragment performs two fixed six-step lower-bound searches: the first
  component not already geometry-resolved, and the first component proven
  fully statistical. Only the interval between those boundaries runs the
  original component formula and early-outs.
- A cumulative base slope-energy total represents the fully statistical suffix
  with one subtraction and one accumulation. Partial geometry and Nyquist
  transition components remain individually evaluated with the original
  formulas.
- The graphics panel now includes lossless RGBA8 category probes, a six-scenario
  category matrix, an A-B-B-A active benchmark and the existing frozen-frame
  structural diff. These probes restore the previous scene and shader state in
  `finally` blocks.
- A pure TypeScript reference compares the ordered path with the canonical
  brute scan. It covers all sea presets, two mid-morph states and 80 randomized
  position/LOD/footprint samples per state (960 comparisons total).

### 14.2 Measured active width

Both diagnostic passes encode integer counts exactly in RGBA8. Every accepted
ocean pixel in every scenario summed to all 48 canonical slots.

| sea and camera | mean individually evaluated | p95 | maximum | scan reduction vs 48 |
|---|---:|---:|---:|---:|
| dead calm, close horizon | 0.02 | 0 | 5 | 100.0% |
| production, medium | **2.53** | 9 | 13 | **94.7%** |
| production, maximum high | **12.84** | 17 | 17 | **73.3%** |
| Southern rough, close horizon | 0.66 | 5 | 23 | 98.6% |
| Southern rough, medium | 2.59 | 9 | 29 | 94.6% |
| Southern rough, maximum high | 25.97 | 34 | 36 | 45.9% |

The normal production medium view therefore examines about 2.5 individual
components per ocean pixel instead of 48. Even the deliberately punishing
Southern Ocean maximum-distance view skips about 46% of the legacy scan.

### 14.3 Full-frame GPU result

The landing metric brackets the complete legacy and active-window oceans in
A-B-B-A order. Each row receives 24 warm-up frames and 12 raw GPU-prefix
rotations; each aggregate therefore has `n=24`. The drawing buffer was
3370×1628 in both repetitions.

| run | legacy frame | active frame | whole-frame gain | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| 1 | 33.40 ± 1.55 ms | 23.40 ± 1.50 ms | **10.01 ± 0.44 ms (30.0%)** | 24.06 → 13.49 ms |
| 2 | 35.60 ± 1.55 ms | 24.33 ± 1.43 ms | **11.27 ± 0.43 ms (31.7%)** | 25.10 → 14.37 ms |

Across the two runs, the mean frame moved from **34.50 ms to 23.87 ms**: an
average **10.64 ms / 30.8%** improvement. The absolute means drifted between
runs, but both internally bracketed deltas agree.

### 14.4 Correctness and visual parity

- All **295 tests in 19 files** pass, including the 960 randomized CPU-reference
  comparisons and category-buffer integrity tests.
- Production build and TypeScript checking pass.
- Two clean 3370×1628 frozen-frame comparisons were run with an exact final
  legacy-vs-legacy control. The active path was bit-identical in one. In the
  other, exactly **one of 5,486,360 pixels** differed, by **one display LSB**;
  no pixel differed by more than one LSB. The mean rounds to 0.00000 LSB and
  the changed fraction is approximately 0.000018%.
- The last-ulp difference is consistent with the expected floating-point
  summation-order change in the aggregated variance suffix. No wave band,
  phase, fade, geometry, buoyancy or visual policy was changed.
- Browser diagnostics contained no runtime or shader errors. The only warning
  was Three.js's existing `PCFSoftShadowMap` deprecation notice.

This meets the practical zero-look-risk objective, but it is important not to
misreport the second capture as literal bit identity. The legacy mode and all
measurement controls remain available for future regression checks.

---

## 15. Next performance lane — five-octave detail stack

The residual active window changes the starting point for all further ocean
work. The next substantial measured target is the analytic detail-gradient
stack in `Ocean.ts`: its five octaves cost **3.6–5.2 ms** as an isolated
counterfactual in the pre-active sweeps. Against the new approximately 24 ms
full frame that is a nominal 15–21% ceiling, not an expected saving; GPU work is
non-additive, and the full active shader has not yet been bracketed with detail
on and off.

The visual constraint is as important as the timing. Detail supplies the
mid-distance sparkle and much of the structure in bright reflections. The next
round optimizes how those five octaves are represented and selected. It does
not begin by reducing their energy, frequency range or accepted appearance.

### 15.1 Step 1 — establish the new full-shader baseline

Add a dedicated full-ocean A-B-B-A benchmark analogous to
`runOceanResidualActiveBenchmark`:

- hold the residual loop on the new `active` default;
- compare the complete five-octave shipping ocean with detail disabled;
- optionally add one- and three-octave rows for scaling, but keep the primary
  statistic five versus zero;
- keep sky LUT, foam, sea state, camera, framebuffer and every other shader
  region fixed;
- use 24 warm-up frames and at least 12 raw GPU-prefix rotations per row;
- report whole-frame delta first and the ocean-prefix difference as a
  cross-check;
- repeat the bracket twice at a verified 3370×1628 drawing buffer.

Do not carry the old 3.6–5.2 ms marginal forward as though it were measured in
the new shader. This step establishes the recoverable ceiling after the
residual win changed register pressure, latency hiding and full-frame balance.

### 15.2 Step 2 — measure the live-octave distribution

Instrument the existing Nyquist decision rather than guessing from camera
distance. For each ocean pixel, classify every configured octave as:

- fully visible analytic detail (`fade == 1` within the shader's thresholds);
- partial Nyquist transition, which must retain the exact current formula;
- fully statistical, whose slope energy is represented only in variance;
- individually noise-evaluated (`fade > 0.002`).

The octave cell size decreases monotonically by `sqrt(5)`, so the
noise-evaluated octaves form a prefix plus at most a narrow transition boundary.
Record mean, p50, p90, p95 and maximum live counts, plus the proportion of
pixels with zero through five noise evaluations. Run the same close, production
medium and maximum-high cameras used by the residual category matrix, at least
for dead calm, the production sea and Southern Ocean rough.

Production uses `directional` detail motion. Measure that path first. Preserve
the laboratory's `counterflow` and `evolving` modes, but report them separately:
counterflow performs two 2D noise evaluations per live octave and evolving uses
the 3D field, so mixing their counts with production would obscure the target.

### 15.3 Step 3 — prototype the exact active-prefix path first

This is the lowest-look-risk experiment and should precede a texture rewrite:

1. derive the last potentially live octave from `footprint`, base cell size and
   the fixed `sqrt(5)` frequency progression;
2. dynamically loop only over that prefix;
3. retain the current `noisedPeriodic` evaluation, derivative transform,
   amplitudes, motion and exact smooth fade for every live or partial octave;
4. add the fully retired suffix's lost slope variance in aggregate. Its
   amplitude and frequency follow fixed geometric progressions, so the suffix
   sum can be precomputed or expressed as a short closed form;
5. keep an individually evaluated boundary wherever `0.002 < fade < 1`.

The residual structural probes already established that a dynamic loop bound
is free on the target WebGL2 driver. This experiment asks how much bookkeeping
remains after the existing branch has skipped the expensive noise call; its
saving may therefore be modest. Build a TypeScript brute/reference pair across
random footprints, strengths and all supported octave counts before trusting a
GPU image diff.

Decision gate: land this path if repeated full-frame brackets show a material,
stable saving and the frozen-frame control passes. If it is below roughly the
one-millisecond measurement floor, retain the instrumentation but do not add
shipping complexity merely because the source loop is shorter.

### 15.4 Step 4 — texture-backed detail only if the prefix is insufficient

The larger opportunity is to replace repeated analytic gradient-noise work
with a periodic, prefiltered gradient/normal representation:

- preserve the existing 256-cell periodic domain and exact world-space wrap;
- preserve each octave's transform, independent scroll, amplitude and total
  slope variance;
- use mip selection or explicit footprint fades so sub-pixel energy moves into
  roughness rather than vanishing or aliasing;
- benchmark texture bandwidth and cache generation as part of the whole frame,
  not just the cheaper ocean sample;
- keep the analytic shader behind a diagnostic A/B switch;
- either retain the analytic implementation for non-production counterflow and
  evolving modes, or explicitly validate a representation that supports them.

A sampled texture will generally not be bit-identical to the quintic analytic
field. Its acceptance therefore requires more than a still-image mean diff:

- strict framebuffer diff at close, medium and maximum cameras;
- calm and rough seas;
- daylight, low sun/sunset and night/lamp conditions;
- motion inspection through the sensitive 40–150 m sparkle band;
- no shimmer, mip pumping, repeated-tile reveal, origin-wrap pop or change in
  reflection width;
- explicit visual sign-off before it replaces the analytic path.

A realistic goal for the complete detail lane is **2–4 ms**, but only the new
baseline and prototypes can establish it.

### 15.5 What follows detail

If detail lands cleanly, continue in this order:

1. **Foam fragment shading — 1.2–2.2 ms isolated marginal.** First split field
   sampling, breakup noise and lighting into counterfactual variants. Then seek
   provably empty-pixel early-outs or mathematically valid reuse of detail-noise
   data. The separate foam simulation pass is not included in this number.
2. **Base water optics — 3.1–3.9 ms isolated marginal.** This is a bundle of
   Fresnel/BRDF, absorption, cloud reflection and haze work rather than one
   known hot loop. Instrument its subregions before choosing an intervention;
   its look risk is higher than detail bookkeeping or empty-foam rejection.

Continue not to prioritize the vertex-wave loop, disc radius, residual cosine
or canonical wave count. Existing measurements either put those below the
floor, locate them in the wrong stage, or show that changing them alters the
surface rather than removing overhead.

### 15.6 Definition of done for the next round

- current full-active detail cost measured twice with valid bracket controls;
- live-octave histogram recorded for the representative camera/sea matrix;
- CPU reference and randomized tests for any active-prefix/variance algebra;
- full-resolution GPU A-B-B-A result for every candidate;
- still-frame diff bracketed by an exact unchanged-path control;
- motion validation across the mid-distance sparkle band;
- default restored automatically after every probe;
- result, including a rejected experiment, appended here with exact numbers.

---

## 16. Detail diagnostics and prefiltered candidate — 2026-07-31

This round completed the baseline instrumentation and produced a first
texture-backed replacement behind a diagnostic switch. **The shipping default
remains the analytic five-octave stack.** User review eliminated every current
replacement: directional texture B, periodic value-noise C and detail-disabled
D. A was better in Southern rough and Current Production, including the
corrected full-near-water comparisons. C's repeatable performance gain is
useful evidence for the texture-backed lane, but C itself is closed.

### 16.1 Instrumentation added

- A complete detail-on/detail-off A-B-B-A benchmark holds the residual loop on
  `active`, keeps the full ocean shader intact and uses the established 24
  warm-up frames plus 12 raw rotations per row.
- A lossless RGBA8 detail-category pass records fully visible, transition and
  fully statistical octave counts. Its decoder verifies that every accepted
  ocean pixel sums to all five configured octaves.
- A nine-scenario matrix covers dead calm, production and Southern Ocean rough
  at the close, medium and maximum-high cameras.
- A second A-B-B-A benchmark compares the complete analytic and prefiltered
  representations.
- The first frozen contact sheet showed analytic, filtered directional,
  filtered value-noise and detail-disabled frames at one identical simulation
  instant. After user review eliminated the directional and disabled variants,
  the capture was reduced to a full-screen A/C comparison: analytic versus
  filtered periodic value noise. The app restores the previous shader setting
  after capture.
- The graphics panel exposes `analytic 5-octave baseline` and `prefiltered
  3-band candidate`; `Restore default` returns to analytic.

At 2560×1440 / DPR 2, the settled ordinary-view analytic-vs-disabled bracket
measured **4.69 ± 2.63 ms** whole-frame detail cost, with the ocean-prefix
cross-check moving **23.52 → 18.18 ms**. This agrees with the historical
3.6–5.2 ms lane, although the whole-frame interval is noisy.

### 16.2 Live-octave matrix

The mean below is the number of analytic noise evaluations per accepted ocean
pixel. Every decoded pixel passed the five-octave sum invariant.

| sea and camera | mean live octaves | p50 | p95 |
|---|---:|---:|---:|
| dead calm, close horizon | 4.33 | 4 | 5 |
| dead calm, production medium | 3.74 | 4 | 5 |
| dead calm, maximum high | 0.46 | 0 | 2 |
| production, close horizon | 4.30 | 4 | 5 |
| production, production medium | 3.47 | 4 | 5 |
| production, maximum high | 0.27 | 0 | 1 |
| Southern rough, close horizon | **4.77** | 5 | 5 |
| Southern rough, production medium | 3.35 | 3 | 5 |
| Southern rough, maximum high | 0.16 | 0 | 1 |

This explains why a pure active-prefix rewrite was not the first implementation
step after instrumentation: the existing branch already avoids the expensive
noise call for retired octaves, while the important close and production views
still evaluate roughly 3.4–4.8 of five octaves. Shortening only the cheap loop
bookkeeping has little recoverable ceiling and does not address the observed
speckled look.

### 16.3 Lighting diagnosis

The work count is footprint-driven, but appearance is strongly lighting-driven.
At Southern Ocean rough, 15:00 local apparent solar time, the analytic stack
draws a dense field of clipped white points. Setting the graphics panel's
direct-sun multiplier to zero removes many of them, but a substantial patterned
highlight remains from reflected sky/cloud radiance. The defect is therefore
not simply a cloud toggle: direct sun amplifies and saturates it, while the
normal field also breaks up the bright environment reflection.

Visual checks must keep sea/camera and lighting as separate matrices. The same
normal representation was inspected in Southern rough daylight, production
daylight and production sunset; the rough daylight case remains the acceptance
stress test.

### 16.4 Candidate representation

`detailGradientTexture.ts` builds a deterministic 512×512 RGBA8 periodic
gradient texture. RG and BA contain two independently phased directional ripple
spectra. The texture uses repeat wrap and trilinear mip filtering; its 256-cell
domain therefore retains the existing exact detail wrap. Including mip levels,
each texture costs about 1.33 MiB. It is allocated lazily on the first matching candidate
selection, so the analytic production default pays neither its generation time
nor its memory cost.

The shader samples three bands:

1. coarse energy from octaves 0–1;
2. middle energy from octave 2 at the existing two-step integer transform;
3. micro energy from octaves 3–4 at the three-step integer transform.

Each band receives the root-sum-square slope energy of the octaves it
represents. Energy deliberately not drawn by the candidate is returned to the
per-pixel variance term. Hardware mip selection integrates the sampled bands
over their screen footprint instead of point-sampling five procedural fields.

The diagnostic now preserves two three-band texture fields for user comparison:

- `directional spectrum`, whose visible structure is longer and more aligned;
- `periodic value noise`, whose visible structure forms shorter, rounder
  regions.

An earlier two-sampled-band experiment is not currently exposed because it
carried materially less near-field slope energy than either three-band version.
That was an engineering observation, not a visual acceptance decision; restore
it if neither three-band option gives the user enough comparison range.

No texture field is promoted or dismissed on the implementer's taste. Both are
visible redesigns rather than parity optimizations. The user judged the
analytic A frames clearly best in Southern rough and Current Production,
eliminated directional B and detail-disabled D, and retained periodic
value-noise C only as a possible compromise if its performance gain proved
large. In the original clipped sheet, C was slightly worse in mid water and
more clearly worse in distant water; its near water could not be judged.
Corrected A/C captures showed the full near-water edge. The user judged A
better in every case, so C failed the visual gate and does not proceed to
motion or wrap validation.

### 16.5 Performance result and decision gate

All timings below used 2560×1440 / DPR 2, the full active-window ocean, 24
warm-up frames and 12 raw rotations per A/B row. They compare analytic A with
the surviving periodic value-noise C candidate.

| condition and bracket | analytic frame | value-noise frame | whole-frame saving | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| Southern rough, 15:00, 1 | 22.20 ± 1.40 ms | 18.08 ± 1.30 ms | **4.12 ± 0.39 ms (18.6%)** | 14.43 → 11.09 ms |
| Southern rough, 15:00, 2 | 23.23 ± 1.43 ms | 21.13 ± 1.67 ms | **2.10 ± 0.45 ms (9.0%)** | 16.82 → 12.74 ms |
| Current Production, 15:00, 1 | 18.99 ± 1.44 ms | 15.45 ± 1.43 ms | **3.54 ± 0.42 ms (18.6%)** | 11.59 → 7.85 ms |
| Current Production, 15:00, 2 | 19.08 ± 1.55 ms | 15.64 ± 1.48 ms | **3.44 ± 0.44 ms (18.0%)** | 12.18 → 8.23 ms |

The production repeats are exceptionally consistent: C saves about 3.5 ms per
frame, clearing the 2 ms performance gate. The rough case is positive in both
brackets but varies from 2.1 to 4.1 ms. One production startup bracket and one
later bracket with a six-millisecond A1/A2 drift were deliberately excluded
from the table; neither is needed to establish the result.

For historical completeness, the now user-rejected directional B field also
measured faster in two heavily loaded rough brackets (15.26 ± 4.59 ms and
13.96 ± 5.41 ms), but its appearance rules it out regardless of timing.
Separate analytic-vs-disabled rough brackets measured **15.84 ± 3.49 ms** and
**11.62 ± 3.14 ms**; detail-disabled D was also rejected visually.

Decision:

- keep analytic A as the default and keep all probes;
- B, C and D are closed; do not spend more benchmark or visual-review time on
  them unless the user explicitly reopens them;
- C passed the performance gate but failed the visual gate;
- retain the diagnostic harness and design the next detail representation
  around A's actual field rather than weakening or replacing its whole visual
  character;
- only after this visual decision move to foam fragment shading.

### 16.6 Recommended next experiment

Detail remains ahead of foam because it combines a larger measured cost with
an unresolved visible defect: A is the best current image, but its finest
resolved normals still produce objectionable clipped white speckle in bright
Southern rough conditions.

Do not build another synthetic three-band field. Build a faithful cache of the
existing `noisedPeriodic` gradient field instead:

1. generate a higher-resolution periodic gradient map from the same analytic
   field and 256-cell domain;
2. keep all five existing octave transforms, independent scrolls, amplitudes,
   Nyquist fades and variance accounting—the texture sample replaces only the
   expensive hash/interpolation evaluation;
3. compare at least 1024² and 2048² cache resolutions so texture interpolation
   error is visible and its bandwidth cost is measured;
4. retain the analytic path for counterflow/evolving laboratory modes until
   they receive separate validation;
5. expose a second hybrid candidate that keeps analytic octaves 0–2 exactly
   and progressively routes only octaves 3–4 through a mip-filtered cache or
   the existing lost-variance term. This is the controlled lever for reducing
   white micro-speckle without discarding the broad and mid-scale structure
   that made A preferable.

The next contact sheets should therefore contain A plus faithful-cache and
hybrid-micro variants, frozen at identical instants. Southern rough at 15:00 is
the primary defect/stress case; Current Production daylight and a low-sun case
are required guards. The user remains the visual judge. Benchmark only variants
the user keeps, with the same A-B-B-A harness and a target of at least 2 ms
repeatable production saving.

Verification at this point: **304 tests in 21 files pass**, TypeScript and the
production build pass, and browser testing found no shader/runtime errors.

---

## 17. Faithful analytic caches and micro hybrid — 2026-08-01

The §16.6 experiment is implemented behind diagnostic switches. The shipping
default is still analytic A; no candidate has visual approval.

### 17.1 Implementations

`detailGradientTexture.ts` now contains a CPU mirror of the shipping
`hash22`/`noisedPeriodic` spatial derivative. It samples that exact periodic
field into RGBA8 gradient maps rather than constructing a statistically similar
replacement. The maps retain:

- the 256-cell domain and exact repeat;
- all five existing integer octave transforms;
- each octave's independent scroll, amplitude and Nyquist fade;
- the existing per-pixel lost-variance handoff.

Five resolutions are exposed. The three smaller maps were added after the user
approved E1 in the cinematic comparisons but asked to search downward for the
smallest cache that preserves the image:

| candidate | texels per analytic cell | RGBA8 + mip memory |
|---|---:|---:|
| E0.25 faithful cache 256² | 1×1 | about 0.33 MiB |
| E0.5 faithful cache 512² | 2×2 | about 1.33 MiB |
| E0.75 faithful cache 768² | 3×3 | about 3.00 MiB |
| E1 faithful cache 1024² | 4×4 | about 5.33 MiB |
| E2 faithful cache 2048² | 8×8 | about 21.33 MiB |

The maps are allocated lazily, so analytic production A pays no memory or
generation cost.

F is a separate hybrid. Octaves 0–2 remain the original analytic calls.
Octaves 3 and 4 use the 2048² faithful map with explicit-normal weights 0.70
and 0.35. The removed resolved energy is transferred into the existing slope
variance term instead of being discarded. This is intentionally a visual
candidate for reducing clipped micro-speckle, not a parity claim.

Faithful/hybrid candidates currently support the shipping `directional` motion
mode. Selecting counterflow or evolving automatically restores analytic detail;
those laboratory modes have not been texture-validated.

### 17.2 Performance

Every row below used 2560×1440 / DPR 2, the full active-window ocean, 24
warm-up frames and 12 raw rotations per A/B row in A-B-B-A order.

Current Production, 15:00, production camera:

| candidate and bracket | analytic frame | candidate frame | whole-frame saving | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| E1 1024², 1 | 18.03 ± 1.43 ms | 14.60 ± 1.23 ms | **3.44 ± 0.39 ms (19.1%)** | 10.73 → 7.86 ms |
| E1 1024², 2 | 17.62 ± 1.39 ms | 14.85 ± 1.10 ms | **2.76 ± 0.36 ms (15.7%)** | 10.94 → 8.02 ms |
| E2 2048², 1 | 17.50 ± 1.14 ms | 14.97 ± 1.20 ms | **2.53 ± 0.34 ms (14.5%)** | 10.77 → 7.89 ms |
| E2 2048², 2 | 18.04 ± 1.26 ms | 14.87 ± 1.29 ms | **3.17 ± 0.37 ms (17.6%)** | 10.67 → 8.19 ms |
| F hybrid, 1 | 17.74 ± 1.27 ms | 16.07 ± 1.30 ms | **1.67 ± 0.37 ms (9.4%)** | 10.72 → 9.27 ms |

Southern Ocean rough, 15:00, production camera:

| candidate and bracket | analytic frame | candidate frame | whole-frame saving | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| E1 1024², 1 | 21.03 ± 1.40 ms | 18.29 ± 1.20 ms | **2.75 ± 0.38 ms (13.1%)** | 14.67 → 11.41 ms |
| E1 1024², 2 | 22.59 ± 1.47 ms | 19.51 ± 1.43 ms | **3.07 ± 0.42 ms (13.6%)** | 15.30 → 12.34 ms |
| E2 2048², 1 | 21.13 ± 1.00 ms | 18.86 ± 1.39 ms | **2.27 ± 0.35 ms (10.7%)** | 14.42 → 11.12 ms |
| E2 2048², 2 | 22.25 ± 1.63 ms | 19.09 ± 1.34 ms | **3.17 ± 0.43 ms (14.2%)** | 15.14 → 12.28 ms |
| F hybrid, 1 | 23.23 ± 1.04 ms | 21.12 ± 1.49 ms | **2.11 ± 0.37 ms (9.1%)** | 15.98 → 14.56 ms |

Both faithful resolutions clear the 2 ms gate repeatably. E1 averages about
3.10 ms saved in Current Production and 2.91 ms in Southern rough; E2 averages
about 2.85 ms and 2.72 ms respectively. The 2048² field therefore buys more
sampling fidelity at a modest bandwidth/memory cost. F is slower because it
retains three analytic calls, but remains a useful visual option if its micro
filtering materially improves the bright-water defect.

### 17.3 Visual gate

Full-resolution, identical-instant A/E1/E2/F captures were made for:

1. Southern Ocean rough at 15:00;
2. Current Production at 15:00;
3. Current Production at 18:15, sun elevation 9°.

All captures include the full near-water edge. The user is the visual authority;
no candidate is accepted, rejected or promoted from implementer taste. The user
accepted E1 in every cinematic condition and could not distinguish it from A,
then deliberately paused promotion to test smaller maps and a closer embodied
view. If the selected faithful cache passes that review, benchmark its
allocation/warm-up behaviour and exact wrap crossings before promotion.

### 17.4 Downward cache search and embodied close-water gate

E0.75, E0.5 and E0.25 retain the exact same five shader lookups and octave
logic. Only the sampled field resolution changes. Consequently a smaller map
can save memory and improve cache locality, but cannot remove more shader
instructions than E1.

One A-B-B-A bracket per new size, at the same 2560×1440 / DPR 2 settings:

Current Production, 15:00:

| candidate | analytic frame | candidate frame | whole-frame saving | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| E0.75 768² | 16.27 ± 1.20 ms | 13.38 ± 1.49 ms | **2.89 ± 0.39 ms (17.8%)** | 9.69 → 7.22 ms |
| E0.5 512² | 15.56 ± 1.26 ms | 12.87 ± 1.38 ms | **2.70 ± 0.38 ms (17.3%)** | 9.04 → 7.06 ms |
| E0.25 256² | 17.81 ± 1.46 ms | 14.75 ± 1.54 ms | **3.06 ± 0.43 ms (17.2%)** | 10.44 → 8.07 ms |

Southern Ocean rough, 15:00:

| candidate | analytic frame | candidate frame | whole-frame saving | ocean-prefix cross-check |
|---|---:|---:|---:|---:|
| E0.75 768² | 19.42 ± 1.25 ms | 16.73 ± 1.46 ms | **2.69 ± 0.39 ms (13.8%)** | 11.57 → 8.73 ms |
| E0.5 512² | 19.71 ± 1.44 ms | 16.68 ± 1.69 ms | **3.03 ± 0.45 ms (15.4%)** | 11.93 → 9.65 ms |
| E0.25 256² | 19.54 ± 1.38 ms | 17.96 ± 1.92 ms | **1.59 ± 0.48 ms (8.1%)** | 11.98 → 10.33 ms |

The result is not monotonic: 768² and 512² are statistically in the same band
as E1's earlier repeated 2.8–3.1 ms savings, while 256² becomes slower in the
rough sea. There is therefore no measured performance case for accepting a
visible quality loss below 1024². The useful remaining question is purely the
user's visual one: whether 768² or 512² still match A in the new close-water
gate.

The contact-sheet harness now has two selectable four-way sets and an embodied
close-water mode. That mode cuts to the first-person controller without letting
a transition advance the frozen world, turns over the raft's side, and pitches
down 35° so the frame contains the water within a few metres rather than a
literal straight-down photograph of the raft logs. Matched full-resolution
sets were captured for Current Production and Southern Ocean rough at 15:00:

- previous round: A / E1 1024² / E2 2048² / F hybrid;
- downward search: A / E0.75 768² / E0.5 512² / E0.25 256².

Promotion remains paused for this user visual decision. The production default
is still analytic A.

### 17.5 Production promotion — 2026-08-01

After direct live comparison on the rebased current-master build, the user
approved the faithful 1024² cache across many ocean, lighting and camera
conditions and preferred it to the hybrid. E1 is now the production default;
the analytic implementation remains available as the A/reference diagnostic.
`Restore default` returns to the active residual window plus faithful 1024²
detail.

The choice deliberately favours the visually approved 1024² field over a
further memory reduction. Its RGBA8 mip chain costs about 5.33 MiB and is
allocated at ocean startup. Earlier A-B-B-A brackets measured approximately
3.10 ms saved in Current Production and 2.91 ms in Southern Ocean rough versus
analytic A. Those absolute timings predate the cloud-fix rebase and must be
remeasured on the integrated build before quoting a final whole-frame gain.
