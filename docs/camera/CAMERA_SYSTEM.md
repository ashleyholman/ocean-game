# Camera system

The design document for stage 2 of 3: the multi-scale cinematic and embodied
camera. It defines what the system is; `docs/camera/CAMERA_ROUND_REPORT.md` records what was
built against it and what was measured.

**The camera/graphics boundary.** Composition and geometric correctness are
requirements now. Final art direction — lighting, atmosphere, colour response,
water optics, material refinement — is the next round's, and this round
deliberately does not pre-empt it. Where a viewpoint is geometrically sound but
does not yet look finished, that is the boundary working as intended, and §12
names the three specific handovers.

---

## 1. Modes

Two, and only two, both entered manually.

| | Cinematic | Embodied |
|---|---|---|
| Where | Outside the active vessel, on an orbit | At the seated castaway's eyes |
| Says | One vessel inside an immense ocean | I am aboard the vessel |
| Scale | 12–1400 m for every vessel | Fixed |
| Drag | Orbits | Looks |
| Wheel / pinch | Scale | Inert |
| Field of view | 42–62° vertical | 58–70° vertical |

There is no automatic idle or watch mode. `CameraSystem.setMode` is the single
hook one would drive.

## 2. Coordinate spaces

The camera lives entirely in **local render coordinates** and reads only the
active vessel's *presentation* pose and immutable framing envelope. It has no
route to canonical state.

```
CanonicalWorldState  (ECEF, UTC, geodesic)     <- untouched by the camera
   |  WorldRenderAdapter
   v
render frame (transported local tangent frame)
   |  vessel dynamics -> vessel.group.matrixWorld
   v
CameraContext  { dt, vessel{matrixWorld,pitch,yaw,roll,x,z,waterlineY,
                 designWaterlineY,framing}, waterHeightAt(x,z) }
   |
   v
CameraPose { position, quaternion, fov, near }
```

`CameraContext` is the whole of the camera's window onto the world, and it is
deliberately narrow: there is nothing on it that could move the vessel, advance a
clock, or reach an ECEF coordinate. That makes world-state isolation
*structural* rather than a rule someone has to remember, and there is a test
asserting the interface's shape so that it stays that way.

The camera's altitude is a local presentation coordinate. Flying to 267 m does
not change the vessel's latitude, longitude, ECEF position, solar time or
astronomical observer location, and astronomy continues to be computed for the
vessel.

## 3. Active-camera ownership

There is exactly **one** `THREE.PerspectiveCamera` in the application, owned by
`CameraSystem`.

The two controllers and the transition produce *poses*. `CameraSystem` is the
only thing that copies a pose onto the camera. Neither controller owns anything
a renderer would accept, so "one active camera" cannot be violated by accident —
a controller cannot render itself, and two of them cannot fight over the frame.

The ocean laboratory's inspection viewpoints move the production camera through
`setDiagnosticView(distance, altitude)` rather than standing up a rival rig.

## 4. Input routing

Input arrives at `CameraSystem` and is dispatched to whichever controller is
active. `InputController` converts gestures to pixels and knows nothing about
modes; routing per mode there would put a copy of the mode state in a second
place, and the two would eventually disagree.

During a transition, input is dropped. A camera being flown somewhere is not a
camera the player is steering.

| Gesture | Cinematic | Embodied |
|---|---|---|
| One-pointer drag | Orbit: 1.5π rad azimuth per screen width, 0.42 rad elevation per screen height | Look: 2.2 fields of view per screen width |
| Wheel | Scale, normalised across `deltaMode` | — |
| Pinch | Scale, by the log of the finger-distance ratio | — |
| `V` | Change mode | Change mode |
| Double-tap on open water | Change mode | Change mode |
| Tap on the sail or mast | Raise or lower the sail | — |

Both look conventions are **grab-the-world**: the scene follows the pointer.
Pinch maps the log of the ratio because the scale is logarithmic, so spreading
the fingers by the same factor changes the scale by the same amount wherever you
are on the curve. Wheel deltas are normalised out of `deltaMode` — Firefox
reports lines, not pixels, and treating three lines as three pixels needs
several hundred notches to cross the range.

## 5. The cinematic scale parameter

One normalised parameter, `cinematicScale01 ∈ [0, 1]`, drives everything.

**Distance is the only authored quantity.** Seven knots are
interpolated with monotone cubic Hermite (Fritsch–Carlson) on `ln(distance)`:

| scale | 0.00 | 0.20 | 0.40 | 0.60 | 0.75 | 0.88 | 1.00 |
|---|---|---|---|---|---|---|---|
| distance | 12 m | 25 m | 45 m | 130 m | 330 m | 750 m | 1400 m |

When an active vessel is assembled, one `Box3` traversal captures an immutable
eight-corner local envelope and publishes its width, height, length and radius
through `CameraContext`. It does **not** change these distances. Instead, the
controller finds a neutral Y-only lift that places the silhouette inside the
8–92% vertical safe frame when possible at one stable reference view. When the
silhouette is too large there, it centres the unavoidable crop. That calculation
produces one constant vertical offset, not another zoom curve: the same offset
is added at 12 m, 45 m and 1400 m. The resulting camera positions are therefore
exactly collinear, while unrestricted close inspection is preserved. The offset
is cached; normal frames neither solve it again nor traverse mesh geometry.

Log space because a linear slider over 12–1400 m spends 96% of its travel above
40 m. Monotone Hermite rather than a plain cubic because a spline through rising
knots can dip *backwards* between them — the zoom would be non-monotonic in the
middle of its range while still passing through every authored value.

Everything else follows:

```
baseAltitude = distance · sin(11°)
trackY       = baseAltitude + constantVesselLift
cameraY      = max(trackY, exceptionalLiveWaterSafety)
theta        = atan((1 − 2·F_horizon)·tan(f/2))    optical pitch
delta        = 11° − theta                          aim offset, held under orbit
```

## 6. Optical framing

**Four quantities that are not the same quantity**, and conflating any two of
them is the classic way to get this wrong:

1. **Elevation** — the angle of the camera *position* above the vessel.
2. **Optical pitch** — the downward tilt of the camera's forward *axis*.
3. **Framing target** — the point the axis passes through, deliberately not the
   vessel.
4. **Vessel screen position** — a *consequence* of the first three, not an input.

`camera.lookAt(vessel)` forces `delta = 0`, which pins the vessel to the exact centre
of the frame and drags the horizon to wherever that leaves it. It is wrong at
every scale, not just some of them.

**Two rules, held exactly, at every scale:**

- **The horizon does not move.** It sits a third of the way down the frame at
  every distance (0.38 on a portrait phone — a tall frame two-thirds full of
  water reads as a wall).
- **The camera follows one line parallel to the original 11° ray.** Vessel
  framing chooses that line's constant Y offset, but never changes it by zoom
  level and never changes distance, scale or orientation.

The fixed orientation keeps the horizon at 33.0%. A framing lift moves the
vessel lower in the picture, trading blank foreground water for mast and sail
room without tilting the view.

11° rather than something steeper because the identity
`F_vessel − F_horizon = tan(elevation) / (2·tan(f/2))` fixes the vessel's place from
the elevation alone. At 13.7° the vessel lands on the lower-third line with the
sea beyond it crushed into the top third; at 11° it lands just above the middle
of the water, and the near edge of visible sea moves in from 38% of the vessel's
distance to 48% of it. The cost is distance, not height.

The aim offset `delta` is held constant as the player orbits. The vessel track
is translated upward as a whole with that orientation held, so the close view
looks down onto the deck and the vessel has more room above it in frame.

**Field of view** is hybrid Hor+: hold the horizontal field, clamp the derived
vertical. Pure Hor+ on a tall phone gives a 130° vertical field that bends the
horizon into a smile; pure Vert− on a wide desktop throws away the width the
composition is built around.

## 7. Following the raft

The camera follows the raft's horizontal anchor through a critically damped
spring, takes **none** of its angular motion, and carries as much of its vertical
heave as the framing requires and no more.

That last clause is the part with a real design in it. A camera that carries a
fixed fraction of the heave is a composition in a moderate sea and a lost raft in
a high one: in `EXTREME_DEBUG` the waterline swings ±9 m, and carrying 15% of it
leaves 7.6 m of relative heave — 33° of arc against a 24° half-field at the close
end of the scale.

So the carried fraction is not authored; **the framing error it may cause is**.

```
leash = 2 · HEAVE_FRAME_BUDGET · tan(f/2) · horizontalDistance
lag   = leash · tanh((raftY − 0.15·lowpass(raftY)) / leash)
```

`HEAVE_FRAME_BUDGET` is 0.10 of frame height. The leash is linear in the
separation — a metre at 12 m, 120 m at 1400 m — so the same rule gives a nearly
rigid vertical follow up close and leaves the composition untouched at altitude,
with no second curve and no sea-state input. `tanh` rather than a hard clamp
because a clamp holds the lag at exactly the leash length and then lets go at the
crossing, which puts a corner in the camera's vertical velocity twice a wave.

