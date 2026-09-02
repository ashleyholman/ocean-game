# World lighting and hull readability — design

**Status:** accepted direction for the world-lighting round; palette choice
pending Ash's A/B sign-off (§6)

**Date:** 2026-08-01

**Code baseline:** master `4237d9f`

**Provenance:** supersedes `WORLD_LIGHTING_ARCHITECTURE_DESIGN.md`, an
uncommitted draft in a Codex worktree that was reviewed but never landed. Its
central diagnosis was correct and is kept here; its process weight (budget
tables, source-symbol guard tests, frozen image thresholds) is deliberately
dropped. That worktree also holds an uncommitted `WorldEnvironment` prototype
that proved the diagnosis; the implementation may crib from it but should not
assume it.

---

## 1. Decision in one paragraph

Give the whole scene one camera-independent lighting source and give objects
the two correct convolutions of it: an L2 spherical-harmonics probe for diffuse
and a PMREM for specular, published together, at `environmentIntensity = 1`,
with the DirectionalLight sun converted to the same linear sky units. Delete
the ship-only `SkyProbe` and the two-colour hemisphere fill. Then — and only
then — re-judge the hull's paint, because the current topsides are ~3% linear
reflectance and **no correct lighting system renders 3% tar as anything but
near-black**. Ash has said the darkness is not the look he wants, so this round
includes a hull material re-spec (§6) with a recommended palette, approved by
eye on a controlled contact sheet under the new pipeline.

---

## 2. Why the hull has been so hard to light

Everything below is verified on master at `4237d9f`.

### 2.1 Three unit systems taped together

- The sky and ocean are authored in their own linear radiance units
  (`sunPower = 21`, `SKY_GAIN = 0.79` in `src/scene/TimeOfDay.ts` /
  `src/scene/shaders/lib.ts`).
- The DirectionalLight sun is **deliberately non-linear**:
  `pow(sunMag, 0.52) * 8.0` (`src/scene/TimeOfDay.ts:644-661`). The 0.52
  compression was tuned so the golden-hour sail didn't go mauve under the cool
  fill — a good beautiful lie for the raft era, but it means the sun-to-sky
  ratio changes with elevation in a way no single calibration constant can
  reconcile. Whatever balance you tune at noon is wrong at 4pm. This is the
  deepest reason every hull-lighting attempt has slid around with time of day.
- The ship adds a third system: a hand-authored 128×64 gradient probe at
  `envMapIntensity = 0.3` stacked on top of the hemisphere fill
  (`src/ship/Ship.ts:62`), self-described in its own comments as a hack whose
  honest fix is scene-wide.

### 2.2 Three.js couples what must be separated

Confirmed in the installed three r0.185.1 shader chunks:

- `getIBLIrradiance()` and `getIBLRadiance()` are both multiplied by the same
  `envMapIntensity`. One scalar controls diffuse fill *and* glossy reflection.
  Raising it to make the shaded hull readable also amplifies bright directional
  sky in the specular path — this is exactly the pale-pine flash the prototype
  round produced at intensity 3.
- Three's environment "irradiance" is **not a cosine integral**. It samples the
  PMREM's top mip — a GGX lobe, much narrower than cosine — along the surface
  normal. The sky map contains the bright circumsolar inscatter glow, so a hull
  plank whose normal sweeps toward the sun's azimuth picks up several times the
  irradiance a true cosine convolution would give. That is why the prototype's
  pale flashes survived disabling the direct sun and large roughness changes:
  the swing lived entirely in the coupled environment terms.

### 2.3 The exposure and the paint were never going to cooperate

Auto-exposure meters the sky alone, and established daylight is pinned at a
fixed plateau of 0.335 (`src/scene/TimeOfDay.ts:773`) — tuned, correctly, to
keep the sky off the ACES shoulder so midday stays deep blue rather than chalk.
The ship is a new, much darker client of that same exposure and never got a
vote.

