# Sailing — project plan

**Status: S1–S6 BUILT (2026-08-05 → 2026-08-17). S7 not started.** Each round
section below carries its own status line, and
`docs/sailing/SAILING_ROUND_HANDOVER.md` carries the implementation truth. The
body of this plan is still the 2026-08-05 draft and is deliberately left as
written, so that what was planned can be read against what was built — only the
status lines are maintained. Read the design doc first; this document only
sequences it. `docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` describes the physics
substrate each round builds on.

Seven rounds, S1–S7. Each is a self-contained checkpoint in the established
style: headless evidence + deterministic gates first, Ash's eyes before merge,
a handover note at the end. S1–S3 are pure physics and are written to be safe
to hand to an implementation model cold; S4 touches the rig loft; S5–S6 are
control logic; S7 is UX and needs Ash in the loop throughout.

---

## 0. Rules for every round (implementer briefing)

An implementation session starting cold reads, in order:
`docs/sailing/SAILING_MODEL_DESIGN.md` → this file's round section → the file-map row it
touches → the handover of the round before it. `docs/ship/SHIP_SPEC.md` §2/§7 for the
vessel; `docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` §9 for the physics file map.

Non-negotiables, all of them enforced or checked today:

1. **Run `npm test` before touching anything**; do not trust stale test counts
   in docs. Regenerate evidence (`npm run ship:response`, `ship:resistance`,
   `ship:dynamics`, plus this project's new exporters) only when your change
   intends it, and commit changed evidence *with* the code that changed it.
2. **Do not touch** hull coefficients, GM, roll/pitch damping, the mass model
   (`massModel.ts` — its disagreement with drawn spar mass is Ash's standing
   call), the wave field, or sea presets — unless the round explicitly says so.
3. **Controls never enter `CanonicalWorldState`.** Vessel-control state only.
4. **No second geometry.** Areas, centres of effort, lever arms, rudder
   geometry: derived from `rig.ts` / `backbone.ts` / `hullForm.ts` at module
   load, like `SCHOONER_RESISTANCE_GEOMETRY` already is.
5. **Determinism.** Seeded processes only; no `Date.now()`/`Math.random()` in
   anything evidence touches. Fixed 240 Hz substep; caller-rate invariance is
   a gate in every round that adds force.
6. **Signs are set by test, not by reasoning.** Wind direction, sail `side`,
   tiller sign, weather-helm sign: each gets a pinned test the day it is born.
   This codebase has burned a full round on each of two sign conventions
   already (`docs/ship/SHIP_RIG_HANDOVER.md` §4).
7. **Anything visible needs Ash.** "Pixel-identical" is the only
   self-certifiable visual claim. If a round changes what the ship looks like
   (S4, S7), plan an A/B checkpoint with Ash before merge.
8. **Surface findings in full.** Anything found along the way that is wrong or
   suspicious gets reported in the round handover even if out of scope — Ash
   decides scope, not the implementer.

Known adjacent debt, *not* to be silently fixed in passing (report if touched):
the hint line still says "Space for the sail" wired to the raft's binary sail;
`Vessel.updateTrimPickTargets` is a raft-only stub; the tiller does not exist
as deck geometry (S7 builds it).

---

## S1 — World wind

**Status: IMPLEMENTED 2026-08-05 — see `docs/sailing/SAILING_ROUND_HANDOVER.md` §S1.
Finding W1 (body-label/compass chirality) was RESOLVED the same day by the
side-label relabel: model +x = port, positive yaw = turn to port; `hullForm.ts`
is the authority.**

**Goal:** one wind authority, queryable by physics, with gusts; conventions
pinned.

**Build**
- `WorldWind`: mean true wind from the active sea preset; seeded OU-style gust
  process on speed + slow direction wander, driven by preset `gustiness`
  (design §4.1). Advances on ordinary physics seconds.
- Convention audit and helpers: one documented direction convention, explicit
  conversions to/from presentation heading and model yaw; the trap that model
  yaw 0 = presentation heading 180° gets a helper and a test, not a comment.
- `WindSystem` and every current wind consumer (spectrum, foam, spray, sky,
  ambience, raft) re-pointed at `WorldWind` values with **zero behavioural
  change** at zero gust amplitude.
- Apparent-wind pure functions (point velocity in, apparent vector out).
- Dev readout in the existing debug panel: true wind, apparent wind at deck,
  gust state.

**Evidence & gates:** deterministic gust-trace JSON (same seed → identical
trace; mean/variance match the preset within tolerance; mean reversion
timescale in band). Convention test pinning wind-toward-+x to a named point of
sail. Full existing suite green; with gusts amplitude-zeroed, frame output of
current consumers unchanged.

**Risk:** low. **Size:** small. The convention audit is the actual work; the
gust filter is twenty lines.

---

## S2 — Sail forces at fixed trim

**Status: IMPLEMENTED 2026-08-06 in two halves — see `docs/sailing/SAILING_ROUND_HANDOVER.md`
§S2a and §S2b. The sanctioned split was taken: 2a = aero + wrench seam +
straight-line gates + energy accounting; 2b = horizontal added mass +
`ship:polar` + the heel/speed gates, which passed on the provisional
coefficients without tuning. The polar is a captive force-balance polar at
frozen trim (no rudder, zero leeway) — S3 and S4 regenerate it as those DOF
arrive. ACCEPTED by Ash 2026-08-06: live beam-reach release, gathered way to
the polar's speed, weather helm observed, head-to-wind luffed her dead.**

**Goal:** wind pushes the ship through real sails; the polar exists. Controls
do not exist yet — trim is frozen at authored test values, sails set/furled by
configuration.

**Build**
- `sailAero.ts`: per-sail geometry derivation (area, CoE, chord from `rig.ts`
  corners + camber — promote the area maths currently living only in
  `tests/ship-rig.test.ts`), lift/drag curves per sail type, luffing collapse,
  reef area/CoE factors, bare-pole windage lump, crude blanketing factor
  (design §6.1).
- The wrench split (design §6.2): `BuoyantBody` external force/torque seam
  (generic, zero-default); horizontal components + yaw moment summed beside
  resistance in `SchoonerHorizontalDynamics`.
- Horizontal added mass (design §6.4) — surge/sway/yaw constants, passive
  evidence regenerated in the same commit.
- Wind-work tracking and the generalised energy gate (design §6.5).
- Per-sail force breakdown in evidence output and dev readout.

**Evidence & gates:** `ship:polar` (design §9) — the round's deliverable.
Gates: no-go zone dead; reach fastest; hull-speed bound (~4.7 m/s, stated
surfing allowance); port/starboard polar symmetry; steady heel under full sail
at 12 m/s in the 15–25° band; zero-sail/zero-wind runs bit-identical to
passive baselines; energy gate through gust transients; caller-rate and
voyage-separation invariance with sails drawing.

**Accept when:** the polar is committed and gated, per-sail forces are
individually inspectable, and a captive-free ship on a beam reach in
`CURRENT_MODERATE` accelerates, heels and settles at a believable speed under
Ash's eyes (live smoke test — the tow harness is how you set the scene, then
release).