**The water clamp.** The camera never crosses the sea. The floor is measured
against the water actually under the camera, expressed *relative to the raft's
waterline*, and tracked with an asymmetric follower — 0.35 s up, 20 s down.
Asymmetric because a symmetric filter returns the *mean* of a wave train, and a
floor at the mean is under water half the time, so it shoves the camera up at
every crest and drops it back in every trough. This is another Y-only
translation; distance and orientation remain the player's authored values.

The clamp is **not** folded back into the player's elevation offset. Doing so
ratchets: every crest raises the camera permanently, and in `EXTREME_DEBUG` it
had wound the camera to 45° of elevation against an authored 11°.

## 8. The embodied camera

**The anchor is authored, not inferred.** Derived once on paper from the figure
as built in `Raft.ts`:

```
figure origin      (-0.18, 0.19, 1.02), rotated -0.42 rad about Y
head centre        (0, 0.685, -0.045) in figure  ->  (-0.1617, 0.8750, 0.9789) in raft
EYE_ANCHOR         (-0.1963, 0.9050, 1.0565)     85 mm forward, 30 mm up
```

Reading it back from the head mesh every frame would tie the camera to a vertex
that breathes by 8 mm. The 85 mm is not arbitrary either: at 55 mm the eye sits
2.7 mm *outside* the torso capsule, inside the 0.06 m near plane, which slices
the chest open.

The castaway is **seated**, so the eye is 0.66 m above the deck crown, not the
1.0–1.4 m of a standing adult. The brief defers to the actual pose.

**Look range.** Full 360° of yaw, pitch from −85° to +89°. Orientation is
composed from quaternions rather than a look-at with an up vector, so the zenith
is reachable with no yaw inversion and no NaN — the clamp is a comfort choice,
not a numerical rescue.

**Default composition.** Two thirds of the frame is sky. Authored as a frame
fraction and inverted into an angle per aspect, because the embodied field of
view clamps at both ends of the aspect range and a fixed pitch would put the
horizon somewhere different on a phone than on a desktop. Sitting on a raft, the
water within a few metres is most of what a downward gaze shows and the least
interesting thing in the scene.

## 9. Head stabilisation

Position in full, angles cut hard.

| | roll | pitch | heave | smoothing |
|---|---|---|---|---|
| shipped | 0.10 | 0.20 | 0.90 | 0.25 s |

The asymmetry is the finding. The *angular* terms are what make an on-deck camera
unpleasant, and they can be cut almost to nothing before the view stops reading
as attached to the boat — a tenth of the raft's roll is still visibly a boat
rolling. The *translation* is what makes it feel like a boat at all, and it is
not nauseating, because being lifted and dropped is exactly what the player can
see happening to the water around them.

These were 0.55 and 0.45 on the first pass, derived from what a neck does. A neck
is attached to an inner ear that agrees with it; a player at a desk has an inner
ear that says the room is still, and every degree the horizon tilts is a degree
of that disagreement. The debug sliders are what found it and they stay.

Yaw is inherited unfiltered: the raft's heading wanders over tens of seconds,
which reads as being aboard something adrift rather than as motion sickness. The
player's look is applied *inside* the stabilised head frame, so a roll tilts the
world under a fixed gaze rather than swinging the gaze.

## 10. Mode transitions

**A straight line**, 0.7–1.4 s, duration solved from the distance travelled.

Straight, and deliberately so. The first version arced over the masthead and
descended a vertical shaft forward of the mast, provably clear of the rig at
every azimuth and scale. It still read badly: a path with a vertical final
tangent finishes its horizontal travel while the camera is several metres up, and
spends the last third of the move dropping. The clearance turned out to be worth
nothing — the destination is inside the castaway's head, so the camera ends up
with a clear view whatever route it takes, and clipping a rope at 40 m/s is a
frame of cloth. **This is a deliberate departure from the brief**, which asks for
a path that avoids the sail and the mast; it was made on the author's explicit
instruction after seeing both.

**The ease leaves quickly and arrives slowly.** The integral of
`60·u²·(1−u)³`, normalised:

```
e(u)  = 20u³ − 45u⁴ + 36u⁵ − 10u⁶
e'(u) = 60·u²·(1 − u)³          peak at u = 0.4, zero and C2 at both ends
```

