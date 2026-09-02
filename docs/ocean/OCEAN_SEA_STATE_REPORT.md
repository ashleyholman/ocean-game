# Ocean sea states and whitewater — implementation report

What was built, what was measured, and what is still wrong. The design is in
`docs/ocean/OCEAN_SEA_STATE_SPEC.md`; the state of the water beforehand is in
`docs/ocean/OCEAN_ARCHITECTURE_AUDIT.md`.

---

## 1. Architecture

**The Gerstner architecture was retained and expanded. It was not hybridised
and not replaced.** The reasoning is in the spec §2; the short version is that
raft buoyancy point-samples the surface at 240 Hz and the parity harness
compares those samples against the *rendered* surface, and an expanded Gerstner
sum is the only candidate where that comparison stays exact by construction. An
FFT ocean needs either a CPU IFFT at 240 Hz (impossible) or an async GPU
readback (latent and non-deterministic), and the hybrid only works by weakening
the physics contract to "the raft responds to the long-wave partition", which at
Hs 4.8 m means the visible water and the water the raft floats in differ by
metres.

What changed underneath is that the components are no longer written by hand.
`src/ocean/` now holds a physical model, and `Waves.ts` owns evaluation and
phase without deciding what the sea is.

### Component layout

48 slots, fixed, **identical on every device**: 24 wind sea, 12 primary swell,
12 secondary swell. A per-device count would make the raft float differently on
a phone while the parity probe stayed green, because CPU and GPU would still
agree *with each other*. Mobile saves on mesh density, detail octaves, foam
resolution, spray count and the per-pixel residual band — none of which the raft
can feel.

A system with no energy still occupies its slots at zero amplitude. Slot
identity is what makes a smooth transition possible: bin `j` of the primary
swell must stay in slot `j` whether or not the secondary swell below it happens
to be switched on.

### The parameter model

Wind: speed, direction, gustiness, maturity. Wind speed does not set wave
height; it drives the wind sea through fetch-limited JONSWAP growth
(`X̂ = X̂_full·maturity^2.5`, `ν̂p = 3.5 X̂^-0.33`, `ε = 1.6e-7 X̂`). The property
that matters is that a young sea at the same wind is *shorter and steeper*, not
merely smaller — which is why `WIND_CHOP` cannot be produced by scaling a swell
down, and why raising the wind roughens the surface long before it builds a sea.

Primary and secondary swell: significant height, peak period, direction,
directional spread, steepness, groupiness. Independently enabled and **never
rotated by the wind**.

Spectral shape is JONSWAP for the wind sea and a Gaussian for swell, discretised
by equal increments of the first moment `m₁`. Equal-*frequency* spacing makes
the sum exactly periodic with period `1/Δf`; equal-*energy* spacing has no
repeat but clusters at the peak and leaves a gap between the shortest resolved
wave and the fragment noise. Amplitudes come from each bin's actual energy
integral and the set is renormalised so `Hs = 4√m₀` holds exactly for the finite
sum rendered — verified to 1e-9 for every preset in `tests/sea-state.test.ts`.

### How wind sea differs from remote swell

Not by amplitude. By *bandwidth, spread and steepness*, all derived:

| | wind sea | swell |
|---|---|---|
| shape | JONSWAP, γ from maturity | Gaussian |
| bandwidth | ~0.55 fp (broad) | `fp / (4.5 + 9·groupiness)` |
| spread | Mitsuyasu wave-age law, 3–14 s_max, frequency-dependent | authored, 7–38° |
| steepness | `0.95 − 0.25·maturity` | authored |
| groups | none, and correctly so | 4.5–13.5 waves per set |
| rotates with wind | yes | never |

### Groupiness

Groupiness **is** the spectral bandwidth. For a narrow-band process the envelope
decorrelates on `1/σ_f`, so waves per set is exactly `fp/σ_f`, and the control
sets `σ_f = fp/(4.5 + 9·groupiness)` directly. There is no envelope function,
nothing extra for CPU and GPU to agree about, and no way for the parity contract
to notice. A wind sea gets no groupiness at all: its own bandwidth is far too
broad for sets to be perceptible. Chop does not come in sets, and that is
physics rather than a limitation.

