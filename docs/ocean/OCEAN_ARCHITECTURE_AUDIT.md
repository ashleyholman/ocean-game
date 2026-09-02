# Ocean architecture audit

State of the water at commit `1765bb7`, measured before any change in the
sea-state and whitewater round. Everything here is what **is**, not what should
be. Recommendations are confined to the last section, and only as a bridge into
`docs/ocean/OCEAN_SEA_STATE_SPEC.md`.

Measurements were taken in the running application at 1600×900, device pixel
ratio 2, desktop quality, through `?debug=buoyancy` and `window.__drift`.

---

## 1. Displacement field

### 1.1 Slots and capacity

| Quantity | Value | Source |
|---|---|---|
| Uniform slots reserved | **8** (`MAX_WAVES`) | `src/scene/Waves.ts:42` |
| Slots used by the production preset | **6** | `DEFAULT_WAVES`, `Waves.ts:72-79` |
| Slots used by the largest test preset | 5 | `STEEP_STRESS`, `Waves.ts:158-164` |
| Shader loop bound | `NUM_WAVES = MAX_WAVES = 8`, a `define` | `Ocean.ts:379` |
| Preset swap cost | no recompile — unused slots carry amplitude 0 and are skipped | `Ocean.ts:377-379`, `lib.ts:294` |

The slot count is fixed at compile time precisely so a preset change never
triggers a shader recompile. That property is worth keeping.

### 1.2 The wave equation, exactly

Per component *i*, with `d` a unit direction in the XZ plane, `p` a **parameter
position in local render coordinates**, and phase `φᵢ`:

```
φᵢ(p)   = kᵢ (dᵢ · p) + phaseᵢ
Dxz(p)  = Σ Qᵢ Aᵢ dᵢ cos φᵢ            horizontal displacement
Dy(p)   = Σ Aᵢ sin φᵢ                  height
n       = (−Σ dᵢ.x Aᵢkᵢ cos φᵢ,  1 − Σ Qᵢ Aᵢkᵢ sin φᵢ,  −Σ dᵢ.y Aᵢkᵢ cos φᵢ)
```

`Waves.ts:473-494` (CPU) and `lib.ts:288-316` (GPU) are line-for-line the same
arithmetic. Phase is advanced once per simulation step in double precision and
uploaded already wrapped:

```
phaseᵢ = ( kᵢ (dᵢ · origin) − ωᵢ t + seedᵢ )  mod 2π          Waves.ts:370-379
```

so the shader never sees absolute time or absolute position — only a bounded
parameter position and a wrapped phase. This is the mechanism that makes
CPU/GPU **temporal** parity exact rather than approximate, and it is the single
most important property of the existing design.

### 1.3 Parameter ranges in the shipping preset

`DEFAULT_WAVES`, `Waves.ts:72-79`:

| # | λ (m) | A (m) | angle (° from wind) | steepness | k (rad/m) | ω (rad/s) | T (s) | c (m/s) |
|---|---|---|---|---|---|---|---|---|
| 0 | 62.0 | 0.330 | −14 | 0.72 | 0.1013 | 0.9971 | 6.30 | 9.84 |
| 1 | 34.0 | 0.205 | +37 | 0.64 | 0.1848 | 1.3466 | 4.67 | 7.29 |
| 2 | 19.5 | 0.118 | −58 | 0.52 | 0.3222 | 1.7783 | 3.53 | 5.52 |
| 3 | 10.4 | 0.060 | +20 | 0.40 | 0.6042 | 2.4351 | 2.58 | 4.03 |
| 4 | 5.6 | 0.030 | −76 | 0.26 | 1.1220 | 3.3184 | 1.89 | 2.96 |
| 5 | 3.0 | 0.014 | +62 | 0.18 | 2.0944 | 4.5335 | 1.39 | 2.16 |

- **Wavelength range:** 3.0 – 62.0 m, ratio 20.7:1.
- **Amplitude range:** 0.014 – 0.330 m; `amplitudeSum = 0.757 m` (measured live).
- **Directional spread:** −76° … +62°, full width **138°**, taken about the wind
  heading. Adjacent components are deliberately non-monotonic in angle.
