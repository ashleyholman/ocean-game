# Ocean look round — handover

**Status:** landed and squashed to a single commit, `ee69193`, on top of
`293e66f`. Every control below is live in the ocean lab and every one restores
its previous behaviour at 0 or 1.

**Baseline:** `293e66f`.

**How it started:** "we've got the large structure fine… what I'm not seeing is
like 30cm sharp peaks or 60cm sharp peaks. those pointy crests at the small
scale."

It ended in the lighting. Most of what looked like ocean problems were not.

---

## 1. What landed

| change | file | why |
| --- | --- | --- |
| Mid-band detail shift | `scene/Ocean.ts` | The 0.2–1.5 m band had no machinery for a sharp crest. The 0.55/octave falloff against a √5 frequency step grows drawn *slope* 1.23×/octave, putting 64 % of drawn detail at 21 cm and below. Energy-neutral: gains are renormalised every frame, pinned by `tests/detail-octave-gains.test.ts`. |
| Body radiance chain re-derived | `scene/oceanOptics.ts` | ~2× over-lit by two errors. Mean-radiance→irradiance shipped at 5.6 where it should be π, and the 1/Q irradiance→radiance step was **never applied at all**. Measured against a reference photo the blue channel ran 1.5–2.5× hot. |
| `Ocean.applyOptics` + lab A/B | `scene/Ocean.ts`, `debug/OceanLab.ts` | Live optics patching. The hull's reflected sea reads the same profile object — one water, one brightness. |
| Wave sky occlusion | `scene/Ocean.ts` | The sea never occluded its own sky; only the hull did. Crest and trough were lit by an identical hemisphere, so the near field was a flat wash — a 5–95 luminance spread of **10 levels against 79** in the photo. |
| Lognormal sun sparkle | `scene/Ocean.ts` | See §2 — the round's best finding. |
| κ 0.62 → 0.92 | `scene/Waves.ts` | Drawn detail consumed only ~45 % of the unresolved slope band; the rest went to a lobe that cannot make a highlight. Now consumes essentially all of it. Test pins the *intent* (share 0.8–1.35), not the constant. |
| Below-horizon reflection block | `scene/Ocean.ts` | `R.y = abs(R.y)` is a sampling guard, but it silently handed every downward ray the bright horizon band. |
| Grazing roughness lift | `scene/Ocean.ts` | See §2. |
| Sky diffuse fill scale | `scene/TimeOfDay.ts` | Key-to-fill measured **4.8:1** where a clear day is 7–10:1. Applied once at `ambientRadiance` so every fill consumer moves together; `hemisphericRadiance` and the SH probe deliberately untouched (those are the *mirrored* sky). |
| Daylight exposure lift | `scene/TimeOfDay.ts`, `main.ts` | See §2. |
| Sky radiance trim | `scene/shaders/lib.ts`, `scene/SkySystem.ts` | Gives the sky headroom below display white so the exposure lift can raise sunlit surfaces without bleaching it. |
| Water contrast | `scene/Ocean.ts` | Hue-preserving luminance power curve, applied *before* glitter and foam so neither is crushed or blown. |

---

## 2. The three findings worth keeping

**Sparkle is a resolved-facet phenomenon, not a statistical one.** There was no
midday sparkle at *any* lobe width. Mirroring an overhead sun needs facets
tilted ~19°; the drawn surface carried ~4°. The statistical lobe standing in
for the missing facets peaks *below display white* at midday's 2 % Fresnel — at
4pm the same lobe sees 30 % and reads as a brilliant streak. That single
Fresnel factor is the whole difference. Proven **both ways** before building
anything: narrowing the lobe made it *worse* (less energy that far off-axis),
raising drawn detail made sparkle appear immediately. Fixed with a lognormal
multiplier `exp(a·g − a²/2)`, whose expectation is exactly 1 — the same energy
scattered into rare brilliant points, no photon invented. GGX returns the
**mean**; the eye reads the **variance**.

**The distance became a sky mirror *because* we stopped drawing its
roughness.** Schlick ran on the macro normal, and the Nyquist fades flatten
that normal with range, so `NdV → 0` and Fresnel → f90. The rougher the real
sea, the more mirror-like ours got. A real sea at grazing shows wave *faces*
tilted toward the viewer, not a plane; lifting the incidence cosine by the
surface's own roughness gave the horizon its hard edge.

**The auto-exposure cannot make daylight bright, and no retune fixes it.** It
sits at 4.78 at noon while a moonless night *demands* ~22 and is clamped at
5.2 — both ends of the day pinned near one number. `E = K·lum^-a` is monotone
decreasing in luminance, so the meter always gives the **darker** scene more
gain; "brighter noon, unchanged midnight" asks it to invert. So the daylight
lift is a **look policy applied outside the meter**, ramped by sun elevation
and exactly 1 below the horizon. The meter's MIN:MAX ratio is a contract and a
test pins its `day < sunset < night` ordering — the first attempt folded the
lift inside and broke that test, correctly.

