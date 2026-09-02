# The ambient set — ending the aureole class

Built on `claude/coord-ambient-set`, off tonight's integration branch. It is the
round the night thread's Parts [B](NIGHT_VISIBILITY_PART_B.md) and
[C](NIGHT_VISIBILITY_PART_C.md) both asked for and neither was allowed to take:

> "the deeper fix underneath both aureole bugs — replacing the seven-direction
> ambient set with a Fibonacci one — is written up as wanting its own round,
> since it would end the class and make the switch unnecessary."

Shipped behind **`?fibonacciAmbient=1`, default off, gated byte-identical when
off.** Nothing about the shipping picture changes until Ash flips it.

---

## The class of bug, not its members

`ambientRadiance` — the fill every unlit surface in the game reads — was
estimated from **seven fixed directions**: the zenith, a ring of four at 26°,
a ring of two at 53°. Two rounds found two members of one family:

- **The moon** (Part B): the fill jumped to 45× the airglow as the moon crossed
  26° and fell to 12× between rings. Fixed outright there.
- **The sun** (Part C): the fill jumps 0.36 → 1.296 crossing 26°, and again at
  55°. Fixed behind `?sunDomeMean=1`, default off, because it moves daylight.

Both fixes work the same way — substitute the aerosol lobe's own normalisation
wherever a mean is taken — and both leave the rings in place for the next bright
thing to cross. **Rings are the fault.** A spherical Fibonacci set has none: no
shared elevations, no repeating azimuth, no "on a ring" and no "between rings".

## The reference, first

A ripple number is worth exactly what its reference is worth, so everything
below is scored against a **converged 8192-direction cosine-weighted integral of
the same sky**, evaluated through the renderer's own `skyWithClouds`. Not
against a smoothed version of the estimator under test, and — the trap this
round nearly fell into — not through the approximation being judged: a reference
taken with `sunDomeMean` on measures nothing about `sunDomeMean`.

## Ripple against sample count

Clear sky, sun swept 10° → 88° in 1° steps, and swept in azimuth at each ring
elevation. `worst` is the largest departure from the converged integral anywhere
in the sweep; `rms` is the typical one.

| directions | elevation worst | elevation rms | azimuth @26° | azimuth @53° |
|---|---|---|---|---|
| **7 (rings, ships)** | **4.652** | **98.1%** | **4.652** | **3.141** |
| 16 | 1.082 | 5.67% | 1.114 | 1.081 |
| 32 | 1.057 | 4.17% | 1.071 | 1.260 |
| 64 | 1.239 | 6.43% | 1.210 | 1.277 |
| 96 | 1.183 | 4.64% | 1.174 | 1.193 |
| 128 | 1.098 | 3.34% | 1.120 | 1.102 |
| **256** | **1.049** | **1.72%** | **1.045** | **1.043** |
| 384 | 1.025 | 0.90% | 1.023 | 1.023 |
| 512 | 1.013 | 0.52% | 1.013 | 1.014 |
| 1024 | 1.003 | 0.14% | 1.003 | 1.003 |

Two things in that table are worth more than the row that was chosen.

**The error is not monotone in count below about 128.** 64 and 96 are *worse*
than 32. A low-discrepancy spiral is not random, and at some counts its local
spacing lines up badly against a 2.7°-wide lobe. So "pick a small count and save
the cost" is not a smaller error — it is a different lottery, with the ticket
bought at build time instead of at sunrise.

**The seven-sample set is not merely spiky.** Its rms error is 98%. It is out by
3–15% even at the elevations *between* its rings, because the aureole's tail
keeps landing in it. That matters for the level question below: this was never a
good estimator that occasionally spiked.

### The cloud deck — the larger fault, and the one nobody has touched

A synthetic deck drifted 2 km past a 40° sun, cover 0.5, on a bare `TimeOfDay`:

| directions | worst | rms |
|---|---|---|
| **7 (rings, ships)** | **1.818** | **27.6%** |
| 64 | 1.234 | 8.43% |
| 128 | 1.104 | 4.35% |
| **256** | **1.067** | **2.67%** |
| 512 | 1.029 | 1.15% |
| 1024 | 1.025 | 1.08% |

