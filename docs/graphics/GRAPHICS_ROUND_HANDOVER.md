# Graphics round — checkpoint handover (session 3)

This is a HANDOVER, not a completion report. The brief remains
`docs/archived/upcoming-prompts/graphics-prompt.txt`; the design docs remain
`docs/graphics/VISUAL_LIGHTING_SPEC.md` / `docs/graphics/VISUAL_REFERENCE_NOTES.md`, both of which still
describe session 1 and now need updating for sessions 2 and 3.

Session 2's handover is in the git history of this file; its workflow notes
still hold except where this file corrects them.

## CLOUD VOLUME — DONE (session 5)

Ash: *"can you please try adding more volume to our clouds?"* The plan the
previous session left here was followed almost exactly, and it worked.

The diagnosis it left was right: the machinery for silhouettes and fire was
already in `cloudLayer()`, but the FIELD was a 2D pancake, so `depth` rarely
exceeded ~0.3, nothing was optically thick enough to silhouette, and with
nothing dark there was nothing for a bright edge to blaze against. What landed:

1. **A real 3D field — at the second attempt. READ THIS BEFORE TOUCHING THE
   FIELD.** The first attempt was `density = coverage2D(pm + shear * (h - 0.5))
   * profile(h)`, which is what the previous handover suggested and is
   **wrong**: a 2D field translated with height is a sheared extrusion, still
   one shape. Every march step drew the same silhouette offset a little, and
   because a typical column is only two or three steps tall, the sky came out
   as *three stacked cut-outs*. Ash spotted it immediately, at sunset, where
   the offset copies are lit differently and so are unmissable.

   What is there now follows Guerrilla's Nubis architecture instead: the 2D
   field is demoted to a **weather map** — sampled ONCE per pixel, supplying
   only where cloud is (`cov`) and how tall it grows (`tower`) — and the
   structure the march exists to resolve comes from a genuinely 3D field:
   `cloudLumps`, a domain-warped fbm of `vnoise3` (`GLSL_COMMON`), subtracted
   from the profiled shape so what survives reads as a heap of bulges. (It was
   a billow basis, `abs(2v - 1)`, for two passes — see the swirls entry below
   for why the fold had to go.) `cloudProfile` still supplies the flat base —
   condensation begins at one altitude, so every base in the sky lines up —
   and the dome that closes early for a tuft and late for a tower.

   Splitting it this way is *also* what made the march affordable: the 2D
   silhouette is a function of (x, z) and does not need re-deriving eight
   times, so the per-step cost is one 3D billow instead of three 2D fbms.
2. **A view march**, `CLOUD_MARCH` steps bottom-to-top through the slab,
   accumulating transmittance and in-scattered radiance. The old single-sample
   `lean` hack is gone: it was faking exactly the base-to-top parallax the
   march now has honestly. Horizontal travel is bounded to `CLOUD_SPAN_CELLS`
   because the geometric figure is thirty cells at three degrees of elevation,
   where an unbounded march samples a different cloud at every step and
   averages them into boiling mush.
3. **Multiple-scattering octaves** replace the old two-lobe `faceLit` term.
   Three Beer terms with shrinking extinction and phase anisotropy: the first
   is single scatter (the sharp forward lobe, the ignition), the last is the
   near-isotropic diffuse light that keeps a two-kilometre core luminous
   instead of black. The similarity relation is why the later octaves are
   attenuated at a fraction of the geometric depth — get that wrong and thick
   cumulus come out as holes in the sky.
4. **Coverage** `uCloudCover` 0.50 → **0.55**, and `uCloudOpacity` 0.85 → **1.0**.
   The first is a composition restoration, not a taste change: thick cores are
   opaque now, so the same threshold covered visibly more sky than the
   composition round approved. The second is a correctness fix — 0.85 was a
   global dimmer on a layer that could never reach optical thickness, and
   against real cores it is a flat 15 % of blue sky shining through the middle
   of every cumulus.

Two things changed contract, both deliberate:

- **`cloudLayer()` now returns PREMULTIPLIED radiance.** A march accumulates
  radiance and opacity together; dividing one back out only to multiply it in
  again amplifies noise exactly where the layer is thinnest. All three call
  sites composite with `sky * (1 - a) + rgb`.