---

## 3. Rejected — do not retry without new information

- **Crest skew via `max(1 + s·v, 0)`.** The clamp drives whole low-value
  regions to zero gradient: flat dead patches ringed by steep edges. Ash:
  "warts", "lumpy cake mix". Ships at 0; a version that survives needs a
  monotone warp with **no clamp**.
- **Anisotropic detail sampling.** Needs a continuous-angle matrix, which
  breaks the integer-matrix exact-wrap contract that fixed detail popping.
  Wind-aligned directionality must come from real residual-only Gerstner rungs.
- **Narrowing `reflectLobeRatio`.** *Brightens* the mid-field — near grazing
  the sharper mirror points at the bright low sky.
- **Lowering `TONE_SHOULDER` to 0.70.** Nearly invisible in the sky, plainly
  costs sail white. Left at 0.80 behind `?shoulder=`.
- **"Fix the sky exposure so the water follows."** Water-to-sky blue ratio in
  linear light is 0.31 for both our render and the photo — *identical*. The
  water was correctly proportioned; the lever was `bodySunGain`. Don't
  "fix" the part the user likes when a direct lever exists elsewhere.

---

## 4. Shipping values — these are Ash's, and several depart from the derivations

| control | value | note |
| --- | --- | --- |
| Sky radiance trim | 0.60 | **Paired with the exposure lift.** |
| Daylight exposure lift | 2.00 | 2.0 is only possible *because* the sky is trimmed. |
| `ambientIrradianceGain` | 6.00 | **Above π**, buying back the fill the sky trim took. |
| Sky fill | 0.80 | Derivation gave 0.60 against a full-radiance sky. |
| `grazingRolloff` | 1.00 | Maximum. |
| Water contrast | 1.15 | |
| `bodySunGain` | 0 | Ash's call over radiometry; the sun's water contribution belongs in the glitter. |
| Crest skew | 0 | See §3. |

**None of these means anything alone.** Sky radiance ↔ exposure lift ↔ ambient
gain are one interlocking set; re-tune one and you must re-judge the others.

---

## 5. Open items

1. **Fuzzy afternoon horizon.** The grazing lift sharpened it, but midday/
   afternoon is still softer than evening. Hypothesis (untested): at noon the
   sky's horizon band is bright enough that the reduced Fresnel still shows
   through, where at sunset the low sky is dim and the cut goes hard.
2. **No pale aerosol band above the horizon.** A real sunny sky has a
   near-white band from aerosol scatter; ours stays saturated blue to the
   waterline. This is the *inverse* of Ash's "too much red" hunch but probably
   the same thing he was sensing. Likely the real remaining "bright day" cue.
3. **Crest skew without the clamp.** A monotone warp of the noise value that
   redistributes slope smoothly rather than subtracting it.
4. **Independent sky-dome gain.** `uSkyGainTrim` currently moves the drawn dome
   *and* the ocean's reflection together — `skyRadiance()` is the single source
   of sky colour and the uniform object is shared between the sky and the ocean
   by construction. Separating them means giving the two materials their own
   copies. Deliberate for now: a sea mirroring a sky other than the one
   overhead is a worse defect than a sky slightly too bright.
5. **Sea-on-sea sun shadowing.** Still absent. The wave occlusion added here is
   hemispheric (sky) only; the sun is gated by `directSunVisibility`, whose
   shadow map is off for the ocean.

---

## 6. Verification debt — read before trusting the numbers above

Percentile measurements in §2 came from live wave-field state and from decoding
the reference photograph, both reliable. **The visual before/after judgements
came from screenshots by eye, not measured pixels**: the browser pane's
`readPixels` returned black frames repeatedly, and rAF stops entirely whenever
the pane is backgrounded, so several A/B captures failed silently and were
discarded rather than reported.

Two traps worth knowing for anyone measuring here:

- **The pane is 854 px wide, which trips `isSmallScreen` → `OCEAN_QUALITY_MOBILE`**
  (3 detail octaves, not desktop's 5; 160×160 rings, not 288×288; ~77 % of
  native pixels). Never read a tier-dependent number off a pane screenshot.
- **Freezing the world clock leaves the lighting stale.** `setPaused(true)` or a
  zero clock rate stops the sun from updating, so a "midday" capture can be lit
  by whatever elevation was last integrated. Set the time with the clock
  *running*.

One test run mid-round showed a single failure that did not reproduce across
four subsequent full runs. It was never pinned down.
