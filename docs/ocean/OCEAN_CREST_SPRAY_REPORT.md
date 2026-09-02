# Crest spray sheets and airborne salt loading

**Status: built, wired, tested and on live lab controls, through five passes.
One artefact remains unresolved — see §5.9, which lists what has already been
ruled out.**
Written 2026-08-01 on branch `claude/crest-spray-sheets-1e1c3b`, implementing
item 1 and the second half of Phase 4 from
`docs/ocean/OCEAN_VIOLENCE_RENDERING_HANDOVER.md`.

Sections 1–4 are the first pass. **Section 5 is the rebuild that followed Ash's
review of it, and where they disagree section 5 is what the code does.** The
first pass is kept because three of its findings still hold and because the
failure it shipped — spray on short ballistic arcs — is worth not repeating.

---

## 1. What a sheet is, because it changed the design

The first plan was a ribbon: trace the breaking ridge, build a strip mesh along
it, extrude it downwind. That was wrong, and the reason is physics rather than
graphics.

When a gale shears across a breaking crest the velocity difference tears the top
off it and the liquid goes through the standard cascade — sheet, then ligaments,
then droplets. The genuinely connected film survives centimetres. A metre
downwind there is nothing left but a cloud of drops.

So the coherence in a photograph of a storm sea is not the coherence of an
object. It is the coherence of an **ensemble**: those droplets were born on the
same crest line, in the same instant, with near-identical velocity, so they
occupy a thin extended volume and translate together instead of dispersing. The
eye integrates the envelope, never the members.

A ribbon mesh fails three ways against that. A two-dimensional strip goes
edge-on and vanishes as it rotates; it has a hard alpha boundary where water in
air has none; and it has no depth, so its near face cannot be brighter than its
far one.

**The polyline survives as the emitter, not as the geometry.** The system traces
a ridge and sheds a correlated swarm along it. Coherence lives in the birth,
which is where the physics puts it.

Four properties carry it, and dropping any one gives snow:

| | why |
|---|---|
| Born on a curve | initial shape is a long thin surface, not a ball |
| Anisotropic velocity spread | tight across, loose along — streams instead of inflating |
| Aligned streaks | every sprite stretches along a shared velocity |
| Ragged death | lifetimes vary with droplet size, so a plume shreds rather than switching off |

---

## 2. The ridge is traced in parameter space

`FoamField` stores whitewater against the undisplaced Gerstner parameter
position because a particle orbits about a fixed `p`: a breaking ridge is a
*stationary curve* there however violently it is moving in world space. Tracing
in the same space means sheets land on the water the foam shader whitened, by
construction rather than by tuning.

It needed a primitive the CPU did not have. `WaveField.sample()` answers "what is
visible at this world position" and pays a seven-iteration Newton solve to do it;
`evaluateSeed()` gives a position and nothing else. Whitewater asks the opposite
question — "this parcel is breaking, where is it on screen" — so
**`WaveField.sampleSeed()`** is new: the full forward evaluation at a parameter
point, one pass over the components, mirroring the shader's `evaluateWaves`
line for line including the determinant clamp and the push of the gradient
through the inverse Jacobian. (`sample()` builds its normal by the older
first-order approximation, which diverges exactly at compressed crests — the
only place this function is ever called.)

Tracing then works by rejection-seeding on the shader's own `breakBand`, then
walking the ridge in both directions, steering at each step towards whichever of
three candidate headings carries the most compression. Ridges shorter than 6 m
are rejected, and **that rejection is what keeps the system pointed at organised
breaking**: a shorter patch is a whitecap fleck, which the foam field already
represents.

Two tests pin the primitive: `sampleSeed` places a point exactly where
`evaluateSeed` does, and round-trips through the inverse solve to 6 decimal
places on height, compression and velocity. If those ever drift, spray is torn
off water that is not the water the foam whitened, and nothing about the
symptom would say so.

---

## 3. Three defects found during bring-up, all by measurement

The first version drew 3000 live particles and was invisible. Each of these was
found by measuring rather than by looking, and none would have been guessable.

**Only 1% of the frame changed, and it saturated at 1.4% when driven sixty times
harder.** Differencing the frame with the layer on and off — the method the
whitewater round established — showed the problem was not brightness but that
the system was barely present. Driving it 60× and getting +0.4% proved the
gain was not the lever.

