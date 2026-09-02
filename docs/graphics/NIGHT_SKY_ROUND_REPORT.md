# Night-sky round — stars, cloud occlusion, Milky Way

Three complaints, three causes, all found and all fixed. Two of the three were
arithmetic rather than taste, which is why they had survived several rounds of
looking at the sky and calling it "fine".

## 1. Every star the same brightness

Two independent causes, both measurable.

**The photometric exponent was halved.** `StarField` computed
`pow(10, -0.23 * m)` where the law is `-0.4`. That is a little over half the
stops. Measured on the shipped 4.5-limited catalogue, the consequence:

| mag bin | stars | display value, old | display value, now |
|---|---|---|---|
| 1.5 | 27 | 0.54 | 0.39 |
| 2.5 | 80 | 0.42 | 0.25 |
| 3.5 | 232 | 0.33 | 0.15 |
| 4.0 | 393 | 0.29 | 0.12 |

**739 of 925 stars — four fifths of the sky — landed between 0.25 and 0.33.**
A 1.3× spread across almost every star on screen. Not a perception problem.

**The catalogue had no faint end.** It stopped at magnitude 4.5 while
`limitingMagnitude` reaches 6.2 at astronomical night, so the faintest star the
game owned was still 1.7 magnitudes clear of the threshold. Nothing could be
"barely there" because there was nothing faint to draw.

Fixed by:

- Regenerating the HYG subset at magnitude 6.5 — 8,920 stars, up from 925.
  Field precision was cut to what a pixel can resolve at the same time
  (0.15 arcsec in RA), which paid for most of the growth: 360 KB of source,
  118 KB gzipped.
- Restoring the `-0.4` exponent, pivoted about second magnitude so the familiar
  sky holds its level while the range opens above and below it.
- Replacing the magnitude-thresholded halo with **glare driven by over-range
  amount in stops**. Past display white a point cannot get brighter, only
  bigger; the extra range has to arrive as area. Because it reads the star's
  final intensity, extinction, twilight and cloud now shrink the halo along
  with the core, with no second threshold to drift out of step with the first.

A test now asserts the catalogue floor lies below the darkest limiting
magnitude the world can produce, so this cannot silently regress.

### Revision: the first pass was far too hot

Shown on screen, the first attempt read as "massive objects in the sky — I
thought it might be the moon". Correct, and the cause was the pivot. Anchoring
at magnitude 2 *and holding its old level* meant the physical exponent pushed
the bright end up rather than pulling the faint end down. Measured against this
renderer, intensity 0.32 already saturates a pixel, and that anchor put
magnitude 2 at 0.347 — so everything from second magnitude up was clipped and
Sirius sat five stops past white, earning the maximum halo.

Two changes, both measured:

**The pin moved to the faint end**, magnitude 5, at 4.4× lower level. The
population, counted as star pixels standing a given excess over the sky they
sit on (differenced against the same frame with the pass hidden, so the Milky
Way and the sky gradient cancel), over a 1209 × 916 window:

| anchor | +3 codes | +8 | +20 | +60 |
|---|---|---|---|---|
| 0.0219 — first pass | 1810 | 1194 | 668 | 192 |
| **0.0100 — shipped** | 1325 | 809 | 408 | 112 |
| 0.0050 | ~800 | ~440 | ~190 | ~40 |
| 0.0013 — too dark | 250 | 95 | 27 | 7 |

The mass of the catalogue now sits in the 3–20 band: present, but a tinge over
the sky rather than something the eye reads without trying.

**The glare shrank.** Widest sigma 3.9 → 1.7 device pixels, onset raised so
only about a dozen stars glare at all. Measured on the brightest star in a
quadrant, the width of its footprint standing more than 20 codes over the sky:

| max sigma | width above +20 | skirt |
|---|---|---|
| 3.9 | 18 device px | still +22…+108 out at 6–12 px |
| 1.7 | 8 device px | gone by 5 px |
| **1.0 — shipped** | 6 device px | essentially just the core |

### Revision: adaptive resolution was breaking both of these

Reported from the wheel: when the adaptive cap drops, the halos grow and the
faint stars brighten. Both real, both the same root cause — every pixel figure
in `StarField` is in RENDER pixels, and adaptive resolution lowers
`setPixelRatio`, so the buffer shrinks and the browser upscales it back. A
render pixel is not a fixed piece of the screen.

