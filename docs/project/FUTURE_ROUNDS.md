# Rounds: done and deferred

Reviewed against the code on 2026-08-16 at master `63308dc`. Before this pass
the file still described the raft as the vessel and the schooner as "planned and
specified, not started"; that had been false for weeks. If you are reading this
after another few rounds have landed, check it again — this document is a claim
about the code, and claims rot.

## Completed

**Planetary world model.** Canonical WGS84 state, accelerated UTC, ellipsoidal
geodesic travel, parallel-transported tangent frame, real Sun, Moon and bright
stars. See `docs/world/WORLD_MODEL.md` and
`docs/adr/ADR-002-planetary-world-model.md`.

**Raft/water coupling.** Distributed 24-station force-based buoyancy at a fixed
240 Hz, Gerstner inverse horizontal-displacement sampling, orbital water
velocity, exact CPU/GPU temporal parity, and the `?debug=buoyancy` verification
harness. See `docs/ocean/RAFT_WATER_COUPLING_SPEC.md` and
`docs/ocean/RAFT_WATER_COUPLING_REPORT.md`. The raft itself is now an opt-in
legacy diagnostic vessel; the schooner is the production ship.

**Open-ocean sea states and whitewater.** A spectral sea-state model — wind sea
from fetch-limited JONSWAP growth, independent primary and secondary swell,
equal-m₁ discretisation into 48 Gerstner components — with whitecaps calibrated
against Monahan coverage, a persistent foam field indexed in Gerstner parameter
space, wind-torn spindrift, and a discoverable developer-tools launcher with an
ocean laboratory. See `docs/ocean/OCEAN_SEA_STATE_SPEC.md`,
`docs/ocean/OCEAN_SEA_STATE_REPORT.md` and
`docs/ocean/OCEAN_ARCHITECTURE_AUDIT.md`.

**Multi-scale cinematic and embodied camera.** Two modes over one camera: a
cinematic camera that climbs as it retreats, from 12 m out and 2 m up to 1400 m
out and 267 m up on a single authored line, holding the horizon a third of the
way down the frame at every scale; and an embodied camera at the observer's
eyes, with a full turn of yaw, the zenith reachable, physical sail occlusion,
and a head model that takes the hull's heave nearly whole while cutting its roll
to a tenth. Manual switching only, over a straight run of 0.7–1.4 s. See
`docs/camera/CAMERA_SYSTEM.md` and `docs/camera/CAMERA_ROUND_REPORT.md`.

**The expedition schooner, built and walkable.** The raft is replaced by a
15.5 m two-masted topsail schooner. Landed, in build order: hull form and
hydrostatics generalised from circular-segment cylinders to clipped hull
stations (M1); the rig, its standing and running gear and the sail plan (M2);
the walkable weather deck, its fittings and the deck walker (M3); and below
decks (M4) — five spaces standing and walkable, the hold and its stow, the pump
shaft and well, the fore scuttle, a closure table that four systems read, the
portal/room daylight model, five interior lamps as real lights, and the
captain's quarters with berth, lockers, panelling, chronometer and a working
desk you can sit at. The player walks in ship-local space, so the ship's own
frame carries the motion. See `docs/ship/SHIP_SPEC.md` for the canonical vessel,
`docs/ship/SHIP_ROUND_HANDOVER.md` for the build order and gates, and the rig,
deck, interior, quarters, desk, furniture-rotation and night-lighting handovers
beside them.

**She sails.** Rounds S1–S5 of the sailing project are merged: world wind with a
deterministic gust process; per-sail aerodynamics at real centres of effort
driving the hull through an external-wrench seam; rudder lift and a tiller on
the same rate limits the crew use; live trim, a moving rig and a classic tack
that completes; and the crew's invisible hands — six trimmer stations, a
helmsman who holds a course, and a dogvane the helm can steer by. See
`docs/sailing/SAILING_MODEL_DESIGN.md`, `docs/sailing/SAILING_PROJECT_PLAN.md`
and `docs/sailing/SAILING_ROUND_HANDOVER.md`.

