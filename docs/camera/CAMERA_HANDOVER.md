> **Superseded.** This was a mid-round checkpoint written when the work was
> unfinished. The round is now complete: read `docs/camera/CAMERA_SYSTEM.md` for the design
> and `docs/camera/CAMERA_ROUND_REPORT.md` for what was built and measured. Several
> statements below — the transition's arc and mast clearance, the head-follow
> fractions, the ocean disc blend range, the outstanding-work lists — were
> overtaken by later decisions and are wrong. Safe to delete.

# Camera round — handover

**The original brief is `docs/archived/upcoming-prompts/camera-prompt.txt` and remains
authoritative.** This document does not replace it. It records what has been
built against it, what was decided in conversation that the brief did not
anticipate, what is left, and what is known to be wrong.

Stage 2 of 3. Stage 1 (open-ocean sea states and whitewater) is complete; stage
3 is the final graphics/lighting/atmosphere round, which owns everything this
round deliberately did not touch.

---

## 1. Status at a glance

| | |
|---|---|
| Cinematic camera | **Built and verified in-browser.** Composition signed off by the author. |
| Embodied camera | **Built, smoke-tested in-browser.** Not yet through the full capture matrix. |
| Mode transition | **Built, smoke-tested.** Frame sequence captured at 0/38/74/100%. |
| Camera debug panel | **Built.** `Tools → Camera`, or `?debug=camera`. |
| Ocean rendering at altitude | **Not started.** This is the largest remaining piece. |
| Vertical follow in a high sea | **Fixed and verified.** See §2.1. Was broken; the raft left the frame. |
| Automated camera tests | **One category written** (`tests/camera-follow.test.ts`, 14 tests). Seven to go. |
| `docs/camera/CAMERA_SYSTEM.md` | **Not written.** Required deliverable. |
| `docs/camera/CAMERA_ROUND_REPORT.md` | **Not written.** Required deliverable. |
| README / `docs/project/FUTURE_ROUNDS.md` | **Not updated.** |
| Visual-critic passes | **0 of up to 3.** |

`npm run typecheck`, `npm test` (114 tests: 100 pre-existing, 14 new) and `npm
run build` all pass at this checkpoint.

---

## 2. What was built

### Architecture

`src/scene/CameraRig.ts` is **deleted**. Its replacement is `src/camera/`:

| File | Responsibility |
|---|---|
| `cameraTuning.ts` | All numbers and curves. Pure: no three.js, no DOM, no state. |
| `types.ts` | `CameraContext`, `RaftAnchor`, `CameraPose`. The narrow window onto the world. |
| `CinematicCameraController.ts` | Orbit, scale, follow, water-clearance clamp. |
| `EmbodiedCameraController.ts` | Eye anchor, free look, head stabilisation. |
| `CameraTransition.ts` | The mode change, and the path it flies. |
| `CameraSystem.ts` | Mode manager. **Sole owner of the one `PerspectiveCamera`.** |
| `src/ui/CameraPanel.ts` | Debug panel, dynamically imported. |
| `tools/camera-evidence.js` | Dev-only browser capture harness (see §6). |

Controllers produce *poses*; only `CameraSystem` copies a pose onto the camera,
so "one active camera" is structural rather than a convention. Input arrives at
`CameraSystem` and is dispatched to whichever controller is active; during a
transition it is dropped.

Rewired consumers: `main.ts`, `input/InputController.ts`, `ui/DebugPanel.ts`
(camera-distance slider removed — it moved to the Camera panel),
`debug/labCameras.ts`, `debug/OceanLab.ts`, `debug/BuoyancyLab.ts`.

### The cinematic composition — decided in conversation, not in the brief

The brief asked for the horizon to move nearer the top of frame at far scales
and for the ocean to fill more of the image. **Three successive attempts at that
were rejected by the author in review**, and the final design is deliberately
different. The reasoning is worth preserving because it will otherwise be
re-litigated:

1. *Tapering the horizon fraction* (0.33 at default → 0.20 at the far end).
   Rejected: reads as the camera scooping its nose down as you scroll out, with
   the sky draining away. Two things changing when only one was asked for.
