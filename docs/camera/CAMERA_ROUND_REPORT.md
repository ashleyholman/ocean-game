# Camera round — report

Stage 2 of 3. The design is `docs/camera/CAMERA_SYSTEM.md`; this records what was built,
what was measured, what was found and what is left.

Every number below is measured in a real browser against the real application,
read back from what the controllers actually produced rather than recomputed
from the curve — so a clamp shows up instead of hiding behind the value that was
requested.

---

## 1. Architecture

`src/scene/CameraRig.ts` is gone. Its replacement is `src/camera/`:

| File | Responsibility |
|---|---|
| `cameraTuning.ts` | All numbers and curves. Pure — no three.js, no DOM, no state, fully testable without a renderer. |
| `types.ts` | `CameraContext`, `RaftAnchor`, `CameraPose`. |
| `CinematicCameraController.ts` | Orbit, scale, follow, heave leash, water clamp. |
| `EmbodiedCameraController.ts` | Eye anchor, free look, head stabilisation. |
| `CameraTransition.ts` | The mode change. |
| `CameraSystem.ts` | Mode manager, sole owner of the one `PerspectiveCamera`. |
| `src/ui/CameraPanel.ts` | Debug panel, dynamically imported. |

Rewired consumers: `main.ts`, `input/InputController.ts`, `ui/DebugPanel.ts`
(the 22–60 m distance slider is gone — distance is now one output of a curve and
a slider setting it directly would contradict the altitude), `debug/labCameras.ts`,
`debug/OceanLab.ts`, `debug/BuoyancyLab.ts`.

Controllers produce poses; only `CameraSystem` copies one onto the camera. A
controller owns nothing a renderer would accept, which makes "one active camera"
structural rather than a convention.

## 2. The cinematic scale curve

Distance is the only authored quantity, at seven knots, interpolated with
monotone cubic Hermite on `ln(distance)`. Measured through the controller at
1440×900:

| scale | distance | altitude | elevation | optical pitch | horizon | raft in frame | raft px |
|---|---|---|---|---|---|---|---|
| 0.00 | 12 m | 2.3 m | 11.0° | 8.6° | 33.0% | 55.5% | 162 |
| 0.40 | 45 m | 8.6 m | 11.0° | 8.6° | 33.0% | 55.3% | 43 |
| 0.75 | 330 m | 63 m | 11.0° | 8.6° | 33.0% | 54.7% | 5.9 |
| 1.00 | **1400 m** | **267 m** | 11.0° | 8.6° | 33.0% | 54.7% | **1.4** |

The horizon and the raft's place in frame are identical at every scale to the
digit, because the aim is solved from the composition rather than from the raft's
position. Zooming is a pure translation.

**Against the acceptance minimums**: maximum distance 1400 m (needs ≥ 600),
maximum altitude 267 m (needs ≥ 180, prefers 250–350), minimum distance 12 m (the
old rig bottomed out at 22 m). Far altitude is 116× the near altitude.

The raft being nearly invisible at full zoom-out is intended, not a defect. There
is no icon, no marker and no minimum projected size.

## 3. Ocean rendering at altitude

Six changes; the first is the substantive one.

**The disc centres on the observer.** Its rings grow exponentially outwards, so
at 1400 m out and 267 m up a raft-centred disc puts its coarsest, most faded
water directly under the lens — a flat plate in the foreground of the shot that
is supposed to be about the sea. Before and after, at maximum zoom in
`SOUTHERN_OCEAN_ROUGH` at sunset: `evidence/camera/m/04-far-sunset.jpg` has
legible swell forms with real light and shade in the foreground; the raft-centred
version is a uniform small-scale ripple with no macro structure at all.

The blend is `smoothstep(200, 900, separation)`. That range is measured, not
guessed — moving the centre moves the raft *out* of the fine rings, so the
surface drawn under it loses the components the LOD fades at that radius:

| scale | disc offset | rendered water shifts by | in pixels | raft is |
|---|---|---|---|---|
| 0.60 | 8 m | 0.00 m | 0.0 px | 17.3 px |
| 0.75 | 27 m | 0.00 m | 0.0 px | 7.0 px |
| 0.88 | 662 m | 0.38 m | 0.8 px | 3.0 px |
| 1.00 | 1374 m | 1.03 m | 2.0 px | 1.7 px |

The analysis first proposed `(80, 400)`. At that range the medium vista sat 278 m
off centre and the raft floated 2 px above water 6.7 px wide — trading a
foreground the camera is not looking at for a registration error on the subject
it is. Past 900 m the raft is under three pixels and a pixel of shift is not a
thing anyone can see.

