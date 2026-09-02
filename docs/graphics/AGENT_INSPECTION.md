# Agent inspection tooling — deterministic views and surface probes

Ash's standing directive (2026-08-13): graphics rounds keep paying the same
diagnosis tax — an agent drives the browser pane by synthetic clicks, wrestles
the camera, and reads pixels back by eye. This tooling replaces that loop.
Name a complete viewing condition, get the same frame every run, and ask any
surface on it how the lighting model is lighting it — in numbers.

## The one-command view

```bash
npm run inspect:view -- --time 14 --stand cabin --look 180,0 --shot --grid 16x9
```

Spawns its own Vite (or attaches with `--server http://localhost:PORT`),
launches headless Chrome with the known-good GPU flags (Metal ANGLE — see
`docs/.../perf` history for why), waits for the app's settle sentinel, then
captures. Output lands under `evidence/inspect/<stamp>/` (or `--out`):

- `view.png` — the settled frame, interface chrome hidden
- `grid.json` — the ray grid with per-cell identity + luminance
- `probes.json` — full decompositions for `--probe` / `--point` requests

The terminal digest prints the applied conditions, the four portal channels'
live light, and the grid as a letter+digit matrix (letter = object, digit =
display luminance 0–9) — "what is on screen and how bright" without opening
anything.

Options: `--time <hours>` `--day <1..366>` `--stand <station|x,z[,y]>`
`--look <yawDeg,pitchDeg>` (yaw 0 = toward the bow, 180 = the stern, +pitch
up) `--portal-mix <0..1>` `--world-view <term>` `--probe <ndcX,ndcY>`
`--point <x,y,z,nx,ny,nz>` `--width/--height`. Stations are
`src/vessel/schooner/stations.ts` — the same list as the deck panel's
"Stand at" buttons, on purpose.

## The URL contract (usable without the CLI)

Any browser instance honours the same parameters — the in-app host is
`src/runtime/diagnostics/InspectionHost.ts`:

```
?inspect=1&solarTime=14&stand=cabin&look=180,0&portalMix=1&worldView=albedo
```

`freezeTime=0` lets the clock run (frozen by default); `chrome=1` keeps the
interface visible. When the frame has settled the host publishes
`window.__driftInspect` with `ready: true`, `applied` (what actually took
effect — check `standRefused`/`standUnknown` before trusting a capture), and
the probe API:

- `conditions()` — sun, exposure, portal mix, all four channels' live light
- `probeNdc(x, y)` — full decomposition of the first ship surface under a
  screen point
- `probePoint(x, y, z, nx, ny, nz)` — the same for an arbitrary vessel-local
  surface point, no camera needed
- `probeGrid(columns, rows)` — the semantic screenshot, row-major from
  top-left
- `report(columns?, rows?)` — conditions + grid in one call

## What a sample says (`SurfaceLightProbe.ts`)

Identity (object, material, roughness), geometry (world/vessel point and
normal, distance), `room` from `lightRoomAt`, then the lighting ledger:

- `baked` — the vertex attributes barycentrically interpolated at the hit:
  what the shader actually multiplies.
- `model` — `vertexLightResponse` recomputed fresh at the hit point. **When
  `baked` ≠ `model`, the bake is stale or a vertex resolved to the wrong
  room** — the §15.5 well-steps fault class, now a one-line check.
- `terms` — irradiance per source: `portalDirect`, `portalBounce`, `sky`
  (visibility-scaled SH), and `sun` with its geometric cosine and a CPU
  occlusion ray. The ray is the truth the shadow map approximates; where
  they disagree, the shadow is wrong, and that is a feature.
- `albedo`, `radiance`, and `display` — predicted pixel through the live
  exposure and the real CPU mirror of the tone curve (`applyToneCurve`).