**A third of the pool was underwater.** 994 live particles of 3058 were below
the surface, correctly depth-tested away, costing slots a sheet in the air could
have used. Particles now retire when they have fallen 2 m below their birth
height. That is a birth-relative approximation rather than a real surface test,
because the honest test is three thousand inverse solves per frame to decide
something about water that has been in the air for under a second.

**The spray was lit ten times darker than the foam it comes off.** A whitecap in
this renderer gets `sunRadiance · foamSunGain` ≈ 2.7 at a 48° sun. The spray had
inherited the old droplet system's 0.034 multiplier, giving 0.26 — so the
desaturated sky ambient was effectively the only light on it, and blue spray over
blue water is invisible at any opacity. `SHEET_SUN_GAIN` is now 0.30, sized
against the foam.

Then the same measurement caught the overcorrection. Raising density to where a
sheet is genuinely a sheet made three hundred overlapping additive sprites
saturate their cores, and the sea grew hard-edged white lozenges — a worse
failure than invisibility, because it reads as a bug. Per-sprite opacity is now
0.11: low is right, but only once density is high, because a sheet's brightness
is supposed to be built by the stacking.

### The structural fix, first attempt: staggered birth

The lozenges were not only a brightness problem. A sheet emitted as one
simultaneous burst is a compact blob that translates downwind as a unit, and no
amount of opacity tuning makes that a veil. The first fix was to stagger each
particle's birth across a shedding window and fast-forward it, so the sheet came
out as a comet rather than a puff.

That was the right diagnosis and half the right fix. **Superseded by §5.2**,
which makes the shedding genuinely continuous over real time instead of faking
its history at birth — which is what the stagger was an approximation of.

---

## 4. Airborne salt loading

The second half of Phase 4, and it needed no new field. The foam field's active
channel already *is* "where is breaking happening right now" — in parameter
space, already advected downwind, already gusted. Read it again at altitude,
with a downwind fetch offset and a height falloff, and the mist is denser
downwind of breaking groups, gusts because the injection gusts, builds and clears
with the sea state, and cannot exist over water that is not breaking. A constant
would have needed all four faked separately and would have been fog.

Three properties keep it off the "uniform grey plane" list:

- **It is a volume.** Density falls exponentially with height above the mean
  surface and the optical depth of a straight ray through an exponential layer
  has a closed form, so this integrates a real column whose thickness depends on
  where the eye is and where it is looking. There is no altitude at which the
  camera crosses a surface.
- **It is located.** One extra texture fetch, upwind of the shading point.
- **It is lit like water.** In-scatter is the sky in the view direction plus a
  hard forward-scattering sun lobe — the same Mie behaviour as the sprites, so it
  flares downsun and stays legible upsun.

Sized so a horizon ray from the deck accumulates about one optical depth by a
kilometre, a quarter of one at 200 m and a tenth at 100 m. Verified by eye at 4×:
the distance softens progressively and the foreground stays crisp.

Its strength comes from `CrestSpray.activity`, not from the sea state directly,
so the haze and the spray can never disagree about how hard it is blowing. The
4 s smoothing on that scalar means a gust raises the spray first and thickens the
air a beat later, which is the order it happens in.

---

## 5. The second pass: what the first version got wrong

The first version shipped as sheets that Ash described as popcorn — discrete
puffs going off at random, all with the same duration, arcing over and dropping.
Four separate defects, and the first one is the root of most of it.

### 5.1 Droplets do not fall

The integrator ran `v.y -= 9.81 dt`. That is correct for a thrown pebble and
wrong for everything the sea tears off a crest, and it produced exactly the
artefact it deserved: short ballistic arcs that read as a wave *crashing over
forwards* rather than as water being *ripped away sideways*.

Spume is roughly 80 µm to 2 mm. A 100 µm droplet has a terminal velocity near
0.5 m/s; the fine fraction is not falling in any meaningful sense, it is
suspended, and an 18 m/s wind carries it tens of metres. Vertical turbulence in
the wave boundary layer runs about 0.04·U10 — 0.7 m/s here — which is easily
enough to loft the small end upward against its own settling.

There is now no gravity term at all. Each droplet relaxes towards the wind
horizontally and towards `turbulent updraft − terminal velocity` vertically, and
the relaxation time is itself derived, because the settling time constant of a
droplet *is* `vt/g`. One relation, three consequences, none of them scripted:

- fine droplets couple to the wind in hundredths of a second and stream away
  almost horizontally, travelling a long way;
- coarse ones hold their throw for a quarter of a second, arc, and fall out;
- the variety between them comes free, from the size distribution.