- **The moon no longer rides `sunUp`.** It did, which meant the only light a
  night cloud had went out exactly when the moon became the reason to look up.
  Moonlight now rides the sky term. Verified against a full moon at 47 degrees.

**Extensibility, which Ash asked for explicitly.** The weather round's levers
are `cloudDensity` (world position + normalised height in, density out),
`cloudProfile` (the per-column height gradient a per-TYPE gradient generalises),
`cloudCoverAt` (the weather map, where a cloud-type channel plugs in) and the
shape constants above them. Promoting those to uniforms is most of what stratus
decks and storm towers need; the light transport below does not have to know.
The layered-altitude design that builds on all of it is written up separately
in `docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`.

**Evidence and measurement.**

- `tools/cloud-evidence.js` — sky-view harness. Aims relative to the SUN rather
  than to a compass, so an A/B compares the same three lighting geometries at
  every hour; pins the drift offset, so before and after look at the same
  clouds. `install()`, `hold()`, `show(azFromSun, el, fov)`, `matrix(tag)`,
  `stability()`, `profile()`.
- Temporal stability, rms display levels per frame of cloud drift, measured at
  three view geometries (this is the aliasing hunt's own metric, put to the
  cloud field — a march multiplies samples per pixel and is exactly the change
  that could have brought the static back):

  | view | 2D pancake (pre-round) | sheared extrusion | 3D field (now) |
  |---|---|---|---|
  | cross-sun, 20 deg | 0.065 | 0.068 | 0.054 |
  | cross-sun, 8 deg | 0.046 | 0.049 | 0.042 |
  | sunward, 14 deg | 0.057 | 0.064 | 0.065 |

  Unchanged within noise across all three states — the 3D field did NOT bring
  the static back, which was the live risk given a march multiplies samples per
  pixel. Peak per-pixel step rose from 1 to 2–4 levels, which is the silhouette
  edges the round exists to create having genuine contrast across them, not
  resampling.

- **Ray-start jitter was not taken, and that was MY call, not a policy.** It is
  the standard cure for march banding (Toft et al. 2016 measure 8 steps +
  jitter + TAA as matching a 128-step reference), but every source pairs it
  with temporal AA and this codebase had none at the time. (Corrected
  2026-08-16: an *ocean* TAA now exists — `src/render/OceanTemporalResolve.ts`,
  opt-in behind `?oceanTaa=1`, off by default. There is still no global or cloud
  TAA, so the call below stands; only the blanket "none" was false. And note
  what happened when a per-pixel jitter was tried anyway: at cache-texel rate it
  magnified into a comb and had to be deleted — see
  `docs/clouds/CLOUD_SHAPE_FINDINGS.md`. A cloud TAA's jitter must be temporal
  across bake sweeps.) An earlier draft of this
  section said "deliberately NOT taken", which read as settled policy; Ash has
  since said plainly that TAA is on the table and they may run a round for it.
  The recommendation and its measured numbers are written up under "Temporal
  anti-aliasing" in `docs/graphics/GRAPHICS_TODO.md`. If TAA lands, jitter plus a much LOWER
  `CLOUD_MARCH` is a net perf win here, not a cost.
- `tests/shader-source.test.ts` now guards the GLSL/TypeScript constant parity
  for the whole cloud field, step count included. Mirror desync is silent —
  nothing crashes, no numeric test fails, the sky just stops agreeing with the
  light on the water — and it is the failure this work is most likely to cause.

**Two traps this cost an hour each — both worth knowing.**

- **A noise field's USEFUL range is not its theoretical range.** `abs(2v - 1)`
  on value noise looks like it spans 0..1. Sampled 200k times it is mean 0.30,
  p05 0.08, p95 0.59 — value noise interpolates uniform hashes, so it clusters
  hard around its mean and `abs()` of it clusters near zero. Used raw, the
  erosion term was a near-CONSTANT subtraction: it thinned every cloud
  uniformly while *looking like it did nothing*, and changing its frequency
  changed nothing visible because there was no shape in it to rescale.
  `cloudLumps` now stretches its own measured p05..p95 onto 0..1. Measure the
  distribution of any new noise basis before tuning anything that consumes it.