Caveats, stated rather than hidden: transparent surfaces are skipped (the
pixel shows what is beyond glass; a ray stopping at the pane would report
darkness for a bright cell); specular/environment reflection is not in the
ledger (diffuse only); grid cells that leave the ship report null — the sea
and sky belong to other systems.

## Guard tests

`tests/surface-light-probe.test.ts` holds the probe's arithmetic to the
modules it reports on — the bake it interpolates, the model it recomputes,
the tone curve it predicts through. If the probe drifts from the renderer,
these fail before a wrong report misleads a round.

---

# Captures and paired A/B sheets

Everything above answers *what is the lighting doing here*, in numbers. This
half answers the other question — *show Ash the two options side by side* —
and it exists because the previous attempt to do that failed silently in two
different ways at once.

## What was wrong before

`docs/ocean/OCEAN_LOOK_ROUND_HANDOVER.md` §6 recorded the debt: the browser
pane's `readPixels` "returned black frames repeatedly", so several A/B
captures were discarded rather than reported, and the look verdicts were taken
by eye off screenshots instead. Both halves of that have now been diagnosed
rather than worked around.

**The black frame was not a timing problem.** The renderer runs with
`preserveDrawingBuffer: false` in every session that is not the buoyancy lab
or the schooner viewer. WebGL then declares the default framebuffer's contents
undefined once the frame is composited, and Chrome takes that literally. A
copy is only valid **in the same task as the render that filled it**, and a
console evaluation, a CDP `Runtime.evaluate`, a `setTimeout` continuation and
anything after an `await` are each a new task. Measured on this branch at
1280×633 headless:

| how the frame was read | mean luminance |
| --- | --- |
| render, then read in the same task | 21.7 |
| read with no render in this task | 0.0 |
| render, then read after one macrotask turn | 0.0 |
| render, then read after a `rAF` (loop still running) | 21.3 — but only because the loop's own render lands in that same task |

Worse than the zeroes: `drawImage` sometimes returns a **stale composited
frame** rather than black, which looks exactly like a capture and is not one.
No amount of sleeping fixes any of this; sleeping is the thing that breaks it.

**The tier substitution was real and is wider than the pane.** A viewport
under 640×1024 selects `OCEAN_QUALITY_MOBILE` during bootstrap — three detail
octaves instead of five, a 160×160 ring grid instead of 288×288. The pane is
854 px wide and trips it. So does `--window-size=1280,720` headless Chrome,
whose content area is only **633 px tall**: measured without `?quality=`, that
window compiles `DETAIL_OCTAVES 3`.

**And a third, found by this round's own control.** The solar search used to
start from the session's live `worldInstantUtcSeconds`. The world clock runs
while a capture host waits out its settling frames and the calendar runs at
30×, so two pages booted a second apart began their search half a minute of
world time apart, matched the requested *elevation*, and arrived at different
*azimuths*. Two pages asked for one identical scene and differed over 98 % of
their pixels. The search now starts from the constant `OPENING_UTC_SECONDS`.

## The capture contract

`?capture=1` opens a capture session. It is the only supported way to get a
pixel out of this application, and it does three things nothing else does:

- **retains the drawing buffer**, so a read is not racing the compositor;
- **detaches the frame driver's animation loop**, so the only renders are the
  ones a capture asks for and the adaptive-resolution walk cannot move the
  framebuffer between two frames of one comparison;
- **publishes `window.__driftCapture`**, whose every shot renders and reads
  inside one task and carries `RenderTierFacts` describing the renderer that
  drew it.

`assertRenderTier` (`src/render/renderTier.ts`) runs before any image is
returned. It checks the tier label, **and separately the geometry that tier is
obliged to draw** — a frame that says `desktop` while the compiled ocean has
three octaves is rejected, which the label alone cannot catch — plus the CSS
size, the pixel ratio, the backing store that must follow from them, that
adaptive resolution cannot move, and that every A/B arm reads back the value
it was captioned with. A mismatch **throws**; no image is written.