- **Dominant period:** 6.30 s (measured live via `waves.dominantPeriod`).
- **Dispersion:** deep water, `ω = √(g k)`, `Waves.ts:283`. There is no depth
  term anywhere, which is correct for an open-ocean prototype.
- **Significant wave height:** not represented. There is no `Hs`, no spectrum
  and no wind coupling. `amplitudeSum` (0.757 m) is the only global scale, and
  it is a sum of amplitudes, not a statistical measure. Treating the six
  components as an irregular sea gives `Hs = 4√(½ΣAᵢ²) ≈ 0.58 m` — a slight,
  glassy sea. That is one condition, and it is the only one the game ships.

### 1.4 Steepness handling

```
Qᵢ = steepnessᵢ / (kᵢ Aᵢ n)                                  Waves.ts:286
```

normalises so that `Σ Qᵢ Aᵢ kᵢ = Σ steepnessᵢ / n < 1`, which guarantees the
Gerstner Jacobian stays positive and the surface never folds. For the shipping
preset `Σ steepness / n = 0.453`; for `STEEP_STRESS` it is 0.88.

The normalisation has an important and deliberate consequence, documented at
`Waves.ts:147-154`: because `Q` is normalised against `A`, halving `A` doubles
`Q` and leaves `Q A k` — the quantity that actually governs crest sharpness and
folding — unchanged. Steepness and size are therefore genuinely independent
controls, which is exactly what a sea-state model needs.

### 1.5 Phase seeding

```
seedPhaseᵢ = (i · 2.3999632297 + preset.seed · 1.7) mod 2π    Waves.ts:291
```

Golden-angle offsets plus a per-preset constant. `CURRENT_MODERATE` has seed 0
by design so its phases are bit-identical to the historical shipping ocean.

### 1.6 The inverse solve

`solveSeed()`, `Waves.ts:397-450`. Two fixed-point contraction steps (guaranteed
to converge because `Σ Q A k < 1`), then Newton on `s + D(s) − x = 0` with the
analytic 2×2 Jacobian, 7 iterations maximum, early exit at residual `< 1e-8`.

Measured `maxSolveResidual` over 40 s runs: `≤ 1.00e-8 m` for every preset
including `STEEP_STRESS`. The solve is not a source of error.

`sample()` returns height, unit normal and orbital velocity at the **visible**
surface point, i.e. after inverting the horizontal displacement. `sampleHeight()`
is the cheap height-only path. `evaluateSeed()` is the undisplaced evaluation
the parity harness uses.

---

## 2. CPU/GPU data flow

```
WaveField.waveA : Float32Array(8×4) = (dirX, dirZ, amplitude, k)     → uWaveA
WaveField.waveB : Float32Array(8×4) = (Q, phase, lodFadeStart, lodFadeEnd) → uWaveB
                                                                    → uWaveAmp
Ocean.update()  writes uWaveOrigin = disc centre (0,0 in production) Ocean.ts:416
```

The arrays are handed to the material **by reference** (`Ocean.ts:354-355`), so
a CPU-side phase refresh is visible to the GPU with no upload call of its own.
`labParity.ts:86-90` deliberately shares the same uniform objects, which is what
makes the readback probe measure the real material rather than a copy.

Clock ordering per frame, `main.ts:218-308`:

1. `raft.update()` → `body.update()` → the fixed-substep loop advances
   `waves.advance(step)` **inside** it (`RaftBuoyancy.ts:658-663`).
2. `ocean.update()` then renders at whatever `waves.time` has become.

So the ocean is drawn on the physics clock, not the wall clock. Nothing else in
the application advances the wave field.

**Measured parity** (`ParityProbe`, 96×96 readback over a ±3 m span, RGBA8
packing of ±16 m):