Those are the numbers the unit tests gate, and they are honest about that field.
**They are not the shipping cloud field**, and a spot check in the running app
said so loudly enough to be worth chasing — so the cloud case was re-measured
live, against the real two-deck cloud clock, with the sky frozen and the deck
drifted underneath it. That measurement is below and it is the one to believe.

### The same thing measured in the running app

Sky frozen, deck drifted 12–16 positions, everything scored against a
4096-direction reference taken through the same live sky. `swing` is how much
each estimator moves across the drift; the reference's own swing is how much the
sky **really** changes, so an honest estimator should match it and no more.

| sun | cover | opacity | ring-7 swing | fib-256 swing | *true* swing | ring-7 worst error | fib-256 worst error | ring-7 bias | fib-256 bias |
|---|---|---|---|---|---|---|---|---|---|
| 76° | 0.5 | 1.0 | 2.22× | 1.90× | 1.86× | 1.74× | **1.03×** | 0.873 | **1.004** |
| 76° | 0.3 | 0.6 | 1.15× | 1.03× | 1.02× | 1.10× | **1.03×** | 0.971 | **1.014** |
| 39° | 0.5 | 1.0 | 2.36× | 1.17× | 1.14× | 1.89× | **1.04×** | 1.135 | **0.994** |
| 14° | 0.7 | 1.0 | 2.82× | 1.22× | 1.13× | 1.85× | **1.10×** | 1.055 | **1.008** |

Three things, and the middle one is the finding of the round:

1. **The Fibonacci fill is unbiased.** 0.994–1.014 against the reference in every
   condition. The seven-sample fill is not: it runs 13% dark under a thick deck
   at a high sun and 13% bright under the same deck at a 39° one.
2. **Its error is not a level, it is a wander** — which is why no constant could
   ever have corrected it, and why nobody noticed it as a bug. It swings up to
   2.82× as the deck drifts where the sky itself changes by 1.13×. **Two thirds
   of the fill's apparent response to cloud was the estimator, not the cloud.**
3. **The Fibonacci fill adds almost nothing of its own**: 1.90 against a true
   1.86, 1.17 against 1.14, 1.22 against 1.13. It moves when the sky moves.

The fill's *colour* wanders with its brightness. At one frozen synthetic field
the overcast fill read (1.000, 0.944, 0.850) — distinctly yellow — against
(1.000, 0.964, 0.936) averaged over eighty of them.

One caveat kept in view: 256 directions is *not* converged on a single frozen
thick deck at a high sun. Spot-measured there, the count sequence runs 1.17,
2.63, 1.39, 1.99, 1.60, 1.76, 1.69 for 16…1024 against 1.73 at 16384 — that sky
is heavy-tailed in direction, a few bright cloud faces carrying the mean, and
one draw of 256 landed 8% low. Averaged over the drift it comes out unbiased,
which is the property that matters for something the eye integrates over
seconds, but it is not the same claim as "converged" and is not stated as one.

## The count chosen: 256

Not because the curve knees there — it does not, it is still falling at 1024 —
but for three reasons that are all about this codebase rather than about
sampling theory:

1. **It is where the error becomes small in the conditions that matter.** The
   clear-sky worst case falls from 4.65× to 1.05×; live, under a drifting cloud
   deck, the worst instantaneous error falls from 1.89× to 1.04× and the bias
   from ±13% to under 1.5%.
2. **Below ~128 the count is not monotone**, so a smaller set is not a smaller
   error.
3. **It is free.** `PROBE_SAMPLES` — the harmonic probe's set — is *already*
   `fibonacciHemisphere(256)`, already evaluated and already cached. The fill
   becomes a second reduction of a cache that exists. 512 would need a second
   cache and 512 new sky evaluations a frame; 256 needs none.

## Cosine-weighted, and that is a measurement too

The weighting mattered as much as the count, and it decided the level.

