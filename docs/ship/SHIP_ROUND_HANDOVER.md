# The schooner — build plan and session handover

**Status: M0, M1, the accepted hull-form refinement, M2 and M3 are complete.
M4 — below decks — is next.** Written 2026-07-31 with Ash after negotiating the
design briefs down into `docs/ship/SHIP_SPEC.md`; updated after the M1 hull review, after
M2, and after M3 closed on 2026-08-06.

**`docs/ship/SHIP_RIG_HANDOVER.md` is the authority on the rig** and
**`docs/ship/SHIP_DECK_HANDOVER.md` is the authority on the deck** — what they are, why
they are shaped that way, and what each round deliberately left open. Read the
deck one before M4: its §8.1 sets out the surface contract M4 has to extend, and
its closing section says exactly where that contract breaks.

**The one thing to read before writing any M4 code**: `deckStandAt` answers
**one** height for any (x, z), because on an open deck there is one. Fitting tops
were the cheap half of relaxing that — a hatch grating is *higher* than the deck,
so "the highest surface that admits the query wins" answers it, which is the rule
the three deck levels already used. A cabin sole is **lower** than the deck above
it, and that rule cannot answer it at all. M4's real structural work is giving
the surface a second floor and a ceiling, and it is more work than the cabin's
furniture is.

`docs/ship/SHIP_SPEC.md` is the authority on **what the ship is**. This document is the
authority on **how she gets built and in what order**. If they disagree about
the ship, the spec wins; about sequencing, this wins.

---

## 1. The scope, honestly

This replaces the raft — a 3.2 m improvised platform carrying one seated
castaway — with a 15.5 m two-masted schooner that the player walks around
inside. It is not a bigger raft. It is:

- a hull with **interiors**, which the raft has no equivalent of;
- a **different flotation regime** (§4);
- a **character controller and collision system**, which do not exist at all;
- an **interior lighting problem**, which does not exist at all.

Eight milestones, each independently verifiable, each leaving `master` running.
Do not attempt more than one per session. M0 alone is a full session.

---

## 2. Why this is not organised as "model first, systems later"

The source briefs were written as asset-delivery specs for a 3D modeller:
deliver geometry now, defer buoyancy, collision, the controller and lighting to
later rounds, and "merely avoid preventing those systems."

**That structure is wrong for this codebase, and adopting it would cause real
damage.** There is no asset pipeline here — no `GLTFLoader`, no textures, no
`public/`. `docs/project/ASSET_CREDITS.md` states the invariant outright: no external models,
textures, fonts or environment maps ship; everything is runtime-generated. More
importantly, geometry and physics are deliberately **one artifact**:

> the geometry is handed in by the Raft, which records it as it builds the
> meshes, so the two can never disagree
> — [BuoyantBody.ts](src/vessel/BuoyantBody.ts)

Three consequences that shape every milestone below:

**You don't document the waterline — you solve it.** The briefs asked for a
"provisional centre-of-buoyancy reference" as a delivered marker. `RaftBuoyancy`
already *computes* the equilibrium waterline from Archimedes and verifies it
against the model. A hand-authored marker would be superseded immediately and
could silently disagree with the truth.

**The hull's acceptance test is its physics.** Whether the offsets are right is
answered by "does she float at 2.3 m at correct trim with a 5.6 s roll." Build
the hull without the buoyancy work and you have a hull you cannot validate — and
hull shape is the single most expensive thing to change late.

**Collision comes out of construction, not after it.** In a procedural pipeline
the walkable surfaces are a by-product of building the deck. Retrofitting a
collision proxy onto finished geometry recreates exactly the two-descriptions
drift the codebase is built to prevent.

So: **the spec's content is adopted wholesale; its round structure is
discarded.** Each milestone below is a vertical slice — geometry *plus* its
physics *plus* its collision, from one source.

The briefs also packed 21 deliverables into a single "modelling round," which is
M0–M4 plus part of M6 in one bite. Ash's instruction was explicitly not to bite
off too much. That instruction wins.

---

## 3. Architectural decisions already made

### 3.1 The player walks in ship-local space — settled

Position, collision, gravity and step height all resolve **in the ship's frame**,
then compose through `group.matrixWorld` exactly as the deck meshes already do.

A pitching, rolling, heaving deck then costs nothing: the player is welded to the
ship the way the mast is, and you never fight the world transform. Doing this in
world space means spending the entire round chasing a floor that moves out from
under a capsule. This decision is in from line one, not retrofitted.

### 3.2 Construction is procedural, via a shipwright layer

No Blender, no imported meshes. But not 3,000 lines of cylinder placement either
— build a primitive layer first (`loftHull`, `spar`, `plank`, `rope`,
`ratlines`, plus merge/instance helpers) and then author the ship as **data**: a
table of offsets, a spar plan, a rigging graph. That is how real ships are
drawn, and it is the only way the hull mesh and the displacement integral come
from one source.

### 3.3 Rigging is a topology graph

Per `docs/ship/SHIP_SPEC.md` §7.4: every important rope connects real attachment points.
Not decorative cylinders. Costs more at M2, and is the only thing that makes M6
tractable.

### 3.4 Traversal aloft is authored

Per `docs/ship/SHIP_SPEC.md` §15: a ladder volume or spline in the ship's frame. No
per-ratline collision, no IK. Decided; do not relitigate at M5.

---

## 4. The flotation rework — the technical core of M0

`RaftBuoyancy` is good code and its **architecture survives intact**. Stations
along the length, each evaluating the water surface at its own world position at
the current physics time, each pushing up with `ρgV`, forces applied at stations
so pitch and roll are genuine torque. Damping against local water velocity.
Added mass. Critical points. All retained.

**One function changes.** `segmentArea()` — immersed area of a circular cylinder
slice — becomes immersed area of a **hull station**. Given a station's offset
polygon (half-breadths at waterlines, mirrored about the centreline), clip it
against the local heeled water plane and take area and centroid. Standard
polygon clipping: exact, cheap, and it handles heel correctly by construction,
which the raft's parallel-cylinder formulation only did by accident of geometry.

The centroid matters more than it did for the raft: at heel, a ship's immersed
section shifts *transversely*, and that shift is precisely where the righting
moment comes from. A raft is a flat plate and barely has one. This is why she
gets a real roll period and the raft does not.

### Why the station count must be revisited

The raft uses 3 columns × 8 rows, and the 8 was chosen against Nyquist for a
1.5 m chop at 0.40 m spacing
([BuoyantBody.ts](src/vessel/BuoyantBody.ts)). A 15.5 m hull is a
different problem: it **spans** several wavelengths of the short seas rather than
riding them. Station spacing must be re-derived against the shortest wave in the
preset matrix — do not inherit 8 rows without redoing that argument, and record
the new derivation in the same place.