Measured on the running app at the Southern steady state: mean horizontal speed
17.2 m/s against an 18 m/s wind, mean vertical −1.16 m/s, and **16% of settled
droplets actively climbing**.

### 5.2 Bursts became sustained tears

Each sheet was one instantaneous burst — hence popcorn, and hence every event
having the same duration because every event had the same parameters. A crest
does not do that: it starts tearing somewhere along its length, goes on tearing
for a fraction of a wave period while it travels, and stops.

A trace now *opens a tear* rather than emitting. The tear holds parameter-space
endpoints, so it rides its crest as the wave carries it, and sheds continuously
until it closes. The plume is the history of a moving source instead of the
debris of an explosion. Around 12–22 are open at once in a Southern gale.

### 5.3 Tears got varied widths

Emission ran along the *entire* traced ridge, so every event spanned the full
width of a wave peak. That was my emitter, not the wave field. Tears now open on
a sub-segment with a width biased narrow — most are a few metres, a few run most
of the crest.

### 5.4 Two numbers became derived

Both were flat constants and both should not have been:

- **How often the sea sheds** is now set by how much breaking ridge the tracer
  actually finds. Searches run at a fixed rate as a *cost* budget; a search that
  finds nothing opens nothing. A calm sea opens no tears and a violent one opens
  many, without a number saying so.
- **How long a tear lasts** was `0.11 × dominant period`, with real jitter around
  it — so no two plumes shared a duration, which was the most obvious tell.
  **Superseded.** A tear has no duration at all now; see §7's table note.

The shed rate is still exposed as a lab slider, as a *multiplier on the derived
value* rather than as the value itself, so a change of sea state still moves the
spray on its own. The duration slider is gone with the duration.

### 5.5 Turbulence was vertical only, which was doubly wrong

Caught by Ash after the rebuild: the plumes had no lateral motion at all.

Two mistakes in one line. Every droplet relaxed towards exactly `wind × 0.96`
horizontally, and because the launch spread decays with the droplet's own `vt/g`
— hundredths of a second for the fine fraction — they converged to *identical*
horizontal velocity almost immediately and then flew in perfect parallel. And the
one axis that did have a turbulent term was the wrong one: in the atmospheric
surface layer the horizontal fluctuations are the larger ones, σu ≈ 2.4 u*,
σv ≈ 1.9 u*, σw ≈ 1.25 u*, with u* ≈ 0.05 U10 over water.

Turbulence is now fully 3D and, more importantly, **spatially coherent**. It is a
smooth field sampled at the droplet's position rather than independent per-droplet
noise, because droplets close together are inside the same eddy and must be
pushed the same way. Independent noise only blurs a plume; a shared field makes it
writhe as a body, which is what the eye reads as turbulent air. Two octaves of
sinusoid products at ~100 m and ~40 m, drifting in time, sampled at 10 Hz per
droplet in six interleaved groups.

Measured after: cross-wind velocity spread **±1.50 m/s** where it was
approximately zero, against an along-wind mean of 17.2 m/s.

### 5.6 Spindrift is gone

Folded in and deleted. Once droplets have honest aerodynamics the difference
between "fine droplets" and "sheets" stops being a difference in kind — they are
the same water at different points of one size distribution. Keeping them apart
meant two schedules, two budgets and two sets of numbers that had to be tuned
into agreeing about the same wind. The fine end of the distribution now covers
what Spindrift drew, and its ballistic "jumping fish" read went with the gravity
term.

Sprite size runs *backwards* from droplet size, which is the non-obvious part: a
fine droplet is an unresolvable mist drawn as a large soft parcel, a coarse one
is a visible individual drop drawn small and tight. That is what lets one system
cover both the veil and the glint.

### 5.7 Third pass: the emitter was visible as an emitter

Ash's review of the second pass found two more, and the second is structural.

**Droplets were launched from the air.** Spawn height was `crest + 0.15 to 0.70 m`,
put there to avoid starting a sprite inside the surface. It read exactly as it
was: a band of spray detached from the wave, hanging thirty-odd centimetres
clear of the water it was supposedly torn from. Now `crest + 0..0.10 m`. Sprites
that start half-submerged are correct and the depth test handles them.

**The tear was visible as a tear.** Each one opened, ran for a scripted duration
derived from the wave period, and closed. Head-on, the sea showed a row of
distinct point sources spaced along every crest, each switching on, running for a
beat and switching off. Two causes, both mine: the emitters were short — width
biased narrow, most only a few metres, so at any distance they were points — and
they had a scripted envelope, which is always visible as one.

