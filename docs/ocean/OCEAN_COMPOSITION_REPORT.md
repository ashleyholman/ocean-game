# Ocean Composition Round — Report

## What this round was

The sea-state round replaced six hand-tuned Gerstner waves with a physically
calibrated spectral model — and the ocean got *worse* to look at. This round
diagnosed why and fixed it at the level where the fix generalises: the
discretisation policy, not the presets.

The diagnosis, in one paragraph: the statistical discretiser (equal-m₁ bins,
stratified cos^2s directions) is the honest way to approximate a Gaussian sea,
and a Gaussian sea with a broad fan at one dominant scale IS an egg-carton
interference field — the "ski moguls". The old hand-tuned ocean read better
because it was a *composition*: 64 % of its variance in one dominant 62 m
component, riders at distinct scales on distinct headings, fractal noise below
3 m. Beauty came from hierarchy, anisotropy and nonlinearity; the spectral
sampler destroyed all three while being more correct statistically.

## The compositional policy (`src/ocean/spectrum.ts`)

The spectrum still sets the energy budget — per-system Hs is exact for the
resolved band — but a fixed compositional policy decides how it is spent.
Taste is encoded once, in `COMPOSITION`, and every state inherits it: presets,
lab slider positions, and every intermediate state of a weather morph.

Per system, slot roles are static and every parameter is a continuous function
of the physical inputs (no sorting, no data-dependent counts — this is what
keeps morphs pop-free):

- **Carrier** (slot 0): the spectral peak on the mean heading, ~40 % of the
  system's variance. The legible dominant train.
- **Sidebands** (pairs at fp ± j·σf): on (nearly) the carrier's heading.
  Near-frequency + same heading = amplitude modulation = groups and sets.
  Near-frequency + different headings = moguls. That distinction is the whole
  fix. Spacing still comes from `groupiness`, so set length remains physical.
- **Fan / ladder**: the stated directional spread is expressed across *scale*:
  progressively shorter components on progressively wider headings, one per
  scale step, each step ≥ ~1.3× from its neighbours. For swell this is the old
  ocean's 62/34/19.5/10.4 m shape restated as policy; for the wind sea it is a
  0.72-ratio ladder from the peak down to the 3.5 m floor.
- **Bound harmonic** (last slot): a phase-locked Stokes second harmonic of the
  carrier — ω is exactly 2ω_carrier (not free dispersion), phase is
  algebraically slaved (`2·carrier + offset`), Q = 0 so it cannot fold and
  leaves the inverse solve untouched. It peaks crests, flattens troughs, and
  leans the crest forward with band sharpness. No shader changes were needed:
  it rides the existing uniform table, so CPU/GPU parity holds by construction.

Amplitudes are normalised against the **ungated** weight sum, then each slot
applies its own resolution-floor gate. A system sliding under the floor fades
each component individually and hands the gated energy to the unresolved band
(which drives the detail noise) — normalising against the gated sum instead
props the last survivor up with the whole budget and then pops it to zero,
which is exactly what the trajectory tests caught.

## Derived quantities replacing hand-tuning

- **Detail-noise amplitude** is now `0.62·√(unresolved slope variance)`
  (`WaveField.detailAmplitude`), calibrated once to reproduce the pre-round
  0.105 at the shipping moderate ocean. Preset `detailStrength` became a
  dimensionless gain (default 1). The texture now tracks the wind physically
  across every weather state.
- **Whitecap threshold** is calibrated against the field's actual
  carrier-plus-Gaussian distribution (`breakingThresholdComposite`, solved by
  bisection), not a Gaussian the composed field deliberately is not. Measured
  exceedance: SOUTHERN 9.1 % vs Monahan 6.0 % (−0.3σ art bias), WIND_CHOP
  0.75 % vs 0.69 %, CURRENT 0.05 %.
- **Q cap** (`safeCompositeQ`): top three steepness terms taken at their
  deterministic worst, the tail at 3.2σ, held at 0.95 of the fold. Dominant
  carriers run visibly steeper than the old all-Gaussian bound allowed and the
  no-fold guarantee is stronger where it matters.
- **Wind validity ceiling**: wave growth sees `effectiveGrowthWind` — identity
  to 24 m/s, smooth saturation never exceeding 32 m/s (the edge of the
  JONSWAP/Cox–Munk/drag validity domain). Whitecap coverage, streaks, spray
  and foam channels keep the raw wind, so a 40 m/s squall reads angrier than a
  32 m/s gale without asking the representation for a 50 m sea. The lab wind
  slider deliberately runs to 40 to exercise this.

## Presentation fixes in passing