### Everything in M0 is headlessly testable

Equilibrium draught, displaced volume, trim, an inclining test for `GM`, and a
**free-decay test** for `T_roll` (heel her 10°, release, measure the period off
the decay) all run without rendering. M0 ships as unit tests, not screenshots.

---

## 5. Budget

`docs/ship/SHIP_SPEC.md` imposes no performance target; this document does. The ocean and
clouds already own most of an ~18 ms frame after the perf round
(`docs/ocean/OCEAN_PERF_HANDOVER.md`, `docs/clouds/CLOUD_CACHE_REPORT.md`).

| | Budget | How it is held |
|---|---|---|
| GPU time, ship only, full detail | **≤ 2 ms** | hand-measured in the browser |
| Draw calls | **≤ 120** | asserted, headless |
| Triangles | **≤ 200k** | asserted, headless |

**Only two of the three are assertable, and the original version of this table
implied all three were.** Draw calls and triangles come off the built group
without a GPU and go in a test from M1. The 2 ms does not: `GpuProfiler` has no
ship pass, and the test environment has no GPU. Until someone adds that pass,
the 2 ms is a browser measurement taken by hand and recorded in the milestone's
notes — say so when you report it, rather than implying a green test covered it.

Assert what can be asserted from M1 onward. Ratlines alone are ~240 segments per mast;
without a number to build against, the cost gets discovered at M5 when it is
expensive to fix. The budget is not tight — a merged, instanced ship lands
around 40 draw calls — but it must be *measured*, not assumed.

Static grouping is expected: merge by material, instance the repeated fittings
(blocks, deadeyes, belaying pins). Anything that moves or changes state stays
separable.

---

## 6. Milestones

Each is a checkpoint you can inspect. The raft keeps working throughout (§7).

### M0 — Hull form and hydrostatics · **DONE**

No visible ship. The foundation everything else is validated against.

**Built:** `src/vessel/schooner/hullForm.ts` (parametric form generating the offsets table),
`hullSection.ts` (polygon clipping against a sloping water plane),
`backbone.ts` (keel, forefoot, deadwood, sternpost and rudder — added by the
addendum below), `hydrostatics.ts`, `massModel.ts`, `SchoonerBuoyancy.ts`.
`RaftBuoyancy` split into a generic `HullBuoyancy` plus a raft subclass;
`raftFlotation.ts` extracted so the raft's timber can be built without a WebGL
context.

**Current canonical result** — all asserted in the ship tests:

| | Target | Achieved |
|---|---|---|
| Moulded volume | 75–77 m³ | **75.08** |
| Displaced volume | 78–81 m³ | **79.59** |
| Displacement | 79.5–82.5 t | **81.58 t** |
| Moulded draught | 2.30 m | **2.30**, solved |
| Draught to keel | derived | **2.52 fwd / 2.87 aft** |
| Trim | level | **level**, LCG placed on LCB |
| GM | 0.55–0.85 m | **0.611** |
| Ballast fraction | 0.25–0.38 | **0.344** |
| Roll period | quick, measured | **5.96 s** free decay |
| Pitch period | measured | **≈2.2 s** |
| Cabin headroom | ≥1.85 m centreline | **1.852 m** at the binding point |
| Cabin sole area | ≥ 7–9 m² available | **11.3 m²** |

**Four things were found that the plan did not anticipate.** All are written up
where they were fixed; recorded here because they change what a later session
should assume:

1. **The roll period is 5.59 s, not the 4.3 s this document predicted.** The
   estimate under-read `KG` by 0.41 m (the rig was not taken seriously) and
   ignored added inertia. `docs/ship/SHIP_SPEC.md` §4.2 and §5.1 carry the corrected
   figures and the arithmetic. §5.3's resonance argument weakens as a result —
   `CROSSING_SEAS` is no longer a near-coincidence — and §5.4's lookout numbers
   drop by about a third.
2. **The equilibrium waterline solver had a hardcoded bracket** of `[-0.5, 1.0]`,
   correct for a 0.25 m raft and silently wrong for anything deeper. A 2.3 m
   draught saturated at 1.0 and the ship floated on a seventh of her
   displacement, with no error raised. Now derived from the hull's own extent.
3. **Buoyancy was applied at local y = 0, not at the immersed centroid.**
   Rotating a body-local point into the world mixes its local y into the
   horizontal moment arm, so the wrong height leaks a spurious righting moment
   of `comY·sin(roll)` per station. Invisible on the raft (0.06 m); on the ship
   it was the same size as the real righting arm and she would not roll at all.
   `StationImmersion.centroidY` now carries it.
4. **The single damping ratio was not a compromise — it was a missing
   mechanism. FIXED during M1, at Ash's instruction.** One figure covered heave,
   pitch and roll, and the belief was that a ship's roll simply wanted a lighter
   number than its heave. The truth was worse: station damping is a *vertical*
   force at the immersed centroid, and its roll torque is that force times the
   centroid's transverse offset — which is 1.1 m on the raft's three columns and
   effectively zero on a centreline hull. A declared 0.18 was reaching roll as
   an effective **0.0011**. Roll now has explicit linear and quadratic terms;
   see `docs/ship/SHIP_SPEC.md` §5.1.1 and finding 2 under M1.

The raft is untouched: `tests/raft-buoyancy-golden.test.ts` pins its
hydrostatics, inertias and a 2400-step trajectory to the values it produced at
commit 8d9f445, and they are bit-identical through the whole refactor.

#### M0 addendum — the hull had no backbone

Found in the M1 readiness review, fixed before any geometry was cut. **The
offsets table starts at the rabbet**, which is the correct meaning of a table of
offsets and an incomplete description of what is under water. The keel, the
deadwood filling the rise aft, the forefoot and stem, and the rudder are 2.67 m³
— 3.4% of displacement — and M0 gave all of them mass and none of them volume.

Fixed in `src/vessel/schooner/backbone.ts` as a **profile**, not an allowance factor,
because M1 is about to draw this timber and a drawn keel cannot be checked
against a fudge factor. The same profile now yields the volume it displaces, the
oak in it (`massModel` derives the backbone per station instead of carrying three
hand-sized lumps), and the shape M1 lofts.

Displacement 77.77 → **80.51 t**, ballast 25.80 → **28.53 t**, KG 1.974 →
**1.925**. `docs/ship/SHIP_SPEC.md` §4.2 carries the full before/after and the arithmetic.

**Two things worth carrying forward:**