Run the arithmetic: topsides `0x3a2f27` ≈ 3.1% linear reflectance. Under a
noon sun of ~7 (current units) at exposure 0.335, the **sunlit** face computes
to roughly 44/255; the shaded face under honest sky irradiance lands around
15–25/255. That is not a bug — that is what 3% tar *is*. Real tarred hulls
read through specular sheen, plank texture, and silhouette, never through
diffuse level. Architecture fixes the sheen and the stability; only a material
decision fixes "too dark", which is why §6 exists.

### 2.4 One more proven defect

The prototype's environment map sampled the sparse cloud cache, whose resident
pages are camera-driven. Rotating the camera could change the lighting source
itself. Lighting must be camera-independent; the visible sky may stay
view-driven, global light may not.

---

## 3. The system

```text
astronomy + sky LUT + cloud summary + ocean optics
                     |
                     v
      WorldRadianceSource (camera-independent, 128×64 HDR)
            |                        |
            v                        v
     diffuse L2 SH             specular PMREM
     (9 RGB coefficients)      (roughness mip chain)
            \                        /
             +--- one generation ---+
                       |
                       v
              WorldLightingFrame
             /         |         \
     ship/world PBR  custom ocean  custom sky
```

### 3.1 `WorldLightingFrame`

A slim read-only record published once per frame: sun and moon direction,
linear radiance and visibility (horizon + cloud gate); the indirect pair
(SH coefficients, PMREM texture, generation id); the exposure. Consumers stop
reaching into `ocean.material.uniforms` or receiving spread uniform bags.
`PlanetaryWorld` and the astronomy remain authoritative upstream — the frame is
a boundary, not a new owner of time.

### 3.2 Camera-independent source map

A 128×64 HDR equirect, refreshed at most once per second (immediately on a
hard edit like teleporting time):

- **Upper hemisphere:** the existing `SkyRadianceLut` plus the existing
  low-frequency cloud-aware lighting summary from `TimeOfDay` — for **every**
  direction. No sampling of camera-resident cloud pages, no cloud march, ever.
  Sharp cloud silhouettes stay a visible-sky feature; stable low-frequency
  cloud light on rough timber is the right trade.
- **Lower hemisphere:** closed-form water body + Fresnel-blended sky
  reflection from the already-derived ocean optics (water colour, aggregate
  slope variance). No wave evaluation. The analytic sun-glitter lobe is
  included behind a diagnostic toggle — if it dumps too much energy into the
  probe it gets corrected at the source, not on the hull.

The composite is texture reads and closed-form math. No new expensive work:
no cloud tiles, no `evaluateWaves`, no cube-camera scene capture.

### 3.3 Diffuse: L2 spherical harmonics

On refresh: async readback of the 128×64 half-float map (64 KiB), integrate
with equirectangular solid-angle weights into 9 RGB coefficients, publish
through one scene `LightProbe`. A cosine lobe integrates the whole hemisphere —
L2 is the conventional, correct representation, and it *structurally caps* the
angular swings that caused the pale flashes. The readback is trivial at this
size; if it ever shows up in the perf panel as a hitch, redesign then — do not
pre-build a GPU reduction.

### 3.4 Specular: PMREM

The same source prefiltered by the existing `PMREMGenerator`, double-buffered
so a new generation never mutates the texture in use. SH and PMREM swap
together as one generation.

### 3.5 One material adapter for ordinary surfaces

All ship (and future world-object) materials come from one `WorldPbrMaterial`
factory over `MeshStandardMaterial` (physical only where transmission or
clearcoat is genuinely needed). The factory applies a single
`onBeforeCompile` transform that:

- suppresses the PMREM-derived `getIBLIrradiance()` contribution; and
- routes the `LightProbe` SH result into `iblIrradiance`, so the physical
  shader keeps its multiple-scattering energy compensation instead of treating
  the probe as plain ambient (verified: in r0.185.1 `lights_fragment_end`
  merges `irradiance += iblIrradiance` for diffuse but passes `iblIrradiance`
  separately into `RE_IndirectSpecular` for the compensation term).