A diffuse fill **is** irradiance over π, so the cosine weight is the physically
right one. Independently, it is the only weighting that keeps the level: a
*uniform* solid-angle mean of the very same 256 directions runs **1.30–1.36×
brighter across the whole day**, because it drags the bright horizon band into
the fill — precisely what `HORIZON_SAMPLES` says in its own comment must not
happen ("this ring is where the sunset's energy is, and feeding it into the fill
would light the raft from the horizon"). A cosine weight vanishes at the horizon
and keeps it out by construction, even though the Fibonacci set reaches down to
0.1° elevation.

Two independent arguments landing on the same weight is the strongest evidence
this round produced.

## What it costs: nothing, and that is a count and not a timing

**No performance measurement was taken.** The machine is thermally throttled and
a number off it would be worse than none. But cost is not a question here, and
the reason is arithmetic rather than a stopwatch:

- The ON arm adds **zero** sky evaluations. It reads three floats off
  `hemisphericRadiance`, which is computed either way.
- The ON arm **removes seven** `skyWithClouds` calls per frame — and with them
  seven CPU cloud marches, the expensive half.

The ON arm does strictly less work than the OFF arm. **What the cold pass must
still check** is that this is true in the frame and not just on paper: CPU frame
time with `?fibonacciAmbient=1` should be equal or very slightly better, never
worse. Anything above +0.05 ms means a consumer started doing more work
somewhere else — the likeliest suspect being a fill that now changes on a
different cadence and re-triggers a republish. That is the only surprise budget
worth naming.

**One real behavioural change comes with the free ride.** The probe cache is
amortised — 16 of 256 directions refresh per frame, a full cycle every ~270 ms —
so under the ON arm the fill inherits that latency, where the seven-sample path
was fully fresh every frame. On a sun that moves 0.034° in 270 ms even at 30×
world speed, and a cloud field that takes minutes to cross, this is a low-pass
on a quantity that was already low-frequency; a hard time jump bypasses it
through the existing `full` branch. It is written down because it is a change,
not because it is a worry.

## What daylight's *level* did — reported separately, as it must be

The smoothness results above would all pass if the fix had simply darkened the
day. It did not, but it did move the level, and here is the move.

Away from the rings, where the old estimator was not spiking:

Fill luminance, `?fibonacciAmbient=0` against `=1`:

| condition | OFF | ON | ratio |
|---|---|---|---|
| clear, sun 15° | 0.2606 | 0.2378 | 0.912 |
| clear, sun 40° | 0.3311 | 0.3159 | 0.954 |
| clear, sun 45° | 0.3607 | 0.3295 | 0.914 |
| clear, sun 60° | 0.3908 | 0.3349 | 0.857 |
| clear, sun 70° | 0.3298 | 0.3428 | 1.040 |
| moonless night, sun −20° | 0.001473 | 0.001413 | 0.959 |

Under cloud there is **no single number**, and that is the point rather than a
gap in the measurement. Because the seven-sample error is a wander and not a
level, the move depends on the condition — live, drift-averaged: **+15.0%** at a
76° sun under a thick deck, **+4.5%** under a thin one, **−12.4%** at 39°,
**−4.4%** at 14° under heavy cover. Each of those is the Fibonacci fill arriving
at the reference while the old one wanders around it.

So: **the fill gets about 5% darker in clear daylight and 4% darker at night,
and under cloud it goes whichever way the old estimator happened to be wrong
(+15% to −12%).** That
is a real level change and Ash's A/B has to accept it.

The case for accepting it is that the move is *toward* the converged integral,
not away:

| sun | ring-7 / truth | fib-256 / truth |
|---|---|---|
| 15° | 1.088 | 0.993 |
| 26° | **4.652** | 0.984 |
| 40° | 1.031 | 0.984 |
| 45° | 1.100 | 1.005 |
| 53° | **3.141** | 1.001 |
| 60° | 1.145 | 0.981 |
| 70° | 0.951 | 0.989 |
| 88° | **2.107** | 0.988 |

The old estimator was biased high nearly everywhere. The 5% is not a darkening;
it is 5% of over-count going away. And it moves in the direction the
`skyFillScale` measurement already pointed — that clear-day render was measured
at a 4.8:1 key-to-fill where a real clear day runs 7–10:1.

## Can `?sunDomeMean=1` be retired? Yes — recommended, not done

It has not been deleted and must not be: it is queued for Ash's A/B (review
queue 3.10a) and removing it takes the comparison away before he makes it.

But the evidence says retire it after that verdict, and the evidence is stronger
than expected. **The Fibonacci set alone is closer to the honest integral than
the lobe normalisation alone, and closer than both together:**

| arm | worst error, 5°–88° sun |
|---|---|
| seven directions, real lobe (**ships**) | 4.652 |
| seven directions + `sunDomeMean` | 1.092 |
| **256 directions, real lobe (this round)** | **1.021** |
| 256 directions + `sunDomeMean` | 1.050 |