1. **GM went the other way from the obvious prediction.** More volume at fixed
   draught means more ballast means lower KG means a stiffer ship — that reading
   gives GM ≈ 0.71 and it counts half the effect. The appendages are low, narrow
   volume on the centreline: KB falls 0.027 and BM = I/V falls 0.038 because they
   add to `V` and nothing to the waterplane. KM drops 0.066 against KG's 0.049,
   the two nearly cancel, and she ends up **0.016 m less stiff, not 0.05 m more**.
   Roll period is unchanged at 5.59 s. A term that enters through one path in
   your head usually enters through three in the arithmetic.
2. **Form coefficients are now explicitly moulded.** The stem's forward face
   stands proud of the moulded forefoot, so the appended body cuts the waterline
   0.44 m further forward; letting that into `L_wl` stretched it 14.31 → 14.71 and
   moved Cb to 0.449 and Cp to 0.620 for a hull whose shape had not changed.
   `hydrostaticsAt` tracks moulded and appended dimensions separately and quotes
   the coefficients on the moulded ones. Every coefficient in the spec is
   therefore the same number it was at M0.

This is the third time M0's published stability figures have moved. It should be
the last before M2 puts real spar geometry on her, which will move them a fourth
time on purpose.

### M1 — Bare hull afloat · low risk

The first time she can be looked at.

**Build:** lofted hull, deck, bulwarks, transom, stem, rudder. Correct sheer and
silhouette. Paint regions per `docs/ship/SHIP_SPEC.md` §16 with the below-waterline
material kept separate. No rig, no interior, no fittings. Hosted in a thin ship
viewer of its own (§7).

The keel, forefoot, deadwood, sternpost and rudder are **already described** — 
`backbone.ts` has the profile, and it is the same profile that displaces the
water. Loft it; do not re-author it. The one parameter there worth moving for
looks is `STEM_RAKE_EXPONENT`, and the band in §4.3 of the spec is what keeps
that honest.

**Bulwarks carry a mass item in the same commit as the bulwark geometry.**
`massModel.ts` smears the shell "keel to deck edge" and has no bulwark term at
all; M1 adds roughly 28 m of them at y ≈ 4.3, about 1.1 t, worth ~0.05 m of GM.
That stays inside the spec's band, so this is not a hull problem — it is a
don't-add-timber-the-mass-model-cannot-see problem, and the fix is one item
pushed next to the geometry that made it necessary.

**Accept when:** she reads correctly from the cinematic camera at the authored
composition distances — **Ash's eye, not a self-certification**; she floats at
the M0 waterline in every sea state without instability; draw calls and triangles
asserted and passing, GPU time hand-measured and reported (§5).

**Also a deliverable: measure what she does to the camera, and write it up.**
The cinematic rig's distance knots were authored around a 3.2 m raft. At the near
knot a 15.5 m hull is five times the subject size, so the whole composition
ladder needs revisiting. **Do not retune the camera inside M1** unless the fix is
trivial — measure it, record it, and let it be scoped properly.

#### M1 findings

**Built:** `shipwright.ts` (primitive layer), `shipGeometry.ts` (the ship as
data), `Schooner.ts` (meshes plus body), `debug/SchoonerViewer.ts` (`?debug=schooner`).
9 draw calls, 18,704 triangles — against budgets of 120 and 200k.

**1. The composition ladder does not survive her.** Measured at 71° horizontal
FOV, taking her 16.57 m length overall:

| Knot | Ship, % of frame width | Raft was | Distance for the raft's framing |
|---|---|---|---|
| 12 m | **97.5%** | 21.4% | 62 m |
| 25 m | 51.6% | 10.3% | 129 m |
| 45 m | 29.4% | 5.7% | 233 m |
| 130 m | 10.3% | 2.0% | 673 m |
| 330 m | 4.1% | 0.8% | 1709 m |

She *overflows the frame* at the near knot. The ratio settles at 5.18× — the
whole ladder wants shifting out by about that factor, which also means the far
knot stops being "a speck on the horizon" and starts being a ship. Not retuned
here, per the instruction above.

**2. Roll was structurally undamped, and is now fixed.** Held beam-on with no
steering, she used to wind up onto the integrator's ±40° limiter and sit there.
The cause was finding 4 above: the mechanism could not deliver roll damping to a
centreline hull at all. Roll now carries its own linear (0.075 of critical) and
quadratic (0.60 per radian) terms; heave went 0.18 → 0.35 now that it is no
longer held down by a compromise with roll. `docs/ship/SHIP_SPEC.md` §5.1.1 has the
argument and the numbers.

Beam-on, 90 s per preset, before and after:

| Sea state | Max roll before | after | On the ±40° clamp before | after |
|---|---|---|---|---|
| `GLASSY_LONG_SWELL` | 18.5° | **7.0°** | — | — |
| `WIND_CHOP` | 9.2° | **6.2°** | — | — |
| `CURRENT_MODERATE` | 40.1° | **20.2°** | 1.7% | **0%** |
| `MATURE_WIND_SEA` | 40.1° | **31.7°** | 6.6% | **0%** |
| `CROSSING_SEAS` | 35.7° | **17.1°** | — | — |
| `SOUTHERN_OCEAN_ROUGH` | 40.1° | **33.7°** | 10.9% | **0%** |

Nothing saturates anywhere in the matrix. The free-decay period moved 5.59 →
**5.96 s** (the bulwark mass and the damping between them), still quick for a
ship, and the effective damping ratio now *rises* with amplitude — 0.045 at 5°,
0.053 at 12°, 0.065 at 25° — which is the signature of the quadratic term and
the reason resonance no longer runs away. Asserted, not just produced.

The yaw-zero figures are retained as the M1 baseline, not as a worst-heading
claim. The later heading audit found materially different responses with yaw;
`docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` now owns that work.

**3. GPU time is still not measured, and could not be.** Two attempts failed for
instructive reasons: an isolated-scene A/B reported the ship as 1.2 ms *cheaper*
than an empty scene (the method is invalid, not the result), and bracketing the
live frame could not start a timer query because `GpuProfiler` already holds the
only `TIME_ELAPSED_EXT` slot. **There is no way to get this number without the
ship pass section 5 asks for.** Do not quote a figure until there is one; the
draw-call and triangle margins are wide enough that this is not urgent.

### M1.5 — Accepted hull form · **DONE**

Ash's M1 review correctly identified that the underwater profile lacked visual
and structural mass. The accepted correction is deliberately narrower than the
experimental hull branch:

- a 0.38 m moulded keel with 0.35 m of drag aft;
- curved rabbet rises opening a proper forefoot and deadwood above the straight
  keel;
- a rudder extended to the keel heel, with its mass derived from that geometry;
- deck and interior masses tied to the walking deck and cabin sole they sit on.