Two thirds of the way there by half time, against a half for smootherstep. A
symmetric ease spends its fastest moment in the middle of the move, which is
wrong for an approach: the apparent rate of something you are flying towards goes
as speed over distance, so holding that steady means shedding speed as the
distance closes. A first draft at `105·u²·(1−u)⁴` put it 77% of the way there by
half time, which measured as a rush followed by a hover.

**The bearing is carried across, in both directions.** Entering, the embodied
look adopts the cinematic camera's bearing; leaving, the cinematic azimuth is
derived from the embodied look. So a mode change is a move and never a spin. The
castaway faces the bow and the camera is usually somewhere else — at the authored
default they are 108° apart and from half the orbit nearly opposite — so
inheriting the figure's facing put a backflip in the middle of a one-second dive.

Pitch is *not* carried in: it levels to the authored embodied pitch. The
cinematic camera looks down at the raft by definition, 8.6° at the default and 80°
in a bird's-eye orbit, and arriving on deck already staring at your own lap is
not an arrival. Because the transition slerps the two end orientations, the
levelling happens *during* the dive.

**This overrides the brief's "preserve the last cinematic azimuth"**, on the
author's instruction. The azimuth is *recovered* exactly by an immediate
there-and-back, because the bearing it is derived from is the one the outward
trip installed; what it does not survive is the player turning their head while
aboard, which is precisely the case where restoring the old azimuth is the
surprise.

Reversing mid-flight is exactly continuous. An asymmetric ease cannot be turned
around by reflecting the clock, so the transition solves `e(u') = 1 − e(u)`
instead, which puts the clock where the other direction would have to be to be at
the position the camera is already at.

Both endpoints are re-evaluated every frame from the live controllers, so the
line tracks the raft as it heaves and the move lands exactly on the destination.

## 11. Clipping

`far` is 25000 m throughout — depth precision goes as `z²/(near·2²⁴)`, so `near`
is the only lever that matters.

| Mode | near |
|---|---|
| Cinematic | `clamp(0.02·min(distance, altitude), 0.25, 6)` |
| Embodied | 0.06 |
| Transition | the tighter of the two, the whole way |

At 1400 m and 267 m up the nearest geometry is hundreds of metres away, and a
0.5 m near plane there throws away most of the depth buffer for nothing. The
embodied 0.06 m is close enough to see a deck log a third of a metre away without
slicing it. The transition takes the minimum so a near plane growing mid-flight
cannot cut the raft off as the camera passes it.

`logarithmicDepthBuffer` is **not** enabled: none of the hand-written shaders
include the chunks it requires.

## 12. Ocean rendering across scale

The camera range is not complete unless the ocean is credible at every scale.
Five changes, all inside the sea-state round's contracts — the physical surface
the raft samples is untouched.

1. **The disc centres on the observer, not the subject.** Its rings grow
   exponentially outwards, so at 1400 m out and 267 m up a raft-centred disc puts
   20 m triangles with every Gerstner component past its LOD fade directly under
   the lens. The centre blends towards the camera's ground point on
   `smoothstep(200, 900, separation)` — exactly zero below 200 m, so the close,
   default and medium compositions and all of embodied mode are bit-for-bit what
   they were. `uRaftPos` now carries the raft's own position, or the contact
   darkening would follow the camera.

2. **Foam fades on its own window.** `nearFade`, `farFade` and `farStat` are
   Chebyshev distance in foam-UV space rather than radius from the disc centre.
   Beyond fixing the centre, this fixes a pre-existing bug: the foam field's valid
   window is centred on the surface drift, which walks away from the raft, so the
   near level's toroidal seam swept into view on a ~13-minute cycle.

3. **Wrap-exact noise.** `mod(vDetail, uDetailWrap)` is an identity only for
   multiples of `uDetailFreq`. Three hard-coded literals were not, which put a
   614 m grid of straight axis-aligned discontinuities through the foam breakup,
   relief and sample jitter. There is a test asserting the property.

4. **Pre-filtered foam erosion.** The fine erosion cut samples at a twentieth of
   the breakup's cell — 12 cm at the default sea state — and hard-thresholded it
   with no prefilter. A sub-pixel hard threshold is per-pixel sparkle that MSAA
   cannot touch, because MSAA is a geometry technique and this is a shading
   discontinuity inside one triangle.

5. **Band-limited residual waves.** The per-pixel residual term faded out at 0.75
   wavelengths of footprint — 1.33 samples per wavelength, the far side of
   Nyquist, where a sinusoid does not disappear but reappears as a low-frequency
   beat. Summed over a sea state's components that beat is the parallel ridging
   any view from altitude shows. Now half a wavelength, with the dropped energy
   folded into slope variance rather than discarded.

