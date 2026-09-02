# Sailing rounds — handover log

Round-by-round record for the sailing project. `docs/sailing/SAILING_MODEL_DESIGN.md` is the
authority on the model; `docs/sailing/SAILING_PROJECT_PLAN.md` on sequence and gates. Newest
round last.

---

## S1 — World wind · implemented 2026-08-05

**Status: complete. 39 test files / 542 tests pass, production build clean,
live smoke test verified against independent panel telemetry.**

### What exists now

| Thing | Where |
|---|---|
| Wind authority: mean + deterministic gusts | `src/world/WorldWind.ts` |
| Frame/angle helpers (render, body, apparent, TWA, points of sail) | same file, pure functions |
| Gust evidence builder + shared gates | `src/world/WorldWindEvidence.ts` |
| Committed evidence, all ten non-debug presets | `evidence/world-wind/gust-baseline.json` |
| Regeneration | `npm run wind:baseline` (`tools/export-world-wind.mjs`) |
| Tests: conventions, gust process, evidence reproduction | `tests/world-wind.test.ts` |
| Production wiring + per-frame gust clock | `src/main.ts` (`worldWind`, step in `stepSimulation`) |
| Dev readout: wind / gust / apparent lines | world panel stats (`src/ui/DebugPanel.ts`), fed by `buildWindTelemetry()` in `main.ts` |
| Dev server for this round | launch config `drift-sailing`, port **5201** |

`WindSystem` is now a consumer: the sea preset's mean wind flows
sea state → `WorldWind` → `WindSystem`/foam/spray, same floats as before.

### The two S1 policy decisions

1. **Presentation stays on the mean wind.** Foam, spray, spectrum, sky and the
   raft read exactly the values they read before — zero behavioural change, by
   construction, not by tolerance. The gusty *instantaneous* wind exists for
   the sailing physics (S2+) and the readout. Pointing any presentation system
   at the instantaneous wind is a look change that needs Ash's A/B.
2. **The gust process is a pure function of elapsed wind time** — a seeded sum
   of incommensurate sinusoids with an OU-like character (10–60 s speed gusts,
   slower direction wander), not integrated noise. The design doc sketched an
   OU filter; the pure-time form was chosen deliberately because it is *exactly*
   caller-rate invariant and *exactly* reproducible, which integrated noise is
   not. Peak excursions: ±40% of mean speed × gustiness, ±8° × gustiness.
   Measured zero-crossing interval 12.8 s. Zero gustiness reproduces the mean
   bit-exactly (gate).

### Conventions, now pinned by test

- `directionDeg` = compass heading the wind blows **toward** (sea-state
  convention). Source bearing = `directionDeg + 180`.
- compass → render: `(directionDeg + frameHeading)·π/180`, vector `(sin, −cos)`
  — asserted equal to `WindSystem.setOceanWind` outputs.
- render → body: the same rotation rows the horizontal-dynamics evidence uses.
- Wind angle off the bow: 0 = dead ahead, ±180 = astern, **positive = wind over
  the model +x side**. The compass-quantity route (`trueWindAngleDeg`) is
  sign-matched to the body route across a full yaw × direction grid.
- Model yaw 0 = presentation heading 180 has its own pinned test.

### FINDING W1 — body axis labels and the compass were mirror-images (RESOLVED 2026-08-05)

Established from code, then fixed the same day. The facts:

- render frame: east = +x, north = −z — verified physically right-handed and
  correct, and shared by the astronomy (`azimuth = atan2(east, north)`,
  `WorldRenderAdapter` maps sun ECEF → render through the same rows), the
  geodesy and every sea direction;
- hull sources labelled model **+x starboard**, +z bow — but a +z bow at model
  yaw zero points *south* (`heading = 180° − yaw`), and a south-facing
  vessel's +x/east side is nautically her **port** side. The labels were a
  consistent mirror image of the world.

**Resolution: the words flipped; nothing else did.** The world mapping is
real (ephemeris, WGS84) and correct; mirroring the geometry instead would
have put the frozen rig's booms to windward of the actual scene wind. So the
2026-08-05 relabel swapped every side word bound to a model axis across the
vessel sources, debug labs, tests, evidence schemas and ship docs:
**model +x = port, −x = starboard, positive yaw = a turn to port.** The
authority statement lives in `hullForm.ts`'s COORDINATES block. Quoted
historical comments keep their original words with pre-W1 notes; the rig
handover's tack bullet carries a dated amendment.

Consequences worth knowing:

- the drawn ship was always coherent: she is a correctly trimmed
  **starboard-tack** vessel — wind over her starboard side, booms and bellies
  to port, leeward;
- renamed identifiers include the `portWaterline`/`starboardWaterline`
  contact fields (now matching their x-signs), `portSpeedMps` and friends in
  the dynamics/resistance evidence, sided rig node names, and the lab camera
  `PORT_WATERLINE`/`STARBOARD_WATERLINE` pair;
- side words are now safe in UI and code alike; positive wind angles in
  `WorldWind` mean wind over the port side, the port tack.

**Proof of pure relabel:** 542/542 tests green; all three sided evidence files
regenerated with byte-identical numeric value multisets (verified by hash),
every diff line a renamed label. **On-screen verification:** captive tow to
heading 180 with wind toward 68 (source 248): readout shows
`67° off bow (starboard) · close-hauled` while the sun — real ephemeris,
azimuth 251.6°, 4° off the wind source — backlights her from starboard with
the booms hanging in her port-side shade. Ephemeris → azimuth → render →
body → side word → drawn geometry all agree.

### Notes for S2

- Consume `worldWind.instantaneousSpeedMps` / `instantaneousDirectionTowardDeg`
  (never the mean) for sail forces; per-sail apparent wind via
  `apparentWindRender` with the CoE point velocity; body-frame angle via
  `windRenderToBody` + `windAngleOffBowDeg`.
- The wind clock advances in `stepSimulation` on presentation dt — bounded
  physics seconds, same clock the waves use. If S2 needs sub-frame gust values
  inside the 240 Hz substep loop, evaluate the series at
  `elapsedSeconds + substep offset` (it is a pure function of time; do not add
  a second `advance` path).
- `pointOfSailName` sector thresholds are naming, not physics; the real no-go
  arc comes out of the S2 polar.
