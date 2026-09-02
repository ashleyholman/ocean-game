# Ocean sea states and whitewater — specification

The design this round was built to. `docs/ocean/OCEAN_ARCHITECTURE_AUDIT.md` records what
existed beforehand; `docs/ocean/OCEAN_SEA_STATE_REPORT.md` records what was actually
delivered and measured.

---

## 1. Current architecture, in one paragraph

A sum of six Gerstner components in eight uniform slots, evaluated by identical
arithmetic on the CPU (`Waves.ts`) and in the ocean vertex shader
(`shaders/lib.ts`). Phase is advanced in double precision and uploaded already
wrapped, so the shader never sees absolute time or absolute position — only a
bounded parameter position and a wrapped phase. That contract is what makes
CPU/GPU temporal parity exact rather than approximate, and everything else in
this round is subordinate to preserving it. Details, measurements and the five
carried-over defects are in the audit.

---

## 2. Extension strategy, and why

**The Gerstner architecture is retained and expanded. It is not hybridised and
not replaced.**

The decision rests on one constraint that outranks every visual consideration:
raft buoyancy point-samples the surface 24 times per station-pass at a fixed
240 Hz, and the parity harness compares those samples against the *rendered*
surface. An expanded Gerstner sum is the only option where that comparison stays
exact by construction.

| | Expanded Gerstner | FFT / Tessendorf | Hybrid (FFT sea + Gerstner swell) |
|---|---|---|---|
| Deterministic CPU point sample at 240 Hz | closed form, exact | needs a CPU IFFT (~6 transforms × 240 Hz — impossible) or an async GPU readback (latency, non-determinism) | same problem, for the partition that carries most of the energy |
| CPU/GPU parity | exact by construction | centimetres in flat water, metres near crests — the CPU samples a bilinear interpolation of a lattice, not the surface the GPU drew | parity contract must be weakened to "long-wave partition only" |
| Preset change | a `Float32Array` upload | regenerate and re-upload `h0(k)`, O(N²) | both |
| Shader recompile | never (fixed slot count) | never | never |
| Tiling | none (no tile exists) | one 256 m tile repeats visibly from raft height; needs 2–3 cascades | inherits it |
| Breaking-crest geometry | never (real ceiling) | never without extra machinery | never |

The hybrid has an honest escape — declare the physics contract to be "the raft
responds to the long-wave partition only" — but at Hs 4.8 m the FFT partition is
*most* of the sea, so the visible water and the water the raft floats in would
differ by metres. That is precisely the bug class the `Waves.ts` header says the
contract exists to prevent, and converting a hard invariant into a soft one to
buy visual detail is the wrong trade in a project whose previous round was spent
establishing the invariant.

The two known weaknesses of Gerstner are already mitigated in this codebase:
`residualWaveGradient()` catches the components the geometry LOD dropped, and
Cox–Munk roughness catches everything below the resolved band. This round makes
the second derived rather than tuned (§7).

**Slot budget: 48, fixed, identical on every device.** 24 wind sea, 12 primary
swell, 12 secondary swell. A per-device component count would make the raft
float differently on a phone while the parity probe stayed green, because CPU
and GPU would still agree *with each other*. Mobile saves its budget on mesh
density, detail octaves, foam resolution and spray count — none of which the
raft can feel.

---

## 3. Canonical sea-state parameters

One convention, stated once: **every direction is the heading the waves or wind
travel _towards_, degrees clockwise from local north**, in the transported local
tangent frame `WorldRenderAdapter` derives from `PlanetaryWorld`. It maps to a
local render direction as `(sin θ, −cos θ)`. It is a presentation heading. Nothing
in the sea state integrates travel or is written back into `PlanetaryWorld`.

### A. Local wind — `generatingWind`
`speedMps`, `directionDeg`, `gustiness`, `maturity` (0..1 fetch/duration proxy).

**Renamed and re-meant by WX2** (`docs/weather/WEATHER_CONCEPT.md` §6). The
field was `wind` and it was, literally, the wind: `WorldWind.setMean` was fed
from it every frame. Since WX2 the present wind is `WeatherState`'s and this
record is the wind that *grew this sea* — `speedMps` and `maturity` describe a
sea jointly and neither is meaningful alone. Every number in `presets.ts` is
unchanged by the rename. `src/ocean/WindSeaMemory.ts` is what writes the pair,
and states the one formula relating it to the present wind.

Wind speed does **not** set every wave height. It sets the wind sea, through
fetch-limited JONSWAP growth (Hasselmann et al. 1973):

```
X̂  = X̂_full · maturity^2.5           X̂_full = 2.14e4
ν̂p = 3.5 X̂^-0.33   (floor 0.13)      ε = 1.6e-7 X̂   (cap 3.64e-3)
Tp = U₁₀ / (g ν̂p)                     Hs = 4 (U₁₀²/g) √ε
```