Two further guards close the old failure directly:

- `?quality=` now takes `desktop` **or** `mobile`, wins over the viewport
  heuristic in both directions, and throws on anything else — a capture that
  misspells its tier must not quietly get the tier the window would have
  guessed.
- `labCapture.grab()` now refuses an all-zero frame instead of returning a
  black canvas. This is not a heuristic: the renderer's clear colour is
  `0x0a1420`, so a frame this application actually drew cannot be pure black
  in all three channels.

## Producing a paired A/B sheet

```bash
# what can be photographed, and which arms
node tools/ab-sheet.mjs --list

# a live switch: both arms off ONE frozen simulation state
node tools/ab-sheet.mjs --switch legacyToneCurve --arm 0 --arm 1 \
  --scene 'seaState=CURRENT_MODERATE,sunElevationDeg=48,waveTimeSeconds=120,lookYawDeg=140' \
  --scene 'seaState=SOUTHERN_OCEAN_ROUGH,sunElevationDeg=9,waveTimeSeconds=151,lookYawDeg=140' \
  --verify --out evidence/ab/legacy-tone-curve

# a page-load switch: one page per arm, interleaved shot by shot
node tools/ab-sheet.mjs --switch shoulder --arm 0.8 --arm 0.7 --verify
```

Output is a labelled sheet, every individual frame at full size, and a
manifest carrying the complete `RenderTierFacts` of every shot.

Scene keys are `CaptureSceneSpec` fields: `seaState`, `waveTimeSeconds`,
`sunElevationDeg`, `stand` (a `stations.ts` name or `x,z[,y]`), `lookYawDeg`,
`lookBearingDeg`, `lookPitchDeg`, `originX`, `originZ`, `cloudWarmFrames`,
`trueWindAngleDeg` and `dayOfYear`.
Surface is `--tier/--width/--height/--dpr`, defaulting to desktop 1280×720 at
DPR 2. `--terrain on` mounts the synthetic land, and `--param k=v` passes any
other URL parameter through (`--param fixture=mountain --param range=5000`),
refusing to overwrite one the capture contract owns.

**Aim at world things by bearing, not by yaw.** `lookYawDeg` is ship-relative,
which is right for a question about the rig and wrong for anything in the
world: the synthetic land sits on a true bearing and the vessel's heading is
whatever the voyage gives it, so aiming at a headland by guessing a yaw is a
sweep rather than a scene. `lookBearingDeg` is degrees clockwise from north
and is converted through the live course.

**Name the point of sail when the question is about sails.** `trueWindAngleDeg`
is the signed true wind angle off the bow — positive is the wind over the port
side, so +45 is close-hauled on the port tack, ±90 a beam reach and 180 dead
downwind. Absent, she is on whatever the opening voyage gives her, which is what
every sheet taken before this field existed was photographed on. Setting it does
three things at once (`VesselRuntime.poseOnTrueWindAngleDeg`): the heading is
commanded, which puts the hull on the captive tow at the speed she is already
making; the model yaw is snapped to it; and the sheets are re-sided for the
resulting tack by the same rule the opening condition uses. That third one is
not a nicety — without it a scene on the other tack draws every sail aback and
captions it a broad reach. Every shot reports the angle that was staged.

**Name the day when the question is about the moon.** `dayOfYear` offsets the
solar search's base instant by whole UTC days. The search window stays one whole
day, so an elevation is still reachable wherever the season allows; what moves is
the date, and with it the moon. It exists because the moon's phase and position
are functions of the date and the opening day's moon is **9.7 % illuminated and
below the horizon** — where every arm of a moonlight A/B is identically zero.
Every shot now reports `moonElevationDeg`, `moonIlluminatedFraction` and
`moonPower`, and `ab-sheet` fails a run whose switch is about the moon when no
shot on it has any moon in it. Useful days from the opening location, asking for
a −30° sun: **32** gives a full moon at 27.5°, **35** gives 91 % at 52°, **18**
gives a moonless night with the moon 28° below the horizon.