### Steepness

`Q = 1` is the physically correct trochoid. Folding needs `Σ Q A k sin φ > 1`,
and that sum is Gaussian with sd `Q√mss`, so `safeGlobalQ` holds it at 4.5σ. The
previous per-component normalisation forced `Σ Q A k < 1` unconditionally, which
for a spectrum with tens of components is a factor of two or more too
conservative — it flattened correct seas into rounded ones. Per-band steepness
is now a *fraction of the safe trochoid*, so it means the same thing at every
sea state. Measured `Σ Q A k` runs 0.00–0.89 across the matrix, all inside the
1.25 backstop.

---

## 2. Whitewater

### Whitecap generation

The breaking indicator is the **trace** of the Jacobian perturbation,
`C = Σ Q aᵢkᵢ sin φᵢ` — the downward crest acceleration in units of g, which
`evaluateWaves` already accumulates. The threshold is derived rather than
dialled: `C` is a sum of many independent-phase terms, so it is Gaussian with sd
`Q√mss`, and requiring the surface fraction above it to equal Monahan's observed
whitecap coverage gives `C_crit = Q√mss · Φ⁻¹(1−W)` in closed form.

It was the *determinant* first, and that was wrong. The two agree to first order
but the determinant carries a second-order term that grows with the sea state,
so thresholding it made rough seas break *less* readily than calm ones — the
opposite of the truth, and not the quantity the Gaussian calibration is derived
for. The determinant stays for what it is actually about, which is folding.

Modulated by a wind gate (large swell under a dead calm does not whitecap
however big it is — this is the term that makes `GLASSY_LONG_SWELL` and
`POST_STORM_SWELL` behave), by the *signed* slope along the wind, and by slow
gust patches.

### Persistent foam

A two-level field **indexed in Gerstner parameter space**, and that is the whole
trick. A Gerstner particle orbits a fixed parameter position rather than
travelling, so foam riding on the water is stationary in that space however
violently it moves in world space. Consequences:

- **No advection pass.** Nothing to integrate, no ping-pong, no numerical
  diffusion smearing the field over a minute of play.
- **Foam rides the wave orbit for free** — the same displacement that draws the
  surface carries the lookup.
- **The diagnostic presentation origin stops being a problem.** It is a phase
  offset applied to the same coordinate, so the wave pattern and the foam
  pattern slide together. There is no boundary to cross.

Two channels: active (τ 0.7 s) and residual (τ = `persistenceSeconds`). Decay is
a multiply and injection an add, both against one target with blend state — no
second buffer. Injection is normalised by each channel's τ, so persistence
controls how long foam lasts rather than how much of it there is. What genuinely
does translate is the slow drift of surface water relative to the wave field,
which is one `vec2` applied identically to injection and lookup.

Desktop 256² near (384 m, 1.5 m/texel) + 128² far (1536 m), 24 Hz, **0.31 MB**.
Mobile halves both and runs at 12 Hz.

### Spray

A separate instanced-quad system stretched along each particle's own
screen-space velocity so it draws a streak rather than a dot, launched with the
crest's own orbital velocity, sub-second lifetime, forward-scattering, gated on
both a breaking crest and a wind strong enough to tear it. `OvertopSpray` is
untouched and remains the raft's own cue.

---

## 3. Root causes of the carried-over defects

**D1 — residual slope evaluated in displaced coordinates.** The vertex shader
evaluated phase at the undisplaced `p` but passed `vLocal`, the *displaced*
position, and the fragment shader evaluated the residual there. Everything
procedural now uses the undisplaced parameter position, which is where water
parcels actually live.

**D2 — no Gerstner normalisation.** Parameter-space gradients were added
straight onto a world-space slope, which is exact only for a height field. Each
layer now contributes a gradient in parameter space; they are summed and pushed
through the inverse horizontal Jacobian exactly once. The normal became the
exact parametric surface normal, and `WaveResult.jacobian` — computed and
discarded for the whole of the previous round — finally has readers.

