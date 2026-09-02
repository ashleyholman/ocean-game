# Ship motion physics and seakeeping — audit handover

**Status: Phase 0 response evidence, prescribed encounter validation, the
production encounter-motion bridge, the shared hull-contact/relative-flow
contract, the passive calm-water resistance surface and force-integrated
surge/sway/yaw are permanent. Canonical ECEF velocity remains the sole motion
authority; propulsion, commanded rudder force and current do not yet exist.**
Written 2026-08-01 after reviewing the hull, mass, buoyancy and damping model and
running a temporary 24-case heading sweep against `CURRENT_MODERATE` and
`SOUTHERN_OCEAN_ROUGH`. The permanent Phase 0 implementation was added on
2026-08-03 without retuning any hull coefficient. The minimal prescribed-speed
encounter harness and single-wave verification followed on 2026-08-04, again
without changing a hull or wave coefficient. The same day, production motion
was connected to canonical ECEF velocity, compressed global voyage, local wave
encounter, ship heading and the developer controls.

Run `npm run ship:response` to regenerate the tracked
`evidence/ship-response/zero-speed-baseline.json`. It covers all ten non-debug
sea presets at 15° heading intervals: 20 seconds of warm-up followed by 70
seconds of measurement at a 60 Hz caller and the real 240 Hz physics step. The
JSON records both presentation heading and model yaw, the complete metric
contract, free-decay evidence and a compact matrix summary. It contains no
timestamp or generated run ID; the stable file's Git history is the run
history.

Run `npm run ship:encounter` to regenerate the two smaller moving-hull records:
`evidence/ship-response/encounter-frequency.json` proves the existing wave
sampler's relative timing in a one-component sea, and
`evidence/ship-response/prescribed-speed-baseline.json` records eight
`CURRENT_MODERATE` headings at a bow-forward 4 m/s. This is prescribed tow-tank
motion through still mean water, not propulsion or a second world-position
authority.

This is a self-contained brief for a dedicated implementation thread.
`docs/ship/SHIP_SPEC.md` remains authoritative on what the schooner is and on its binding
hydrostatic ranges. `docs/ship/SHIP_ROUND_HANDOVER.md` remains authoritative on build
sequence. This document addresses the narrower question:

> Is the present amount and speed of ship motion believable, why is the default
> view especially roll-heavy, and what must be measured or modelled before the
> motion can be called validated?

## Current session handover — 2026-08-04

Ash has visually accepted the production velocity/encounter result. The full
checkpoint is committed in five ordered changes:

1. `a4da690` — permanent zero-speed response matrix and physical gates;
2. `6225982` — prescribed-speed encounter-frequency proof and 4 m/s response
   slice;
3. `60dab5d` — production projection of canonical vessel motion into the local
   wave/render frame, including ship yaw, foam and airborne spray;
4. `31537c7` — separate ordinary-time water encounter from the independently
   compressed 30× global voyage and from the astronomy clock;
5. `784d237` — retain commanded ship heading at Stop, when course over ground
   is correctly undefined.

The developer panel now provides `−1 m/s`, `+1 m/s`, `Stop`, `Release tow` and
`Ship / tow true heading`. Speed or heading commands engage a captive tow; the
release returns the vessel to passive force-integrated motion. These remain
diagnostic constraints, not sail, engine or rudder forces. Canonical ECEF
velocity is the authority for course and speed, while vessel yaw and yaw rate
remain the schooner's own rigid-body state. With no current model yet, speed
over ground and speed through water are numerically equal, though integrated
sideslip now lets course and heading differ.

Three clocks/scales must remain separate:

- astronomical UTC advances the Sun, Moon and stars and may be frozen by the
  lighting debug control;
- local vessel/wave encounter and speed response use ordinary bounded physics
  seconds;
- global WGS84 travel applies the fixed 30× voyage compression to distance,
  without making waves, wind or vessel response run 30× faster.

The vessel-centred renderer does not make the sea travel with the ship. The
mesh stays near render origin for precision; the wave parameter origin advances
by the equal-and-opposite local encounter displacement. The canonical ECEF
position advances independently by the compressed global distance. The local
wave origin is derived scratch and must never become a second saved position.

Checkpoint verification: Ash passed the native-resolution visual test and
confirmed that the ship reads as moving through the waves. The stopped-heading
regression was also exercised live: changing 270° to 90° visibly rotated the
hull while speed and all three ECEF velocity components remained zero. The
repository finishes this session with 34 test files / 475 tests passing and a
successful production build.

### Hull-contact checkpoint — implemented 2026-08-05

