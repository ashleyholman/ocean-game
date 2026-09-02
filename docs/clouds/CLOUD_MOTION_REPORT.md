# Clouds that move — round report

Written at the close of the cloud-motion round. Ash's ask:

> "One is that they don't move ... and they don't evolve in shape either ...
> when I'm scrolling the local apparent solar time, I'd kind of expect to see
> the clouds fast-forwarding. And then when I'm going in normal time, they would
> drift. And then when I pause the canonical world, then maybe the clouds would
> stop ... ideally their shape would evolve too."

All of that, plus roadmap item 3 (the cirrus deck), which is here because a
second layer is what makes motion read as depth rather than as sliding.

`docs/clouds/CLOUDS_ROADMAP.md` remains the authority on what comes next.

## 1. The cloud clock — why they did not move, and what replaced it

They *did* move. `SkySystem.update` integrated a drift offset at 4.5 m/s times
the **frame delta**, which is 4.5 metres per real second against a noise cell
1150 m across: one cell every four minutes. Static, for any purpose.

Worse than slow, it was on the wrong clock. A frame delta knows nothing about
whether the world is paused, what the time multiplier is, or that the time
slider has just been dragged through an afternoon — so the drift ran while the
world was frozen and stood still while the sun crossed the sky.

Now `SkySystem.advanceCloudClock(worldUtcSeconds, windDir, windSpeed)` is called
from the presentation-lighting derivation, which is the one place that holds the
canonical instant. Everything Ash asked for is a property of that one argument:

| the world does | the clock is handed | the sky does |
|---|---|---|
| paused | the same instant twice | stands still |
| running at 72x | +72 s per real second | drifts |
| time slider dragged | +3600 s in one frame | fast-forwards |
| slider dragged back | −3600 s | runs backwards |

**It integrates rather than evaluating a closed form**, and that is deliberate
in both directions. Against the frame delta, it gains the whole table above.
Against `offset = wind × (t − t0)`, it gains the ability to survive a wind
change: the offset is the integral of a wind that a sea state can alter, and a
closed form would slide hours of accumulated drift onto the new heading in a
single frame. `tests/graphics.test.ts` has all five properties as tests.

### CLOUD_TIME_RATE — the one lie, isolated on purpose

> **Superseded. `CLOUD_TIME_RATE` no longer exists.** Marked 2026-08-16 by the
> correctness-and-truth round. It was replaced by `CLOUD_WALL_RATE = 1.0` in
> `src/scene/SkySystem.ts` — cloud seconds per **wall-clock** second, not per
> world second. Clouds are weather now rather than timelapse: the deck drifts at
> the speed the current weather implies, while only the sun, moon and stars keep
> accelerated astronomical time. The sea set that precedent.
>
> The verdict this section was waiting for was given, and it went against the
> lie. `SkySystem.ts` records it: the old 0.2-of-world-time rate was a 14.4x
> timelapse and Ash read it exactly as one — *"they look a bit ridiculous"*.
> Everything below is the reasoning for a constant that has since been removed;
> the *isolation* argument is the part that survived, and the replacement is
> stricter about it — there is deliberately no astronomical instant, rate or
> pause input to cloud time at all, so freezing a lighting condition cannot
> freeze the weather and dragging the Sun across six hours cannot teleport the
> deck.

Cloud time runs at **0.2 world seconds per world second**.

The world runs at 72x and the sky is the only part of the scene that obeys it —
the sea runs at wall-clock rate, because a raft bobbing 72x too fast is not a
raft. Advect an honest 11 m/s wind aloft on world time and the deck crosses the
frame in eight seconds: a correct timelapse sitting on a real-time ocean, which
reads as the sky being on fast-forward rather than as weather.

At 0.2, with the default sea state's 6 m/s surface wind:

- cumulus **160 m per real second**, 2.1 deg/s at 45 degrees of elevation —
  about 22 seconds to cross a 46-degree frame
- cirrus **397 m per real second**, but only 1.4 deg/s, because it is four times
  further away. The two decks moving at visibly different angular rates is the
  depth cue the round was really after
- one hour of dragged solar time moves the low deck **8 km**, seven noise cells

Everything downstream of this constant is in real metres per second of cloud
time, so a weather system can author true wind speeds and true cloud lifetimes
and only this number knows about the compression. It is on a graphics-panel
slider (`Drift rate`, 0 to 1x world) precisely because it is a judgement about
how a sky should feel, and that is a thing to watch rather than to argue about.

## 2. Shape evolution — a third axis, not a phase

`cloudFbm(vec2 p)` became `cloudFbm(vec2 p, float w)` over `vnoise3`. `w` is a
coordinate through a genuine 3D volume, and the cloud pattern is a slice through
it, so advancing `w` slides the slice: contours are continuously born, deformed,
merged and killed. No amount of translating a 2D field imitates that —
translation moves clouds past the camera without ever changing one.

Two details carry most of the quality:

**`w` doubles with each octave, alongside the domain.** The base octave — where
the clumps and lanes are — turns over eight times slower than the finest. That
is the observed behaviour of convection (eddy turnover time scales with eddy
size) and it is what stops the evolution reading as a uniform boil. Callers that
read the field at a scaled domain scale their `w` by the same factor, so a
feature's lifetime is proportional to its size for free: `cloudEvolve` is
carried in **metres** rather than as a phase so that every consumer can convert
it with its own spatial scale.

**The lump field boils upward** (`CLOUD_BOIL`), mostly vertically, because a
cumulus interior does: bubbles rise through the body and pile against the
inversion. Without it the cauliflower is a rigid carving the wind carries about
intact, and a cloud whose outline evolves while its interior does not reads as a
shape sliding under a fixed texture.

### The basis swap was not free, and it was nearly silent

Trilinear interpolation averages eight lattice values where bilinear averages
four. Measured over 400k samples:

| basis | mean | sd | p05 | p50 | p95 |
|---|---|---|---|---|---|
| 2D (old) | 0.4684 | 0.1236 | 0.2656 | 0.4684 | 0.6720 |
| 3D (raw) | 0.4688 | 0.1067 | 0.2935 | 0.4689 | 0.6445 |

Same mean, **14 % less spread**. The whole layer is built on how far this field
passes a threshold — coverage, the soft edge, the column height, the region
swing — so a narrower distribution shortens every tower and flattens the sky,
and it would have done it without a single constant changing. Measured against
the same 400k samples: the fraction of sky above threshold barely moves (0.4993
to 0.4961) but the mean column height of what *is* covered falls 14 % (0.415 to
0.356) and the fraction of full-height towers drops by more than half (2.2 % to
0.9 %).

`CLOUD_FBM_MEAN` / `CLOUD_FBM_GAIN` rescale the deviation, which lands every
quantile within 0.0003 of the old basis and leaves every downstream constant at
the value it was tuned to. Both are in the CPU-mirror parity test.

This is the third time this project has been bitten by using a noise field
outside its measured distribution. The rule from `docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`
— *measure a basis's distribution before tuning anything that consumes it* —
now has a corollary: **measure it again when you change the basis, even when the
mean is unchanged.**

## 3. The cirrus deck — roadmap item 3

Built as `docs/clouds/CLOUD_STRUCTURE_HANDOVER.md` designed it: an unmarched sheet at
8400 m, its own field, ice optics, composited under the low deck (for an upward
ray the cumulus is nearer). Three things the design did not anticipate:

**The anisotropy has to be split.** The design says "strongly anisotropic,
stretched 4–8x along the upper wind". Put that stretch in the envelope and the
sky fills with straight-edged white bands a hundred kilometres long —
brushstrokes, not weather. The elongation belongs to the **filaments**: a mildly
stretched envelope (2.2:1, 3.6 km across the wind) carrying a heavily stretched
fibre field (`CIRRUS_FIBRE`, 7:1 finer across than along). Organic patches,
combed.

**The comb has to reach zero.** A filament field that only multiplies gives a
veil with ripples in it. Cirrus has fibres with *sky between them*, so the fine
field is windowed hard — `CIRRUS_COMB` runs from about the field's 15th
percentile to its 89th, which tears a seventh of the deck's area right through
and leaves a ninth at full thickness.

**The Nyquist fade has to be per axis.** The roadmap warned its Nyquist
behaviour would differ from the low deck's. It understated it: one isotropic
figure against a 7:1 field either retires the deck while it is still resolved or
lets the comb alias, and it did the latter — the first sunset had ruled
horizontal dashes across fifteen degrees of sky, the same failure mode as the
ocean's residual wave term, from the same cause. `cloudLayer` now passes
`vec2 dqHigh = vec2(fwidth(q.x), fwidth(q.y))` and each scale asks the question
on its own axes, with a 2.0 factor charging the fbm's second octave rather than
only its base. The distance haze also had to go from `exp(-t*0.000019)` to
`exp(-t*0.000030)`: a ray to the high deck at ten degrees of elevation runs
48 km, nearly all of it through the dense lower air the low deck's haze is
calibrated on.

The payoff the design promised does arrive: 8 km of dip is 2.9 degrees of extra
sun, so the high deck stays lit — by light that has crossed a long red path —
after the cumulus below it has gone to ash.

## 4. One weather scenario, and where the weather system plugs in

Ash asked for one scenario rather than a system. It is: **fair-weather cumulus
under a broken cirrus veil**, and the only input is the sea state's surface wind.

Wind aloft is derived from it by the textbook maritime Ekman figures — friction
slows and backs the wind near the sea, and it strengthens and veers clockwise
with height toward the geostrophic flow:

| deck | veer | gain | evolution, as a fraction of advection |
|---|---|---|---|
| cumulus, 1100–3300 m | 22 deg | 1.85x | 1/14 |
| cirrus, 8400 m | 58 deg | 4.6x | 1/60 |