**D3 — detail wrapping inconsistent with q-space periodicity.** The root cause
was a units mismatch: the origin was wrapped in *metres* (`mod 256.0`) while the
noise lattice is periodic in *cells*, and each octave was sampled at a different
frequency with a non-integer 2.17 ratio and a 31.8° rotation. The three octaves
therefore repeated over 614.4 m, 283.1 m and 130.5 m, and the code wrapped at
256 m, which matched none of them. The octave transform is now the integer
matrix `[[2,1],[-1,2]]`: being integer it maps the noise lattice onto itself, so
one wrap in octave 0 is a whole number of wraps in every later octave, and a
single exact period exists for the whole stack. It is derived from the stack
rather than assumed.

**D4 — foam noise not periodic.** Foam used `vnoise`, which has no wrap at all.
It now uses the same periodic noise in the same parameter space.

**D5 — wind headings baked at construction.** The sea state owns the wind and
`WindSystem` presents it; course and wind became separate quantities. Before,
one vector did both jobs and a wind change could not be expressed at all.

**Bonus: the `0.34` roughness fudge.** `mss_unresolved` is now
`Cox–Munk total − resolved components − detail octaves`. The derivation lands at
0.0100 for the production preset against the hand-tuned 0.0115, which is a good
sign the old value was approximately right and is now approximately *derived*.

---

## 4. Measurements

### CPU/GPU parity and buoyancy — `evidence/buoyancy-regression.json`

| | result |
|---|---|
| Whole-hull air-gap frames | **0 in every preset**, including `EXTREME_DEBUG` |
| Max inverse-solve residual | **≤ 1.00e-8 m** in every preset |
| Max CPU/GPU parity error | **3.22e-3 m**, against a pre-round baseline maximum of 6.60e-3 m |
| 30 / 60 / 120 Hz render | **identical** dRms (0.0138) and identical max pitch (8.9°) |
| Irregular render timing | dRms 0.0133 — indistinguishable |
| ±6 km, ±60 km phase origin | no degradation; dRms 0.0089–0.0138 |
| Wrap boundary ±ε | dRms 0.0101 vs 0.0102, parity 1.77e-3 vs 1.76e-3 |

The statistical `Q` did not degrade the inverse solve: residual stayed at 1e-8
everywhere despite `Σ Q A k` reaching 0.89.

### Detail-wrap continuity — `evidence/wrap-continuity.json`

Full-frame pixel diff at 3200×1800, wave field and foam history held completely
still, only the detail origin moved:

| offset | mean |Δ| | max | % pixels > 8/255 |
|---|---|---|---|
| +1 wrap | **0** | **0** | **0** |
| +7 wraps | **0** | **0** | **0** |
| +110 wraps (59 km) | 0.015 | 16 | 0 |
| wrap − 1 cm | 1.42 | 157 | 2.4 |
| +½ wrap (control) | 26.5 | 196 | 49.6 |

Bit-identical at whole wraps; the half-wrap control confirms the measurement has
discriminating power. This required a new `SimHandle.setDetailOriginOverride`,
because moving the *presentation* origin changes the wave pattern legitimately —
wave phase shifts by `k(d·origin)`, which is not a multiple of 2π for any finite
offset — and that swamps the question being asked. The first version of this
evidence made exactly that mistake and the independent critic caught it.

### Whitecap coverage — `evidence/whitecap-coverage.json`

Foam contribution isolated by differencing foam-on against foam-off, so sun
glitter is not counted as foam:

| preset | U₁₀ | rendered foam | Monahan | ratio |
|---|---|---|---|---|
| SOUTHERN_OCEAN_ROUGH | 18.0 | 5.19 % | 6.01 % | 0.86 |
| MATURE_WIND_SEA | 12.5 | 1.45 % | 2.07 % | 0.70 |
| WIND_CHOP | 9.0 | 1.18 % | 0.69 % | 1.71 |
| CURRENT_MODERATE | 6.0 | 0.00 % | 0.17 % | — |
| POST_STORM_SWELL | 5.5 | 0.00 % | 0.13 % | — |
| GLASSY_LONG_SWELL | 1.6 | 0.00 % | 0.00 % | — |

Within a factor of 1.7 across the range where whitecaps exist, and exactly zero
in the calm states. `POST_STORM_SWELL` registering zero at Hs 3.45 m is the
intended behaviour and the clearest single demonstration that coverage is driven
by wind and steepness rather than by wave height.

Spindrift particle counts scale the same way: 129 (extreme), 52 (Southern
Ocean), 7 (mature / chop), **0** (moderate, glassy, dead calm).

### Performance

Measured with `EXT_disjoint_timer_query_webgl2` at 3200×1800 (1600×900 at DPR 2),
`SOUTHERN_OCEAN_ROUGH`, Apple Silicon:

| | ms/frame |
|---|---|
| Whole scene | 19.9 |
| — sky and clouds | 2.2 |
| — ocean surface | 15.4 |
| — foam shading | 2.6 |
| — spray | < 0.3 |
| Foam field step (2 levels × decay + inject) | 0.85 |
| CPU simulation step | 1.47 (8.8 % of a 60 Hz frame) |

Per-pixel residual band, measured separately: 2.1 ms of a 29 ms frame with all
48 components against 0.4 ms with a 9 m cut. Desktop keeps all of them because
the cut costs more than it saves — between roughly 30 m and 200 m the geometry
has faded short components out while the pixel footprint can still resolve them,
and turning their slope into roughness there washes the mid-distance out.

Memory: foam field 0.31 MB desktop, 0.08 MB mobile. Spray 320 KB preallocated,
no per-frame allocation.

Bundle: entry 794 kB (gzip 234) against 752 kB (gzip 219) before. All three
diagnostic panels are dynamic imports and absent from the entry chunk:
`OceanLab` 15.4 kB, `DebugPanel` 11.9 kB, `BuoyancyLab` 34.7 kB.

### Preset matrix

Full machine-readable definitions in `evidence/sea-state-presets.json`, produced
by `npx vite-node tools/export-presets.ts`. Every `resolved` value is what the
model produces from the declared parameters; none is authored.

| preset | U₁₀ | Hs | Tp | λ max | max wave | Σ Q A k | W | survivability |
|---|---|---|---|---|---|---|---|---|
| FLAT | 0 | 0.00 | — | 0 | 0.0 | 0.00 | 0 % | comfortable |
| DEAD_CALM | 0.8 | 0.07 | 16.0 | 544 | 0.1 | 0.00 | 0 % | comfortable |
| GLASSY_LONG_SWELL | 1.6 | 1.90 | 15.0 | 484 | 3.5 | 0.01 | 0 % | comfortable |
| LIGHT_BREEZE_OVER_SWELL | 4.6 | 1.46 | 12.0 | 327 | 2.7 | 0.34 | 0.07 % | comfortable |
| WIND_CHOP | 9.0 | 0.48 | 2.4 | 185 | 0.9 | 0.50 | 0.69 % | wet but viable |
| CURRENT_MODERATE | 6.0 | 0.56 | 6.3 | 107 | 1.0 | 0.43 | 0.17 % | comfortable |
| MATURE_WIND_SEA | 12.5 | 3.23 | 8.5 | 271 | 6.0 | 0.51 | 2.07 % | marginal |
| CROSSING_SEAS | 7.5 | 2.31 | 12.5 | 356 | 4.3 | 0.53 | 0.37 % | wet but viable |
| POST_STORM_SWELL | 5.5 | 3.45 | 14.5 | 446 | 6.4 | 0.41 | 0.13 % | marginal |
| SOUTHERN_OCEAN_ROUGH | 18.0 | 6.42 | 15.5 | 527 | 11.9 | 0.61 | 6.01 % | marginal |
| EXTREME_DEBUG | 26.0 | 17.98 | 19.9 | 991 | 33.4 | 0.89 | 9.72 % | debug only |