The shared, temporary **hull–water contact and relative-flow result** now exists
for every adapter-defined buoyancy station. `BuoyantBody` allocates the complete
result graph once and overwrites it at each 240 Hz contact evaluation. External
consumers receive a deep read-only view; the results are not navigation or save
state and retain no history.

For the schooner's existing 39 longitudinal sections the result distinguishes
the wave sample point, immersed-volume centroid and genuine port/starboard
waterline intersections. It exposes actual immersed volume, design-immersion
ratio, water normal and particle velocity, full 3D hull-point velocity, water
relative to the hull, normal and response-compatible vertical entry speeds,
force values and fixed bow/midships/stern classification. Whole transverse
sections correctly remain `centre`; their two derived waterline contacts carry
the real port/starboard identities.

Buoyancy, damping, overtopping, response metrics and development diagnostics
now consume the shared evaluation. The established vertical damping and
overtopping kinematics remain deliberately separate from the new 3D projection,
so introducing the contract did not retune motion. Deterministic tests cover
allocation identity, yaw transforms, side/longitudinal classification,
co-moving zero flow, entry-speed signs and continuous wet/dry entry.

Checkpoint verification: 35 test files / 482 tests pass and the production
build succeeds. On 2026-08-05, both response baselines were regenerated against
the current intentional rig geometry, reconciling an older 0.145 m lookout-point
coordinate drift. The evidence diff is limited to that coordinate and derived
lookout comfort metrics: vessel motion, hull contact, limiter fields, deck and
cabin metrics, and encounter-frequency evidence are unchanged.

### Calm-water resistance checkpoint — implemented 2026-08-05

`SchoonerResistance` now consumes the shared station contacts and evaluates a
passive body-axis surge force, sway force and yaw moment without changing
production movement. The geometry is not a second hull description: the 39
canonical stations yield 114.79 m² of wetted surface, 22.50 m² of moulded-hull
side profile, 12.49 m² of backbone profile and 1.64 m² of centred-rudder profile.

The viscous term uses the ITTC-1957 correlation line. Form factor, residuary
hull-speed rise, cross-flow and forward-coupled lateral slopes are explicit,
separately reported provisional coefficients because this hull has no physical
tow-tank data. The model is allocation-free when given a reusable result and
adds prescribed yaw-point velocity to the contact result without pretending yaw
is already a body state.

Run `npm run ship:resistance` to regenerate
`evidence/ship-resistance/calm-water-baseline.json`. Its captive surface contains
eight straight-tow speeds from 0–6 m/s, seven ±15° drift cases and seven steady
yaw cases over normalized rates ±0.5. At 4 m/s the current surface produces
4.629 kN of drag and requires 18.52 kW of effective power; at 6 m/s the explicit
residuary rise takes drag to 54.38 kN. These figures are a transparent game-model
baseline, not a claim of measured full-scale performance.

Deterministic gates cover zero force at rest, continuous low-speed onset,
monotonic drag, ahead/astern reversal, component closure, presentation-yaw
invariance, exact drift/yaw reciprocity and non-positive mechanical power. The
checkpoint finishes with 36 test files / 492 tests passing and a successful
production build. Existing response evidence is unchanged because no resistance
force is integrated in production.

That final sentence describes this historical checkpoint only; the following
checkpoint is the deliberately separate integration change.

### Passive horizontal-dynamics checkpoint — implemented 2026-08-05

`SchoonerHorizontalDynamics` now applies the resistance result to the loaded
81.58 t rigid body at the established 240 Hz step. It integrates render-frame
surge/sway and vessel yaw rate, uses midpoint velocity/yaw for both wave-origin
encounter and global displacement, then commits final tangent velocity into
`PlanetaryWorld` on every substep. The temporary render-frame velocity is
overwritten from canonical ECEF state each caller interval; it is not another
saved or navigational velocity.

`PlanetaryWorld.advanceTangentMotionStep` applies the fixed 30× voyage scale to
geodesic displacement only. Water encounter, resistance and yaw remain on
ordinary physics seconds. Vessel updates are now two-phase so world and
lighting presentation read the completed canonical motion state.

Run `npm run ship:dynamics` to regenerate
`evidence/ship-dynamics/passive-horizontal-baseline.json`. In still water the
4 m/s release slows monotonically to 3.00 m/s over 30 seconds, the 1 m/s
sideslip (toward +x/port — named "starboard" before the 2026-08-05 W1 side
relabel) and 0.16 rad/s yaw-rate releases decay without a positive
rigid-body energy step, and captive tow holds 4 m/s while still reporting its
4.629 kN resistance. The 60 Hz and 120 Hz caller runs finish identically, and
1× versus 30× voyage runs retain identical local motion and water encounter
while global distance differs by the required factor.