**Wake and ship–sea interaction.** WK0 through WK-R13: bow pressure front, stern
and transom wake, a foam field the hull writes into, hull wet band, and a review
thread that repaired a long list of registration faults. The wake stays strictly
one-way — nothing is written back to the wave field, buoyancy or any physics
surface, and that is pinned by test. See `docs/wake/WAKE_WATER_DESIGN.md` and
`docs/wake/WAKE_WATER_HANDOVER.md`.

**Light, colour and sky.** A world lighting model with per-term diagnostic
views; a hue-preserving tone curve that replaced the ACES "instagram filter"; a
sun shadow pass with variable penumbra and hull sky-occlusion; a marched 3D
cloud field with altitude decks, a cirrus deck, a world-time cloud clock and a
tile cache; a real night sky; and an ocean look round that derived the water's
body radiance chain and reshaped its detail spectrum. See `docs/graphics/` and
`docs/clouds/`.

**A player-facing interface.** The HUD lives behind a pill with five pages and a
compass rose; the developer shell is gated behind `?debug`; the voyage the page
opens in is derived from the sea rather than authored.

**Terrain, R0 and R1.** A tile system with anchored synthetic land and distance
haze, and a settled depth decision: reversed-Z is the desktop candidate where
`EXT_clip_control` exists; logarithmic depth is a compatibility fallback that is
not budget-clean. R1 has not formally exited. See
`docs/terrain/terrain-project-plan.md` and `docs/terrain/decisions/`.

## The parallel session of 2026-08-16/17

Sixteen rounds across nine streams, integrated through a staging branch. The
account of it, including the one branch that did not make it onto master, is
`docs/project/SESSION_HANDOVER_2026-08-17.md`. In summary, these moved from
deferred to built:

- **Sailing S6, the navigator** — she sails to a point, beating when she must,
  and the crew shorten sail under a canvas policy.
- **The sail coefficients** — induced drag, aback lift, and live camber. This
  re-priced every speed in the game and its verdict is Ash's.
- **Ship M6, sails alive** — the six principal sails as deformable cloth.
- **The interior finished and made usable** — wardroom and forecastle furnished,
  eleven places to sit or lie, and deadlights over the stern windows.
- **Moonlight made consequential** — a moon worth ten times what it was. The
  accompanying scotopic model was rejected by eye and now ships off; its display
  calibration is retained only for an explicit opt-in comparison.
- **Weather, a new stream** — a pressure record upstream of everything, the
  barometer, and the separation of the present wind from the sea's memory of it.
- **Sound, a new stream** — a listener and six voices derived from state that
  already existed.
- **Wake WK3** — bow-entry spray and the overtop port.
- **Tooling** — a capture instrument that cannot lie about its render tier, and
  a determinism guard that holds re-staging to the quantisation floor.

- **Ship M5, the climb aloft** — an authored climb spline with eight anchors, the
  lookout platform and lifelines, and a comfort treatment that is one derived
  term rather than a taste dial.
- **Terrain R1's code queue** — TERR-104, and a clearance query that had been
  over-reporting by up to 5 km.
- **The timber** — measured rather than assumed, which turned the round on its
  head; see the handover.

Nothing was left in flight at the checkpoint. Master carries 1717 fast tests and
27 slow, typecheck and build clean.

## Continuous follow-up of 2026-08-17

The continuous follow-up after checkpoint `c065057` adds four verified slices:

- A bounded clear/rain/storm weather MVP, including deterministic rain, lightning, delayed thunder, visibility, and wind cues.
- One coarse Natural Earth source for the globe and explicit `?terrain=global` local tiles.
- SURV0's conserved onboard-water ledger and SURV1's tributary-geometry and pure-flux foundation.
- Continuous spherical Moon presentation and tone-safe warm lamp wicks.

The integrated gate is 1,801 tests passed and 27 skipped, with typecheck and
build clean. Thunder, raft/daylight weather taste, and near-coast coarse terrain
remain in `REVIEW_QUEUE.md`.

