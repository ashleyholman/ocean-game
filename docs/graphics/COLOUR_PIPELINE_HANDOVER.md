# Colour pipeline round — handover

**Status:** landed, with six A/B switches still in place and four open items.

**Baseline:** `e2caac0`.

**How it started:** "it kinda reads like there's an instagram filter on it…
everything should read really vibrant, but it reads kinda greeny and washed out
and greyish and hazy."

There was. It was ACES, and most of what follows is the consequences of taking
it out.

---

## 1. What landed

| change | file | why |
| --- | --- | --- |
| ACES → hue-preserving max-channel curve | `scene/toneMapping.ts` (new) | ACES removed 20–30% of the chroma from every bright band and lifted green 11–18% against blue. The new curve compresses the PEAK channel and scales all three by one common factor, so ratios — hue and saturation — survive the shoulder exactly. |
| Deleted the 0.335 daylight exposure plateau | `scene/TimeOfDay.ts` | It existed only to hold the sky out of the ACES shoulder. One adaptation curve now runs all day. |
| `BETA_R_PROJ` hand-fitted → derived | `scene/shaders/lib.ts`, `tools/derive-sky-projection.mjs` (new) | The old value put the zenith at CIE x 0.212, y 0.173 — a violet no sky has ever been. Derived spectrally it lands x 0.246, y 0.253 against a published ~0.25, 0.25. |
| Sky chroma trim kept at 1.25 | `scene/colourPipeline.ts` | Removed as ACES scaffolding, then restored on Ash's eye. Defensible on its own terms: a three-band model is a projection of a continuous spectrum onto three primaries, and a modest chroma stretch corrects what that projection loses. |
| Sunset hold 0.30 → 0.75 | `scene/shaders/lib.ts` | Removing the chroma trim exposed a defect it had been masking: below sun +1° the sky turned BACK to blue with the disc still on the water (linear blue rose 0.18 → 0.22 → 0.30 across +1 → 0 → −1 while red fell). |
| Sky sampling 13 → 256 directions | `scene/TimeOfDay.ts` | **The biggest real bug found.** The old 13-sample set over-reported the whole-dome mean by **49% under heavy cloud and 154% under clear sky** against a 4000-direction reference. The sea reflects that mean, so the water had been reflecting a dome up to 2.5× too bright, with an error that moved with cloud cover. |
| L2 spherical-harmonic sky probe | `scene/skyHarmonics.ts` (new) | Replaces the single achromatic dome average as the rough reflection's convergent target. See §3 for the honest assessment of what it delivers. |
| Cloud cover 0.62 → 0.70 | `scene/SkySystem.ts` | 41% → 14% sky coverage. The grey water was reflected cloud, and the clouds were exonerated (mean radiance 0.74× the Lambertian ceiling; the 13% that exceeds it is all inside 45° of the sun — forward scatter). It was simply a cloudier day than the world wants as a baseline. |
| Water backscatter grey → spectral | `scene/oceanOptics.ts` | `bb` was `(0.00105, 0.00094, 0.00112)` — blue/red 1.07. Seawater's molecular backscatter follows λ⁻⁴·³², which is 3.63 across the profile's own band centres. Half of why clear water is blue is that blue is *scattered back*, and the model was scattering every colour back equally. |
| Shadow toe | `scene/toneMapping.ts` | Answers "the legacy ACES ocean was a deeper blue" — that was ACES's toe crushing water red to ~2/255. This is the same effect built to stop short of clipping. |
| Salt loading 1 → 0.25, spray brightness 1 → 2.1 | `main.ts`, `scene/CrestSpray.ts` | Ash's values, set against SOUTHERN_OCEAN_ROUGH. Both are global multipliers on values already scaled by sea state. |

Net on the near water, start of round to end: **(66, 98, 161) sat 0.588 →
(24, 76, 175) sat 0.864.**

---

## 2. Open items, ranked

### 2.1 Toe strength is unchosen — **do this first**

