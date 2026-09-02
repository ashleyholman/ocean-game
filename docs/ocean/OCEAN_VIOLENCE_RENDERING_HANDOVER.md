# Ocean violence and storm legibility — rendering handover

**Status: problem confirmed; implementation not started.** Written 2026-08-01
after inspecting the current production and embodied views, isolating the swell
and wind-sea layers in the running Ocean Laboratory, and tracing the ocean,
foam, spindrift, wind and camera code.

This is a self-contained brief for a dedicated implementation thread. It does
not replace `docs/ocean/OCEAN_SEA_STATE_SPEC.md`, which remains authoritative on what a
sea state means, or `docs/ocean/OCEAN_SEA_STATE_REPORT.md`, which records how the current
spectrum and whitewater systems were built. This document is about a different
question:

> Why does a sea with violent physical parameters still look comparatively
> smooth, clean and benign, and how should the renderer communicate the danger?

---

## 1. Executive conclusion

There are two separate effects, and earlier discussion blurred them together.

1. **Wave spacing is configuration.** A 15.5 s primary swell really does have a
   deep-water wavelength of about 375 m. It should look like an enormous,
   broad hill of water rather than closely packed chop. A renderer cannot make
   those crests closer without changing the sea state.
2. **The missing violence is presentation.** `SOUTHERN_OCEAN_ROUGH` also carries
   a resolved 4.39 m wind sea at about 9.68 s, 18 m/s wind, a calculated 6.01%
   whitecap fraction and aggressive foam/spray controls. With the long swell
   isolated away, that wind sea still reads as rounded, glossy corrugations
   with very little coherent breaking, whitewater or airborne spray. Those
   configured phenomena are not visually legible.

The correct direction is therefore **not simply to raise `Hs` or shorten the
primary swell**. First make breaking geometry, foam, spray, wind and visibility
communicate the sea that already exists. Only then decide whether the artistic
target also wants a different distribution of spectral energy.

The intended Southern Ocean experience is stronger than “large waves.” It is a
wind-loaded environment in which crest tops tear away, whitewater streams
downwind, the air above the surface fills with salt spray, visibility falls
during gusts or squalls, and the player intermittently loses the distant sea
behind nearby ridges. The surface, atmosphere, vessel and soundscape all need to
agree about that wind.

---

## 2. What is actually configured

The following are the resolved values shown by the Ocean Laboratory on the
current desktop path, not estimates from the comments in `presets.ts`:

| Quantity | `SOUTHERN_OCEAN_ROUGH` |
|---|---:|
| Mean wind at 10 m | 18.0 m/s |
| Gustiness | 0.70 |
| Combined significant height | 6.41 m |
| Primary swell | 4.40 m at 15.50 s, ~375 m peak wavelength |
| Secondary swell | 1.60 m at 11.0 s, ~189 m peak wavelength |
| Resolved wind sea | 4.39 m at 9.68 s, ~146 m peak wavelength |
| Sum-of-amplitudes maximum crest diagnostic | 10.91 m |
| Calculated whitecap fraction | 6.01% |
| Whitewater generation | 2.10 |
| Foam persistence | 12 s |
| Spray intensity | 1.80 |
| Fine roughness / detail gain | 1.50 / 0.90 |

Deep-water wavelength here is the usual approximation `L ≈ 1.56 T²`. The long
spacing is consequently real configuration, especially for the primary swell.
The important counterpoint is that the preset is not *only* that swell: it
contains a large, steep, broad-band wind sea and strong wind presentation
parameters too.

The comments above the preset currently quote 4.96 m wind-sea `Hs`, 6.82 m
combined `Hs` and 6.4% whitecaps. The resolver now reports 4.39 m, 6.41 m and
6.01%. That documentation drift is not the visual defect, but it should be
corrected during the implementation so nobody tunes against stale numbers.

---

## 3. Controlled visual findings

The inspection used a bright noon presentation to remove darkness as an
excuse, paused the canonical world, selected `SOUTHERN_OCEAN_ROUGH`, and compared
production and embodied views. The Ocean Laboratory's diagnostic layer masks
were then used to render swell alone and wind sea alone. Those masks preserve
the full sea's derived amplitudes, steepness, breaking threshold and detail
budget; an isolated layer is the same layer used by the composed sea.

### 3.1 Full composition

- The overall sea reads as rolling blue hills with high-frequency glitter.
- Large vertical travel is present, but scale and danger are weakly expressed.
- The distant horizon is usually clean and continuously readable.
- Coherent white crest lines are scarce relative to the stated 6% coverage.
- The diagnostic reported roughly 200–300 live spindrift particles, but no
  convincing airborne spray was perceptible in ordinary play views.
