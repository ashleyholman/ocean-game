# Visual lighting specification — clear-sky atmosphere, ocean optics, full day

The graphics round's design contract. Derived from the measured baseline
(`evidence/graphics-round/baseline/`), two quantitative analyses of the
shipped model, and `docs/graphics/VISUAL_REFERENCE_NOTES.md`. Everything here derives from
the real astronomical state — Sun/Moon direction and elevation — never from
clock labels.

## Protected references

`evidence/graphics-round/baseline/16-sunset-sunview-58m.jpg` and
`17-sunset-sunview-14m.jpg` — the sun-facing sunset with its concentrated
warm glitter path — are the look this project is being built around. Every
change below was chosen to leave the 0–5° sun-elevation sun-facing band
within a few sRGB counts of these frames. The transmittance chain
(`betaExtinction`, `lightTransmittance`, `SUN_BELOW`) is therefore
untouchable in this round: it is what makes those sunsets.

## Colour pipeline

- Working space: linear sRGB throughout. All shader radiometry is linear;
  `TimeOfDay` writes computed colours with explicit `LinearSRGBColorSpace`;
  hex-authored material colours use three's default sRGB→linear tagging.
- Output: `renderer.outputColorSpace = SRGBColorSpace`, applied exactly once
  by `<colorspace_fragment>` in custom shaders and by the standard chunks in
  built-in materials.
- Tone mapping: ACES filmic, applied exactly once (`material.toneMapped`
  default true; verified against three 0.185 source that custom
  ShaderMaterials get `TONE_MAPPING` defined once). No post chain, no bloom
  pass: the sun/moon/star/lamp "glow" is authored in-shader, where it cannot
  smear the horizon.
- Audit verdict: there is **no** colour-space or double-tonemap bug. The grey
  midday was a model operating-point problem (see below). This spec keeps
  the pipeline as-is and fixes the model.

## The diagnosed midday failure (what this spec corrects)

1. Mie in-scatter used the full Mie extinction coefficient (0.057) with a
   wide HG lobe (g = 0.76): 54% of red-channel extinction re-emitted into a
   >60°-wide circumsolar veil. Zenith B/R 1.65 instead of ~4. **Fix: split
   Mie scattering from Mie extinction** — extinction keeps βM = 0.057
   (sunset colour depends on it), in-scatter uses βM_scat = 0.020 with
   g = 0.85. The glow tightens to a genuine clear-sky aureole.
2. The exposure floor (0.55) held the sky 1.4 stops into the ACES shoulder,
   where blue compresses to grey. **Fix: floor 0.55 → 0.34.** Only binds
   above ~+5° sun elevation; sunset/twilight/night exposure is unchanged.
3. The circumsolar halo term `pow(mu,9)·0.030` added a second 20–30° wash.
   **Fix: `pow(mu,30)·0.014`** — a ~5° aureole survives, the wash does not.
4. Materials: the directional sun was ~10× dimmer than the sky model's own
   illuminant while ambient fill was boosted ×5; a sun-facing sail at +2°
   received 5.8× more (blue) ambient than (red) direct light. **Fix:
   `sunScale` 3.05 → 8.0, sail ambient gain 5.0 → 3.2.**

## Clear-atmosphere profile

One fixed clear maritime profile, continuous in sun elevation:

- Rayleigh: β_R = (0.0403, 0.0977, 0.2334) per air mass (real sea-level
  optical depths). Unchanged.
- Mie extinction: β_M = 0.057 + 0.0075 absorption. Unchanged (transmittance
  authority).
- Mie in-scatter: β_M_scat = 0.020, HG g = 0.85 (clear maritime aerosol:
  AOD ~0.08, narrow forward lobe).
- Multiple scattering: MULTI = 0.15 with the ozone-filtered illuminant.
  Unchanged — it is the bluest term in the model and is what makes twilight
  blue; its magnitude at the horizon is handled by exposure, not by cutting
  it.
- Weather extension point: a future weather system varies β_M_scat, g,
  haze distance and cloud parameters; this round hard-wires the clear set
  in one place.

Predicted (verified from an exact numerical mirror): midday zenith sRGB
≈ (121, 149, 184), 45°-elevation sky ≈ (100, 143, 188), horizon a pale
unclipped blue-grey ≈ (212, 224, 230); sunset band within ~10 counts of the
protected reference.