The deck, cabin sole, bulwarks, freeboard, ballast height and added-mass
coefficient are unchanged. There is no runtime hull-tuning or rebuild system.
The refined hull displaces 79.59 m³ / 81.58 t and retains the measured 5.96 s
roll period, leaving motion changes to `docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md`.

### M2 — Rig, static · **DONE**, and reviewed by eye

See `docs/ship/SHIP_RIG_HANDOVER.md`. Delivered: spars with rake, standing rigging as a
topology graph, ratlines, channels and chain plates, **running rigging** (sheets,
halyards, topping lifts, braces) with the deck fittings they belay to, and
**eight** sails set — not furled. 13 draw calls, 28,306 triangles. Hydrostatics
were measured against the drawn spars and the disagreement reported rather than
applied; see that document's section 6.

**A second pass rebuilt the sail plan.** The square topsail was in the wrong
century (an 1850s double topsail on a 1765–1780 vessel), the main topmast carried
five metres of bare stick where a gaff topsail belongs, and Ash's review then
found around twenty further faults — **every one of them with the test suite
green.** They were all in relationships the tests had no category for: sails
against tops, gaffs against tops, ropes against cloth, ropes against the hull,
and the rig's own guess at where the bulwark was. `docs/ship/SHIP_RIG_HANDOVER.md` §3 is
the write-up, and it is the most useful thing to read before the next milestone.

One structural change reaches outside the rig: **`hullForm.ts` now owns the
bulwark and caprail dimensions** (`railSection()`), because `rig.ts` was placing
every fitting on the rail against a hardcoded stand-in for a wall it could not
see. `shipGeometry.ts` imports them and its geometry is byte-identical.

**Originally scoped as:** masts, topmasts, bowsprit, gaffs, booms, fore-topsail yard; standing
rigging as a topology graph; shrouds, ratlines, stays, backstays, deadeyes,
channels, chain plates; sails present but **furled only** — reuse the existing
furl approach from [Raft.ts](src/vessel/raft/Raft.ts).

Topside mass moves to the real spar geometry, so M0's hydrostatics get their
first real perturbation — re-verify `GM` and `T_roll` after this lands.

**Accept when:** silhouette reads as a topsail schooner at distance; perf budget
still passing *with* ratlines; hydrostatics re-verified.

### M3 — Walkable deck · **DONE**

See `docs/ship/SHIP_DECK_HANDOVER.md`, which is the authority; sections 8–11 are the
second slice. Delivered: the walkable deck as a surface both the loft and the
character controller consume, a collision model derived from the rig's own lists
*and* from the deck's furniture, the character controller in ship-local space,
the embodied camera re-anchored to the body it now has, the quarterdeck ladders,
and the deck furnished — cargo hatch with a grating you stand on, bilge pump,
mast partners, windlass, the bowsprit's heel bitted and gammoned, and a tiller
with the arc it sweeps.

**Accepted against its own gate**: a player walks bow to stern and around both
masts without snagging, proved by a flood fill driven through the walker's own
move routine; no collision gaps; motion comfortable in `CURRENT_MODERATE` and
survivable in `WIND_CHOP`, asserted by `ship-hydrostatics.test.ts`. Ash walked
her furnished and signed off.

**What moved out of M3 rather than being finished in it**, with reasons —
`docs/ship/SHIP_DECK_HANDOVER.md` §6 carries the list:

- **Touch controls for walking.** The camera and the sail have had touch since
  the camera round; the body does not. An input-parity task, not a deck one.
- **A player-facing field-of-view setting.** The slider is a developer control
  and persists nothing. A settings task.
- **Standing on her in `SOUTHERN_OCEAN_ROUGH`.** The gate asks for moderate and
  chop, and both are asserted. Rough weather was a stretch goal and it needs
  Ash at the keyboard, not a test.
- **Three rope-versus-spar fouls** of 9, 13 and 25 mm at the mastheads. M2
  leftovers, listed in `ship-rig.test.ts` with measured depths.
- **The dressing pass** — casks, barrels, chests, dinghy, binnacle, stern
  lantern, skylight. Deliberately deferred: it is loose gear, and loose gear is
  what M6 will want to move, lash and wet. The companionways want M4's
  below-deck to exist first.

**The embodied camera was anchored to the raft castaway's eye** — 0.905 m above
the baseline, which on the schooner is three metres below the deck and 1.4 m
below the sea. `V` aboard her put the camera inside the hull, in the shipped
build, and nothing gated the toggle.

Originally scoped as:

The first genuinely new system.

**Build:** character controller in ship-local space (§3.1); collision surfaces
emitted by deck construction; deck fittings that affect circulation — hatches,
bitts, capstan, pump, tiller with its real arc; the comfort work.

Expect to revisit head stabilisation
([EmbodiedCameraController.ts:117](src/camera/EmbodiedCameraController.ts:117)).
Those constants were found for a *seated* castaway; a walking player adds
self-generated motion on top of the ship's. The file's own warning applies:
the player's inner ear says the room is still.

**Accept when:** a player can walk bow to stern and around both masts without
snagging; no collision gaps; motion is comfortable in `CURRENT_MODERATE` and
survivable in `WIND_CHOP`.

### M4 — Below decks · medium risk · **structural slice DONE, see `docs/ship/SHIP_INTERIOR_HANDOVER.md`**

The two-storey surface contract, the companionway and the cabin as a bare lit
volume have landed, and the sea is kept out of her by a stencil mask
(`scene/interiorStencil.ts`) — the cabin sole is 0.15 m above the design
waterline and the hold's floor will be below it, so the ocean needed a notion of
the hull it had never had.

**Still open in M4:** the §10 spaces are not started, and the companion ladder is
a domestic stair rather than a ship's ladder. See `docs/ship/SHIP_INTERIOR_HANDOVER.md`.

**The floor plan for the rest of M4 is agreed and drawn:
`docs/ship/SHIP_BELOW_DECKS_PLAN.md`.** Five spaces on three floor levels, joined
bow to stern, with a platform deck over the hold — 49.3 m² of walkable floor
against the 9.37 m² that exists. It also carries four findings for the code,
including a bilge pump that is drawn 1.95 m from where it is weighed.

**Build:** captain's cabin in full (`docs/ship/SHIP_SPEC.md` §9); companionway traversal
to the quarterdeck; interior lighting zones and portal occlusion; other spaces
as volumes at low detail (§10); low-detail hold suggestion under the cargo hatch.

Interior lighting is a real render change, not dressing: everything currently
assumes you are outdoors under sky ambient, sun and moon. The cabin must **be
dark**, lit through stern windows and the companionway, with the gimballed
lantern as a real light. `Lamp.ts` is the precedent.