Deterministic gates cover the dry yaw inertia derived from the existing mass
budget, coast-down, sideslip, yaw decay, non-increasing energy, caller-rate
invariance, voyage separation and captive-tow preservation. The checkpoint
finishes with 37 test files / 502 tests passing, a successful production build
and a native-resolution live smoke test of free motion, tow, Stop, heading and
release controls.

### Previous-baseline impact — measured 2026-08-05

Run `npm run ship:dynamics:response` to regenerate
`evidence/ship-dynamics/wave-response-comparison.json`. It starts the production
free-motion path from each of the historical eight 4 m/s
`CURRENT_MODERATE` captive conditions, uses the same 20-second warm-up and
70-second measurement windows, and compares the resulting vertical response to
`prescribed-speed-baseline.json`. The original captive file remains unchanged
and is the control; it has not been redefined as a dynamic run.

This is an unpowered release, not a like-for-like propulsion replacement. Over
90 seconds the vessel slows from 4 m/s to 2.059–2.105 m/s, passive sway peaks at
0.237 m/s, yaw departure peaks at 11.92° and yaw rate peaks at 3.90°/s. Those
speed and heading changes alter encounter frequency, so the vertical response
moves materially and by heading rather than by one global scale:

- largest heave-RMS increase: +71.00% at 189°;
- largest roll-RMS increase: +100.29% at 189°;
- largest peak-roll increase: +54.61% at 189°;
- largest pitch-RMS increase: +32.87% at 279°;
- largest peak-pitch increase: +44.95% at 54°;
- largest peak-vertical-acceleration increase: +97.47% at 54°.

These are largest absolute changes, not uniform degradations. For example, roll
RMS falls 19.57% at 279° and 11.96% at 324°, while peak vertical acceleration
falls 23.93% at 234° and 25.86% at 324°. No comparison case overtops, touches a
safety limiter or exceeds the 1e-6 m inverse-surface gate. The result confirms
that the old captive matrix is still useful as a controlled response surface,
but it is not representative of an unpowered vessel allowed to slow and turn.
The final comparison checkpoint passes 37 test files / 503 tests, the production
build and an exact regeneration of all eight cases.

### Recommended following implementation task

Add real sail drive and commanded rudder force behind the next separate
validation checkpoint. Apply aerodynamic forces at the rig's real centres of
effort, apply rudder force at the existing blade geometry, and keep controls in
a vessel-control state rather than canonical world state. Validate steady
points of sail, acceleration/terminal-speed balance, turn-circle reciprocity,
weather-helm sign and fixed-step energy accounting before replacing the tow
harness as the ordinary way to get underway.

The completed contract is the clean prerequisite for:

- bow splash and entry spray;
- stern and divergent wake emitters;
- slamming impulses and drag/lateral-resistance forces;
- overtopping/green-water events with a physical source;
- later capsize/downflooding work.

Do not put these temporary results into `CanonicalWorldState`, a giant game
state or saved navigation state. Canonical world state should remain position,
velocity, transported frame and astronomical fields; commands and later sail/
rudder settings belong to a vessel-control state; contact results belong to the
physics step that produced them.

---

## 1. Executive conclusion

The current result does **not** show that the schooner is simply a bad design.
Its displacement, centre of gravity, metacentric height and free-decay roll
period form a coherent small-vessel model. A roughly 81.6 t, 15.5 m hull with a
5.0 m beam and a measured 5.96 s roll period should move much faster than a
large modern ship, and a beam or quartering sea can make it deeply unpleasant.

The default presentation nevertheless overstates how representative that
motion is:

- the debug ship has a fixed yaw of zero and no steering;
- it has no forward speed, so wave period and encounter period are identical;
- the `CURRENT_MODERATE` 6.3 s primary is close to the ship's 5.96 s natural
  roll period;
- the default wave direction is oblique but strongly transverse to the hull;
- `SOUTHERN_OCEAN_ROUGH` is even closer to beam-on for its dominant wind sea
  and primary swell.

The heading sweep confirms the importance of that setup. In
`CURRENT_MODERATE`, peak roll changes from **7.4° to 21.5°** solely by rotating
the otherwise stationary ship. In `SOUTHERN_OCEAN_ROUGH`, it changes from
**16.8° to 37.8°**, with the lower-roll headings redirecting much of the motion
into pitch instead. The fixed default is therefore a high-excitation condition,
not an average description of life aboard.

The right next step is not to tune away the observed roll. The first repeatable
heading/speed slice now exists and is connected to authoritative world motion.
It should next gain a reusable hull-contact and relative-flow contract, then
expand over loading and later sail configurations as those systems become real.
Player comfort and camera treatment should be based on that response envelope
rather than on the single yaw-zero case.