**Risks:** sign errors (mitigated by S1 conventions + per-sail evidence);
tuning rabbit-holes — the round tunes to the stated gates only, polish waits
for S3's rudder so bias isn't hidden by a missing DOF. **Size:** the big one.
Split candidate if needed: 2a aero + wrench seam with straight-line gates, 2b
polar + added mass + tuning.

---

## S3 — Rudder and helm

**Status: IMPLEMENTED 2026-08-06 — see `docs/sailing/SAILING_ROUND_HANDOVER.md`
§S3. ACCEPTED by Ash: he steered her through a tack from the dev panel. The
round's own FINDING S3 — that the frozen trim cannot tack, and she wears
instead — was carried into S4 and closed there.**

**Goal:** commanded steering; the ship turns, tacks and gybes under force.

**Build**
- Rudder deflection input threaded through `SchoonerResistanceInput`; lift +
  stall + induced drag on the existing blade geometry and inflow contract
  (design §6.3; mind the yaw-rate-at-the-blade gotcha, added once). δ=0
  reproduces today's passive terms exactly.
- Tiller angle in a minimal first `SailingControls` (just the helm, with rate
  limit) + dev-panel slider.
- Retire captive-tow *heading* as the ordinary steering path (it remains a
  diagnostic; the debug panel gains "release to helm").

**Evidence & gates:** `ship:turn`, `ship:tack`, `ship:helm` (design §9).
Turn-circle mirror reciprocity; radius vs angle monotonic; no turn at zero
speed; tack success/failure envelope asserted both ways; weather-helm sign and
few-degree magnitude; sternway steering sign correct.

**Accept when:** with S2 sails at fixed trim, Ash can steer her through a tack
from the dev panel and it reads as an event — way carried through the eye of
the wind, sails luffing then filling (flags only; visuals still frozen), speed
rebuilt on the new tack.

**Risks:** rudder authority vs the provisional lateral coefficients may need
joint retuning with S2's added mass — expected, do it against the gates.
**Size:** medium.

---

