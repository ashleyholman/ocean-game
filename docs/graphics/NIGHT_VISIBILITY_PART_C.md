# Night Visibility, Part C — the display calibration

Built on `claude/coord-night-vision`, on top of Parts
[A](NIGHT_VISIBILITY_PART_A.md) and [B](NIGHT_VISIBILITY_PART_B.md). The spec
calls this "required, and not optional" and "the only part of this document that
addresses the literal question *on all screens and devices*". It is the last
piece of the night thread.

> **CURRENT STATUS, 2026-08-17.** Ash rejected Part A and chose 0% as the shipped
> default. Part C derives only Part A's lift, so it is now inactive on the
> product path rather than being repurposed into a global brightness change.
> Settings hides the calibration unless a non-zero `?scotopic=` explicitly opts
> into the observer. The default path does not load a saved/URL black floor or
> precompile the pass, and the inactive summary says the picture is unchanged.

Also in this round, and separate: **the sun's aureole bug, fixed behind a
default-off switch.**

---

## Why it is an act and not a slider

Every other dial in this thread asks *is the scene bright enough*. This one asks
a question that is not in the scene at all: **where is this panel's black, in
this room?** Nothing the renderer can measure answers it, because the answer is
made of backlight leakage and the light behind the player's chair.

The form follows from that. A slider sits beside the picture and invites the
player to adjust the scene until it looks nice, which yields a *preference*. So
this is a full-screen modal that covers the picture entirely and asks a question
with a right answer — which of these squares can you actually see — which yields
a **measurement** the renderer can then trust.

**The optional act.** With a non-zero `?scotopic=`: Settings → Display →
*Calibrate optional night vision*.

1. The screen goes pure black. "Set your screen to the brightness you actually
   play at, and sit where you actually sit." Five seconds of nothing.
2. A ladder of thirteen squares fades in, from pure black to level 45.
3. "Click the leftmost square you can still make out." One click. Done.

Three things the form has to get right, and does:

- **The eye has to settle.** A reading of near-black taken two seconds after
  looking at a lit interface measures the interface. Five seconds is not real
  dark adaptation — that is twenty minutes — but it is the difference between a
  reading and a guess, and it is short enough that nobody skips it.
- **Nothing bright near the patches.** A caption beside a level-3 patch destroys
  the reading of that patch. All the text is dim and far from the ladder; the
  patches carry no labels at all, no focus ring and no hover state.
- **There has to be a control.** The leftmost patch is pure black and nothing is
  drawn there — verified in the browser, `rgb(0, 0, 0)` computed. A player who
  picks it is told so plainly and gets one retry; a second identical answer is
  recorded rather than argued with, and flagged `suspect`. It is the only guard
  available against the strong human urge to see something where there is
  nothing.

**Afterwards**, Settings reads back what it concluded, in the player's terms:

> Your display goes black below level 11 of 255 — about average, so the night is
> lifted less than the default.

with *Calibrate my display* and *Forget* beside it. `?blackFloor=N` overrides for
harnesses.

---

## What the renderer does with it

It **re-derives Part A's optional scotopic lift**, and nothing else. At the
shipped 0% strength there is deliberately no consumer for the measurement.

That operator exists to raise the night off the display's floor, and its
shipping strength was chosen against an *assumed* floor — Part A's arithmetic
posits a 250 cd/m² panel carrying 15 cd/m² of room reflection. Part C replaces
the assumption with the player's own number.

The derivation is a **closed-form inversion of the operator**, not a fit. The
lift is `K^(1−1/g)·Y^(1/g)`, so demanding it carry the night sea `Y` to a target
`T` gives

```
g = ln(Y/K) / ln(T/K)
```

with `T` the display luminance of `measured floor + 24 codes`. The margin of 24
is the one chosen number: the sea is a field with its own internal contrast, and
putting its *mean* at the threshold would put half of it underneath.

**The reference floor is derived, not picked.** `CALIBRATION_REFERENCE_FLOOR_CODE`
is whatever floor makes this model reproduce the shipping `SCOTOPIC_LIFT_GAMMA`
exactly. It lands at **15.5** — which is roughly an uncalibrated laptop in a lit
room, so Part A's guess was a good one. It was still a guess. An uncalibrated
session uses the shipping constant itself rather than a re-derivation of it: the
two agree to 0.2%, but "agrees closely" is not the claim being made, "unchanged"
is.

### Verified in the browser, live, on one frozen frame

Moonless night, sun −34°, same camera, same instant, flipping the calibration in
place:

| calibration | derived gamma | night sky | night sea |
|---|---|---|---|
| floor 2 — good panel, dark room | 1.317 | **sRGB 15** | 58 |
| uncalibrated | 2.000 | **29** | 64 |
| floor 36 — bright room | 4.000 (clamped) | **49** | 71 |

The sky moves by a factor of three in code space and the sea by much less, which
is the operator's selectivity doing its job: the sea is nearer the knee, so it
gets less of the lift. The lift is a **uniform**, not a baked constant, which is
what lets a calibration land in the frame it is taken — a calibration you cannot
see take effect is one nobody trusts.

### Deliberately NOT a black-point lift