Containment: pin the three version, set `customProgramCacheKey`, and add one
test that fails loudly if the shader chunk we anchor on changes. All shader
surgery lives in this one module. No hull-specific light, gain, or exposure —
if the hull needs an exception, the system is wrong.

### 3.6 Linear sun

For object lighting, replace `pow(sunMag, 0.52) * 8.0` with a linear sun in
sky units: colour from the transmitted spectrum (as now), magnitude from
transmittance times one named constant, calibrated so the measured noon ratio
of direct sun irradiance to SH sky irradiance is ≈ 5–6 : 1 (clear-sky reality).
Measure the ratio from the live probe with the diagnostics — do not guess it.
Golden-hour warmth then arrives honestly through transmittance colour and the
exposure curve rather than by bending the light source.

Two knock-ons to check, not assume:

- the lamp/deck parity constant in `src/scene/Ocean.ts` (~line 261) was derived
  against the old DirectionalLight scale and must be re-derived;
- the raft still reads the same DirectionalLight and will shift. The raft is
  legacy and retiring; its look is explicitly not protected.

### 3.7 What gets deleted

- `SkyProbe` in `src/ship/Ship.ts` (the documented hack), including its 0.3
  intensity and caller-side gain.
- The scene `HemisphereLight` fill (`src/main.ts:458`) — the probe pair
  replaces it. (This is the "honest fix is scene-wide" the SkyProbe comment
  already promised.)
- Any `WORLD_ENVIRONMENT_INTENSITY`-style fudge. Production environment
  intensity is 1; the only conversion in the system is the named sun constant
  in §3.6.

### 3.8 Exposure policy

One scene exposure, applied once by the renderer — unchanged mechanism. But
the 0.335 day plateau is a look decision that predates the ship. After the
pipeline lands, A/B the plateau (0.335 vs ~0.45) with the ship in frame and
let Ash pick. The deep-blue-sky policy and the readable-ship policy are now
two clients of one number; that trade belongs to Ash, not to a calibration
script.

### 3.9 Shadows

Resize the sun shadow frustum (`src/main.ts:443`, currently ±4 m around the
raft) so the 15.5 m schooner casts and receives its own shadows. Ocean shadow
reception stays out of scope.

---

## 4. Non-goals

- No raft migration or raft acceptance work.
- No conversion of sky or ocean to stock materials; they consume the frame's
  values but keep their specialised shaders.
- No new cloud marching, wave evaluation, or cube-map scene capture in the
  environment path.
- No ship shadow on the water; no submerged-hull refraction.
- No ambient occlusion this round — full-sphere IBL will slightly over-light
  bulwark corners and under-deck nooks; noted as a future term, not blocking.
- No texture/grain work this round (§6.4 names it as the follow-on lever).

---

## 5. Verification

Kept deliberately small:

1. **Constant-environment test:** under a uniform white source, SH irradiance
   is orientation-independent at the expected value, and a mirror's PMREM
   lookup returns the source radiance. This pins the normalisations so
   diffuse/specular can never become two disguised look multipliers.
2. **Camera-invariance test:** with the world frozen, rotating only the camera
   leaves the source map checksum and generation unchanged.
3. **Term diagnostics:** selectable debug outputs for direct diffuse, direct
   specular, indirect diffuse, indirect specular, normals, albedo, and
   pre-tonemap linear. When something looks wrong, the answer is a term with
   an owner, not another blind multiplier sweep.
4. **Controlled lighting sheet:** one frozen world instant; a ship-only yaw
   sweep and a camera-only orbit; front/cross/back sun; reference objects
   (18% grey, ~80% white, dark glossy dielectric) beside the actual hull
   swatches. This is the sheet that answers "is it the source, the material,
   or the geometry".
