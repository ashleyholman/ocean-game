# Night Visibility, Part A — Scotopic vision

Built on `claude/coord-night-vision`, from master `ba087c1`. Part B
(moonlight) is **not** in this round; the spec orders it after Part A and
`moonPower` is untouched.

Read `NIGHT_VISIBILITY_SPEC.md` first — this is the report against its Part A,
not a replacement for it.

> **SHIPPING VERDICT, 2026-08-17.** Ash rejected this look and asked for it
> fully off, at 0%, rather than tuned down. That verdict is implemented:
> absent `?scotopic=` selects zero, the direct path cannot engage or precompile
> this pass, and display calibration is not loaded. The architecture below is
> retained only as the explicit `?scotopic=1` comparison arm.

> **AMENDED BY PART B.** Two things below are no longer true, both in the same
> place, and [NIGHT_VISIBILITY_PART_B.md](NIGHT_VISIBILITY_PART_B.md) has the
> measurement that changed them:
>
> - **The rod ramp no longer reads this pipeline's exposure meter.** It reads
>   `TimeOfDay.retinalLuminance`, modelled in real cd/m2. The anchors are still
>   the twilight definitions but they are now 5.0 and 0.008 cd/m2 rather than
>   measurements of our own meter, and the hand-rounded constant described under
>   "The rod ramp is derived from the twilight definitions" is gone. Raising the
>   moon proved a single compressed scalar cannot order two light sources: a half
>   moon came out at rod 0.399 and rendered the night DARKER than no moon.
> - **The daylight guarantee got stronger, not weaker.** -6 degrees is now an
>   exact knot of the model, so rod dominance is 0.0 above civil twilight by
>   construction rather than by a rounding.
>
> Everything else here stands, including the whole of the pass architecture, the
> material audit, and all three machine-checkable clauses.

---

## The diagnosis, in numbers

Every figure below came from a throwaway probe driving the real `TimeOfDay`
through the real tone curve, in the manner the spec's ground rules ask for.

| sun | metered adaptation lum | exposure | zenith sky (display Y / sRGB code) | horizon band | ambient-lit surface |
|---|---|---|---|---|---|
| +70° | 4.99e-1 | 1.60 | 0.319 / 154 | 0.725 / 226 | 0.324 / 155 |
| 0° | 1.02e-1 | 1.37 | 0.0588 / 68 | 0.455 / 182 | 0.0740 / 76 |
| −6° | 5.69e-3 | 3.49 | 0.0089 / 25 | 0.0491 / 62 | 0.0129 / 31 |
| −12° | 1.70e-3 | 4.83 | 0.0038 / 12 | 0.0120 / 29 | 0.0059 / 19 |
| −25° | 1.47e-3 | 4.99 | **0.0035 / 11** | **0.0107 / 27** | **0.0054 / 14** |
| full moon 40°, sun −25° | 2.75e-3 | 4.29 | — | — | — |

**A moonless night presents between sRGB codes 11 and 27.** On a laptop panel in
a lit room the screen's own reflected flare typically sits at 5–15% of panel
white. The entire night picture is underneath the reflection of the room. That
is the finding: the night is not artistically too dark, it is beneath the
display's noise floor.

For contrast, the lantern at the same hour:

| | display RGB | display Y |
|---|---|---|
| lamp glass globe | 0.981, 0.647, 0.402 | **0.700** |
| lamp flame core | 0.983, 0.673, 0.444 | 0.722 |

(Follow-up correction: the visible wick is now an unlit emitter rather than a
PBR surface receiving its own co-located point light. Its radiance is capped
before `TONE_BLEACH_HALF`, so the core remains brighter than the globe and the
2100 K warmth survives.)

---

## What was built

### Architecture: option (a), a full-screen post pass

`src/render/ScenePresentPass.ts`. The scene renders into a linear-HDR
`RGBA16F` target with MSAA and stencil, and one fullscreen shader then does, in
this order and only this order:

```
tone map  →  scotopic operator  →  sRGB encode  →  1-LSB dither
```

The spec chose (a) over a shared GLSL function before any code was written,
because (b) fails as a subtle mismatch between the ship and the sea. Taken as
directed.

**What makes the migration safe is three's own rule, not our diligence.**
`WebGLPrograms.getParameters` forces `toneMapping = NoToneMapping` and the
output colour space to the working (linear) space for *every* material whenever
a non-XR render target is bound. The instant the scene is aimed at the pass's
buffer, every material — hand-written and built-in alike — compiles with
`#include <tonemapping_fragment>` and `#include <colorspace_fragment>` expanded
to nothing. No material can opt out, and none can be forgotten. See the audit
below for the three things that do *not* follow from that rule.

