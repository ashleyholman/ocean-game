# The sailing model — design

**Status: design draft for Ash's review, 2026-08-05. Nothing here is built.**
`docs/ship/SHIP_SPEC.md` remains the authority on what the vessel is.
`docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` is the authority on the physics substrate this
builds on, and its "recommended following implementation task" (§ before Part 1)
is the direct ancestor of this document. `docs/ship/SHIP_RIG_HANDOVER.md` is the authority
on the rig. `docs/sailing/SAILING_PROJECT_PLAN.md` sequences the work.

Two scope decisions were made by Ash on 2026-08-05 and are binding for this
project:

1. **Invisible hands.** The crew exists as actuation — controls change at human
   hauling rates, ropes and spars move, but no crew bodies are drawn or
   animated. Embodied crew is a later project that will drive the same controls.
2. **Minimal geometric rig response.** Booms, gaffs and the topsail yard swing
   to their commanded trim; sails re-loft to the moved spars; set/furled states
   get a simple honest visual. Deformable cloth, flogging animation and
   picturesque furls remain the separate sails-alive round (M6 in
   `docs/ship/SHIP_ROUND_HANDOVER.md`).

---

## 1. What this project is

Make the schooner sail: wind produces force in real sails, the hull answers with
the physics that already exists, a commanded rudder steers, and a layered
control system lets the crew work the ship while the captain gives orders — or
takes any rope or the tiller personally.

The product goal, in Ash's words: **friendly controls for sailing newbies on
top, a detailed simulation underneath, and anything the crew can do the player
can do.**

Non-goals for this project (deliberately, see §10): visible crew bodies,
deformable cloth, per-line tension simulation, ocean current, evolving weather
systems, sail damage, anchoring, and any interaction of sailing with the
save/narrative layer beyond what the control state itself needs.

---

## 2. A short sailing primer

For reviewing everything below. Sailors can skip.

**True and apparent wind.** The wind the world blows is *true* wind. A moving
ship makes her own headwind, so the wind the sails actually feel — *apparent*
wind — is the vector sum of true wind minus ship velocity. Sail faster and the
apparent wind both strengthens and swings forward. Every sail decision aboard
is made against apparent wind; the sails have no way of knowing the true wind
exists.

**Sails are wings, mostly.** Except when running dead downwind (where a sail is
just a barn door dragged along), a trimmed sail is an aerofoil: air flows across
it, and it generates *lift* perpendicular to the airflow plus *drag* along it.
The useful forward component of that lift is what drives the ship. This is why
boats can sail *toward* the wind — not straight into it, but obliquely.

**Points of sail and the no-go zone.** Measured by the angle between the ship's
heading and where the wind comes from: *close-hauled* (~55–60° off the true
wind for a rig like ours — as close as she can point), *beam reach* (wind on the
side, usually fastest), *broad reach* (wind over the quarter), *run* (dead
downwind, slower than a reach). Inside roughly ±55° of the wind is the **no-go
zone**: sails cannot fill, they *luff* (flap uselessly — "flogging"), and the
ship coasts to a stop — "in irons."

**Tacking and gybing.** To go upwind you zig-zag: sail close-hauled on one
*tack* (wind over the port side = port tack), then turn the bow *through* the
wind onto the other. That turn is a **tack**: the ship must carry enough speed
to coast through the no-go zone while the sails are useless; fail and she's in
irons. Turning the stern through the wind instead is a **gybe**: the sails stay
full the whole time, but the booms slam across if not controlled — mechanically
violent, so it is done deliberately with the sheets managed.

**Heel, leeway, and the keel.** Sail force pushes sideways as well as forward.
The ship *heels* (leans away from the wind) until her righting moment balances
the sail's heeling moment, and she slides slightly sideways — *leeway* — until
the keel and hull side generate enough lateral resistance to balance the rest.
Both already have physics in this codebase: heel is the roll DOF with its
validated GM and damping; leeway is the sway DOF against the existing lateral
resistance surface.

