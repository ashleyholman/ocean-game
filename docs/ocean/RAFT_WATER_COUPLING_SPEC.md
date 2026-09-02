# Raft / Water Coupling — Specification

> **Status after rebase onto the planetary world model (ADR-002).**
> §1 describes the pre-round-2 architecture: a planar `worldX/worldZ` integrated
> by `WindSystem`, and an 800 m world recentre. Round 2 replaced both with
> `PlanetaryWorld` and a permanently raft-centred renderer, so the local drift
> and the recentre that §1 analyses no longer exist. The wave field's origin is
> now a presentation-only phase anchor, fixed at (0, 0) in production and moved
> only by the harness.
>
> The buoyancy specification (§2 onward) is unaffected and is what the shipped
> code implements. Test-matrix rows covering the recentre boundary have been
> dropped; rows covering world offsets are now exercised by moving the wave
> origin instead.

Scope: make the raft unquestionably belong to the water. Diagnosis, corrected
physics, diagnostic harness, test matrices and acceptance criteria. Nothing in
this document covers the celestial cycle, sky art direction, audio, gameplay or
camera composition beyond what is needed to *see* the water contact line.

Companion document: `docs/ocean/RAFT_WATER_COUPLING_REPORT.md` (results).

---

## 1. Current architecture

### 1.1 The wave field

`src/scene/Waves.ts` holds one sum of six Gerstner components. Each component
has a wavelength, amplitude, direction and normalised steepness; the angular
frequency follows deep-water dispersion `ω = sqrt(g·k)`.

Per frame, `WaveField.update(dt, worldX, worldZ)` advances a double-precision
phase per component and wraps it to `[0, 2π)`:

```
phase[i] = ( k[i]·(d[i]·W) − ω[i]·t + seed[i] )  mod 2π
```

where `W` is the world anchor passed by the caller. That phase array is uploaded
verbatim to the ocean shader as `uWaveB[i].y`, so the shader never sees absolute
time or absolute world position. Both consumers then evaluate

```
φ_i(p) = k[i]·(d[i]·p) + phase[i]
height  = Σ A_i sin φ_i
disp.xz = Σ Q_i A_i d_i cos φ_i          (horizontal Gerstner displacement)
```

for a parameter position `p`. **`p` is measured from the world anchor `W`.**
This is the contract that matters, and it was not being honoured — see §2.

### 1.2 The rendered ocean

`src/scene/Ocean.ts` builds a radial disc of 288 rings × 288 sectors, radii
growing exponentially from ~0.24 m to 20 km. Each frame the disc is *positioned
at the raft*: `mesh.position.set(localX, 0, localZ)`. The vertex shader uses
`vec2 p = position.xz`, i.e. mesh-local coordinates, which are therefore
**raft-relative**.

Per-component LOD fade removes a wave from the geometry once the mesh can no
longer carry it at ≈4.5 samples per wavelength; the dropped slope is restored
per pixel by `residualWaveSlope()` in the fragment shader. With
`OCEAN_QUALITY_DESKTOP` the shortest component (λ = 3 m) starts fading at
r = 17.4 m and is gone by r = 33.5 m — far outside the raft, so the surface
under the raft carries every component at full amplitude.

### 1.3 The raft

`src/scene/Raft.ts` builds ~3.2 m × 2.2 m of lashed logs, cross beams, mast,
furled sail and one seated figure, all as children of one `THREE.Group`.

The pre-existing motion model:

1. Five sample points (centre plus four at ±0.95, ±1.4) are rotated into the
   raft's heading and passed to `waves.sample()`.
2. A least-squares plane is fitted to the five heights.
3. `heave`, `pitch` and `roll` each chase that plane through an implicit
   critically damped spring: `stepSpring(heave, meanH − 0.045, 6.0, dt)`,
   `stepSpring(pitch, −atan(slopeZ), 4.5, dt)`, `stepSpring(roll, atan(slopeX), 4.5, dt)`.