6. **The haze hold-back ramps out with altitude.** The 7% hold-back across the
   disc rim *is* the horizon line from 10 m up, and a false horizon 0.86° below
   the eye from 267 m.

**Handed to the graphics round**, because they are colour and atmosphere rather
than geometry: the far view washes out to near-white at local noon
(`uHazeDistance` is a hazy-day 2600 m); the raft is unhazed while the sea is
hazed, so at 1400 m a crisp dark speck sits on a 40%-hazed sea; and the deck is
very dark in the embodied view at sunset. Lengthening the haze is not the fix —
it exposes the residual ridging the haze is currently masking.

## 13. Audio

`Ambience` is non-positional Web Audio and there is **no** `THREE.AudioListener`
anywhere. That is valid and deliberate. The camera system adds none, in either
mode or during a change, and there is a test asserting the camera has no
children at all. Ambience is uninterrupted by mode switching because nothing
about it is attached to the camera.

## 14. Responsive behaviour

| Target | Vertical FOV | Horizon | Raft |
|---|---|---|---|
| 3840×2160 | 43.7° | 33% | 57.7% |
| 1440×900 | 48.1° | 33% | 55.3% |
| 390×844 portrait | 62.0° | 38% | 54.5% |
| 844×390 landscape | 42.0° | 33% | 58.8% |

The portrait horizon is lifted by an offset on the authored fraction rather than
by a second curve, so there is one composition. The elevation offset is held as
an *offset* from the scale's authored elevation, so rotating a phone re-solves
the composition without discarding how the player had framed it.

Aspects near 1:1 are the one place the composition drifts: the 62° vertical
maximum makes the optical pitch that puts the horizon a third down *exceed* the
11° elevation, so the axis passes slightly below the raft and it sits at 49.2%
rather than 54.7%. Nothing breaks, and no supported viewport is that shape.

## 15. Invariants

Held, and asserted by tests:

- `PlanetaryWorld`, WGS84/ECEF, geodesics, clocks, astronomy, star orientation
  and the world-render adapter are untouched. Driving every camera control and
  both modes leaves `createSnapshot()` byte-identical.
- `RaftBuoyancy`, the sea-state model, `WaveField`'s CPU/GPU equations, inverse
  sampling, the orbital-velocity contract and the persistent-foam history are
  untouched.
- Exactly one `THREE.PerspectiveCamera`, owned by `CameraSystem`.
- No `THREE.AudioListener`, in either mode.
- No NaN or infinity at any scale, from any input, including a NaN scale.
- The zoom curve is strictly monotonic in distance and altitude at every point.
- Camera motion uses presentation delta time. Two runs covering the same
  presentation seconds in different step sizes agree to a centimetre.
- No camera state in the canonical world snapshot.
- `?debug=buoyancy`, `?debug=ocean` and `?debug=1` still work and still open the
  same shared panels as the visible launcher; `?debug=camera` was added.

## 16. Deferred

- Automatic idle and watch cameras. `setMode` is the hook.
- A first-person body. The castaway is culled whole within 1.15 m of their head
  (hysteresis to 1.45 m), which is the documented compromise.
- Pointer lock. Not required for basic use, and dragging works without it.
- Camera preference persistence. `framing` and `look` are plain numbers and
  round-trip through JSON; nothing writes them anywhere yet, and they must not
  go into the canonical snapshot.

---

## Files

| File | Responsibility |
|---|---|
| `src/camera/cameraTuning.ts` | Every number and curve. Pure: no three.js, no DOM, no state. |
| `src/camera/types.ts` | `CameraContext`, `RaftAnchor`, `CameraPose`. The narrow window. |
| `src/camera/CinematicCameraController.ts` | Orbit, scale, follow, heave leash, water clamp. |
| `src/camera/EmbodiedCameraController.ts` | Eye anchor, free look, head stabilisation. |
| `src/camera/CameraTransition.ts` | The mode change and the line it flies. |
| `src/camera/CameraSystem.ts` | Mode manager. Sole owner of the one camera. |
| `src/ui/CameraPanel.ts` | Debug panel, dynamically imported. |
| `tools/camera-evidence.js` | Dev-only in-browser capture and measurement harness. |
| `tests/camera.test.ts` | The brief's eight test categories. |
| `tests/camera-follow.test.ts` | The vertical follow, against wave trains. |