- **Halo grew** because a sigma fixed in render pixels covers twice the angle
  when the ratio halves, and the upscale shows that one-for-one.
- **Faint stars brightened** because the core PSF is normalized to unit
  integral over render pixels, so its peak per render pixel is
  scale-independent — but each of those pixels is then displayed over four
  times the area. A star that was one dim pixel became a 2×2 block of the same
  brightness.

Fixed by scaling halo sigma with the render scale (angular size held) and the
core normalization with its **square** (displayed light held). The core's own
sigma is deliberately not scaled: 0.56 is a sampling floor, and going under it
is what makes points alias as they cross the grid. Measured at half resolution
against full:

| | displayed light | angular width |
|---|---|---|
| before | **4.02×** | **2.0×** |
| after | 0.85× | 1.33× |

The residual is the Nyquist floor doing its job — at half resolution a star has
to be angularly larger, but it now dims as it spreads rather than blooming. The
reference ratio is 2, so at full resolution the correction is exactly 1 and
nothing about the tuned look moves.

One measurement trap worth recording: **half-resolution screenshots lie about
this.** A faint star is one pixel, and a 2:1 downsample divides its excess by
four, so a downscaled capture of this sky looks far emptier than the sky is.
Judge it at `?fixedDpr=1` with the viewport matching the capture, or trust the
pixel counts.

## 2. Stars visible through cloud

The wiring was correct — the star pass and the sky read the same live uniforms,
the same atlas address, the same opacity. The **law** was wrong, twice.

**The alpha has a ceiling below one.** `cloudBake` writes
`(1 - transmit) * fade` with the march exiting at `transmit < 0.01` and
`fade = haze · horizonFade · cloudRes`. So the densest cloud the bake can
express reports:

| elevation | max alpha | starlight through solid deck |
|---|---|---|
| zenith | 0.935 | 6.5 % |
| 30° | 0.884 | 12 % |
| 15° | 0.795 | 20 % |

And none of those fades are holes: haze is atmosphere *in front of* the cloud,
`cloudRes` is a Nyquist retirement of detail.

**Linear `1 − α` is not a beam transmittance.** That alpha describes a
scattering slab's appearance. A star is a delta-direction beam, and cumulus
runs to optical depths in the tens, so the honest answer is `exp(-τ) ≈ 0`.

Fixed by raising transmittance to a power — `(1-a)^k == exp(-k·τ)` — with
`k = 5`. A wisp at alpha 0.3 still passes about a sixth of a star, which is
what a real veil does; the densest bake alpha now passes one part in a million.

## 3. No Milky Way

HYG carries no diffuse information, and no catalogue extension reaches it: the
band is magnitude 8–20 stars, hundreds of times more numerous than anything
worth drawing as points.

Source: the **diffuse galaxy layer** of NASA SVS *Deep Star Maps 2020*, in
galactic coordinates (CC BY, Gaia DR2). It is published separately from the
resolved `starmap` layer, which is exactly what we want — our 8,920 points are
the resolved stars, so compositing the diffuse layer adds the galaxy without
counting them twice.

- Baked to 480 × 240 (0.75°/texel) by area-average **in linear light**, split
  into a luminance plane stored as `linear^(1/4)` and a quarter-resolution
  flux-weighted chroma plane. 174 KB of generated TypeScript, 72 KB gzipped,
  decoded to `DataTexture` at start-up — the project still ships no binary
  assets and loads nothing asynchronously.
- 240 × 120 was tried and rejected: the Great Rift and the Magellanic Clouds
  smear into the general glow, which loses the only thing a real map buys over
  a procedural band.
- The galactic frame is built from the IAU pole and centre directions rather
  than a copied matrix, and verified against five real objects (LMC, SMC,
  Polaris, Sirius, Deneb) to within 0.1°.
- Composited into `base` **before the cloud over**, so cloud occlusion, the
  moon's aureole and the twilight gradient all apply with no extra code.

**Brightness is measured, then deliberately departed from.** The real contrast
is about 21 mag/arcsec² against a 22 mag/arcsec² sky — a factor of 2.5. Read
off the running night sky, the background sits at 12.4/255 (0.0038 linear), so
the peak addition wanted is 0.0057 linear; a rendered gain ladder put the band
at 0.0080 linear per 0.02 of gain, giving **0.015** as the faithful figure.