## S4 — Rig state, trim, and the moving rig

**Status: IMPLEMENTED 2026-08-07, reviewed and corrected twice on 2026-08-08 —
see `docs/sailing/SAILING_ROUND_HANDOVER.md` §S4 and the two review passes after
it. Four faults were found by Ash's eye after the gates were green (a sail that
came down without its gaff, a rig that moved in steps, a furl that became a
cylinder, and the crew being charged to the wrong clock); all four are fixed and
recorded there.**

**Goal:** the full control surface exists and the drawn rig follows it. After
this round the ship is *manually sailable* end to end from the dev panel.

**Build**
- Full `SailingControls` per design §5: per-sail set states and trims, signed
  headsail sheets, slaved gaff topsail, actuation-rate limiter table (one
  place), tack-side handling.
- Trim constants in `rig.ts` become functions of control state; incremental
  rig re-loft with a measured rebuild budget; mirrored sheet leads for the
  port tack; reefed/furled visual states (honest placeholder bundles).
- Aero consumes live trim (S2's frozen trims become the test fixtures).
- Trim-envelope intersection sweep added to the rig test suite (design §8).
- Dev panel: per-sail controls + set-state buttons.

**Evidence & gates:** rig tests green **across the trim envelope and both
tacks** (intersections, pin-per-rope, rope-path, belly-to-leeward with the
tack-dependent sign); polar regenerated at live-trim best settings and equal or
better than S2's fixed-trim polar; rebuild cost within budget; actuation-rate
determinism (command trace → identical state trace).

**Accept when:** Ash sails a beat, a reach and a gybe from the dev panel, sails
visibly swinging and reefing, both tacks drawing correctly — and signs off the
placeholder furl visuals as acceptable-for-now (explicit A/B checkpoint, rule 7).

**Risks:** the re-loft is where the rig round's invisible-fault lessons bite
hardest — the trim-envelope test sweep is the defence and is **not optional**;
placeholder furls are a look decision that must not be self-certified.
**Size:** medium-large, the most cross-cutting round.

---

## S5 — The crew's hands (standing orders)

**Status: BUILT AND GATED 2026-08-15, AWAITING ASH'S LIVE REVIEW.**
The compass-course helm was accepted 2026-08-11 (steps 1–5) and re-confirmed
by Ash 2026-08-15. Steps 6–8 — apparent-wind steering through a dogvane cue,
the six trimmer stations, and the shared `trim to draw` order — are now built,
evidenced and gated. What remains is the acceptance sitting itself: headless
evidence proves the contract and the bounds, and cannot certify that the hands
read as human. See `docs/sailing/SAILING_ROUND_HANDOVER.md` §S5 trimmers for
implementation truth, the measured numbers and five findings.

**Implementation authority:** before writing S5 code, read
`docs/sailing/SAILING_S5_HUMAN_CREW_HANDOVER.md`. Its approved
truth → instrument/cue → perception → human decision → control contract
supersedes any reading of the bullets below that would give crew exact
simulation telemetry or continuous autopilot behaviour.

**Goal:** tier 1 — helmsman and trimmers. "Steer 240", "trim to draw", and the
ship holds course and stays powered without the player touching anything.

**Build**
- `Helmsman`: course-hold and apparent-wind-angle-hold, human-shaped (deadband,
  yaw-rate anticipation, rate-limited tiller through the same `SailingControls`
  path as the player — invariant 2).
- `Trimmers`: per-sail target-AoA policy, ease-when-overpowered on a heel
  threshold, luffing report.
- Order API (plain calls; no UI yet) + dev-panel order buttons.

**Evidence & gates:** course-hold RMS error bands per sea state (calm ≤ ~2°,
`CURRENT_MODERATE` ≤ ~5°, rough documented-not-gated); no control written
faster than player rate limits (asserted structurally); trimmed polar ≥ a
stated fraction of the S4 best-trim polar across the sailable arc; gust script
→ trimmers ease and heel stays bounded.

**Accept when:** Ash orders a course across `CURRENT_MODERATE` and watches her
hold it for minutes, tiller and sheets moving at crew pace, without a single
direct control input — and takes the helm mid-run with zero mode switch (the
helmsman just stops writing when overridden; who-has-the-conn is a plain rule
decided this round: player input wins, standing order resumes on release).

**Risks:** controller tuning in a seaway (the response matrix says yaw
disturbance is real); resist the urge to make the helmsman perfect — the gates
have upper *and* lower bounds on liveliness. **Size:** medium.

---

## S6 — The navigator (sail to a point)

**Status: BUILT AND GATED 2026-08-17, AWAITING ASH'S LIVE REVIEW.** The
navigator, the canvas policy, tack and gybe as crewed sequences, and the
`sail to (lat, lon)` order all exist and are gated headlessly by
`npm run ship:voyage` against `evidence/ship-sailing/voyage-baseline.json`.
Both of S5's outstanding debts are closed: the canvas policy can now actually
reduce driving sail (measured heel relief in 16 m/s), and the square topsail's
`cannot draw` report is acted on rather than ignored. What headless evidence
cannot do is the accept-when below — a pin dropped upwind and watched from the
deck — so that verdict is still owed. See
`docs/sailing/SAILING_ROUND_HANDOVER.md` §S6 for implementation truth, the
measured numbers and the findings.

**Goal:** tier 2 — waypoint sailing with beating, evolutions as crewed
sequences, canvas policy.

**Build**
- `Navigator`: direct-course vs beat decision, fixed-length tack legs (no
  laylines yet), tack/gybe sequences with entry-speed check and in-irons
  recovery, arrival criterion.
- Canvas policy table (design §7 tier 2) driving make/shorten-sail sequences
  through the trimmers.
- Order API: "sail to (lat, lon)" against the canonical geodetic position;
  works under 30× voyage compression by construction (all control runs on
  ordinary seconds; only geodesic displacement compresses — assert this).

**Evidence & gates:** scripted voyages in JSON — upwind destination reached
within a distance-made-good bound and a bounded tack count; downwind voyage
gybes rather than tacks; wind-band sweep shows the canvas policy shortening
sail monotonically; a voyage replay is deterministic.

**Accept when:** Ash drops a pin upwind in `WIND_CHOP`, orders "sail there",
and the ship beats to it — tacking, reefing when the preset says she should —
while he stands on deck and watches the crew's invisible hands work her.

**Risks:** tack-failure edge cases in rough presets (the recovery behaviour is
the deliverable, not an error path); scope creep toward route optimisation —
fixed legs are enough for v1. **Size:** medium.

---

## S7 — The captain aboard (player controls and UI)

**Goal:** the player-facing layer: take the tiller with your hands, haul a
sheet at its pin, give orders without opening a dev panel.

**Build**
- The tiller as real deck geometry with its arc (M3's unbuilt fitting),
  grabbable from the walker; a helm "use" interaction that maps player input to
  tiller angle through the same rate limits.
- Line interaction at the belaying points that already exist as walker-collidable
  geometry: minimal grammar (approach a pin → prompt → hold to haul/ease that
  sail's control). Grammar prototyped *with* Ash early in the round (design §11).
- Captain's order surface: a minimal map/compass overlay to set a destination
  pin and course, plus make/shorten sail orders. First real HUD in the game —
  design review with Ash is part of the round, not after it.
- Retire the raft-era "Space for the sail" hint path for the schooner.

**Evidence & gates:** thinner by nature — input→control determinism, rate-limit
equivalence (player and crew produce identical traces for identical intents),
interaction reachability (every control reachable on deck in
`CURRENT_MODERATE` motion). The real gate is play.

**Accept when:** a newbie (Ash) sails her from the deck: walks to the tiller,
takes it, feels weather helm as she rounds up when released; orders the crew to
a destination from the map and can seize any control at any moment and the crew
yields it. That sentence is the project's definition of done.

**Risks:** interaction feel on a moving deck (the walker + ship-motion
composition is untested territory for held controls); UI look is entirely
Ash-gated. **Size:** medium, but calendar-elastic — iterate with Ash.

---

## Sequencing and dependencies

```
S1 ──► S2 ──► S3 ──► S4 ──► S5 ──► S6 ──► S7
```

Strictly serial at the round level — each consumes the previous round's
contract. Within rounds, evidence builders can proceed in parallel with
implementation. If S2 runs long, split as noted in its section rather than
letting the checkpoint sprawl. Rounds map one-to-one onto implementation
sessions/worktrees in the established workflow; each ends with its evidence
committed, this file's round marked done, and a short handover appended to a
`docs/sailing/SAILING_ROUND_HANDOVER.md` started at S1.

Relation to the ship milestones: this project *is* the force half of M6
("sails alive") plus the steering half of M3's tiller; M6's cloth/flogging
visual work remains open afterwards, and the embodied-crew project slots in
after S7 driving the same `SailingControls`.

---

## What "done" means for the whole project

The ship sails from A to B under her own crew, with weather-appropriate canvas,
through real forces only — and at any moment the captain can walk to any
control the crew was using and take it, with the crew resuming when he steps
away. No captive tow, no prescribed motion, no control the player cannot reach.
