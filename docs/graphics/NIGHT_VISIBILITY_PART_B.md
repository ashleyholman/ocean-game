# Night Visibility, Part B — Moonlight

Built on `claude/coord-night-vision`, on top of Part A
([NIGHT_VISIBILITY_PART_A.md](NIGHT_VISIBILITY_PART_A.md)). The spec ordered
Part B after Part A so the observer model would exist before anyone touched the
light. It was the right order, and not for the reason anyone expected.

> **RE-AUDITED AFTER PART A'S REJECTION, 2026-08-17.** Scotopic vision now ships
> at 0%. Part B's primary calibration is linear-radiance based and still measures
> 12.14× on `ambientRadiance`. On the actual direct-display path the sea measures
> sRGB 17 moonless and 52 under a full moon at 40° — a 35-code separation, larger
> than the optional observer arm's 40 → 59. `MOON_SKY_POWER`, direct moonlight,
> glitter gain and star penalty therefore need no compensating retune. The rod
> columns below are retained as diagnostics for `?scotopic=1`, not as shipping
> presentation.

---

## The clause, and the number

> "A full moon changes the night ambient by at least an order of magnitude,
> measured on `ambientRadiance`, not judged by eye."

**Measured: 12.14×**, at −25° sun, full moon at 40°, against 1.79× before.
Gated in `tests/moonlight.test.ts`.

The whole night, measured through the meter and tone curve, with the optional
observer result after the slash:

| state | `ambientRadiance` | ratio | exposure | optional rod | zenith sky (shipping/optional sRGB) | sea | lamp | limiting mag | moon direct |
|---|---|---|---|---|---|---|---|---|---|
| moonless | 1.471e-3 | 1.00× | 4.99 | 1.000 | 11 / 35 | 17 / **40** | 218 | 6.20 | 0.000 |
| quarter, 40° | 1.727e-3 | 1.17× | 4.81 | 1.000 | 13 / 36 | 19 / **41** | 217 | 6.11 | 0.004 |
| half, 40° | 3.520e-3 | 2.39× | 3.85 | 0.999 | 20 / 42 | 27 / **48** | 210 | 5.72 | 0.034 |
| full, 10° | 1.177e-2 | 8.00× | 2.56 | 0.954 | 31 / 50 | 43 / **56** | 202 | 5.09 | 0.171 |
| full, 40° | 1.786e-2 | 12.14× | 2.24 | 0.750 | 40 / 52 | 52 / **59** | 200 | 4.84 | 0.270 |
| full, 70° | 1.885e-2 | 12.81× | 2.25 | 0.670 | 45 / 54 | 54 / **59** | 200 | 4.76 | 0.312 |

Monotone in phase, monotone in elevation, monotone on screen. The shipping sea
runs **17 → 52** sRGB codes from moonless to full — 35 codes. The optional
observer compresses that to the historical 40 → 59.

---

## What changed

| dial | was | now | why |
|---|---|---|---|
| `MOON_SKY_POWER` (`TimeOfDay.ts`) | 0.070 | **1.0** | solved, not hunted: in-scatter is linear in it, so an order of magnitude on the total needs 0.796; 1.0 is that rounded up, and measures 12.14× |
| `moonLightIntensity` | hand-set 0.34 | **derived**, 0.270 at full | `MOON_IRRADIANCE_SCALE = SUN_IRRADIANCE_SCALE × MOON_SKY_POWER / SUN_SKY_POWER` |
| `moonSpecularGain` (`oceanOptics.ts`) | 0.75 | **0.09** | it is a ratio to `uMoonPower`; holds the moonglade's on-screen brightness where Ash's eye put it |
| moon's star penalty | hand-set 1.2 mag | **derived**, 1.25·log₁₀(B) | background-limited detection, not surface brightness |
| the rod ramp's input | the renderer's meter | **modelled cd/m²** | see below — this is the real story |
| ambient/probe/horizon means | point-sample the moon's aerosol lobe | **dome-mean the lobe** | seven samples cannot estimate a 3° spike |

### One moon, one number

