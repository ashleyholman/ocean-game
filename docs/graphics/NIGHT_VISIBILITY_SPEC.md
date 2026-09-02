# Night Visibility & Moonlight — Spec and Handover

Two coupled pieces of work, deliberately written as one document because doing
either alone will produce the wrong numbers for the other.

> **FINAL VISUAL VERDICT, 2026-08-17.** This document records the reasoning that
> produced Parts A–C, but Ash rejected Part A's look and chose 0% as the shipped
> default. That is now implemented. Part B's moonlight remains: re-audited on
> the direct-display path, it moves the representative sea from sRGB 17 to 52
> while retaining the 12.14× ambient gate. Part C is only available when a
> non-zero `?scotopic=` opts into Part A; it has no effect on the product path.

**Branch discipline.** This must build on `claude/lantern-water-lighting-issue-e23aa0`,
not on `main`. That branch carries the airglow cut, the raised exposure ceiling,
the lamp's daylight rolloff and the detail-octave change, and every measurement
below was taken *after* those. Starting from `main` will reproduce a night that
is 2 stops brighter than the one this spec describes and none of the numbers
will mean anything. Branch from it, do not merge it in halfway.

---

## Background: what changed, and what it exposed

The lantern round deepened the night by cutting the airglow floor
(`NIGHT_BASE_GAIN = 0.25` in `shaders/lib.ts`, mirrored in `TimeOfDay.ts`) and
raised the auto-exposure ceiling 2.3 → 3.0 so the meter could follow it down.
That was the right move and it is staying. It also surfaced two consequences
that this round exists to deal with.

**1. The night may now be too dark to play in.** Not too dark *artistically* —
the intent is "a hand-sized warm refuge inside an enormous dark ocean" and the
deepened night serves that. Too dark *practically*, on an uncalibrated laptop
panel in a lit room. This is a real risk and the round should treat it as the
primary requirement, not an afterthought.

**2. Moonlight is inert.** Measured on `TimeOfDay.ambientRadiance`, a **full
moon at 40° elevation changes the night ambient by 1.8×** (it was 1.21× before
the airglow cut). Reality is 100–300×. Moonlit and moonless nights currently
look nearly identical, which is the most obviously wrong thing left in the sky.

The unifying frame for both: **the pipeline models the light and the camera but
not the observer.** Real nights are legible not because the world is bright but
because the eye adapts and switches to rods. Every compression that adaptation
would have done has instead been smuggled into source radiance values — which is
exactly why the airglow floor was four times too high and doing the moon's job.

---

## Part A — Scotopic vision (the night-visibility fix)

> **BUILT** on `claude/coord-night-vision`. See
> [NIGHT_VISIBILITY_PART_A.md](NIGHT_VISIBILITY_PART_A.md) for what landed, the
> measurements behind it, the proof for each machine-checkable acceptance
> clause, and what is still owed — chief among it the legibility verdict, which
> was Ash's and is now **rejected**. Option (a) was taken as recommended and is
> retained as an opt-in lab arm; it defaults to zero.

### Requirement

Make a physically dark night legible on ordinary consumer displays **without
adding light to the scene**. Nothing in this part may change a linear radiance
before tone mapping. If it does, it is the wrong fix and it will undo Part B.

### Approach: model the observer

Below roughly 0.01 cd/m² equivalent, human vision is rod-dominated. Three
consequences, all of which help here:

1. **Sensitivity** rises by orders of magnitude — this is the visibility win.
2. **Colour vanishes.** Rods are monochromatic and peak bluer than cones (the
   Purkinje shift), so dim scenes desaturate toward blue-grey. This is why
   night reads blue in film and in memory, and it means the boost is *not*
   colour-neutral — desaturating is part of the effect, not a side cost.
3. **Acuity drops.** A slight loss of fine detail in the deepest shadows is
   correct, and conveniently hides near-black quantisation noise.

Implement as a **post-tonemap operator keyed on local luminance**, so it lifts
only what is dark. The lamp, the moon's glitter path and the stars stay
photopic and keep their colour and their dominance; the sea comes up off black.
That selectivity is the whole point — a global lift would flatten the very
day/night range the lantern round just bought.

### Where it goes