**Weather helm.** The sails' combined centre of effort sits fore-and-aft of the
hull's centre of lateral resistance. When they don't align, the ship tries to
turn on her own — usually *into* the wind ("weather helm") — and the helmsman
holds a few degrees of rudder against it. Which sails are set moves the balance:
more canvas aft (mainsail) turns her upwind; more forward (headsails) turns her
away. Real crews steer with sail choice as much as with the rudder. Our model
gets this for free from per-sail centres of effort.

**Reefing and shortening sail.** More wind does not mean more speed forever:
past a point the extra canvas just heels her over and buries the rail. The crew
*shortens sail* — strikes the light sails, then ties down a *reef* to shrink the
big gaff sails. A well-handled ship in strong wind carries less canvas, not
more.

**This rig specifically** (see `docs/ship/SHIP_SPEC.md` §7): a topsail schooner. Two gaff
sails on booms (mainsail, foresail) are the workhorses — trimmed by *sheets*,
hoisted by paired *throat and peak halyards*, reefable. Three triangular
headsails on stays forward (fore staysail, jib, flying jib) — hoisted on
halyards, trimmed by port/starboard sheets, struck early in weather. One
*square* topsail on the foremast — the only sail trimmed by rotating its yard
with *braces*; good off the wind, first in when beating. Two light fair-weather
sails (main gaff topsail, fisherman) that are simply set or struck; the gaff
topsail is bound to the mainsail's trim by spec.

---

## 3. Design invariants

These outrank every detail below, and every round in the plan must preserve
them:

1. **Forces move the ship; commands never do.** Sail and rudder forces are the
   only new way the vessel gains momentum. The captive tow remains exactly what
   it is today: a diagnostic harness, never a gameplay path.
2. **One control surface.** Crew tiers and player input write to the same
   vessel-control state through the same actuation-rate limits. There is no
   crew-only channel and no player-only channel. This is the "anything the crew
   can do, the player can do" requirement made structural — and testable: the
   crew tier's output is valid iff it could have been produced by a player.
3. **Controls live in vessel-control state**, never in `CanonicalWorldState`
   (`docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` guardrail). Canonical state remains
   position, velocity, transported frame, astronomy.
4. **One geometry truth.** Sail areas, centres of effort and rudder geometry are
   *derived* from `rig.ts` / `backbone.ts`, never re-declared. The rig round's
   hardest-won lesson (`docs/ship/SHIP_RIG_HANDOVER.md` §3) was that a second description
   of the ship is a fault generator.
5. **Existing gates keep passing.** Caller-rate invariance, voyage-compression
   separation (30× applies to geodesic distance only), free-decay behaviour
   with no wind and no sail, and the wave inverse-solve registration are
   non-negotiable. The energy gate is *generalised*, not removed: hull kinetic
   energy may rise only by work the wind actually did (§6.5).

---

## 4. Layer 1 — wind

### 4.1 True wind

The sea state is already the authority: every preset in `src/ocean/presets.ts`
carries `wind { speedMps, directionDeg, gustiness, maturity }`, chosen
consistently with its wave spectrum. Layer 1 promotes this to a queryable world
wind rather than inventing a second weather source.

- `WorldWind` (new, `src/world/` or `src/scene/`) owns the instantaneous true
  wind: mean vector from the active sea state, plus a gust process.
- **Gust process:** a seeded, deterministic mean-reverting walk (an
  Ornstein–Uhlenbeck-style filter is enough) on speed and direction,
  parameterised by the preset's `gustiness`. Target behaviour: speed excursions
  of roughly ±(gustiness × 40%) around the mean with 10–60 s character, plus a
  slow direction wander of a few degrees. Deterministic seeding is mandatory —
  evidence runs must reproduce exactly, and no `Date.now()` anywhere near it.
- The existing presentational `WindSystem` (`src/scene/WindSystem.ts`) becomes a
  *consumer* of `WorldWind` — one authority, like the wave field. Ocean
  spectrum, foam, spray, clouds and audio keep reading the values they read
  today.