---

## 2. What is already physically coherent

### 2.1 Hull and mass properties

The current model is not a decorative mesh attached to a bobbing spring.

- Hull length is 15.5 m, beam 5.0 m and moulded loaded draught 2.3 m; draught to
  the keel is 2.52 m forward and 2.87 m aft.
- The measured displaced volume is 79.59 m³, or approximately 81.58 t in
  seawater.
- The hydrostatic model integrates the same lofted sections used to build the
  hull, including keel, deadwood, stem, sternpost and rudder appendages.
- The current dynamic GM is approximately 0.611 m after the accepted keel,
  rudder and mass-placement corrections.
- The analytical mass model includes the rig's mass and moment even though the
  present M1 visual ship does not yet draw the full rig. The physics is
  consequently less under-massed aloft than the image suggests.
- Thirty-nine longitudinal contact stations give about 0.397 m spacing, fine
  enough to retain the raft model's short-wave sampling margin.

### 2.2 Distributed buoyancy

Each station samples the actual wave surface and vertical water velocity at its
world position. Its immersed section is clipped against the local sloping water
plane, producing volume and a shifted transverse/vertical centroid. Buoyancy
and vertical damping are applied at that centroid, so pitch and roll are real
moments from distributed forces rather than authored animations.

The integrator uses fixed 1/240 s substeps, and the sea is sampled at the same
substep times. Frame rate therefore does not set the vessel response.

### 2.3 Roll period and damping

The free-decay test heels the ship on flat water, releases it and measures zero
crossings. It produces **5.96 s**, while the stiffness/inertia closed form gives
5.94 s. The 0.3% agreement is strong evidence that the period is a consequence
of the stated mass and restoring stiffness rather than an integrator artefact.
A classical empirical estimate gives about 5.41 s; the model is roughly 10%
slower, within the scatter expected from that simple formula.

Roll damping has explicit linear and quadratic moments. The measured effective
damping ratio rises from about 0.045 at 5° release to 0.065 at 25°, which is the
correct qualitative behaviour for eddy shedding off a rounded bilge. Before
that term existed, the ship accumulated energy until it sat on the ±40° safety
limiter. The present model dissipates energy and no tested case in this audit
actually touched the limiter.

These are meaningful strengths. Any replacement must preserve them or provide
better evidence.

---

## 3. Why the default condition rolls so much

### 3.1 Natural period and forcing period are close

`CURRENT_MODERATE` carries a primary peak at 6.3 s. The ship's free roll is
5.96 s. With the ship stationary, encounter period equals the configured wave
period, placing substantial spectral energy close to the roll response peak.
The sea is broad-band, so this is not one perfect sinusoid driving one perfect
oscillator, but it is close enough to matter.

This does not prove the damping is wrong. Resonant amplification is a physical
reason small ships avoid particular headings and speeds. The current viewer
removes those operational choices and holds the vessel in the forcing.

### 3.2 The fixed orientation is roll-heavy

Sea-state directions are headings the waves travel toward. The ship's local
`+z` axis is the bow; at model yaw zero that corresponds to presentation
heading 180°. The `CURRENT_MODERATE` primary travels toward 54°, a 126° relative
angle: oblique, but only 36° away from a directly transverse sea. The Southern
primary travels toward 70° and its wind sea toward 82°, respectively about 20°
and 8° from transverse at the default ship orientation.

Consequently, the Southern default is nearly the orientation most effective at
creating roll. Rotating the hull toward a more longitudinal encounter trades
roll for pitch; it does not make the same ocean small or comfortable.

### 3.3 The running viewer has no speed-dependent encounter shift

The ship viewer's `yaw` is “not yet driven by anything,” and the buoyancy body
only simulates heave, pitch and roll. Surge, sway and yaw are kinematic. The ship
sits at the render origin with no forward velocity through the wave field.

For a moving vessel, encounter frequency depends on wave frequency, heading and
ship speed. Head seas generally increase encounter frequency; following seas
decrease it; quartering cases can move energy toward or away from roll and pitch
response peaks. The running viewer cannot explore any of that, so its resonance
statements remain statements about a stationary hull. The headless response
harness can now tow the hull bow-first through wave coordinates, which is enough
to validate encounter timing and measure an initial response slice without
pretending that propulsion or steering exists.

---

## 4. Permanent zero-speed response matrix

### 4.1 Deliverable and method

`npm run ship:response` creates a fresh `WaveField` and `HullBuoyancy` for each
case, snaps the hull to the surface, and runs 90 simulated seconds with a 60 Hz
caller and the real 240 Hz physics substep. It discards the first 20 seconds and
records the remaining 70. The deterministic preset seed and all physical
parameters remain fixed.