The other five: foam levels fade on **their own texture window** in Chebyshev UV
rather than on radius (which also fixes a pre-existing bug — the field's valid
window is centred on the surface drift, so the near level's toroidal seam swept
into view on a ~13-minute cycle); three hard-coded noise multipliers become
integer multiples of `uDetailFreq`, removing a **614 m grid of straight
axis-aligned discontinuities** through the foam; the fine foam erosion is
footprint-prefiltered instead of hard-thresholded at a 12 cm cell; the residual
wave term is **band-limited at Nyquist** instead of at 1.33 samples per
wavelength; and the haze hold-back ramps out with altitude, so the disc rim stops
drawing a false horizon 0.86° below the eye.

## 4. The embodied camera

Eye anchor derived on paper from the figure as built, then authored as a
constant: `(-0.1963, 0.9050, 1.0565)`, 0.66 m above the deck crown because the
castaway is seated. 85 mm forward of the head centre rather than 55 — at 55 the
eye sits 2.7 mm *outside* the torso capsule, inside the 0.06 m near plane, which
slices the chest open.

Full 360° of yaw; pitch −85° to +89°, with the zenith verified reachable and the
real star catalogue visible there (`evidence/camera/m/11-embodied-zenith-night.jpg`,
with a stay crossing the lower frame so the raft is still legible). Orientation
is composed from quaternions, so there is no yaw inversion or NaN at the pole.

The default view opens on **two thirds sky**, authored as a frame fraction and
inverted into an angle per aspect. The sail is real geometry and physically
occludes (`m/09`); lowering it opens the view (`m/10`).

**Head stabilisation shipped at roll 0.10, pitch 0.20, heave 0.90**, smoothing
0.25 s. Settled by sitting in it. The angular terms can be cut almost to nothing
before the view stops reading as attached to the boat; the translation is what
makes it feel like a boat at all and is not nauseating. The first pass at 0.55
and 0.45 was derived from what a neck does — but a neck is attached to an inner
ear that agrees with it, and a player's is not.

## 5. Transitions

A straight line, 0.7–1.4 s, with an asymmetric ease that leaves quickly and
arrives slowly. Measured at 1440×900 in `CURRENT_MODERATE`:

| | 0% | 20% | 40% | 60% | 80% | 100% |
|---|---|---|---|---|---|---|
| default (0.4), height | 8.6 m | 7.7 | 4.9 | 2.0 | 0.9 | 0.8 |
| default, speed | 0 | 59 m/s | **97** | 62 | 13 | 0 |
| far (1.0), height | 267 m | 236 | 143 | 46 | 5.6 | 1.0 |
| close (0.0), height | 2.3 m | 2.1 | 1.6 | 1.0 | 0.8 | 0.8 |

Duration: 0.80 s from the close scale, 0.95 s from the default, 1.40 s from
maximum aerial.

**Two authored departures from the brief**, both on the author's instruction
after seeing the alternative:

- *The path does not avoid the rigging.* The first version arced over the
  masthead and descended a vertical shaft, provably clear of mast, yard, sail and
  deck by 0.54 m at every azimuth and scale. It still read as "arrives above mast
  height and then just drops down into place", which is what any path with a
  vertical final tangent does. The destination is inside the castaway's head, so
  the view is clear on arrival whatever route is taken.
- *The cinematic azimuth is not preserved across a switch; the bearing is.*
  Entering, the embodied look adopts the camera's bearing; leaving, the azimuth
  is derived back from the look. Measured: bearing 48° outside → 48° aboard →
  turn the head 120° → 168° aboard → 168° outside, with the azimuth re-derived
  from 132° to 12°. An immediate there-and-back recovers the azimuth to under
  half a degree. What it does not survive is turning your head while aboard —
  which is precisely the case where restoring the old azimuth is the surprise.

Pitch is not inherited: it levels to the authored embodied pitch *during* the
dive, so the view comes up to the horizon as the camera comes down to the eye.

## 6. Defects found and fixed

Four were live bugs in the checkpointed code, found by testing rather than by
reading.

**1. The camera did not follow the raft's heave in a high sea.** Reported from
play. A fixed 15% heave carry is a composition in a moderate sea and a lost raft
in a high one. Measured at the closest scale, as a fraction of frame height:

| | raft in frame | elevation | clearance |
|---|---|---|---|
| `EXTREME_DEBUG` before | **−0.29 to 1.15** — off both edges | 45.2–45.8° | — |
| `EXTREME_DEBUG` after | 0.407–0.594 | 11.0–16.7° | 1.31 m |
| `SOUTHERN_OCEAN_ROUGH` before | 0.333–0.707 | 14.1–16.3° | 0.54 m |
| `SOUTHERN_OCEAN_ROUGH` after | 0.416–0.593 | 11.0–18.2° | 1.03 m |
| `CURRENT_MODERATE` after | 0.484–0.523 | **11.00° flat** | 2.00 m |