`moonPower` and `moonLightIntensity` were two independent hand-set dials for one
body, and they disagreed. Direct-light-to-sky-power was **4.86 for the moon
against 0.37 for the sun** — thirteen times out. The moon's lamp was doing work
its sky should have been doing, which is exactly why moonlit *surfaces* looked
plausible while moonlit *nights* did not.

The atmosphere and the geometry are the same for both bodies, so the conversion
from "power the dome scatters" to "irradiance the light throws" is the same
conversion, scaled by how much less power the moon has. The derived intensity at
full moon is 0.270 against the old 0.34: the direct moonlight was always about
right, and the sky was eleven times too dim.

Measured consequence, and the best single summary of what Part B fixed — **the
moon's key-to-fill ratio was 41:1 and is now 4.80:1, against the sun's 6.85:1.**
It was a spotlight in a black room. It is now a light in a sky.

---

## The thing Part A had to be built first to reveal

Raise the moon to a real order of magnitude with everything else left alone, and
this happens:

| | rod | exposure | sea on screen |
|---|---|---|---|
| moonless | 1.000 | 4.99 | code 40 |
| **half moon at 40°** | **0.399** | 3.91 | **code 36** |
| full moon at 40° | 0.000 | 2.46 | code 49 |

**A half moon rendered the night darker than no moon at all.** Two
self-cancelling effects cost more than the moon's own light bought: the exposure
meter closed down, and rod dominance collapsed from 1.000 to 0.399 — because
phase brightness is cubic, so a half moon brings an eighth of the light while
the meter reacts as though the sun were coming up.

That is not a moon bug. It is Part A's rod ramp reading the wrong instrument,
and the measurement that proves it is this:

| | reality | this pipeline |
|---|---|---|
| moonless → end of nautical twilight | 8× | **1.15×** |
| moonless → end of civil twilight | 5000× | **3.87×** |
| moonless → full moon | 100× | 12× (after Part B) |

The pipeline compresses the night far harder than it compresses twilight, and by
a *different factor for each light source*. A single compressed scalar therefore
cannot order two light sources the way an eye orders them, and no re-fitting of
the ramp's endpoints can make it — the two sources need different fits.

### So the observer stopped reading the renderer

`TimeOfDay.retinalLuminance` is now modelled in **real cd/m²**, from the sun's
elevation and the moon, against textbook values:

```
clear day 3000 · sunset 1000 · civil twilight end 5 · nautical end 0.008
moonless night 0.001 · full moon overhead 0.1
```

log-interpolated between twilight knots, plus the moon scaled by phase
brightness and by sin(elevation) — illuminance on the ground, which is the right
law for a source lighting a landscape.

This is the spec's own thesis taken one step further. "The pipeline models the
light and the camera but not the observer" — but an observer that adapts to the
*renderer's* luminance is still not being modelled, it is just being driven by a
different lie. The eye adapts to the world.

Two consequences worth stating:

- **The exposure meter is unchanged and still reads the rendered sky.** A camera
  meters what is in front of it; an eye adapts to where it is standing. They are
  different instruments and they now have different inputs, which is the point,
  not an inconsistency.
- **Part A's daylight guarantee got stronger.** It previously rested on a
  measured pipeline constant rounded down by hand so that `smoothstep` would
  return exactly 1. Now −6° is an exact knot of the model, so `rodDominance` is
  0.0 at and above the end of civil twilight by construction. The hand-rounded
  constant is gone.

Where the observer lands now: moonless 1.00e-3 cd/m² (rod 1.000), half moon at
40° 9.03e-3 (rod 0.999), full moon at 40° 6.53e-2 (rod 0.750). A half moon
leaves you essentially as dark-adapted as no moon — which is true, and which our
meter could not tell.

---

## The bug Part B exposed: the ambient fill is a seven-sample lottery

`ambientRadiance` averages the sky over **seven** directions: the zenith, a ring
at 26° and a ring at 54°. The aerosol phase function is `g = 0.94` for a high
source — about **43** at the light's own direction and **0.11** twenty-five
degrees off it, a factor of four hundred inside a few degrees.

Seven point samples do not estimate the mean of that. They play a lottery. At
the old moon strength the prize was small; at `MOON_SKY_POWER` it was not.
Measured, sweeping a full moon up through the sky:

```
moon elev   10°    18°    22°    26°    30°    34°    50°    54°    58°    86°    90°
ratio      7.89   11.78  20.79  45.52  20.92  13.57  21.93  34.00  16.88  18.11  32.61
```

**The entire scene's fill would have pulsed fourfold as the moon tracked**, with
peaks at exactly 26°, 54° and 90° — the sample rings.

The fix is not more samples. A Mie phase function integrates to 1 over the
sphere, so the mean over a dome the lobe sits entirely inside is just its
normalisation, 1/2π. Substituting it is an **unbiased estimator with zero
variance** where seven point samples are a high-variance one. The dome you look
at is untouched and keeps its real aureole; only the means change. Applied to
all three means — the ambient fill, the 256-direction harmonic probe, and the
8-sample horizon ring the exposure meter reads.

After: `1.00 → 3.77 → 8.00 → 10.18 → 11.24 → 12.05 → 12.57 → 12.90×`, smooth and
monotone all the way up.

### The same bug is on the sun, and is NOT fixed

Measured, clear sky, no moon: the daylight fill reads `0.323` at 70° sun, `0.353`
at 45°, **`1.296` at 25°**, `0.206` at 10°. That 2.4× spike at 25° is the sun
sitting on the 26° sample ring. It predates both parts of this round.

It is left alone deliberately: fixing it moves daylight, and "daylight is
bit-identical" is Part A's clause, not Part B's to spend. It wants its own
round, and the fix is the same one — or seven samples becoming a Fibonacci set,
which the 256-direction probe already uses and which would end the class.

---

## Acceptance

| clause | result |
|---|---|
| Full moon changes night ambient ≥ 1 order of magnitude on `ambientRadiance` | **12.14×**, gated |
| Moonlit and moonless unmistakably different at a glance | shipping sea 17 → 52 sRGB codes; gated at ≥ 30 codes |
| Glitter path stays a path, not a blown sheet | gain reduced in step; **held on screen, not verified by eye — see below** |
| Star visibility drops in a way that survives a photograph | 6.20 → 4.84 at full moon; a real full moon gives ≈4.5 |
| Moonless night must not get brighter | exact: `moonPower` is 0, ambient/exposure/limiting-mag pinned to Part A's values |
| Scales with phase and elevation rather than jumping | monotone and smooth in both, gated |
| Part A: daylight bit-identical | **holds, and is now stronger** |

### What Part A still guarantees, and what Part B deliberately supersedes

**Still holds, unchanged:**

- Daylight is bit-identical. `moonPower` is gated to exactly 0 above −2° sun, so
  Part B cannot reach daylight; the `domeMean` estimator change is moon-only and
  daylight ambient measures identically. Both are gated.
- The optional scotopic pass does not run at the shipped 0% strength; if enabled,
  it remains an exact identity in daylight and above its knee.
- The lantern is still the brightest thing and keeps its 2100 K exactly. On the
  direct path its margin over the sea is about 17× under a full moon, which is
  correct rather than a fault — a full moon *should* close on a hand-sized
  flame. Both ends are now pinned.

**Deliberately superseded:**

- **Part A's report says the rod ramp is anchored on measurements of this
  pipeline's exposure meter. That is no longer true** and the Part A report has
  been amended. The anchors are still the twilight definitions, but they are now
  real cd/m² and the input is modelled rather than metered. The reason is above;
  the old anchoring produced a half moon that made the night darker.
- **"No linear radiance value changes anywhere" was Part A's clause and Part B
  breaks it on purpose, at night only.** That is the entire point of Part B. The
  clause survives where it was meant to: in daylight, and for the moonless night.

---

## What Ash has to judge, and which dial to reach for

1. **The moonlit sea.** Not certified here. Is a full moon too much, too little,
   too blue? → `MOON_SKY_POWER`. Every number in this document moves with it,
   including the ambient ratio, so it cannot go below about 0.82 without failing
   the acceptance gate.