The tracked JSON contains 240 cases: ten non-debug sea presets at the 24
presentation headings from 0° through 345° in 15° steps. It records the
corresponding model yaw because model yaw 0° is presentation heading 180°.
Heave is displacement about each case's measured mean, not absolute world
height. Point acceleration and jerk are rigid-body kinematics; they exclude
gravity, impacts and rig flex and are not yet complete comfort or injury
ratings.

The overtopping fields report the existing longitudinal crown-entry detector.
They establish where and how often its threshold fires, but do not yet simulate
water volume or free-surface effects on deck. `overtoppingEventSamples` counts
station/substep samples, not unique breaking waves.

### 4.2 Current committed result

| Preset and presentation heading | Peak roll | RMS roll | Peak roll rate | Peak pitch | Peak heave | Lookout peak* |
|---|---:|---:|---:|---:|---:|---:|
| `CURRENT_MODERATE` 180° / model yaw 0° | 19.63° | 8.06° | 23.50°/s | 6.00° | 0.88 m | 0.75 g |
| Current lowest-roll, 60° | **7.12°** | **2.90°** | 9.46°/s | 7.67° | 0.79 m | 0.45 g |
| Current highest-roll, 165° | **21.08°** | **8.90°** | 24.26°/s | 5.96° | 0.88 m | 0.85 g |
| `SOUTHERN_OCEAN_ROUGH` 180° / model yaw 0° | 36.89° | 17.19° | 41.05°/s | 11.71° | 6.12 m | 1.54 g |
| Southern lowest-roll, 75° | **20.75°** | **8.67°** | 21.25°/s | 26.73° | 6.05 m | 1.29 g |
| Southern maximum-pitch, 240° | 22.44° | 9.23° | 22.86°/s | **27.89°** | 6.06 m | 1.58 g |
| Southern largest valid roll, 150° | **39.47°** | 17.25° | 43.71°/s | 12.89° | 6.13 m | 1.32 g |

\* Kinematic acceleration magnitude divided by standard gravity; gravity
itself is not included.

Across the full matrix, opposite-heading RMS values differ by at most 2.42% for
roll and 3.71% for pitch. Individual finite-window peaks are noisier: at most
10.25% for roll and 6.79% for pitch. The long-run reciprocal tolerances are
therefore 5% for RMS and 12% for peaks. The selected `CURRENT_MODERATE` CI pair
uses tighter 3% RMS and 5% roll-peak limits.

### 4.3 Interpretation

- Heading alone changes peak standard-sea roll by almost **3×** and RMS roll by
  slightly more than **3×**. The current yaw-zero presentation is near the
  high-roll side of that envelope.
- Lower-roll Southern headings are not safer in every sense: peak pitch rises
  to **27.9°**, while peak heave remains roughly 6.1 m.
- Sixteen Southern headings trigger the provisional overtopping detector; no
  other preset does. The worst case reports crown entry on 4.07% of measured
  frames and a maximum sampled depth of 1.35 m. No case becomes fully airborne.
- Southern headings 330° and 345° touch the 40.107° emergency attitude clamp.
  Those two roll peaks and any acceleration spike caused by the clamp are
  invalid as physical predictions. They are failed validity cases that require
  real downflooding/capsize treatment, not successful survivability results.
- No case touches the angular-rate or vertical-speed guard. The maximum wave
  inverse-solve residual is 1e-8 m, retaining CPU surface-registration accuracy.
- Excluding the two clamped cases, the largest lookout acceleration is 1.61 g
  of rigid-body kinematic acceleration in Southern heading 210°. This confirms
  that aloft exposure needs its own operational limit, but it is not yet a
  complete human-load calculation.

For a player aboard, `CURRENT_MODERATE` yaw zero would indeed be unpleasant:
8.1° RMS roll and 23.5°/s peaks are not subtle. Whether that belongs in the
default experience is a product and operational-heading decision, not evidence
by itself that the hull is unstable.

### 4.4 Prescribed-speed encounter result

`npm run ship:encounter` now makes two tracked records. A pure 8 s, one-component
wave is sampled along four 4 m/s paths. Its measured encounter periods are
6.059 s head-on, 6.523 s on the head quarter, 8.000 s beam-on and 11.769 s when
following. They match `|omega - k d·V|` to the recorded precision, proving that
the existing `WaveField` clock and local-coordinate convention produce the
right relative timing.