### It is night-only, and that is what makes daylight exact

`rodDominance()` is **exactly 0.0** for every sun elevation above −6°. The pass
declines to engage when the operator would do nothing, and the frame then takes
`renderer.render(scene, camera)` — the original call, unchanged. Daylight is not
"nearly unchanged"; it is the same code path it was before this file existed,
and it costs nothing.

The buffer engages slightly *before* rod dominance leaves zero
(`SCOTOPIC_ENGAGE_RATIO = 1.35`, hysteresis at 1.75), so there is always a band
of twilight in which the pass is running and the operator is provably inert.
That band is where a path-change artefact would show, and it is where to look
for one.

Both program variants are compiled once at startup by a 1×1 warm render, so the
first dusk of a session does not stall on recompiling the whole scene.

### The operator

`src/scene/scotopic.ts`. Three effects, all keyed on per-pixel display
luminance and all scaled by a global rod-dominance weight:

1. **Sensitivity.** `lifted = SCALE · Y^(1/2)`, with `SCALE` *derived* — it is
   `KNEE_HI^(1−1/γ)`, the value that makes the lifted curve pass exactly through
   the knee. Blended out by a `smoothstep` between 0.004 and 0.08 display
   luminance. Both the blend weight and the value difference vanish at the knee,
   so the join is C1 and cannot draw a Mach band along an iso-luminance contour.
2. **Purkinje.** The rod signal is achromatic; 80% of the chroma goes, and what
   remains leans blue-grey.
3. **Acuity.** A four-tap cross at one device pixel, each tap clamped so it
   cannot exceed the centre by more than 0.02 — without the clamp it is a bleed
   rather than a blur, and a star or the rim of the lantern would smear into the
   sea. This also pays for itself by hiding the near-black quantisation noise the
   lift magnifies.

Measured effect at full rod dominance:

| | before | after |
|---|---|---|
| night zenith sky | code 11 | code 35 |
| night sea | code 14 | code 40 |
| horizon band | code 27 | code 48 |

**Why the lift helps even though it compresses code-space contrast.** It moves
sky and horizon from 13 codes apart to 8. Counted in codes that is a loss;
counted on the panel it is a gain, and the panel is what the requirement is
about. On a 250 cd/m² display carrying 15 cd/m² of room reflection, the unlifted
pair sit at 16.4 and 17.7 cd/m² — a Weber contrast of 8%, most of it drowned in
flare. Lifted they sit at 20.2 and 22.3 — 10.4%, and both are further clear of
the flare floor where the eye's contrast sensitivity is better. That arithmetic
is the argument for the operator's shape; if Ash's verdict is that it does not
hold, the shape is what should change.

### The rod ramp is derived from the twilight definitions

The naive route — calibrate to cd/m² — does not survive contact with this
pipeline, and the reason is worth recording so nobody retries it. Anchoring a
clear midday sky at 3000 cd/m² puts a moonless night at 8.7 cd/m² against
reality's 1e-3: four orders out, because the scene spans about 8.5 stops from
noon to midnight where the world spans eighteen. A single scale factor cannot
translate a compressed range into an absolute one.

What transfers is the *ordering*:

- **Civil twilight** ends at −6° and is defined as the last light in which
  ordinary outdoor activity needs no artificial illumination. That is the
  photopic end. This meter reads 5.689e-3 there.
- **Nautical twilight** ends at −12° and is defined as the point at which the
  sea horizon is no longer discernible — the eye has run out of cones. This
  meter reads 1.696e-3, within 15% of the 1.472e-3 moonless-night floor the lamp
  and the graphics tests already use.

Interpolated in log luminance, because adaptation is logarithmic.

The photopic anchor is that reading **rounded down**, to 5.6e-3, and the
direction is load-bearing rather than tidy: `smoothstep` reaches exactly 1 only
at its upper edge, so an anchor a hair *above* the civil-twilight reading leaves
1.0e-7 of rod dominance switched on through the entire day. Invisible, and
enough to make "daylight is bit-identical" false as stated. Costs about 0.05° of
sun elevation.