- **An erosion term has to be commensurate with what it erodes.** With cores
  at `shape ≈ 1` and optical depth 3–5, subtracting 0.2 changes alpha from
  0.98 to 0.96 — invisible. Two successive doublings looked like dead code. It
  only becomes a *silhouette* when it can drive density to zero, so
  `CLOUD_ERODE_TOP` is 1.70, above the shape's maximum by design. Bracketed by
  pushing it to 3.0 (clouds shredded to lace, which proved the term live) and
  coming back down.

**What is still not there.**

*Volume.* Done, over two further passes after Ash's review:

- **The stacked cut-outs** (first pass) — diagnosed and rewritten, see above.
- **A hard matte at the edges** ("like when you cut out something from one image
  and paste it on top of another"). Measured before touching it: 22 px of ramp
  from a sky at saturation 0.58 to cloud at 0.13, with no colour overshoot, so
  purely abruptness. Cause was mine — erosion raised to 1.70 can annihilate the
  soft coverage fringe entirely, because `max(shape - erode, 0)` clips density
  to zero wherever erosion exceeds the fringe's low coverage. Fixed by scaling
  erosion by coverage, which keeps the fringe's own ~100 px ramp while still
  carving folds where there is substantial cloud.
- **Concentric swirls, then dark seams** — the `abs()` billow basis, removed
  entirely in favour of a domain-warped plain fbm. See the Worley item in
  `docs/graphics/GRAPHICS_TODO.md` for why the basis had to go rather than be sanded.
- **Aspect ratio** — Ash approved changing it directly. Base 1500 -> 1100 m,
  top 3600 -> 3300 m, cells 2083x1613 -> 1299x1010 m: a cumulus goes from
  about 4:1 to near 1:1. The gas sky does not read these constants, so its
  colour is untouched.
- **Size variety** — `CLOUD_REGION_SCALE`/`CLOUD_REGION_SWING` modulate the
  coverage threshold at ~6 km scale, giving crowded regions, thin lanes and
  open holes. Threshold modulation buys size and depth variety together,
  because the threshold sets both coverage and column height.

*Altitude and cloud type* is the remaining structural gap — every cloud is in
one deck at one altitude because there IS one deck. Ash asked for that to be
its own session: **`docs/clouds/CLOUD_STRUCTURE_HANDOVER.md`**.

*Fire.* The sunward silhouette is
present but polite. A low sun behind a thick core should read much darker than
it does, and the blazing rim much brighter. The mechanism is in place and
measurable (a thin edge scatters ~17x a core at `mu ≈ 1`); it is the balance
between `CLOUD_SUN_GAIN`, the isotropic floor and `CLOUD_ESCAPE` that wants a
tuning pass, ideally with Ash in front of it.

**Perf is unmeasured.** `gl.finish()` does not synchronise in the harness
browser, so every timing came back incoherent (a cloudless dome "measuring"
18 ms).

> **Both halves of that sentence are out of date.** Corrected 2026-08-16 by the
> correctness-and-truth round. GPU time *is* measurable now —
> `src/render/GpuProfiler.ts` (`EXT_disjoint_timer_query_webgl2`, disjoint
> honoured, per-pass prefix rotation), driven headlessly per
> `SHADOW_ROUND_HANDOVER.md`. And `CLOUD_MARCH` is **192 on both presets**
> (`CLOUD_MARCH_STEPS`, `src/scene/Ocean.ts`), not 6 and 4 — the march moved
> into the cloud cache, where it runs once per texel per bake sweep instead of
> once per screen pixel per frame, which is what made the higher count
> affordable. The rest of this paragraph — the two conservative rejects inside
> `cloudDensity`, and Safari being GPU-bound already — still holds.

The march is gated behind `CLOUD_MARCH` — 6 on desktop, 4 on mobile,
compiled into both the dome and the ocean so sky and sea cannot disagree — and
two conservative rejects inside `cloudDensity` mean most steps of most pixels
cost one fbm rather than three. It still wants a real measurement on Ash's
hardware, and Safari was already GPU-bound before this.

## WHAT ASH HAS CONFIRMED

- **Daytime blue sky: FIXED** (session 2, their words: "you've fixed it
  finally"). Re-verified this session against a pre-change baseline; midday is
  unchanged in hue and within a few LSB in brightness. Evidence:
  `evidence/graphics-round/final/midday.jpg`.
- **Sunset progression and the horizon bands: reviewed and accepted this
  session**, with the cloud-volume gap explicitly deferred to next.

## THE DEFECT THIS SESSION EXISTED TO FIX

Ash, from the running game:

> "the sky surrounding the sun peaks in its orange/pink colour when the sun is
> still several degrees above the horizon ... but then as the disc of the sun
> falls lower past that point, the sky starts getting bluer again to match more
> like daytime colours, even though the sun disc is still visible"

It was real and it measured. Sky at 2 deg elevation in the sun's azimuth,
display RGB:

| sun elevation | before | after |
|---|---|---|
| +6 deg | `248,238,215` (peak) | `240,229,201` |
| +1 deg | `215,197,235` | `220,183,98` (peak) |
| 0 deg | `155,196,238` | `203,161,128` |

**Cause.** The in-scatter integral charged every scattering event along the
view ray the sun transmittance measured AT THE OBSERVER, at sea level. For a
ray toward the horizon that is wrong by orders of magnitude: the air that
lights up is 50–300 km away and kilometres up, it sees the sun a degree or two
higher through the Earth's curvature, and its sunlight grazed thin high air
rather than forty sea-level air masses. The warm single-scatter term therefore
collapsed ~25x between sun +5 and sun 0, at which point the surviving blue
multi-scatter term won and the sky went back to daylight blue with the disc
still on the water.

## WHAT LANDED (all in `shaders/lib.ts` + its CPU mirror `TimeOfDay.ts`)

Sky:

- **`viewPathInscatter()`** — two-segment quadrature of the in-scatter
  integral, split at half the view path's air mass, each segment sampled at
  the density-weighted median of its own half and carrying its own local sun
  elevation and altitude. Segment weights are per channel
  (`exp(-betaE*a0) - exp(-betaE*a1)`), which is the second half of the
  saturation story: blue is extinguished fastest on the way back, so blue's
  scattering is weighted toward the near, low, deeply reddened part of the
  path. Reduces exactly to the old `(1 - Tview) * Tsun` when both samples see
  the same sun, so midday is untouched by construction.
- **`sunAirMassAt(z, eps)`** — sun-ray air mass from altitude `z`, with the
  density reduction above `z`, the tangent-point correction for rays that dip,
  and the horizon-dip term (from 2.5 km up you see the sun 1.6 deg after the
  sea has lost it). Strict generalisation of `lightTransmittance`.
- **The twilight arch and the Earth's shadow now come from geometry** rather
  than the old hand-fitted `azBias`, which is gone.
- **Recycled first-order light** — where the sky is full of reddened
  single-scattered sunlight, the second-order field it feeds is reddened too.
  Only the multi ILLUMINANT is recoloured, never the `(BETA_R/betaE)^p`
  scattering weight; recolouring the latter strips the blue out of the daytime
  sky (measured: midday zenith `103,151,220` -> `132,151,212`). Weighted by the
  first-order share of local radiance, plus a sun-direction-weighted hold so
  the recolouring survives the warm term dying below +2 deg.
- **Chroma boost is now a ratio exponent, not a difference gain.** The old
  `lum + (c - lum) * k` drove blue to exactly 0 on a saturated sunset and a
  clamp held it there — a lie about the sky, a banding source, and because it
  engaged abruptly with sun elevation it drew a yellow-green horizon strip that
  appeared and vanished around sun +3. `SKY_SATURATION` 1.36 -> **1.25** and is
  now an exponent; luminance is renormalised so it changes colour only.
- **The old low-sun Mie in-scatter boost is gone** (`BETA_M_SCAT * (1 + 1.2 *
  lowSun)` -> `BETA_M_SCAT`). It was a workaround for the sunset arriving late,
  which is what `viewPathInscatter` now fixes properly; left in it
  double-counts, and aerosol scattering is spectrally grey so an oversized Mie
  term paints the golden hour white instead of gold.
- **`SKY_GAIN`** 0.82 -> 0.79, to hold midday at its approved brightness
  against the honest brightening the view-path fix brings.
- **Exposure meter** now takes the larger of the fill average and a horizon
  ring (`HORIZON_SAMPLES`, `HORIZON_METER_WEIGHT`). The fill samples sit at
  26 deg elevation and above, so they were metering the DARK half of a sunset
  and opening the exposure until the bright band pinned against display white,
  where ACES has no hue left to give. The ring only ever closes the exposure
  down. `ambientRadiance` (scene fill) is deliberately untouched.

Ash's mid-session horizon-band report — **this one was mine**:

> "there's this glowing white halo across the horizon, which doesn't look
> realistic at all ... and then similarly, if I look in the opposite direction
> ... there's literally this dark band between the ocean and the sky"

I had fed the multi-scatter reach from `scatterPathScale`, which blows up
hyperbolically as the view ray flattens (8 km at the zenith, 327 km at the
horizon), so the local sun elevation swung nearly 5 deg across the last 5 deg
of sky — and the twilight illuminant is falling off a cliff at exactly that
moment. Both the multi reach (`MULTI_REACH_MAX`) and the single-scatter sample
PLACEMENT (`SAMPLE_REACH_MAX`; the air mass carried is untouched) now approach
soft ceilings. Measured worst radiance change per quarter-degree over a sweep
of five sun elevations and three azimuths:

| state | worst step |
|---|---|
| pre-round | 3.4% |
| the state Ash saw the band in | 27.3% |
| now | 3.2% |

Clouds (`cloudLayer()` rewritten again):

- Real slab constants (`CLOUD_BASE`/`CLOUD_TOP`/`CLOUD_MID`/`CLOUD_THICK`).
- **Per-cloud sun geometry** driving both the terminator and the transmittance
  colour, through the same `sunAirMassAt()` the sky uses — so cloud and sky can
  never disagree about how red the light is. This is the direct answer to Ash's
  "we kinda need to be calculating the orange tint of clouds per cloud position
  rather than it being some uniform thing".
- **Self-shadow march** along the sun's azimuth over the field read as a height
  map. One noise unit is ~2.1 km and the slab is ~2.1 km thick, so a ray rises
  almost exactly `tanSun` column-heights per noise unit and the comparison is
  in those units directly.
- **Two-lobe scattering**: a strong forward lobe (light driven through thin
  cloud — the ignition) and a weak back lobe (the lit face we see when the sun
  is behind us, which is why anti-solar clouds glow while sunward cores go
  dark). Beer–Powder, thickness undersides, slant opacity.

## THE TRAP THAT COST AN HOUR — READ THIS

**GLSL has no hoisting. The TypeScript mirror does.** A constant declared
after its use passed `tsc`, passed all 203 tests, and rendered a black screen
in the browser. `tests/shader-source.test.ts` now has a declaration-order
guard for top-level GLSL constants and functions; it would have caught it.

Corollary: **the numeric test suite exercises only the CPU mirror.** A GPU-only
break is invisible to it. Always open the browser and look before believing a
green suite.

## THE FLICKERING NOISE — DIAGNOSED (session 4)

Ash: "a lot of 'flickering noise' ... you can kinda see it in the water in a
single frame but it's much more obvious with motion". Also, from Safari: "here's
what i see when the effect is bad."

**It is sampling, not shading.** Rendered at 2x2 supersampling the same frame is
clean, coherent water; at 1.00x on a DPR-2 panel the mid-distance dissolves into
a stipple of pinprick highlights. Evidence, 1:1 crops of the same instant:
`evidence/flicker/crop-{1x,2x,4x-ssaa}.png`.

Aliasing error against a 2x2-supersampled reference of the same frame, rms
display levels over the 40-150 m band (the worst band; the peak is at ~53 m, not
at the horizon):

| render scale | pixels vs native | error vs SSAA |
|---|---|---|
| 1.00x | 25 % | 19.2 |
| 2.00x (native) | 100 % | 13.3 |

Ablated at native, same metric: no detail octaves **3.5**, no clouds in the
reflection 11.4, no residual swell 13.4, no foam 13.4. So the detail-noise
octaves drive about three quarters of it, through the shading's non-linear
response to the normal rather than through the normal itself.

**Why it comes and goes.** `main.ts`'s adaptive pixel-ratio walk stepped the cap
DOWN above 26 ms and UP below 13 ms. Vsync pins a healthy 60 Hz frame at
16.7 ms — neither. The walk therefore had one reachable direction: the first
slow patch of a session dropped the buffer and nothing could raise it again
until reload. A browser running the tab at 120 Hz clears the 13 ms bar and one
capped at 60 Hz never does, which is the whole of "yours looks fine and my
safari looks bad". Now a policy with tests: `src/render/adaptiveResolution.ts`.

**What is NOT the cause**, measured and discarded:

- Screen-space specular anti-aliasing (slope derivative folded into roughness,
  the Kaplanyan remedy). The slope is smooth between pixels here — the
  sub-pixel term measures 0.0005-0.0016 against a Cox-Munk budget of 0.063, one
  to two percent. Written, measured, reverted. Do not re-derive it.
- Tightening the detail-octave band limit. Sweeping the fade window from
  0.20-0.50 cells down to 0.03-0.08 cuts frame-to-frame incoherence from 8.7 to
  3.1, but moves the image AWAY from the supersampled truth at every step: it
  is blur, not filtering, and it softens exactly the mid-distance the round has
  been protecting. Available as a lever if Ash wants it; not taken.

**Still open**: Ash sees the artefact at native 2x as well, less severely. The
resolution walk explains the come-and-go and the browser difference; it does not
explain what remains at native. That needs its own pass — and the honest target
is the reflection lobe's per-pixel sky sample, not the normal.

**The harness** is `tools/flicker-harness.js`, loaded with
`fetch('/tools/flicker-harness.js').then(r => r.text()).then(s => (0,eval)(s))`.
It stages a deterministic instant, pins the camera, advances only the wave phase
and the presentation clock, and measures against a supersampled reference. Two
traps it exists to remember: `ocean.update()` re-uploads most uniforms every
`stepSimulation`, so an ablation applied before the step is silently undone; and
editing anything under the Vite root triggers a full page reload that resets
the staged state.

## OPEN ISSUES CARRIED FORWARD

1. ~~**Cloud volume**~~ — done, session 5; see the top of this file. **Fire**
   is what remains of that item: the silhouette-and-blaze balance at a low sun.
2. ~~**Safari-only water noise**~~ — diagnosed, see above. What remains is the
   residue visible at native resolution.
3. **Foam-window seam** in the foreground water (pre-existing, Ash-isolated to
   the foam layer). Square Chebyshev near/far handoff at 110–170 m in
   `Ocean.ts`.
3b. **Safari is GPU-bound**, out of scope by Ash's instruction ("leave perf
   tuning out of scope — but just instrument for now"). Their readout when the
   effect is worst: 30 FPS at 34.6 ms while already drawing a quarter of the
   panel's pixels. The walk is right to be at 1.00x there; nothing but a cheaper
   ocean shader moves it.
4. **Foam/whitewater aesthetic pass** — the "stunningly gorgeous" standing
   requirement. Still only corrective fixes; nobody has done the beauty pass.
5. **The brief's validation matrix and the visual-critic loop** (max 3 passes)
   — only ad-hoc captures exist.
6. **Sun disc at sunset** is a small pale dot. Its radiance is only ~5x the sky
   behind it, so its own colour never dominates; a real low sun is orders
   brighter and reads as a reddened disc. `SkySystem.ts`, the `sunDisc` gain of
   2.4.
7. Session-1 leftovers: far-aerial residual ridging, embodied deck darkness at
   sunset, raft unhazed at distance, perf at 1440p/4K unmeasured, polar checks.
8. **Docs**: `docs/graphics/GRAPHICS_ROUND_REPORT.md` unwritten; `README`, `FUTURE_ROUNDS`,
   `VISUAL_LIGHTING_SPEC`, `VISUAL_REFERENCE_NOTES` all need this round.

## WORKFLOW NOTES

- Dev server: `drift-graphics` (port 5183). Capture server: **port 5203** —
  `node tools/capture-server.mjs evidence/graphics-round 5203`. Port 5202 holds
  a live instance from the `daytime-sky-sun-graphics-8e07a2` worktree; leave it
  alone and use another port.
- `evidence/` is gitignored. This session's captures live in this worktree at
  `evidence/graphics-round/{final,bands,bands-fixed,clouds-v1,sunset-v2,sunset-v3}`
  and are not in the commit.
- **The offline probes are the fast loop and they are worth rebuilding.** They
  import `TimeOfDay` directly, bundle with esbuild (alias `three` to the repo's
  copy), and print display RGB through the exact exposure + ACES + sRGB chain.
  This session used four: a sun-elevation x view-elevation x azimuth grid, a
  warmth curve, a display-space progression, and a worst-step-per-quarter-degree
  scan. They matched browser pixels all session and turned every "is this
  better?" into a number in about three seconds.
- **Assert on display values, not linear ratios.** ACES compresses hard near
  white, so a large linear ratio can still look like pale cream. The new tests
  in `tests/graphics.test.ts` run the same tone-map chain the renderer does.
- Browser harness: it dies on every HMR reload. Cache it —
  `localStorage.setItem('__harness', src)` once, then
  `eval(localStorage.getItem('__harness'))` after each reload.
- Camera aim: `cinematic.orbit()` has a measured gain of **-2.924** on the
  camera's forward azimuth, and `orbitAzimuth` accumulates unwrapped. Drive it
  closed-loop (orbit, step ~30 frames to settle, measure
  `camera.getWorldDirection()`, repeat) rather than computing an absolute.
- Staging otherwise as session 2 documented: `world.setPaused(true)` FIRST,
  binary-search the canonical instant for an exact sun elevation,
  `sim.refreshLighting()`, then `renderFrame()` and `drawImage` with no awaits
  in between.

## THE BLOBBY GLASS OCEAN — FIXED (session 4)

Ash: take the production ocean preset, dial up the primary swell significant
height, and it renders "absolutely absurd looking waves ... a weird blobby glass
ocean", while Southern Ocean rough at a similar swell height looks like water.

`unresolvedSlopeVariance` was `max(coxMunk(U) - resolvedMss, 0)`, and the zero
was reachable. At 6 m/s the Cox–Munk budget is 0.0337; the resolved mean square
slope passes it at a primary Hs of about 3.7 m and reaches 0.065 at Ash's 5.6 m.
Past that point the subtraction clamps at zero — and the derived detail
amplitude is `0.62·√(unresolved)`, so the fragment stage loses BOTH its ripple
geometry and its statistical roughness in the same instant. `alphaGlitter` and
`alphaReflect` fall to their floors and the sea becomes polished plastic draped
over the swell. Southern Ocean rough escapes only because 18 m/s buys a budget
of 0.095 against 0.012 resolved.

Zero was never a defensible answer: the subtraction compares different bands.
Cox–Munk's mss accumulates about evenly per octave of wavenumber from the peak
to the capillary cut-off near 5 mm, the geometry stops at 3.5 m (1.1 m with
micro chop), so nine-odd octaves of real slope are permanently out of the
components' reach against the two or three they carry. Hence a floor at
`UNRESOLVED_MIN_SHARE = 0.75` of the Cox–Munk total. Every shipping preset
already sits above it — the lowest is Crossing seas at 0.83 — so nothing that
exists moves, and the collapse a lab slider (or a future weather state) can
drive into is closed. Evidence: `evidence/flicker/swell-{before,after}.png`.

## VERIFICATION AT THIS COMMIT

`npm test` 216/216, `npm run typecheck` clean, `npm run build` clean, no console
or shader errors on a fresh load.

Session 4 added 13: twelve for the adaptive-resolution policy (the first of them
is the one that would have caught the one-way walk) and one pinning the
roughness floor against a swell far past the wind that could raise it.