**Convention audit is a Round S1 deliverable, not an assumption.** Sea-state
directions are documented as headings the waves travel *toward*; presentation
heading 180° is model yaw 0; the render frame is +X right / +Z aft while the
hull model is +z bow. The wind module must publish one explicit convention
(recommendation: "direction the wind blows toward, in the same frame the wave
field uses"), provide conversion helpers, and carry a test that pins a wind
blowing toward +x to a named point of sail at a named heading. Getting a sign
wrong here inverts every polar; it must be nailed before any force exists.

### 4.2 Apparent wind

Computed per sail, at each sail's centre of effort, using the full rigid-body
point velocity (translation + roll/pitch/yaw rates × lever arm):

```
apparent = trueWind − velocityOfCoEPoint
```

Using point velocity rather than hull velocity is cheap and buys a real
behaviour: a rolling rig sweeps its masts through the air, which opposes the
roll — **aerodynamic roll damping**, the reason sail-set ships roll easier than
bare poles. The motion handover lists its absence as a known gap; this closes
it without a dedicated model.

No vertical wind gradient or twist in v1 (§10). One true wind, evaluated at
each CoE.

---

## 5. Layer 2 — rig state and controls

The heart of the project. A new **vessel-control state** (`SailingControls`,
working name) holding the complete control surface. Physics reads it; crew
tiers and the player write to it; nothing else mutates the ship.

### 5.1 Control inventory

Per sail, exactly two kinds of state — a discrete **set state** and (where
meaningful) a continuous **trim**:

| Sail | Set states | Trim | Notes |
|---|---|---|---|
| mainsail | furled · reef2 · reef1 · set | sheet angle | boom sail; reefs shrink hoist and area |
| foresail | furled · reef1 · set | sheet angle | boom sail |
| fore staysail | furled · set | sheet angle (signed) | working headsail, last struck |
| jib | furled · set | sheet angle (signed) | |
| flying jib | furled · set | sheet angle (signed) | first headsail struck |
| fore topsail (square) | furled · set | **brace angle** (yard rotation) | clewed up = furled for v1 |
| main gaff topsail | struck · set | — slaved to mainsail sheet | per `docs/ship/SHIP_SPEC.md` §7.1 amendment; **interlocked with the mainsail's hoist, below** |
| fisherman | struck · set | — sheeted to mainmast, fixed | lightest-air sail only |

Plus the helm:

| Control | Range | Notes |
|---|---|---|
| tiller angle | ±35° rudder equivalent | long tiller, mechanically direct (`docs/ship/SHIP_SPEC.md` §2); sign convention fixed by test, not by comment |

Signed headsail trim encodes which side the sail is sheeted to; boom-sail sheet
angle is the boom's angle off centreline, swinging through zero at a tack or
gybe. Trim limits come from the rig (a boom cannot pass the shrouds; the yard
braces to a maximum before the standing rigging stops it) and are derived from
`rig.ts` geometry, not invented.

**The one interlock: the gaff topsail and the main gaff.** Every corner of the
gaff topsail hangs on gear the mainsail's hoist moves — its clew is hauled out
along the main gaff, its tack down by the jaws — so there is no such thing as a
gaff topsail carried over a lowered gaff. A crew hands the topsail *first*; it
is the first sail off the ship and it is down before anyone touches the throat
and peak halyards. Two rules, which are the same physical statement twice:

- the mainsail's hoist may not **fall** while the topsail has cloth set;
- the topsail's hoist may not **rise** while the mainsail is not fully set.

Ordering the mainsail down (furl *or* reef) therefore also orders the topsail
struck, and the mainsail's own evolution waits — one order from the player, the
sequence a crew would work, and the wait charged on top of the §5.2 time rather
than taken out of it. Making sail again does **not** re-set the kite; that is
its own order.

This is the only cross-sail dependency in the rig, and it exists because it is
the only place two sails share a spar. Without it the sim drew a state that
cannot exist: the clew rode the gaff down while the head stayed at the topmast,
so the topsail stretched further the more the mainsail came in, and since the
aero reads the same corners, handing the mainsail in a squall *grew* the light
kite above it from 15.5 m² to 21.4 m². The geometry was never wrong — the order
of work was missing.

**What a control is not:** we do not model individual line tensions, purchase
ratios, or which pin a fall is belayed to. Each control maps one-to-one onto
running rigging that already exists in the graph (`RUNNING_RIGGING`,
`src/vessel/schooner/rig.ts`), so every verb has a physical referent and the
later embodied-crew project can attach hands to real pins — but the *state* is
the sail's, not the rope's.

### 5.2 Actuation rates — the equivalence mechanism

Every control moves toward its commanded target at a finite, crewed rate.
Nothing is instant. Provisional values, tunable in one table:

| Operation | Duration (order) |
|---|---|
| tiller, hard-over to hard-over | 3–4 s |
| sheet, full ease-to-haul | 10–20 s |
| set or strike a headsail | 30–60 s |
| hoist or lower a gaff sail (throat + peak) | 60–120 s |
| tie in / shake out a reef | 3–5 min |
| set / clew up the square topsail | 2–3 min |

The rates are the equivalence mechanism of invariant 2: the crew tier requests
target values and the same rate limiter moves them that a player's input moves.
They are also the game feel of working a real ship — an order takes effect the
way it would aboard: soon, not now.

**Which clock each one runs on** — *decided 2026-08-08, after review; this
paragraph replaces "these run on ordinary physics seconds, never the 30× voyage
clock", which was wrong for half the table.*

The durations above are what they always were: statements about a **real
crew's working day**. What changed is the recognition that the day is not the
clock the player sits in. `PlanetaryWorld` advances the calendar *and the
distance made good* at 30×, so charging an errand in keyboard seconds charges
the voyage thirty times over — handing the mainsail cost 45 minutes of
daylight and thirty times the sea room, and a day spent tacking made almost no
progress across the chart.

So the split is by **what the control costs**:

- **The tiller and the sheets run on ordinary physics seconds.** They are not
  errands; they are worked continuously against her live response, and the
  turning-circle and tack evidence is timed against them.
- **Sail evolutions run on the world's clock**: the table above is stored in
  world seconds and divided by the **astronomical calendar's** rate
  (`DEFAULT_WORLD_SECONDS_PER_REAL_SECOND`), not by the voyage compression.
  <!-- Corrected 2026-08-17 (WX1). This line said "the voyage compression" and
  was harmless while both were 30×; it went live the day the voyage clock
  dropped to an honest 1×. `src/world/clock.ts` says which of the two a crew
  cost converts against, and `SailingControls` does what it says. --> The crew's day is
  charged what the crew's day costs, and the player watches it at the same
  30× everything else about the voyage moves at.

Multi-control evolutions (tacking, reefing) are **sequences** owned by the crew
tier (§7), not by the control state. The control state knows only current and
target values.

### 5.3 Persistence

Control state is small, plain data (a dozen numbers and enums). It is not
canonical world state, but it must survive whatever save/restore the vessel
already participates in, alongside heading. No history, no derived values
saved.

---

## 6. Layer 3 — forces

All force evaluation happens inside the existing 240 Hz fixed substep, summed
where resistance is already summed (`SchoonerHorizontalDynamics` free path).
Everything below is a **transparent game-model baseline** in the same spirit as
`SchoonerResistance`: explicit, separately-reported provisional coefficients,
no claim of tank data, every term inspectable in evidence output.

### 6.1 Sail aerodynamics

New pure-maths module (`sailAero.ts`, working name) that derives per-sail
geometry from the rig once — area, centroid centre of effort, chord direction
as functions of the current trim — and evaluates per-sail force per substep:

- **Angle of attack** = angle between apparent wind (at that sail's CoE, §4.2)
  and the sail's chord given current trim and hull attitude. Full 3D: the
  sail's orientation rotates with heel, so drive naturally sags as she heels —
  no ad-hoc cosine corrections.
- **Lift and drag coefficients** per sail from a small family of curves by sail
  type (boom gaff sail / headsail / square sail), parameterised by the sail's
  existing `camber` value in `rig.ts`. Shape: linear-ish lift rise to a maximum
  around 25–30° AoA, soft stall beyond, drag rising from a small base
  quadratically. Provisional anchors: CLmax ≈ 1.0–1.2 fore-and-aft, the square
  topsail drag-dominant off the wind (CD ≈ 1.2 square-on).
  *Amended 2026-08-17 (the S6c coefficient round — see
  `SAILING_ROUND_HANDOVER.md`), because this paragraph described a rig with no
  pointing limit of its own:* three terms were added and each closed a stated
  simplification. **Induced drag** `CL²/(π·AR_eff·e)` on each sail's own
  effective aspect ratio, solved live from its corners — geometric `span²/area`
  raised by the sea's mirror, `1/(1 + 2·gap/span)`; the gaff main comes out at
  3.06 and the square topsail at 1.14, which is why gaffers do not point.
  **Lift on an aback sail**, the same curve read on the other face with the
  shallower belly backed cloth takes, so backing a headsail is a technique that
  works — and an aback sail carries the *attached* drag curve, because pressed
  cloth is not a shivering rag. And **CLmax reads the drawn camber**, not the
  design one: the ±5° centreline ramp and the flattening a hard sheet takes out
  live in `sailAero` now and the M6 loft reads them from there. The one number
  in the new terms that is not derived is the span efficiency `e = 0.85`, and
  it is labelled as such in the coefficient block.
- **Luffing:** below a threshold AoA the sail cannot hold shape — lift
  collapses smoothly to zero over a few degrees, drag falls to bare-pole
  values, and the sail reports a boolean `luffing` flag for presentation and
  for the crew trimmer. No flogging *forces* in v1.
- **Reefed / furled:** reefs scale area and lower the CoE per a fixed per-reef
  factor derived from the sail's geometry; furled/struck contributes nothing
  (bare-pole windage of spars is one small lumped drag term for the whole rig,
  so a storm still pushes a stripped ship). *Implemented 2026-08-08:* for the
  two gaff sails the hoist fraction is the **gaff's height**, not a
  compression of the cloth — the spar comes down and the sail's head comes
  with it, foot left on the boom. Reefing a gaff sail is exactly that
  evolution, so one fraction serves both. Geometry is still derived from the
  corners, never scaled by a second guess.
- **Blanketing:** v1 carries only a crude downwind occlusion — a sail dead
  down-apparent-wind of another loses a fraction of its force. One coefficient,
  honestly labeled, revisited only if evidence shows it matters. No slot
  effect.

**Output per sail:** a force vector at a CoE point, plus the flags. Evidence
mode reports every sail separately (the world-lighting round's per-term-views
lesson: aggregate numbers hide sign errors).

### 6.2 The wrench split

The vessel deliberately has two integrators (`BuoyantBody` for heave/pitch/
roll, `SchoonerHorizontalDynamics` for surge/sway/yaw). Sail and rudder forces
are one physical wrench, split once, in one place:

- horizontal force components + yaw moment about the existing yaw reference →
  summed beside resistance in `SchoonerHorizontalDynamics`;
- roll and pitch moments (force × lever about the CoM) + the small vertical
  component → a new **external force/torque input on `BuoyantBody`**, applied
  in the same substep.

The `BuoyantBody` external-wrench seam is the one genuinely new piece of
physics plumbing in the project. It must be generic (later consumers: green
water, towing, collision) and must default to zero so every existing test and
evidence file is bit-identical with no sails set.

Heel then *emerges*: sail heeling moment vs the validated righting arm and roll
damping. Weather helm emerges: per-sail CoE positions vs the lateral resistance
distribution. Leeway emerges: side force vs the existing sway resistance. None
of the three is authored.

### 6.3 Rudder

The rudder becomes a lift surface with a commanded deflection, extending the
passive model rather than replacing it:

- Input: rudder angle from the control state, threaded into
  `SchoonerResistanceInput` (`src/vessel/schooner/SchoonerResistance.ts`).
- Inflow: local water velocity relative to the blade, from the same station
  contact/relative-flow contract everything else uses — including the yaw-rate
  contribution at the stern (mind the documented gotcha: contact hull-point
  velocity excludes yaw rate; the resistance model adds it explicitly and the
  rudder term must do the same, once).
- Force: lift ∝ deflection × dynamic pressure of inflow up to a stall around
  25–30° effective angle, plus induced drag. Effectiveness therefore scales
  with speed² — a stopped ship does not answer her helm, which is real and
  matters for the in-irons experience. Astern inflow reverses the geometry
  (she steers "backwards" making sternway, as real ships do).
- The existing zero-deflection passive drag terms remain the δ=0 case;
  captive-tow evidence must be unchanged at zero deflection.

No propeller wash (no propeller), no tiller force feedback (§10).

### 6.4 Added mass

The passive round deliberately shipped dry horizontal inertias. Sailing makes
the gap visible (acceleration and turn dynamics), so this project adds constant
added-mass coefficients for surge (~5–10%), sway (~30–60%) and yaw (~20–40%) —
provisional, separately reported, tuned against the turn-circle and
acceleration evidence. This changes the passive baselines; the evidence
regenerates with the change, in the same commit, per the established rule.

### 6.5 Energy accounting

The passivity gate generalises: over any interval, hull kinetic + rotational
energy change ≤ work done by sail and rudder forces (wind is the only source;
water only dissipates). The harness tracks wind work explicitly. With no sails
set and no wind, the original non-increasing-energy gates apply verbatim and
must keep passing.

---

## 7. Layer 4 — command hierarchy

Three tiers. Each tier only writes targets into the tier below; only tier 0
touches the control state, and it does so through the §5.2 rate limits.

**Tier 0 — direct control.** Set a target value for one control: tiller angle,
one sail's sheet, one sail's set state. This is the player's manual interface
*and* the crew's hands. Dev-panel sliders first (the existing `ControlGroup`
pattern); deck interaction (walking to the tiller) is the final round.

**Tier 1 — standing orders.**
- *Helmsman:* "steer compass course X" / "hold this apparent-wind angle" (the
  latter is how a real helmsman sails close-hauled). A deliberately human
  controller: deadband, anticipation of yaw rate, limited tiller speed — tuned
  to hold course within a few degrees in a seaway, not a servo. Sailing by
  apparent wind angle also gives gust response (luff up in the puffs) for free.
- *Trimmers:* per-sail target-AoA policy — keep each set sail near its best
  drive for the current point of sail, ease when overpowered (heel beyond a
  threshold), report when a sail can't be made to draw (too close to the wind,
  or blanketed).