**The eye is stated, never inherited.** Switching to the embodied camera
without placing the body first puts it wherever the walker happens to have got
to — measured, that is (−0.35, −1.32, 0.25), inside the hull, and every frame
of the sheet comes out black. There is no running simulation to walk the body
onto the deck, so `stand` is part of every scene and a refused placement fails
the capture.

## Two shapes of switch, and why it matters

`src/debug/abSwitches.ts` is the registry, and a switch earns a place in it by
being **readable, not just settable** — a sheet that can set an arm but not
read it back cannot detect the arm failing to take.

- **`live`** moves a uniform or a cache key. Both arms are flipped between two
  renders of one frozen state in one page: literally the same water, the same
  clouds, the same instant, the same eye. Sixteen switches, including the
  colour pipeline's six, `oceanTaa`, `scotopic`, `kelvinPattern` and
  `cloudLiveMarch`. That last one is a shader **define**, which would normally
  make it `reload` — it is live only because `SkySystem.setLiveMarch` sets
  `needsUpdate`, which is precisely the step three's program cache misses when a
  source-text switch is flipped behind its back.
- **`reload`** changes shader **source text**, which three's program cache is
  not keyed on — flipping it in place leaves compiled programs running the old
  code, so the comparison would be a lie. `shoulder` and `noToe`. These get
  one page per arm, loaded concurrently, staged identically, interleaved shot
  by shot.

Arms interleave rather than running as two blocks, following the perf
harness's doctrine: a machine that drifts between two long blocks puts its
drift in the answer, and pixels drift too — the foam integrates, the cloud
cache regenerates, the eye adapts.

### Two defects in the live path, and the controls that now catch them

Both were found by the A/B-sheet round of 2026-08-17, and both had been
silently corrupting every live sheet taken before it.

**The ship was still under way between the two arms.** `captureAb` settled
three frames at 1/60 s after applying each arm, and `setPaused` stops the
calendar, not the vessel. Measured: the eye moved 7 mm along the deck and 6 mm
across it in those three frames, 64 mm in forty-eight. In a frame full of
rigging, glitter and foam a sub-pixel shift resamples every edge, so **the same
arm photographed twice through that settle differed by a mean of 3.33/255 over
48 % of the frame** — growing monotonically with settle length, and with its
signed luma at zero throughout, which is the signature of a picture that moved
rather than one that changed. `sunDomeMean` measured 3.34 against that 3.33: its
sheet was a photograph of the harness. Arms now settle at **dt = 0**
(`republish`), which leaves the eye at identical coordinates to six decimal
places and puts the same-arm control at **0 % of pixels, max 0**.

Staging still settles at a real delta and must — everything staging waits for is
an integrator. The two calls are opposites on purpose.

**Half the registry moves a term the render never re-read.** Several switches
move a CPU-side lighting quantity — the ambient fill above all — which reaches
the picture through `refreshLighting`/`refreshWorldLighting`, not through a
uniform the next render happens to upload. `sunDomeMean` moved the fill to
0.85× at a 27° sun and moved the frame by nothing. `captureAb` now refreshes the
lighting after applying an arm, and the same flip moves the frame by a signed
**+2.32** levels over 99 % of it.

Three additions came with them:

- **A null control on every live sheet.** The page-load path always measured its
  floor with a third page at the same arm; the live path had nothing equivalent
  and needed it more. `--verify` now re-runs the whole capture with **both arms
  set to arm one**, per scene, and fails the run when the delta does not clear
  that floor by 2× — or when the arms come out bit-identical, which is how
  `starDome` and `vesselSkyOcclusion` reported themselves as inert.