## Exposure strategy

Deterministic scene-side curve (no temporal luminance adaptation): target =
`min(3.0, max(0.34, 0.55·(0.29 / (ambientLum + 0.0008))^0.34))`, smoothed
with a 4 s presentation-time constant (unchanged shape apart from the
floor). Day sits ~0.34–0.5, sunset ~0.7, blue hour ~1.0–1.4. The debug
exposure bias remains a pure multiplier on top. Exposure never creates light:
stars, lamp and moon are gated on their own source terms.

**Ceiling raised 2.3 → 3.0, with `NIGHT_BASE_GAIN = 0.25`.** These are one
change. The airglow floor in `nightBase` was not behaving like a floor: at full
strength it sat above everything that is supposed to light a night, and a *full
moon* moved the ambient by only 1.21×. It is also where most of the world's
compression lived — 6.5 stops noon-to-night against reality's ~18. Cutting it
to a quarter recovers about two of those stops. The old 2.3 ceiling had to move
with it, because a moonless night already sat at 1.98 — within 1.16× of the cap
— so any deepening past ~1.55× stopped being met by the meter and simply drove
the picture dark, which is the wrong half of "the world got darker". What is
being modelled by the extra headroom is dark adaptation, and the point of it is
that the constant sources — the lamp, the stars, the moon — rise in the picture
as the meter opens. That is the whole reason a lantern reads as a lantern:
weak and incidental at dusk, the only thing that matters at midnight, with the
change carried by the world going dark rather than by a switch.

The moon has *not* had this pass and still wants one: after the cut a full moon
moves the ambient by 1.8× against a real 100–300×, so moonlit and moonless
nights still look nearly alike. Recorded in GRAPHICS_TODO.

## Direct sun vs ambient sky

- `sunLightIntensity = transmittanceMagnitude × 8.0 × belowFade` — the
  DirectionalLight now matches the sky model's own illuminant scale, so a
  low sun visibly out-shines the cool fill on facing surfaces.
- Hemisphere fill: unchanged sampling (sky-model average), but consumers'
  gains rebalanced (sail 3.2, see materials). Ambient stays cool and
  subordinate.
- Spray consumers of `sunIntensity` are rescaled by 3.05/8.0 so their
  absolute brightness is preserved through the sunScale change.

## Ocean optical model

Four separated components (per-pixel, in the existing shader structure):

1. **Water-body radiance.** Irradiance-reflectance form
   `Rw = bb/(a+bb) ≈ (0.0035, 0.016, 0.062)` (Jerlov-I-like oligotrophic
   profile) times downwelling irradiance
   `Ed = skyGain·ambient + sunGain·sunRadiance·max(sunElev,0)`. Deeper,
   bluer and *sun-aware*: body colour collapses warm-dark at sunset by
   itself. Existing crest SSS term kept.
2. **Fresnel sky reflection.** True reflected ray (the horizon bend is
   deleted); roughness widens the lobe by blending toward a CPU-computed
   cosine-weighted hemispheric sky radiance (`lobeBlend = min(1.6·αr, 0.55)`)
   instead of bending every ray into the bright horizon band. Schlick
   Fresnel with roughness-limited F90 (`F90 = 1 − 0.55·min(2.4·αr, 0.7)`):
   a wind-roughened sea never reaches mirror grazing reflectance.