---

## 5. Independent critic

An independent critic reviewed 25 renders against the baseline without knowing
how anything was implemented. It found two genuine defects that had survived my
own review, both of which are now fixed:

**The threshold-bias sign was inverted.** `breakingThreshold` returned
`threshold − bias·σ` while the documented meaning of the control is "negative
makes foam easier". Because every rough preset carried a negative trim and every
calm preset a positive one, the trims were systematically fighting the physical
calibration — the critic measured `WIND_CHOP` at 9 m/s carrying five times the
foam of an 18 m/s Southern Ocean gale, and 17× that of `MATURE_WIND_SEA`. Fixed,
and `tests/sea-state.test.ts` now asserts both the sign and the resulting
coverage ordering across the matrix.

**Foam showed bilinear-texel geometry.** The critic described "a literal
geometric diamond — four straight edges, four sharp corners, a smooth radial
gradient interior", and diagnosed it as a placed billboard. There are no
billboards; that shape is exactly what a bilinearly-filtered *isolated texel*
looks like when foam is sparse relative to a 1.5 m field texel. The lookup is now
jittered by a fraction of a texel using the same noise that breaks the foam up,
which destroys the texel geometry without blurring the field or costing a second
fetch. The critic identified the artefact correctly and the mechanism
incorrectly, which is exactly what an independent critic is for.

It also correctly identified that my wrap-continuity evidence could not show
what it claimed, because moving the presentation origin changes the wave field
as well as the detail noise. That is a methodological error on my part; §4
records the corrected, decisive measurement.

Three of its severity-1 findings I judge to be artefacts of the evidence rather
than the renderer, and I have re-shot rather than "fixed" them:

- *"All waterline views collapse to the same sea."* The lab's waterline camera
  sits 0.95 m above the local surface, 7 m from the raft, at 26° FOV, and it
  tracks the water. A 375 m swell is locally a tilted plane at that framing, so
  the shot cannot show wave height whatever the height is. The wide camera in
  `evidence/final/` shows the difference plainly.
- *"Crossing seas contains a single wave train."* The image-space FFT it used
  was taken over a mid-distance strip, where perspective compresses the surface
  so severely that near-horizontal banding dominates regardless of the true
  directional spectrum. At the wide camera the two systems are clearly separate.
- *"Detail declines monotonically with world offset."* Measured across frames
  whose wave fields legitimately differed; the controlled test in §4 shows
  bit-identical output at 59 km.