2. *Raft centred in the band of water* (`F_raft = (F_h + 1) / 2`). Rejected:
   technically balanced, but with a third of the frame given to sky it puts the
   raft on the lower third line, and the sea beyond it is crushed into the top
   third while the sea on the camera's own side is cut off by the bottom edge.
   The author's words: *"you're showing me what's ahead, but not what's
   behind."*
3. *A raft-centre bias term* blending toward frame centre. Superseded by the
   author's own proposal, which is simpler and better.

**The design that shipped**: the camera runs out along **one straight line** at
a **constant 11° elevation**. Height and setback grow in proportion; nothing
rotates, nothing re-frames. Distance is the only authored quantity.

```
theta     = atan((1 - 2 F_h) tan(f/2))    optical pitch — constant, 8.62°
altitude  = distance * sin(11°)           the line
delta     = elevation - theta             aim offset, held constant under orbit
```

Measured across the whole range at 16:10:

| scale | distance | altitude | elevation | tilt | horizon | raft in frame | raft px @2880 |
|---|---|---|---|---|---|---|---|
| 0.00 | 12 m | 2.3 m | 11.0° | 8.62° | 33% | 54.7% | 246 |
| 0.40 | 45 m | 8.6 m | 11.0° | 8.62° | 33% | 54.7% | 66 |
| 0.75 | 330 m | 63 m | 11.0° | 8.62° | 33% | 54.7% | 9 |
| 1.00 | **1400 m** | **267 m** | 11.0° | 8.62° | 33% | 54.7% | 2.1 |

Against the brief's acceptance criteria: max distance 1400 m (needs ≥ 600),
max altitude 267 m (needs ≥ 180, prefers 250–350), min distance 12 m (was 22).
The open sea *between the viewer and the raft* at full zoom-out is 957 m, up
from 664 m under design 2 — that number is the one the author was reacting to
and is worth keeping an eye on if the geometry is touched again.

**The raft being nearly invisible at full zoom-out is intended**, not a defect
to be fixed. Author: *"the raft being so small it's not visible is dramatic and
makes the whole point."* This overrides the brief's "still locatable" wording.
Do not add an icon, a marker, or a minimum projected size.

Interpolation is monotone cubic Hermite (Fritsch–Carlson) on `ln(distance)`, so
the zoom is monotone at every point rather than only at the knots, and has no
rate discontinuity.

### 2.1 Vertical follow — reported from testing, fixed after the checkpoint

**The report**: with the sea state set to extreme, the raft heaved several
metres and the camera did not follow it, so the raft went in and out of frame.

Reproduced, and it was three faults stacked on one another. All three are fixed;
the numbers below are measured in-browser against `EXTREME_DEBUG` (Hs 18 m) and
`SOUTHERN_OCEAN_ROUGH` (Hs 6.8 m), with the idle drift disabled so the
measurement is of the follow alone.

**1. A fixed heave-carry fraction.** `HEAVE_CARRY = 0.15` was authored against a
moderate sea. The camera carried 15% of the raft's heave and lagged the other
85% — a few centimetres in `CURRENT_MODERATE`, seven and a half metres in
`EXTREME_DEBUG`. At the close end of the scale that is 33 degrees of arc against
a 24 degree half-field.

The fix is that **the carried fraction is no longer the authored quantity — the
framing error it may cause is** (`HEAVE_FRAME_BUDGET = 0.10` of frame height).
The lag is put through `softLimit` against a leash of
`2 · budget · tan(f/2) · horizontalDistance`, which is a metre at 12 m and 120 m
at 1400 m. Below a rough sea the leash is slack at every scale and the camera is
bit-for-bit the old constant-fraction one; above it, the camera rides the swell,
because by then that is the only thing that keeps the raft on screen.

`tanh` rather than a hard clamp: a clamp holds the lag at exactly the leash
length while the swell has it stretched and lets go at the crossing, which puts a
corner in the camera's vertical velocity twice a wave.

**2. The water-clearance floor tracked the mean of the sea, not its crests.** A
symmetric low-pass of the surface height sits *under water half the time*, so it
shoved the camera up at every crest and let it fall back in every trough — the
exact bobbing the filter was added to remove. It is now an asymmetric follower
(`attackRelease`, 0.35 s up / 20 s down) on the surface height **relative to the
raft's waterline** rather than in world height, because the camera's anchor now
tracks the raft and an absolute floor would swing against it by the full
amplitude of the swell.