| Preset | max CPU/GPU height error |
|---|---|
| FLAT | 3.78e-9 m |
| LONG_GENTLE_SWELL | 1.25e-4 m |
| CURRENT_MODERATE | 1.43e-3 m |
| CROSSING_SEAS | 5.36e-4 m |
| LARGE_LONG_SWELL | 7.06e-4 m |
| STEEP_STRESS | 3.14e-3 m |
| SHORT_WIND_CHOP | 6.60e-3 m |

This is the established scale of error and it is **not** an arithmetic
discrepancy — the two evaluations are identical. It is the mesh: the probe
compares an interpolated triangle against a point sample, so the error tracks
the surface curvature over one triangle. Short chop is worst because its
wavelength is closest to the vertex spacing. Any change that raises the
curvature-per-triangle will raise this number without any parity defect
existing.

---

## 3. Mesh topology and LOD

`buildRadialDisc()`, `Ocean.ts:51-98`. A radial disc centred on the raft:

```
r(t) = INNER_SCALE · (e^{K t} − 1),  K = ln(OUTER_RADIUS/INNER_SCALE + 1)
INNER_SCALE = 8.68 m,  OUTER_RADIUS = 20 000 m
```

| Quality | rings | sectors | vertices | triangles | `lodSpacing` |
|---|---|---|---|---|---|
| Desktop | 288 | 288 | 83 232 | 165 888 | 0.026885 |
| Mobile | 160 | 160 | 25 760 | 51 200 | 0.048393 |

`lodSpacing = max(K/rings, 2π/sectors)` — metres of vertex spacing per metre of
radius (`Ocean.ts:349`). Measured live: 0.026885 desktop, 0.048393 mobile.

Per-ring angular jitter (`Ocean.ts:62-63`) breaks the spoke pattern that a
regular radial grid shows in specular highlights.

The disc is never rotated and never snapped. It is translated to the raft each
frame (`Ocean.ts:410`) and its own centre is added into the parameter position
through `uWaveOrigin` (`Ocean.ts:416`) — one line, and the only thing keeping
the rendered surface in the same space as `WaveField.sample()`.

**Wave LOD fade** (`setLodSpacing`, `Waves.ts:320-335`):

```
rFade  = λ / (4.5 · lodSpacing)
fadeStart = 0.70 · rFade      fadeEnd = 1.35 · rFade
```

i.e. a component is faded out once the mesh can no longer carry ~4.5 points per
wavelength. Desktop radii for the shipping preset:

| λ (m) | fadeStart (m) | fadeEnd (m) |
|---|---|---|
| 62.0 | 359 | 693 |
| 34.0 | 197 | 380 |
| 19.5 | 113 | 218 |
| 10.4 | 60 | 116 |
| 5.6 | 32 | 63 |
| 3.0 | 17 | 34 |

Past 693 m the disc carries no displacement at all; everything beyond that
radius is normal-only.

---

## 4. Shading chain

Three levels, each handing off as it becomes sub-pixel:
**displaced geometry → residual wave slope → procedural detail normals →
statistical roughness.**

### 4.1 Residual wave slope

`residualWaveSlope()`, `lib.ts:330-352`. For each component, `missing =
smoothstep(fadeStart, fadeEnd, lodRadius)` is the fraction the geometry dropped;
`visible = 1 − smoothstep(0.22λ, 0.75λ, footprint)` is the fraction a pixel can
still resolve. The slope of the still-resolvable part is added per pixel; the
rest is accumulated into `lostVariance` and folded into roughness.

Loop bound is `NUM_WAVES` — all 8 slots, per pixel.

### 4.2 Detail normals

`Ocean.ts:206-227`. `DETAIL_OCTAVES` = 3 desktop / 2 mobile.

| Octave | base frequency (cyc/m) | wavelength (m) | amplitude |
|---|---|---|---|
| 0 | 1/2.4 = 0.4167 | 2.40 | `uDetailAmp` = 0.105 |
| 1 | 0.9042 | 1.106 | 0.0578 |
| 2 | 1.9621 | 0.510 | 0.0318 |