## Deferred

Still deliberately unimplemented, with extension points left open:

- **Sailing S7, the captain aboard.** The tiller as real deck geometry you can
  take in your hands, a haul-and-ease grammar at the belaying pins, and the
  first real order surface. Its accept-when sentence is the sailing project's
  definition of done. `docs/sailing/SAILING_PROJECT_PLAN.md` §S7.
- **The climb (ship M5) and the dressing rounds after it.** An authored climb
  spline in the ship frame, the lookout platform and lifelines, and the aloft
  comfort treatment; then expedition chests, the stern lantern, the binnacle,
  weathering and LOD. `docs/ship/SHIP_ROUND_HANDOVER.md`.
- **Weather and currents.** The bounded MVP now supplies complete clear, rain,
  and storm states; its visibility drives existing ocean and terrain haze, and
  deterministic near rain, lightning, delayed thunder, and a wind cue are live.
  Still deferred:
  spatial weather and currents, evolving storm tracks, cloud type and ceiling,
  patchy key light, far rain, wet surfaces, ocean impacts, and production GPU
  evidence. Sea-state phase continuity exists, but weather maturity and the
  bigger-versus-steeper decision remain open.
- **Provisions, pay and the crew's comforts.** Three concept documents exist and
  none is accepted: the ledger-versus-hold resource core, money as a ledger and
  a port interface rather than a gauge, and morale as five channels rather than
  one bar. Their load-bearing open question is pacing, which is really a
  question about whether a voyage can ever be skipped or slept through.
- **A complete Moon model.** Phase presentation now follows continuous
  rough-sphere lighting at a deliberate 2.62× apparent size while direct
  moonlight remains physical and scotopic lifting ships off. Detailed surface
  orientation, eclipses, and sharper star presentation remain deferred.
- **Player instruments and navigation.** Local trajectory map, compass beyond
  the HUD rose, binoculars; destination selection, routing and autopilot;
  offline voyage progression from versioned snapshots. S6 and S7 take the first
  bites of this.
- **Swimming, diving, and the deep-ocean abyss.**
- **Encounters, distant objects, coastlines and islands.** A shared Natural
  Earth fallback now gives the globe recognisable land/relief and explicit
  `?terrain=global` local tiles across teleports. Synthetic remains the shipping
  default; the authored opening of the time was a city centre on land (it has
  since moved to open water in the Tasman Sea). GLO-30/WBM acquisition, production LOD,
  Gate A, and R2/R3 remain staged rather than claimed.
- **Consequences.** SURV0 now supplies a deterministic conserved onboard-water
  ledger, openings catalogue, and zero-load seam. SURV1 has tributary event
  geometry and a pure provisional flux resolver, but production still discards
  event water. Routing, scuppers, deck flow, presentation, motion coupling,
  pumping, capsize, and sinking remain open; the ±0.7-radian limiter still makes
  capsize impossible by construction.
- **Automatic idle and watch cameras.** The manual toggle is the only way modes
  change, and `CameraSystem.setMode` is the single hook a watch mode would
  drive.
- **A first-person body.** The observer is culled whole whenever the camera is
  within 1.15 m of their head, which is the documented compromise in place of
  building hands and a torso the embodied camera could look down at.
- **A materials and textures pass**, beyond the first round. The timber round of
  2026-08-17 re-derived the roughnesses under the light that actually exists —
  they had been fitted against a sky probe of a third the strength the ship now
  reflects — and put procedural variation behind `?timber=`, default off. What
  it did *not* do is settle whether any of it is wanted; that is in the review
  queue, with the correction and the taste deliberately kept apart.

Future geographic and environment systems should sample canonical ECEF position
and UTC. Future controls should alter tangent velocity or acceleration through
the world model rather than create a parallel local travel simulation. Future
ocean work should go through the sea state rather than reaching into the wave
field: `WaveField` owns evaluation and phase, and deliberately does not decide
what the sea is.