The fix is to stop scripting the schedule at all. A segment now spans the **whole
traced ridge**, and carries a `weight` re-derived every frame from the *live*
breaking indicator at its own position, through the same ramp the foam shader
uses. It fades up as its crest steepens into breaking and away as the crest
passes, and it is evicted when the weight reaches nothing. There is no timer
anywhere in the emission path: how much a piece of water sheds is a continuous
function of how hard it is breaking at that instant.

Two smaller correlations went with it. Droplet position is uniform along the full
ridge, piecewise-linear through the midpoint so a curved crest is followed rather
than chorded. And the launch velocity is now drawn *per droplet* rather than once
per emitter per frame — the previous version handed every droplet emitted in a
frame the same velocity, quantising each plume into slabs of identical water.

Ash asked whether making every droplet's release fully independent — rejection
sampling the whole disc per droplet — would be affordable. It would not: about
fifteen wave evaluations per droplet, some 3,500 per frame at these rates, which
is milliseconds. What this does instead is keep an *inventory* of breaking crest
that is refreshed continuously, and sample within it in O(1) per droplet. The
statistical independence lands where it is visible, and the expensive part is
amortised across every droplet that comes off the same crest.

A duplicate check (segments closer than 7 m in parameter space) stops a
vigorously breaking crest being found repeatedly and stacking emitters on itself.

### 5.8 Fourth pass: the emitter knew what the frame rate was

Ash, looking head-on across the wind: evenly spaced vertical bands of droplets,
roughly 30 cm apart, within a single crest.

My first read of this was wrong — I measured the *segment* spacing and found the
emitter covers only about 15% of the breaking crest in strips tens of metres
apart, which is true and is a separate problem, but it is not what was being
described. The reported spacing was sub-metre.

The measurement settled it immediately. **4,711 live droplets occupied 134
distinct age values, every one of them exactly on a frame boundary.** The
shedding pass runs once a frame, so every droplet in the sea was born on the
frame clock. Each frame's cohort is a curtain launched simultaneously along the
crest; by the time the next one appears the wind has carried it

    15.91 m/s ÷ 60 fps = 0.265 m

downwind. Crests run across the wind, so a cohort is a line receding into the
screen when viewed across it — which projects as a near-vertical streak, with
successive cohorts 26 cm apart horizontally. Evenly spaced vertical bands.

**What makes it survive is what made the trajectories right.** Droplets are
launched with a real velocity spread (σ ≈ 2.1 m/s along flight) that ought to
blur 26 cm into nothing within a tenth of a second. It does not, because the drag
time constant is `vt/g` — about 0.03 s for the fine fraction — so the launch
spread is erased almost immediately and every droplet thereafter travels at
wind-plus-eddy. The curtains never diffuse. Better aerodynamic coupling preserves
birth-time structure more faithfully, so this artefact got *worse* as the physics
got better.

It also explains why the third pass reintroduced it. The first pass had a
sub-frame stagger, which was removed when shedding became continuous across
frames — exactly the moment it stopped being optional.

Fixed by giving each droplet a uniform birth instant inside the frame and flying
it forward to now: one random draw and three multiply-adds.

| | before | after |
|---|---:|---:|
| live droplets | 4,711 | 7,396 |
| distinct age values | 134 | 7,074 |
| droplets with a unique birth time | 2.8% | 95.6% |

There is a test on it, because it is invisible to every other check in the suite
and the physics actively conceals it.

### 5.9 UNRESOLVED: droplets emit from visibly discrete origins

**This is an open bug. Do not assume the notes below narrow it further than they
do.**

Ash, looking head-on at an oncoming crest: spray rises in distinct fans from
origins spaced roughly 10–30 cm apart along the crest, instead of coming off it
continuously. Reproducible, obvious in motion, and visible in a still.

Four hypotheses were tested and **all four are dead**, with numbers, so nobody
re-runs them:

| Hypothesis | Measurement | Verdict |
|---|---|---|
| Frame-quantised birth | 4,711 droplets on 134 ages, all on frame boundaries | **Real, fixed** (§5.8) — did not resolve the artefact |
| Segment coverage gaps | ~24 segments covering ~15% of breaking crest, gaps tens of metres | Real, but the wrong scale — reported spacing is sub-metre |
| Chord error in the 3-point segment | straightness 0.95, median max chord error 0.24 m | Dead |
| Fragmented crest detection | 200 m of one crest = 9 above-gate runs, median 6.5 m | Real, but again a ten-metre effect |
| PRNG correlation at spawn stride | χ²=42.5 on 49 df, lag-1 r=0.003 at the stride `spawn` uses | Dead |
| Quantised spawn positions | 580 spawns over 32.2 m of crest, **median origin spacing 3.8 cm** | Dead — origins are continuous |