- Wind direction and 18 m/s intensity are difficult to infer without reading
  the controls.

### 3.2 Swell alone

The primary swell looked very smooth. That is substantially correct. A long,
organised 15.5 s swell can carry immense elevation with a surprisingly gentle
local slope. Its appearance explains why height alone cannot be the visual
definition of violence.

### 3.3 Wind sea alone

This is the decisive comparison. With swell and detail shading removed, the
resolved 4.39 m wind sea remained a field of rounded corrugations. It did not
look like a strongly forced 18 m/s sea with frequent breaking crests. The
problem therefore survives removal of the long wavelengths: the geometric and
whitewater layers are failing to distinguish a large wind sea from smooth
swell strongly enough.

### 3.4 Embodied crest occlusion

“Crest occlusion” means a nearer wave ridge rises into the sky portion of the
frame and hides more distant water or part of the horizon behind it. It does
not mean the entire 360-degree horizon should disappear at once. Directional
ridges normally obscure a sector, intermittently.

Partial occlusion did occur in one observed embodied sequence. It was difficult
to perceive because the crest was smooth, water and horizon haze were similar
in value, and there was no bright breaking edge or spray plume to mark it as a
near wall of water. The seated embodied eye is only about 0.66 m above the deck,
but its vertical translation follows the raft at 90%. Being carried up by the
local long wave is physically reasonable and reduces the relative rise of that
same wave around the camera. The default composition also gives a substantial
part of the frame to raft and sail.

This is **not an embodied-view ocean LOD defect**. Below a 200 m camera/subject
offset, including all embodied mode, the fine ocean is centred on the vessel
and the complete geometric chain is available.

---

## 4. Root causes and likely contributors

### 4.1 Breaking is classified but not given a breaking silhouette

The resolved surface is a bounded Gerstner composition. Its global steepness is
deliberately kept away from horizontal folding, and bound components sharpen
crests without overturning them. That is numerically sound, but it means a wave
which the breaking indicator identifies as a whitecap still has a smooth,
single-valued water silhouette. Foam and particles are asked to communicate all
of the crumbling, tearing and crest-top asymmetry.

This is the largest structural gap. A gale needs local crest forms that differ
qualitatively from swell: feathered edges, wind-torn lips, short spilling faces
and coherent downwind sheets. The base Gerstner surface cannot supply them by
itself.

### 4.2 Fine shading competes with the large form

The Southern preset has `fineRoughness: 1.5`, `detailStrength: 0.90`, strong
gust streaks and micro-chop. At bright noon the result contains plentiful
small specular variation, but the eye reads it as a glittering sheet. It can
flatten the perceived height gradient by giving crest, face and trough similar
amounts of visual activity.

The requirement is not “less detail” in the abstract. Detail needs to support
the large form: compressed and brighter near breaking tops, darker and calmer
in troughs, directionally stretched by wind, and progressively folded into a
stable roughness lobe rather than screen-space sparkle.

### 4.3 Whitewater may be physically calibrated but is not perceptually legible

The foam shader has a thoughtful three-level design: persistent history, a live
crest term and statistical far-field coverage. The current implementation was
previously calibrated by counting bright, desaturated pixels, so this handover
does **not** declare the physical whitecap calculation wrong.

It does show that calibration by total bright-pixel area is insufficient for
the experience. Six percent expressed as small fragmented flecks can satisfy a
coverage measurement while failing to produce the connected crest-length
features by which a person recognises a gale. Exposure, bright water reflection,
breakup erosion and the near/far hand-off can also make correct area visually
weak.

One value deserves explicit revalidation: the statistical far-field input is
`whitecapCoverage(U10) * min(generation, 1.5) * 0.26`. The 2.10 Southern
generation is capped at 1.5 for that term. The result is in the foam field's
internal density units, not literal surface coverage, so it must be evaluated
with captures rather than interpreted as a percentage on paper.

### 4.4 The existing spindrift is intentionally too small to carry a gale

`Spindrift.ts` describes its own design as “sparse and small.” Each sprite has a
base radius of roughly 0.045–0.165 m, lasts 0.45–1.20 s, is low-opacity and is
only easy to see when lighting produces useful forward scatter. That is a good
design for individual droplets and small streaks. It is not a representation of
metres-long sheets being torn from connected breaking ridges, nor of salt mist
loading the first several metres of air above the surface.

Increasing the count of these sprites alone is likely to produce snow or grit.
Storm presentation needs an additional, larger-scale system.

### 4.5 Wind has consumers but no environmental body

`WindSystem` is a clean source of wind direction and strength. It feeds wave
orientation, detail streaks, foam drift, spray and the raft's sail. It does not
currently create low-altitude haze, visibility loss, gust fronts, coherent
airborne streak fields, audio pressure, loose-rig response or broader vessel
cues. If the spray disappears against bright water, almost nothing else says
“18 m/s.”