- Known stale raft-era paths (unchanged this round, S7's list): the hint line
  advertises "Space for the sail" and Space toggles the *raft's* binary sail;
  `Vessel.updateTrimPickTargets` is raft-only.

### Verification record

- `npm test`: 39 files / 542 tests green (16 new).
- `npm run build`: clean.
- `npm run wind:baseline`: all ten presets validated; e.g. CURRENT_MODERATE
  6.00 m/s gusting 5.55–6.55, SOUTHERN_OCEAN_ROUGH 18.0 m/s gusting 14.2–22.6.
- Live smoke test on port 5201: with the ship in free drift at 0.089 m/s on
  course 67.8° and wind toward 68°, the readout independently showed
  `apparent 5.86 m/s · 179° off bow · run` with instantaneous 5.95 — i.e.
  apparent ≈ instantaneous − drift speed, dead astern, cross-checked against
  canonical-state speed/course numbers produced by code this round never
  touched.
- One dev-tools quirk observed, not a bug: with the browser pane hidden,
  `requestAnimationFrame` stops, so panel stats stop updating — the panel
  looks empty until the pane fronts.

---

## S2a — Sail forces at fixed trim (first half of S2) · implemented 2026-08-06

**Status: complete. 42 test files / 577 tests pass, production build clean,
live smoke test verified: she sails in production. S2b (polar + added mass +
tuning) remains open; the plan's sanctioned split was taken.**

### What exists now

| Thing | Where |
|---|---|
| Per-sail geometry + aero, pure maths | `src/vessel/schooner/sailAero.ts` |
| BuoyantBody external wrench seam (generic, zero-default) | `src/vessel/BuoyantBody.ts` (`externalWrench`, `externalWrenchWorkJ`) |
| Dynamics external-force seam + wind-work tracking | `src/vessel/schooner/SchoonerHorizontalDynamics.ts` (`externalForces`, `externalWorkJ`) |
| The stateful stepper (wind → aero → both seams) | `src/vessel/schooner/SchoonerSailForces.ts` |
| Sub-frame gust evaluators (pure time, no second clock) | `WorldWind.instantaneousSpeedMpsAt` etc. |
| Straight-line evidence, committed | `evidence/ship-sailing/straight-line-baseline.json` |
| Regeneration + gate validation | `npm run ship:sailing` (`tools/export-ship-sailing.mjs`) |
| Tests: geometry, curves, pinned signs, seams, evidence contract | `tests/ship-sailing-aero.test.ts` (23) |
| Production wiring + per-sail dev readout | `src/main.ts` (`sailForces`, `buildSailTelemetry`), world panel |

Production default: **all eight sails set at authored trim** (the physics
carries the canvas the eye sees), starboard tack, driven by the
*instantaneous* wind — sail physics is the gusty branch's first real
consumer; presentation stays on the mean.

### Architecture, in five sentences

`sailAero.ts` derives every sail's area, centre of effort and **leeward
normal** from the same `rig.ts` corner nodes the renderer lofts, with the
leeward normal computed by the exact `sailSurface` patch-normal construction
times `side` — the physics pushes the way the drawn belly falls, by
construction. Per 240 Hz substep the stepper evaluates apparent wind at each
CoE (full rigid-body point velocity, so a rolling rig is damped
aerodynamically), flat-plate AoA against the leeward normal, family CL/CD
curves with soft stall and smooth luffing collapse, crude downwind
blanketing, and a lumped spar windage that never furls. The wrench is split
once: horizontal force + yaw moment beside resistance in the free path;
vertical force + pitch/roll torque onto the BuoyantBody seam (applied under
captive tow too — a towed ship under sail heels). Gusts are sampled at
`base + substepCount·h`, a monotone grid anchored at reset — that is why
caller-rate invariance with sails drawing is **exactly zero error**, not
merely within tolerance. Reefs are re-derived shrunk geometry, not scaled
guesses; the port tack is the exact x-mirror of the authored rig, spar
windage included.

### The frozen-trim honesty (read before judging the sweep)

Trim is the authored `SHEET_*`/`BRACE_ANGLE` baked into the rig nodes —
close-hauled-ish settings. The captive sweep (8 m/s wind, 2 m/s tow) reads
accordingly, and the physics keeps deriving period seamanship nobody coded:

- best drive **5381 N at −75°** (close/beam reach, wind over the starboard
  side — the drawn tack); dead ahead **−1662 N**, all 8 sails luffing;
- the flying jib (flattest sheet) luffs first when pointing high — the spec's
  "first headsail struck";
- the square topsail goes **aback** near the beam but is the second-strongest
  sail on a run — "good off the wind, first in when beating";
- wrong-tack angles (wind over port with starboard-tack trim) are useless
  until deep angles where barn-door drag takes over. This is correct for
  frozen trim, not a bug; S4's live trim opens the polar out.
- gaff sails are stalled (AoA ~60°) on a beam reach with hauled sheets —
  also real. Do not "fix" any of this by rotating a normal.

### Gates that hold (all in `ship:sailing` + the test suite)

- **Zero-default**: `npm run ship:dynamics` regenerated **byte-identical**
  with the seams in place; a becalmed bare-poled provider is bit-identical
  to no provider.
- **Energy (design §6.5)**: over a 90 s gustiness-1 free run from rest,
  horizontal KE never exceeds accumulated wind work by more than 0 J —
  exactly 0, the explicit-Euler work integral is exact for the scheme.
  Final speed 2.60 m/s ≪ the 5.875 hull-speed bound.
- **Caller rate**: 48 vs 240 Hz with sails drawing — velocity, yaw and work
  errors exactly 0. Voyage compression 1× vs 30×: local dynamics identical,
  global ratio exactly 30.
- **Tack mirror**: pure aero mirrors exactly; the end-to-end captive mirror
  differs by 1.2e-5 relative because **the loaded CoM sits slightly off
  centreline** (her booms hang to port) — real asymmetry, gated < 1e-3.
- **Signs pinned by measurement**: drive forward, side to leeward, heel to
  leeward (negative roll = port down, asserted against the body transform),
  weather helm toward the wind. Heel-into-AoA is geometric: laid on her beam
  ends the drive collapses.

### Findings (rule 8 — surfaced in full)

1. **Heel is light at 8 m/s**: steady captive heel peaks at −6.5°. The S2
   gate band (15–25° at 12 m/s full sail) is 2b's tuning target; at 12 m/s
   this model gives roughly 15° before tuning. Expected for provisional
   coefficients; do the tuning against the polar, not before it (plan's
   own warning about hiding bias without the rudder DOF).
2. **Test-timeout policy changed** (beyond the morning's surgical fix): under
   real machine load (load average 25 with a concurrent AI session) dozens of
   legitimate multi-second physics tests flaked at vitest's 5 s default, and
   even 15–30 s authored budgets blew. `vite.config.ts` now sets
   `testTimeout: 60_000` suite-wide; the heaviest evidence tests carry
   explicit 120 s (one 300 s) budgets. A hung test fails slower; a loaded
   machine no longer fails green physics.
3. **Dev-server double-boot reconfirmed**: one browser-pane session booted
   `main.ts` twice (two canvases, two 'code loaded' logs) — the known
   Vite/pane trap. Hard-reload before trusting anything live.
4. **Weather wander**: with no rudder (S3), the free ship wanders in heading
   under the sail yaw moment — rounds up from a reach, bears away near a
   run. Correct and expected; do not add a heading clamp to hide it.
5. Known stale raft-era paths untouched (S7's list): the header's
   `sail up/down` flag is still the raft's binary sail; hint line unchanged.

### Notes for S2b

- The polar builder should reuse `SailingForceEvidence.ts`'s `runSailCase`
  (captive bisection on tow speed per angle, or free-run settling once the
  added mass is in). Per-sail breakdowns are already in every sweep entry.
- Added mass (§6.4) changes the passive baselines — regenerate
  `ship:dynamics` evidence in the same commit, per the standing rule.
- Blanketing is one crude cone (0.5 loss, 10–25° ramp) and windage one lump
  (17.1 m², Cd 1.0); both are labeled provisional in
  `SAIL_AERO_COEFFICIENTS` and are the first candidates if the polar looks
  wrong downwind.
- `SailingForceEvidence` gates live twice deliberately: in the export tool
  and in the test suite. Keep them in step if you touch either.

### Verification record

- `npm test`: 42 files / 577 tests green (23 new).
- `npm run build`: clean.
- `npm run ship:sailing`: written and validated (best drive 5381 N at −75°,
  dead ahead −1662 N, gust run 2.60 m/s, energy excess 0 J).
- `npm run ship:dynamics`: byte-identical regeneration (zero-default proof).
- Live smoke test on port 5201: from rest in the default sea
  (CURRENT_MODERATE, wind 6 m/s toward 068°), she accelerated through
  0.35 m/s, heeled to leeward, and the panel showed the full per-sail
  readout — square topsail drawing 934 N on the run, apparent wind swung
  aft, drive 2153 N — all through code paths this round wired.

---

## S2b — Added mass and the polar (second half of S2) · implemented 2026-08-06

**Status: complete and ACCEPTED by Ash 2026-08-06 (live beam-reach test, by
eye). Every stated S2 gate passed on the provisional coefficients — no tuning
was performed, per the plan's "tune to the stated gates only".**

Ash's acceptance run, in his own observations: released from tow at heading
158° in the default sea, she gathered way in a long smooth asymptotic build
to ~3.35 m/s (the polar's number for that wind), his new wind flags agreed
with the physics, the weather helm walked her from 158° to 188° while speed
bled off, and head-to-wind every sail read LUFF and she died — "she's
a-sailin alright". Heel remains illegible by eye under wave roll at 6 m/s;
that check falls to the rounds that make heel visible. Ash asked for a
dedicated sailing debug tab — the plan's reserved `sailing` DevTools entry,
due with S3's tiller.

### What exists now

| Thing | Where |
|---|---|
| Horizontal added mass: surge 6% · sway 40% · yaw 30% | `SCHOONER_HORIZONTAL_ADDED_MASS`, `SchoonerHorizontalDynamics.ts` |
| Polar builder (force-balance solves) | `src/vessel/schooner/SailingPolarEvidence.ts` |
| Committed polar | `evidence/ship-sailing/polar-baseline.json` |
| Regeneration + gates | `npm run ship:polar` (`tools/export-ship-polar.mjs`) |
| Polar contract test | `tests/ship-sailing-polar.test.ts` |
| `WORKING_SAIL` canvas preset (kites struck) | `sailAero.ts` |

Added mass is diagonal in the body frame — the net force rotates to body
axes, divides per-axis by its virtual mass, rotates back. Passive baselines
changed as the design §6.4 warned; `ship:dynamics`, `ship:dynamics:response`
and `ship:sailing` regenerated in the same commit (coast-down 4→3.04 m/s
instead of 4→3.00; the gust run's energy excess went slightly *negative*
because part of the wind's work now genuinely accelerates entrained water).

### What kind of polar this is, honestly

Each point is a **captive force-balance solve**: bisect the tow speed along
a fixed heading until net surge force vanishes, then settle heel at the
solution. No rudder (S3) and no live trim (S4) exist, so leeway is not
solved (the side-force residual is reported instead) and the
rudder-to-hold-course column of design §9 does not exist yet. S3 and S4
regenerate this same file as those DOF arrive. The evidence's contract block
states all of this.

### The numbers (13-angle grid × 4/8/12 m/s FULL_SAIL + 12 m/s WORKING_SAIL)

- **No-go dead**: 0 m/s everywhere inside 30° of the wind, drive at rest
  negative (she is pushed astern). The sailing sector opens at ~45°.
- **Beam reach fastest on every sheet**: 2.65 / 4.20 / 4.85 m/s at
  4 / 8 / 12 m/s, the run always slower — the classic polar shape.
- **Hull-speed bound**: max 4.85 m/s vs 4.7 hull speed, 3% over — inside
  the stated 1.25 surfing allowance, and about right for a pressed schooner.
- **Tack mirror**: max speed error 5e-5 m/s across the whole grid.
- **Heel band**: 16.5° max at 12 m/s full sail — inside the 15–25° gate
  with the provisional aero coefficients untouched.
- **Shortening sail works**: WORKING_SAIL at 12 m/s sheds a third of the
  heel (16.5°→12.1°) for 0.16 m/s of speed — the reason crews shorten sail,
  emergent again.

### Verification record

- `npm test`: full suite green including the new polar contract test (the
  suite's heaviest at ~170 s of solves; 600 s budget).
- `npm run ship:polar`: written and validated, all gates.
- `npm run ship:dynamics` / `ship:dynamics:response` / `ship:sailing`:
  regenerated with the added mass, same commit.
- One passive-test tolerance moved with cause: the sideslip no-undershoot
  bound went from −1e-8 to −1e-6 (the sway added mass shifts the decay's
  numerical tail to ~−8e-8 — noise scale, not ringing; the comment in the
  test records the measurement).

### Open toward S3

- Rudder lift on the blade geometry, δ=0 bit-identical to today's passive
  terms; retire captive-heading as the steering path.
- Regenerate the polar with helm-held free equilibrium (adds leeway and the
  weather-helm column); the added-mass constants are S3's to retune against
  turn circles, per design §6.4.
- The S2 accept-when (Ash steers the scene by eye: beam reach in
  CURRENT_MODERATE, accelerate, heel, settle) is the round's remaining human
  gate.

---

## S3 — Rudder and helm · implemented 2026-08-06

**Status: built and gated; 47 test files / 663 tests pass, production build
clean, panel verified live. The round carries one major finding (below): at
the frozen S2 trim the classic tack does not complete — she wears instead —
and the fix is S4's live trim by construction. Ash's accept-when (steer her
through a tack from the dev panel) therefore CANNOT pass this round as
written; Ash decides whether wearing ship + the pinned finding closes S3 or
holds it open. Dev server: launch config `drift-sailing-s3`, port 5213.**

### What exists now

| Thing | Where |
|---|---|
| Commanded rudder force (lift increment on the blade) | `src/vessel/schooner/SchoonerResistance.ts` (`SCHOONER_RUDDER_COEFFICIENTS`, post-loop block) |
| The helm: ±35°, rate-limited 20°/s on the substep grid | `src/vessel/schooner/SailingControls.ts` |
| Dynamics seam (`helm`, zero-default bit-identical) | `SchoonerHorizontalDynamics.ts` (`RudderAngleProvider`) |
| Harness: thrust, maneuver scripts, trajectories, helm | `SailingForceEvidence.ts` (`runSailCase` options) |
| Turn/tack/helm evidence builders | `src/vessel/schooner/SailingSteeringEvidence.ts` |
| Committed evidence | `evidence/ship-sailing/{turn,tack,helm}-baseline.json` |
| Regeneration | `npm run ship:turn` / `ship:tack` / `ship:helm` |
| Equilibrium polar (speed + leeway + rudder per point) | `SailingPolarEvidence.ts` v2, `npm run ship:polar` |
| Tests | `tests/ship-sailing-rudder.test.ts` (13), `ship-sailing-steering.test.ts` (4), `ship-sailing-polar.test.ts` (committed + spot) |
| Sailing dev panel (tiller, rudder physics, release-to-helm) | `src/debug/SailingPanel.ts`, `sailing` DevTools entry in `main.ts` |

### The rudder model, in four sentences

The passive model already carried the undeflected blade, so the commanded
model adds only the **increment** deflection produces: a flat-plate lift
curve (`CL = slope·sinα·cosα`, soft stall 25–40°, induced + pressure drag)
evaluated at the deflected angle **minus the same expression undeflected** —
at δ=0 the increment is skipped entirely, so amidships helm is bit-identical
to the passive model by construction (`ship:dynamics` regenerated
byte-identical as proof before the retunes). The blade is one lift surface:
area-weighted inflow at the immersed centroid from the same station
contacts, with the yaw-rate point velocity added once there (the documented
gotcha, pinned by a test that reads pure rotation as 90° inflow at r·arm).
The `sinα·cosα` fold reverses lift when the flow reverses, so she steers
backwards making sternway for free, and q ∝ inflow² means a stopped ship
does not answer her helm — both pinned by measurement. Positive deflection =
trailing edge to port = bow to port under headway, the same rotational sense
as yaw.

### The two S3 retunes (the joint retuning the plan predicted)

1. **`liftSlopePerRad` 3.2 → 4.5**: the initial value was an unprincipled
   conservatism; 4.5 is the lifting-line value 2π·AR/(AR+2) at the blade's
   effective aspect ratio 5.1 (geometric 3.4 × ~1.5 hull end-plate). Not an
   independent knob.
2. **`backboneForwardLateralSlope` 2.20 → 1.30**: per-strip, 2.20
   double-counted the continuous keel's 3D lift (whole-surface AR ≈ 0.5 ⇒
   whole-keel slope nearer 1.3). The overcount was yaw damping, priced by
   the tack evidence: ~100 kJ to rotate through the eye against ~116 kJ of
   way. All passive baselines regenerated in the same commit
   (`ship:resistance`, `ship:dynamics`, `ship:dynamics:response`,
   `ship:sailing`, `ship:polar`); the sideslip no-undershoot bound moved
   −1e-6 → −2e-3 with the measured cause in the test comment (one
   zero-crossing at −7.2e-4 of a 1 m/s release — marginally under critical
   damping, not ringing).

### FINDING S3 — the frozen trim cannot tack (rule 8, surfaced in full)

At the frozen S2 trim the classic tack completes from **no** entry — close
reach with a good full (2.8 m/s), beam reach near best speed (4.2 m/s), all
of them. The chain, each link measured:

- the sheets are cut for a close reach (S2a's own "best drive at −75°"),
  so sails fill only past ≈38–42° off the wind;
- every with-way entry carries through the eye (crossing speed 1.1–1.4 m/s,
  entry-invariant — the swing sheds everything above it);
- on the new bow she keeps swinging to ≈+35° where the **in-irons
  attractor** captures her: the moment the sails begin to fill (+38°) their
  weather moment (≈+7 kNm) rounds her back up, with ≈−80 N of drive behind
  it and no way left for the rudder to answer;
- capture angle band across all entries: **34.0–34.9°** — a sharp
  attractor, not scatter; the stern-board recovery (helm shifted under
  sternway — implemented in the script) escapes at ~0.05°/s, hopeless.

The remedies are trim actions — harden the sheets (fill ≈30° would put the
attractor *outside* the dead band and dissolve the trap), back a headsail —
which are exactly S4's live trim. **She wears soundly instead**: the gybe
completes in ~51 s, transit through dead astern ~13 s, max yaw rate 0.043
rad/s, energy gate held — period-correct for a schooner that won't stay.
`ship:tack`'s gates assert all of this in the direction that is TRUE today
(`classicTackCompletesAtAnyEntry: false` is a deliberate gate); S4 flips it
to a success gate as part of its acceptance.

### The numbers

- **Turn circles** (synthetic thrust, no wind, both directions): radius
  160 / 84 / 58 m at 10/20/30° helm — monotone, near speed-independent
  (2.5 vs 4 m/s within 0.4%), mirror error 1.7e-3 (the real CoM
  asymmetry), drift angle 4→10° and speed loss 16→55% growing with helm,
  stopped ship turns exactly zero.
- **Weather helm** (captive zero-leeway balance, wind 8): AFT_CANVAS
  3.5–10.4° weather everywhere; FULL_SAIL 8.7° close-hauled easing to 0.9°
  downwind (max 3.8° in the 60–120° gate band); WORKING_SAIL slightly less;
  HEADSAILS_ONLY flips to **lee helm** (−1.5 to −3.2°) — ordering follows
  canvas CoE exactly, construction verified by measurement.
- **Equilibrium polar** (v2, format bump): best speeds shaved 1–2% by the
  now-priced leeway and helm drag (8 m/s beam: 4.20 → 4.18 m/s); leeway
  3.8° pinching at 45° easing to ~1.2° downwind; helm column +5.7°
  (weather) at 45° through zero to −0.3° (lee) past 120° — the S2 wander
  finding, quantified. Mirror 4.8e-5, heel at 12 FULL_SAIL 16.1° (in band).

### Verification record

- `npm test`: 47 files / 663 tests green (18 new).
- `npm run build`: clean.
- Zero-default proof: `ship:dynamics` byte-identical (hash-compared) with
  the helm seam in place, before the retunes.
- Caller-rate invariance with a scripted helm: 48 vs 240 Hz **exactly**
  equal (command schedule on whole-second boundaries, rate limiter on the
  substep grid).
- All five steering/polar export tools validate their gates at write time;
  the same gates run in the suite (turn and tack rebuild live; helm and
  polar assert the committed JSON plus one live spot-solve each — a full v2
  polar rebuild is ~20 min and no longer fits a test budget).
- Live panel on port 5213: tiller commands walk the blade through the rate
  limiter, rudder inflow/AoA/stall/moment read back from the physics, mode
  line and release-to-helm work, world panel unaffected. (Browser-pane rAF
  throttling — the S1 quirk — makes sustained live sailing impossible in
  the pane; the by-eye drive is Ash's.)

### Notes for S4

- The tack gate flip is S4's acceptance-standard change: live trim hardens
  the sheets, the fill threshold drops inside the attractor, and
  `classicTackCompletesAtAnyEntry` becomes a success gate. Keep the capture
  band and eye-crossing bands as regression context.
- The maneuver scripts' course hold (`courseHoldRudderDeg`) and the
  stern-board helm shift are evidence glue; S5's `Helmsman` is the
  production version and should replace, not wrap, them.
- `WORKING_SAIL`'s reefed variants and the polar's per-sail breakdowns are
  already in the v2 format; S4 regenerates the same file at live-trim best
  settings (gate: equal or better than this polar).
- Known stale raft-era paths unchanged (S7's list): the hint line still
  advertises the raft's binary sail; `Vessel.updateTrimPickTargets` is
  raft-only.

---

## S4 — Rig state, trim, and the moving rig · implemented 2026-08-07

**Status: built and gated; the tack gate FLIPPED — the classic tack
completes from every with-way entry, as the S3 finding said live trim
would make it. All committed evidence regenerated (tack/turn/helm v2,
polar v3, straight-line byte-identical). Ash's accept-when (sail a beat, a
reach and a gybe from the dev panel, sails visibly swinging and reefing,
both tacks drawing, sign off the placeholder furl visuals) is the open
human gate — the browser pane's rAF throttling (the S1 quirk) still makes
sustained live sailing impossible in the pane, so the by-eye run is his.
Dev server: launch config `drift-sailing-s3`, port 5213.**

### What exists now

| Thing | Where |
|---|---|
| Full control surface: per-sail set states + trims, one rate table | `SailingControls.ts` (`ACTUATION_RATES`, `SET_STATE_HOIST_FRACTION`) |
| Live corner constructors + moved-node overlay + apply/restore | `rig.ts` (`liveSailCorners`, `trimmedRigNodePositions`, `applyRigTrim`) |
| Geometrically derived trim limits | `rig.ts` `RIG_TRIM_LIMITS` (swept vs standing rigging at module load) |
| Aero consumes live trim, per substep, frozen table now a fixture | `sailAero.ts` (`SailAeroSailState`, `frozenSailStates`, `liveSailVariantGeometry`, `gatherSailCorners`, `liveSailSide`) |
| Stepper reads the controls (or the frozen fixture path) | `SchoonerSailForces.ts` (`attachControls`, `fixedTrimsDeg`) |
| Live re-loft: whole rig, PRNG-stable, furl bundles | `rigGeometry.ts` (`buildRigGeometry(state?)`, `RigLoftState`), `Schooner.updateRigLoft` |
| Production wiring: physics + thresholded/rate-limited loft refresh | `main.ts` (`attachControls`, `refreshRigLoft`) |
| Dev panel: per-sail sheets, set states, fisherman dip, live readout | `src/debug/SailingPanel.ts` |
| Trim-envelope sweep + belly both tacks + re-loft contracts | `tests/ship-rig-trim-envelope.test.ts`, `ship-rig.test.ts` ('live re-loft') |
| Controls contract (rates, ladders, substep determinism) | `tests/ship-sailing-controls.test.ts` (15) |
| Mirrored sheet leads + pin-rail twins both sides | `rig.ts` (lead flip in the overlay; `mirrorOf` rails) |

### Architecture, in six sentences

Set states are fixed points on a continuous hoist fraction (furled 0 ·
reef2 0.55 · reef1 0.75 · set 1, one truth with the aero's
`reefHoistFraction`), so an evolution is a rate-limited walk and
mid-transition cloth is honestly partial for physics and eye alike. Live
trim re-runs the *same constructors* the baked graph was authored with
(`swingAbout`, `headsailClew`, `yardArms`, `alongMainGaffAt`) at commanded
angles — at the authored angles every derived position is bit-identical to
the frozen table, pinned by `toBe` tests and proved end-to-end by a
byte-identical `ship:sailing` regeneration. The aero derives area/CoE/
leeward-normal per substep from those corners (allocation-light, the
shared quad reductions), with the belly side flipping with the trim sign
for fore-and-aft sails and riding the yard for the square topsail — set by
the belly test on both tacks, never by reasoning. The loft applies the
trims by mutating the ~20 moved nodes in place (spars, ropes, blocks and
sail corners all share the node objects, so everything follows) inside an
apply/finally-restore, and rebuilds the WHOLE rig: measured 2.1 ms median,
which is why S4 chose rebuild-everything over dirty-flagging (design §8
left that to the measurement); production refreshes at 0.1°/0.5% hoist
thresholds, ≥120 ms apart. The PRNG restarts per build and a furled sail's
bundle path consumes exactly the draws its cloth would have, so colours
never shift when canvas changes. Sheet leads live in port/starboard pairs
with stable node names — the overlay flips the *position* to the sheeted
side, so pin-per-rope keeps its bijection and the spare rail is just
drawn timber (a visible starboard-bulwark addition for Ash's review).

### THE TACK GATE FLIPPED (the S3 finding's promised fix, measured)

The maneuver evidence now sails the live control surface: approach on the
authored trims, **harden everything at the order** ("ready about" — 12–14°
maneuvering trims), haul across at the eye with the **staysail held aback**
until she pays off 12°, ease to the 20° working trim when through. The
hardened fill thresholds sit inside the old ±34° attractor, and:

- classic tack completes from **every** with-way entry: 101 s (6 m/s close
  reach), 89 s (8 m/s close reach), 132 s (8 m/s beam entry) — slow is
  honest, she turns at her hull's own rate and never stalls (min speed
  0.72–0.88 m/s through the old capture band);
- the from-rest order still fails before the eye (real: no way, no rudder);
- the gybe is unchanged and sound (transit 13.2 s, max yaw 0.043 rad/s);
- **hardening at the order beats hardening late** — measured, not
  reasoned: delaying the haul to −45° loses the beam entry outright (the
  sheets are still walking when she reaches the fill band — the S3 failure
  in miniature);
- S3's capture band **34.0–34.9°** is preserved HERE as regression
  context; `captureAngleBandDeg` in the evidence is now null and a
  reappearing capture fails the write.

### CORRECTION — what actually flipped the tack gate

The first write-up of this round credited the fix to "hardened sheets +
the staysail held aback." **Measured, the backed staysail is worth 0.2 s /
1.3 s / 1.8 s of a 101 s / 89 s / 132 s maneuver** — under 1.5%, and all
three entries complete without it. The hardened sheets do essentially all
the work. The hold is kept in the script because it is what a crew does
and because it will matter the day an aback sail carries lift, but it
must not be described as part of the mechanism. The reason it does
nothing is FINDING S4-2 below.

### FINDING S4-1 — the model has no pointing limit of its own (rule 8)

The provisional aero carries no induced drag (CD never scales with CL²),
so with live trim and an 8° sheet floor she made **2.7 m/s at 30° off the
true wind** — modern-sloop pointing from a gaff schooner, and the S3
no-go gate blew on the first polar run. The aerodynamically honest fix is
the CL²/πARe term (the low-AR gaff sails would pay heavily, which is WHY
gaffers don't point), but it re-prices every committed sailing speed and
belongs to a coefficient round with Ash's polar A/B. Until then the limit
is enforced the way the period did it: the trim-to-draw schedule never
sheets inside a **20° working floor** (a gaff main stays over the
quarter). Measured ladder at 8 m/s, 30° true: floor 8° → 2.68 m/s ·
15° → 0.98 · 18° → 0.42 · **20° → 0.15** (gate holds; the sailing sector
opens ≈35–40° and the 45° point still gains 1.54 → 2.73 m/s over frozen
trim). The tack's flatter 12–14° trims are *maneuvering* trims inside the
evolution only — measured necessary (at 20° she dies in the fill band on
every entry) and eased back to 20° at completion.

### FINDING S4-2 — she escapes irons by stern-boarding, NOT by backing a sail

Ash asked the direct question — once she IS in irons, can she get out? —
so it was measured rather than reasoned. Five cases, head to wind at rest
with flat sheets (`ironsEscapes` in `tack-baseline.json`), deliberately
separating the two candidate mechanisms so neither could take credit for
the other:

| what the crew does | result |
|---|---|
| nothing (drift) | free after **227 s**, falls off to port |
| back a headsail | **STUCK** — pinned at −18.8° for the whole 240 s |
| helm alone (stern-board) | free in **79.8 s**, falls off to starboard, exits at 1.19 m/s |
| backed headsail **and** helm | free in **80.3 s** — half a second *slower* |
| helm the other way | **STUCK** — pinned at −20.5° |

**The helm does all of it.** She gathers ~0.6–1.1 m/s of sternway (the
wind pushes her astern at ≈1050 N with everything luffing), the blade
steers reversed once the flow reverses — the S3 sternway behaviour,
pinned by test — and that is enough. The backed headsail contributes
nothing, and adding it to the helm *costs* half a second.

**Why the real technique fails here:** `sailLiftCoefficient` returns 0 for
any negative angle of attack — "an aback sail in v1 is treated as
collapsed, like luffing" (`sailAero.ts`, a stated simplification since
S2a). Backing a headsail is *defined* as loading its front face, so the
one manoeuvre whose entire purpose is to work without boat speed is the
one the model cannot represent. This is the same missing branch, not a
new bug — but it now has a measured consequence and a gate that will
notice the day someone adds the aback lift term.

**And the escape has a direction.** Falling off *toward* the side the
sheets are on meets a second attractor at ≈20° — the sails fill, their
weather moment pins her, yaw rate goes to literally zero and stays there.
It is the S3 in-irons mechanism alive at a new angle, and it means the
practical rule is: from irons, fall off *away* from your sheets. Worth
knowing before S5's crew starts issuing recovery orders.

Note this also means the drift case is not "she frees herself" so much as
"the luffing sails' one-sided drag eventually rotates her" — rigid cloth
cannot flog, so eased sheets act like small set sails. That is why the
stuck state is measured with the sheets flat, where the artefact is
smallest; eased to 60° the same artefact sails her out unaided in ~75 s.

### The polar, v3 (live-trim best settings)

Every point solved with each sail trimmed to draw for its own apparent
wind — the lift-peak rule clamped at the rig's mechanical stops, i.e.
S5's `Trimmers` policy in fixture form, reported per point in the file.
Gated equal-or-better against the committed frozen v2 grid point-by-point
(worst delta printed by the tool), plus all standing gates. Headline
gains at 8 m/s FULL_SAIL: 45° · 1.54 → 2.73 m/s; 60° · 3.34 → 3.97;
90° · 4.18 → 4.25; 150° · 3.29 → 3.54.

### Findings (rule 8 — the rest, surfaced in full)

1. **Trim limits are derived and honest**: mainsail ±46.0°, foresail
   ±51.5° (the GAFF meets the shrouds before the boom does — and her
   backstays are standing, not runners, so deep easing stops early),
   brace ±22.0° (backstays again), headsails ±60° as a stated provisional
   cap (no hard spar stop exists; the envelope sweep polices the box).
   The sweep exempts each swinging spar's attachment fifth (jaws ride the
   mast; the throat sits in the shroud convergence).
2. **The flogging exemption**: the envelope sweep's first run failed
   exactly two poses — a headsail at 0° trim passing through its steady
   neighbour. Cloth near amidships is mid-crossing slatting canvas the
   rigid surface cannot represent (its camber is already ramped flat over
   ±5°, `CAMBER_RAMP_DEG`), so the cleanliness claim covers *steady*
   trims (|trim| ≥ 5°); every steady pose in the swept box is clean, both
   tacks, including all adjacent-headsail opposite extremes.
3. **The port-tack peak halyard CLEARS** — the coupling the rig graph
   itself flagged (gear rigged to starboard vs a port-tack topsail belly)
   was measured, not assumed, and holds above one rope radius. Pinned in
   the envelope suite.
4. **Deck obstacles do not follow the booms**: `DECK_OBSTACLES` reads the
   rig once at module load (its own comment: nothing moves until the
   booms get a working sheet — which is now). A walker can stand in a
   swung boom's path and is blocked by the authored position's phantom.
   Same class: `windCues`' ensign-staff clearance was chosen against the
   *authored* main sheet and is unmeasured against a live one
   (`SHIP_WIND_CUES_HANDOVER` §ensign asked for exactly that re-measure).
   Both are deliberately untouched this round; they belong to the rounds
   that own walking and cues.
5. **The fisherman's dip is a trim walk**: its "side" commands walk the
   fixed ±40° sheet through zero at the dip rate — mid-dip the sail
   luffs, which is what a dipped fisherman does. Its struck state (and
   the gaff topsail's) draws NO bundle: they are sent below, honestly
   gone.
6. **Evidence-format bumps**: steering evidence v2 (live-surface
   maneuvers, success tack gate, nullable capture band; turn/helm files
   regenerated identical-but-for-version), polar v3 (trim schedule per
   point + the equal-or-better gate). The evidence-gitignore allowlist
   needed no change (same file names).

### Verification record

- `npx tsc --noEmit`: clean. `npm run build`: clean.
- Irons: five cases written and gated at export time; the contract test
  asserts the same facts, including the two gated in the direction of a
  *limitation* (`ironsBackedHeadsailAloneEscapes: false`, and the
  toward-sheets attractor being non-null).
- Merged with master's tag-split test suites (`docs/project/TESTING.md`): the tack and
  irons contract tests carry `['slow', 'sailing']`; the new controls and
  trim-envelope suites are deliberately left untagged because they run in
  well under a second each — the split's driver is runtime, not category,
  and the envelope sweep is this round's central defence, so it belongs
  in the loop everyone actually runs.
- Controls: 15 new tests — §5.2 rates, ladder evolutions, proration,
  slaving, fisherman dip, clamps, and bit-exact frame-chop determinism on
  the fixed substep grid.
- Live-vs-frozen: every starboard variant pinned `toBe` (bit-exact) at
  authored trim/hoist; port variants pinned to 12 digits (the mirrored
  corner lists round differently for the yard sails — same cloth,
  different arithmetic path).
- `npm run ship:sailing`: **byte-identical** (hash-compared) through the
  live aero path — the zero-default proof of the whole refactor.
- `npm run ship:tack` / `ship:turn` / `ship:helm`: regenerated and
  validated; turn and helm changed only in `formatVersion`.
- `npm run ship:polar`: regenerated at the trim-to-draw schedule with the
  equal-or-better gate against v2 enforced at write time.
- Rig suite: live re-loft block (authored pose bit-identical through the
  live path; exact graph restore; lead flip; 2.1 ms measured budget with
  a 30 ms CI bound; furl without colour shift) + the trim-envelope sweep
  (steady box clean both tacks) + pin-rail twins.
- Live smoke test on port 5213: sailing panel commands the full surface;
  trims walk at crew rate on the substep grid; the aero's per-sail AoA
  readout tracks the *walking* trim; the gaff topsail follows the main's
  sheet; set-state evolutions walk their hoists; drawn booms swing to the
  commanded side; zero console errors. Sustained sailing in the pane is
  still impossible (rAF throttling, the S1 quirk) — Ash's by-eye run is
  the acceptance.

### Notes for S5 (and the A/B checkpoint)

- **Ash's A/B review bundle for this round**: the placeholder furl
  bundles (a lashed canvas roll along boom/stay/yard; kites vanish
  below), the NEW starboard pin rails (drawn timber both sides now), the
  camber flattening through ±5° of trim (a crossing sail goes flat rather
  than popping its belly), and the moving rig itself. None of these are
  self-certified.
- `Trimmers` is already specified by `trimToDrawDeg` + the 20° working
  floor (polar file, per point); `Helmsman` replaces
  `courseHoldRudderDeg`; the tack sequence (harden at the order, haul at
  the eye, staysail aback to +12°, ease at complete) is the evolution
  S6's crewed sequences should encode verbatim — it is measured to work
  and measured to be sensitive to timing.
- The induced-drag coefficient round (FINDING S4-1) should come before
  any polar-based tuning; it will re-price the polar, the no-go, and
  possibly the heel band together. **Fold the aback-lift branch (FINDING
  S4-2) into that same round** — both live in `sailAero.ts`'s coefficient
  block, both change what the sails do at extreme angles, and doing them
  together costs one regeneration of every sailing baseline instead of
  two. When the aback branch lands, the irons gates in
  `export-ship-tack.mjs` will fail loudly and on purpose.
- S5's recovery orders must know the escape rule: stern-board with the
  helm, and fall off AWAY from the sheeted side (toward it there is still
  an attractor at ≈20°). "Back the jib" is not yet a move that works.
- Known stale raft-era paths unchanged (S7's list): the hint line still
  advertises the raft's binary sail; `Vessel.updateTrimPickTargets` is
  raft-only.

---

## S4 review — the lowering gaff, and a rig that moves at frame rate · 2026-08-08

Two faults, both found by Ash on the first review of S4, both in the
*relationship* between things the tests only ever measured separately.

### FAULT 1 — a sail came down and its gaff did not

Furl the mainsail, unfurl it, and the cloth was nowhere near its boom.

The hoist was modelled as a property of the **cloth**: `gatherSailCorners`
compressed every corner's height toward the sail's lowest corner. So the
gaff stayed fully peaked over a sail that had fallen away from it, the head
edge floated in mid-air with nothing holding it, and — because the main boom
rises 0.95 m aft — "compress toward the lowest corner" dragged the clew
*below* the boom it is laced to: 0.62 m under at hoist 0.35, 0.86 m at 0.10.

A hoist is not a property of the cloth. It moves the spar. `gaffPoseAt` in
`rig.ts` now lowers the gaff itself: the jaws slide down the mast's own raked
line from the throat to the gooseneck, and the peak's angle above horizontal
eases from the sail plan's peak angle to the boom's own rise. At hoist 0 the
gaff lies along its boom with the jaws at the gooseneck — which is exactly
where the furled bundle is drawn, so the bottom of the hoist and the furled
state are one continuous picture instead of a pop. The cloth then needs no
gathering at all: its head corners *are* the gaff's two ends and its foot
corners are the boom's, at every hoist. `gatherSailCorners` still gathers the
headsails, the square topsail and the gaff topsail, none of which own a spar
that lowers.

The reef fixed points ride the same curve, and that is not a compromise:
reefing a gaff sail **is** lowering the gaff by the depth of the reef band and
tying the new foot to the boom.

**This changed the aero.** Reef geometry is derived from the corners, and the
corners moved. Reef areas rose because the new model keeps the full foot chord
on the boom and loses cloth from the head, where the old one squashed the whole
quad vertically:

| | old | new |
|---|---|---|
| mainsail reef1 | 43.223 m² | 44.845 m² |
| mainsail reef2 | 31.726 m² | 33.682 m² |
| foresail reef1 | 21.181 m² | 21.882 m² |

`set` is bit-identical (57.605 m², same CoE) — the full-hoist path takes the
authored arithmetic untouched, deliberately, because every S2/S3 fixture is
pinned to those numbers. `evidence/ship-sailing/straight-line-baseline.json`
regenerated; the three reef areas are the only lines that moved, because
nothing else in the evidence set carries a reef (WORKING_SAIL and BARE_POLES
are set/furled only).

**Why no test caught it**: every sail test measured the sail against *itself* —
its area, its corners, its belly, its clearance from other sails. None measured
it against the timber it is bent to. `ship-rig.test.ts` now asserts, at eight
hoists per gaff sail, that the head corners lie on the gaff segment and the
foot corners on the boom segment, to 1e-9 m.

### FINDING S4-3 — the fore gaff passes through the spring stay (PRE-EXISTING)

Found while checking whether a lowered gaff fouls anything a peaked one
clears. It does not — but the fore gaff *already* intersects the spring stay
(`mainHounds` → `foreHoundsEye`) by 6 mm at **full hoist**, sheeted a few
degrees to starboard, in the rig as it has always been.

`boomSwingLimitRad` cannot see it. It sweeps one side and mirrors, on its own
stated assumption that the standing plan is symmetric — and the fore hounds
eye is offset 0.14 m off the centreline, which is precisely the asymmetry that
assumption waves through. Lowering deepens the overlap to 79 mm over a narrow
band around 0.9–0.98 hoist, then it opens out fast; by three-quarter hoist the
gaff is well clear, and by half hoist it has more than a metre.

Pinned by measurement in `ship-rig.test.ts` ("records the fore gaff's overlap
with the spring stay"), not fixed. The fix is either to move the stay or to
stop mirroring the limit — a rig-geometry decision, not a sailing one.

Measured alongside it, and reassuring: lowering costs no clearance worth the
name. The main gaff's worst gap improves monotonically as it comes down (0.05 m
peaked at hard sheet, 0.34 m near struck). The fore gaff dips ~0.046 m below
its peaked clearance around three-quarter hoist as it crosses from the topmast
shroud to the lower one, then opens out. Both stay clear; the fore eats into
the limit's own 0.05 m margin briefly.

### FAULT 2 — the rig moved in steps, not in motion

Every control read as *step step step*: trimming, furling, unfurling.

Not a smoothing problem. A **rationing** problem. A whole-rig rebuild measured
2.43 ms, so S4 rate-limited it to 120 ms and put a movement threshold on top:

| control | step | rate | what the eye got |
|---|---|---|---|
| main sheet | 0.74° | 8.3 Hz (the interval) | ~11 cm jumps at the boom end |
| hoist | 0.005 | **2.2 Hz** (the epsilon, at 1/90 per second) | slow 3 cm creeping |

Rationing an expensive rebuild does not make motion smooth; it makes it
stroboscopic at whatever rate the ration allows. Interpolating between the
rationed poses would have hidden it, at the cost of 120 ms of lag and a snap
at the furled boundary. The rebuild got cheap instead.

Where the 2.43 ms went, measured per builder (median of 40):

```
sails            1.178 ms   48.4%      deckFittings     0.328 ms   13.5%
finish           0.293 ms   12.1%      ratlines         0.177 ms    7.3%
runningRigging   0.150 ms    6.2%      channels         0.111 ms    4.6%
standingRigging  0.109 ms    4.5%      spars            0.069 ms    2.8%
```

Two findings in that table. Half the cost was 1,560 sail vertices, because
each one cost five `sailSurface` evaluations (the point plus two centred
finite-difference tangents) and every evaluation allocated a handful of `Vec3`
objects — about 39,000 short-lived objects per re-loft. And 0.74 ms of it
rebuilt things that cannot move: masts, tops, channels, deck fittings,
standing rigging, ratlines.

Both fixed:

- **Cloth without allocation.** The draft and height profiles only ever take
  the values `j/SAIL_U` and `i/SAIL_V`, and are the same functions for every
  sail on every rebuild, so they are tabulated once at module load. Normals are
  the surface's own analytic ones rather than four extra evaluations. The patch
  writes straight into a reused `Float64Array` through
  `SurfaceBuilder.addGridFlat`. 1.178 ms → ~0.12 ms.
- **A static half and a live half.** `LOFT_STEPS` marks each builder, and
  `Schooner` carries two meshes per material region. `buildDeckFittings` split
  in three at the same points in the draw order, because the headsail bullseyes
  and the blocks on the gaff and boom genuinely do move. Draw calls 19 → 22;
  triangles unchanged at 31,790.

The colour stream is the subtle part. A partial rebuild skips builders that sit
*between* the live ones, so it rewinds the generator to the state each live
builder started at (`SeededRandom.state`, recorded once from the authored
pose). Without that, the ship repaints itself every frame a sheet is moving.

**Results.** Live-only re-loft 0.46 ms in node, 0.6 ms median in the browser.
`main.ts` now re-lofts whenever any channel's value differs from the one it
last drew — no interval, no epsilon, no interpolation, no lag — and does
nothing at all on the frames when nothing moves.

`refreshLiveRigGeometry` additionally writes into the buffers already on the
GPU, allocating only when a sail crosses furled and the cloth's vertex count
changes. **Not demonstrated**: paired interleaved timing in the browser pane
could not separate it from the allocating path (0.6 ms median either way).
It is kept on the reasoning that disposing and re-creating four GPU buffers
every frame is worse than updating them, which that clock cannot see. If it
ever needs to be settled, settle it on the headless GPU harness.

### Not verified here

The **smoothness itself**. The browser pane this was built in does not run
`requestAnimationFrame` while it is hidden, so an animated furl could not be
watched end to end. Geometry, cost and the furl/unfurl buffer swap are all
verified; that the motion now reads as motion is Ash's call at the keyboard.

---

## S4 review, second pass — the roll, and which clock the crew is on · 2026-08-08

### FAULT 3 — a sail that came down into nothing, and a cylinder at the end

The furl bundle was drawn only once the sail was fully struck, at a radius
from a per-sail fitted formula (`0.03 + 0.0125·√area`, capped). Three faults in
one:

- **No progress.** Cloth shrank away to nothing all the way down, then a white
  cylinder appeared. Nothing showed how far through the evolution she was.
- **It did not wrap the boom.** At the gooseneck the boom is 0.098 m in radius
  and the mainsail's bundle was 0.125 m, less a fixed 0.03 m of sag — 0.095 m
  of cover over a 0.098 m spar. The timber came out through the top of the
  roll. That is Ash's "white cylinder and a wooden boom overlapping".
- **It was a fitted number.** Nothing tied the roll's size to the cloth in it.

Now the roll is sized by **conserving the cloth**. `furlRoll` takes the area
gathered so far, multiplies by one effective thickness
(`FURL_PACKED_THICKNESS_M`, 12 mm — loose folds with air, not wound canvas),
and solves the annulus around the spar it is wrapped on:
`r = √(core² + A/π)`. So it starts at the spar's own size, thickens with every
foot of halyard, and a big sail makes a fat roll *because it is a big sail* —
there is no per-sail table any more. The sag is now a fraction of the roll's
own thickness over the spar, so a thin new roll cannot droop far enough to
expose the timber.

Measured, fully struck (radius at heel/head, and the clearance over the spar at
the bottom of the sag):

| sail | roll length | r at h=0.9 | r at h=0 | worst clear |
|---|---|---|---|---|
| mainsail | 8.65 m | 0.121 / 0.090 | 0.194 / 0.176 | 0.015 m |
| foresail | 5.12 m | 0.119 / 0.087 | 0.182 / 0.163 | 0.014 m |
| fore staysail | 2.83 m | 0.046 | 0.127 | 0.022 m |
| jib | 3.95 m | 0.046 | 0.128 | 0.022 m |
| flying jib | 4.48 m | 0.050 | 0.140 | 0.024 m |
| fore topsail | 5.19 m | 0.084 | 0.174 | 0.019 m |

The mainsail finishes at about 0.37 m across on an 8.6 m boom, which is the
sausage in any harbour photograph of a gaff rig. `ship-rig.test.ts` asserts
both halves — that it grows at every step down, and that it clears its spar at
both ends at every hoist.

**The two sails that still vanish are the gaff topsail and the fisherman**, and
that is deliberate: they are handed and sent below, and have no spar aloft to
gather on. The test lists the six that do stow, so if either ever grows a stow
it shows up there. The three headsails Ash saw "disappear into nothing" now
carry a visible roll on the stay from the first foot of halyard — they were
drawn before, at 0.046–0.09 m and only at the very end.

### FAULT 4 — the crew was being charged to the wrong clock

Furling took 90 seconds at the keyboard, and Ash could barely tell it was
moving. The number was not the problem; the *clock* was.

This world runs two. Waves, hull motion and sail forces run on plain elapsed
seconds — you watch her roll in real time. But `PlanetaryWorld` advances the
calendar **and the distance made good** at 30×. So a control counted in
keyboard seconds is charged to the voyage thirty times over: handing the
mainsail burned 45 minutes of daylight and thirty times the sea room, and a
day spent tacking made almost no progress across the chart. Ash's point
exactly, and it is arithmetic rather than taste.

Which clock a control belongs to is decided by **what it costs**:

- A **sail evolution is an errand** — it costs a slice of the day, which is the
  whole point of the §5.2 table. `CREW_EVOLUTION_WORLD_SECONDS` now holds those
  durations in *world* seconds and `ACTUATION_RATES` divides by the compression.
  A gaff mainsail comes down in 3 s at the keyboard (90 world seconds), a reef
  in 8 s (240), a headsail in 1.5 s, the square topsail in 5 s, the kites in 2 s.
- The **helm and the sheets stay in the boat's frame**, unchanged. They are not
  errands; they are controls worked continuously against her live response, and
  S3/S4 pinned turning circles and a whole tack against exactly those rates.
  Moving them would have invalidated the tack evidence for no gain.

Pinned by test in `ship-sailing-controls.test.ts`. If 3 s reads too fast on
screen, the honest lever is `CREW_EVOLUTION_WORLD_SECONDS` — "this crew is
shorthanded and takes longer" — not a fudge factor downstream. Ash's word on
the 30×: "probably not a bad thing, but I'll have to eyeball it and we can tune
it later."

### FINDING S4-4 — the capture harnesses could not see the rig move

Found while trying to photograph the roll. `refreshRigLoft` was called from the
frame loop, and every capture harness (`shipContactSheet`, `rigLayoutSheet`,
the lighting sheets) deliberately drives `stepSimulation` and `renderFrame`
directly rather than waiting on `requestAnimationFrame`. So since S4 landed,
**every contact sheet has drawn the rig at whatever pose it was last lofted
at**, whatever the controls said — sails full in a picture of a struck ship.

Fixed by moving the call to the end of `stepSimulation`, where it belongs: the
rig follows the controls that the physics step just advanced, and every path
that steps the sim gets a rig that matches. Nothing else moved.

---

## S5 checkpoint — compass-course human helm · accepted 2026-08-11

**Status: implementation steps 1–5 of the approved human-crew handover are
built, gated and ACCEPTED by Ash after live `CURRENT_MODERATE` review. This is
the mandatory pre-trimmer checkpoint, not completion of S5.** Apparent-wind
steering and all automated sail adjustment remain deliberately unimplemented
until after this review.

### What landed

- `CompassInstrument` is a physical damped card on the 240 Hz dynamics grid,
  with wrap-safe response, small overshoot and correlated bounded seaway
  displacement. Magnetic and true north remain equal in this round.
- `SailingCrewSensors` is the exact-truth boundary. It reduces heading, hull
  motion, existing rudder resistance and sail aero into delayed/quantised
  compass memory, coarse head swing, cloth/wind, body and tiller-load cues.
  `Helmsman` imports only the human observation type.
- Spoken orders cross once-sampled utterance, recognition, processing and
  motor phases. Station/purpose random streams are independently seeded; no
  frame random draw or wall clock enters the operator.
- The helmsman changes the existing `SailingControls` rudder target only in
  discrete decide/wait/act/watch/ease episodes. The S4 actuator remains the
  sole blade mover and retains its rate limit.
- A direct tiller drag silences the crew immediately. Releasing it preserves
  the standing order, makes the returning hand reacquire the compass, and
  delays the next decision rather than snapping back to a stored target.
- The Sailing panel carries the temporary review HUD: moving compass card and
  fixed lubber line, order/perception/developer-truth marks, requested/actual
  rudder, perceived tiller load, gaze and order phases, intervention pulse and
  a rolling sixty-second trace.
- `npm run ship:crew` writes the committed deterministic internal-chain
  evidence at `evidence/ship-sailing/crew-baseline.json`.

### Ash's live review and accepted tuning

Ash's first verdict was "seems pretty good." The one fault was that the hand
changed what it was doing a little too often when generally heading straight,
though the quicker rhythm remained desirable during a maneuver.

The accepted correction is deliberately local: once the hand has eased to
midships, an ordinary settled-course correction cannot restart for three
seconds. A clear or fast bow swing and a loading tiller still interrupt the
look-ahead dwell; nonzero-helm response watching, counter-helm, active
maneuvers and direct-takeover reacquisition retain their quicker timing. The
evidence now gates that settled correction/ease/correction chatter cannot
reappear below the interval.

Accepted provisional checkpoint values after that change:

| case | result |
|---|---|
| compass 30° step | settles 4.2875 s; 1.13° maximum overshoot |
| steady compass | 0° final residual |
| repeated seaway | 1.621792° maximum card displacement |
| calm course hold | 1.64° RMS; 5.0 interventions/min; 24.2 s longest unchanged target |
| `CURRENT_MODERATE` hold | 1.40° RMS; 8.0 interventions/min; 24.0 s longest unchanged target |
| direct takeover | no crew decision during takeover; first post-release decision after 1.04361 s |

Thirty, sixty and 120 Hz callers produce identical fixed-step compass and helm
signatures. On merged `master`, the non-slow suite finishes at 76 files / 921
tests passed, 25 skipped; production typecheck and build are clean apart from
the existing Vite chunking/import warnings.

### What remains in S5

1. Add apparent-wind-angle steering through perceived wind, cloth and head
   cues. The helmsman must not receive the mathematical apparent-wind angle.
2. Build one human operator loop per sail station: observe, decide, wait, haul
   or ease a finite amount through `SailingControls`, then watch the cloth.
   **No automatic sheet adjustment exists at this checkpoint.**
3. Add shared spoken `trim-to-draw` orders with independent station response
   delays, sustained cannot-draw reporting, and no artificial anti-synchrony.
4. Add trimmer polar-fraction and gust/heel evidence, including delayed
   incremental easing and useful steady performance without reproducing the
   ideal S4 trim oracle.
5. Review apparent-wind behaviour if materially different, run the full
   relevant slow sailing gates, regenerate all S5 evidence, and record final
   round acceptance.

Waypoint sailing, tacks as ordered crew sequences and canvas policy remain S6,
not unfinished S5 checkpoint work.

---

## S5 trimmers — the crew's hands on the sheets · implemented 2026-08-15

**Status: BUILT, GATED, AWAITING ASH'S LIVE REVIEW.** Steps 6–8 of
`docs/sailing/SAILING_S5_HUMAN_CREW_HANDOVER.md` §11. The helmsman was
re-confirmed acceptable by Ash on 2026-08-15 before this work started, closing
the outstanding verdict from the heading-hold bias round.

### What landed

- **The dogvane became an instrument.** `sailAero` now publishes the hull-level
  apparent wind it already computed for blanketing; `SailingCrewSensors`
  reduces it to a coarse vane reading — delayed, quantised to 5° when the
  helmsman is looking at it and 15° when he is not, with its own acquisition
  delay. Its bearing comes from `WorldWind.windAngleOffBowDeg`, the same
  convention the polar uses, so the crew's felt wind and the polar's wind
  angle cannot drift apart.
- **`hold apparent wind angle`** is a second standing helm order. The helmsman
  never receives the apparent angle: he works from the vane reading, the luff,
  the bow's swing against the horizon and the weight in the tiller, with the
  card demoted to a slow secondary reference. Shaking cloth is its own evidence
  that she has come too close, and starts a bear-away before a fresh vane
  reading arrives.
- **`Trimmers.ts` — six stations**, five sheets and one brace, each with its own
  order pipeline, attention timers and seeded streams. A station observes its
  own cloth, decides `acceptable` / `haul` / `ease` / `overpowered ease` /
  `cannot draw`, waits out a decision and motor delay, makes **one finite
  adjustment**, then watches it before deciding again.
- **`trim to draw`** as one spoken order every station hears in its own time,
  plus `stand down sheets`. Direct player takeover of a sheet silences that
  station and preserves the standing order, exactly as the helm's rule does.
- **The review HUD** carries a vane line and a line per station: order phase,
  last decision, and the last adjustment with what the hand saw when he made it.

### The method, and why it needed both halves

A trimmer who only hardens a shaking sail converges from one side and stops at
the first setting that does not complain — which can be a long way from a good
one, because **a sail sheeted too hard does not shake to tell you so**. The
loop therefore has the other half of the only method a hand actually has:
after a long settled interval he **tries the sheet a little further out**, and
if the luff answers, the ordinary hardening rule takes it straight back. The
trial interval doubles after each trial he has to undo, so once he has found
this sail's edge he stops reaching for it.

Two supporting corrections, both found by measurement:

- **A luff that flickers is still a luff.** `unsettledSeconds` began as a
  stopwatch that zeroed on the first good moment, so intermittent shivering
  never accumulated and the mainsail hardened once and then sat 10° off for
  two and a half minutes. It is now a leaky accumulator that fades more slowly
  than it builds.
- **A yard is not a sheet.** The square topsail has no hauled-flat state: it is
  braced round until its face meets the wind, and a general "shaking → harden"
  rule left it aback and untouched forever. `decideBrace` handles it separately,
  which is the distinction the handover's own §7 already drew.

### The numbers (committed, `evidence/ship-sailing/crew-baseline.json`)

Three cases, each run three ways over the same 180 s with the same seed, sea,
wind and helmsman — differing only in who touches the sheets. The "ideal" is
`trimToDrawDeg`, the S4 schedule, written every substep; the trimmers are
forbidden to call it.

| case | crew | ideal | untouched | crew / ideal |
|---|---|---|---|---|
| from the working trims, 6 m/s | 3.663 | 3.657 | 3.596 | **1.002** |
| from a badly set rig, 6 m/s | 3.510 | 3.653 | 3.107 | **0.961** |
| strong wind, 16 m/s | 5.270 | 5.343 | 5.216 | **0.986** |

A rig eased right out and left there makes 0.850 of the ideal; the hands
recover it to 0.961 without being told what is wrong with it. They do it in
23 adjustments across six stations in three minutes — roughly one per station
per minute — with a minimum gap of 2.3 s between any station's two decisions.

Gates: no station acts before its own utterance, recognition, processing and
motor delays have run; every adjustment is followed by a real observation gap;
the crew reach ≥ 0.94 of the ideal; their settled sheets sit ≥ 2° from the
schedule's on average (they did not arrive at its answer); a badly set rig is
recovered by more than 0.05 of the ideal; and `cannot draw` is only ever
reported from sustained evidence.

### FINDING S5-1 — the felt wind side was labelled backwards (PRE-EXISTING)

`WindAndSailCue.side` was derived from the sails' angle of attack, so on the
authored starboard tack — wind over the starboard rail, booms to port — it
reported `port`. It names the side the wind is on and `Helmsman` reads it as
that, but it was reporting the side the *sails* are on.

Harmless where it was used: the helmsman only watches it for a flip, and a
consistent inversion flips at the same moments. It is not harmless for a
trimmer, who decides which way to haul from it. Now derived from the apparent
wind vector and pinned by three tests against the same beam-reach fixture
`ship-sailing-aero.test.ts` fixes the force signs on.

### FINDING S5-2 — a new perceptual sample moved the accepted helm trace

The dogvane originally drew from the helm's own `perception` stream. Every
compass and tiller draw after the first glance then landed differently, and
the accepted S5 helm changed behaviour without a line of helm code changing:
the `CURRENT_MODERATE` settled signed mean went from +0.55° to +1.30° and blew
the `helmHoldsCourseCentred` gate.

This is exactly what the handover's stream-per-station-and-purpose rule exists
to prevent, and the gate the heading-hold round added is what caught it. The
vane now has its own stream and the helm numbers are back to −0.12° and
+0.55° to the digit. **The lesson generalises: any new sampled cue needs its
own stream, and a shared RNG is a coupling between modules that do not import
each other.**

### FINDING S5-3 — she carries a permanently aback square topsail on every beat

Close-hauled at ~60° apparent, the fore topsail sits at −45° angle of attack.
The hand braces the yard round to its mechanical stop (15° → 21.9°, which is
also where the ideal schedule puts it) and it still will not draw, so he
reports `cannot draw` and leaves it. That report is correct and the geometry is
correct — but nothing acts on it, because striking a sail is S6. **She is
therefore beating with a square sail aback, all the time, and nobody is
paying for it in the numbers because it is in every case equally.** The
fix is S6's canvas policy: a sail that cannot draw on this point of sail
should be clewed up.

### FINDING S5-4 — easing alone cannot depower her

In the 16 m/s case the hands feel her lying over, ease twelve times, and end
with every sheet at or near its outer stop — and she still touches **30.7° of
roll**. S2 gated steady heel under full sail at 12 m/s into the 15–25° band;
this is well past it. The trimmers are behaving correctly and are simply out
of authority: what she wants is a reef, and shortening sail is S6. Recorded as
`strongWindHeelBoundedDeg` rather than gated, because a bound the crew cannot
enforce is not their gate to pass.

### FINDING S5-5 — "the ideal polar" is a static rule, not an optimum

`trimToDrawDeg` sheets every sail to the lift peak off the *current* apparent
angle, recomputed every substep. In a seaway that is not optimal: the crew
beat it (1.002) in the working-trims case simply by leaving sails alone while
the apparent angle wandered. The gate was therefore moved off speed and onto
**distance from the schedule's settings**, which tests the thing that actually
matters — that the hands did not arrive at the oracle's answer. Note also that
`SailingPolarEvidence`'s comment calling that schedule "S5's `Trimmers` policy
in fixture form" is now misleading and should be reworded: the production
trimmers cannot call it, and do not reproduce it.

### Not verified here

**That it reads as human.** The browser pane does not run
`requestAnimationFrame` while it is hidden, so the simulation is frozen in it
and the hands cannot be watched working end to end. The panel renders, the
controls issue orders, the vane line reads correctly (60° off the bow,
starboard, close-hauled — matching the headless runs), and there are no console
errors. Everything else is Ash's call at the keyboard, per the handover's
acceptance statement.

---

## S6 — The navigator: sail to a point · implemented 2026-08-17

**Status: BUILT, GATED, AWAITING ASH'S LIVE REVIEW.** Tier 2 of the design's
command hierarchy exists. The plan's accept-when — "Ash drops a pin upwind in
`WIND_CHOP`, orders 'sail there', and the ship beats to it while he stands on
deck and watches the crew's invisible hands work her" — is **not certified
here and is owed**. Headless evidence proves the contract and the bounds; it
cannot tell you whether a beat reads as a beat from the quarterdeck.

Both of S5's outstanding debts are closed and both are closed with a measured
number. Two new findings, one of them a real bug that had been sitting in the
order pipeline since S5.

### What landed

- **`crew/Navigator.ts`** — one man with a chart. He decides direct course
  versus beat, picks the board, runs the boards out, calls the evolutions, and
  says when she has arrived. His whole input is a `NavigatorObservation`: a fix
  a few minutes old, the compass card, the log, and an estimate of the wind's
  bearing and strength that is filtered over 75 s and read to 5° and half a
  metre a second. No vessel velocity, no heel, no sail force, no apparent-wind
  vector — the same discipline S5's handover imposed on the helm, applied to
  the chart room. He writes no control: everything he decides leaves the module
  as a spoken order.
- **`crew/CanvasPolicy.ts`** — the wind-band table of design §7, six plans from
  *all plain sail* to *fore and staysail*, with the ordering asserted rather
  than assumed (`canvasPlansAreMonotonic`). Quick to shorten, slow to shake
  out: 25 s of settled judgement to reduce, 90 s and a clear 1.2 m/s below the
  band's floor to make sail again.
- **`crew/CanvasHands.ts`** — eight stations that hear "shorten sail" and each
  go and work their own sail through the existing `SailingControls` evolution
  rates, charged to the crew's own working day. Deliberately separate from
  `Trimmers`: a sheet is worked continuously against the sail's behaviour, a
  halyard is an errand you are sent on. Different men, different streams.
- **Evolutions as sequences.** The helmsman gained a tack/gybe mode — helm
  toward the wind (away for a gybe), *held* until the wind is on the other
  cheek **and** the cloth fills, "shift your helm" for a stern-board when she
  hangs in stays, and an honest failure when she will not go round. The
  trimmers gained the sheet half: haul taut at the order, the fore staysail
  held aback until she pays off, over, then eased to the working trim on the
  new board. The new course rides in on the tack order, so there is no window
  in which a helmsman is steering the old course through a hundred degrees of
  wrong.
- **`npm run ship:voyage`** writes `evidence/ship-sailing/voyage-baseline.json`.
- **`EllipsoidGeodesic` gained `inverse`.** The navigator's course to a
  waypoint and the vessel's own propagation are now the same solver on the same
  figure of the earth — ellipsoidal in production, spherical in evidence, one
  of each. A layline measured on a different earth from the one she sails is
  the "no second geometry" rule with a chart in its hand.

### The numbers (committed, `evidence/ship-sailing/voyage-baseline.json`)

**The beat.** `WIND_CHOP`, 9 m/s with 0.45 gustiness, a mark 4 km dead to
windward, voyage clock at 5×, arrival radius 300 m.

| | |
|---|---|
| fetched the mark | 644 s, 57 m to go |
| boards | 3 tacks ordered, 3 completed, 0 failed, 0 deferred for want of way |
| tack durations | 47.6 s, 46.2 s, 50.2 s (order to cloth full on the new board) |
| ground each tack cost | 504 m, 473 m, 460 m of chart, at 5× |
| track sailed | 7635 m for 3943 m made good — efficiency **0.516** |
| canvas | all plain sail → working canvas → flying jib in, 4 evolutions |
| mean speed | 2.37 m/s |

The efficiency is the number that says she really beat: 0.516 against the
theoretical 1/cos(55°) = 0.574 for perfect boards, so she is losing about a
tenth of her track to the tacks themselves and to the boards being ordinary
rather than optimal. A "beat" at 0.95 would mean the mark was never upwind.

**The gybe.** 8 m/s, a mark 4 km away on bearing 040 with the wind from 270 and
her broad on the starboard gybe: the only way there takes her stern through the
wind. She arrived in 348 s, 220 m to go, **1 gybe and 0 tacks**, gybe duration
38.3 s, efficiency 0.866 (a passage that could nearly be laid).

**The same beat at 30×.** 24 km to windward, arrival radius 2500 m: arrived
654 s, 1123 m to go, 3 tacks, efficiency 0.526 — the same passage, sailed the
same way, on a chart moving thirty times faster. The tacks took 47.6, 50.4 and
55.3 s exactly as before and cost **3023 m, 3083 m and 2772 m** of chart doing
it. That ratio is the honest consequence of the two clocks and it is why the
arrival radius is a per-voyage parameter: at 30× an evolution costs kilometres,
so "close enough" cannot be tighter than what an evolution costs.

**Shortening sail, against S5's FINDING S5-4.** 16 m/s, `CURRENT_MODERATE`,
300 s, identical seed, sea, wind and hands — the only difference is whether
anyone may take cloth off her.

| | sheets only | canvas policy |
|---|---|---|
| settled maximum roll | **26.4°** | **21.0°** |
| peak roll (first two minutes, both under all plain sail) | 30.7° | 30.7° |
| rig she ended on | as found (full) | close-reefed |

**5.5° of relief**, and it puts her back inside the 15–25° band S2 gated steady
heel into. The peaks are equal to three digits because both runs start under
all plain sail and the crew take about two minutes to get the reefs in: that is
not a defect, it is what shortening sail costs, and it is why the comparison is
made on the settled window.

**The canvas sweep.** Walking the wind from 2 to 20 m/s a step at a time
through the policy's own hysteresis, cloth carried goes 24 → 18 → 15 → 13 → 6 →
5 (in the table's own per-sail units) and the plan index never decreases. Both
the table's ordering and the swept result are gated.

**The voyage clock.** Two runs of one scripted case at 1× and 30× — a rudder
command at 30 s, a shorten-sail order at 60 s, the trimmers working their
sheets throughout:

- the control traces are **byte-identical** (1357 characters of ordered helm,
  trim adjustments and sail evolutions);
- the four sail evolutions took 10.008, 8.004, 1.504 and 2.004 s in both;
- water passed under her: 508.550468 m in both, **identical**;
- chart covered: 508.550468 m against 15256.514041 m — a ratio of
  **30.000000002**.

The helmsman is deliberately *not* in that case, and the reason is the
invariant working rather than failing: his compass reading is a function of
where on the earth she is, so at 30× he is genuinely somewhere else and steers
differently. Displacement compresses. Nothing else does.

**Determinism.** The beat's first five minutes, run again from the same seed,
gives a byte-identical control signature, and 30/60/120 Hz callers all give the
same one.

**The square topsail, against S5's FINDING S5-3.** The hand at the yard
reported `cannot draw` at 31.8 s of the beat; the navigator struck it at
35.8 s — **a 4.0 s response**. It then spent **4.9 s** aback while the cloth
came in, and none thereafter, against S5's "all the time, in every case
equally". It stays handed while she is close-hauled and may be re-set only when
her ordered course is 100° or more off the wind.

### FINDING S6-1 — a spoken order arriving mid-action was silently dropped

`StationOrderPipeline` only delivered an order while the station's phase was
`acting`, and any completed action calls `markWatching`, which moves the phase
on. An order that arrived while a hand was in the middle of a correction
therefore had its phase taken from it in the half-second between understanding
it and beginning it — and was then **never delivered at all**. The station
simply never heard it.

S5 never saw this because every order in its evidence is given at t=0 with the
deck idle. S6's navigator gives orders all voyage long, and the first
measurement showed **three of the first four tacks he ordered vanished**, along
with three course orders. She sailed on serenely, and the navigator's watchdog
reported "the order was never worked" twenty seconds later.

Delivery is now decided by the clock, not by the phase, and `markWatching`
refuses to mark an order watched before it has been delivered. **The S5
`crew-baseline.json` is byte-identical after the change**, verified by
regenerating it — which is the only reason this could be fixed inside S6 rather
than being escalated.

### FINDING S6-2 — the S5 handover's checkpoint table is stale

`SAILING_ROUND_HANDOVER.md`'s S5 checkpoint table (2026-08-11) records calm
hold at 1.64° RMS, 5.0 interventions/min and 24.2 s longest unchanged target.
The committed `crew-baseline.json` — written by the trimmers commit, 8753f9c —
says **1.13° RMS, 3.7/min, 40.4 s**, and `CURRENT_MODERATE` says 1.46°,
10.7/min, 30.5 s against the table's 1.40°, 8.0/min, 24.0 s. The evidence moved
when the trimmers landed (they change what the sails are doing under the
helmsman) and the table did not follow.

Not touched, because those are the numbers **Ash accepted at the checkpoint**
and re-labelling his acceptance is not an implementer's call. Reported so the
next person compares against the JSON and not the prose.

### Deliberate simplifications, so nobody finds them by surprise

- **No laylines.** Boards are a fraction of what is left of the passage (0.45,
  floor 250 m, ceiling 20 km), which converges without any layline arithmetic.
  The plan asked for fixed legs in v1 and this is that, with the one change
  compression forced: an *absolute* board length is meaningless at 30×, where
  two miles of chart is twenty seconds of sailing and a tack is fifty.
- **The first order of a voyage is never an evolution** unless her present head
  is genuinely on the other side of the wind from the mark. When both boards
  are equally good — which is exactly the case for a mark dead to windward —
  he keeps the one she is on. Measured the hard way: without that tie-break he
  threw her through the wind on the first order for no gain and she stalled at
  0.1 m/s in the eye of it.
- **The fisherman is not dipped in an evolution.** It has a side rather than a
  trim and no station works it during a tack. It is struck by the canvas policy
  above 5.5 m/s, so it is rarely set when one is ordered, but a tack in light
  air will carry it aback. Small, known, not fixed.
- **No heaving to, no route optimisation, no wind-shift strategy.** Out of
  scope by the plan.

### Not verified here

**That it reads right from the deck.** The accept-when is Ash's, and nothing in
this round can stand in for it: whether the beat feels like a beat, whether the
tacks read as events, whether the crew shortening sail in a rising breeze looks
like seamanship or like a spreadsheet. Also unmeasured by choice: any
performance number. The machine was thermally throttled throughout and a cold
pass belongs to Ash.

### Reproducing the evidence

```
npm run ship:voyage          # rebuilds evidence/ship-sailing/voyage-baseline.json
npm test                     # the fast suite, including the S6 gates read from that file
npm run test:slow:sailing    # rebuilds the canvas sweep and the voyage-clock case
npm run build
```

---

## S6c — The coefficient round: what a sail costs · implemented 2026-08-17

**Status: BUILT, GATED, AND THE POLAR A/B IS ASH'S.** The three faults three
separate rounds queued into one coefficient block are closed: induced drag
(FINDING S4-1), lift on an aback sail (FINDING S4-2), and CLmax reading the
static design camber while the drawn camber went live (SHIP_RIG_HANDOVER
§11.6). Every committed sailing number is re-priced and regenerated in the
same commit. **She is slower — much slower close-hauled — and that is the
result, not a regression.** Whether she sails *better* or merely
*differently* is a question this round cannot answer about itself; §"What is
owed to Ash's eye" is the ask.

### The three terms, and where each number comes from

**1. Induced drag — `CDi = CL²/(π·AR_eff·e)`.** The same form
`SCHOONER_RUDDER_COEFFICIENTS` has priced the blade's lift with since S3,
applied per sail, on the CL the sail is *actually* carrying (so a luffing
sail pays nothing and a backed sail pays for the lift it carries backwards).

`AR_eff` is solved from the live corners every substep — the cloth actually
standing there, so a reef, a half-hoist and a swung trim each change it:

- `span` = the cloth's own vertical extent, `area` = its planform;
- `AR_geom = span²/area`. No choice in it;
- the sea is a mirror. A sail whose foot touched the water would be half of
  a wing of twice the aspect ratio. A gap lets flow across and spends the
  mirror: `imageGain = 1/(1 + k·gap/span)`, `k = 2`, gap measured from the
  foot to the sea at her design draught. Both limits are right — gap 0
  doubles the aspect ratio, a sail high in the air keeps its own — and `k`
  is the one shape choice, saying the mirror is half spent at half a span.
  It is the same partial-end-plate idea the rudder is already priced with
  (geometric 3.4 raised to 5.1 against the hull).

At the authored trims, all of it derived, none of it fitted:

| sail | area m² | span m | foot above sea | gap/span | AR_geom | image gain | **AR_eff** |
|---|---|---|---|---|---|---|---|
| mainsail | 57.6 | 10.56 | 3.85 | 0.36 | 1.94 | 0.58 | **3.06** |
| foresail | 28.2 | 8.39 | 3.30 | 0.39 | 2.50 | 0.56 | **3.89** |
| fore staysail | 11.6 | 7.03 | 2.87 | 0.41 | 4.26 | 0.55 | **6.61** |
| jib | 16.3 | 10.23 | 3.20 | 0.31 | 6.43 | 0.62 | **10.38** |
| flying jib | 22.2 | 10.86 | 3.67 | 0.34 | 5.31 | 0.60 | **8.47** |
| **square topsail** | 35.3 | 5.75 | 10.15 | 1.77 | **0.94** | 0.22 | **1.14** |
| fisherman | 14.8 | 6.60 | 12.10 | 1.83 | 2.94 | 0.21 | **3.57** |
| gaff topsail | 15.5 | 8.10 | 11.00 | 1.36 | 4.24 | 0.27 | **5.39** |

That spread is the finding in one table. The two workhorses and the square
topsail — **60% of her canvas** — are the low-aspect surfaces, and the
square topsail set aloft gets almost no help from the sea. This is why
gaffers do not point, arrived at from the rig's own geometry rather than
asserted.

**`e = 0.85` is the one number in this round that is NOT derived, and it is
said plainly in the code.** It prices everything the lifting-line ideal does
not have: loading nowhere near elliptic, the twist the M6 cloth draws, a
mast or a stay in the luff, eight surfaces sharing one wake. It sits
deliberately below the rudder's 0.90, which prices a clean rigid blade. It
was written down **before the first polar was solved with the induced term
in and was not touched afterwards** — the discipline matters more than the
value. Deriving it honestly means a Glauert planform solve per sail (the
chord distribution is available from the same corners `AR_eff` reads) and is
worth of order 5% on the induced term. Named as owed, not smuggled in.

**2. Aback lift — the same curve on the other face.** `sailLiftCoefficient`
returned 0 for any negative AoA, "an aback sail in v1 is treated as
collapsed, like luffing". It is now read at `−aoa` with the shallower belly
a backed sail actually takes, gated by a new `sailAbackFactor` — which is
*the cloth's own* `abackFill` curve, `smoothstep(0, 12°, −aoa)`, moved into
`sailAero` so the loft and the physics read one function. Net CL is
`attach·CL(+aoa, camberDraw) − aback·CL(−aoa, camberAback)`, negative when
she is backed. Between the two branches is a band where neither holds: that
is the cloth that flogs, and it carries no lift from either side.

Drag changed with it, and this turns out to matter more than the lift: an
aback sail is **pressed cloth, not a shivering rag**, so it carries the
attached drag curve. Before, a sail 65° aback sat at `cdLuffing` = 0.05.
Now it sits near 1.0.

**3. CLmax reads the drawn camber.** The M6 round made the belly a live
shape and left the coefficient reading `Sail.camber`. The two shape terms —
the ±5° centreline ramp and the flattening a hard sheet takes out — moved
into `sailAero.SAIL_CLOTH_SHAPE` and `sailShapeCamber`, and `rigGeometry`'s
`CLOTH_CUTS` now reads them from there instead of holding its own copy. The
flow terms (`fill`, `attach`, `abackFill`) are deliberately **not** folded
in: the aero already prices them as the attachment gate and the dynamic
pressure, and counting them twice would price a luffing sail's collapse
twice.

At the 20° working sheet the mainsail's drawn camber is 0.085 → **0.0682**,
CLmax 1.188 → **1.090**; backed it is 0.0297, CLmax **0.773**. The square
topsail backed is CLmax **0.402** against 0.825 drawing, because its aback
belly is 0.10 of its draft — measured in M6, because its flat patch clears
the fore topmast by 94 mm and a backed square sail lies against the stick.

**No pixels moved.** `sailAbackCamber` matches the loft's aback belly
exactly rather than being more coherent than it, the `?cloth=flat`
checksums taken from master still reproduce, and the whole rig-cloth suite
is green.

### THE POLAR, BEFORE AND AFTER (steady speed, m/s)

The A/B is Ash's and this is the one glance. `npm run ship:polar` prints
this table itself now, against whatever is committed.

| true wind off bow | 4 m/s FULL | | 8 m/s FULL | | 12 m/s FULL | | 12 m/s WORKING | |
|---|---|---|---|---|---|---|---|---|
| | **was** | **now** | **was** | **now** | **was** | **now** | **was** | **now** |
| 30° | 0.05 | **0.00** | 0.13 | **0.00** | 0.21 | **0.00** | 0.23 | **0.00** |
| 45° | 1.31 | **0.47** | 2.70 | **1.03** | 3.75 | **1.59** | 3.64 | **1.00** |
| 60° | 2.22 | **1.38** | 3.92 | **2.88** | 4.66 | **3.85** | 4.51 | **3.44** |
| 75° | 2.70 | **1.97** | 4.20 | **3.67** | 4.86 | **4.48** | 4.71 | **4.25** |
| 90° | 2.78 | **2.30** | 4.23 | **3.95** | 4.91 | **4.71** | 4.76 | **4.53** |
| 105° | 2.68 | **2.37** | 4.15 | **4.00** | 4.84 | **4.74** | 4.68 | **4.58** |
| 120° | 2.32 | **2.20** | 3.95 | **3.87** | 4.68 | **4.66** | 4.58 | **4.53** |
| 135° | 2.04 | **2.04** | 3.67 | **3.69** | 4.46 | **4.48** | 4.35 | **4.38** |
| 150° | 1.87 | **1.89** | 3.54 | **3.57** | 4.46 | **4.48** | 4.35 | **4.41** |
| 165° | 1.74 | **1.76** | 3.39 | **3.42** | 4.33 | **4.35** | 4.25 | **4.28** |
| 180° | 1.54 | **1.56** | 3.03 | **3.11** | 4.05 | **4.10** | 4.05 | **4.10** |
| best | 2.78 @ 90° | **2.37 @ 105°** | 4.23 @ 90° | **4.00 @ 105°** | 4.91 @ 90° | **4.74 @ 105°** | 4.76 @ 90° | **4.58 @ 105°** |

**The shape of it, said plainly:**

- **Upwind she is much slower.** 45° loses 60–73% of her speed; 60° loses
  17–38%; and inside 30° she is dead at *any* sheeting the rig permits.
- **Reaching she loses a little.** 90° gives up 4–15%.
- **Downwind she is very slightly FASTER** — +0.03 to +0.08 m/s from 135°
  aft. Off the wind the square topsail draws instead of being ignored, and
  drag is drive there.
- **Her best point of sail moved aft**, 90° → 105°, on all four sheets that
  existed before this round. A rig
  that pays for its lift prefers a broader reach. That is a real, legible
  behavioural change and it is the kind of thing to look for on the water.

**Do not read the 45° collapse as "she cannot beat".** It is mostly one
sail, and the fifth sheet exists to prove it.

### The fifth sheet: what the square topsail costs on a beat

`BEATING_SAIL` at 8 m/s — the working canvas with the square topsail
handed, which is what a crew carries and, measured, what S6's navigator
already does (the hand reports `cannot draw`, it is struck 4.0 s later).

| true wind | FULL_SAIL 8 m/s | BEATING_SAIL 8 m/s |
|---|---|---|
| 45° | 1.03 | **2.25** |
| 60° | 2.88 | **3.44** |
| 75° | 3.67 | **3.80** |
| 90° | 3.95 | 3.95 |
| 150° | **3.57** | 3.31 |
| 180° | **3.11** | 2.81 |
| close-hauled angle | 60° | **45°** |

A square sail cannot be braced to draw close-hauled — her braces stop at
22° and the apparent wind is 40° forward of that — so close-hauled it
stands **65° aback**, 35 m² of pressed cloth at CD ≈ 1.0 and AR 1.14. It is
worth **−1.6 kN of drive at 60° true**. Handed, she points 45° instead of
60° and gains 1.2 m/s there. Carried, she is 0.3–0.5 m/s faster from 150°
aft. That is the whole argument for handing a square topsail on a beat,
and until this round the model could not express either half of it.

**How much of the FULL_SAIL collapse is induced drag and how much is the
topsail?** Measured against a full wardrobe with only the topsail furled
(2.374 m/s at 45°, 3.644 at 60°, probed directly rather than committed —
the `BEATING_SAIL` sheet also strikes the kites, so its numbers are lower
again), and against the old polar, where an aback topsail was already
inert at `cdLuffing`: **the induced-drag term alone costs 12% at 45° and
7% at 60°.** That is the honest price of the pointing limit, and it is a
small fraction of what the FULL_SAIL column shows. The rest is the sail a
crew would have handed.

### The pointing limit, and whether the 20° sheet floor is still needed

**It is not, and that is the round's cleanest result.** S4 said in writing
that `MIN_DRAWING_SHEET_DEG = 20` was a period-practice stand-in holding the
model up because the aero had no pointing limit of its own. Re-measured on
S4's own ladder, 8 m/s, 30° true, FULL_SAIL:

| sheet floor | before (S4) | after (S6c) |
|---|---|---|
| 8° | 2.68 m/s — gate blown | **0 — dead, −770 N at rest** |
| 12° | — | **0 — dead, −749 N** |
| 16° | — | **0 — dead, −986 N** |
| 20° | 0.15 m/s | **0 — dead, −1454 N** |

She cannot be made to sail at 30° at any sheeting the rig permits. At 45°
the floor is worth 0.05 m/s and at 55° nothing at all — the apparent angle
there is wide enough that the lift-peak rule is not clamping.

**The floor is kept, at 20°, and its comment rewritten.** Nothing rides on
it now; it could be lowered without a gate noticing. It stays because it is
what a crew does, and because S5/S6's hands share its value through
`SailingControls.WORKING_TRIM_DEG` — moving it is a crew decision, not an
aerodynamic one, and this round had no measurement that wanted it moved.

The new evidence for the limit is `PolarSheet.closeHauledAngleDeg`: the
first grid angle at which she makes half that sheet's best speed. **60° on
every full-canvas sheet, 45° with the topsail handed**, gated into 45–75° in
both directions so the limit can neither vanish nor swallow the beat.

### Heel, leeway and helm

| | before | after |
|---|---|---|
| full sail heel at 12 m/s (gate band 15–25°) | 18.32° | **19.68°** |
| working sail heel at 12 m/s | 14.49° | **15.51°** |
| max leeway *in the sailing sector* | 3.52° | **6.33°** |
| max helm to hold course *in the sailing sector* | 3.56° | **6.84°** |
| voyage settled heel at 16 m/s, sheets only | 26.4° | **27.5°** |
| voyage settled heel at 16 m/s, canvas policy | 21.0° | **23.1°** |

**She heels MORE, everywhere, and that is the honest direction.** Slower
through the water means the apparent wind stays further abeam and stronger
relative to her, and an aback sail's pressed drag is a side force where it
used to be nothing. The 12 m/s band still holds with 5.3° of margin; the
16 m/s voyage numbers moved up about a degree each and the canvas policy
still buys 4.4° of relief (was 5.5°).

Leeway and helm nearly doubled, and the gates for both are now **scoped to
the sailing sector** (points at or above half their sheet's best speed).
That is a gate whose intent survives and whose scope had to move: at 45° in
8 m/s she now makes 1.03 m/s with 20° of drift and 22° of helm, which is a
true captive answer describing a ship being dragged sideways. The old
unscoped gate would have forbidden the file from *measuring* that. A new
gate asserts that nothing **inside** the sector saturates the leeway search.

### THE TACK: the gate flipped back, and the decomposition says which term did it

`classicTackCompletesAtAnyEntry` was S3's deliberate FALSE, S4's celebrated
TRUE, and is now FALSE again. Before believing that, the terms were switched
off one at a time — three runs of the same script:

| arm | result |
|---|---|
| **both terms on** (the honest model) | captured **−48° to −67°** — no entry even reaches the eye |
| induced drag OFF, aback ON | captured **−45° to −68°** — same failure |
| aback OFF, induced drag ON | **crosses the eye on every entry** (1.11–1.41 m/s), captured **+22° to +34°** |

So the dominant term is the aback branch, and on the approach leg the only
aback sail is the square topsail. **The harness was tacking a topsail
schooner with its square topsail set and 65° aback.** One line was added to
the tack script — `commandSetState('foreTopsail', 'furled')` at the top of
the approach leg, the order that precedes "ready about" — and it is the only
change this round made to a maneuver script. With it:

| | S4 | S6c |
|---|---|---|
| 6 m/s, close reach | completed 101.2 s | **crosses the eye, captured at 28.1°** |
| 8 m/s, close reach | completed 81.4 s | **crosses the eye, captured at 32.6°** |
| 8 m/s, beam entry | completed 122.8 s | **crosses the eye, captured at 21.0°** |
| from rest | fails before the eye | fails before the eye (unchanged, correct) |
| eye-crossing speed band | (n/a, all completed) | **1.11–1.43 m/s** |
| capture band | null | **21.0–32.6°** |
| gybe | 51.5 s, transit 13.2 s | **50.9 s, transit 13.1 s** (unchanged and sound) |

**Read the capture band.** S3 measured 34.0–34.9° on the *near* side of the
eye. S6c measures 21.0–32.6° on the *far* side. Same attractor, same
mechanism — the sails fill, their weather moment pins her, yaw rate goes to
zero — reached from the other direction, because she now gets *through* the
wind and cannot get away from it. **S4 flipped this gate by hardening the
sheets, and that worked because hard-sheeted lift was free.** Induced drag
prices it, and the flat maneuvering trims no longer buy enough drive to
carry her out to a close-hauled groove that has itself moved from ~45° to
55–60°. The script's fixed 42° completion angle is asking her to settle on a
course the rig can no longer sail to.

**THE SHIP CAN STILL TACK.** `ship:voyage`, regenerated in this commit,
beats 4 km to windward with **three tacks ordered, three completed, none
failed**. The crew work the sheets continuously against the cloth and
stern-board her when she hangs; this fixed-angle script does neither. The
stale instrument is the script, not the ship — which is why the gate was
reversed rather than the model retuned, and why the harness's own fix
(ease when the cloth fills, not at a fixed angle; carry the crew's
stern-board) is named below as owed rather than done here.

### IRONS: FINDING S4-2 is closed, and all five gates reversed

S4's gate carried an instruction: *"if this ever flips, someone has added
the aback branch and must come here and say so deliberately."* This is that.

| what the crew does | S4 | S6c |
|---|---|---|
| nothing (drift) | free after 229.2 s | **free in 44.3 s** |
| **back a headsail** | **STUCK** — pinned at −18.8° for 240 s | **free in 48.4 s** |
| helm alone (stern-board) | free in 79.9 s | **free in 48.0 s** |
| backed headsail **and** helm | free in 80.4 s | **free in 50.6 s** |
| helm the other way | **STUCK** — pinned at −20.5° | **free in 64.1 s** |

Backing a headsail is a move that works now. Both attractors S4 documented
are gone, including the toward-sheets one at ≈20° — falling off toward your
sheets is still the slow way round (64.1 s against 48.0 s) but no longer
hopeless, so S5's recovery rule can be relaxed from "impossible" to
"slower".

**Two things to be suspicious of, surfaced rather than smoothed:**

1. **Backed headsail + helm is still *worse* than helm alone** — −2.6 s,
   where S4 measured −0.5 s. It is not a bug: backing a sail and putting
   the helm the same way are two ways of doing one job, and the backed
   cloth's drag holds her sternway down, which is what makes the reversed
   blade bite. But it means the model still does not reward the combination
   a real crew uses.
2. **The drift case at 44 s.** S4 already flagged it as an artefact — rigid
   cloth cannot flog, so eased sheets act like small set sails — and the
   aback branch makes that artefact *stronger*, because her flat-sheeted
   cloth is now pressed on its other face instead of idling at `cdLuffing`.
   44 s is a plausible time for a real ship to fall off unaided, so the
   number is not absurd; it is reached partly for a modelling-convenience
   reason. The fix is flogging forces, deferred since v1.

### The voyage (S6), re-priced

| | before | after |
|---|---|---|
| upwind beat, 4 km dead to windward | arrived 644 s, 57 m to go | **arrived 867 s, 131 m to go** |
| boards | 3 ordered / 3 completed / 0 failed | **3 / 3 / 0** |
| track efficiency | 0.516 | **0.521** |
| mean speed | 2.37 m/s | **1.71 m/s** |
| downwind passage | 348 s, efficiency 0.866 | **355 s, efficiency 0.865** |
| the same beat at 30× | 654 s, 1123 m to go, efficiency 0.526 | **1095 s, 2101 m to go, efficiency 0.453** |
| `cannot draw` response | 4.0 s | **4.0 s** |
| compression ground ratio | 30.000000002 | **29.999999975** |

**The beat takes 35% longer and she still gets there, with the same number
of boards and the same efficiency.** That is the most reassuring number in
the round: the *shape* of her beating is unchanged, the pace of it is
honest. The 30× case degraded more (efficiency 0.526 → 0.453) because an
evolution now costs more chart at the same compression — the two-clocks
consequence the S6 handover already named, made larger by a slower ship.

### The rest of the evidence

- **`straight-line-baseline.json`** — the frozen-trim captive sweep. Best
  drive **5385 N at −75° → 3808 N at −90°** (the same aftward migration the
  polar shows), dead ahead **−1665 N → −7371 N** (head to wind under full
  sail she is now blown astern four times as hard, because her sheeted
  cloth is *pressed* aback instead of idling), gust free run **1.87 →
  3.05 m/s**. That last one is faster because the free ship no longer rounds
  up: she ended the old run at −46° of yaw and ends the new one at −10°.
  **Weather helm is much weaker under the honest coefficients** — the
  low-aspect mainsail aft loses lift to induced drag faster than the
  high-aspect headsails forward do. Worth an eye on the water.
- **`turn-baseline.json`** — **byte-identical**. Turn circles are sailed
  under bare poles, so nothing in this round could touch them, and it is a
  good null result to have.
- **Weather helm halved, and this is a feel change.** In the polar's own
  column at 12 m/s FULL_SAIL the beam balance rudder went **3.01° → 1.37°**;
  at 8 m/s the beam point is ±0.27° either side of zero, which is one
  bisection quantum and means "neutral" both before and after. Mechanism:
  the low-aspect mainsail **aft** gives up more lift to induced drag than
  the high-aspect headsails **forward** do, so the centre of effort walks
  forward. She is still weather-helmed where it resolves, and much less so.
- **`crew-baseline.json` — the helmsman steers WORSE in a seaway and better
  in calm.** Calm compass hold RMS **1.13° → 1.08°**, interventions
  **3.7 → 2.0/min**, longest unchanged target **40.4 → 49.2 s** (weaker
  weather helm gives him less to fight). `CURRENT_MODERATE` RMS
  **1.46° → 2.54°**, interventions **10.7 → 12.3/min**, longest unchanged
  target **30.5 → 9.3 s**. Rudder force goes as inflow squared and she is
  slower, so in waves he has less blade and works it harder. Still inside
  the accuracy band, and the biggest single behavioural regression in the
  round after the tack.
- **The trimmers are worth less as a fraction and the same in metres.** A
  badly set rig nobody touches: **3.11 → 2.91 m/s** absolute, but the ideal
  it is scored against fell further (3.65 → 3.22), so
  `untrimmedPolarFraction` **rose** 0.850 → 0.904 and the crew's recovery
  reads 0.904 → 0.980 where it used to read 0.850 → 0.961. They recover
  more of a smaller gap.
- **`helm-baseline.json`** — regenerated; the canvas-balance study moves
  with the same forward walk of the centre of effort.
- **The opening voyage now starts 3.1° under-sheeted.** The authored fan
  (26° main easing to 37° flying jib) is a sail plan and this round did not
  touch it; the polar's beam schedule moved under it — 90° full-sail mean
  28.5° → 33.5° at 4 m/s and 35.4° → 37.1° at 8, which interpolates to
  32.0° → 35.1° at the production wind against the fan's fixed 32.0°. Three
  degrees of boom is not a visible mis-set, so the fan stays and the test's
  tolerance widened from 2° to 4° with the reason written into it. Easing
  the fan to the new schedule changes the drawn rig at scene open and is
  Ash's call.
- **No new evidence file, so the `.gitignore` allowlist needed no change.**
  The fifth polar sheet lives inside `polar-baseline.json`, which is
  already allowlisted.
- **Per-sail coefficients are now in the evidence.** `SailBreakdownEntry`
  carries `aspectRatioEff`, `camberDrawn`, `liftCoefficient` (negative when
  aback), `dragCoefficient` and `inducedDragCoefficient` for every sail at
  every point. The world-lighting round's per-term-views lesson: an
  aggregate drive number cannot tell you whether a sail is paying for its
  lift, carrying it backwards, or simply not making any — and on one
  close-hauled point all three happen at once.

### Which gates moved, and why

| gate | before | after | why |
|---|---|---|---|
| polar `formatVersion` | 3 | 4 | model re-priced, file shape changed |
| polar `minSpeedDeltaVsFrozenMps` | ≥ −0.05 | **removed** | equal-or-better is the wrong question for a round whose point is that the old numbers were too fast. Replaced by a printed comparison |
| polar `maxLeewayDeg` / `maxAbsBalanceRudderDeg` | all points | **sailing sector only** | intent survives, scope had to move; a crab at 45° is a measurement, not a violation |
| polar `closeHauledAngleDeg` | — | **new, gated 45–75°** | the pointing limit is a property of the aerodynamics now, so it is gated in both directions |
| polar `sailingSectorLeewaySaturated` | — | **new, must be false** | a saturated leeway inside the sector is the solver reporting its box |
| tack `classicTackCompletesAtAnyEntry` | true | **false, asserted** | intent is now wrong: see the decomposition. The script is stale, and `voyage-baseline.json` is the counter-evidence in the same commit |
| tack `captureAngleBandDeg` | must be null | **must be 10–42°** | reversal of the same gate |
| tack `minSpeedMps` | > 0.5 | **> 0.05** | number moved: she is genuinely slower everywhere, the beam entry touches 0.19 m/s. Zero would still be a dead stop |
| tack `eyeCrossSpeedBandMps` | ungated | **new, 0.8–2.5 m/s** | the half of S4's win that survived, now defended explicitly |
| irons `ironsBackedHeadsailAloneEscapes` | must be false | **must be true** | FINDING S4-2 closed, exactly as S4's gate asked in writing |
| irons `ironsDriftPayOffS` | > 150 s | **> 20 s** | she is no longer stuck for minutes; the gate now asserts she is caught at all |
| irons `ironsTowardSheetsAttractorDeg` | must be non-null | **must be null** | the attractor is gone |
| polar test: beam `balanceRudderDeg > 0` | sign-gated | **\|helm\| < 0.6° at 8 m/s, 0.5–3.0° at 12 m/s** | the 8 m/s beam value is ±0.27°, one bisection quantum — it was never a resolvable sign. Moved onto the 12 m/s point, which is |
| crew test: `untrimmedPolarFraction` | < 0.90 | **< 0.92** | the denominator moved: she is 9.6% slow untouched instead of 15%, because the ideal came down faster than she did |
| opening-voyage test: beam trim mean | within 2° | **within 4°** | the authored fan is a sail plan and did not move; the polar's beam schedule moved 3.1° under it |
| steering test: `classicTackCompletesAtAnyEntry` | true | **false, with the reason and the counter-evidence in the assertion** | same reversal as the exporter gate |
| steering test: `ironsDriftPayOffS > 150` | stuck for minutes | **> 20 s** | she is not stuck any more; the gate now asserts she was caught at all |
| steering test: `ironsBackedHeadsailAloneEscapes` | false | **true** | FINDING S4-2 closed |
| steering test: `ironsTowardSheetsAttractorDeg` | non-null, 10–45° | **null, and the slow way round is gated slower** | the attractor is gone |

### New tests, so the round defends itself

`tests/ship-sailing-aero.test.ts` gained eight cases for the coefficient
block: the aspect ratio's two image limits and its monotonicity in the gap;
that the gaff sails and the square topsail come out low-aspect **from the
rig's geometry** rather than by assertion; that `CDi` is quadratic in CL,
inverse in AR, free at zero lift and sign-blind; that the drawing and aback
branches hand over through a band carrying neither; that CLmax falls as a
sheet is hardened and the centreline ramp takes it to zero; that a backed
sail reads negative lift, negative camber and pressed drag; and that handing
the square topsail close-hauled *increases* total drive.

One of them is the architectural pin and matters most: **the loft and the
coefficient must produce one camber, not two that agree.** It drives
`rigGeometry.sailLoftLive` and `sailAero.sailShapeCamber` at the same trim
and asserts the drawn draft reduces to the exported shape camber to twelve
digits, drawing and aback. That is M6 §11.4's lesson (two copies of the
belly normal, agreeing only because someone kept them agreeing) applied
before the same fault could happen twice.

### Findings (rule 8 — surfaced in full, not fixed here)

1. **`options.canvas` is dead for every scripted evidence run.** `runSailCase`
   sets `sails.canvas`, but the moment a script calls `attachControls` the
   stepper reads the live control surface and ignores it — and
   `new SailingControls()` starts every sail *set*. The tack, gybe and irons
   cases all pass `canvas: FULL_SAIL` and it is coincidence that this is
   what the controls default to. Found while trying to run a tack with the
   topsail handed and getting bit-identical numbers. Not fixed: the fix is
   an initial set-state argument on `SailingControls`, which is the crew
   module's business.
2. **An aback sail still reports `luffing: true`.** `PerSailForce.luffing`
   is `sailLuffFactor(aoa) < 0.5`, so a sail full of wind on its wrong face
   is indistinguishable from a shaking rag. Consequences: it casts no
   blanket shadow (the blanketing pass skips luffing sails), and the crew's
   `fullness` observation calls it 'empty'. Deliberately untouched — the
   word is read by the cloth, the crew, the HUD and the evidence, and
   changing its meaning is a vocabulary change across four consumers.
3. **The flying jib is the largest of the three headsails** — 22.2 m²
   against the jib's 16.3 and the staysail's 11.6. Every family aboard has
   it the other way round. Noticed while tabulating spans and areas for the
   aspect ratios; it is a sail-plan question, not a coefficient one.
4. **`SHIP_RIG_HANDOVER` §1's sail-area table is still stale** — M6 finding
   5, re-confirmed by this round's measurements (mainsail 57.6 m² against
   the table's 60.8, gaff topsail 15.5 against 11.5).
5. **The polar's trim schedule has no rule for handing a sail.**
   `trimToDrawDeg` sheets every sail to the lift peak clamped at its stops,
   and a square topsail close-hauled clamps to "still 65° aback". A real
   trimmer's answer at that point is to furl it. The `BEATING_SAIL` sheet
   works around this rather than fixing it; a schedule that could hand a
   sail would make the FULL_SAIL sheet mean what a reader expects it to.
6. **The polar module's header comment claimed "no live trim (S4)"** and had
   been untrue since the round it named. Corrected.

### What is owed to Ash's eye — THIS IS THE ROUND'S ASK

Nothing here certifies that she sails *better*, only that she sails
*honestly*. The polar A/B above is one glance; these are the things to feel:

1. **Beat her, with and without the square topsail.** This is the single
   biggest change and it is now a decision with a real cost on both sides:
   handed, she points 45° instead of 60° and gains over a metre a second
   close-hauled; carried, she is faster from 150° aft. Does having to make
   that choice feel like seamanship or like an annoyance?
2. **Is she too slow upwind now?** 45° went from 2.70 to 1.03 m/s at 8 m/s
   under full sail. The physics says a gaff schooner carrying a backed
   square sail should be dreadful there. The game question is different
   from the physics question, and only Ash can answer it.
3. **Her best point of sail moved from 90° to 105° on every sheet.** A
   broad reach is now her fastest, not a beam reach. That should be
   *felt* — bear away from a beam reach and she should come alive.
4. **Weather helm is much weaker.** The free ship in gusts used to round up
   to 46° and stop; she now holds within 10° and keeps sailing. That is a
   large change to how she feels on the tiller and it was not designed —
   it fell out of the coefficients.
5. **She heels about a degree more everywhere**, and in 16 m/s under sheets
   alone she settles at 27.5°. That is outside the 15–25° working band by
   design (nobody is shortening sail in that arm), but it is worth seeing.
6. **A tack.** The scripted harness no longer completes one; the crew do.
   Sail a tack from the deck and see which is true of the ship you are on.

### Not verified here

- **No performance measurement of any kind.** The machine was thermally
  throttled throughout. The induced term adds one multiply and one divide
  per sail per substep, the aback branch one extra `sailLiftCoefficient`
  call on sails at negative AoA, and the live aspect ratio one pass over
  three or four corners — all in a loop that already re-derives the whole
  cloth geometry. The prediction is that it is unmeasurable against
  `deriveLiveVariants`, and the prediction is worth nothing until a cold
  machine says so.
- **The Glauert span-efficiency solve** (see `e = 0.85` above).
- **The tack harness's own repair**: ease when the cloth fills rather than
  at a fixed 42°, and carry the crew's stern-board. Measured to be the
  reason the scripted tack fails where the crewed one succeeds; deliberately
  left to whoever owns the maneuver script, with the decomposition above as
  the brief.

### Reproducing the evidence

```
npm run ship:polar           # ~20 min; prints the before/after table itself
npm run ship:tack            # tack, gybe, five irons cases
npm run ship:sailing         # the frozen-trim captive sweep
npm run ship:voyage          # ~9 min; the S6 beat, re-priced
npm run ship:turn            # byte-identical (bare poles)
npm run ship:helm ; npm run ship:crew
npm test ; npm run test:slow:sailing ; npm run build
```