What the last measurement leaves is a **density** explanation, which is
consistent but not confirmed as the whole story. Among droplets still near their
birth (age < 0.12 s):

| | |
|---|---:|
| median nearest-neighbour spacing | 1.20 m |
| median sprite radius | 0.73 m |
| **spacing ÷ radius** | **1.65** |

Neighbours sit further apart than a sprite is wide, so sprites never touch and
each renders as a separate object. Origins along the crest are continuous; the
*instantaneous* population near the crest is not, because droplets leave at over
10 m/s and only ~500 of ~7,000 are still near where they were born.

If that is the whole explanation, the fix is unpleasant: the ratio is
scale-invariant — doubling count while halving radius leaves it unchanged — so
only **total sprite area** moves it, and that is fill rate. Continuity would cost
roughly 3–4× the spray's current fill.

**An across-crest scatter was tried and reverted.** Spawning exactly on the
traced polyline does give the source zero width, which is a genuine defect and
worth fixing on its own merits; but scattering across the crest did not resolve
this artefact, so it is out rather than sitting in the code unjustified. Re-add
it deliberately if the source-width question is taken up.

The diagnostic setup that makes this visible at all: **foam off, salt off, spray
strength 8×, camera on a breaking crest.** Against dark water the structure is
unmistakable in one frame. Several of the dead hypotheses above cost real time
because they were reasoned about instead of looked at.

---

## 5c. A measurement that was wrong twice, and how

Worth recording because both readings were confidently produced and both were
rubbish.

**A frozen wave clock inflated the live count by 3×.** An early cost harness
called `crestSpray.update` in a loop without advancing `waves`, so no crest ever
stopped breaking, no segment ever evicted, and the population climbed to 14,163
and kept going. With the clock running the same configuration self-regulates to
between two and six thousand. Anything that measures this system has to advance
the wave field, because the whole eviction rule is a function of it.

**A single timing leg read 4x high.** One paired run reported 1.97 ms of
spray-only cost; six alternating pairs immediately afterwards gave a median of
0.467 ms with a spread of 0.27 to 0.64. The spread is real — live count and
segment count both oscillate with the wave and gust phase — but the 1.97 was not.
Single legs are not a measurement here; the whitewater round's alternating-pairs
method is, and it is the one the numbers below come from.

---

## 5b. A whitewater finding, outside this round

`FOAM_COVERAGE_GAIN` is **not** the problem I claimed in the first draft of this
report — that was a single unrepresentative frame and Ash tuned the value against
this sea. It stays at 3.2.

The real gap is one Ash named: whitewater should come tumbling down a wave face
from the top with power, and it does not. `FoamField` injects foam where the
crest is breaking and then advects it **uniformly downwind** at
`windAdvection × windSpeed` — 1.35 m/s in this preset — with a single scroll
vector for the whole texture. There is no transport down the wave face at all.
So a breaker deposits a white line at the crest and that line sits there ageing
while the wave moves out from under it.

The fix is to make the advect pass per-texel: carry foam along the local
downslope in the wave's propagation direction, scaled by how hard that texel is
breaking. The inject pass already evaluates the wave sum per texel, so the
machinery exists; the cost is roughly doubling that evaluation.

That is a whitewater change, not a spray change, and it is probably the larger
of the two remaining wins.

## 6. Cost

CPU, desktop tier, Southern steady state, six alternating A/B pairs with the wave
clock running in both legs:

| | ms/frame |
|---|---:|
| **Spray, median** | **0.47** |
| range across pairs | 0.27 – 0.64 |

At 2,000–6,500 live droplets in 9–29 segments, which is a real oscillation with
the wave and gust phase rather than measurement noise. Pool capacity is 16,384,
so roughly 60% headroom at the peak.

Where it goes: 84 `sampleSeed` calls per frame at 2.43 µs each is 0.20 ms, and
that is the floor. **Segments are the dominant cost, not droplets** — each one
needs three full wave evaluations per frame to stay registered on a crest that is
moving, at forty-eight components of sin and cos apiece, while a droplet costs
about a tenth of one trig call. `maxSegments` is the lever if this ever needs to
come down.