The ocean and sky already run `<tonemapping_fragment>` then
`<colorspace_fragment>` inline (see the tail of `Ocean.ts`'s fragment shader),
and the ocean adds a 1-LSB dither at the point of quantisation. A scotopic
operator must sit **after tone mapping and before the colourspace encode**, and
it must be applied consistently to every surface or the raft will detach from
the sea it floats on. Two options, and the choice is the main architectural
decision of this part:

- **(a) A full-screen post pass.** Correct by construction — everything is in
  the same buffer, so nothing can disagree. Costs a render target and a pass,
  and the existing inline tonemapping has to move into it.
- **(b) A shared GLSL function** called by every material's tail, matching how
  `skyRadiance` is already shared between the dome, the water and the CPU. No
  extra pass, but it must be added to the ocean, the sky, the sail, the spray,
  the stars *and* the standard materials on the raft — and a material that
  forgets it will glow wrongly against everything else.

Recommendation: **(a)**, despite the cost. The failure mode of (b) is a subtle,
hard-to-attribute mismatch between the raft and the sea, and this codebase has
already paid for that class of bug once with the sky's CPU/GPU mirror.

### Acceptance

- No linear radiance value changes anywhere. Verifiable: the graphics tests'
  existing radiance assertions must pass untouched.
- A moonless night is readable — the swell's shape legible, the horizon
  findable — on a laptop panel at default brightness in a lit room.
- Daylight is bit-identical. The operator must be inert above its threshold.
- The lantern still reads as the brightest thing at night and keeps its 2100 K
  colour; it must not be desaturated along with the sea.
- No banding in the deep sea. Re-check the existing 1-LSB dither, which was
  tuned against a night two stops brighter than the current one.

### Historical requirement, superseded with Part A's rejection

> **BUILT, THEN RETIRED FROM THE DEFAULT UI** — see
> [NIGHT_VISIBILITY_PART_C.md](NIGHT_VISIBILITY_PART_C.md). It
> is not the "raise until barely visible" form this paragraph asks for: that
> yields a preference, and a ladder of patches with one click yields a
> measurement. With a non-zero `?scotopic=`, Settings -> Display. Verified in
> the browser: the night sky reads sRGB 15, 29 or 49 on one frozen frame
> depending on the floor measured. No player action is required at the shipped
> 0%; there is no active lift to calibrate.

A **player brightness calibration** in settings, with the standard "raise until
this shape is barely visible" target. Everything above assumes a display, and
you cannot know the player's panel or their room. Scotopic modelling makes the
night legible on a *reasonable* display; calibration is what makes the promise
hold on all of them. This is the only part of this document that addresses the
literal question "on all screens and devices".

That was the requirement before the visual verdict. It is preserved below as
design history, not repurposed into a daylight-changing global brightness
control after the only intended consumer was rejected.

---

## Part B — Moonlight

> **BUILT** on `claude/coord-night-vision`, after Part A as this document
> ordered. See [NIGHT_VISIBILITY_PART_B.md](NIGHT_VISIBILITY_PART_B.md).
> `moonPower` 0.070 -> 1.0, measuring **12.14x** on `ambientRadiance` against
> the 1.79x below. The couplings this section warns about were all real; a
> fourth one it does not mention — the seven-sample ambient fill point-sampling
> the moon's aerosol lobe — would have made the whole scene's fill pulse
> fourfold as the moon tracked, and is fixed. What is still owed is Ash's eye,
> and the moonglade is the item most likely to be wrong.

### The measurements

Taken with `TimeOfDay` at −25° sun, after the airglow cut:

| | ambient (lum) | vs moonless | reality |
|---|---|---|---|
| no moon | 1.47e-3 | 1.00× | — |
| half moon, 40° | ~1.5e-3 | ~1.1× | ~10× |
| full moon, 40° | 2.7e-3 | 1.8× | 100–300× |

`moonPower = 0.070` in `TimeOfDay.ts` is the primary dial.

### The couplings — do not move `moonPower` alone

- **`moonSpecularGain = 3.5`** (`oceanOptics.ts`) sets the moon's glitter path
  on the water and was calibrated *against the current `moonPower`*. Raising
  one without the other will either blow the glitter path out or leave it
  invisible. They move together.
- **`limitingMagnitude`** already carries a moon penalty (measured 6.20
  moonless → 5.00 full moon). A physically brighter moon should wash out
  substantially more sky, so the penalty wants re-deriving, not just re-tuning.
- **The exposure meter** reads ambient, so a brighter moon closes the exposure
  down and partially self-cancels. Expect to need more `moonPower` than the
  naive ratio suggests, and measure the *rendered* result rather than the input.
- **Part A interacts directly.** If the eye adapts, the moon can be physically
  weak and still read; without Part A, the moon has to carry legibility itself.
  This is why the two are one document.

### Sequencing

**Do Part A first, then tune the moon inside it.** Tuning the moon against an
unadapted pipeline and then adding scotopic vision means tuning it twice, and
the second pass will fight the first.

### Acceptance

- A full moon changes the night ambient by at least an order of magnitude,
  measured on `ambientRadiance`, not judged by eye.
- Moonlit and moonless nights are unmistakably different at a glance.
- The moon's glitter path on the water stays a path, not a blown sheet.
- Star visibility under a full moon drops in a way that survives comparison
  with a real photograph.

---

## Ground rules carried from this round

These are conventions the lantern work was held to, and they should carry over.

- **Measure before tuning.** Every number above came from a throwaway probe
  test driving the real `TimeOfDay`. "It looks too bright" is a starting point;
  a ratio against a physical reference is an argument.
- **Derive rather than choose, where a source exists.** The lamp's gain on the
  water is `FLAME_INTENSITY × OCEAN_PER_DECK_IRRADIANCE` because one flame
  cannot be two brightnesses. Prefer the same for the moon: it should be one
  moon, seen by the dome, the ambient fill, the water and the exposure meter.
- **Put compensation where the cause is.** The airglow floor was doing dark
  adaptation's job in the wrong place and broke the moon and the lamp as a
  side effect. Scotopic vision is the *right* place for it.
- **Record the tunables and their derivation** in `docs/graphics/GRAPHICS_TODO.md`, including
  what was measured and what was merely reasoned. There is a template there
  from this round.

## Open items inherited, not yet closed

- The frame cost of `detailOctaves: 5` (desktop) has **never been measured on
  real hardware** — it was reasoned from the Nyquist fade and could only be
  checked in a backgrounded browser tab, where frame pacing is forced and fps
  readings are meaningless. Whoever next has a warm desktop session should
  check it. Six octaves is the next step if it is cheap.
- The lamp's foam term has not been seen at a sea state that breaks a whitecap
  within a few metres of the raft.
- `AMBIENT_ROLLOFF = 1.0` in `Lamp.ts` was chosen to put the lamp's daytime
  reflection below clipping; a compression-consistent derivation argues for
  ~0.5. The visual requirement won. Worth revisiting if Part A changes what
  "below clipping" means.