The companion hull run tows the canonical ship at 4 m/s through
`CURRENT_MODERATE` on eight headings spaced around the primary swell's 54°
travel heading. Across the 70-second measurement windows, peak roll ranges from
**2.62° at heading 234°** to **21.27° at heading 324°**; maximum pitch is
**8.15° at heading 234°**. All eight cases stay finite, avoid every emergency
limiter and retain a maximum inverse-surface residual of 1e-8 m.

Those numbers are a deterministic response slice, not a claim that the vessel
can propel itself at 4 m/s in every condition. The horizontal path is prescribed
and bow-aligned; current, leeway, sail force, rudder force and dynamic
surge/sway/yaw remain absent.

---

## 5. What the present model does not yet prove

### 5.1 Horizontal dynamics is passive, not yet sailing

Heave, pitch and roll remain the distributed flotation body's waterplane
degrees of freedom. Surge, sway and yaw now integrate the passive resistance
surface, so the vessel can coast, shed sideslip and damp yaw while retaining a
heading distinct from course. There is still no aerodynamic sail force,
commanded rudder response, weather helm, current or player steering force.

That is a complete passive rigid-body checkpoint. It is not yet a sailing
model.

### 5.2 Incident-wave physics is quasi-hydrostatic

The model integrates instantaneous immersed geometry beneath a sampled free
surface and damps against local vertical water velocity. It does not integrate
the full pressure field around the moving hull, wave diffraction,
frequency-dependent radiation forces or radiation-memory kernels. Added mass
is one constant 0.45 multiplier used for heave, pitch and roll inertia.

This can produce credible low-frequency flotation and a coherent roll period,
but it should not be described as a validated response-amplitude operator for
all wavelengths and headings.

### 5.3 Damping is plausible but partly calibrated to this simulation

The 0.075 linear and 0.60 quadratic roll terms have good qualitative behaviour,
but the quadratic value was chosen against the sea-state sweep because a model
test or Ikeda-style calibration is unavailable. Heave/pitch damping is one ratio
distributed by waterplane area. Neither is frequency-dependent.

The result is defensible as a game model, not independently validated naval
architecture. The response matrix should be treated as a tuning surface with
physical guardrails, not as measured truth.

### 5.4 Major real-world forces and state changes are absent

- aerodynamic sail forces, steady heel and aerodynamic roll damping;
- mast, sail and rig flexibility;
- rudder and keel lateral resistance;
- course-keeping by a helmsman;
- slamming and dynamic bottom pressure;
- green-water mass and momentum on deck;
- flooding, free-surface effect and progressive loss of stability;
- cargo or ballast shift;
- loading changes as stores and water are consumed;
- capsize, downflooding and recovery beyond the ±40° safety bound.

Some omissions will increase motion and some will decrease it. They cannot be
collapsed into a single “more damping” adjustment.

### 5.5 The visible vessel understates the moving mass

The analytical model already includes substantial mast, topmast and standing-
rigging mass aloft. M1 currently shows the hull without the full M2 rig. A bare
hull rolling at the period of a rigged 80 t schooner lacks the visual levers,
flex, sail pressure and scale cues that would make its inertia understandable.
This presentation mismatch contributes to the impression that a lightweight
model is being flung around, even though the mass model itself is not light.

---

## 6. Recommended implementation sequence

### Phase 0 — Make heading response a first-class diagnostic (implemented)

This now exists as the headless `src/vessel/schooner/SchoonerResponse.ts` harness,
`tools/export-ship-response.mjs` exporter and `tests/ship-response.test.ts`
physical gates. A GUI was intentionally omitted: the export records both
heading conventions unambiguously, and the command-line run is the durable
interface.

- Accept an explicit heading for each case and record both model yaw and true
  presentation heading.
- Run every playable sea over a configurable 15° heading grid.
- Export deterministic JSON with peak and RMS heave, pitch and roll;
  angular rates and accelerations; vertical acceleration and jerk at deck,
  cabin and lookout; overtopping; wet station fraction; and limiter proximity.
- Record the warm-up and measurement windows separately in the run contract.
- Assert symmetry between opposite headings while speed remains zero.
- Use selected short cases in CI and retain the full 90-second-per-case run for
  committed evidence.

The committed baseline is evidence, not a giant golden assertion. CI checks the
heading contract, pitch decay, finite/contact/limiter invariants and stationary
opposite-heading symmetry using selected shorter cases. An intentional physics
change should regenerate the full JSON, review its ordinary Git diff and commit
the changed evidence with the code that caused it.

### Phase 1 — Establish response and comfort envelopes

Run the current model before changing it across:

- every playable sea state;
- heading;
- representative speeds once encounter motion exists;
- at least light, canonical and heavy loading;
- sails furled, reduced and working once aerodynamic forces exist.