The **sense** of the veer comes from the observer's latitude, not from the
constants: clockwise seen from above in the north, anticlockwise in the south,
ramping to nothing across five degrees of the equator, where the Coriolis
parameter goes to zero and the Ekman layer has no defined depth. The raft starts
at 35 degrees SOUTH, so the northern sense would have been wrong for the only
water anyone has sailed here.

Evolution is a *ratio* rather than an absolute rate because the same shear that
carries a cloud is what tears it apart: a stiff wind means a shorter-lived
cloud, not merely a faster one. 1/14 is about a twenty-five-minute cumulus
lifetime, which is real. Cirrus is an order of magnitude more placid — ice in
laminar flow with no convection under it.

A weather system replaces `uCloudCover` and `cirrusCover` with per-region values
and sets the veers and gains per state. Nothing else here has to change.

## 5. What it cost

**Unmeasured, and this session could not measure it.** The agent browser
reported `innerWidth === 0` and a 2x2 drawing buffer throughout, so the
adaptive-resolution proxy from `docs/clouds/CLOUD_SHAPE_FINDINGS.md` reads "holds native
DPR" while drawing four pixels. Recorded rather than guessed at. The arithmetic
of what changed, which is at least honest:

- `cloudFbm` went from 4 x `vnoise` (16 hashes) to 4 x `vnoise3` (32 hashes).
- The low deck evaluates it **6 times** per drawn pixel (region threshold, base
  cell, puff, three sun-shadow taps): 96 → 192 hashes.
- The cirrus deck adds **2 more** (envelope, fibre): +64 hashes, plus its
  lighting, for pixels above the horizon fade.
- The march is unchanged — `cloudLumps` was already `vnoise3` — and for a pixel
  that actually contains cloud it is still the dominant term at roughly 8 steps
  x 2–3 `vnoise3`.

So: about **2x on the weather map, which is the whole cost of a clear-sky
pixel**, and unchanged on the expensive cloudy ones. The cheapest thing to trade
back, if the perf round wants it, is the cirrus fibre octave; the next is
`CLOUD_OCTAVES`.

### Aliasing did not come back

`stability()` at the legacy 4.5 m/s drift rate, against the numbers the aliasing
hunt recorded on master:

| view | master | now |
|---|---|---|
| sunward | 0.068 | 0.072 |
| cross | 0.073 | 0.081 |
| anti | 0.090 | 0.062 |
| zenith | 0.108 | 0.087 |

Two up, two down, all comparable — the field is still band-limited with a second
deck and a third noise axis on it.

At the **game's** drift rate (160 m/s, 35.5x the legacy rate) the same measure
reads 0.57–0.87 rms with peaks of 23–40 levels. That is motion, not static, and
the check is that it grows **sub-linearly** with the rate: 35.5x the drift gives
10x the rms. Point-sampling past Nyquist does the opposite — it saturates, and a
pixel resampling unrelated noise scores the same whether the field moved a
millimetre or a kilometre.

Use `stability()` at its default for comparison against history; pass the real
per-frame figure to ask the other question.

## 6. Fixed in passing

`isSmallScreen` in `main.ts` latched TRUE whenever the module was evaluated
before first layout, because `innerWidth === 0` satisfies both of its tests —
handing a desktop the mobile ocean (5-step cloud march, three fbm octaves) for
the whole session with nothing in the image to say so. It now reads through to
`window.screen`. `docs/clouds/CLOUD_SHAPE_FINDINGS.md` flagged this as a real latent bug
whose fix had been thrown out with that round's code; it cost an hour there and
it was confirmed live in this session, where the pane reports zero width and the
shader defines now correctly come back desktop.

## 7. What this round did not do

- **Roadmap item 2, cloud TYPE within a deck.** Untouched. Note for whoever
  takes it: `docs/clouds/CLOUD_SHAPE_FINDINGS.md` FACT 2 limits its payoff more than the
  roadmap admits — the flat-slab projection maps screen-vertical to distance, so
  a per-type height gradient cannot change a silhouette. What it *can* change is
  opacity and interior structure, which is the difference between a flat grey
  stratus sheet and a field of bright heaps. That is real, but it is a smaller
  claim than "most compositional payoff per line".
- **A mid deck.** Still the least valuable of the three.
- **Cloud shadows on the water** moving with the deck. The sun transmittance
  already rides the clock, so gaps sweep the glitter; what is missing is the
  patchy spatial version in `docs/graphics/GRAPHICS_TODO.md`, which is now much more worth
  having than it was, because the gaps move.
- ~~**`CLOUD_TIME_RATE` is a guess Ash has not yet seen in motion.** The slider is
  there for exactly that verdict.~~
  **Verdict given, and the guess lost.** Marked 2026-08-16. Ash saw it in motion
  and read it as timelapse — *"they look a bit ridiculous"*. The constant was
  replaced by `CLOUD_WALL_RATE = 1.0` (`src/scene/SkySystem.ts`): clouds drift at
  wall-clock rate, like the sea, and no longer ride the world clock at all.