Frequency ratio 2.17 (deliberately not 2.0). Each octave scrolls along the wind
direction at `0.30 + 0.18·o` m/s of noise-space, and each octave's direction is
rotated off the last by `normalize(dir + perp·0.62)` ≈ 31.8° so the ripple
cross-hatches instead of combing into stripes.

Noise is `noisedPeriodic()` (`Ocean.ts:167-196`) — gradient noise whose lattice
hash is taken `mod NOISE_PERIOD`, so it is genuinely periodic with period
**256 lattice cells**.

### 4.3 Roughness

```
sigma2 = (0.003 + 0.00512 · windStrength) · 0.34               Ocean.ts:256
alpha  = clamp(√(2 σ²) + √(2 · variance), 0.040, 0.85)         Ocean.ts:257
```

Cox–Munk slope statistics for the base, widened by the variance of everything
the geometry and the detail octaves had to drop. `windStrength` defaults to 6.0
m/s and is the *only* place wind speed enters the water today.

### 4.4 Foam — the current whitecap formula, in full

`Ocean.ts:296-310`:

```glsl
float steep = smoothstep(0.10, 0.30, length(slope));
float crest = smoothstep(0.68, 0.98, vHeight * uCrestScale) * steep;
if (crest > 0.001) {
  float mask = vnoise(world2 * 2.2 + uWindDir * uNoiseTime * 0.22);
  mask *= vnoise(world2 * vec2(5.5, 1.6) - uWindDir * uNoiseTime * 0.11) * 1.4;
  mask = smoothstep(0.30, 0.62, mask);
  float foamFade = 1.0 - smoothstep(120.0, 260.0, vLodRadius);
  float foam = crest * mask * 0.38 * foamFade;
  color = mix(color, vec3(0.74,0.76,0.78) * foamLight, clamp(foam,0,1));
}
```

Inputs are therefore exactly: **normalised instantaneous height**
(`uCrestScale = 1/(amplitudeSum · uWaveAmp)`), **slope magnitude**, two
**non-periodic** `vnoise` lookups, and **radial distance**. Peak opacity is
0.38 and it cuts off entirely at 260 m.

Consequences:

- Foam is a function of instantaneous height, so it appears and vanishes with
  the crest. It has **no persistence, no advection, no age and no decay** — it
  is a mask multiplied onto crests, which is the "painted on" failure by
  construction.
- The height threshold is normalised against `amplitudeSum`, so it is not a
  fixed world height — but it *is* purely a rank statistic of the current
  preset. A 6 m glassy swell and a 0.6 m chop produce identical foam coverage.
  Wind speed does not enter at all.
- `vnoise` (`lib.ts:33-42`) uses `hash21` with **no periodic wrap**, unlike
  `noisedPeriodic`. See §6.

In the shipping preset the threshold `smoothstep(0.68, 0.98, ...)` is reached
only near the very top of the amplitude sum, so measured foam coverage in
`CURRENT_MODERATE` is effectively nil — visible in the baseline captures under
`evidence/baseline/`.

### 4.5 Raft-specific spray

`OvertopSpray.ts`: 18 sprites, 0.85 s lifetime, 0.14 s cooldown, ≤2 emission
sites and ≤8 puffs per frame, fed from `RaftBuoyancy.overtopEvents`. It is a
physical cue for water coming aboard, entirely separate from ocean foam, and it
stays that way.

---

## 5. Presentation origin

`WaveField.setOrigin(x, z)` (`Waves.ts:345-349`) is a **phase offset**, not a
position. `PlanetaryWorld` is the sole authority for where the raft is
(ADR-002). Confirmed by inspection:

- `main.ts:118-120` initialises `presentationOriginX/Z = 0` and never changes
  them on the production path.
- `main.ts:263-272` passes them to `ocean.update()`; `main.ts:235-249` passes
  local `(0, 0)` to `raft.update()`.
- `main.ts:456-460` — `setPresentationOrigin()` exists only on `SimHandle`, and
  its only callers are the diagnostic harness (`BuoyancyLab.reset()` →
  `sim.resetSimulation(preset, originX, originZ)`).