**What ships is 0.008 — 0.53× that**, chosen at the wheel, and the reason is
one the measurement does not capture: 2.5:1 is the *peak* of the band against a
pristine sky, whereas what someone standing on a deck reports is barely seeing
it at all. The number describes a photometric maximum; the experience is a
faint uncertainty in the sky that resolves when you stop looking straight at
it. Two things also push the faithful figure to read stronger in this renderer
than the arithmetic suggests: the star field standing inside the band is denser
than the measurement accounted for, and this sky's night floor is a
photographic rendering rather than a pristine 22 mag/arcsec².

The measured figure stays in the code as `MILKY_WAY_MEASURED_GAIN` and the
panel reports the gain as a multiple of it, so the size of the departure is
always on screen — in either direction — rather than buried in a constant.

Visibility is driven by `limitingMagnitude`, so it fades late in astronomical
twilight and a full moon erases it (visibility 0.02 at limiting magnitude 5.0) —
which is what the real thing does.

## Judging it yourself

Graphics panel, six new controls, all live with no recompile:

- **stars → Magnitude exponent** — 0.230 legacy flat ↔ 0.400 physical
- **stars → Faint-end level** — 0.2× ↔ 4.8× the shipped level; moves the whole
  ladder, since it is the rung everything else is measured from
- **stars → Glare size** — reported as the sprite it forces, not as sigma; 3.9σ
  is the 23-pixel version that read as a moon
- **stars → Cloud beam power** — 1.00 legacy linear alpha ↔ 10 optical depths
- **milky way → Peak gain** — off ↔ 4× the measured value
- **milky way → Chroma** — grey (as the eye sees it) ↔ full (as photographed)

The chroma default is 0.55. There is no physical answer: at this surface
brightness the eye is on rods and the real band is colourless. The tan core is
photographic, and this world's night already is too, so it is a taste call.

## Where the navigational stars sit

Worth recording, because it decides whether pulling the faint end down can ever
cost the game anything. All 58 stars of the Nautical Almanac list — the 57 plus
Polaris — are present in the catalogue by proper name, and:

- Every one is brighter than magnitude 2.88 (faintest: Acamar). Median 1.79.
- All 58 fall inside the brightest **179 of 8,920** records — the top 2%.
- 15 of the 16 stars in the entire sky brighter than magnitude 1 are on the
  list; so are 38 of the 50 brighter than magnitude 2.

So the navigational set lives entirely at the top of the ladder, where stars
are unambiguous. Everything this round did to the faint end — 8,000 new records
below magnitude 4.5, the anchor pulled down — happens strictly below the stars
a navigator would ever shoot. A future sight-taking or star-identification
feature is not competing with the changes made here.

## Not closed

**Three ship tests fail under parallel load** — `ship-deck`,
`ship-hydrostatics`, `ship-response` — and they fail identically on a clean
tree with this branch's work stashed. They are per-test timeouts on long
physics runs, not assertion failures, and all three pass in isolation.
Pre-existing, not this round's, but worth a look.

> **Closed 2026-08-16** by the correctness-and-truth round, and the answer was
> not quite the three named here. `ship-hydrostatics` and `ship-response` were
> given explicit 120 s budgets by rounds in between and no longer time out.
> `ship-deck`'s sweep was moved behind the `slow` tag, which took it out of
> `npm test` but left `npm run test:slow` exposed to the same contention; it now
> carries a 120 s budget too. The test that actually times out today is a
> different one — `interior-light-runtime`'s "shows the shut forecastle no
> sunlit fitting through its own deckhead", the heaviest test left in
> `npm test`, which used about half the 60 s default on a quiet tree and blew
> straight through it under parallel load. It now carries 240 s. Full suite
> green under load afterwards. The reusable half: a heavy test that merely
> *fits* in the default budget is not safe, because `vite.config.ts` records
> 3-6x wall-clock inflation on a contended machine — half the budget quiet is a
> failure waiting for company.

**GPU cost is unmeasured.** The structural argument is that it is small — the
star pass is one draw call whose fragments total roughly 166k against the sky
pass's 1.37M, and the sky gains two texture fetches gated to night — but I could
not get a trustworthy number. `gl.finish()` does not measure GPU time in the
browser pane, and the in-page timer-query profiler needs the real frame loop to
drive it. This wants the headless-Chrome method
(`--enable-gpu --use-angle=metal`, paired interleaved blocks) on a quiet GPU.