- **Living ripples**: the fragment detail octaves each scroll at the
  gravity-wave phase speed of their own cell size on their own heading
  (`uDetailScroll`, CPU-integrated in double precision, wrapped exactly in
  each octave's lattice). The old single shared scroll translated the whole
  fractal rigidly — "painted spots" — and, incidentally, upwind. Octaves now
  shear across each other and the texture churns.
- **Spindrift**: additive blending (a droplet spatter transmits its backdrop
  and adds scattered light; alpha blending rendered spray as dark clumps —
  "birds" — against any sky brighter than the sprites). Droplet colour is
  desaturated toward luminance (Mie scattering is achromatic — that is *why*
  spray is white), launch velocity takes ~half the wind instead of a fifth,
  and drag tightened so it streams rather than floats.

## Contracts, tested

`tests/composition.test.ts` is the policy's contract — perceptual invariants
asserted over every production preset AND swept along a storm→calm arc, so any
state a future weather system reaches inherits them:

- carrier dominance (variance share > 25 %, 1-vs-2 ratio away from the floor);
- directional coherence (amplitude²-weighted resultant > 0.82 per system);
- anti-mogul bounds (crossing energy at any one scale stays subordinate, with
  the crossing angle floored at ~20° absolute — below that, interference is
  finite-crest texture, not egg-carton);
- bound-harmonic lock through time, morphs and origin shifts, to 1e-9 rad;
- first-order continuity of every slot along the arc (halving the blend step
  halves the worst amplitude delta — the property a pop cannot fake);
- ceiling saturation, derived-detail calibration and ordering.

The existing sea-state suite still passes with three deliberate amendments:
quadrature holds to the floor-gated fraction (< 1 %) rather than exactly;
bound harmonics are exempt from the distinct-direction rule (they are the
carrier's own profile); the phase-continuity bound reflects carrier
concentration (2 % blend step ≤ 0.12 m, 0.1 % step ≤ 1 cm, ratio-bounded).

One pre-existing identity bug fixed on the way: a system whose spectral
support collapsed (e.g. DEAD_CALM's 0.6 s wind sea) short-circuited without
emitting its slots, silently shifting every later slot's identity.

## Verified visually

Side-by-side against 1765bb7 (the reference ocean) and master, matched time
(18:36 solar), matched location: the moderate ocean now reads as one dominant
swell with groups, crossed by distinct-scale riders over churning fine
texture — no moguls, and the far field keeps serrated structure instead of
ruled lines. Master's SOUTHERN_OCEAN_ROUGH at the same view is a uniform
egg-carton; this branch's is organised trains. Mid-band "worked water" weight
was re-tuned live against user feedback (the first calibration starved the
riders at ~8 % of system variance; they now carry ~19 %, close to the old
ocean's share).

## Known limitations, unchanged and deliberately untouched

These are graphics-round scope (stage 3), and were confirmed pre-existing by
A/B against master:

- far-field specular bleach in energetic seas (whole horizon blows out toward
  the sun in daylight);
- foam *shading*: whitecaps are barely visible in bright light, and can render
  darker than the specular-blown water around them (including occasional
  hard-edged dark patches at the foam window edge). Foam **generation** is
  calibrated (numbers above); its lighting is booked for the graphics round.
- foam chunk-stepping: the structural cause this round could remove is removed
  (breaks no longer fire on a regular interference lattice synchronised per
  group). Re-verify once foam is actually visible after the lighting round;
  if residue remains, threshold jitter in `FoamField` is the knob.

## For the graphics round

Handed off deliberately unresolved, because every one of these is a lighting
question wearing an ocean costume:

- far-field specular bleach in daylight (whole horizon blows out sunward);
- foam shading: whitecaps near-invisible in bright light, occasionally darker
  than the specular-blown water around them, hard-edged dark patches at the
  foam window edge;
- foam *quantity* is sensitive to `microChop` at extreme states even though
  the exceedance area is calibration-pinned: the injection shader credits
  compression in the `[0.8·T, 1.25·T]` band below/around the threshold, and
  micro chop widens that band in absolute units. When foam appearance is
  retuned under the new lighting, express that band in units of the field's
  σ rather than of the threshold, or narrow it;
- re-verify foam chunk-stepping once foam is actually visible — the
  structural cause (breaks on a regular interference lattice) is gone, but
  the visual confirmation was impossible under the current foam shading;
- `microChop` preset defaults were set under the old lighting and should be
  re-judged once micro-scale structure is actually legible.

Tooling: `.claude/launch.json` carries a `drift-master` entry (port 5180)
that serves whatever the MAIN worktree has checked out — check out any
comparison commit there (pre-composition master, 1765bb7, a mid-round state)
and run it beside the working branch on 5174 for matched-lighting A/B, the
same workflow this round used to separate its own regressions from
pre-existing ones. Stage both sides identically: same preset, same paused
solar time, same location.

## For the weather round

Drive the *physical inputs* through `blendSeaState` (or your own relaxation
dynamics on wind/swell parameters); do not interpolate component tables. Every
intermediate state satisfies the invariants above by construction, slots keep
identity, and phases are carried by `WaveField.applySeaState(state, true)`.
Wind above the ceiling is safe and encouraged — presentation channels keep
scaling. `POST_STORM_SWELL` as a preset should eventually become what a
storm's swell *turns into* under your decay dynamics rather than a fixed
point.