The parameter-space decision is most of why the first line is that small: a
`sample()`-based tracer would have paid the seven-iteration inverse solve on
every probe.

**GPU cost is not measured and that is a gap.** This is a fill-rate system —
8192 additive quads with large screen coverage — and the whitewater round
established that GPU timing in an agent's browser pane is worthless, because the
pane does not composite while hidden so timer queries never retire. It needs the
same treatment that round used: real headless Chrome with `--enable-gpu
--use-angle=metal`, driven by a `?perf=` URL, paired A/B. I have not built that
harness for this layer.

---

## 7. What is tuned by eye and wants your judgement

Everything in this table moved during bring-up and none of it is settled. All of
it is on live lab controls under **storm spray** in the Ocean laboratory —
sheet on/off, sheet strength, salt loading, salt scale height — because the
failure modes here are only visible in motion. A still frame cannot distinguish a
streaming veil from a blob sliding across the water.

**Re-read against the code on 2026-08-17, and five of the six rows had gone
stale** — two renamed, two moved, one deleted outright. A parameter table is
read by whoever is about to size a change against it, so a row that is out by a
factor of 2.9 is worse than no row at all. Corrected below; the old values are
kept beside the live ones because the ratio is the useful part.

| | value | was | slider | what it trades |
|---|---:|---:|---|---|
| `SPRAY_OPACITY` (`CrestSpray.ts`) | 0.0385 | 0.11, as `SHEET_OPACITY` | — | thin wash ↔ saturated slab |
| `particlesPerMetreSecond` | 18 desktop / 6 mobile | 30 | Shed density | grit everywhere ↔ dense local plumes |
| `SALT_DENSITY_FULL` (`Ocean.ts`) | 0.00385 /m | 0.0011 /m | Salt loading | how far you can see |
| `SPRAY_SUN_GAIN` (`CrestSpray.ts`) | 0.30 | 0.30, as `SHEET_SUN_GAIN` | — | invisible ↔ glowing |
| `searchesPerSecond` | 36 | 36 | cost budget; also caps how many plumes exist |
| ~~`SHED_PERIOD_FRACTION`~~ | **gone** | 0.11 ×Tp | ~~Tear duration~~ | the concept was removed, not renamed — see below |

Three things the corrections say that the numbers alone do not:

- **`SHEET_OPACITY` → `SPRAY_OPACITY` is a rename AND a 2.9× reduction.** The
  rename is deliberate and the code says why at its declaration: "an earlier
  version called this `SHEET_OPACITY`, from a design in which a *sheet* was an
  object the system built; there is no such object any more."
- **`SHED_PERIOD_FRACTION` no longer exists**, and neither does the tear
  duration §5.4 describes as derived. `CrestSpray`'s tear "has no duration, and
  that is the point"; `Segment` carries no lifetime field and `OceanLab` says
  "there is deliberately no duration control any more". §5.4's second bullet and
  its closing sentence are therefore history rather than description — left as
  written, because this is a report of a round, but do not size against them.
- **The "Sheet strength" slider is now "Spray brightness"**, and it does not
  drive `SPRAY_OPACITY` at all: it moves the `uStrength` uniform. Two different
  levers with one old name between them.

Salt loading is **settled at 0.6 of the first pass's value** by Ash's eye. The
salt scale-height control was removed: for the near-horizontal rays that matter
the column integral collapses to roughly `distance × exp(-y/H)`, so it was very
nearly degenerate with the loading slider and was not earning its place.

My own read: the sheets now behave — they follow real ridges, they stream
downwind, they elongate and shred — but I would not claim they read as a gale
yet, and I could not fairly test that against a sea which is 55% saturated white.
The foam decision comes first.

---

## 8. Not done

- **GPU cost bracket** (§6). The one real gap.
- **Evidence-sheet integration.** The violence contact sheet does not yet take a
  spray on/off pair. The lab toggle exists; the pinned capture does not.
- **The attached root.** A genuine connected film in the first metre at the lip,
  where the water really is a sheet still attached to the crest — that is what
  would say "torn off *that* wave" rather than "a cloud appeared here". The
  swarm should be judged first; it may not need it.
- **Sky-side salt.** The layer thickens the water but not the sky just above the
  horizon. From the deck the discontinuity is small because the ocean disc covers
  everything up to the horizon, but it is a real seam and it will matter more from
  a raised camera.
- **Mobile is untested on a device.** The quality tier keeps the sheets and thins
  them, which is the right shape per the handover, but it has only been reasoned
  about, not run.