**A full moon lands at rod 0.643 without being told to.** A brighter night
meters brighter, so the observer partly returns to cone vision and the moon has
to carry more of the legibility itself. That coupling is why Part B must be
tuned *inside* this, and it is now a test.

### The switch

`?scotopic=0` off (the default), `?scotopic=1` on, `?scotopic=<0..1>` at partial
strength. Also a live slider in the graphics panel under "colour pipeline
(A/B)". **Live**, unlike `?noToe=1`, and the difference is structural: the toe
changes the tone curve's shader *source*, which is not part of three's program
cache key, so flipping it at runtime would leave compiled programs running the
old code. This moves a uniform. Both sides of the A/B are available in one page
load, which is what a legibility judgement needs.

Originally defaulted on. Ash's visual verdict supersedes that spec choice; it
now defaults **off at 0%**.

---

## The acceptance clauses

### 1. No linear radiance value changes anywhere — PASSES

The full suite is green: **1191 passed, 26 skipped, 95 files**. Every existing
radiance assertion passes untouched.

One test file was edited and it is not a radiance assertion:
`tests/runtime-architecture.test.ts` pins the exact body of the render
pipeline's `prepareFrame`, which now advances the observer's adaptation as well
as the terrain hook and the voyage clock. The pin was rewritten to slice out the
`prepareFrame` body and assert both the original ordering and that simulation is
still absent from it — which is what the pin is actually for. Stated plainly
rather than quietly widened.

Structurally: the operator's only inputs are values that have already been
through `CustomToneMapping`. Nothing upstream of the curve is reachable from it.

### 2. Daylight is bit-identical — PASSES, by construction

Two independent halves, both tested:

- `rodDominance(time.adaptationLuminance)` is **exactly 0** — `toBe(0)`, not
  `toBeCloseTo` — for every sun elevation from +90° down to −6°, asserted
  against the real meter rather than against the anchor constant.
- With rod dominance at zero, `scotopicPassEngaged()` returns false, so the
  buffer is never allocated and the frame takes `renderer.render(scene, camera)`
  unchanged. Asserted across the same sweep.

And separately, so the claim survives a future change to the ramp: the operator
returns its argument **bit-identically** (`toEqual`, exact) whenever rod
dominance is 0 *or* the pixel's luminance is at or above the knee. That is an
early return — `if ( w <= 0.0 ) return c;` — and there is a test pinning the
guard so it cannot quietly become arithmetic.

**The honest caveat.** This clause is exact *because* the pass does not run in
daylight. The pass itself is not bit-identical to the inline path, and could not
be: an HDR round trip changes half-float storage precision, the space MSAA
resolves in, and the space transparency blends in. Those differences are real,
they are confined to the hours the operator runs, and one of them has a visible
consequence — see the CrestSpray finding below.

### 3. The lantern is the brightest thing and keeps its 2100 K — PASSES

At the deep-night exposure (4.99), through the real tone curve, at rod
dominance 1.0:

- Both lamp surfaces — the glass globe at `emissiveIntensity 0.55` and the flame
  core at 5.0 — come out of the operator **bit-identical** to their input,
  asserted on both the RGB triple and on the two chroma ratios. They are far
  above the knee, so they never enter the branch.
- Lamp globe display Y = 0.700. After the lift, the zenith sky, the horizon sky
  and an ambient-lit surface are each still **below one tenth of it**. The
  refuge is still a refuge.

The knee at 0.08 is what buys this: 8.8× below the globe, 7.5× above the
horizon band. The lamp and the sea sit on opposite sides of it with an order of
magnitude to spare in both directions.

### 4. Legibility on a laptop panel in a lit room — **OWED, NOT CERTIFIED**

Not mine to call and not asserted anywhere. The arithmetic above says the night
sea moves from code 14 to code 40 and that this clears a typical room-flare
floor. Whether it *reads* is Ash's verdict, at his panel, in his room.

If it is too weak, the dial is `SCOTOPIC_LIFT_GAMMA`. If it is too strong or too
flat, the same dial the other way. If it reads lifted but muddy, that is
`SCOTOPIC_KNEE_HI` letting the operator climb too far up the range. The graphics
panel's slider scales the whole thing for a quick bracket before touching any
constant.

---

## The audit: every material that used to tone-map inline

Three's render-target rule handles the whole list at once, but the list is
recorded and pinned by a test (`knows exactly which materials tone-map inline`)
so a new entry cannot appear unnoticed.