**3. The clamp was folded back into the player's elevation offset.** One line —
`this.elevationOffset += elevation - rawElevation` — meant every crest that
raised the camera raised it *permanently*. Measured in `EXTREME_DEBUG`: the
camera had wound itself up to **45 degrees of elevation** and stayed there, a
bird's-eye view of a composition authored at 11. Only the hard limits
(`-0.5`, `ELEVATION_MAX`) are absorbed now; the water floor is a transient the
sea imposes and is left as a live clamp.

Measured, cinematic scale 0 (12 m) unless stated, as a fraction of frame height:

| | raft in frame | elevation | clearance |
|---|---|---|---|
| `EXTREME_DEBUG`, before | **−0.29 to 1.15** (off both edges) | 45.2–45.8° | — |
| `EXTREME_DEBUG`, after | 0.407–0.594 | 11.0–16.7° | 1.31 m |
| `SOUTHERN_OCEAN_ROUGH`, before | 0.333–0.707 | 14.1–16.3° | 0.54 m |
| `SOUTHERN_OCEAN_ROUGH`, after | 0.416–0.593 | 11.0–18.2° | 1.03 m |
| `SOUTHERN_OCEAN_ROUGH` @0.4, after | 0.446–0.542 | **11.00° flat** | 5.06 m |
| `CURRENT_MODERATE`, after | 0.484–0.523 | **11.00° flat** | 2.00 m |

The last two rows are the point about not regressing: at the default scale, and
in a moderate sea at any scale, the elevation is exactly the authored 11.00° and
the horizon exactly 33.2% — the signed-off composition, unmoved.

Covered by `tests/camera-follow.test.ts`, which measures where the raft lands by
*projecting it through the pose the controller produced* rather than by
re-evaluating the composition equations, and which carries the pre-fix anchor
alongside so the same run shows the old camera failing.

**Still open, found while fixing this and deliberately not touched:** the idle
azimuth drift adds `1.5°` of elevation to `elevationOffset` at the end of every
cycle and never gives it back, so a camera left alone climbs about 1.5° every 95
seconds — 9° over ten idle minutes. Same family as fault 3, different cause, and
it is a deliberate feature with an accumulating bug rather than a clamp leak.

### Embodied camera

Eye anchor derived on paper from the figure's actual geometry in `Raft.ts` and
then authored as a constant (the figure breathes ±8 mm; reading it back live
would pulse the camera):

```
figure origin      (-0.18, 0.19, 1.02), rotated -0.42 rad about Y
head centre        (0, 0.685, -0.045) in figure  ->  (-0.1617, 0.8750, 0.9789) in raft
EYE_ANCHOR         (-0.1963, 0.9050, 1.0565)     85 mm forward, 30 mm up
```

85 mm forward, not 55 mm: at 55 mm the eye sits **2.7 mm outside the torso
capsule**, inside the 0.06 m near plane, which slices the chest open. 85 mm
gives 21.6 mm of clearance.