**Accept when:** the cabin is the warm refuge the spec asks for at night; no
light leaks through hull or deck; transition from deck to cabin holds exposure
plausibly.

### M5 — The climb · **BUILT, on `claude/coord-m5-climb`, gates green, Ash's verdict owed**

Originally scoped as:

**Build:** authored climb spline in the ship's frame (§3.4); named anchors —
climb-start, transitions, lookout-standing; lookout platform and lifelines;
the aloft comfort treatment.

`docs/ship/SHIP_SPEC.md` §5.4 has the numbers: ±20° of roll swings the lookout ±3.9 m at
5.8 m/s and 0.86 g. This is not the deck at altitude.

**Accept when:** the climb is legible and continuous; the lookout gives an
unobstructed horizon and a view down over the deck; comfortable in moderate
seas and *deliberately* dramatic in heavy ones.

**§20 below is the M5 record** — what was built, the numbers behind every
decision, what is gated, what is owed, and what to look at first.

### M6 — Sails alive · medium risk

**Build:** the six principal sails as deformable meshes; wind coupling; the
operational configurations. The rigging graph from M2 is what makes the states
coherent.

### M7+ — Dressing and detail

Anchors and cable, windlass, dinghy lashed aboard, stern lantern, binnacle,
signal halyards, painted trail boards, expedition chests, weathering passes,
LOD.

---

## 7. Migration — complete; the raft remains diagnostic

The schooner has replaced the raft in production. The historical migration
sequence below explains how that change was kept safe.

- M0 generalises the physics with the raft as the first client, proving the
  refactor by leaving raft behaviour bit-identical.
- M1–M5 build the ship **alongside**, in isolated inspection harnesses of the
  kind `BuoyancyLab.ts` and `OceanLab.ts` already are.

  **This was not free, and an earlier version of this document said it was.**
  `BuoyancyLab` originally reached into raft-specific state at seven sites.
  That seam is now the shared `SimHandle.vessel` contract. **The M1 decision was a thin
  ship viewer of its own**, followed by generalising the lab over that seam once
  M3 gives the ship something worth stepping through frame by frame.
- The swap happens once, late, when the ship is genuinely better.

### What carries over

`RaftBuoyancy`'s architecture (§4) · the sail shader approach
([Raft.ts](src/vessel/raft/Raft.ts)) · `Lamp.ts` as the model for real
light sources · `OvertopSpray.ts` · the whole camera system · the debug labs and
evidence-capture tooling · deterministic-LCG construction so the ship is
identical on every load.

### What does not

The raft's log and beam geometry · `EYE_ANCHOR` and `HEAD_CENTRE`
([EmbodiedCameraController.ts:76](src/camera/EmbodiedCameraController.ts:76)),
both derived on paper from the seated figure · `buildFigure()` · the
mast-tap picking targets in `InputController` · the raft's 3×8 station grid.

---

## 8. Open questions, deliberately deferred

- **Where does she sail?** `docs/ship/SHIP_SPEC.md` §1 leaves the ocean open. The
  planetary world model makes this a real decision with real consequences
  (`docs/world/WORLD_MODEL.md`).
- **Below-waterline finish** — pale composition, dark merchant coating, or
  copper. Copper implies money and a wealthy refit; it is a fiction decision,
  not a material one (`docs/ship/SHIP_SPEC.md` §16).
- **Does the player ever take the tiller?** The spec says the crew work her
  continuously. Steering would be a system, not a prop.
- **Main-topmast staysail** — permitted but not required (`docs/ship/SHIP_SPEC.md` §7.1).
  Decide at M6 on visual value.
- **Pitch period confidence.** The ~2 s estimate is weak. M0 measures it; if it
  lands far off, §5.3's resonance analysis needs revisiting.

---

## 9. Starting cold

Read `docs/ship/SHIP_SPEC.md` first, then §2 and §4 here.

**M0, M1 and the accepted hull refinement are done.** The next planned ship
milestone is M2, the static rig. Read the motion handover before changing GM,
added mass, damping or sea-state response, and do not re-fair the hull without
re-running the complete ship test set.

Run `npm test` before touching anything; do not rely on a stale hard-coded test
count in this document.

---

## 20. M5 — the climb and the foremast lookout

**Branch `claude/coord-m5-climb`. `npm test` 1616 green, `npm run
test:slow:rig-geometry` green, `npm run build` clean.** Everything below is
built and gated except where it says otherwise; §20.9 is the owed list.

Ash has not seen it. The accept-when's *"legible"* and *"deliberately
dramatic"* are feel verdicts nobody but him can give, and §20.10 says exactly
what to try and in which sea states.

### 20.1 What was built

| File | What it is |
|---|---|
| `src/vessel/schooner/lookout.ts` | The fore top planked, railed and rigged: planking, four stanchions, two rope lifelines, a futtock stave and two futtock shrouds a side with rungs across them. Also the stance, and the two lines up the gang. |
| `src/vessel/schooner/riggingClimb.ts` | The authored spline: eight named anchors, the ladder of holds under it, arc-length traverse, the pose, and the two boxes a hand points at. |
| `src/vessel/schooner/aloftState.ts` | How far up the body is, and the lay-down flag. `seatState.ts`'s shape, one module over. |
| `src/vessel/schooner/aloftComfort.ts` | §5.4 recomputed against the built ship, and `ALOFT_STABILISATION`. |
| `tests/ship-aloft.test.ts` | 60 gates. |