| material | how it tone-maps | through the pass |
|---|---|---|
| `Ocean.ts` main shader | `#include <tonemapping_fragment>` | include compiled out; pass applies the curve once |
| `Ocean.ts` flat-profile stand-in | same | same |
| `SkySystem.ts` dome | same | same |
| `StarField.ts` | same | same |
| `TerrainSystem.ts` (patched into a standard material) | same, via string injection | same |
| `Raft.ts` hull + sail (`?debug=raft` only) | same | same |
| `OceanTemporalResolve.ts` copy | same | only runs when the pass declines |
| every `WorldPbrMaterial` / built-in on the ship | three's own chunk inside `meshphysical_frag` | same |
| `OvertopSpray.ts` (`SpriteMaterial`) | three's own chunk inside `sprite_frag` | same |
| `CloudDome`, `FoamField`, `SkyRadianceLut`, `WorldRadianceSource`, the temporal motion/occluder/resolve materials | never — offscreen simulation and probe targets, `toneMapped: false` | unaffected |
| **`CrestSpray.ts`** | **never — no include at all** | **changes; see below** |

Nothing in `src` writes its own sRGB encode (checked for `sRGBTransferOETF`,
`LinearTosRGB`, `0.4545`, `1.0/2.2` — no hits), so there is no double-encode
path.

Three things the render-target rule does not cover, each handled explicitly:

1. **Writes placed after `colorspace_fragment`.** These survive the rule and
   land on a raw linear radiance. See the next section — this was the round's
   real bug.
2. **Diagnostic readbacks.** A debug view, a category probe or a term sheet
   writes a measured quantity past the tone curve on purpose. The pass is
   switched off for those frames by `framePresentationCompatible()` in
   `main.ts`, the same predicate that already excluded the temporal resolve, now
   hoisted and shared.
3. **Blending and MSAA** now happen in linear HDR rather than on sRGB-encoded
   bytes. More correct, still a change, confined to the hours the pass runs.

---

## Findings

### 1. The sky dome's 1-LSB dither would have become static — FIXED

The coordinator's warning about the ocean's dither was right, and there were
**two** of them. `SkySystem.ts` carries the same post-encode 1-LSB dither as
`Ocean.ts`, written after `colorspace_fragment` — so three compiles tone mapping
and the encode out of the shader when it is aimed offscreen, but the dither
survives and adds ±1/510 of a **linear radiance**. The night zenith's linear
radiance is about 7e-4, so the dither would have been roughly **2.8× the sky's
own value**: the entire dome as static.

Both are now gated on a `uQuantiseDither` uniform, cleared by any presenter that
renders them offscreen, and the dither is applied once by the presenter at the
real point of quantisation — after the operator, which is where it belongs, and
now covering the sky's gradients as well as the sea's.

The second one was found by sweeping the tree, not by remembering it, so the
sweep is now the guard: `accounts for every surface that dithers past the
colourspace encode` walks all of `src`, finds every straight-line write after an
encode, and fails unless it is gated or belongs to a presenter. Verified by
mutation — removing the sky's guard turns the test red with the offending line
quoted.

### 2. `?oceanTaa=1` has been quietly doing this all along — FIXED in passing

The same bug already existed on the temporal path, which has rendered the scene
into a linear-HDR target since it was built. Anyone who ran `?oceanTaa=1` at
night was looking at ~26 sRGB codes of static on the sea. Fixed by the same
mechanism, and the temporal copy now dithers at its own output.

### 3. Crest spray has never been tone-mapped — REPORTED, NOT CHANGED

`CrestSpray.ts` is the one material in the presented scene with no
`tonemapping_fragment` include at all. It writes raw linear radiance,
additively, into a framebuffer holding sRGB-encoded bytes. That is a category
error and it predates this round.

It matters here because the pass fixes it as a side effect, and the fix is
visible at night:

- `uSkyLight` = desaturated ambient × 2.4 ≈ 2.6e-3 at −25° sun; `uSunLight` is 0.
- **Today**, additively onto the encoded canvas: up to +1.6e-3 in encoded units,
  about **+0.4 sRGB codes**. Crest spray is effectively invisible at night.
- **Through the pass**, additively in linear HDR and then tone-mapped and
  lifted: the same spray takes a patch of sea from code 40 to about **code 51**.