There is no mass, no buoyancy, no submersion, no waterline and no torque. The
raft is a kinematic target-follower with a hard-coded −0.045 m offset.

### 1.4 Frame ordering

`src/main.ts` runs, per frame: `time.update` → `wind.update` → recentre test →
`waves.update(dt, wind.worldX, wind.worldZ)` → `raft.update(dt, …, localX, localZ, …)`
→ `rig.update` → `ocean.update(localX, localZ, …)` → render.

`dt` is the wall clock delta clamped to 1/20 s. There is no fixed timestep and
no substepping.

---

## 2. Root-cause hypotheses

Ranked by the vertical raft/water error each can produce.

### H1 — Coordinate-space mismatch between CPU sampling and the shader (≤ 1.5 m)

The wave field is anchored at the raft's **absolute** world position
`(wind.worldX, wind.worldZ)`, so `p` must be measured from the raft. The ocean
disc honours this: it is centred on the raft, and its `p` is raft-relative. The
raft does not: `Raft.update` passes

```
wx = localX + (rotated sample offset)
```

where `localX = wind.worldX − originX` is the raft's position in the *local
render frame*, which is not zero and grows with drift.

The raft therefore samples the surface at a world position displaced by
`(localX, localZ)` from the point it is drawn at. At t = 0 the two agree exactly,
which is why the defect is invisible on load. `WindSystem` drifts at 0.09 m/s
(sail down) to 0.55 m/s (sail up) and the world is only re-centred at 800 m, so
the error grows without bound (modulo each wavelength) for up to 24 minutes of
play.

*Predicted signature*: perfect correlation against the CPU sample (the raft
tracks its own sample flawlessly) combined with visible hovering and submersion
against the rendered water; error uncorrelated with camera or wave preset;
zero at load; worsening with time; worse with the sail up.

**Status: confirmed before any code change.** Measured in the running
application: at 721.75 m of drift along the wind heading the CPU sample sits
+0.742 m above the rendered water; at 186.25 m it sits −0.566 m below it. A
production screenshot at the second condition (`evidence/before/`) shows the
raft submerged to the yard, with the deck, the logs and the seated figure
entirely underwater and the water surface above the lowest point of the folded
sail — precisely the reported bug.

### H2 — There is no waterline, and no buoyancy (≤ 0.12 m, plus "hovercraft" reading)

`stepSpring(this.heave, meanH − 0.045, …)` places the raft *origin* 45 mm below
the mean water height. The origin is not an authored waterline: the log keels
sit at y ≈ 0.006 and the log crowns at y ≈ 0.247, so a −0.045 m offset immerses
the flotation geometry by ~51 mm out of a 241 mm log diameter — about 20%. The
logs ride visibly proud of the water. Nothing in the model represents mass,
displacement or submersion, so pitch and roll cannot arise from torque and
nothing resists the raft leaving the surface.

### H3 — The 0.33 s lag is a filter constant, not inertia (≤ 0.15 m)

For the implicit critically damped spring the continuous transfer function is
`H(s) = ω₀²/(s + ω₀)²`, giving phase lag `2·atan(ω/ω₀)` and gain `ω₀²/(ω₀² + ω²)`.
At the dominant component (λ = 62 m, ω = 0.997 rad/s) with ω₀ = 6.0:

```
lag = 2·atan(0.997/6.0) / 0.997 = 0.330 s      ← the reported "0.33 s"
gain = 36/(36 + 0.994)          = 0.973
```

Amplitude-weighted across all six components the gain is **0.936** — the
reported "91% of wave range". Both previously reported numbers are arithmetic
consequences of `ω₀ = 6.0`. They are not evidence of mass. The same filter costs
20.6% of a period on the 3 m component, which is what detaches the raft from
chop.

### H4 — Sub-converged Gerstner inverse — **hypothesis rejected** (≤ 0.001 m)