- **`meanSignedLuma`** on every difference: arm B minus arm A, in sRGB code
  levels. The unsigned mean cannot tell "the deck is two levels brighter" from
  "every specular edge resampled", and both defects above were found by the
  signed number being zero where the unsigned one was not. It is the statistic
  for any question about fill, exposure or level; the unsigned mean is the one
  for texture and edges. `legacySkyHue` is the clean illustration — mean 9.2,
  signed 0.71.
- **`sunElevationDeg` on every shot** — what was *drawn*, not what was asked.
  The solar walk lands on the nearest instant in the opening day, which tops out
  near 55° and bottoms out at **−34°**, so a scene asking for −40° silently gets
  −34°. Three committed sheets carried exactly that caption error.

The determinism baseline is no longer embedded in the manifest as base64; it is
written beside the sheet as `determinism-baseline.png` and ignored, like every
other frame. Three manifests went from 13.6 MB to 11.5 KB.

**A sheet is dated by its tier stamp.** The manifest records every registered
switch's live value, so a sheet taken before a round landed can be recognised as
stale by the switches missing from that list — which is how the three sheets
committed on 2026-08-16 were caught: no `sunDomeMean`, no `fibonacciAmbient`, no
`scotopic`, i.e. before the ambient-set and night rounds. A night frame from
that build is visibly a different night. Check the stamp before trusting an old
sheet.

## Determinism: what is proven, and what is not

| claim | measured |
| --- | --- |
| **a shot re-taken from an already staged scene** | 0.04–0.2 % of pixels, max **1**/255 — exact to 8-bit quantisation |
| **two separate pages, each staging the scene once** | 3.9 % of pixels, mean **0.04**/255 |
| the same scene **staged a second time on one page** | **0.01 % of pixels, mean 0.00004/255, max 1** — the 8-bit quantisation floor, same as a re-shot frame. Was 54–94 %, mean 2.6–4.3/255 |

The first is asserted, and `--verify` fails the run if it regresses. It is the
one the A/B contract rests on, because **a live A/B takes both arms off one
staging** — re-stage reproducibility never enters that comparison. For scale,
the `legacyToneCurve` arms differ by mean **28.4**/255 against a same-stage
floor of **0.002**.

The second is what makes the page-load path usable, and it only holds for a
page's FIRST staging. Measured for `shoulder`: a cross-page floor of **0.04**
against an arm delta of **2.0**, a margin of about fifty, so that A/B is
supportable. Run one `--scene` per invocation; the tool warns when you do not,
because the control covers only the first scene and every later one rests on
the larger re-stage floor.

The third **was** an open defect, and is now at the same floor as the first.
The record below is kept because the shape of the bug is more useful than the
fact of it: five instances were found, and all five will recur.

Staging the same scene twice on one page, then diffing both the pixels and the
live subsystem state, separated the causes. Three were traced by the capture
round; two more were found by re-running its own check on a live page *after*
those three were fixed and the page still would not reproduce.

| cause | evidence | now |
| --- | --- | --- |
| **the cloud tile scheduler's round-robin cursor** | ends at 149 on one staging and 83 on the next; drop `cloudWarmFrames` to 0 and the residue falls from mean **1.37** to **0.14** | `CloudDome.reset`, via `SkySystem.reset` |
| **the cloud deck's drift phase** | *not one of the three.* Integrated per presentation frame in `advanceCloudPresentation`; on a live page it moved the ambient fill **9 %** and the exposure **0.7 %** — the largest term left after the cursor | `SkySystem.reset` |
| the eye-adaptation meter never resets | exposure 1.244669 → 1.244759 on a re-stage, climbing monotonically all session without ever coming back down (**0.007 %**) | `resetIntegrators`: `TimeOfDay`, `ScenePresentPass`, the schooner's metered eye |
| **the wind's gust clock** | *not one of the three.* `WorldWind.clockSeconds` accumulates all session; a different gust reached the sails, then the yaw, then the camera — **1.1e-5 rad** of heading after 40 warm frames | `WorldWind.reset`, in `resetIntegrators` |
| the vessel's attitude does not return | camera *x* differs by 1.8 mm after 40 warm frames, 0.026 mm after 4 | `PlanetaryWorld.restoreOpeningVoyage` plus the yaw `Schooner.resetHorizontalMotion` was not restoring |