3. **Sun glitter.** GGX with a glitter-specific roughness:
   `σ² = unresolvedSlopeVariance + pixelVariance` (variances add — the old
   σ-addition inflated α by √2), `αg = clamp(√(2σ²), 0.06, 0.45)`,
   `αr = clamp(0.55·αg, 0.04, 0.28)`. Microfacet Fresnel **F(V·H)**, not
   F(N·V): at noon steep views this cuts the broad glare ~10×; on the
   sunset sun-facing path V·H stays grazing and the path keeps full punch —
   tighter and more fragmented, not weaker.

   **Where the drawn/statistical split sits** (desktop 5 detail octaves, was
   3). The stack draws the slope a pixel can resolve and hands the rest to the
   lobe; at three octaves the finest cell was 0.48 m and only 16% of the sea's
   unresolved slope variance was ever drawn, leaving a 12.5° lobe to be broken
   up by a normal that swung 5.5°. A lobe wider than the texture that has to
   modulate it smooths over it — measurably so, ratio 0.44. That is why a
   lantern two metres away lit a flat disc and why the near daylight sea read
   glassy. Five octaves put the finest cell at 9.6 cm and the split at 9.2°
   drawn against a 10.2° lobe (ratio 0.91), which is where sparkle contrast
   peaks. Six was measured (4.3 cm, ratio 1.58) and deliberately not taken: it
   narrows the lobe to 7.4° and would visibly retune the daylight sun glitter,
   which is a separate look decision. Cost is confined to the near field by
   each octave's existing Nyquist fade — octaves 3 and 4 are dead past roughly
   ten metres and hand their variance back to the lobe per pixel — and the
   wrap-period identity is unaffected, because the integer octave matrix maps
   the lattice onto itself at any octave count.
4. **Foam.** Existing history/coverage system untouched. Shading fixed:
   the sun term dropped its accidental second transmittance factor and its
   gain rises 0.055 → ~0.16, so daylight whitecaps are finally brighter
   than the water; compositing becomes a bounded mix (foam keeps ~10% of
   the spec instead of subtracting it, so foam can never render darker than
   the glare it sits on); the far statistical coverage ramp is aligned to
   the far-window fade (same smoothstep edges) so the window edge is C¹;
   the injection band is expressed in units of the breaking indicator's own
   σ (calibrated to be pixel-identical at the shipping moderate state) so
   `microChop` no longer widens it in absolute units.

Atmospheric perspective: clear-profile haze distance 2600 → 9000 m
(2600 was a 10 km-visibility hazy day; clear tropical marine is 30–60 km).
The ridging that haze masked is neutralised structurally: as footprint
folds structure into variance, the reflection lobe blend pre-averages the
sky, so distant normal perturbations stop mattering exactly where they
become sub-pixel. Altitude-ramped hold-back unchanged.

Moon glitter: same formula as the sun with the real moon direction, gain
11 → ~3.5, scaled by lunar illuminated fraction; a restrained silver path
~2 stops below white.

### Ocean profile interface

`OceanOpticsProfile { absorption, backscatter, skyIrradianceGain,
sunIrradianceGain, roughnessScale, reflectLobeRatio, grazingRolloff,
hazeDistance, foamAlbedoFresh/Old, foamSkyGain, foamSunGain,
moonSpecularGain }` — one clear deep-ocean instance shipped; geographic /
weather profiles later swap constants without touching planetary code.

## Clouds

Geometry, coverage and motion untouched. Lighting only: lit colour follows
`lightTransmittance(sunDir)` (already warm at low sun); the shade colour
stays a sky-derived term so cloudless sky is never veiled (alpha compositing
verified against the bluer sky); at night clouds fall to the night-base sky
times a small factor — dark silhouettes, faintly moonlit when the moon is up
(existing `uMoonTint·uMoonPower` term, rescaled by phase).

## Twilight

No twilight-specific code path: the progression falls out of the atmosphere
(ozone-filtered multiple scattering), the exposure curve and the star
visibility function, all continuous in sun elevation. Validation pins the
stages: −4° warm horizon + blue dome, −9° deep blue, −15° near-dark with a
faint sunward glow, −18° full night.

## Star visibility

Magnitude-dependent, driven by estimated sky state, not elapsed time:

- CPU computes `limitingMagnitude` from sun elevation (piecewise-smooth fit
  of Crumey-style twilight limits: +2° → none, 0° → ≈ −0.5, −4° → ≈ 1.5,
  −9° → ≈ 3.2, −12° → ≈ 4.5, −15° → ≈ 5.3, −18°+ → 6.2), reduced when the
  moon is bright (up to ~1.2 magnitudes at full moon).
- Per star (GPU, vertex): visibility =
  `smoothstep(limit + 0.4, limit − 0.9, m_eff)` where
  `m_eff = magnitude + k·(airmass−1)`, k ≈ 0.25 — near-horizon extinction
  dims and never brightens.
- Bright stars therefore appear first, the full catalogue only under a
  sufficiently dark sky, and dawn reverses the sequence continuously.