`sample()` inverts the horizontal displacement with three fixed-point
iterations. The analytic contraction bound is
`Σ Q_i A_i k_i = Σ steepness_i / n = 0.453`, which with a maximum initial error
of `Σ Q_i A_i = 2.19 m` and a maximum slope of `Σ A_i k_i = 0.209` would allow
~36 mm of height error. That bound is far too pessimistic: measured over 375 552
(position, time) samples of the production field the *effective* contraction is
0.20–0.26, because the six directions are spread over ±76° and the sin/cos
factors never align. Actual residual after three iterations: **0.10 mm RMS,
1.1 mm maximum**. The source comment is accurate and this is not a contributor.

The solver is nevertheless upgraded to Newton iteration for §6's steep presets,
where the contraction bound rises toward 0.88 and three fixed-point iterations
would no longer suffice — and so that the residual becomes a *measured* quantity
in the harness rather than an assumed one.

### H5 — Variable timestep (≤ 0.02 m, frame-rate dependent)

The implicit spring is unconditionally stable but its effective damping depends
on `dt`, so flotation behaviour changes with display frame rate. There is no
substepping.

### H6 — Double smoothing into the camera (cosmetic, but masks the defect)

`CameraRig` low-passes `raft.waterHeight` with a 0.9 s time constant and carries
15% of it. The camera therefore rises and falls on the *same wrong signal* the
raft uses, which partially hides the disagreement from the production camera.

### H7 — Recentre discontinuity (≤ 1.5 m, instantaneous) — a corollary of H1

At a recentre the raft's sample point teleports 800 m, so its target height steps
by up to 1.51 m and the springs lurch for about a second. The recentre code
itself is algebraically correct; the discontinuity exists only because the raft
samples in the wrong frame. Fixing H1 makes the recentre genuinely invisible.

### H8 — Contact darkening detached from the raft (0 m vertical, but visible)

`Ocean.ts` sets `uRaftPos = (0, 0)` and compares it against `vLocal`, which is
the *displaced* surface position. The darkening disc under the raft therefore
wanders by up to the local Gerstner displacement (~1.9 m) relative to the raft it
is supposed to sit beneath. This is raft/water contact and is in scope.

### Ruled out by inspection (documented so they are not re-investigated)

- **Model scaling / parent transforms**: the raft group has unit scale and is a
  direct child of the scene; the ocean mesh likewise.
- **Different wave phases or units**: shader and CPU read the same `phase[]`
  array, written once per frame in double precision. Degrees appear only in the
  authored `angleDeg`, converted once in the constructor.
- **CPU/GPU different simulation times**: both consume the same `phase[]`; there
  is no separate time uniform in the wave path.
- **Double application of raft translation or wave displacement**: the raft's
  position is set once, from one source.
- **LOD divergence under the raft**: the shortest component fades no closer than
  r = 17.4 m, so the surface beneath the raft is complete.
- **float32 phase upload**: 2π/2²³ ≈ 7.5e-7 rad of phase error, i.e. sub-micron
  height error.
- **Ocean recentring**: the recentre itself is algebraically sound (phase anchor
  and local coordinates shift together). It is the *sampling* that is wrong, at
  every offset, not only near the boundary.
- **Mesh tessellation under the raft**: radial spacing at r = 1.6 m is 0.276 m
  (0.498 m on mobile) and angular spacing 0.035 m, giving a linear-interpolation
  height error of 1.4 mm desktop / 4.4 mm mobile, 2.9 / 9 mm worst case under
  Gerstner compression. Three orders of magnitude below H1; the mesh is amply
  resolved for a CPU/GPU comparison to be meaningful.

### Found, real, and deliberately out of scope

These are genuine defects in the water shading path that this round does not
touch, because they produce no vertical raft/water error and fixing them would
alter production water appearance for reasons unrelated to raft coupling. They
are recorded here so they are not lost:

- `residualWaveSlope()` is evaluated at `vLocal` (the *displaced* position) while
  the vertex stage evaluates phase at the undisplaced `p`, misregistering the
  LOD-seam ripple by up to 3.9 rad on the 3 m component.
- `residualWaveSlope()` adds a plain height-field slope with no Gerstner
  `1/(1 − ΣQAk·s)` normalisation, up to ~45% relative error on that term.
- `uDetailOrigin` wraps world coordinates mod 256 m, but the noise lattice is
  periodic mod 256 in *q*-space where `q = world·(1/2.4)`; the detail normals
  therefore pop every 256 m of drift, and the foam mask (plain `vnoise`) has no
  period at all and jumps outright.
- The `?debug=1` wind-heading slider rotates drift and raft yaw but not the wave
  directions, which `WaveField` bakes at construction.

---

## 3. The intended raft waterline

All coordinates are raft-local metres, y up, +z toward the bow, +x to starboard
*(pre-W1 mirrored label; since the 2026-08-05 side relabel — see `hullForm.ts`
— +x is the port side, and the lab camera names below swapped accordingly)*.
Every number below is derived from the actual constructed geometry (the raft is
built from a deterministic LCG seeded 20260727, so it is identical on every
load) — none of them is a tuned constant.

### 3.1 Flotation geometry

| Feature | Value |
|---|---|
| Deck logs | 9 cylinders, radii 0.1107–0.1339 m, lengths 3.03–3.33 m, axes y = 0.117–0.135 |
| Length-weighted log axis | **y = 0.1267** |
| Mean log keel (bottom) | y = 0.0060 |
| Mean log crown (deck surface) | y = 0.2474 |
| Cross beams | 2 × r ≈ 0.0725, length 2.36, axis y = 0.0150 at z = ±1.06 (below the logs) |
| Total log volume | 1.3244 m³ |
| Total timber volume | 1.4435 m³ |

### 3.2 Mass budget

Rather than tune a mass to hit a chosen waterline, the mass is built from
material densities and the waterline is *solved* from Archimedes. Seasoned
softwood driftwood is taken at **475 kg/m³**, seawater at **1025 kg/m³**.

| Item | Mass |
|---|---|
| Timber (logs, beams, mast, step, yard) | 685.7 kg |
| Cordage — stays, lashings, loops, spare bundle | 22 kg |
| Sail cloth | 7 kg |
| Figure | 72 kg |
| **Total** | **786.7 kg** |

### 3.3 Solved equilibrium waterline

Solving `ρ_w · V_displaced(w) = m` over the real log and beam cross-sections:

| Quantity | Value |
|---|---|
| **Designed equilibrium waterline** | **y = 0.1306 m** |
| Draft below the mean log keel | 0.1246 m |
| Draft as a fraction of log diameter | **51.6%** |
| Freeboard to the mean log crown | **0.1168 m** |
| Waterplane area A_wp | 6.953 m² |
| Displaced volume | 0.7675 m³ |

The solved waterline lands 3.9 mm above the length-weighted log axis. That is
the intended reading and it is a *consequence*, not a target: a raft of
half-density timber floats with its logs half immersed. The model origin is
**not** the waterline — it sits 131 mm below it, near the log keels — so the
previous `−0.045` offset was neither the waterline nor a meaningful datum.

### 3.4 Critical dry points

Points that must not touch water in ordinary production waves. Clearance is
measured above the designed waterline.

| Name | Raft-local position | Clearance |
|---|---|---|
| `DECK_CROWN_CENTRE` | (0.00, 0.00, 0.2474) | 0.117 m |
| `DECK_CROWN_BOW` | (0.00, 1.20, 0.2474) | 0.117 m |
| `DECK_CROWN_STERN` | (0.00, −1.20, 0.2474) | 0.117 m |
| `MAST_STEP_TOP` | (0.04, −0.34, 0.3000) | 0.169 m |
| `FIGURE_TORSO` | (−0.18, 1.02, 0.2850) | 0.154 m |
| `FOLDED_SAIL_LOW` | (0.06, −0.30, 0.5980) | **0.467 m** |
| `YARD_LOW` | (0.06, −0.30, 0.7200) | 0.589 m |