- There is **no renderer-recentering path**: no threshold test, no 800 m
  recenter, no `worldX`/`worldZ` accumulator. `grep` for `recenter` across
  `src/` returns nothing but historical prose in the coupling documents.

**Confirmed: production keeps the raft at local (0, 0) and the presentation
origin at (0, 0).**

---

## 6. Wrap boundaries — every one of them

| Coordinate | Wrap | Where | Periodic in the space it is used? |
|---|---|---|---|
| `uDetailOrigin` | `mod 256.0` m | `Ocean.ts:423-428` | — |
| `noisedPeriodic` lattice hash | `mod NOISE_PERIOD = 256` **cells** | `Ocean.ts:173-176` | see below |
| `uNoiseTime` | `mod 1800` s | `Ocean.ts:430` | yes, and the scroll is linear so it is continuous |
| foam `vnoise` | **none** | `lib.ts:33-42` via `Ocean.ts:303-304` | **no** |
| wave phase | `mod 2π` | `Waves.ts:374-376` | yes, exactly |

The detail-normal defect is a **units mismatch**. The origin is wrapped in
metres (`mod 256.0`), but the noise lattice is periodic in *cells*, and octave
*o* is sampled at `world2 * freq` with `freq` = 0.4167, 0.9042, 1.9621 cyc/m.
Octave 0 therefore has a spatial period of `256 / 0.4167 = 614.4 m`, octave 1
`283.1 m`, octave 2 `130.5 m`. None of these is 256 m. Shifting the origin by
exactly 256 m — which the code treats as a no-op — moves every octave to an
unrelated part of the noise field. That is the popping described in the coupling
report.

The foam defect is simpler: `vnoise` has no wrap at all, so foam jumps whenever
the wrapped origin crosses the 256 m boundary.

---

## 7. Known defects carried in from the coupling report

Each confirmed against the source.

**D1 — residual slope evaluated in displaced coordinates.**
The vertex shader evaluates wave phase at the **undisplaced** `p + uWaveOrigin`
(`Ocean.ts:112-118`) but passes `vLocal = local.xz`, the **displaced** position
(`Ocean.ts:120, 125`). The fragment shader then evaluates
`residualWaveSlope(vLocal + uWaveOrigin, ...)` (`Ocean.ts:232`). The residual
ripple is therefore registered against a surface that has been displaced by up
to `Σ Q A ≈ 0.34 m` in the shipping preset, and by a raft length in
`STEEP_STRESS`. Confirmed.

**D2 — residual slope lacks the Gerstner normalisation.**
`Ocean.ts:239` adds `grad + swell` directly to the base slope
`(−n.x/n.y, −n.z/n.y)`. That addition is exact only for a height field. Where
horizontal displacement has compressed the surface — precisely at crests — the
true surface slope requires the inverse of the horizontal Jacobian
`∂(x,z)/∂(px,pz)`. The Jacobian determinant is already computed in
`evaluateWaves()` (`lib.ts:315`) and then **discarded**: `WaveResult.jacobian`
has no reader anywhere in the codebase. Confirmed.

**D3 — detail-origin wrapping inconsistent with q-space periodicity.** §6 above.

**D4 — foam noise not periodic.** §6 above.

**D5 — wave headings baked at construction.**
`applyPreset()` bakes `angle = windHeadingRad + spec.angleDeg` into `dirX/dirZ`
(`Waves.ts:275-279`). `windHeadingRad` is a constructor argument
(`main.ts:98`, the initial true course) and is never updated afterwards — there
is no setter. Meanwhile `wind.direction` *is* updated every frame from the
transported ECEF frame (`main.ts:134`) and drives the detail-normal scroll, the
foam mask scroll and the roughness. So today the fine detail follows the course
and the swell does not, by accident rather than by contract. Confirmed.

---

## 8. Performance

Measured at 1600×900, DPR 2 (effective 3200×1800 = 5.76 Mpx), desktop quality,
Chrome, Apple Silicon.