- Diagnostics under the Graphics panel: limiting magnitude, sky brightness
  factor, visible-star estimate.

## Star point rendering

- Crisp core: point size grows sub-linearly with brightness and is clamped
  small (ordinary stars ≈ 1.5–2.5 device px); brightness is carried by
  intensity, not diameter.
- A minimal halo only for stars brighter than m ≈ 0.8.
- B−V colour kept, slightly desaturated.
- High-DPI: sizes in device pixels via `uPixelRatio` (unchanged plumbing).

## Night sky and darkness

- Night base (airglow + starlight floor) unchanged in colour, judged at the
  new exposure; target: deep navy, horizon slightly lighter than zenith,
  readable-but-dark water with tonal variation.
- No lifted grey, no full black: the moonless frame keeps its ~3 stops of
  structure between the sky floor and the darkest water.
- Banding: the sky dome's smooth gradients get a ±0.5/255 blue-noise dither
  in-shader if visible (verify at night; add only if needed).

## Moon presentation

- Disc: deliberately enlarged from the physical 0.53° diameter to 1.40° after
  the physical disc read as a tiny shader fleck. Real sun→moon geometry now
  drives continuous rough-sphere illumination across the face and terminator,
  replacing the softened binary mask that made partial phases look cut out.
  Detailed topography remains out of scope.
- Halo: `pow(mu,1400)·0.55` aureole kept (it is small); the broad
  `pow(mu,14)·0.016` glow reduced to a clear-sky value and scaled with
  phase; architected as a single uniform a future weather system can raise
  under thin cloud.
- Moonlight (directional light + sky in-scatter + glitter) scaled by
  `phase_fraction` through a steep curve (quarter moon ≈ 1/10 full), zero
  below the horizon (existing gate).

## Raft lamp

- One ship's oil lantern hung from a short davit on the bow quarter near the
  castaway: lashed timber post, arm and eye, bail handle, vented flared cap,
  barrelled glass globe inside four iron guard rods, brass oil font below.
  Procedural geometry, no assets. Hung rather than bolted, because a hung
  lamp stays upright while the raft rolls under it. The globe carries a low
  emissive that ramps with the flame — that, not the wick, is what reads as
  "lit" past a few metres, and it is what the sea reflects.
- Light: one `PointLight`, ~2100 K colour, physical decay, range-limited
  (~7 m); illuminates deck, sail foot, figure and near water only.
- **Daylight rolloff.** A real lantern is not dim at noon, it is *irrelevant*
  at noon — roughly 2 lux at two metres against daylight's hundred thousand.
  This scene spans ~8.5 stops noon-to-night where the real one spans eighteen,
  so a flame calibrated at midnight is far too strong at noon on the same axis.
  `Lamp.renderEmission` is `emission` scaled by `(ambient / nightAmbient)^-1.0`,
  and it is what the PointLight, the sail and the ocean all read. Measured:
  suppression 0.003 at +60° sun, 0.013 at +2°, 0.29 at −6°, 1.0 below −18°. So
  the lamp drowns and revives smoothly with the sky, and the on/off hysteresis
  is no longer what carries the transition — it is just the castaway striking a
  match inside a change the light was already making.
  **The flame's own emissive surfaces are deliberately NOT suppressed**: the
  glass and wick keep their radiance, because daylight does not dim a flame. A
  lamp lit at noon therefore still reads as lit if you look straight at it, and
  lights nothing — which is exactly what a lamp lit at noon does.
- **The water reads the lamp's 0..1 `emission`, not the PointLight's
  intensity.** Those are two renderers looking at one flame and they must be
  tunable apart; the sea's own scale is `uLampGain` (default 3.0, radiance at
  one metre, on `uSunPower`'s scale) with a Graphics-panel slider. The ocean
  windows its lamp radiance to zero at the same 7.5 m the PointLight uses, so
  "the refuge is the raft, not the sea" is structural, not tuned.