`FOLDED_SAIL_LOW` is the "folded-sail lever" of the bug report: with the sail
furled the yard sits at y = 0.75 and the rolled cloth hangs to
0.75 − 0.03 − (0.042 + 0.080) = 0.598. Raising the sail lifts the whole assembly
by 1.66 m, so the furled state is the worst case and is the one that must be
protected.

### 3.5 Low outer edges (overtopping is permitted here only)

The outermost logs' crown lines, `x = −0.985, y = 0.239` and `x = +0.971,
y = 0.252`, and the log ends at |z| > 1.4. At the extreme beam (|x| = 1.10) the
round log flank falls to the log axis height, i.e. to the waterline itself — the
sides of this raft meet the water continuously and are *meant* to be wet. Water
crossing an outermost log crown is a genuine overtopping event and is allowed if
it is detected and acknowledged (§10).

### 3.6 Centre of mass

Taken as the mass-weighted centroid of the same budget: **(0.003, −0.021, 0.145)**
— essentially amidships, 14.5 mm above the designed waterline. The metacentric
height is very large (BM = I_wp,T / V = 2.780 / 0.7675 = 3.62 m), so the raft is
stiff in roll; this is correct for a wide, shallow log raft.

---

## 4. The corrected physical model

### 4.1 Parameter-space parity (fixes H1 and H4)

The wave field is re-anchored to the **local render origin** rather than to the
raft:

- `WaveField.setTime(t, originX, originZ)` bakes `k·(d·origin)` into the phase,
  where `origin` is the world position of the local render frame — the value
  that only changes at a recentre.
- The ocean shader receives a new `uWaveOrigin` uniform: the disc's centre
  expressed in local render coordinates. The vertex shader evaluates
  `evaluateWaves(p + uWaveOrigin, …)` and the fragment shader's residual slope
  uses the same offset.
- `WaveField.sample(x, z)` therefore takes **local render coordinates** —
  exactly what `Raft.update` was already passing.

Algebraically the rendered surface is unchanged: before, the absolute parameter
position was `worldRaft + p`; after, it is `origin + (p + waveOrigin)` where
`waveOrigin = worldRaft − origin`, i.e. the same point. The ocean therefore
renders identically, and CPU and GPU are now provably evaluating one surface in
one space. This is the "shared parametric coordinate system" option of the
Gerstner requirement, and it is the one adopted.

Gerstner horizontal displacement is handled by **inverting** it: `sample(x, z)`
solves `s + D(s) = (x, z)` for the seed `s`, so the CPU evaluates the surface at
the horizontal position the eye actually sees. The three fixed-point iterations
are replaced by **Newton iterations** using the analytic 2×2 Jacobian
`J = I + ∂D/∂s` (the same `jxx/jzz/jxz` terms the shader already computes).
Convergence is quadratic; the residual is exposed to the harness as a measured
quantity, not asserted.

### 4.2 Distributed buoyancy (fixes H2, H3, H5)

The target-following spring is removed entirely. It cannot be salvaged: it has
no notion of submersion, so it cannot know whether the raft is in the water.

The raft becomes a rigid body with three simulated degrees of freedom — heave,
pitch and roll. Surge, sway and yaw remain driven by `WindSystem` exactly as
before (the prototype has no steering, and changing that is out of scope).

Flotation is represented by a grid of **12 contact stations**, 3 across the beam
× 4 along the length, covering the real log footprint. Each station owns a
slice of the actual flotation geometry: the three logs in its column, clipped to
its longitudinal cell, plus its share of a cross beam where one falls in the
cell. Per station, per substep:

1. Evaluate the water surface at the station's **world** position and the
   current **physics** time — the same surface, space and instant the shader
   renders, via §4.1.
2. Take height, normal and Gerstner orbital velocity
   `v_water = (Σ Q_i A_i ω_i d_i sin φ_i, −Σ A_i ω_i cos φ_i)`.
3. Compute the immersed cross-sectional area of that station's cylinders under
   the local water plane (exact circular-segment integral), times the cell
   length → immersed volume `V_i`.
4. Hydrostatic buoyancy `F_i = ρ_w · g · V_i` upward.
5. Damping `−c_i · (v_point − v_water)·ŷ`, i.e. relative to the *local water*,
   not to the world. At low frequency the relative velocity vanishes, so damping
   contributes no lag on swell — the lag budget is spent only where the raft is
   genuinely not following.
6. Apply the force at the station, so pitch and roll emerge from torque.
7. Add gravity at the centre of mass; integrate semi-implicitly.

Damping is expressed physically, from the restoring stiffness: total
`c = 2ζ·sqrt(K·m_virtual)` distributed across stations in proportion to their
waterplane area, with **ζ = 0.65** and a heave added-mass coefficient
`C_a = 0.7 × displaced mass`. Both are documented engineering estimates for a
shallow-draft raft, not fitted values. The resulting natural frequencies are

```
ω_n heave = 7.23 rad/s (T = 0.87 s)
ω_n pitch = 7.26 rad/s (T = 0.87 s)
ω_n roll  = 7.20 rad/s (T = 0.87 s)
```

which are far above every production wave frequency (0.997 – 4.533 rad/s), so
the raft rides swell with near-unity gain and small lag, and filters chop
because the chop is both above resonance *and* averaged away across a footprint
longer than the chop wavelength. No arbitrary delay is used anywhere.

Predicted heave lag, same model, no per-preset tuning:

| λ (m) | T (s) | lag (s) | lag (% of T) |
|---|---|---|---|
| 62.0 | 6.30 | ~0.16 | ~2.6 |
| 34.0 | 4.67 | ~0.16 | ~3.5 |
| 19.5 | 3.53 | ~0.17 | ~4.7 |
| 10.4 | 2.58 | ~0.17 | ~6.6 |

### 4.3 Fixed timestep

Physics runs at a **fixed 240 Hz substep** driven by an accumulator, capped at
12 substeps per frame (matching the existing 1/20 s dt clamp). The wave field is
advanced *per substep*, so buoyancy is evaluated on the surface that actually
exists at that instant.

The ocean is rendered at the **physics clock**, not the wall clock. The
accumulator remainder (< 4.2 ms) is therefore never a CPU/GPU time
disagreement — it is a uniform, sub-frame time offset of the whole scene. This
makes temporal parity exact by construction rather than by tolerance.

---

## 5. Diagnostic harness

Enabled only by `?debug=buoyancy`. The module lives under `src/debug/` and is
**dynamically imported**, so it is code-split out of the production bundle and
cannot appear without the query parameter. `?debug=1` continues to open the
existing tuning panel and nothing else.

Required capabilities:

| Capability | Mechanism |
|---|---|
| Deterministic seeded waves | Per-preset integer seed drives the component seed phases |
| Fixed simulation timestep | 240 Hz substeps; harness may override to 30/60/120/240 Hz |
| Pause | Transport control and `Space` |
| Single-frame step | `.` steps one render frame at the nominal rate |
| Step N simulated seconds | `[` / `]` for ±1 s; `__lab.advance(seconds)` for any value |
| Scrub / jump to exact time | `__lab.seek(t)` resets to 0 and re-simulates deterministically |
| Reset to time zero | `R` / `__lab.reset()` |
| Wave-preset selection | Dropdown and `__lab.setPreset(name)` |
| Camera-preset selection | Dropdown and `__lab.setCamera(name)` |
| Toggleable overlays | Per-layer checkboxes and `__lab.setOverlay(name, on)` |
| Slow motion | Rate multiplier 0.05× – 1× |
| Transparent / wireframe water | Water render-mode selector |
| Contact readout | Live numeric panel, all §8 quantities |
| Non-zero world offsets | `__lab.setWorldOffset(x, z)` |
| Recentre boundary | `__lab.approachRecenter()` places the raft just inside the 800 m threshold; `__lab.forceRecenter()` crosses it |

Rendering is driven **synchronously** by the harness, not by `requestAnimationFrame`,
so capture is unaffected by background-tab throttling and every captured frame
is at an exact, reproducible simulation time.

### 5.1 Development-only visible markers

- Designed waterline: a closed loop at raft-local y = 0.1306 around the hull
  footprint.
- Centre of mass: a marker at the solved COM.
- Every buoyancy station: a marker whose colour encodes immersion fraction.
- Every critical dry point: a marker that switches colour when its clearance
  goes negative.
- The water-surface point beneath each station, its surface normal, the
  buoyancy force, the damping force, the station velocity and the local water
  velocity: drawn as scaled vectors with a legend.

---

## 6. Wave test matrix

One set of physical raft parameters must serve all of these. No per-preset
offsets or constants are permitted.

| # | Preset | Definition | Purpose |
|---|---|---|---|
| 1 | `FLAT` | no components | equilibrium waterline, drift, pitch/roll zero |
| 2 | `FROZEN_SINGLE` | λ 40 m, A 0.50 m, 0°, frozen time | spatial CPU/GPU parity |
| 3 | `LONG_GENTLE_SWELL` | λ 95/78 m, A 0.55/0.30 m | broad heave and slope following |
| 4 | `CURRENT_MODERATE` | the shipping production field | regression |
| 5 | `SHORT_WIND_CHOP` | λ 6.0–1.5 m, A 0.075–0.014 m | filtering without losing contact |
| 6 | `CROSSING_SEAS` | two systems ±46°, plus short cross chop | combined pitch and roll |
| 7 | `LARGE_LONG_SWELL` | λ 140/92/46/18 m, A 1.35/0.80/0.34/0.13 m | large non-breaking sea |
| 8 | `STEEP_STRESS` | λ 26–4 m, A 1.10–0.11 m, Σ steepness 4.40/5 | debug-only steepness limit |

Each dynamic preset also runs at: world origin; +6000 m offset; −6000 m offset;
just inside the 800 m recentre threshold; immediately after a recentre.

---

## 7. Camera test matrix

Debug-only, world-stabilised. None of these inherit raft heave, pitch or roll.

| Key | Preset | Description |
|---|---|---|
| A | `PRODUCTION` | the shipping `CameraRig`, untouched |
| B | `PORT_WATERLINE` | broadside from +x, eye 0.55 m above mean water, 9 m out — named `STARBOARD_WATERLINE` before the W1 relabel |
| C | `STARBOARD_WATERLINE` | mirror of B |
| D | `BOW_WATERLINE` | low from +z |
| E | `STERN_WATERLINE` | low from −z |
| F | `HIGH_THREE_QUARTER` | 12 m up, 16 m out, 35° |
| G | `DIAGNOSTIC_ORTHOGRAPHIC_SIDE` | orthographic, strictly side-on, for measurement |
| H | `FIXED_WORLD_CAMERA` | fixed in the world; does not follow the raft at all |

Every worst-case timestamp is captured from B, D, E and F at minimum.

---

## 8. Numerical measurements

Signed normal distance at each of the 12 contact stations:

```
d_i = dot(W_i − S_i, N_i)
```

`W_i` — the designed-waterline point (raft-local y = 0.1306) at station i,
transformed to world. `S_i` — the water-surface point at `W_i`'s horizontal
position at the same simulation time. `N_i` — the local water normal.
**Positive = gap/hover, negative = immersion.**

Recorded every physics frame:

- `d_i` for all 12 stations; mean, RMS, min, max, 95th percentile of `|d|`
- clearance of every critical dry point
- number of immersed stations (0–12)
- centre heave, pitch, roll
- linear and angular velocity, acceleration, jerk
- water vertical velocity and raft vertical velocity at the centre
- dominant wave period of the active preset
- same-frame correlation of raft-waterline height vs water height
- best-lag correlation and the lag, **as a secondary diagnostic only**
- lag as a percentage of the dominant period
- Gerstner inverse-solve residual (m)
- CPU-vs-shader height difference at a set of probe points

Exported as CSV and JSON per run. Plots rendered from the same data.

Run length: ≥ 60 simulated seconds per dynamic preset after a 10 s settling
interval. Timestep tests at 30, 60, 120 Hz render rates plus one deliberately
irregular render schedule.

---

## 9. Acceptance criteria

Thresholds are fixed here, before results are seen. The raft is 3.2 m long, so
the guidance metre values are used unmodified.

### 9.1 Visual

- A defined, visibly credible waterline cutting the round log flanks.
- No hovercraft gap; no silent pass-through of crests.
- Water never reaches `FOLDED_SAIL_LOW`, `MAST_STEP_TOP` or the central deck in
  presets 3–7.
- Pitch and roll visibly agree with the water slope under the raft.
- No jitter at any frame rate.
- Any overtopping starts at an outer edge and is acknowledged; foam is never
  used to hide geometry.

### 9.2 Numerical

| Preset | Requirement |
|---|---|
| FLAT | mean \|d\| ≤ 0.01 m, max ≤ 0.02 m; pitch and roll < 0.1°; \|dy/dt\| < 1 mm/s; no dry-point contact |
| FROZEN_SINGLE | CPU probes agree with the shader within rendering tolerance at origin, ±6000 m and across a recentre |
| LONG_GENTLE_SWELL | mean \|d\| ≤ 0.03 m; p95 ≤ 0.07 m; heave lag ≤ 8% of dominant period; no persistent hover |
| CURRENT_MODERATE, CROSSING_SEAS | no full-raft air gap > 0.15 s; no deck penetration; no dry-point immersion; no oscillatory hover/submerge; no jitter |
| SHORT_WIND_CHOP | contact maintained with the aggregate surface; no conspicuous bridging gap |
| LARGE_LONG_SWELL, STEEP_STRESS | stable; no levitation; no deep central clipping; no folded-sail immersion; edge overtopping only when a crest genuinely crosses the freeboard |
| All | behaviour materially unchanged at 30, 60 and 120 Hz and under irregular render timing |

Correlation is reported but is **never** a pass condition.

### 9.3 Production

- Production camera, waves, lighting and composition visually unchanged apart
  from the raft now sitting correctly in the water.
- The raft remains small and subordinate in frame.
- The camera does not inherit raft pitch or roll.
- No debug UI, markers or overlays without `?debug=buoyancy`.
- `tsc --noEmit` and `vite build` clean; no console or WebGL errors; desktop and
  mobile viewports; correct across pause/resume and tab throttling.
- Frame cost of the new physics measured and reported.

---

## 10. Overtopping

Flotation is fixed first; foam is never used to conceal intersection.

For presets 1–7 no water should cross the outer log crowns other than briefly at
an extreme corner. An overtopping event is *detected*, not assumed:

1. The local water height at an outer-edge station exceeds that station's log
   crown, **and**
2. the relative vertical water velocity at that station is positive (the water
   is rising into the raft, not the raft merely clipping a static mismatch).

When both hold, a short-lived, restrained foam/spray response is emitted **at
that edge station** and nowhere else. No water-on-deck simulation is added in
this round. If the visual cue would materially expand scope it stays disabled in
production waves and the detection remains as a documented hook.