5. The existing production contact sheet (textured seas, morning→sunset)
   remains the beauty gate, and the protected sky/ocean sunset look must
   survive unchanged.

Perf: the refresh is a 128×64 composite plus PMREM once per second. Watch it
in the existing perf panel; no pre-committed budget tables.

**Where these landed.** 1 and 2 are `tests/world-lighting.test.ts` and
`src/debug/worldLightingAudit.ts`. 3 is in `src/scene/WorldPbrMaterial.ts`
behind a `WORLD_PBR_DEBUG` define, selectable from the graphics panel: views
1–4 are the four `ReflectedLight` accumulators substituted before the tone
curve, so they are comparable with the beauty frame; views 5–7 are written past
it, so code/255 is the number. 4 is `src/debug/worldLightingSheet.ts` —
`shipViewer.lightingSheet()` for the three controlled rows and
`shipViewer.termSheet()` for the decomposition, both under one frozen instant
with the world clock AND the sky clock held.

One thing item 2 asserted turned out not to be true. `up >= side >= down` was
being checked as an invariant; measured hourly across a simulated day it fails
at three samples of twenty-four, all on the morning limb at 6°, 18° and 30°
solar elevation, where a vertical face aimed at the low sun collects the
circumsolar aureole and the horizon band at far better cosines than a
horizontal one does. Worst case measured: up 1.59 against side 2.06. That is
the sky being shaped like a sky. The audit now asserts only `up >= down` and
`side >= down`, which is the part the equirect convention actually pins, and
reports side/up as a number rather than a verdict.

---

## 6. Hull material re-spec

### 6.1 The decision being made

The current spec ("very dark tarred brown, ~3% linear") guarantees a
near-black hull under *correct* physics. The earlier "lighten it" experiments
failed because they ran under broken lighting — 15% albedo under no IBL and a
coupled fill produced a flat tan boat, and the palette took the blame. Under
the new pipeline, a mid-reflectance timber hull will shade honestly: bright
where sky and sun reach it, genuinely dark in shadow, warm at sunset. Ash has
said the near-black look is not what he wants, so the palette changes — by
his eye, from rendered options, not by decree of this document.

### 6.2 Recommended: Option A — oiled-timber expedition schooner

The reference is the Norwegian working schooner / Colin Archer rescue-boat
finish: oiled larch or oak topsides that read as warm golden-brown timber,
near-black tarred wales giving the hull its graphic line, a pale boot top
anchoring the waterline. Period-plausible for an expedition vessel, and built
to glow at the sunset benchmark.

| Region | Now | Proposed | Linear lum. | Roughness |
|---|---|---|---:|---:|
| topsides | `0x3a2f27` (~3%) | `0x8a6a46` oiled larch | ~16% | 0.42 |
| transom | `0x342a23` | `0x7d5f3e` slightly deeper | ~13% | 0.45 |
| wales | `0x261e19` | `0x332720` tarred, kept dark | ~2% | 0.38 |
| bootTop | `0x2b2521` | `0xd8d2c3` off-white stripe | ~65% | 0.55 |
| belowWaterline | `0xb9b3a4` tallow | keep | ~46% | keep |
| deck | `0x8d7a5c` | keep | ~20% | keep |
| trim | `0x9c7b3a` | keep | ~22% | keep |
| inboardBulwark | `0x6d3b2d` | keep | — | keep |

Why it works: at ~16% linear the topsides sit near photographic mid-grey —
diffuse light finally *carries form* (+2.4 stops over today; shaded planking
estimated around 70–100/255 instead of ~20). The tar story moves to the wales,
which stay near-black but glossy (roughness 0.38), so they read through sheen
exactly as real tar does. The white boot top gives the eye a waterline and a
scale cue in every sea state. Vertex jitter stays; the existing region split
already supports all of this with no geometry work.

### 6.3 Alternatives to render alongside

