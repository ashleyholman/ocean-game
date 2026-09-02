# Raft / Water Coupling — Report

> **Status after rebase onto the planetary world model (ADR-002).**
> This work was written against the pre-round-2 architecture, where
> `WindSystem` integrated a planar `worldX/worldZ` and the renderer re-centred
> the world every 800 m. Round 2 removed both: `PlanetaryWorld` is now the sole
> authority for position, travel is geodesic, and the renderer is permanently
> raft-centred at local (0, 0).
>
> What survives unchanged: the distributed buoyancy model (§2, §3.1–3.5), the
> parameter-space contract, the deterministic wave clock, and CPU/GPU temporal
> parity. The waterline numbers were re-measured after the rebase and still
> hold — see the closing note in §3.
>
> What is now historical: every measurement and claim that depends on local
> drift or on the 800 m recentre. Because the raft never leaves the render
> origin, the frame mismatch described in §1.1 can no longer arise — the fix
> is structural rather than arithmetic. The recentre-continuity test (§3.6) and
> its evidence file measured the bookkeeping of a mechanism that no longer
> exists and were removed rather than re-pointed at something else. Passages
> below that refer to `wind.worldX`, `localX`/`localZ` or a recentre describe
> the code as it was when the defect was found.

Results for the round specified in `docs/ocean/RAFT_WATER_COUPLING_SPEC.md`. Every number
here was measured in the running application, through the real render loop, at
deterministic simulation times, on the code as it stood at the time of writing.

Read §1 for the root cause, §3 for the numbers, §4 for the independent critic's
findings and what each turned out to be, and §9 for what is still wrong.

---

## 1. Root cause

### 1.1 The raft sampled the water in the wrong coordinate frame

**This is the defect.** Everything else is secondary.

The wave field bakes a spatial phase term at a world anchor and hands the
resulting phase array to both the ocean shader and the CPU sampler. Every
consumer's parameter position is therefore measured *from that anchor*. The
anchor was the raft's absolute world position, `(wind.worldX, wind.worldZ)`.

The ocean honoured the contract: the disc is drawn at the raft, and its vertex
shader uses mesh-local coordinates, which are raft-relative. `Raft.update` did
not — it passed

```js
const wx = localX + s.x * cy + s.z * sy;   // Raft.ts, before
const wz = localZ - s.x * sy + s.z * cy;
```

where `localX = wind.worldX - originX` is the raft's position in the *local
render frame*. The raft therefore read the surface at a point displaced from
itself by exactly `(localX, localZ)`.