2. **The aureole.** At full moon, the sky 20° from the moon measures sRGB 158
   against a zenith of 40 — a four-fold contrast where a real full-moon sky runs
   two- or three-fold. It is Rayleigh in-scatter and physically the right shape,
   but it is large now. If it reads as a washed sky rather than as a moon, the
   dial is again `MOON_SKY_POWER`, and the ambient ratio falls with it.

3. **The moonglade.** `moonSpecularGain` was cut 0.75 → 0.09 to hold the path's
   on-screen brightness at the full-moon operating point, and this is the one
   deliberately conservative choice in the round. The *physical* answer is
   ≈0.645 — hold the glitter's ratio to a sea that has come up twelve times with
   it — which would make the moonglade about seven times brighter than today. It
   was not taken because a moonglade that bright was already tried at gain 3.5
   and rejected by eye for competing with the lantern, and re-creating a
   known-rejected look on a reasoning argument is not this round's call. **This
   is the most likely thing to be wrong.** If the path reads too meek against
   the brighter sea, `moonSpecularGain` is the dial and 0.645 is the other end.

4. **The moon no longer fights a shipping lift.** For an explicit optional-arm
   investigation, the old diagnostic still has a direction:
   - Moonlit nights right, moonless nights too dark → `SCOTOPIC_LIFT_GAMMA` in
     `scotopic.ts`. The lift does most of its work where the moon is absent.
   - Moonlit nights too bright, moonless right → `MOON_SKY_POWER`, down.
   - Moonlit nights look *flat* — lit but with no shape — → the observer is
     still too rod-dominated under the moon. `RETINAL_FULL_MOON_CD`, up, which
     pushes rod dominance down and hands the picture back to the moon.
   - **Do not** try to fix a moonlit night with `SCOTOPIC_LIFT_GAMMA`; it is a
     global operator and it will take the moonless night with it.

---

## Performance: NOT measured

Unchanged from Part A: the machine was thermally throttled and no number was
taken. Part B's additions are all CPU-side and small, but "small" is a reasoning
word and this project has an open, unexplained regression.

What the cold pass must check, on top of Part A's list:

- **`TimeOfDay.refreshFromAstronomy` cost, per frame, moon up versus moon down.**
  `CpuProfiler`, not `GpuProfiler` — this is all CPU. The suspicion is near-zero:
  the `domeMean` change *removes* a `pow` on the moon's path, and the retinal
  model is a handful of `log10`s once per frame. The measurement exists to
  confirm that, not because anything is expected.
- **The one thing that could actually cost.** `MOON_AMBIENT_RATIO_PEAK` is a
  measured constant standing in for a live quantity, because computing the
  moon's true marginal contribution to the fill needs a second pass over the
  ambient samples. If a future round wants that ratio live — it would make the
  star penalty exact and elevation-correct rather than a two-point fit — the
  cold pass should measure what 7 extra `addInscatter` calls per frame cost
  before anyone builds it.
- **Budget.** Anything over 0.05 ms of added CPU per frame for the whole of Part
  B is a surprise worth chasing.

---

## Does Part B need compensating calibration after the 0% verdict?

**No.** Part C calibrates Part A's operator; it is not an independent display
transform. Once Ash chose the direct path, applying Part C there would require a
new global black-point lift that changes daylight and would quietly reverse the
verdict.

Part B instead has to stand on the shipped path by itself. It does: the full
moon's physical gate remains **12.14×** on `ambientRadiance`, the tone-mapped sea
is monotone at every tested phase/elevation, and it moves from sRGB **17 to 52**
without the observer. The lantern remains roughly 17× brighter. Those are the
focused gates in `tests/moonlight.test.ts`; no Part B constant was changed.

The patch ladder still makes a valid measurement and remains available when a
non-zero `?scotopic=` explicitly opts into Part A. It is simply not a product
setting while the only consumer of that measurement ships off.

---

## Still open

- Ash's eye on all four items above, the moonglade first.
- The sun's 2.4× ambient-fill spike at 26° elevation — real, pre-existing,
  unfixed, and the same class as the moon's. Wants its own round because the fix
  moves daylight.
- `MOON_AMBIENT_RATIO_PEAK` as a live quantity rather than a measured constant,
  if the star penalty ever needs to be exact.
- The optional observer's frame cost, only if that rejected arm is reconsidered.