It was three faults stacked: the fixed carry fraction; a water floor tracking the
*mean* of the sea, which is under water half the time, so it shoved the camera up
at every crest; and the clamp being folded back into the player's elevation
offset, which **ratchets** — every crest raised the camera permanently, and in
`EXTREME_DEBUG` it had wound to 45° against an authored 11°.

**2. The idle drift ratcheted the elevation.** It added 1.5° of elevation per
cycle and never gave it back, so an untouched camera climbed ~1.5° every 95 s —
9° over ten idle minutes, taking the horizon with it. Now azimuth-only: three
minutes idle moves the azimuth 132°→156° with the elevation pinned at exactly
11.000° and the horizon at 33.2%.

**3. The transition passed through the sail.** Found by walking the curve across
32 azimuths × 5 scales × sail raised and stowed, not by eye — a cubic Bézier with
a vertical final tangent still carries 0.8% of a control point 180 m away right
to the end, which is a metre and a half of lateral offset among the rigging. This
was fixed, and then the whole arc was replaced with a straight line (§5), which
makes it moot.

**4. `cinematicDistance(NaN)` returned NaN.** `value < 0 ? 0 : ...` passes NaN
through, because every comparison against NaN is false. One NaN upstream would
become a NaN camera matrix and a scene that silently stops drawing. The clamps
now test `>=` first, which launders it.

## 7. Test coverage

**164 tests, all passing.** 100 pre-existing (planetary, raft-water, sea-state,
CPU/GPU parity, shader source) plus 64 new.

| Category | Where |
|---|---|
| Cinematic scale curve | `camera.test.ts` — clamping, NaN, strict monotonicity at 4000 points, C1 rate continuity at 20000, knot fidelity, required range |
| Camera framing state | azimuth retained across zoom, elevation held as an offset, orbit limits, six viewport shapes, reset |
| Mode manager | toggle, composition round-trip, arrival bearing, exit bearing, one input owner, one camera, no audio listener |
| Transition | duration band, exact landing from three scales, monotone progress, finite matrices, mid-flight reversal, straight-line property, ease shape, ease inverse |
| Embodied look | full turn without inversion, zenith and floor, yaw stability at the pole, violent raft attitudes, default composition, FOV clamps |
| World-state isolation | canonical snapshot byte-identical after every control; context shape; frame-rate independence at 30/60/144 Hz |
| Input | drag, pinch symmetry, wheel `deltaMode` normalisation, `V`, double-tap, form-field guard, listener release, zero viewport |
| Serialisation boundary | no camera state in the snapshot, JSON round-trip, hostile restore sanitised |
| Vertical follow | `camera-follow.test.ts` — leash geometry, saturation, floor envelope, eight controller runs against multi-component wave trains built from the presets, with the pre-fix anchor carried alongside so the same run shows the old camera failing |
| Shader invariants | `shader-source.test.ts` — wrapped-detail sampling, residual band limit |

The follow tests are the template for the rest: drive the controller with a
synthetic `CameraContext` and assert on what the *frame* did, measured by
projection, not on what the controller was asked for.

## 8. Performance

The stepped profiler in `tools/camera-evidence.js` reports CPU submit time only —
`gl.finish()` is not a reliable GPU fence in this browser. These are real
presented frame rates, counted over rAF:

| | 1920×1080 | 3840×2160 |
|---|---|---|
| Default composition | 57.8 fps | 24.5 fps |
| Far aerial | **70.9 fps** | **25.7 fps** |
| 390×844 portrait (dpr 2) | 110.8 fps | — |
| 844×390 landscape | 120.7 fps | — |

**The far aerial view is not more expensive than the default.** The camera range
costs nothing; the cost is fill rate. The 4K figure of ~25 fps is below the
brief's ~30 fps target, measured in an embedded browser pane rather than on a
native 4K desktop, so treat it as a lower bound — and note that production caps
the pixel ratio at 2 (1.75 on small screens), so a 4K panel at a 1920-point
window renders exactly this.

No allocation happens in the camera update loop: the context object is mutated
in place, and every controller's scratch vectors are fields.

## 9. Verification matrix

53 captures under `evidence/camera/` (git-ignored by repo convention).

- `m/01`–`m/14` — the eight cinematic and six embodied cases at 1440×900:
  close/default/medium/far at sunset, far at noon and at night, a 82° bird's-eye,
  a horizon-level orbit, embodied with sail raised and stowed, zenith at night,
  down at deck and water, horizon at sunset, and the Moon at night (found at its
  computed bearing of −110° and altitude 18°, not placed by hand).