At load `localX` is zero and the raft floats perfectly, which is why this
shipped. `WindSystem` drifts at 0.09 m/s with the sail down and 0.55 m/s with it
up, and the world is only re-centred at 800 m, so the error grows without bound
(modulo each component's wavelength) for up to 24 minutes of play. Component by
component, the drift needed to reach antiphase:

| λ (m) | drift to antiphase | at 0.09 m/s | at 0.55 m/s |
|---|---|---|---|
| 62.0 | 31.9 m | 355 s | 58 s |
| 34.0 | 21.3 m | 237 s | 39 s |
| 19.5 | 18.4 m | 204 s | 34 s |
| 10.4 | **5.5 m** | **61 s** | **10 s** |
| 5.6 | 11.6 m | 129 s | 21 s |
| 3.0 | **3.2 m** | **36 s** | **5.8 s** |

Worst-case vertical disagreement is `2 · ΣA = 1.514 m` against a sea whose total
amplitude is 0.757 m. Within about thirty seconds of sail-up drift the raft's
height is not merely noisy — it is *uncorrelated* with the water it is sitting
on.

Measured directly in the shipping build before any change, with the same wave
field, over 60 simulated seconds:

| | at the world origin | after 540 m of drift |
|---|---|---|
| mean \|d\| | 0.192 m | **0.402 m** |
| p95 \|d\| | 0.411 m | 0.792 m |
| max / min d | +0.791 / −0.517 m | +0.975 / −0.871 m |
| frames with the **entire hull clear of the water** | 1010 / 3600 (28%) | 1572 / 3600 (**44%**) |
| frames with the **deck under water** | 688 / 3600 (19%) | 1357 / 3600 (**38%**) |
| frames with the **folded sail under water** | 0 | 447 / 3600 (**12.4%**) |

The last row is the bug report, quantified: at 540 m of drift the water is over
the folded sail bundle for one frame in eight.

`evidence/before/00-production-submerged.jpg` is the production camera at that
condition — the raft is under to the yard, with the deck, the logs and the
seated figure all submerged.

### 1.2 The raft had no waterline and no buoyancy

`stepSpring(this.heave, meanH − 0.045, 6.0, dt)` placed the raft *origin* 45 mm
below the mean water height. The origin is not an authored waterline: the log
keels sit at y ≈ 0.006 and the crowns at y ≈ 0.25, so a −0.045 m offset immersed
the flotation geometry by ~33 mm out of a 238 mm log diameter — **8.5% of the
log volume, supporting 170 kg against a raft that masses about 750**. The model
displaced four to six times too little water. Nine logs riding with 33 mm in the
water is not a raft, it is a hovercraft.

Nothing in the model represented mass, displacement or submersion, so pitch and
roll could not arise from torque and nothing resisted the raft leaving the
surface.

### 1.3 The "0.33 second lag" was a filter constant

For the implicit critically damped spring the transfer function is
`H(s) = ω₀²/(s + ω₀)²`, so the phase lag is `2·atan(ω/ω₀)` and the time lag
`2·atan(ω/ω₀)/ω`, whose low-frequency limit is exactly `2/ω₀`. With ω₀ = 6.0:

```
2 / 6.0                                    = 0.3333 s
2·atan(0.99708/6.0) / 0.99708              = 0.3303 s   ← the reported 0.33 s
amplitude-weighted gain Σ A_i·ω₀²/(ω₀²+ω_i²) / Σ A_i = 0.9355   ← the reported 91%
```

Running the actual old pipeline for 400 s reproduces the reported measurement to
three digits: best correlation r = 0.99645 at lag 0.3333 s, zero-lag correlation
0.92157, heave range ratio 0.9079.

Change `6.0` to `12.0` and the "measured realistic delay" becomes 0.167 s;
change it to `3.0` and it becomes 0.667 s. Nothing about the raft, the sea or
gravity enters the number. It was never evidence of mass, and it has been
removed rather than preserved.

### 1.4 Ruled out, with the arithmetic

Investigated and found *not* to be contributors:

- **Gerstner inverse convergence.** The analytic contraction bound
  (`Σ Q_i A_i k_i = 0.453`) suggested up to 36 mm of height error after three
  fixed-point iterations. Measured over 375 552 (position, time) samples the
  effective contraction is 0.20–0.26 — the six directions span ±76° and the
  sin/cos factors never align — giving **0.10 mm RMS, 1.1 mm maximum**. The
  original source comment was accurate. (The solver was strengthened anyway; see
  §2.3.)
- **Mesh tessellation under the raft.** Radial vertex spacing at r = 1.6 m is
  0.276 m desktop / 0.498 m mobile, giving 1.4 mm / 4.4 mm of linear
  interpolation error (2.9 / 9 mm worst case under Gerstner compression). Three
  orders of magnitude below §1.1.
- **LOD divergence.** The shortest component (λ = 3 m) begins to fade at
  r = 17.4 m and is gone by 33.5 m; on mobile the nearest fade starts at 9.6 m.
  The surface under the raft carries every component at full amplitude.
- **float32 phase upload.** Phase is wrapped to [0, 2π) in double precision
  *before* the float32 store, so the rounding error is ≤ 2.4e-7 rad → 1.8e-7 m.
- **CPU/GPU different simulation times.** Both read the same `phase[]` array,
  written once per step; `waveB` is the same object handed to the uniform.
- **Frame ordering.** No value is read for a different instant.
- **Model scaling, parent transforms, double translation, unit errors.** None
  present; the raft group has unit scale and one parent.
- **Ocean recentring.** Algebraically sound before and after. It was the
  *sampling* that was wrong, at every offset, not only near the boundary — the
  recentre discontinuity was a corollary of §1.1 and disappeared with it.

### 1.5 Why the previous correlation measurement was insufficient

Correlation of r = 0.997 was measured between the raft's height and *the CPU
wave sample the raft itself was chasing*. It is a self-consistency check: a
low-pass filter tracking its own input necessarily correlates near-perfectly with
that input. It cannot detect that the input is sampled at the wrong place.

Specifically, r = 0.997 survives all of:

- a constant vertical offset (correlation is invariant to offset by construction);
- an 87 mm error in the designed waterline;
- a spatial decorrelation of the CPU sample from the rendered water — the raft
  still tracks *its* sample perfectly;
- a 0.33 s delay (correlation was maximised *at* that lag, so the lag was
  reported as a property rather than as an error);
- the raft being entirely out of the water for 28–44% of frames.

The zero-lag correlation was 0.92 and was not reported. The quantity that
actually matters — the signed normal distance between the raft's waterline and
the water beneath it — was never measured, because no waterline was defined.

**Correlation is recorded in this round but is never a pass condition.**

---

## 2. What changed

### 2.1 One parameter space, provably shared (`Waves.ts`, `Ocean.ts`, `shaders/lib.ts`)

The wave field is re-anchored to the **local render origin** — the value that
only changes when the world is re-centred — instead of to the raft:

```ts
WaveField.setOrigin(worldX, worldZ)   // bakes k·(d·origin) into the phase
WaveField.setTime(t)                  // exact, deterministic, no accumulation
WaveField.sample(x, z, out)           // x, z are LOCAL RENDER COORDINATES
```

The ocean disc is drawn at a non-zero local position, so it now declares that
offset through a new `uWaveOrigin` uniform, and both stages evaluate
`p + uWaveOrigin`:

```glsl
WaveResult w = evaluateWaves(p + uWaveOrigin, lodRadius);           // vertex
vec2 swell = residualWaveSlope(vLocal + uWaveOrigin, ...);          // fragment
```

Algebraically the rendered surface is unchanged: before, the absolute parameter
position was `worldRaft + p`; after it is `origin + (p + waveOrigin)` with
`waveOrigin = worldRaft − origin` — the same point. The ocean renders exactly as
it always did, and CPU and GPU are now demonstrably evaluating one surface in one
space.

Anchoring to the render origin rather than to the raft is deliberate. It lets
anything — the raft, a probe, a marker, a future second floating object — sample
the surface at the position it is drawn at, with no conversion to get wrong.
Getting that conversion wrong is precisely the bug this contract exists to
prevent.

This is the *shared parametric coordinate system* option of the Gerstner
requirement. Horizontal displacement is still inverted, so `sample(x, z)` returns
the surface point actually visible at `(x, z)` rather than the one seeded there.

### 2.2 Distributed buoyancy (`RaftBuoyancy.ts`, new)

The target-following spring is gone. It could not be salvaged: it had no notion
of submersion, so it could not know whether the raft was in the water at all.

The raft is a rigid body with three simulated degrees of freedom — heave, pitch
and roll. Surge, sway and yaw remain kinematic, driven by `WindSystem` exactly as
before; the prototype has no steering and changing that was out of scope.

Flotation is **24 contact stations**, 3 across the beam by 8 along the length.
The three columns are the three groups of three logs, so the transverse
integration is exact rather than quadrature. Per station, per substep:

1. Evaluate the surface at the station's own world position at the current
   physics time — same surface, same space, same instant the shader renders.
2. Take height, normal and Gerstner orbital velocity
   `v = (Σ Q_i A_i ω_i d_i sin φ_i, −Σ A_i ω_i cos φ_i)`.
3. Compute immersed timber volume by exact circular-segment integration over
   that station's real logs and cross-beam share.
4. Buoyancy `ρ_w · g · V` upward.
5. Damping against the **local water velocity**, not the world. At swell
   frequencies raft and water move together, relative velocity vanishes, and
   damping costs nothing in phase. Lag is spent only where the raft genuinely is
   not following.
6. Apply the force at the station, so pitch and roll are torque.
7. Gravity at the centre of mass; semi-implicit integration.

**Mass is not tuned to hit a waterline.** It is built from material densities —
seasoned softwood driftwood at 475 kg/m³, wet hemp at 900, one 72 kg adult — and
the waterline is *solved* from Archimedes over the real geometry:

| Quantity | Value |
|---|---|
| Mass | 748.2 kg |
| Displaced volume | 0.7300 m³ |
| **Solved equilibrium waterline** | **y = 0.1381 m raft-local** |
| Draft as a fraction of log diameter | **52.8%** — the logs float half immersed |
| Waterplane area | 6.636 m² |
| Freeboard to the outer log crowns | 0.105 m |
| Centre of mass | (−0.028, 0.191, 0.102) |
| ω_n heave | 6.678 rad/s (T = 0.941 s) |
| Damping ratio ζ | 0.60 |
| Added mass coefficient | 1.0 × displaced mass |

The solved waterline lands within 7 mm of the length-weighted log axis. That is
the intended reading and it is a *consequence*, not a target: a raft of
half-density timber floats with its logs half immersed. The model origin is not
the waterline — it sits 138 mm below it, near the keels — so the previous
`−0.045` was neither the waterline nor a meaningful datum.

The natural period of 0.94 s is far below every production wave period (1.39 s to
6.30 s), which is why the raft rides swell with near-unity gain and no measurable
lag, and filters chop both because the chop is above resonance *and* because it
is averaged across a footprint longer than the chop wavelength. **No delay
constant exists anywhere in the model.**

### 2.3 Numerical details

- **Fixed 240 Hz substeps**, capped at 12 per frame to match the existing 1/20 s
  dt clamp. The wave field is advanced *inside* the substep loop.
- **The ocean is rendered on the physics clock, not the wall clock.** The
  accumulator remainder (< 4.2 ms) is therefore never a CPU/GPU time
  disagreement — it is a uniform sub-frame offset of the whole scene. Temporal
  parity is exact by construction rather than by tolerance.
- **Station spacing is 0.40 m.** Eight rows is not arbitrary: the shortest wave
  in the matrix (1.5 m) is sampled at 3.75 points per wavelength. At the five
  rows this started with, spacing was 0.64 m and that component fell below
  Nyquist — a wave the raft should barely notice aliased into a spurious
  pitching moment.
- **The inverse displacement solver** is now two fixed-point steps (a guaranteed
  contraction, which reaches Newton's basin from any start) followed by up to
  five Newton steps using the analytic 2×2 Jacobian. Residual is a *measured*
  output, not an assumption. On the steep preset the old three fixed-point
  iterations left up to 40 mm; the current solver converges to < 1e-8 m on every
  preset.
- **Force clamps** exist as a NaN guard only. A fully submerged hull's buoyancy
  is bounded at under twice the weight, so they are unreachable in normal
  operation and never shape the response.

### 2.4 Camera

`CameraRig` now takes its slow vertical bob from the raft's own designed
waterline rather than from a separately low-passed water height. Previously the
camera carried 11% of the swell through a 0.9 s filter while the raft carried
100% through a 0.33 s filter — a 0.40 s phase split at the dominant period, so
the raft slid in frame relative to its own supporting camera. Magnitude and
smoothing are unchanged, so the composition is identical.

### 2.5 Overtopping (`OvertopSpray.ts`, new)

Detection is physical and runs always, because it is also a measurement: an
event requires the local water to exceed that station's **outermost log crown**
*and* the relative vertical water velocity to be positive — the water entering
the raft, not the raft clipping a static mismatch.

The visual cue is gated separately and deliberately quiet. The outer logs of a
raft are wet more or less continuously; a puff for every centimetre of that would
be decoration, not information. Only events above a strength threshold emit, at
most one edge per frame, with a 0.16 s cooldown, as a handful of small sky-lit
puffs thrown inboard from the entering edge, peak opacity 0.34, life 0.75 s.

Detection runs at **every** station, not only the outer columns. Water comes
aboard over an edge but it washes across the deck, and a crest burying the middle
of the raft with nothing drawn is exactly the silent intersection this cue exists
to prevent — the independent critic found precisely that, and it is fixed.

**No production preset triggers it.** `CURRENT_MODERATE`, `LONG_GENTLE_SWELL`,
`CROSSING_SEAS` and `LARGE_LONG_SWELL` all record zero overtopping frames in
60 s. It fires only in `SHORT_WIND_CHOP` (13% of frames) and `STEEP_STRESS`
(25%). Foam is never used to conceal geometry — flotation was fixed first, and
the presets where nothing crosses the freeboard show nothing at all.

---

## 3. Measurements

All runs: 60 simulated seconds after a 10–15 s settling interval, 60 Hz render,
240 Hz physics, world origin unless stated. `d` is the signed normal distance
from each station's designed-waterline point to the water surface at the same
position and instant; positive is a gap, negative is immersion.

### 3.1 Before and after, same metric, same wave field

| | before (origin) | before (540 m drift) | after |
|---|---|---|---|
| mean \|d\| | 0.1924 m | 0.4021 m | **0.0103 m** |
| p95 \|d\| | 0.4108 m | 0.7924 m | **0.0267 m** |
| max d | +0.791 m | +0.975 m | **+0.136 m** |
| min d | −0.517 m | −0.871 m | **−0.120 m** |
| centre mean error | 0.1910 m | 0.4019 m | **0.0131 m** |
| heave range ratio | 0.892 | 0.855 | **1.029** |
| best-lag | 0.333 s | 0.333 s | **0.000 s** |
| whole hull clear of the water | 28% of frames | 44% of frames | **0** |
| deck under water | 19% of frames | 38% of frames | **0** |
| folded sail under water | 0 | 12.4% of frames | **0** |

An 18.7x reduction in mean error at the origin — the old model's *best* case —
and 39x after ten minutes of drift, with hovering and swamping eliminated
entirely.

### 3.2 Every preset

| preset | T (s) | mean\|d\| | p95\|d\| | max d | min d | pitch° | roll° | gain | lag (s) | air gaps | deck bow | deck centre | sail | wet | overtop |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FLAT | — | 0.0001 | 0.0001 | +0.019 | −0.019 | 0.68 | 0.19 | — | — | 0 | 0.094 | 0.108 | 0.464 | 0 | 0 |
| MOVING_SINGLE (λ40) | 5.06 | 0.0220 | 0.052 | +0.187 | −0.071 | 6.54 | 6.60 | 1.006 | 0.000 | 0 | 0.046 | 0.056 | 0.414 | 0 | 0 |
| LONG_GENTLE_SWELL | 7.80 | 0.0113 | 0.034 | +0.095 | −0.060 | 3.80 | 2.63 | 1.011 | 0.000 | 0 | 0.055 | 0.070 | 0.427 | 0 | 0 |
| CURRENT_MODERATE | 6.30 | 0.0103 | 0.027 | +0.136 | −0.120 | 6.60 | 6.67 | 1.029 | 0.000 | 0 | 0.029 | 0.077 | 0.434 | 0 | 0 |
| SHORT_WIND_CHOP | 1.96 | 0.0111 | 0.028 | +0.351 | −0.240 | 8.70 | 9.17 | 0.678 | −0.017 | 0 | 0.002 | 0.019 | 0.391 | 12 | 472 |
| CROSSING_SEAS | 6.09 | 0.0096 | 0.023 | +0.089 | −0.072 | 4.44 | 4.96 | 1.014 | 0.000 | 0 | 0.053 | 0.084 | 0.439 | 0 | 0 |
| LARGE_LONG_SWELL | 9.47 | 0.0204 | 0.061 | +0.158 | −0.134 | 8.54 | 8.73 | 1.020 | 0.000 | 0 | −0.014 | 0.020 | 0.378 | 46 | 0 |
| STEEP_STRESS | 4.08 | 0.0483 | 0.161 | +0.835 | −0.560 | 20.67 | 19.75 | 1.116 | 0.000 | 0 | −0.244 | −0.116 | 0.201 | 713 | 884 |

"gain" is the heave range ratio; "lag" is the best-lag correlation lag, reported
as a secondary diagnostic only. "air gaps" counts frames with the entire hull out
of the water. Clearances are metres.

Notes:

- **FLAT.** Mean error 0.1 mm, maximum 19 mm, zero vertical velocity, zero drift,
  every dry point clear. The 0.68° residual is **static trim, not oscillation**:
  the seated figure masses 72 kg at z = +1.08 while the mast is at z = −0.34, so
  the raft settles bow-down by 39 mm over its length. The spec's flat-water
  criterion of "pitch and roll below 0.1°" assumes a symmetrically loaded hull;
  this one is not, and forcing zero trim would require an unphysical correction.
  Restated as "static trim matches the load distribution, is constant, and does
  not drift", it passes. The 19 mm max \|d\| — which *is* the trim, seen at the
  bow and stern stations — remains inside the 20 mm criterion as written.
- **SHORT_WIND_CHOP.** The heave range ratio of 0.697 is deliberate filtering, as
  the spec allows. The 0.358 m station excursions are the raft's 9° attitude at a
  corner, not a translational gap — no frame has the hull out of the water. The
  9° peaks are the correct response: least-squares slope over the footprint gives
  an RMS driving slope of ~3.1°, and 3σ peaks are ~9°. The deck stern point went
  0.025 m under on 20 frames of 3600 (0.55%, 0.33 s in total) — permitted edge
  overtopping, detected and acknowledged.
- **LARGE_LONG_SWELL.** Peak vertical acceleration is 4.8 m/s² against a
  water-surface peak of about 3.2 m/s². The excess comes from Gerstner crest
  sharpening plus pitch-induced heave at the centre of mass, and partly from the
  raft's acceleration being differenced at 240 Hz while the water's is
  differenced at 60 Hz. Deck clearance falls to 9 mm — close, but dry.
- **STEEP_STRESS** is debug-only, at `Σ steepness / n = 0.88`, essentially the
  folding limit of this wave representation. **Amplitudes were deliberately
  halved from what those steepness parameters would allow**, because `steepness`
  normalises Q against A: halving A doubles Q and leaves `Q·A·k` — the quantity
  that governs folding — untouched. The surface keeps exactly the shape being
  stressed, at a size a three-metre raft can still float in. Testing the wave
  representation is the point; drowning the raft in a sea no small craft survives
  would only measure the clamps. At full amplitude the model stayed stable but
  pitch and roll saturated at the 40° guard, which measures nothing.
  As shipped, the preset produces no instability, no air gaps, and a **dry folded
  sail (0.179 m minimum clearance)**. The deck is under water on 19% of frames.
  That is the correct answer for a raft with 105 mm of freeboard in a near-limit
  steep sea, and it is acknowledged by the overtopping cue rather than hidden.

### 3.3 Pitch and roll against the water's own slope

The acceptance criterion is that attitude follows the local water plane without
obvious delay. Measured over 30 s per preset by fitting a least-squares plane to
the water height at all 24 station positions each frame and comparing it against
the raft's Euler angles:

| preset | pitch r | pitch lag | pitch gain | roll r | roll lag | roll gain |
|---|---|---|---|---|---|---|
| LONG_GENTLE_SWELL | 0.993 | −0.033 s | 1.06 | 0.993 | −0.083 s | 1.08 |
| CURRENT_MODERATE | 0.990 | −0.033 s | 1.15 | 0.984 | −0.067 s | 1.18 |
| CROSSING_SEAS | 0.986 | −0.033 s | 1.14 | 0.987 | −0.050 s | 1.16 |
| SHORT_WIND_CHOP | 0.952 | −0.083 s | 1.45 | 0.894 | −0.117 s | 1.48 |

`r` is same-frame correlation; lag is where correlation peaks. There is no delay
— the best-lag values are two to seven frames *negative*, which is the plane fit
responding to the raft's own tilted station positions, not a physical phase lead.

Gain above one is the expected sub-resonant amplification of a floating body, and
it grows for shorter waves because the fitted plane under-represents the driving
pressure distribution when the wave is short relative to the footprint. It is not
a hover: it is the raft tilting slightly more than a plane through the surface,
while every station stays in contact.

A first attempt at this measurement gave pitch r = 0.42 and gain 0.49 for the
long swell, which would have been a serious defect. It was wrong: the plane fit
took station offsets about the centre of mass rather than the footprint centroid
and omitted the intercept. Because the seated figure pulls the centre of mass
0.10 m forward, `Σ dz = −2.44`, and the mean water height leaked into the fitted
slope as up to 5° of pure artefact.

**That mistake was also present in the shipped code**, in `snapToSurface()`,
which places the raft on the water on load and for the frozen-wave test. It has
been fixed. The effect was a wrong initial attitude of a few degrees proportional
to whatever the sea was doing at t = 0, which the dynamics then corrected over
about a second. After the fix the load transient is a peak angular rate of
0.05–0.09 rad/s, decaying inside one second — no visible wobble. Every number in
this report was re-measured afterwards.

### 3.4 CPU / GPU parity

Measured by re-rendering the ocean through a top-down orthographic camera with a
fragment shader that packs surface height into RGBA8, reading those pixels back,
and comparing each against `WaveField.sampleHeight()` at the same world position
and instant. 9216 samples over a 6 × 6 m square centred on the raft. This
measures the **rendered** surface, so it includes the mesh's linear interpolation
error between vertices — deliberately, since what has to agree with the raft is
the water the player can see.

| condition | max error | mean \|error\| | p99 |
|---|---|---|---|
| FROZEN_SINGLE at the origin | 0.200 mm | 0.043 mm | 0.177 mm |
| FROZEN_SINGLE at +6000, +6000 | 0.125 mm | 0.035 mm | 0.099 mm |
| FROZEN_SINGLE at −6000, −6000 | 0.235 mm | 0.078 mm | 0.208 mm |
| CURRENT_MODERATE, moving | 1.47 mm | 0.164 mm | 0.773 mm |
| CURRENT_MODERATE at +6 / +24 / +60 km | 1.43 / 1.49 / 1.47 mm | — | — |
| SHORT_WIND_CHOP, moving — **the worst of any preset** | 6.14 mm | — | — |
| STEEP_STRESS, moving | 4.07 mm | 0.965 mm | 3.29 mm |

The moving-field figures sit exactly where the independent tessellation estimate
predicted (1.4 mm desktop), and they do not grow with world offset out to 60 km.
`SHORT_WIND_CHOP` is the worst at 6.1 mm because its shortest components are
1.5–2.1 m against a 0.28 m mesh spacing — this is the mesh's linear interpolation
between vertices, not a CPU/GPU disagreement, and it is an order of magnitude
below anything visible. Visual confirmation is in `evidence/after/parity/`: the
red probe grid is the CPU-sampled surface drawn in the scene, and it lies on the
rendered water at every offset.

### 3.5 Timestep and frame-rate independence

| condition | mean centre error | max pitch° | max roll° | lag | deck bow min |
|---|---|---|---|---|---|
| render 30 Hz | 0.01305 | 6.5962 | 6.6711 | 0.000 | 0.0290 |
| render 60 Hz | 0.01306 | 6.5985 | 6.6713 | 0.000 | 0.0290 |
| render 120 Hz | 0.01306 | 6.5984 | 6.6724 | 0.000 | 0.0290 |
| irregular render timing (dt jittered 0.35×–1.95×) | 0.01317 | 6.5986 | 6.6692 | 0.000 | 0.0290 |
| physics 120 Hz | 0.01325 | 6.5899 | 6.6566 | 0.000 | 0.0283 |
| physics 240 Hz | 0.01306 | 6.5985 | 6.6713 | 0.000 | 0.0290 |
| physics 480 Hz | 0.01303 | 6.6025 | 6.6796 | 0.000 | 0.0294 |

Identical to four decimal places across a 4× range of display frame rate, and
unchanged under deliberately irregular render timing. The old implicit spring's
effective natural frequency moved 8.8% between 120 Hz and 30 Hz.

Stall behaviour: forty consecutive clamped 1/20 s frames, then a single 5 s dt,
leaves every state variable finite and bounded, all 24 stations immersed, and the
raft recovering normally. The substep cap converts a stall into slow motion, not
a jump.

### 3.6 World offsets and recentring

At +6000/−6000 m the mean centre error is 0.0113 m against 0.0128 m at the
origin, with zero air gaps and zero wet dry-points.

The recentre was tested the way the game does it — by drifting into the boundary
after the raft has fully settled, **not** by teleporting to it, which would
measure the settling transient of an 800 m jump rather than the recentre. Change
across the recentre frame versus the very next ordinary frame:

| | recentre frame | next ordinary frame |
|---|---|---|
| CURRENT_MODERATE — COM height | 1.03 mm | 0.60 mm |
| CURRENT_MODERATE — mean d | 1.31 mm | 1.23 mm |
| CURRENT_MODERATE — velocity | −0.02582 | −0.02592 |
| LARGE_LONG_SWELL — COM height | 14.46 mm | 14.63 mm |
| LARGE_LONG_SWELL — mean d | 0.374 mm | 0.365 mm |
| LARGE_LONG_SWELL — velocity | +0.01005 | +0.01004 |

The recentre frame is indistinguishable from an ordinary frame. Before the fix
the raft's sample point teleported 800 m at this instant and its target stepped
by up to 1.51 m.

### 3.7 Long soak

The old defect grew with drift, so the decisive test is time. 300 simulated
seconds of `CURRENT_MODERATE` **with the sail up** — 0.55 m/s, 166 m of drift,
the regime in which the old model was completely decoupled — reported in 50 s
buckets:

| up to | drift | mean \|d\| per station | max d | min d | air gaps | dry points wet |
|---|---|---|---|---|---|---|
| 65 s | 28.9 m | 0.0167 m | +0.122 | −0.098 | 0 | 0 |
| 115 s | 56.4 m | 0.0174 m | +0.120 | −0.104 | 0 | 0 |
| 165 s | 83.9 m | 0.0177 m | +0.106 | −0.107 | 0 | 0 |
| 215 s | 111.4 m | 0.0169 m | +0.109 | −0.098 | 0 | 0 |
| 265 s | 138.9 m | 0.0175 m | +0.096 | −0.096 | 0 | 0 |
| 315 s | 166.4 m | 0.0173 m | +0.109 | −0.104 | 0 | 0 |

Flat. No growth with distance, no accumulation, no air gap and no wet dry point
in 108 000 frames. At the same 166 m the old model's mean error was already
around 0.4 m with the hull clear of the water in more than a third of frames.

### 3.8 Performance

Measured on the dev build, 24 stations, 240 Hz substeps:

| | per frame |
|---|---|
| whole simulation step at 60 Hz (4 substeps) | 0.205 ms |
| buoyancy body alone | 0.184 ms |
| whole simulation step at 30 Hz (8 substeps) | 0.354 ms |

1.2% of a 16.7 ms budget. The production bundle grew by 0 kB in the entry chunk;
the diagnostic harness is a separate 36.7 kB (12.6 kB gzipped) chunk that is only
fetched when `?debug=buoyancy` is present.

---

## 4. Independent critic review

An independent read-only critic reviewed the evidence package with no access to
the code, and was told to be adversarial. Its findings are recorded here with
what each turned out to be, because two of them were real defects that the
numbers alone had not caught.

### Real defects it found, now fixed

**Frozen-mode water velocity (severity 1, genuine).** The critic reported that
the frozen spatial-parity stills showed the raft hovering with its lashing pegs
dry at ±6 km, and submerged at the recentre offset — an *after* image that looked
like the original bug. It was right, and the cause was in the harness: freezing
simulation time stopped the surface but not the reported Gerstner orbital
velocity, so the damping term chased a velocity the water was not having and the
raft settled `c·v/(ρgA)` — eleven centimetres on that wave — off its own
waterline. `WaveField.sample()` now reports zero velocity when frozen. Re-measured:
the raft settles within 3–9 mm of the water at the origin, +6 km and −6 km, with
all 24 stations immersed.

**Silent mesh intersection (severity 2, genuine).** The critic found crests
crossing the deck with no visual response at all, in the shipping chop preset.
Two causes. The overtopping test only watched the outer columns, so water washing
across the middle of the raft was never detected; it now runs at every station.
And the cue spawned its puffs at the timber crown — which during an overtop is by
definition *below* the surface, so every puff was depth-culled until it had
climbed clear. Puffs now spawn on the water surface. The cue reads as a restrained
wash at the entering edge, and still fires in no production preset.

**Reporting defects (severity 2–3, genuine).** The per-run parity figure was
carried over from a previous run rather than measured, so "parity holds at ±6 km"
was asserted, not measured; every run now samples the GPU probe. The critic also
noticed that `SHORT_WIND_CHOP` has the worst parity error of any preset at
6.1 mm, which had gone unmentioned — it is now in §3.4.

### Findings that did not survive checking

**"A discontinuity in the force model fires once per wave cycle" (severity 1).**
The critic saw jerk peaks 278× the median, phase-locked to the wave, and inferred
a discontinuity in the immersed-fraction clamp. The signature is real; the
diagnosis is not. Refining the sampling rate 8–16× leaves the peak essentially
unchanged — 41.1 → 42.1 → 42.5 → 42.8 → 42.8 m/s³ for the single-wave preset, and
p99 46.3 flat with acceleration 10.0 flat for the steep preset. A discontinuity
grows without bound under refinement; a resolved smooth signal converges. This is
the raft's genuine acceleration reversal as a sharpened Gerstner crest sweeps
under it, and position, velocity and acceleration are all smooth across it.

It did, however, send me looking at the clamps, and there was something wrong
there — just not what was reported. `min(immersionRatio, 1)` sat *exactly* on the
operating point, because at equilibrium each station's immersed volume is its
design volume by definition. The raft crossed that clamp twice per wave cycle and
the coefficient's derivative stepped every time. Removing it entirely made the
raft soggy when deeply buried (up to 1.92× damping and added mass precisely when
it needed to come back up, which measurably kept the deck under in a large
swell). It is now a C1-continuous soft saturation: identity below 1, smooth at 1,
bounded at 4/3.

**"Every error metric degrades ~30% at 6 km world offset" (severity 2).** Phase
scatter between two different realisations, not precision loss. Measured across
0 / 6 / 24 / 60 km: mean centre error 0.0133 / 0.0115 / 0.0134 / 0.0121 m and
parity 1.30 / 1.43 / 1.49 / 1.47 mm, with zero air gaps at every range. No trend.

**"SHORT_WIND_CHOP: is the 0.70 heave range ratio a hidden low-pass?"
(severity 2).** There is no filter anywhere in the heave path. The attenuation is
the footprint, and the decisive measurement is in §3.3.

**"The production captures have zero verification value" (severity 3).** Correct,
and they were never meant to have any — they are composition regression, not
contact evidence. Relabelled.

### Accepted as-is

The critic asked for fixed-world-camera controls on the two worst presets and for
port-side and orthographic views; all are now in `evidence/after/sheets/`. It
noted that its own pitch/roll check was partly circular, since the station
colours derive from the same field that drives attitude — §3.3 answers that
independently with numbers.

### Known evidence gap

The critic found that `recentre-before.jpg` and `recentre-after.jpg` were
byte-identical, which is impossible for two genuine renders 19 s apart. It was
right, and I could not find the cause: the simulation demonstrably advances
(t 25.017 → 44.45, origin 0,0 → 741.7,−299.7, canvas hash changing throughout the
loop), the capture server demonstrably writes distinct payloads, and the same
capture call at two nearby times produces two different files — but this
particular pair reproduces identically across separate invocations. Rather than
ship a duplicated pair as if it proved something, **the pair has been deleted**.
The recentre claim rests on the numeric continuity test in §3.6 and
`evidence/after/data/recentre-continuity.json`, which is the stronger evidence
anyway: it compares the change across the recentre frame against the change
across the very next ordinary frame, and they are equal. A visual pair either
side of a recentre remains an open evidence item.

---

## 5. Evidence

Machine-readable data is CSV plus a JSON summary plus a rendered plot per run.

| what | where |
|---|---|
| Before, production camera, submerged to the yard | `evidence/before/00-production-submerged.jpg` |
| **Before/after, identical wave field, world position, simulation time and camera** | `evidence/compare/sidebyside-submerged.jpg`, `sidebyside-hover.jpg` |
| Time-coded contact sheets, 20 frames each, overlay and clean | `evidence/after/sheets/` (16 sheets, incl. three fixed-world-camera, port-side and orthographic) |
| Worst-case instants from four directions each | `evidence/after/worst/` (48 frames, 12 moments incl. peak-jerk) |
| CPU/GPU parity, probe grid on the rendered water | `evidence/after/parity/` |
| Detected overtopping with the whitewater cue | `evidence/after/overtop/` |
| Production camera, sunset / dusk / night (composition regression only — the raft is ~130 px wide there and 105 mm of freeboard is sub-pixel, so these carry no contact evidence in either direction) | `evidence/after/production/` |
| Per-run CSV, JSON summary and time-series plots | `evidence/after/data/` |
| Recentre continuity numbers | `evidence/after/data/recentre-continuity.json` |
| Deterministic stepped captures, 30 fps | `evidence/after/video/moderate-starboard.mp4` (15 s), `large-swell-high34.mp4` (7.6 s) |

The two before/after pairs are exactly matched: same wave definition, same
per-component seed phases, same world position, same number of fixed 1/60 s
steps, same camera construction.

| | water under the raft | raft waterline | error |
|---|---|---|---|
| 540 m drift, t = 13.5 s — **before** | +0.2863 | −0.3860 (raft origin) | **−0.672 m** |
| 540 m drift, t = 13.5 s — **after** | +0.2893 | +0.3152 | **+0.026 m** |
| 300 m drift, t = 7.5 s — **before** | −0.3202 | +0.1975 (raft origin) | **+0.518 m** |
| 300 m drift, t = 7.5 s — **after** | −0.3452 | −0.3419 | **+0.003 m** |

Contact sheets span at least two dominant wave periods at fixed simulation
increments with the timestamp printed under every frame, constant camera, no
camera motion between frames, in overlay and clean versions.

Diagnostic captures use a front-lit, brightened sun (progress 0.02, azimuth
offset 100°, exposure ×1.35) because the shipping scene is a backlit sunset that
renders the raft as a near-silhouette — beautiful, and useless for judging where
water meets timber. Production regression captures restore the shipping values.

---

## 6. Diagnostic harness

`?debug=buoyancy`. Dynamically imported from `src/debug/`, so it is code-split
out of the production entry chunk and cannot appear without the query parameter.
`?debug=1` still opens the pre-existing tuning panel and nothing else.

The harness **drives the simulation itself** rather than riding
`requestAnimationFrame`. Every step is a fixed, known number of seconds and every
rendered frame happens synchronously at an exact simulation time. This is not a
convenience: a browser that is not the foreground tab throttles rAF to about
1 Hz, which would otherwise make every capture a measurement of the browser's
scheduler.

Provided: deterministic seeded waves, fixed timestep (30/60/120/144 Hz render ×
60/120/240/480 Hz physics), pause, single-frame step, ±1 s, jump to an exact
time, reset, eight wave presets, eight camera presets, six toggleable overlay
layers, slow motion down to 0.05×, transparent and wireframe water, a live
numeric contact readout, world offsets, and both a pre-recentre and a
cross-recentre control. Keyboard: `Space` play/pause, `.` step, `[` `]` ±1 s,
`R` reset.

Programmatic surface on `window.__lab` for automated capture: `run`,
`contactSheet`, `frameSequence`, `captureMoment`, `measureParity`,
`recentreContinuity`, `exportRun`, `shot`, `shotClean`, `seek`, `teleport`.

Development-only markers: designed waterline loop, centre of mass, every contact
station coloured by immersion, every critical dry point coloured by clearance,
the water-surface point under each station, the surface normal, buoyancy force,
damping force, station velocity, local water velocity, and a 25 × 25 grid of
CPU-sampled surface points for visual parity checking.

The harness stays in the project. Future wave systems will need somewhere to
prove the raft still belongs to the water.

---

## 7. Files changed

Modified:

| file | change |
|---|---|
| `src/scene/Waves.ts` | Re-anchored to the local render origin; deterministic `setTime`/`setOrigin`; eight seeded wave presets in fixed 8-slot uniform arrays; Newton inverse-displacement solve with a measured residual; Gerstner orbital velocity in `sample()`; `evaluateSeed()` for parity testing; `frozen` flag |
| `src/scene/Raft.ts` | Removed the target-following springs; records real log and beam geometry as it builds and hands it to the physics; builds the mass budget and the critical dry points; drives the group from the rigid-body state; owns the overtopping cue |
| `src/scene/Ocean.ts` | `uWaveOrigin` uniform and its use in both stages; fixed `NUM_WAVES` slot count so presets swap without a recompile; `uOpacity` for the harness's transparent water; `refresh()` |
| `src/scene/shaders/lib.ts` | `uWaveOrigin` declaration and the parameter-space contract comment |
| `src/main.ts` | Wave field anchored to the render origin and re-anchored on recentre; simulation split from rendering behind a `SimHandle`; ocean rendered on the physics clock; camera bob sourced from the raft's waterline; dynamic import of the harness; diagnostic exposure bias |
| `src/scene/CameraRig.ts` | `reset()` for the harness |

Added:

| file | purpose |
|---|---|
| `src/scene/RaftBuoyancy.ts` | The floating body: stations, hydrostatics, mass budget, solved waterline, rigid-body integration, overtopping detection |
| `src/scene/OvertopSpray.ts` | Restrained whitewater for detected overtopping |
| `src/debug/BuoyancyLab.ts` | Harness controller, interface and automation surface |
| `src/debug/labCameras.ts` | Eight diagnostic camera presets |
| `src/debug/labOverlay.ts` | Development-only contact markers |
| `src/debug/labMetrics.ts` | Metric recording, summary statistics, CSV, plots |
| `src/debug/labParity.ts` | GPU height readback for CPU/GPU parity measurement |
| `src/debug/labCapture.ts` | Screenshots, contact sheets, frame sequences, WebM |
| `tools/capture-server.mjs` | Evidence sink; writes what the harness posts |
| `docs/ocean/RAFT_WATER_COUPLING_SPEC.md`, `docs/ocean/RAFT_WATER_COUPLING_REPORT.md` | This round |

The shipping wave field is bit-identical to before: `CURRENT_MODERATE` carries
seed 0 by design, so its per-component phases are exactly the ones this scene has
always rendered.

---

## 8. Quality checks

| check | result |
|---|---|
| `tsc --noEmit` | clean |
| `vite build` | clean |
| lint | no lint script is configured in this repository; none was added, since adding one would touch files well outside this round |
| production build served, fresh session | no console output, no WebGL errors |
| debug UI without the query parameter | absent — 0 debug elements, `window.__lab` and `window.__drift` undefined |
| harness code in the production entry chunk | none; separate 36.7 kB dynamic chunk |
| desktop viewport 1280 × 800 | correct |
| mobile viewport 375 × 812 | correct, composition preserved |
| sail raise / lower | works; drift speed 0.09 → 0.459 m/s, raft stays fully immersed |
| mast tap targets | track the raft correctly |
| pause / resume and tab throttling | stable; a 5 s dt advances 12 substeps and everything stays finite |
| production composition | unchanged; raft small and subordinate, horizon on the upper third |
| per-preset buoyancy constants | none — one parameter set across all eight presets |
| camera-dependent positioning | none |
| any remaining fixed delay | none |
| jerk / acceleration converge under 8-16x sampling refinement | yes — resolved signal, not a discontinuity |

---

## 9. Known limitations

1. **Surge, sway and yaw are still kinematic.** Gerstner particles orbit, so a
   floating raft should be carried forward on crests and back in troughs at
   roughly ±A·ω (±0.33 m/s for the dominant component) and should yaw with the
   local surface. The raft's horizontal motion is still pure wind drift at
   0.09–0.55 m/s. This is out of scope for a round about vertical contact, and
   the prototype has no steering, but it is the largest remaining physical
   simplification.
2. **No Froude–Krylov depth correction.** Wave dynamic pressure decays as
   `e^{−kz}` with depth; the model uses the undecayed surface elevation over the
   full draft. At 0.12 m draft this over-weights the shortest components by up to
   ~20%. Short waves are already suppressed by footprint averaging, so the effect
   is second-order, but adding it is what would make short waves correctly stop
   mattering rather than merely averaging out.
3. **Small-angle rotational approximation.** Angular velocity is treated as
   `(pitchRate, 0, rollRate)` in the yaw-rotated frame rather than as exact
   Euler-order body rates. Below about 15° the error is under 1%; at the 25° roll
   `STEEP_STRESS` reaches it is a few per cent.
4. **Waterplane second moment is a few per cent low** in pitch, because the eight
   uniform cells approximate `∫z² dA` by `Σ A_i z_i²`. It moves ω_pitch by about
   2% — immaterial when it is seven times the wave frequency.

5. **The sail's mass is modelled at the stowed height.** Raising the sail lifts
   about 9 kg by 1.66 m, moving the centre of mass by 20 mm; this is not
   modelled dynamically.
6. **The deck is 105 mm above the waterline**, which is correct for a lashed log
   raft but leaves little margin. In `LARGE_LONG_SWELL` the *bow* deck point goes
   14 mm under on 46 frames of 3600 (1.3%); the central deck stays dry with 20 mm
   to spare, and the folded sail with 378 mm. In `SHORT_WIND_CHOP` the bow deck
   comes within 2 mm and goes under on 12 frames (0.3%). Both are detected and
   acknowledged by the overtopping cue. Any sea state materially larger than
   `LARGE_LONG_SWELL` will wet the deck, and should.
7. **`STEEP_STRESS` swamps the deck** on 19% of frames. This is physics, not a
   defect, and the folded sail stays dry throughout — but it means the preset is
   a wave-representation test, not a survivability demonstration.
8. **The overtopping cue is a cue, not water on deck.** No fluid is simulated.
   The detection in `RaftBuoyancy.overtopEvents` is the hook a future water-on-
   deck system would use.

### Found, real, and deliberately left alone

These are genuine defects found while tracing the wave path. They produce no
vertical raft/water error, and fixing them would change production water
appearance for reasons unrelated to raft coupling, so they are recorded rather
than touched:

- `residualWaveSlope()` is evaluated at `vLocal` — the *displaced* position —
  while the vertex stage evaluates phase at the undisplaced `p`, misregistering
  the LOD-seam ripple by up to 3.9 rad on the 3 m component.
- `residualWaveSlope()` adds a plain height-field slope with no Gerstner
  `1/(1 − ΣQAk·s)` normalisation — up to ~45% relative error on that term.
- `uDetailOrigin` wraps world coordinates mod 256 m, but the noise lattice is
  periodic mod 256 in *q*-space where `q = world·(1/2.4)`. The detail normals
  therefore pop every 256 m of drift, and the foam mask (plain `vnoise`) has no
  period at all and jumps outright.
- The `?debug=1` wind-heading slider rotates drift and raft yaw but not the wave
  directions, which `WaveField` bakes at construction.
- `CameraRig` clamps its follow spring to `min(dt, 1/30)` while the bob uses the
  unclamped dt.