| Quantity | Desktop | Mobile quality |
|---|---|---|
| Ocean triangles | 165 888 | 51 200 |
| Draw calls (whole scene) | 6 | 6 |
| Vertex wave work | 83 232 × 8 slots (6 active) | 25 760 × 8 |
| Fragment residual work | 8 slots **per pixel** | 8 |
| Detail octaves | 3 | 2 |
| Cloud octaves in reflection | 3 | 2 (and reflection clouds off) |
| Adaptive DPR cap | 2, reduced by 0.25 if the 2.5 s average frame exceeds 26 ms | 1.75 |

CPU cost of the wave field, measured directly (Node, same arithmetic, 24
stations × 240 Hz = 5760 `sample()` calls per simulated second):

| components | ms of CPU per simulated second | % of one core |
|---|---|---|
| 8 | 8.59 | 0.86 % |
| 16 | 14.57 | 1.46 % |
| 24 | 20.82 | 2.08 % |
| 32 | 26.60 | 2.66 % |
| 48 | 36.21 | 3.62 % |
| 64 | 46.32 | 4.63 % |
| 96 | 68.93 | 6.89 % |

The CPU is **not** the constraint. Cost is sub-linear in the component count
because the Newton solve exits early on residual, so most samples run 3–4
iterations rather than 7.

The fragment-stage residual **is** a constraint. It is `NUM_WAVES` iterations
per pixel; at 5.76 Mpx and 8 slots that is 46 M iterations per frame. Scaling
the slot count to 48 without restructuring would be 276 M — not affordable.

Baseline bundle: `index` 751.58 kB (gzip 218.68), `BuoyancyLab` chunk 34.70 kB
(gzip 12.14), CSS 2.50 kB.

---

## 9. Baseline verification state

| Check | Result |
|---|---|
| `vitest run` | 5 files, **65 tests, all passing** |
| `tsc --noEmit` | clean |
| `vite build` | clean (one pre-existing >500 kB chunk warning) |
| Test coverage of the water | **none** — no test imports `Waves.ts`, `Ocean.ts`, `RaftBuoyancy.ts` or anything in `src/debug/` |
| Vitest scope | there was no `test` config; vitest inferred its include glob and would have walked into nested agent worktrees. Now pinned to `tests/**/*.test.ts` with `.claude/worktrees` and `.codex/worktrees` excluded (`vite.config.ts`) |

Baseline buoyancy regression (40 s, 8 s settle, 60 Hz render / 240 Hz physics,
origin 0,0) is recorded in
`evidence/baseline/before-buoyancy-regression.json`. Headline: **zero
whole-hull air-gap frames in every preset**, solve residual ≤ 1e-8 m, waterline
error RMS 0.0133 m in the shipping preset.

Baseline visual reference: `evidence/baseline/before-CURRENT_MODERATE-*.jpg`.

---

## 10. What to extend, what to correct, what to leave alone

**Leave alone.** The parameter-space contract (bounded position + wrapped phase,
`Waves.ts:8-31`); the double-precision phase advance; the shared `waveA`/`waveB`
uniform arrays passed by reference; the radial disc and its exponential ring
spacing; the fixed-slot no-recompile design; the Newton inverse solve; the
handoff chain geometry → normal → roughness; the Cox–Munk roughness base; the
analytic sky shared between dome and water; `OvertopSpray` as a raft-only cue;
the whole `SimHandle` boundary and the buoyancy harness.

**Extend.** The component budget and its organisation into physical systems —
the equations are right, there are simply too few of them and no model deciding
what they should be. `WaveResult.jacobian` is already computed and needs a
consumer. `setLodSpacing` generalises unchanged. The lab's camera set, capture
pipeline and metric recorder generalise to ocean work with no modification.

**Correct.** D1–D5 in §7, and the fragment-stage residual cost model in §8,
which must be restructured before the slot count can grow.

**Add.** Everything to do with whitewater. There is no foam persistence, no
advection, no age, no spray, and no wind coupling of any kind beyond a single
roughness scalar. This is the largest genuine gap and it is where most of the
visual return of this round lives.