Define separate labels for physical safety, deck work, interior comfort and
aloft exposure. A condition can be physically survivable and still make deck
work impossible. The lookout values in `docs/ship/SHIP_SPEC.md` already show why position
aboard matters.

### Phase 2 — Add authoritative heading, course and encounter speed (implemented)

The world model, ship pose and wave sampler need one coherent notion of vessel
motion. Implement steering/course before using speed to retune any natural
period.

The 2026-08-04 implementation covers both the bounded diagnostic and production
bridge. The response harness accepts heading plus bow-forward speed, advances
its temporary sampling position at every 240 Hz physics step, verifies all four
encounter aspects, and stores an eight-heading moving response run. Production
projects canonical ECEF velocity into the transported local frame, drives
`Ship.yaw`, advances the shared CPU/GPU wave origin, and transports foam and
airborne spray consistently. No second geographic position exists.

The remaining work around this phase is deliberately deferred until its inputs
are real:

- Add current and leeway, then distinguish heading, course over ground and
  speed through water numerically rather than only by contract.
- Expand the initial one-speed matrix when representative operating speeds and
  loading states have a defensible source.
- Add force-integrated sail propulsion and rudder steering in the later sailing
  phase; keep the prescribed debug controls as a captive harness.

Operational behaviour can then avoid sustained resonant headings naturally
rather than hiding the response in damping.

### Phase 3 — Establish hull contact/relative flow, then hydrodynamic coefficients

The shared, temporary hull-contact result and the bounded passive resistance
surface described in the current session handover are complete. Physics and
effects now have one contact and relative-flow contract rather than independently
guessing where the water meets the hull. Longitudinal drag and distributed
hull/backbone/rudder lateral resistance are independently inspectable before
integration. Replace the single added-mass multiplier and shared heave/pitch
damping only where evidence shows they matter.

- Derive or estimate distinct heave, pitch and roll added inertia.
- Validate pitch free decay as rigorously as roll free decay.
- Measure response convergence against station count and physics step.
- Consider frequency-dependent radiation or a compact memory approximation if
  the heading/speed matrix exposes systematic phase or amplitude errors.
- Calibrate roll damping from a defensible empirical method or reference hull
  data where possible; preserve its nonlinear amplitude dependence.

Avoid sophistication that does not change the measured playable envelope.

### Phase 4 — Add sailing and severe-weather forces

- Apply sail forces at the real centres of effort, with steady heel and gust
  impulses.
- Add commanded rudder force and yaw dynamics on top of the passive centred-rudder
  resistance surface.
- Add slamming and green-water impulses where relative entry velocity and local
  geometry justify them.
- Treat shipped water as mass only if it persists; otherwise keep spray and
  overtopping as presentation events.
- Define the downflooding/capsize boundary before allowing playable cases to
  live near the current 40° safety clamp.

The Southern visual-violence work should share the same breaking and
overtopping events, but it must remain a separate implementation thread from
this physics work.

### Phase 5 — Tune experience after the physics envelope exists

Then decide:

- the ordinary operational heading maintained by the crew;
- when the helmsman changes course to avoid dangerous roll;
- which sea states permit deck work or going aloft;
- how interior and deck cameras stabilise without erasing the vessel motion;
- whether `CURRENT_MODERATE` is truly the intended default sea or merely the
  historical visual-regression baseline.

Do not lower `GM`, increase damping or alter wave period solely to make one
camera shot comfortable. Every such change moves draught, stability, decay,
resonance or severe-weather survival and must be revalidated as a system.

---

## 7. Acceptance criteria

Phase 0 now passes the completeness, finite-value, inverse-surface and
opposite-heading gates below. It also exposes two deliberate failures of the
no-clamp gate: `SOUTHERN_OCEAN_ROUGH` at presentation headings 330° and 345°.
They stay in the evidence so later capsize work has a concrete boundary to
replace.

### Diagnostic and physical gates

- Free-decay roll period remains within the canonical band and agrees with the
  closed form independently of frame rate.
- Pitch decay receives an equivalent measured and asserted period/damping test.
- The heading/speed/loading sweep is reproducible and stored as machine-readable
  evidence.
- Stationary opposite headings remain symmetric within a documented tolerance.
- Encounter-frequency tests pass for single head, following, beam and
  quartering waves once translation exists.
- No playable case silently relies on the ±0.7 rad angle clamp or ±6 rad/s rate
  clamps. Approaching a clamp is reported as a failed validity margin, not a
  dramatic success.
- Energy decays in flat-water releases and remains bounded in every finite
  regular-wave resonance test.