Stacking the normalisation on top of the Fibonacci set makes it slightly
*worse*, and there is a reason rather than an accident:

> `1/(2π)` is the exact mean of a phase function over a **uniform** hemisphere.
> The fill is now a **cosine-weighted** mean, for which the exact substitution
> would be `max(l·up, 0)/π` — different by a factor of `2·l.y`, which is 2× at
> the zenith and 0 at the horizon.

Measured, that mis-substitution costs 1.6% at a high sun and 5% at a 5° one. It
is smooth in sun elevation, so it is invisible; but it is now the *largest*
remaining error in the estimator, and it is why the two fixes together do not
converge on the truth. Gated in `tests/fibonacci-ambient.test.ts`.

**This is a finding about the moon too, and it is NOT fixed here.** The moon's
lobe is dome-meaned unconditionally — Part B's fix, not behind any switch — so
with `?fibonacciAmbient=1` on, the moon's contribution to the fill carries the
same `2·l.y` error: at a typical 40° moon that understates it by about 29% of
the moon's own marginal term. The measured damage is small because the term is
diluted (full-moon/moonless fill ratio 12.14× on the ring set against 12.35× on
the converged integral, so `MOON_AMBIENT_RATIO_PEAK = 11.3` does **not** go
stale), but the constant is wrong for the quantity it is now applied to, and
correcting it would move the night. It belongs to whoever next opens the night
thread.

## Acceptance

| | |
|---|---|
| The rings are gone | `?fibonacciAmbient=1`; 256 cosine-weighted Fibonacci directions, no shared elevation, no repeating azimuth |
| Count chosen by measurement | ripple-vs-count swept 16→1024 against an 8192-direction reference in the unit harness and a 4096-direction one in the running app; 256 is where the error becomes small in both and where the cost is zero |
| Measured in the app, not only in the harness | the synthetic cloud field disagreed with the shipping one, so the cloud case was re-measured live and the write-up corrected — the live numbers are the better result, not the worse one |
| Off is byte-identical | exposure, `ambientRadiance`, `hemisphericRadiance` and `skySh` pinned to exact doubles with `toBe` — **read off the pre-change code by stashing the diff**, not off the new code and declared correct |
| A spike, not a level | the level move is pinned in its own test, and shown to be movement toward the converged integral |
| Registered for the sheet | `tools/ab-sheet.mjs --switch fibonacciAmbient`, live scope, read-back gated |
| Suite | 1456 → **1472 passing**, build and typecheck clean |
| Performance | **not measured**, deliberately; the ON arm provably does less work — see above for what the cold pass must confirm |

## What is owed to Ash

1. **A/B `fibonacciAmbient`** — a paired sheet at 26° sun against 40°, and a
   second at 45° under a drifting cloud deck, which is where the bigger everyday
   fault lives. What to look for: off, the fill steps as the sun crosses 26° and
   53° and wanders as clouds drift; on, neither. Then the level: the whole scene
   sits about 5% darker in clear daylight, and under cloud moves by up to
   ±15% in whichever direction the seven-sample fill was wandering.
2. **The verdict on `sunDomeMean`** it was already owed. This round recommends
   retiring it once that verdict is in — but the recommendation is only usable
   after he has seen the thing it is about.
3. **Whether the two switches should ship as one.** They are independent flags
   because they are independent changes, but if the recommendation above holds,
   the shipping configuration is `fibonacciAmbient` on and `sunDomeMean` off,
   which is one checkbox from where the code sits today.

## Still open

- The cold-pass frame time, as above. No timing was taken in this round or in
  any of the three night rounds.
- The `1/(2π)` versus `max(l·up,0)/π` normalisation, for the moon. Diagnosed
  here, deliberately not fixed: it moves the night.
- `HORIZON_SAMPLES` — the exposure meter's eight directions at 4° elevation — is
  the last ring left in the file. It was checked and it does **not** spike: the
  aerosol lobe broadens to `g = 0.8` at low sun (`lowSun` in `addInscatter`), so
  by the time anything bright reaches 4° the lobe is 12× flatter and there is no
  spike to catch. The aureole bug was always a *high-sun* bug. Left alone.