**Tier 2 — navigation and evolutions.**
- *Course to a waypoint:* if the direct course is sailable, order it; if it is
  inside the no-go zone, beat — alternate close-hauled legs with tacks, simple
  fixed-length legs in v1 (proper laylines later).
- *Evolutions as sequences:* **tack** (helm down → sheets handled through the
  eye of the wind → fill on the new tack; must detect and recover from a failed
  tack/in-irons by falling off and rebuilding speed), **gybe** (main sheeted in
  hard → stern through the wind → eased on the new side), **make sail /
  shorten sail** per the canvas policy below.
- *Canvas policy:* a table mapping true wind bands to the sail set carried
  (roughly: everything ≤ 5 m/s; strike fisherman and gaff topsail by ~7;
  flying jib in and first reef around 10–12; topsail in and deep reefs above
  14; bare poles / storm trysail territory is out of scope). Provisional; it
  becomes the knob Ash tunes for how conservative the crew feels.

The captain's interface in this project is a thin order API (and dev panel):
"steer 240", "sail to point", "make sail", "shorten sail", "heave to" is
explicitly out of scope. The map UI comes in the final round; the order
*semantics* exist from Tier 2's round onward.

---

## 8. Visual response (minimal geometric)

Per Ash's scope call: the rig follows the state honestly, without cloth
simulation.