- CPU ship sampling remains registered to the rendered surface at all headings,
  speeds and world locations.

### Experience gates

- `CURRENT_MODERATE` is evaluated at the crew's actual operating heading, not
  only yaw zero, and its deck/cabin/aloft comfort classifications are explicit.
- `SOUTHERN_OCEAN_ROUGH` remains violent. Safer headings may trade roll for
  pitch or reduce capsize risk; they must not turn a 6.4 m sea into gentle
  motion.
- The full visual rig is present before final subjective judgement of inertia,
  scale and roll speed.
- Camera stabilisation reports the underlying body motion separately so comfort
  work cannot conceal a physics regression.

---

## 8. Non-solutions and guardrails

- Do not infer bad hull design from the fixed yaw-zero response alone.
- Do not call 5.96 s “slow” because the roll looks fast; it is quick for a ship
  but plausible for this small vessel.
- Do not tune only peak angle. RMS angle, angular rate, acceleration, duration
  near extremes and location aboard all matter.
- Do not add damping merely until Southern roll looks pleasant.
- Do not use the camera as evidence that the rigid body is correct.
- Do not claim encounter resonance before speed and heading are modelled.
- Do not let the fixed safety clamp masquerade as capsize physics.
- Do not derive mass from whichever rigging meshes happen to be visible; retain
  the canonical mass budget and reconcile geometry to it.

---

## 9. Starting file map

| Concern | Current authority / implementation |
|---|---|
| Canonical vessel and motion figures | `docs/ship/SHIP_SPEC.md` |
| Build sequencing and current milestone findings | `docs/ship/SHIP_ROUND_HANDOVER.md` |
| Hull form and station spacing | `src/vessel/schooner/hullForm.ts` |
| Static hydrostatics | `src/vessel/schooner/hydrostatics.ts` |
| Canonical loading and inertia | `src/vessel/schooner/massModel.ts` |
| Schooner-specific body parameters and roll/pitch decay | `src/vessel/schooner/SchoonerBuoyancy.ts` |
| Prescribed motion contract and single-wave proof | `src/vessel/schooner/EncounterMotion.ts` |
| Passive calm-water surge/sway/yaw force surface | `src/vessel/schooner/SchoonerResistance.ts` |
| Captive resistance evidence builder | `src/vessel/schooner/SchoonerResistanceEvidence.ts` |
| Fixed-step passive horizontal integration | `src/vessel/schooner/SchoonerHorizontalDynamics.ts` |
| Flat-water horizontal evidence builder | `src/vessel/schooner/SchoonerHorizontalDynamicsEvidence.ts` |
| Eight-heading free-response comparison builder | `src/vessel/schooner/SchoonerHorizontalResponseEvidence.ts` |
| Production velocity, stopped heading and local encounter projection | `src/vessel/VesselMotion.ts` |
| Permanent response matrix and metric contract | `src/vessel/schooner/SchoonerResponse.ts` |
| Baseline exporter | `tools/export-ship-response.mjs` |
| Encounter exporter | `tools/export-ship-encounter.mjs` |
| Tracked zero-speed evidence | `evidence/ship-response/zero-speed-baseline.json` |
| Tracked encounter timing | `evidence/ship-response/encounter-frequency.json` |
| Tracked 4 m/s response slice | `evidence/ship-response/prescribed-speed-baseline.json` |
| Tracked calm-water tow/drift/yaw surface | `evidence/ship-resistance/calm-water-baseline.json` |
| Tracked flat-water horizontal dynamics | `evidence/ship-dynamics/passive-horizontal-baseline.json` |
| Tracked free-vs-captive wave comparison | `evidence/ship-dynamics/wave-response-comparison.json` |
| Generic distributed flotation integrator | `src/vessel/BuoyantBody.ts` |
| Active-vessel runtime contract | `src/vessel/Vessel.ts` |
| Visible schooner pose and hull-relative update | `src/vessel/schooner/Schooner.ts` |
| Current debug host | `src/debug/SchoonerViewer.ts` |
| Existing metric recorder to generalise | `src/debug/labMetrics.ts` |
| Hydrostatic and current single-condition motion tests | `tests/ship-hydrostatics.test.ts` |
| Response, pitch-decay and heading-symmetry gates | `tests/ship-response.test.ts` |
| Sea directions and periods | `src/ocean/presets.ts` |

The prescribed encounter foundation, hull-contact contract, passive resistance
and surge/sway/yaw integration are complete and validated. The retained captive
matrix and the new free-release comparison now show separately what heading and
speed constraints were buying. The next physics checkpoint is real sail drive
and commanded rudder force; wake rendering and crew simulation remain separate
consumers and do not require a second navigation state.