`TONE_TOE_STRENGTH` is 0.5, a number I picked for clipping safety, not one Ash
approved. Measured, it moves near-water red 34 → 24; ACES moved it to ~2. Ash's
verdict on the A/B was that he could not see `?noToe=1` change anything, which
is consistent with a 4% effect.

At 0.8 near-water red reaches ~13, and because the toe takes a FRACTION of the
darkest channel rather than a fixed offset it still cannot reach zero at any
strength. The dial is safe to push; it just needs an eye on it.

**Blocker:** the toe is a page-load switch (`?noToe=1`), not a slider, because it
changes shader SOURCE and three's program cache is keyed on material parameters,
not chunk text. Dialling it live needs a uniform plumbed through every material
(ShaderMaterials via their uniform objects, built-ins via `onBeforeCompile`).
That is the work to do if Ash wants to land this by feel rather than by
successive reloads.

### 2.2 The horizon band

Ash's original complaint: "there's this pretty thick band over the water that's
supposed to be realistic for some horizon effect, but it's overdone. And it eats
into the cloud layer."

Only half-addressed. What was fixed was MY contribution — a bleach term that
whitened it for no reason. The sky model's own horizon-to-zenith brightening
measures **4.90×**, and a spectral reference predicts **4.91×**, so the band is
physically right. Making it thinner is a deliberate departure from physics and
is Ash's call, not a bug fix. The levers, in order of bluntness:

- `AM_VIEW_CAP` (13.0) — the view-path air-mass ceiling. Lower thins the band.
- `MULTI` (0.175) — the multi-scatter fill, which also saturates near the horizon.
- The ocean's `hazeDistanceM` (9000) governs the water half of the band.

### 2.3 Sun-vs-ambient balance

Untouched. `sunLightIntensity = pow(sunMag, 0.52) * sunScale` in `TimeOfDay.ts`
is a deliberately non-linear sun, tuned for the pre-round pipeline. It means the
sun-to-sky ratio changes with elevation in a way no single calibration constant
reconciles — whatever balance is tuned at noon is wrong at 4pm.
`docs/graphics/WORLD_LIGHTING_DESIGN.md` §2.1 documents this as the deepest reason hull
lighting has never held still. The new display transform does not need the
compression; it is a good candidate for deletion, but it will move every lit
surface and needs its own A/B.

### 2.4 Cloud occlusion of the sun

Ash flagged this early — "the sun's handling behind clouds, that's a problem, I
know that's bad at the moment" — and it was never addressed. It is a
**single-ray** test from the camera (`cloudTransmittanceToward`), so the entire
world's key light hard-switches when one ray crosses a cloud, with no penumbra
and no spatial variation across a sea that extends to the horizon. Statistically
the model is sound (~79% of sun positions clear at 62% cover) — the defect is
that it is a point sample driving a global light. An area average over a few
kilometres of offset rays would soften it and be more correct.

---

## 3. Honest assessment of the SH probe

It works, it is tested, it costs ~0.1 ms, and **it does not visibly do
anything.** Measured across 5 sun elevations × 3 camera azimuths, flat-mean vs
probe differs by at most **6.0 levels mean / 36 peak** out of 255, and at sunset
— where it should shine — **0.4–0.6 levels.**

Two reasons, both discovered after the work: `probe(up)` is identical to the flat
mean by construction (that was a design goal), and the reflection is only ~6% of
a typical water pixel because Fresnel is ~0.06 at normal viewing angles.

It is kept because the sky sampling it required (§1, the 154% bug) is worth
having regardless, and the harmonic accumulation is **1.1% of that cost** —
1.63 ms for the 256 sky samples, 0.0185 ms for the SH reduction. It is free on
top of something the renderer wants anyway.

**Do not repeat the claim that it enables the sunset path on the water.** It
does not. That comes from `skySpec` (the directional gas-sky sample at the true
mirror direction) and the sun glitter, both of which predate this round.

---

## 4. Scaffolding to remove

`scene/colourPipeline.ts` and its six checkboxes in `debug/GraphicsPanel.ts` are
diagnostic. When the choices are settled:

1. Delete `colourPipeline.ts` and the `colour pipeline (A/B)` section of the panel.
2. In `shaders/lib.ts`, fold `uSkyProj` and `uSkySaturation` back to `const`.
   **This is the only standing cost of the switches** — as uniforms the compiler
   cannot constant-fold `BETA_R_PROJ`.
3. Drop `LEGACY_FLAT_BACKSCATTER` from `oceanOptics.ts` and
   `Ocean.publishWaterBodyColour`.
4. Drop the `flatProbe` path from `skyHarmonics.ts` and its test.
5. `?legacyColour=1` and `?noToe=1` go with them.

`debug/dayLadder.ts` and `tools/derive-sky-projection.mjs` should STAY. The
ladder is how any future lighting change gets judged across the day, and the
derivation tool is the provenance for `BETA_R_PROJ`.

---

## 5. Measurement traps — read this before benchmarking

Four things burned real time this round and produced claims that had to be
retracted. All are environmental, none are bugs in the game.

1. **`gl.finish()` does not force GPU completion in the Claude browser pane.**
   A 3.59 Mpx frame and a 0.92 Mpx frame both timed at 0.323 ms. Any "the draw
   cost is unchanged" conclusion from that method is worthless. Use the app's own
   `EXT_disjoint_timer_query` profiler (the perf panel) or measure in real Chrome.
2. **Vite can serve one module twice.** `./colourPipeline` and
   `/src/scene/colourPipeline.ts` resolved to two module records with separate
   state, so a harness flipping a flag flipped a copy nothing read. `main.ts` now
   exposes the app's own instance as `__drift.colourPipeline` — use that, never a
   fresh dynamic import.
3. **`stepSimulation` re-uploads most ocean uniforms every frame.** Overriding a
   uniform and then calling `stepSimulation` silently reverts it. Override AFTER
   the step, render only. `uWaterRw` is the exception — it is NOT re-uploaded, so
   zeroing it persists and will poison every later reading in the session.
4. **The browser pane must be laid out before any measurement.** With the pane
   hidden, `innerWidth` is 0 and the drawing buffer is 1×1. Take a screenshot
   first.

---

## 6. Performance — open

A regression was found and fixed: `PROBE_SLICE` was 64 directions per frame,
costing **+0.447 ms** of CPU in `stepSimulation` against the 13-sample set it
replaced. At 16 per frame the step share is **0.640 ms against master's 0.658** —
level, at full 256-direction accuracy, with 270 ms of latency on a reflection
target whose scene changes over minutes.

**Not closed.** Ash reported ~40 ms frames, which is ~25 FPS and much larger than
0.45 ms explains. Two things are unresolved:

- The claim "the GPU draw is unchanged" rests on the broken `gl.finish()` timing
  in §5.1 and **should be treated as unverified.** Candidates for a genuine
  per-pixel cost: `uSkyProj`/`uSkySaturation` becoming uniforms inside `GLSL_SKY`
  (which `CloudDome`, `SkyRadianceLut` and `Ocean` all include), and the
  `uSkySaturation` branch adding a `pow(vec3)` the compiler could previously
  eliminate. Removing the switches (§4) resolves both by construction.
- The adaptive-resolution controller was **not** the cause and was not modified.
  Its thresholds are absolute floors — nothing gives up resolution above 50 FPS —
  so a sub-millisecond delta at 8.5 ms frames cannot make it step down. But it
  does amplify: once strained it steps 0.25 and then refuses to climb back until
  a retry timer expires (8 s, doubling to 120 s), because under vsync there is no
  signal for how much headroom is left. A few strained warm-up windows can park a
  session below native long after the cause has gone. Worth surfacing `cap`,
  `provenExpensiveCap` and seconds-to-retry in the perf panel — currently you can
  see that resolution is low but not why.

---

## 7. Things only Ash can settle

- Toe strength (§2.1).
- Whether the horizon band is thinned against the physics (§2.2).
- Whether cloud cover 14% is the right baseline, or whether it should vary by
  weather rather than being one constant.
- Whether the sea wants to be deeper still. The measured near-water red is 24;
  ACES's was 2. There is a lot of room between those, and only one of them
  clips.