**Every one was the same bug: an owner holding state that `resetSimulation`
could not reach.** Two recurring kinds, and both will recur:

- **A low pass with no way home.** A multi-second constant and a first-frame
  latch. It climbs across a session and never returns, and a capture cannot
  wash it out because 40 warm frames is 0.67 s against a 4 s constant. The
  exposure meter, the rod dominance and the interior gain are all this.
- **A clock or cursor advanced by hand, per frame.** A cursor is state even
  when every value it fills is a pure function of the scene, because *which*
  values are current depends on where the cursor was. Five of these: the cloud
  tile scheduler, the cloud drift phase, the wind's gust clock, the sky probe's
  256 directions at 16 per frame, and the solar disc's 16 samples at 4 per
  frame. The last two only show on a staging shorter than their own cycle — 16
  and 4 frames — which is why the guard includes a short-warm case.

Two of these deserve their own note.

**`setPaused` stops the calendar, not the ship, and not the weather.** Three
things advance on presentation frames and ignore the astronomical clock
entirely: `advanceTangentMotionStep` (the vessel's geodesic travel),
`advanceCloudPresentation` (the cloud deck's drift) and `WorldWind.advance`
(the gust clock). A "frozen" capture scene is under way, in moving cloud, in a
changing gust. The vessel cause was flagged as possibly honest floating-point
divergence and is not: the second staging began from a *different initial
condition*, which is why the divergence grew with settle length. An
integrator's own noise would not care how long it ran.

**Reset order is a dependency order, and getting it wrong hides a fix.**
`SchoonerSailForces.reset` rebases its wind time on `WorldWind.elapsedSeconds`.
With the vessel reset issued before the clock reset, the sails were pinned to
the *old* gust clock a few lines before that clock was zeroed — so the wind
fix appeared not to work. The clocks now run first in `resetSimulation`, and
`tests/sim-handle.test.ts` pins that order.

### The guard, and what it is worth

`tests/restage-determinism.test.ts` — node, no GPU, runs on every commit. It
runs each subsystem, restarts it, runs it again and asserts the state matches
**exactly**, not within a tolerance: the claim is that the second run
recomputes rather than continues, and a tolerance passes a low pass that merely
got close, which is what the defect looked like in the first place.

Every case carries a negative control asserting that *without* the restart it
does **not** reproduce, and each fix was mutation-checked against it — remove
the fix, the test fails. A determinism test with no negative control is
indistinguishable from a test of a constant.

What it cannot see: anything needing a GL context (the foam history, the
temporal resolve, the cloud cache's actual texels, and `SkySystem` itself,
which needs a renderer to construct). The composed `resetSimulation`'s wiring
and its ordering are pinned separately in `tests/sim-handle.test.ts`.

### The bound that now holds

Measured on a live page at 960×600, through the capture host's own staging
recipe (72 warm frames, rebase, freeze, hold, restore phase, shoot), with a
*different* scene staged between every repeat so nothing could be inherited:

| | mean | max | pixels differing |
| --- | --- | --- | --- |
| scene A staged 3× | **0.00004**/255 | **1** | 0.01 % |
| scene B staged 2× | **0** | **0** | 0 % |
| control: A against B | 67.1/255 | 247 | 100 % |

The control matters: it proves the probe can see a difference. Re-staging now
sits at the 8-bit quantisation floor — the same bound as re-shooting an
already-staged scene, which is the strongest claim this table makes anywhere.

### What is owed, and one known caveat

**`--verify` on a cold machine.** The figures above are a hand-built mirror of
the staging recipe, not the tool's own path, and the determinism round was
forbidden to benchmark. Re-run `ab-sheet --verify` and, if it agrees, promote
the re-stage claim from reported to asserted.

**A page's FIRST staging leaves the cloud scheduler one frame ahead** —
`stagingFrame` 13 against 12, cursor 28 against 27 — and every staging after
it agrees exactly. The cause is understood: `ScenePresentPass.warm` renders the
whole scene once into a 1×1 target to pay a shader-variant compile early, and
that throwaway render spends a frame of the cloud cache's amortized generation.
It does **not** reach the pixels, because `requestCloudCacheRebase` re-renders
every resident tile from current uniforms before the freeze — which is why the
two defences are kept independent. The clean fix is for the cloud cache to
decline work during a render that is a compile warm-up rather than a picture,
the same distinction `ScenePresentPass.update(dt, compatible)` already makes
for the observer's adaptation. Not done here.

**One deliberate behaviour change.** `resetSimulation` now returns the vessel
to the opening voyage rather than to wherever the previous staging left it. A
page's first staging is essentially unaffected — the capture host detaches the
animation loop within a few frames of load — but stagings two onward change,
which is the entire point. Sheets whose scenes are sensitive to vessel speed
will differ from any pre-fix artefact.

`--verify` measures all three claims, in pixels rather than PNG bytes (PNG is entropy
coded, so a byte comparison can only ever say "identical or not", never *how*
different). For a page-load switch it also opens a third page at the *same*
arm as the first, stages it identically, and measures the cross-page floor
directly. If that floor is not clearly smaller than the arm delta, the run
**fails** and says the sheet cannot support a verdict rather than quietly
inviting one.

## Traps that have already cost a round

- **`gl.finish()` does not do what it claims in the browser pane.** GPU timing
  comes from `GpuProfiler`, never from wall clock around a finish.
- **Vite can serve the same module twice** — `./colourPipeline` and
  `/src/scene/colourPipeline.ts` are distinct records — so a harness that
  imports a module itself can get a second copy and flip a flag nothing reads.
  Reach for the app's own instance through `window.__drift`.
- **`stepSimulation` re-uploads uniforms**; stepping is not side-effect free.
- **Settling at `dt = 0` does not settle anything.** The existing contact
  sheets step at zero and get away with it only because they run as async work
  *inside* a live animation loop, whose own real-delta frames integrate the
  sky, the cloud gate, the world probe and the eye's adaptation between their
  awaits. A capture session detaches that loop; a scene settled entirely at
  zero comes out pure black with two faintly lit deck beams in it. Settle at a
  fixed delta, then freeze.
- **A visible window costs about 3× a headless one.** Never mix the two in one
  comparison.

## Extending

The pattern to keep: **conditions and pose are URL parameters** (dispatch in
`InspectionHost.ts`, following the evidence-host convention), **measurements
are `__driftInspect` methods**, captures and A/B sheets are `__driftCapture`
methods, and the CLI stays a thin CDP wrapper over both — `tools/headless.mjs`
holds the shared Chrome launch so no tool grows its own GPU flags.

To add a switch, add a row to `AB_SWITCHES` with a real read-back and the
right `scope`; `--list`, the sheet builder and the tier assertion all pick it
up as data. Wants still open: sea-state presets for `inspect-view`, and a
deterministic cloud cache, which is what currently keeps page-load A/Bs out of
verdict range. (Heading is no longer one of them — `trueWindAngleDeg` above.)

One caveat found while shooting the moonlight sheet: **the re-stage residue is
much larger at night than the daylight figure this document quotes.** The same
scene staged twice on one page came back 93.6 % of pixels apart, mean 11.85 of
255, against the ~0.04 measured in daylight. It does not touch that sheet — both
arms come off ONE staging and the same-arm control is bit-identical — but it
says the re-stage claim in §"Determinism" is a daylight claim, and anything that
compares across two stagings at night is resting on nothing.