The castaway is **seated**, so the eye is 0.66 m above the deck crown, not the
1.0–1.4 m the brief suggested — the brief explicitly defers to the actual pose.
The figure faces the bow (+z) and the rig is astern, so the default view opens
onto open water with the sail behind the player's shoulder. `DEFAULT_LOOK_YAW =
Math.PI + FIGURE_YAW`, derived rather than eyeballed.

Head stabilisation takes **position in full** (the eye is exactly where the deck
puts it, heave included) and attenuates only the **angles**, through a low-pass
then a follow fraction: roll 0.55, pitch 0.45, heave 0.9, τ 0.25 s. Yaw is
inherited unfiltered — the raft's heading wanders over tens of seconds and that
reads as being aboard something adrift, not as motion sickness.

Orientation is composed from quaternions, not `lookAt` with an up vector, so
+89° pitch is reachable with no yaw inversion and no NaN. Verified: zenith 89.0°,
down −85° clamp.

The castaway is culled by **proximity** (hidden within 1.15 m, shown beyond
1.45 m, hysteresis), which also covers the last frames of a transition without a
special case. No first-person body is built; that is the documented compromise.

### Look controls — changed on author feedback

Embodied look is **grab-the-world (street-view)**: drag right swings the view
left, drag down looks up. Gain 2.2 fields of view per screen-width, i.e. **194°
per full-width drag**, so a full turn is under two drags. The first
implementation used the opposite (joystick) convention at gain 1.35 and was
rejected as too slow and backwards.

Cinematic orbit is unchanged from the old rig's convention, except that the
elevation rate dropped from 0.62 to 0.42 rad per full-height drag — at 0.62 a
half-screen flick threw the horizon off the top of the frame.

### Transition

Cubic Bézier whose final tangent at the embodied end is **vertical**: the camera
descends onto the eye down a clear shaft forward of the mast rather than flying
in through the rigging. Lift height is solved from the raft's own masthead
(`raft.mastHead` transformed live), so it clears the rig with the sail raised or
stowed — the sail always hangs below the yard.

Both endpoints are re-evaluated every frame from the live controllers, so the
curve tracks the heaving raft and lands exactly on the destination pose.
Duration is solved from distance travelled, clamped to 0.7–1.4 s. Reversing
mid-flight is exactly continuous (smootherstep is symmetric, so reflecting the
elapsed time reproduces the value the other direction was about to produce).

Measured: 48.1° → 62.2° FOV, near 0.5 → 0.06, progress 0 → 0.38 → 0.74 → 1.00.

### Other fixes made along the way

- **Wheel `deltaMode` normalisation.** Firefox reports lines (`deltaMode 1`,
  `deltaY ≈ 3`); treating that as pixels needed ~700 notches to cross the range.
- **Sail-tap threshold** now scales with the projected mast and switches off
  below 20 px. At 1400 m the old fixed 153 px radius meant a tap anywhere near
  the middle of the sea raised the sail.
- **Water-clearance clamp** uses the *sampled* sea height under the camera, not
  a constant, low-passed at τ 1.5 s so the camera does not bob with individual
  crests, with one fixed-point refinement pass because the probe point depends
  on the elevation it is being used to compute.
- **Per-mode near planes**: cinematic `clamp(0.02·min(distance, altitude), 0.25,
  6)`, embodied 0.06. Depth precision goes as `z²/(near·2²⁴)`, so `near` is the
  only lever that matters and `far` stays at 25000.
- **`OceanLab`'s camera presets were dead code** — they wrote `rig.distance` and
  `rig.height`, fields that did not exist and were recomputed every frame. Now
  wired to `CameraSystem.setDiagnosticView(distance, altitude)`.
- **Mobile mode toggle**: double-tap on open water (touch has no `V`, and a
  permanent on-screen button is the HUD this scene does without).

---

## 3. What is left

Ordered by what blocks what.

### 3.1 Ocean rendering at altitude — the big one

Nothing here has been started. Two read-only analyses were run and their
findings are the plan. In priority order:

1. **Blend the ocean disc's centre toward the camera above ~80 m.**
   `main.ts` passes `(0, 0)` to `ocean.update`; pass
   `raft + (cameraGround - raft) · smoothstep(80, 400, cameraDistance)` instead.
   At 1400 m the foreground is currently **20 m triangles with every Gerstner
   component past its LOD fade** — a flat mirror plate — because `vLodRadius` is
   distance from the *raft*, and the water nearest the camera is the water
   furthest from the raft. Bit-identical below 80 m, so every existing capture
   and the buoyancy regression are preserved. **Trap**: `Ocean.ts` sets
   `uRaftPos` to the disc centre; it must be changed to the real raft position
   or the contact darkening follows the camera.
2. **Re-key the foam fades to texture UV instead of raft radius.** Prerequisite
   for (1). `nearFade`/`farFade`/`farStat` become Chebyshev distance in foam-UV
   space at `(0.28, 0.45)` and `(0.21, 0.59)` — these are today's radii divided
   by today's extents, so the current look is reproduced. Also fixes a
   pre-existing bug: `FoamField`'s valid window is centred on `drift`, not on the
   raft, so the near level's toroidal seam sweeps into view on a ~13-minute
   cycle. Re-key `live` to `footprint` (1.3 → 7.0 m) rather than 180–420 m.
3. **Footprint-prefilter the `fine` foam erosion** (`Ocean.ts:536`). It samples
   at a **2.2 cm cell** and hard-thresholds with no prefilter — guaranteed
   per-pixel foam sparkle at 4K that MSAA cannot touch.
4. **Make three hard-coded noise multipliers integer multiples of
   `uDetailFreq`** (0.42 → ×1, 0.85 → ×2, 0.62 → ×2). They currently break the
   `mod(vDetail, uDetailWrap)` identity, putting a **614.4 m grid of straight
   axis-aligned discontinuities** across the foam breakup, relief and jitter.
5. **Ramp the haze hold-back `0.93 → 1.0` with camera altitude.** The disc rim
   is a 7% hard radiance step; at 9.9 m eye height it *is* the horizon line and
   must stay, but at 267 m it is a false horizon 0.86° below the eye.

**Do not** change `NOISE_PERIOD` (the detail octaves fade on footprint long
before the 614 m tile could repeat — this was my initial instinct and it is
wrong), **do not** lengthen `uHazeDistance` (it is the main thing suppressing
spectral corduroy at altitude), and **do not** enable `logarithmicDepthBuffer`
(none of the hand-written shaders include the required chunks).

### 3.2 Automated camera tests

`tests/camera-follow.test.ts` exists and covers the vertical follow (§2.1) —
leash geometry, the saturation, the floor envelope, and eight controller-level
runs against multi-component wave trains built from the presets. That is one
category. The brief lists eight: scale curve, framing state, mode manager,
transition, embodied look, world-state isolation, input, serialisation boundary.
`cameraTuning.ts` is deliberately pure so most of this needs no renderer. The
transition's clearance against mast/yard/sail should be tested by walking
`samplePath` for every azimuth and scale, not by eye.

The follow tests are a template for the rest: drive the controller with a
synthetic `CameraContext`, and assert on what the *frame* did, measured by
projection, not on what the controller was asked for.

### 3.3 Documents

`docs/camera/CAMERA_SYSTEM.md` and `docs/camera/CAMERA_ROUND_REPORT.md` are both required by the brief
and neither exists. `README.md` (controls table still says "Zoom (22–60 m)",
no `V`, no double-tap, no Camera panel) and `docs/project/FUTURE_ROUNDS.md` (should mark this
round complete and name the graphics round next) both need updating.

### 3.4 Verification matrix

The brief lists 18 required captures plus responsive sizes plus transitions in
three sea states. So far: baselines, a scale sweep, an embodied smoke test and
one transition sequence — all at 1440×900, all in `CURRENT_MODERATE` except the
baselines. Still needed: noon and night far views, high bird's-eye, low
horizon-level orbit, calm and Southern-Ocean-rough at every scale, 3840×2160,
390×844 portrait, mobile landscape, and the transition from minimum and maximum
scale with the sail both raised and lowered.

Performance has not been measured at 4K or at mobile viewports. The stepped
profiler in `tools/camera-evidence.js` reports ~1.5 ms/frame at 2880×1800, but
`gl.finish()` is not a reliable GPU fence in this browser and that number should
be treated as CPU submit time only.

> Still true about that number, but there is now a way to take a real one:
> `src/render/GpuProfiler.ts` (timer queries, disjoint honoured), driven
> headlessly per `docs/graphics/SHADOW_ROUND_HANDOVER.md`. Marked 2026-08-16.

### 3.5 Visual-critic passes

Zero of the permitted three have run.

---

## 4. Known defects

Everything here is observed, not suspected.

1. **The far view washes out to near-white at noon.** `uHazeDistance = 2600` is
   a hazy-day value; at 1400 m with several km of sea on screen the sea is 30–70%
   blended to horizon-sky. Worst in `probe/far-noon.jpg` and `probe/mid-rough.jpg`.
   Mitigated by §3.1 items 1 and 5; final visibility is arguably the graphics
   round's call.
2. **Foreground at altitude is a flat plate** — §3.1 item 1.
3. **Foam reads as blobs then as uniform dither at altitude**, with visible
   concentric LOD rings centred on the raft — §3.1 item 2.
4. **Radial moiré in a steep bird's-eye**, from looking down the disc's spoke
   axis (`probe/far-steep.jpg`).
5. **The raft is un-hazed while the sea is hazed.** There is no `scene.fog` and
   every raft material has `fog: false`, so at 1400 m a crisp dark speck sits on
   a 40%-hazed sea. Fixable with `onBeforeCompile` reusing the ocean's own haze,
   but it touches materials, which is the next round's territory.
6. **The ocean lab's `waterline` and `crest` viewpoints are now subject to the
   production sea-clearance clamp** and will be raised above the height they ask
   for. Genuine waterline inspection belongs to the buoyancy lab's dedicated
   cameras. Documented, not accidental.
7. **`.claude/launch.json` carries a second entry** (`drift-camera`, port 5178)
   because ports 5173–5175 were occupied by sibling worktrees. Harmless; remove
   if unwanted.
8. **The idle azimuth drift ratchets the elevation.** `updateDrift` folds its
   `1.5°` elevation lift into `elevationOffset` at the end of every cycle and
   never returns it, so an untouched camera climbs ~1.5° every 95 s — 9° over ten
   idle minutes, and the horizon with it. Found while fixing §2.1 and left alone:
   it is a feature accumulating rather than a clamp leaking, and the fix is a
   design question (should the drift return to where it started, or should the
   lift be part of a longer cycle that comes back down?) rather than a defect
   with one right answer.
9. **In `EXTREME_DEBUG` at the closest scale the camera flies at 11–17° rather
   than the authored 11°.** The sea genuinely requires it: crests reach ~20 m
   and the camera is 11.5 m from the raft. The horizon moves with it, 24–33% from
   the top. Correct, and the raft stays put — but it is the one place where the
   composition is not exactly what was authored, and it is worth knowing before
   someone reports it as a second bug.

---

## 5. Invariants that must not regress

Verified at this checkpoint; re-verify after any further change.

- `PlanetaryWorld`, WGS84/ECEF, geodesics, clocks, astronomy, star orientation
  and the world-render adapter are **untouched**.
- `RaftBuoyancy`, the sea-state model, `WaveField`'s CPU/GPU equations, inverse
  sampling, orbital-velocity contract and the persistent-foam history are
  **untouched**.
- The camera reads the raft's *presentation* pose and the sea surface through
  `CameraContext` and has no route to canonical position, velocity or time.
- `Ambience` remains non-positional Web Audio with **no** `THREE.AudioListener`.
  This is valid and deliberate; do not add one.
- `?debug=buoyancy` and `?debug=ocean` still work and still open the same shared
  panels as the visible launcher. `?debug=camera` was added alongside.
- All 100 pre-existing tests pass, plus the 14 in `tests/camera-follow.test.ts`.
- The authored composition — 11.00° elevation, 33.2% horizon, raft at 54.7% —
  is **exact** at every scale in `CURRENT_MODERATE` and at the default scale in
  `SOUTHERN_OCEAN_ROUGH`. §2.1 changed the vertical follow and the water floor;
  neither may move that composition in any sea a player is meant to sail.

---

## 6. Reproducing the evidence

```bash
node tools/capture-server.mjs evidence/camera 5201
npm run dev
```

Then in the browser console at `http://127.0.0.1:5173/?capturePort=5201`:

```js
const cam = await (await import('/tools/camera-evidence.js')).install();
cam.reset({ sea: 'CURRENT_MODERATE', solar: 18.85 });
cam.drift.cameras.cinematic.setScale(1.0);
cam.settle(2);
await cam.shot('far-aerial');
console.log(cam.report());
```

`cam.report()` returns measured geometry — distance, altitude, elevation,
optical pitch, horizon fraction, where the raft lands in frame, raft pixel width,
draw calls, triangles — read back from what the controllers actually produced, so
a clamp shows up instead of being hidden behind the value that was requested.
Frames are stepped and rendered synchronously in one task, so nothing depends on
`requestAnimationFrame` pacing.

`cam.raftSweep(seconds)` returns the raft's vertical excursion in frame over a
span of time as `{min, max, span}`. The §2.1 regression is invisible in any
single still, so anything about the sea's effect on framing wants this rather
than a screenshot. Note that the idle azimuth drift will contaminate a long run
— `drift.cameras.cinematic.setDriftEnabled(false)` first.

`evidence/` is git-ignored by existing repo convention. Captures referenced
above live under `evidence/camera/{baseline,scale,scale2,scale3,line,probe,embodied}/`.