The property that matters visually: a young sea at the same wind speed is
*shorter and steeper*, not merely smaller. Raising the wind over calm water
roughens the surface long before it builds a large sea. Fully-developed limits
are `Hs∞ ≈ 0.0246 U₁₀²` and `Tp∞ ≈ 0.784 U₁₀`, both uncertain to about ±5 %
because the U₁₉.₅→U₁₀ conversion is.

Wind also drives: directional spread (Mitsuyasu wave-age law), spectral
peakedness γ, fine roughness, whitecap threshold, foam streak orientation, foam
drift and spray emission.

### B and C. Primary and secondary swell
`enabled`, `significantHeight`, `peakPeriod`, `directionDeg`, `spreadDeg`,
`steepness`, `groupiness`. Independently enabled, and **never rotated by the
wind**. Swell that arrived from a storm two thousand kilometres away does not
swing round because the local breeze backed.

### D. Capillary and high-frequency roughness
`fineRoughness`, `detailScale`, `detailStrength`, `gustStreak`. Affects
reflection and fine appearance; contributes no displacement, so it cannot move
the raft. Diminishes to a genuinely glassy state under little wind.

### E. Whitewater
`thresholdBias` (in units of σ, so it means the same thing at every sea state),
`generation`, `persistenceSeconds`, `breakup`, `windAdvection`, `sprayIntensity`.

---

## 4. Wave-system decomposition

**Spectral shape.** JONSWAP for the wind sea; a Gaussian for swell, because
swell has been dispersively filtered by distance and because `σ_f` then gives
direct control over the one quantity that decides how a sea reads — for a
narrow-band process the envelope decorrelates on `1/σ_f`, so waves per set is
`fp/σ_f`. The Phillips constant α is dropped entirely: the shape is integrated
numerically and the discrete components are rescaled so `Hs = 4√m₀` holds
*exactly* for the finite sum actually rendered.

**Discretisation: equal increments of the first moment `m₁ = ∫ f S(f) df`.**
Equal *frequency* spacing makes the sum exactly periodic with period `1/Δf`,
short enough to see at any affordable count. Equal *energy* spacing has no
repeat but clusters at the peak: at 24 components the shortest wave it produces
is around 14 m, leaving nothing between there and the 2.4 m fragment noise.
Equal-m₁ has no repeat *and* reaches about 3.8 fp at the top bin. Amplitudes come
from each bin's actual energy integral, not the mid-point rectangle rule.

**Deterministic everywhere.** No RNG: golden-ratio stratified jitter inside each
bin, and a stratified quantile through the wrapped-Gaussian approximation to
`cos^2s(θ/2)` for directions. Same seed and parameters ⇒ bit-identical
components on every device.

**Groupiness is the spectral bandwidth, not an envelope.** `groupWaves = 4.5 +
9·groupiness` sets `σ_f = fp/groupWaves` directly. There is no envelope
function, nothing extra for CPU and GPU to agree about, and no possibility of
the parity contract noticing. A wind sea gets no `groupWaves` at all: its own
bandwidth is about 0.55 fp, far too broad for groups to be perceptible. Chop
does not come in sets, and that is correct physics rather than a limitation.

**Steepness is a fraction of the safe trochoid.** `Q = 1` is the physically
correct trochoid — circular Lagrangian orbits of radius A. Folding needs
`Σ Q A k sin φ > 1`, and that sum is Gaussian with sd `Q√mss`, so it is a
several-sigma event rather than something that happens; `safeGlobalQ` holds it at
4.5σ. The previous per-component normalisation forced `Σ Q A k < 1`
unconditionally, which for a spectrum with tens of components is a factor of two
or more too conservative and flattened correct seas into rounded ones.

---

## 5. Whitewater architecture

Four separate systems. They are not merged.

**1. Whitecap generation.** The breaking indicator is the *trace* of the
Jacobian perturbation, `C = Σ Q aᵢkᵢ sin φᵢ` — the downward crest acceleration in
units of g, which `evaluateWaves` already accumulates. The threshold is derived,
not dialled: `C` is a sum of many independent-phase terms, so it is Gaussian
with sd `Q√mss`, and requiring the surface fraction above the threshold to equal
Monahan's observed whitecap coverage gives

```
C_crit = Q √mss · Φ⁻¹(1 − W),     W = 3.84e-6 U₁₀^3.41, rolled off to a 10 % asymptote
```

Foam *area* is therefore calibrated against measurement by construction, and is
verifiable by histogramming the field. Modulated by a wind gate (large swell
under a dead calm does not whitecap however big it is), by the *signed* slope
along the wind (breaking happens on the downwind face; using slope magnitude
puts a symmetric ring round every crest, one of the clearest tells of painted-on
foam), and by slow gust patches.