So breaking crests start to show at night. That is arguably correct — whitewater
lit by airglow should be the brightest thing on a dark sea, and +0.4 codes is
the artefact rather than the intent — but it is a look change nobody asked for
in this round, so it has not been compensated for and `uStrength` has not been
touched. Note that `uStrength = 2.1` was fitted by Ash's eye against
`SOUTHERN_OCEAN_ROUGH` in daylight, and **daylight is untouched**, so the fit is
intact where it was made.

The rejected pass now ships off, so this side effect is absent from the product
path and `CrestSpray` behaves as it did before Part A. `?scotopic=1` still shows
the bundled spray/observer delta as a historical A/B; deciding to tone-map spray
on its own would be a separate change.

### 4. The lamp's flame core bleach — RESOLVED IN FOLLOW-UP

The old core at `emissiveIntensity 5.0` was also a PBR surface centimetres from
its own point light. At night exposure those two paths entered the global
highlight bleach around 26× display white, producing (0.998, 0.991, 0.986) —
white. The follow-up makes the wick a tone-mapped unlit emitter, caps visible
surface burn independently of the full light-flux control, and lands it around
(0.983, 0.673, 0.444), luminance 0.722. Point-light and ocean-reflection energy
are unchanged.

---

## Performance: NOT measured, and what the cold machine must measure

**No number is quoted, because none was taken.** The machine was thermally
throttled and carrying several other agents; a figure from it would be worse
than none, because it would be quoted back later as if it meant something.

If the optional arm is reconsidered, the cold-machine pass must establish:

- **Scenario.** `?terrain=off`, desktop quality, a fixed camera, sun at −25°
  (moonless deep night — the only hours the pass runs), `?fixedDpr=` pinned so
  adaptive resolution is not walking the scale mid-measurement. A second run at
  a rough sea state, because crest spray now composites differently.
- **The A/B.** `?scotopic=1` against `?scotopic=0` at the same sun elevation, in
  the same page load if the harness allows it, paired and interleaved in blocks.
  `?scotopic=0` is the exact pre-round path, so the delta is the whole cost of
  the pass: one RGBA16F MSAA target's allocation and bandwidth, one full-screen
  draw, and five tone-curve evaluations plus the operator per pixel.
- **The instrument.** `src/render/GpuProfiler.ts`. `gl.finish()` lies in the
  browser pane. Headless Chrome with `--enable-gpu --use-angle=metal`; never mix
  a visible window into the comparison, it costs about 3×. Never read a
  tier-dependent number off the 854 px pane, which trips the mobile tier.
- **The budget.** A resolve-and-present pass at 1× DPR should come in around
  **0.3–0.6 ms**; the ocean shader alone is the most expensive thing in the
  frame at several ms. Over **1.0 ms** means something is wrong — most likely
  the MSAA resolve of a half-float target, in which case the first thing to try
  is dropping `samples` on the pass target and letting the ocean's own temporal
  path carry antialiasing at night.
- **What is already known to be free.** Daylight. The pass is not allocated, not
  resized and not drawn above −6° sun, so a daytime benchmark should measure
  *identically* to the pre-round build. That is itself a check worth running: a
  daylight delta means the bypass is leaking.

---

## What Part B inherits

- **`moonPower` is untouched.** Nothing in this round moved a linear radiance.
- **The moon now partly switches the observer back to cones.** Rod dominance is
  0.643 under a full moon at 40°, against 1.000 moonless, purely because the
  meter reads brighter. So the naive Part B ratio is now *doubly* self-
  cancelling: the exposure meter closes down, and the observer un-adapts. Expect
  to need more `moonPower` than either effect alone suggests, and measure the
  rendered result.
- **A moonlit night will read less blue and less soft than a moonless one**
  without any additional work, because desaturation and the acuity loss both
  scale with rod dominance. That is the correct direction and it is free.
- **`AMBIENT_ROLLOFF = 1.0` in `Lamp.ts`** was chosen to put the lamp's daytime
  reflection below clipping. The spec wondered whether Part A changes what
  "below clipping" means. It does not: the operator is inert in daylight and the
  lamp is above the knee at night. That question is closed.

## Original open items, now dispositioned

- **Legibility:** rejected by Ash; 0% is implemented as the shipping default.
- **Crest spray:** the bundled night brightening is absent with the pass off.
  Tone-mapping spray independently would be a new change.
- **Frame cost and deep-gradient banding:** relevant only if the optional arm is
  reconsidered; neither blocks the direct shipping path.
- **Display calibration:** subsequently built in Part C and then retired from
  the default UI with the operator it calibrates. It remains available to an
  explicit non-zero observer arm.