- **On the water the lamp is a light inside the BRDF, in three terms**, all
  exempt from the raft's contact darkening because the lamp is *on* the raft:
  1. **Glitter**, and this is the term that carries the whole look. Same GGX
     machinery as sun and moon, but with a per-pixel `L = normalize(flame −
     P)`: a near-field direction makes the half-vector change across every
     ripple, so each facet either catches the flame or does not, and the pool
     becomes a shimmering column broken by the swell. Sphere-light widening
     `α += r/2d` (r = the globe, 0.055 m) keeps the near field off fireflies.
  2. **Body**, on `bodySunGain` through Rw, plus a near-surface scatter
     reflectance (0.05) for the bubble-laden top centimetre and the spray haze
     over it, which is whiter than Rw's cobalt. Both ride the lamp's own
     Lambert, so they rake across wave faces instead of sitting flat.
  3. **Foam**, on `foamSunGain`. A bubble raft two metres from an open flame
     is the brightest thing the lamp touches, and it used to see mean sky and
     moon only.
- Water under the hull is gated out of all three (`smoothstep(0.8, 1.6, d)`
  from the raft centre), or the raft floats on a symmetric glowing disc — the
  giveaway that a light has no geometry attached to it.
- Superseded: the additive pool `color += tint · glow/(1+1.4d²) · N.y · 0.045`
  applied after the finished pixel. Its only spatial modulation was `N.y`, the
  one component of a water normal that barely varies, and at 1 m it measured
  40× the sea's own night radiance — a pedestal that erased the surface it was
  meant to reveal. That is the "dull and textureless" lit patch.
- The raft's contact darkening is now applied to each sky- and sun-driven term
  at source rather than to the finished pixel. The composite is linear in
  those terms, so the daytime picture is unchanged; what changes is that the
  lamp is no longer inside the multiply.
- Automatic: on when sun elevation < −5°, off when > −3° (hysteresis band;
  no flicker at the threshold). Presentation-time smooth ramp over ~2 s and
  a very slow ±4% flame variation.
- Emissive core is visible as a warm point in far cinematic views.
- Debug: auto / forced-on / forced-off and an intensity slider in the
  Graphics panel. Lamp state touches no canonical world state.

## Material response

- Sail: ambient gain 5.0 → 3.2; direct sun (via sunScale 8.0) now wins on
  sun-facing cloth at low sun (measured plan: amb/direct 5.8 → 1.34 at
  +2°). Backlit transmission term kept but multiplied by the sail's open
  fraction so a furled roll no longer glows like glass. Lamp light reaches
  the cloth through the standard light loop... (sail shader gains the lamp
  as a third analytic light: direction, colour, inverse-square).
- Wood/rope/figure: MeshStandardMaterial responds to the rebalanced lights
  as-is; the figure's albedo is raised slightly so it reads at midday
  without changing its silhouette reading at night.
- Spray/spindrift/overtop gains rescaled through the sunScale change so
  their absolute look is preserved.

## Shadows

Existing setup (none) is kept for this round except: enable a small
shadow map on the directional sun for the raft group only (mast/sail/figure
onto deck) if the measured cost at 1440p is negligible; otherwise record as
deferred. The lamp does not cast shadows.

## Performance budget

- No new render passes, no post-processing, no per-star CPU work (one
  shared transform + uniforms only).
- Added per-frame CPU: one cosine-weighted sky average (≤ 16 extra
  `skyRadiance` samples), the lamp controller, the star limit function —
  all O(1) allocations-free.
- Added per-pixel GPU: one `mix` and one dot in the water shader; net
  change ≈ zero (the deleted bend pays for the hemi blend).
- Targets: no regression at default view; 1440p smooth; 4K ≥ 30 fps on a
  modern desktop; mobile unchanged (quality tiers untouched).

## Visual invariants (tested or critic-checked)

1. Midday zenith visibly blue (pre-tonemap B/R ≥ 2.5) and deeper than the
   horizon; cloudless sky never grey.
2. Horizon legible without a hard seam at every camera altitude.
3. Ocean outside glitter predominantly blue; aerial view textured, not
   white.
4. Glitter localised, view-dependent, roughness-widened; sunset sun-facing
   path within a few counts of the protected reference.
5. Sun-facing sail at low sun visibly warm; ambient never suppresses it.
6. Star limiting magnitude monotone in sun depression; bright before faint;
   none in daylight.
7. Night dark but structured; lamp a small warm refuge; moon halo small;
   moonlight follows the real moon with phase-scaled strength.
8. All transitions continuous (no pops at sunrise/sunset/lamp threshold).
9. Graphics controls mutate no canonical world state.