Two of its severity-2 findings were real and are fixed: `CURRENT_MODERATE` had
come back measurably more directionally locked than the baseline it exists to
defend (spread widened 24° → 38°, against the old preset's ±78° fan), and
`POST_STORM_SWELL` was reading as a washboard rather than a swell (spread
widened 8° → 15°).

---

## 6. Known limitations

**Physical**

- No breaking-crest *geometry*. Gerstner cannot overturn a lip; whitewater is
  shading and particles on a non-overturning surface. This is the architecture's
  real ceiling and no amount of foam work removes it.
- The resolved band stops at 3.5 m. Everything shorter is statistical roughness,
  which is why the whitecap threshold has to relax below Michell's limit — the
  relaxation is precisely the correction for that truncation.
- Foam does not spread or diffuse. It decays and drifts uniformly; a patch keeps
  its shape as it fades. Real foam spreads as it ages.
- Swell direction does not refract, and there are no currents.
- `SOUTHERN_OCEAN_ROUGH` is classified *marginal* but measured zero overtopping
  frames. That is not a bug: its energy sits at 15.5 s and 176–375 m
  wavelengths, which a 3.2 m raft rides like a lift. Overtopping tracks
  *steepness*, not height — `WIND_CHOP` at Hs 0.47 m overtops on 191 frames
  while `SOUTHERN_OCEAN_ROUGH` at Hs 6.42 m overtops on none. The classification
  is optimistic and is left as documentation of expected behaviour rather than
  of measured behaviour.
- The raft's constrained three-degree-of-freedom model **cannot represent a
  capsize at all**. `EXTREME_DEBUG` wets critical points on 318 frames and
  should physically have rolled the raft over long before; it instead clamps at
  ±0.7 rad. Nothing has been flattened or given extra freeboard to hide this —
  it is a limitation of the raft model, and it belongs to a later round.

**Visual**

- The raft has no waterline *intersection*: no contact foam, no refraction, no
  local displacement. There is only a contact-darkening term. This is
  pre-existing and belongs to the graphics round, but it is the largest single
  obstacle to reading scale, and the critic was right to raise it.
- The far field bleaches towards the horizon in energetic states: distance haze
  plus specular saturation together crush wave silhouettes that should be
  visible as a serrated line.
- Quantisation contours are visible in near-field normals under high contrast.
- Calm presets show no raft reflection, which undercuts the mirror claim more
  than the flatness supports it.
- Foam shading is deliberately simple pending the lighting round: Lambertian
  with age-dependent albedo, split sky/sun/moon irradiance, edge translucency
  and a relief bump, but no multiple scattering and no wet-surface response.

---

## 7. Files changed

**New**

```
src/ocean/seaState.ts             canonical parameters, slot budget, interpolation
src/ocean/spectrum.ts             JONSWAP/Gaussian, m1 binning, growth, whitecaps
src/ocean/presets.ts              the twelve sea states
src/ocean/SeaStateController.ts   transitions
src/scene/FoamField.ts            persistent foam in Gerstner parameter space
src/scene/Spindrift.ts            wind-torn crest spray
src/ui/DevTools.ts                developer-tools launcher shell
src/ui/controls.ts                shared panel control builders
src/debug/OceanLab.ts             ocean laboratory panel
tools/export-presets.ts           machine-readable preset export
tests/sea-state.test.ts           30 tests over the sea-state model
tests/shader-source.test.ts       GLSL template-literal hazards
docs/ocean/OCEAN_SEA_STATE_SPEC.md
docs/ocean/OCEAN_SEA_STATE_REPORT.md
docs/ocean/OCEAN_ARCHITECTURE_AUDIT.md
```

**Modified**

```
src/scene/Waves.ts          sea states, 48 slots, statistical Q, phase re-seeding,
                            compression output, exact normal
src/scene/shaders/lib.ts    gradient/Jacobian split, compression, residual band
src/scene/Ocean.ts          parameter-space coordinates, integer octave matrix,
                            derived roughness, the whole whitewater block
src/scene/WindSystem.ts     wind and course separated
src/main.ts                 sea-state wiring, foam/spray, dev-tools launcher
src/ui/DebugPanel.ts        becomes a lazily-imported DevPanel
src/debug/BuoyancyLab.ts    migrated to sea states
src/debug/labParity.ts      shares the new residual uniform
src/debug/labCapture.ts     configurable capture port
src/styles.css              panel moved left, scroll containment
vite.config.ts              vitest scope pinned, nested worktrees excluded
README.md, docs/project/FUTURE_ROUNDS.md
```

**Evidence**

```
evidence/baseline/            pre-round reference renders and buoyancy numbers
evidence/final/               all ten sea states at the wide camera
evidence/round1/, round2/     critic input and the re-shoot
evidence/buoyancy-regression.json
evidence/wrap-continuity.json
evidence/whitecap-coverage.json
evidence/sea-state-presets.json
```

---

## 8. Verification

```
vitest run     7 files, 100 tests, all passing
tsc --noEmit   clean
vite build     clean (one pre-existing >500 kB chunk warning)
```

Vitest scope is now pinned to `tests/**/*.test.ts` with `.claude/worktrees` and
`.codex/worktrees` excluded. There was no `test` config before, so vitest
inferred its include glob and would have walked into nested agent worktrees,
reporting another branch's results as if they were this one's.