The eventual schooner will add valuable scale and wind cues through sails,
cordage, flags, loose cloth and rigging noise, but the raft comparison proves
that missing ship detail is not the root cause. The ocean and atmosphere must
remain convincing when no vessel is in frame.

### 4.6 Mean wind and squall severity should not be one control

An 18 m/s mean wind warrants frequent whitecaps and substantial spindrift, but
the user's desired near-whiteout is better treated as an intermittent squall or
gust-loading state rather than permanent opaque fog across the whole preset.
The existing scalar `gustiness` modulates particle emission; it does not model a
moving squall, spray loading or visibility range. A storm-weather layer should
be able to intensify airborne water and reduce near-surface visibility without
silently changing the underlying wave spectrum.

---

## 5. Recommended implementation sequence

### Phase 0 — Build an evidence harness before tuning

Extend the existing Ocean Laboratory rather than inventing a second control
surface.

- Add canonical captures for full sea, swell only, wind sea only, detail only,
  foam off/on and spray off/on.
- Capture at a fixed noon, overcast daylight and low backlight, from embodied
  open-water, low waterline, close crest and wide horizon views.
- Record resolved `Hs`, periods, wind, whitecap fraction, live spray count,
  bright/desaturated foam coverage and the fraction of the visible horizon
  replaced by nearer water.
- Add a deterministic gust/squall phase so comparisons do not depend on waiting
  for a favourable random instant.
- Warm foam history before every capture; its time constant is measured in
  seconds and an unwarmed field is not the preset.

The first acceptance image should be **wind sea only**. If that layer does not
read as violent, adding the long swell back cannot rescue it.

### Phase 1 — Restore large-form legibility

- Reduce or reshape Southern fine-detail gain until it no longer washes the
  large surface into uniform glitter.
- Increase stable crest/face/trough value separation without painting a height
  gradient onto every wave.
- Make compressed crest shoulders broader and more coherent in lighting.
- Review horizon atmospheric blending so nearby crests separate clearly from
  distant haze while the true far horizon still dissolves naturally.
- Verify that the wind-sea geometric ladder, including metre-scale micro-chop,
  survives into the near silhouette rather than appearing only in normals.

Do not change `Hs` in this phase. It should establish what the existing geometry
can communicate.

### Phase 2 — Add a bounded breaking-crest representation

Add a rendering layer driven by the same compression/breaking data already used
for foam. Suitable approaches include a crest ribbon/cap mesh, a short-lived
displacement lip, or a screen-stable local crest sheet. Requirements:

- follow real breaking ridges rather than emit at arbitrary positions;
- extend coherently along a crest for metres, not isolated pixels;
- lean and stream downwind;
- remain bounded and non-folding at the base-surface contract;
- fade by geometric footprint rather than raw distance;
- remain registered with foam under wave displacement and origin wrapping;
- distinguish spilling/broken tops from ordinary sharp but unbroken crests.

A small visual-only cap need not enter buoyancy. If displacement becomes large
enough to alter the waterline or cause overtopping, it must instead be shared by
CPU and GPU and treated as real geometry. Keep that boundary explicit.

### Phase 3 — Recompose whitewater around crest-scale structure

- Make fresh foam form thicker, connected leading edges along breaking crests.
- Preserve holes and ageing breakup, but do not let erosion destroy the
  crest-length read at ordinary camera distances.
- Increase separation from sun glitter so whitewater remains visible at noon.
- Carry residual foam into long, wind-aligned streaks and windrows.
- Revalidate the near/far/statistical hand-off in embodied and horizon views.
- Measure physical-looking coverage and perceptual continuity separately.

The goal is not a whiter ocean. It is a sea whose white areas describe where
and how the water is breaking.

### Phase 4 — Add storm-scale spray and visibility

Keep the current droplet spindrift as the finest layer and add two larger ones:

1. **Crest spray sheets:** coherent ribbons or clustered streak volumes emitted
   from connected breaking ridges, accelerated rapidly downwind and fading over
   a few metres.
2. **Airborne salt loading:** a shallow, wind-aligned mist volume concentrated
   near the water, driven by recent breaking activity and gust/squall strength.

The second layer is what can legitimately reduce visibility. It should obscure
contrast progressively with distance, vary in gusts, remain denser downwind of
breaking groups and avoid looking like uniform grey fog. Spray against the sun
should flare; cross-lit spray should reveal streak direction; spray looking
away from useful light must still retain enough body to communicate wind.