- **Option B — weathered tar:** topsides `0x5a473a` (~7%), roughness 0.45.
  Keeps the moody dark-ship identity at about +1.2 stops. If A feels too
  yacht-pretty, B is the honest middle.
- **Option C — painted topsides:** ivory/white `0xcfc9b8` above a dark sheer
  strake, in the polar-expedition tradition. Maximum legibility against a dark
  sea, very different character.

### 6.4 Approval path

Render current + A + B + C on the controlled sheet **under the new pipeline
only** — judging new paint under the old lighting is how the last round went
wrong. Ash picks by eye. Only after that verdict do `docs/ship/SHIP_SPEC.md`'s canonical
paint section and `shipGeometry.ts` change together. If the chosen hull still
wants more life afterwards, the next lever is texture — plank grain, salt
streaks, wear at the wales — which buys more readability per stop than any
further albedo change, and is its own round.

---

## 7. Implementation order

1. **Source + probes:** camera-independent `WorldRadianceSource`, SH + PMREM
   pair, atomic swap, `scene.environmentIntensity = 1`. Constant-environment
   and camera-invariance tests green.
2. **Adapter + migration:** `WorldPbrMaterial` factory, migrate every ship
   region, delete `SkyProbe` and the hemisphere fill, resize the shadow
   frustum.
3. **Linear sun:** §3.6, including re-deriving the lamp parity constant.
4. **Diagnostics:** term outputs and the controlled lighting sheet.
5. **Look decisions, in order, by eye:** exposure plateau A/B; then palette
   A/B/C (§6). Update `docs/ship/SHIP_SPEC.md` and `docs/graphics/GRAPHICS_TODO.md` after approval.

Steps 1–4 must not change the protected sky/ocean look; step 5 is where Ash's
verdicts live.

---

## 8. Risks

| Risk | Handling |
|---|---|
| `onBeforeCompile` breaks on a three upgrade | One module, pinned version, chunk-anchor test that fails loudly. |
| Bright horizon makes L2 SH ring negative | Clamp reconstructed irradiance ≥ 0 and validate against brute-force cosine convolution on a test map; fix the source if error is large. |
| Lower-hemisphere glitter over-lights from below | It's behind a toggle and visible in the term diagnostics; correct its energy at the source. |
| Raft look shifts when the hemisphere fill dies | Accepted; the raft is retiring and explicitly unprotected. |
| Lamp/deck night parity drifts after the sun change | The Ocean.ts parity constant is re-derived in step 3; night sheet re-checked. |
| Hull still reads flat after all of it | The remaining lever is texture (grain, streaks), scoped as its own round — not gain-tweaking. |

---

## 9. 2026-08-11 addendum — local vessel interreflection

The original round correctly produced open-world Sun, sky and sea irradiance,
but its non-goals left out short-range interreflection. The omission became
visible from the weather deck: a sun-facing red bulwark read as red while its
opposite mate fell nearly to black, and pale stair treads returned no light to
their vertical faces.

The correction is not a change to the source/probe pair. Participating schooner
materials receive one optional lower-hemisphere diffuse-bounce state through
`WorldPbrMaterial`. Its irradiance is derived from the existing sky mean and
direct Sun after reflection by the deck timber and an effective view factor;
the receiver applies the analytic lower-hemisphere cosine weight. It therefore
lands in `reflectedLight.indirectDiffuse`, remains visible to the term
diagnostics, and leaves the ocean, PMREM, exposure and global sun-to-sky ratio
unchanged.

Region ownership must follow transport, not the file that happens to build a
surface. The companionway coaming is generated with the interior assembly and
shares its oiled-oak colour, but every visible face stands above deck. It now
uses the exterior `deckJoinery` region so the cabin's reduced sky visibility
does not turn it black beside the quarterdeck stairs.

This is the first local-transport layer, not a permission for object brightness
gains. The exterior field is intentionally uniform and limited to the deck bowl
and fittings. Enclosed rooms still require spatial portal visibility and a
separate interior transfer solution.