Touched: `rig.ts` (publishes the top's member proportions), `rigGeometry.ts`
(lofts the lookout; the crosstrees now read those proportions rather than
keeping their own copy), `shipStations.ts` / `seatState.ts` (two climb rows),
`EmbodiedCameraController.ts` (a sway term), `CameraPanel.ts` (its slider),
`VesselRuntime.ts` / `main.ts` (the axes reach the station), `RuntimeOptions.ts`
(`?interiorView=lookout`).

### 20.2 The climb is a station, not a machine

**The interior round's station table took a climb without a line changing**, and
that is the design worth keeping. `shipInteractables` offers the verb where a
body can take it; `SeatedStation` writes the eye while it is taken;
`seatState.ts` holds one name. A climb needs all three and nothing else — it is
entered by pointing at a thing, it holds the body where it stood, it owns the
eye until it lets go, and a body is in one of them at a time.

The one thing it adds is that **its pose moves**, and `SeatedStation.step`
already asked for the pose every frame and wrote the eye to it exactly. A moving
pose was never ruled out; nothing had needed one.

Two things did not fit and were placed rather than forced:

- **The progress has nowhere on a station row to live.** Rows are pure functions
  and hold no state. It is `aloftState.ts` — the split `closures.ts` /
  `shipClosures.ts` and `seatState.ts` / `shipStations.ts` already use.
- **`SeatPose`'s cone is declined.** Every other row clamps the head and
  `yawRange` calls the width "the whole design". A lookout's job is to look
  everywhere, and a clamp that dragged the view round as the pose turned would
  be a camera moving by itself at the one place a player cannot brace. The range
  is a full half-turn either way, so the pose's facing is read only by the
  settle. `riggingClimb.climbPose` argues it.

`ShipStation.room` gained `'weatherDeck'`. The eleven below-decks rows are swept
by `ship-interior.test.ts` against a room's sole and deckhead; a gang of shrouds
has neither, so that file now filters to `BELOW_DECKS_STATIONS` and says why.
Filing the climb under the forecastle would have been worse than excluding it —
the forecastle is a real place two metres under the planking the climb starts
on, and every assertion would then have measured against the wrong room *and
passed*.

### 20.3 The spline and its anchors

Eight, both gangs, one expression with a sign. Port and starboard are never
typed out twice. The spline is **centripetal Catmull–Rom over the anchors,
traversed by arc length** — a spline's own parameter runs fast through the long
straight and slow round the corners, so a body advanced at a constant rate in
`u` sprints up the gang and stalls at the rail.

| Anchor | Hold | Eye (port gang) |
|---|---|---|
| `climbStart` | deck, inboard of the bulwark | 1.67, 5.62, 3.36 |
| `railCrossing` | the caprail, astride | 2.11, 6.26, 3.36 |
| `shroudFoot` | first ratline above the cap | 2.42, 6.52, 3.40 |
| `shroudMid` | mid-gang | ~1.5, 9.6, 3.5 |
| `shroudHead` | last rung on the vertical | ~0.87, 11.8, 3.6 |
| `futtockStave` | the stave, body swung out | 1.00, 12.60, 3.05 |
| `topRim` | over the after edge | 1.00, 14.06, 3.05 |
| `lookoutStand` | the planking | 0.48, 14.36, 3.33 |

About 9.7 m of path at **1.05 m/s**, one rate both ways — roughly nine seconds
deck to top. W climbs, S descends; no second binding, the same arrangement the
fore scuttle uses.

**The eye path is the spline, and the holds are a separate derived list.** That
is what "no IK" buys: a foot path would need a body, a body needs a posture, a
posture aloft is a lean. So each anchor carries an `eye` (the camera) and a
`hold` (what a body has its weight on), and `climbHolds` fills in *every drawn
rung between them* out of `RATLINES` and `futtockRungY()`. The continuity gate
walks that ladder. A spacing change in `rig.ts` therefore fails a test rather
than quietly leaving a gap.

**Leaving is a descent, not a release.** Every other station puts the eye back
on a body 0.6 m away; this one is nine metres up. Space aloft sets the body
going down at the climb rate and the station lets go at the foot — one button
that always works, the whole way down visible, and any upward input cancels it.
Three verbs from one row: `Go aloft` / `Lay down on deck` / `Step down on deck`,
plus `Hold on` while it is descending.

### 20.4 The lookout, and why it is that size

The fore top is **boxed in on four sides**, and every dimension is one of them
talking rather than taste:

- **The fore gaff, from below and aft.** It sweeps ±51.5° and its upper surface
  reaches this planking's underside at 0.97 m from its throat. The structural
  after edge — the after crosstree arm's face at 2.987 — leaves **10 mm**. The
  measured trade is in `LOOKOUT_Z_AFT`'s comment: 2.987 → 10 mm; 3.020 → 35 mm;
  **3.050 → 59 mm**; 3.080 → 82 mm. 3.05 is the row where a spar is no longer
  nearly touching a floor and a body still fits.
- **The fore lower yard, from above and forward.** Slung at 12.45 and 7.5 m
  long; braced hard its after face passes z = 3.35 at a metre off the
  centreline. Above it there is **95 mm** to the crosstree arms, which is not a
  gap a head goes through.
- **The doubling, up the middle**, 0.22 m across at this height.
- **The topmast backstay, through the after-outboard quarter.**

So: planking 1.70 m × 0.57 m over the two arms, **no lubber's hole** (there is
no 0.4 m square of that frame that is not structure carrying the topmast, and
all six shrouds converge on the masthead so the gang arrives *at* the mast), and
the way in is **futtock shrouds landing on the after edge**, spread
athwartships, with the climb coming up abaft the top. That is the only quadrant
that is not gaff, yard or backstay.

The result holds **exactly one body with 25 mm to spare at each end**. The
stance is derived — the centre of the planking less a body's radius, less the
doubling — rather than placed, because at 25 mm a typed number is a number that
stops being true.

`FUTTOCK_STAVE_Y` is derived too, and it is the arithmetic that makes the climb
work at all: a body's eye is 1.48 m above its rung and the planking's underside
is 12.73, so the eye reaches the planking when the feet are at 11.25 — where the
gang is 0.39 m off the centreline, well inside a 0.85 m half-span. **A body still
on the gang when its head reaches the top's level has its head inside the top.**
It has to leave earlier, so the stave is the highest drawn ratline whose eye
still clears — 11.117, a rung and not a round number.

Eye standing there: **14.36 m, which is 10.14 m above the deck** — inside §15's
9–11 m band. **The planking itself is 8.62 m up, which is 0.4 m short of that
band**, and §5.4's "the lookout sits ~10 m above deck" is the reading that makes
both work. Recorded so nobody re-derives it and calls it a fault.

### 20.5 The comfort treatment, and the numbers behind it