**2. Persistent foam.** A two-level field **indexed in Gerstner parameter
space**. This is the load-bearing idea: a Gerstner particle orbits a fixed
parameter position rather than travelling, so foam riding on the water is
*stationary* in that space however violently it moves in world space. Therefore
no advection pass, no ping-pong, no numerical diffusion — and the diagnostic
presentation origin stops being a problem, because it is a phase offset applied
to the same coordinate, so the wave pattern and the foam pattern slide together.
Two channels: active (τ 0.7 s, the break itself) and residual (τ =
`persistenceSeconds`, the slick it leaves). Decay is a multiply and injection an
add, both done with blend state against one target. Injection is normalised by
each channel's τ so persistence controls how long foam lasts, not how much there
is.

**3. Foam appearance.** Multi-scale noise thresholded against coverage, with the
threshold floored so even saturated foam keeps holes in it; a second finer cut
for holes inside holes; footprint-widened thresholds for correct pre-filtering;
age-dependent albedo; split sky/sun/moon irradiance so foam is warm at sunset
and blue-grey at dusk rather than one grey that only changes brightness;
translucency at thin edges; and suppression of the water's specular underneath,
because a bubble raft has no mirror in it.

**4. Spindrift.** A separate instanced-quad system, stretched along each
particle's own screen-space velocity so it draws a streak rather than a dot,
launched with the crest's orbital velocity, sub-second lifetime, forward
scattering, and gated on both a breaking crest and a wind strong enough to tear
it. `OvertopSpray` is untouched and remains the raft's own cue.

---

## 6. Control panel and preset matrix

A discoverable `Tools` launcher, bottom-left, opening a list of lazily-imported
panels: world/lighting, ocean laboratory, buoyancy lab. `Hide all` gives a clean
frame while every panel keeps its state; `\` toggles all chrome including the
launcher. `?debug=1`, `?debug=ocean` and `?debug=buoyancy` open the same UI
state rather than constructing a competing debug system.

Ten sea states plus `FLAT` and `FROZEN_SINGLE` diagnostics. Full documented
matrix with resolved values is in the report.

---

## 7. Corrections to existing defects

- **D1, residual coordinates.** Everything procedural — residual wave gradient,
  detail octaves, foam field, foam breakup — moves to the *undisplaced parameter
  position*, the same `p` the vertex phase used.
- **D2, Gerstner normal.** Each layer contributes a height gradient in parameter
  space; they are summed and converted to a world slope exactly once, through
  the inverse horizontal Jacobian. The normal becomes the exact parametric
  surface normal.
- **D3, detail wrapping.** The octave transform becomes the integer matrix
  `[[2,1],[-1,2]]`, which maps the noise lattice onto itself, so one wrap period
  is exact for the whole stack. The period is derived from the stack rather than
  assumed.
- **D4, foam wrapping.** Foam moves into the same periodic noise and the same
  parameter space.
- **D5, wind heading.** The sea state owns the wind; `WindSystem` presents it.
  Course and wind become separate quantities. *(Superseded by weather round WX2:
  `WeatherState` owns the present wind and the sea owns its memory of it. The
  half of this that still holds is that `WindSystem` only presents.)*
- **Roughness.** `mss_unresolved = Cox–Munk total − resolved components −
  detail octaves`, replacing a hand-tuned 0.34.

---

## 8. Acceptance criteria

**Numerical.** Zero whole-hull air-gap frames in every raft-survivable preset;
solve residual ≤ 1e-8 m; CPU/GPU parity within the pre-round scale (max
6.60e-3 m); identical results at 30/60/120 Hz and under irregular render timing;
no degradation at ±6 km, ±60 km or across a wrap boundary; type-check and
production build clean.

**Visual.** DEAD_CALM genuinely calm rather than scaled-down waves;
GLASSY_LONG_SWELL broad and smooth with little roughness; WIND_CHOP short and
locally driven rather than miniature swell; CROSSING_SEAS visibly two systems;
POST_STORM_SWELL powerful with reduced whitewater; SOUTHERN_OCEAN_ROUGH
materially larger and more energetic, not merely faster; whitecaps present for
plausible reasons and absent where inappropriate; foam persisting, advecting,
fragmenting and decaying; continuity across origin changes and wrap boundaries;
CURRENT_MODERATE not regressed.

**Performance.** Smooth at 1440p on a modern desktop; 4K at a capped device
pixel ratio; usable 30 fps at a mobile viewport; no unbounded allocation in the
animation loop.

---

## 9. Non-goals

Global weather simulation; meteorological forecasts; latitude/longitude/sun/moon
work (already owned by the world round); shorelines, reefs, bathymetry; breaking
surf; Navier–Stokes; volumetric water-on-deck; capsize, structural breakup,
drowning or survival systems; gameplay-facing controls; the multi-scale camera
(round 2) and final graphics polish (round 3); a full FFT replacement; an
SDF/ray-marched ocean.