- The frozen trim constants in `rig.ts` (`SHEET_*`, `BRACE_ANGLE`) become
  functions of the control state. The node graph already routes everything
  through named points, so a swung boom carries its sheet, topping lift and
  sail corners with it (`rig.ts`'s "the sails round bends real cloth to the
  same names" contract, honoured).
- Sail lofting re-runs when trim state changes; spars and running rigging
  likewise. *Resolved 2026-08-08, after review:* the granularity is a
  **static/live split**, not a threshold. S4 first shipped a whole-rig rebuild
  (2.4 ms) rationed to 8 Hz, and the ration is what the eye sees — motion in
  steps. The rebuild is now the half a control can move, evaluated without
  allocating (~0.5 ms), run on every frame anything is travelling and skipped
  entirely when nothing is. No threshold, no interval, no interpolation lag.
- Set states render as: set = current cloth; reefed = re-lofted smaller sail
  (reef geometry derived, not hand-authored); furled/struck = cloth hidden
  plus a stowed roll along the spar or stay so the rig doesn't look amputated.
  *Implemented 2026-08-08, after review:* the roll is **continuous, not a
  furled-only placeholder** — it is sized by conserving the cloth (area
  gathered × an effective packed thickness, solved as an annulus around the
  spar), so it appears with the first foot of halyard, thickens all the way
  down, and is a sleeve over the timber rather than a rod beside it. The gaff
  topsail and fisherman have no stow: they are handed and sent below.
- **Both tacks must draw correctly.** The current graph is baked on the
  starboard tack; sheets lead to one side. S4 adds the mirrored leads (the pin-per-rope
  and rope-path tests extend to both tacks) and the sail `side` sign flips with
  the tack — set by running the belly test, never by reasoning
  (`docs/ship/SHIP_RIG_HANDOVER.md` §4).
- The rig-vs-everything intersection suite runs over the **whole trim
  envelope**, not one pose: sweep sheet/brace ranges in the test and assert no
  spar–spar, spar–rigging or sail–rigging intersection at any legal trim. The
  rig round's central lesson was that untested categories rot silently; trim
  adds a continuous dimension to that risk.

Flags/pennants as wind tellers, luffing shiver, and all cloth motion: M6.

---

## 9. Validation and evidence

Same culture as the physics rounds: headless, deterministic, committed JSON,
gates in CI, Ash's eyes before merge. New evidence products:

| Evidence | Contents | Headline gates |
|---|---|---|
| `ship:polar` | steady-state speed vs true-wind angle (15° grid) × wind speeds (4, 8, 12 m/s) × canvas states, with per-sail force, heel, leeway, rudder-to-hold-course | no drive inside the no-go zone; max speed on a reach, not a run; speeds bounded by hull speed (~4.7 m/s for 14.3 m LWL) except a stated surfing allowance; polar symmetric port/starboard within tolerance |
| `ship:turn` | turn circles at 2 or 3 speeds × rudder angles, both directions | port/starboard mirror within tolerance; radius decreases with rudder angle; stopped ship does not turn |
| `ship:tack` | tack and gybe attempts across entry speeds and sea states | tack succeeds above a stated entry speed in calm water and fails below it (both outcomes asserted); gybe conserves plausibility (no energy spike, boom transit time bounded) |
| `ship:helm` | weather-helm curve: rudder angle to hold course vs canvas balance | sign correct (more aft canvas → lee helm on the rudder... asserted by construction from the CoE positions, verified by measurement); magnitude a few degrees, not tens |
| gust response | response to a scripted gust at fixed controls | heel and speed rise bounded; energy gate (§6.5) holds through the transient |
| `ship:crew` (S5) | the compass card, the helm's observation chain and the six trimmer stations | course-hold RMS bands; nonzero human latency; finite adjustment episodes with real observation gaps between them; a useful fraction of the ideal trim *without* reproducing it |
| `ship:voyage` (S6) | scripted voyages to a chart position: the beat, the downwind passage, the canvas sweep, the voyage clock | the windward mark fetched inside a bounded tack count; a downwind passage that gybes and never tacks; canvas shortened monotonically as the wind rises; deterministic replay; control timing independent of voyage compression |

*Corrected 2026-08-17: this table listed a `ship:gust` script. There has never
been one. The gust case shipped inside `ship:sailing` as
`freeRuns.gustEnergy` (`tools/export-ship-sailing.mjs`), gated there, and the
row is renamed above rather than deleted so the case is still findable.*

Cross-cutting gates carried from the physics rounds, now with sails: caller-rate
invariance, voyage-compression separation, zero-wind/zero-sail equivalence to
the passive baselines (bit-identical), no safety-limiter contact in any
evidence case, wave-registration residual unchanged.

And the experience checks that only Ash can run: does close-hauled *feel*
close-hauled (spray, heel, the rail down); does easing the sheets visibly
relax her; does a tack read as an event with a beginning, middle and end.

---

## 10. Simplifications ledger

What v1 deliberately does not simulate, so nobody discovers it by surprise:

- individual line tensions, purchases, belaying, chafe — controls are per-sail;
- cloth dynamics feeding back into forces — force model is quasi-steady
  aerodynamics on the lofted shape; visuals follow state, never vice versa;
- sail–sail interaction beyond one crude blanketing factor — no slot effect;
- vertical wind gradient and twist — one true wind for the whole rig;
- flogging loads, luffing damage, gear failure of any kind;
- ocean current (deferred with leeway/current separation already noted in the
  motion handover) and evolving weather (`docs/project/FUTURE_ROUNDS.md`);
- tiller force feedback / helm load;
- heaving to, anchoring, towing, and any storm-survival tactics beyond
  shortening sail;
- crew skill, fatigue, or failure — the invisible hands are competent and tireless.

Each is either a later project or a later fidelity pass; none is architecture.
The one structural bet: per-sail quasi-steady aero at real centres of effort is
detailed enough to make points of sail, helm balance, reefing and tacking all
emerge — and everything on this list can be added *under* the same control
surface without changing it.

---

## 11. Open questions, deliberately left

- **Reef counts and storm canvas** — one reef or two on the mainsail, is there
  a storm trysail: decide when the canvas policy meets the rough presets.
- **Does the fisherman earn its keep** in the trim model or stay a fair-weather
  set-piece? (It is already the roughest sail geometrically —
  `docs/ship/SHIP_RIG_HANDOVER.md` §6.)
- **Player interaction grammar on deck** (S7): look-at-and-use vs proximity
  prompts vs a helm "seat". Decide with the round, prototype-first.
- **Where the order UI lives** (map pin, spoken orders, both) — S7, with Ash.
- **Sound.** Sailing is loud (luffing, water, rigging hum). Out of scope here,
  but the `luffing`/heel/speed signals should be exposed so the audio round can
  consume them.

---

## 12. Planned file map

| Concern | Planned home |
|---|---|
| world wind authority + gusts | `src/world/WorldWind.ts` (new) |
| apparent wind helpers | with `WorldWind`, pure functions |
| vessel-control state + rate limiting | `src/vessel/schooner/SailingControls.ts` (new) |
| sail geometry derivation + aero | `src/vessel/schooner/sailAero.ts` (new, pure maths like `rig.ts`) |
| rudder lift | extend `src/vessel/schooner/SchoonerResistance.ts` |
| external wrench seam | extend `src/vessel/BuoyantBody.ts` |
| force integration | extend `src/vessel/schooner/SchoonerHorizontalDynamics.ts` |
| crew tiers | `src/vessel/schooner/crew/` (new: `Helmsman.ts`, `Trimmers.ts`, `Navigator.ts`) |
| rig trim → geometry | `rig.ts` trim constants → functions; `rigGeometry.ts` incremental rebuild |
| dev panel | `sailing` entry in the existing `DevTools` array |
| evidence builders | `src/vessel/schooner/Sailing*Evidence.ts` + `tools/export-ship-sailing.mjs` |
| tests | `tests/ship-sailing-*.test.ts` |

`docs/sailing/SAILING_PROJECT_PLAN.md` sequences these into rounds with per-round gates.