That is the other obvious use of the same number and it was not taken. It would
touch daylight — Part A's bit-identical clause — to rescue shadow detail that is
not what this thread is about. The floor is measured to size the night's lift,
and the night is where it is spent.

Consequences that follow, all gated:

- **Daylight is still bit-identical**, calibrated or not: the operator only runs
  where the pass runs, and the pass does not run above −6° sun.
- **The lantern still keeps its colour exactly**, at every gamma the ladder can
  produce.
- **The join stays C1 at every gamma.** The scale is republished with the gamma,
  so recalibrating cannot put a seam at the knee.
- Every answer the ladder can give — including the daft ones — leaves the lift
  between 1 and 4 and the night sea below the knee.

---

## The sun's aureole bug, behind `?sunDomeMean=1`

Part B found that `ambientRadiance` is a **seven-sample** average of the sky —
zenith, a ring at 26°, a ring at 54° — and that the aerosol phase function is
`g = 0.94`, about 43 at the light's own direction and 0.11 twenty-five degrees
off it. Seven point samples do not estimate that mean; they play a lottery. The
moon's copy of the fault was fixed outright there. The sun's was left alone
because fixing it moves daylight.

Measured, clear sky, sweeping the sun:

```
sun elev   5      10     15     20     25     30     35     45     55     70     85
OFF      0.121  0.203  0.261  0.402  1.296  0.597  0.354  0.361  0.831  0.330  0.445
ON       0.125  0.207  0.252  0.279  0.297  0.310  0.319  0.331  0.339  0.345  0.347
```

**The whole scene's fill jumps 2.4× as the sun crosses 26°, and again at 55°.**
With the fix it is a smooth monotone rise, which is what a clear sky's diffuse
fill does.

The fix is the same one: a Mie phase function integrates to 1 over the sphere,
so the mean over a dome the lobe sits inside is just its normalisation. Unbiased,
zero variance, and the dome you actually look at is untouched.

**Default off, and the off arm is gated byte-identical** — five daylight ambient
values pinned to their exact doubles with `toBe`, not `toBeCloseTo`, plus the
exposure meter and the harmonic probe. Off, the sun's path runs the identical
arithmetic it always did, so this costs nothing until Ash A/Bs it.

It is registered in `src/debug/abSwitches.ts` as a **live** switch, readable as
well as writable, so `tools/ab-sheet.mjs --switch sunDomeMean` will produce the
paired sheet. There is a checkbox in the graphics panel beside the other six.

**What to look at:** the sun crossing 26° elevation. Off, the fill steps; on, it
does not. The second thing to check is that the fix removes a *spike* and not a
*level* — away from the sample rings the two arms agree to within 20%, which is
gated, because a fix that merely darkened the day would pass a smoothness test
and be wrong.

---

## Acceptance

| | |
|---|---|
| No dead shipping control | hidden at 0%; a saved measurement cannot engage or alter the direct path |
| Optional calibration remains usable | with non-zero `?scotopic=`, Settings → Display; five seconds and one click |
| Short and unmistakable | full-screen black, no other control on screen, one question |
| Result legible afterwards | the verdict line quotes the level and what it changed; *Forget* undoes it |
| Uncalibrated opt-in sessions unchanged | the optional arm's original gamma is used directly, not re-derived |
| Part A's daylight clause | holds, calibrated or not — gated at every gamma the ladder can produce |
| Sun fix present and default off | `?sunDomeMean=1`; off is byte-identical, gated on exact doubles |
| Suite | 1346 → **1361 passing** |

---

## What remains relevant

Ash does **not** need to calibrate the shipped game: doing so would change
nothing. If the optional observer is reconsidered, perform the calibration
before judging that arm; `CALIBRATION_TARGET_MARGIN_CODES` remains its taste
dial. The separate `sunDomeMean` A/B is unaffected by this verdict.

## Still open

- The optional observer's frame cost, only if that rejected arm is reconsidered.
  Part C itself adds nothing per-frame; calibration is not even loaded at 0%.
- The moonglade (`moonSpecularGain`), still the item in Part B most likely to be
  wrong.
- An independent decision to tone-map crest spray; the bundled Part A change is
  absent from the product path.
- ~~The seven-sample ambient set itself.~~ **TAKEN**, in its own round:
  [AMBIENT_SET_ROUND.md](AMBIENT_SET_ROUND.md). The rings are replaced by 256
  cosine-weighted Fibonacci directions behind `?fibonacciAmbient=1` — also
  default off, also byte-identical off. It confirms the guess above and goes one
  further than expected: measured against a converged 8192-direction integral,
  the Fibonacci set **alone** is closer than `sunDomeMean` alone (1.021 worst
  against 1.092), and closer than both together, because `1/(2π)` is the exact
  mean of a phase function over a *uniform* hemisphere and the fill is now a
  *cosine-weighted* one. So the recommendation is to retire this switch after
  Ash's A/B rather than keep it alongside — but it stays until then, because the
  comparison is his to make.
  That round also surfaced the larger everyday fault this one was hiding: the
  seven-sample fill wanders **±28% rms on every cloudy frame** as tufts drift
  across its sample directions. Neither aureole fix touched it.