Add non-water cues at the same time: wind and rigging audio, sail and loose-cloth
load, windward shudder, foam advection and, where appropriate, wet lens or deck
effects. Avoid generic camera shake as the primary cue; it is uncomfortable and
does not explain what the wind is doing.

### Phase 5 — Revisit the Southern spectrum only after presentation works

The current primary swell can remain long if the target is “large Southern
Ocean swell under a gale.” If the target is a younger, more chaotic storm sea,
then redistribute some energy toward broader crossed 7–10 s components,
increase directional spread or add a squall-driven short-wave band. Do not
blindly increase combined `Hs`: that will increase vessel excursion while
leaving the same smooth visual language in place.

Use the isolation captures to decide. If the repaired 9.68 s wind sea is violent
enough, the configuration was already doing its job. If it remains too ordered
after the renderer exposes it honestly, change the spectrum deliberately and
record the new scenario semantics in `docs/ocean/OCEAN_SEA_STATE_SPEC.md`.

---

## 6. Acceptance criteria

The implementation thread should define numeric thresholds after its first
baseline capture, but the behavioural gates are already clear.

### Southern Ocean rough

- In a blind comparison, its wind-sea-only capture cannot be mistaken for
  `CURRENT_MODERATE` or a swell-only state.
- Fresh breaking edges form coherent crest-length features in embodied, low
  waterline and wide views.
- Sections of the distant sea are intermittently occluded by nearer crests from
  the embodied eye, and those crests remain perceptible as near water rather
  than dissolving into horizon haze.
- Eighteen-metre-per-second wind direction is readable from surface streaks,
  foam and airborne material without opening the lab controls.
- Ordinary gale conditions show continuous whitewater activity and visible
  spindrift; deterministic squall peaks can reduce near-surface visibility
  dramatically without turning the whole frame into an opaque overlay.
- Foam remains registered to the water and stable under motion, distance, LOD,
  world-origin wrapping and all canonical camera views.
- The ocean retains large troughs and dark water between white features; it
  does not become uniformly white or uniformly noisy.

### Regression and comfort guards

- `GLASSY_LONG_SWELL` remains clean and almost spray-free.
- `CURRENT_MODERATE` does not inherit Southern storm loading.
- No new screen-space sparkle, particle snow, hard haze plane, repeating foam
  grid or camera-centred spray disc appears.
- The first rendering phases do not alter CPU wave sampling, `Hs`, period,
  buoyancy or ship motion.
- Desktop and mobile quality paths degrade density and resolution gracefully;
  mobile must retain the large coherent storm cues before the tiny particles.
- GPU cost is bracketed as an ocean component in the existing profiling
  framework before the effect is accepted.

---

## 7. Non-solutions and guardrails

- Do not make every Southern wave short. Long swell is part of the place and is
  physically compatible with violent local wind.
- Do not raise wave height merely because the surface looks calm. That makes
  vessel motion worse while leaving the communication defect untouched.
- Do not force the whole horizon to be hidden. Occlusion is directional and
  intermittent.
- Do not replace whitewater with a uniform white texture or full-screen fog.
- Do not solve wind with camera shake.
- Do not make all spray into thousands of identical bright particles.
- Do not allow a visual crest displacement large enough to disagree visibly
  with buoyancy, overtopping or foam registration.
- Do not tune only under one sun direction. Forward-scattering spray is allowed
  to change character with lighting; the storm cannot disappear completely.

---

## 8. Starting file map

| Concern | Current authority / implementation |
|---|---|
| Southern parameters | `src/ocean/presets.ts` |
| Spectrum, steepness and whitecap relation | `src/ocean/spectrum.ts` |
| CPU wave field and diagnostic layer masks | `src/scene/Waves.ts` |
| Ocean geometry, detail, foam composite and haze | `src/scene/Ocean.ts` |
| Persistent foam history | `src/scene/FoamField.ts` |
| Fine droplet spindrift | `src/scene/Spindrift.ts` |
| Wind presentation state | `src/scene/WindSystem.ts` |
| Embodied eye and stabilisation | `src/camera/EmbodiedCameraController.ts` |
| Diagnostic controls and resolved readout | `src/debug/OceanLab.ts` |
| Frame wiring and far-field foam input | `src/main.ts` |
| Sea-state contract | `docs/ocean/OCEAN_SEA_STATE_SPEC.md` |
| Existing ocean implementation evidence | `docs/ocean/OCEAN_SEA_STATE_REPORT.md` |

The best first implementation task is Phase 0 plus a small Phase 1 experiment:
produce a deterministic Southern wind-sea-only embodied capture with detail and
foam independently toggleable, then make the large geometric form and existing
foam readable before adding any new effect. That gives every later breaking,
spray and squall change an honest baseline.