- `r/15`–`r/18` — 3840×2160, 1440×900, 390×844 portrait, 844×390 landscape, plus
  4K far aerial and mobile embodied.
- `sea/` — calm and Southern-Ocean-rough at close, default, far and embodied.
- `t/` — five transition frames each at 0/25/50/75/100% from close, default and
  maximum scale, sail raised and stowed, and the return leg.

Fresh loads and every debug deep link (`?debug=1`, `?debug=camera`, `?debug=ocean`,
`?debug=buoyancy`) produce no console errors. The Tools launcher lists World &
lighting, Camera, Ocean laboratory and Buoyancy lab; `Hide all` gives a clean
frame with no camera HUD.

## 10. Visual acceptance

| | |
|---|---|
| Zoom reveals substantially more ocean? | Yes — 12 m/2.3 m to 1400 m/267 m. |
| Meaningful altitude? | Yes — 116× |
| Waves smaller through perspective? | Yes |
| Far view communicates solitude and scale? | Yes |
| Raft tiny without becoming an icon? | Yes — 1.4 px, nothing added |
| Close raft inspection? | Yes — 162 px at 12 m |
| Embodied feels located on the raft? | Yes |
| Directly upward at the stars? | Yes |
| Sail obstructs physically but tolerably? | Yes |
| Lowering the sail opens the view? | Yes |
| Transitions smooth and free of clipping? | Smooth. Passes through rigging by design (§5). |
| Ocean convincing at the farthest range? | At sunset and at night, yes. **At noon it washes out** — atmosphere, not geometry. |
| Visible mesh edges, repetition, shimmering? | No edges, no repetition. Residual ridging exists but is below the haze. |
| Mobile composition usable? | Yes |
| Planetary or astronomical regression? | None |

## 11. Known limitations

1. **The far view washes out to near-white at local noon.** `uHazeDistance` is a
   hazy-day 2600 m and there are kilometres of sea on screen. Graphics round.
   Lengthening the haze is not the fix: at 12000 m the mid-band shows parallel
   ridging the haze is currently masking. The residual band limit (§3) reduces
   that but does not remove it — it is inherent to summing a few dozen coherent
   Gerstner components, and removing it properly means a spectral rewrite the
   brief explicitly rules out.
2. **The raft is unhazed while the sea is hazed.** No `scene.fog`, and every raft
   material sets `fog: false`, so at 1400 m a crisp dark speck sits on a
   40%-hazed sea. Fixable with `onBeforeCompile` reusing the ocean's own haze,
   but it touches materials.
3. **4K runs at ~25 fps** in the measured environment (§8).
4. **Aspects near 1:1** put the raft at 49.2% rather than 54.7%. No supported
   viewport is that shape.
5. **The transition passes through the rigging**, by instruction (§5).
6. **The cinematic azimuth is not preserved across a mode switch**, by
   instruction (§5). The bearing is.
7. **At the closest scale in `EXTREME_DEBUG` the camera flies at 11–17°** rather
   than the authored 11°. The sea genuinely requires it: crests reach ~20 m and
   the camera is 11.5 m from the raft. The raft stays put; the horizon moves.
8. **The ocean lab's `waterline` and `crest` viewpoints** are subject to the
   production sea-clearance clamp and will be raised above the height they ask
   for. Genuine waterline inspection belongs to the buoyancy lab's dedicated
   cameras.
9. **No first-person body.** The castaway is culled whole within 1.15 m.

## 12. Commands

```bash
npm ci
npm run typecheck     # passes
npm test              # 164 passing
npm run build         # passes
```

Browser verification:

```bash
node tools/capture-server.mjs evidence/camera 5203
npm run dev
```

Then, in the console at `http://127.0.0.1:5174/?capturePort=5203`:

```js
const cam = await (await import('/tools/camera-evidence.js')).install();
cam.reset({ sea: 'CURRENT_MODERATE', solar: 18.85 });
cam.drift.cameras.cinematic.setDriftEnabled(false);   // or it contaminates long runs
cam.drift.cameras.cinematic.setScale(1.0);
cam.settle(20);
await cam.shot('far-aerial');
console.log(cam.report());
```

`cam.report()` returns measured geometry — distance, altitude, elevation, optical
pitch, horizon placement, where the raft lands in frame, raft pixel width, sea
state, significant height. `cam.raftSweep(seconds)` returns the raft's vertical
excursion in frame over a span of time, which is the only way to see the §6.1
regression: it is invisible in any single still.