**§5.4's table is about 8% low, and it is not a typo.** It works from "~11.5 m
above the roll axis"; reconstructing its arithmetic exactly (`11.5·sin20° =
3.93`, `11.5·0.349·ω = 4.23`, `11.5·0.349·ω² = 0.455 g`, all three reproducing
the printed row) shows the 11.5 was taken as ten metres above deck with the roll
axis near the waterline. **The waterline is not the roll axis.**
`BuoyantBody.transform` rotates every local point about the centre of mass, and
`massModel` puts it at **y = 1.887** — 0.66 m below the waterline. The real lever
is **12.48 m**.

| Sea | Roll | Lateral | Peak speed | Peak accel |
|---|---|---|---|---|
| `CURRENT_MODERATE` | ±8° | ±1.74 m | 1.83 m/s | 0.20 g |
| `MATURE_WIND_SEA` | ±20° | ±4.27 m | 4.59 m/s | 0.49 g |
| `SOUTHERN_OCEAN_ROUGH` | ±34° | ±6.98 m | 7.81 m/s | 0.83 g |

**All of it is translation, and that is the whole finding.** Roll and pitch are
rigid-body attitudes: the masthead has *exactly* the deck's. Twenty degrees is
twenty degrees whether you are on the planking or ten metres over it. There is
nothing in §5.4 that says the angular follow fractions should differ aloft, and
a different number up here would be a number with no cause — so
`ALOFT_STABILISATION` inherits `WALKING_STABILISATION`'s angles **unchanged, and
that is a decision rather than an omission.**

What differs is the position, by the ratio of two levers: 3.85 m standing on
deck against 12.48 m on the top — **3.2×**. And until M5 the embodied camera
passed the eye's horizontal position through *whole*: there was no term that
could do anything else. Heave had `heaveFollow`; sway had nothing.

So `HeadStabilisation` gains **`swayFollow`** — the horizontal analogue,
applied to the deviation from the same 2.2 s running mean, so the vessel's own
progress across the ocean is never lagged. It is **1 everywhere but the
masthead**, and aloft it is **0.872**, derived and not chosen:

> A body aloft is not welded to the platform. It stands with a hand through the
> lifeline, and a neck holds a head upright while the ship rolls under it. An
> upright body's eye is `eyeHeight` above its *feet*, vertically; a rigid one's
> is `eyeHeight` along a mast that has rotated. The fraction is the ratio of the
> two levers — `(12.7625 − 1.887) / (14.3625 − 1.887) = 0.872`. **It is the same
> uprightness the angular terms already claim, applied to the position they were
> never applied to.** The camera has always attenuated the head's rotation and
> never the head's position, which presents a head turned toward vertical still
> standing at the end of a rigidly-rotated 1.6 m neck.

**Why not more.** Everything the fraction removes is eye-to-feet offset. At
`SOUTHERN_OCEAN_ROUGH` the raw excursion is 6.98 m, so the largest fraction that
keeps the eye inside a platform whose half-span is 0.85 m is about **0.867** —
and the physically-derived 0.872 sits just inside it. The agreement to half a
percent is the useful part: **there is no comfort available above the bound.** A
camera attenuated enough to matter is a camera standing off the edge of its own
planking, which is a worse failure than a big swing.

**Why the drama survives being trimmed by an eighth.** A translation at altitude
is nearly invisible against what you are mostly looking at: four metres of sway
is 0.05° of parallax against a 5 km horizon, and the near geometry translates
*with* the eye. The one thing that moves is the ship 10.2 m below, and it swings
**47° peak-to-peak across the view at `MATURE_WIND_SEA` and 71° in the worst
sea** (52° and 77° untrimmed — the treatment costs a tenth). That is where the
drama lives, it arrives for free, and nothing here touches it.

The slider is in the camera panel beside the other three, which is how the roll
and pitch fractions were settled in the first place.

### 20.6 What is gated

`tests/ship-aloft.test.ts`, 63 cases, both gangs throughout.

- **The frame is asserted first.** Everything is ship-local; the climb starts on
  a deck `deckStandAt` agrees is there and ends on planking the platform agrees
  is there, both on the right side. A spline authored in the rig's frame and
  read in the ship's would come out a plausible half-metre wrong and nothing
  else would fail.
- **Continuity, in metres.** Every consecutive pair of holds within a rung's
  step (0.62 m), except the one authored stride over the caprail (1.05 m, named
  and allowanced separately). Never downward, except the last stride across the
  planking. Every rung hold coincides with a drawn `RATLINES` entry.
- **Both directions.** The descent is *driven through the state machine* at the
  same rate with the forward axis held at −1, has to touch every anchor, and has
  to land the eye within 50 mm of the climb-start eye — which is what makes
  `standUp` a settle rather than a fall. Up and down agree to within four
  frames.
- **The eye path.** No sample-to-sample step over 30 mm, monotone in height, and
  **never more than 0.45 m from a drawn rung beneath it** on the gang stretch —
  the gate that makes "legible" measurable rather than a look.
- **Nothing passes through anything.** Every spar, every standing-rigging run,
  the lookout's own timber and lifelines, and the cloth, swept across the trim
  envelopes of the mainsail, foresail and fore topsail. Clearance 0.10 m, chosen
  against the camera's 0.06 m near plane and not as a structural margin — a
  climber's whole business is being close to the rigging, and the same file
  asserts the eye is never *more* than 0.4 m off the shrouds it is on.
- **The platform against the swung gaff**, over the whole ±51.5°, and against
  every sail through its own trim range.
- **Nothing aloft is a collider**, asserted by measuring the whole lookout above
  the obstacle index's ceiling.
- **The view, with rays.** The 160° sector through the bow is clear of solid
  obstruction from both stances; no more than 10 bearings of 72 are blocked at
  all; over half the sampled deck is visible from each side, including the
  waist, the quarterdeck and the head.
- **The motion.** §5.4's arithmetic reproduced exactly at the lever the spec
  assumed, the real lever measured against the centre of mass, the sway fraction
  equal to the uprightness the angles claim, and the residual eye-to-body offset
  asserted smaller than the platform's half-span in the worst sea in the table.
- **The station machinery.** Both boxes' `xLo < xHi` on both sides; each gang
  offered from its own foot and refused from the other rail; the take/leave
  driven through the registry row rather than by synthetic key events.

### 20.7 Faults found on the way, all real

1. **The gang was asked about the eye's height, not the feet's.** A shroud gang
   converges on the masthead, so asking it where it is 1.48 m further up put the
   eye that much further inboard than the body — and at the top, past the hounds
   entirely, **103 mm inside the foremast**. Fixed; the standoff and the rise are
   applied to where the feet are.
2. **The climb rode the middle shroud rather than the gap between two.** The
   gang's centreline is the mean of three seats 0.38 m apart, which *is* the
   middle shroud. 62 mm from a 36 mm rope, against a 60 mm near plane. Fixed:
   `foreGangGapAt` rides the gap between the forward and middle shrouds.
3. **"Give it more room" was the wrong direction.** Leaning 0.20 m out and
   0.11 m aft over the top's corner measured *worse* than 0.15 m straight out:
   92 mm from the backstay and 71 mm from the gaff, against 227 mm and 134 mm.
   There was more room; it was in the other direction.
4. **Pre-existing, M2's, reported not fixed:** the fore gaff at large ease
   reaches into the outboard end of the **forward crosstree arm**.
   `ship-rig.test.ts` checks a gaff against its own top but only against the
   *trestletrees* (0.23 m half-breadth) and only at the *authored* trim; the arms
   are 0.85 m and the foresail eases to 51.5°. A test now pins the depth so a
   future round notices, but fixing it means either shortening the arms — which
   are what the topmast shrouds spread to — or capping the foresail's ease, which
   is a sailing decision, not a geometry one.
5. **The topsail was invisible to every test in the file**, and a screenshot
   found it. See §20.8.

### 20.8 The square topsail owns the forward view

The fore topsail's foot is bent to the lower yard at 12.45 m and its head is at
18.20, so it stands across the fore top from below the lookout's feet to well
over her head. **Measured from the stance: 0.38 m at the worst brace on the port
top, 0.42 m on the starboard.** Set, you cannot see the bow from up here, and no
arrangement of a platform on this mast changes it — the sail is *on* this mast.

That is true of the vessel rather than a fault in her. What *was* a fault is that
every intersection test measured the eye against timber and rope, and cloth is
neither — the same shape of gap as the rig round's "sails were checked against
`SPARS`, so the tops went unchecked". It took a screenshot to see.

Two responses, both deliberate:

- **The arrival facing is 150° off the stern on her own side, not dead ahead.**
  That is the sector a lookout on a top actually has — beam round toward the
  bow on the side she is standing, clear of the cloth and clear of the doubling.
  The other bow belongs to the other gang. Gated: the arrival look is forward of
  the beam, outboard of the mast, and runs into nothing.
- **The near approach is measured and asserted**, at 0.30 m, so cloth cannot get
  into the lens.

**This is the thing to look at first, and it is a design question, not a bug.**
A fore top under a set square topsail may simply be the wrong place for a
lookout on this vessel, in which case the answer is the *main* topmast — which
has crosstrees at 13.70 and no square sail — and M5's machinery moves there for
the cost of one table row. Or it is right and interesting, and the answer is
that you furl the topsail when you go up to look. Ash decides.

### 20.9 Owed, and honestly not done

- **A cloth occlusion sweep.** What is gated is the nearest approach and the one
  arrival bearing. What is *not* is "how much of the horizon do the set sails
  take" — an attempt measured 45 of 72 bearings blocked and was wrong, because a
  bilinear sail patch sampled on a grid puts points within a third of a metre of
  almost any ray cast over forty metres. It needs real triangle-ray intersection
  against the drawn surface, not a proximity test. The test file says so where
  the sweep would go.
- **No performance number, deliberately.** The machine was thermally throttled
  and none was taken. **But §5 of this document predicted this milestone is
  where an unstated budget gets discovered, and it should be said loudly: the
  cost is real and it is not measured.** The lookout adds ~40 solids — planking,
  four stanchions, six lifelines, four futtocks, two staves, twelve futtock
  rungs — to a static loft step, which is small. The thing to measure is **the
  frame at the masthead**, not the geometry: the eye goes from 5.7 m to 14.4 m
  and the near geometry falls away, so cloud, ocean and shadow all get a
  different workload from anything the perf work was baselined on. A cold pass
  should take the ship's GPU time and the frame time at `?interiorView=lookout`
  against the same scene on deck, in `MATURE_WIND_SEA`, at the same time of day.
  Nobody has looked.
- **The furled-topsail case is unmeasured.** Every cloth number above is at full
  hoist.
- **The lower yard passes 109 mm from the eye at full brace**, and the eased gaff
  134 mm. Both pass the gate and both are close.
- **`DECK_OBSTACLES` reads the rig once at module load** — the known deferred
  cross-coupling. It did **not** bite: the climb is authored, the walker is held
  on deck throughout, and nothing aloft has a collider. Recorded because the
  brief asked whether it would.

### 20.10 What Ash has to judge, and how to get there

`?interiorView=lookout` opens standing on the **starboard** fore top with the
body left on deck at the foot of the gang, so Space starts an honest descent and
lands somewhere you can walk away from. `?debug` for the camera panel and its
new **Sway follow** slider.

To do it properly: aboard, walk forward to the fore shrouds — either side — look
at them and press Space.

1. **Is the climb legible?** Nine seconds, W and S. Does it read as a ladder, or
   as being winched? Watch the rail crossing and the swing out onto the futtocks
   in particular — both are authored moves and both are where it would read as a
   lurch.
2. **The arrival.** You come over the after edge and step in. Does the platform
   read as somewhere to stand?
3. **The topsail.** §20.8. Furl it and look again — that comparison is the whole
   question.
4. **The motion, in three seas.** `CURRENT_MODERATE` should be comfortable;
   `MATURE_WIND_SEA` is the design case and should be *dramatic and bearable*;
   `SOUTHERN_OCEAN_ROUGH` should be frightening. The thing to watch is **the ship
   below you**, not the horizon — that is where the arithmetic says the motion
   lives, 47° of swing at the design sea.
5. **The sway slider.** 0.87 is shipped and derived. Try 1.0 (the whole of it)
   and 0.6 (past the bound, where the eye leaves the platform). If 1.0 feels
   better, say so — the derivation is honest but it is still a model, and the
   deck's own fractions were settled by exactly this.

**Do not judge the composition against a stale build.** Half an hour of this
round was spent looking at `master` through a dev server started in the parent
checkout — the trap `drift-below-usable`'s launch entry already warns about.
Check `window.__drift.cameras.stabilisation.swayFollow` exists before believing
anything you see.

### 20.11 Follow-up: the climb and the core action picker

Ash's first walk-through found three climb faults that were one interaction
fault: a lower-deck lamp or scuttle could answer while he looked at the mast,
the gang required Space at both ends, and its below-deck tolerance offered
*Go aloft* from the forecastle. The correction is one coherent pass, not three
priority exceptions.

- `Interactables` now ranks explicit gaze first and proximity second. Being
  inside a floor-sized target says only that it is reachable; it no longer
  manufactures zero-angle intent. Floor objects use the same 35° cone as every
  other object.
- A target owns its reachable side. Closures with two faces carry two records:
  the wardroom/hold faces of the hatchway and weather-deck/forecastle faces of
  the scuttle. Lamps and stations carry their room. This makes decks and
  bulkheads semantic occluders while retaining legitimate two-level hatches.
- The lower foremast is gaze geometry for each gang. Looking at it or up it from
  the appropriate foot therefore means *Go aloft*; the reach volume itself is
  clamped to the actual weather deck, so the same gaze below decks cannot.
- Walking outboard into the ropes from 0.45 m takes the ordinary climb station.
  Holding descent through the foot releases it. A release latch prevents that
  held input from immediately taking the climb again during the settle.

The same regression pass covers the reported wardroom case (looking at an
officer's berth while near the hatchway boards), the cabin desk/lantern overlap,
both sides of the two-level closures, both climb gangs and every below-decks
space. The captain's berth privacy curtain was also found to be a decorative
false affordance: it is now a stateful closure with gathered-open and opaque
pleated-closed geometry. Closed, it screens the berth and removes the berth's
selection target until drawn back.
