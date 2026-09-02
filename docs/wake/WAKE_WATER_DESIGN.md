# Ship–sea interaction — wake and water effects design

**Status: design authority, 2026-08-06. WK0–WK2 are implemented and both GPU
budget gates have passed. On 2026-08-07 Ash directed the combined wake on by
default; later the same day the WK-R recovery round fixed a trail-destroying
advection defect, recalibrated the deposits, and built §4.5's wave pattern
ahead of the WK4 gate — the gate's "subtle at her Froude numbers" premise was
wrong at the 3.5–4.1 m/s Ash actually sails (Fr 0.30–0.35). §2's third bullet
should be read with that correction. WK-R merged to master on 2026-08-08 with
Ash calling it an improvement but not finished; visual calibration of the
combined look is his open checkpoint, and no WK-R gain is accepted yet. State
in `docs/wake/WAKE_WATER_HANDOVER.md`.** Companion plan: `docs/wake/WAKE_WATER_PROJECT_PLAN.md`,
which sequences this into rounds WK0–WK5.
Baseline assumption: sailing rounds **S1–S4 are merged** — the schooner moves
under sail force with commanded steering and live trim, so speed through
water, heading,
course and turn rate are all real, driven quantities rather than tow-harness
inputs.

This is the thread `docs/ship/SHIP_MOTION_PHYSICS_HANDOVER.md` §Phase 4 ordered kept
separate from the physics work, and the one its "recommended following
implementation" list names as unlocked by the hull-contact contract: bow
splash and entry spray, stern and divergent wake emitters, overtopping with a
physical source. `README.md` states the gap plainly: *"There is still no sail
drive, commanded rudder force, current or wake."* Sail drive and rudder have
since landed. This project deletes the word "wake" from that sentence.

---

## 1. What this project is, and is not

**Is:** the visible consequences of a hull moving through water. Five
phenomena, one thread: the turbulent trail astern, the bow wave and its foam
collar along the waterline, episodic bow splash and entry spray, overtopping
acknowledgement (ported from the raft, which has it, to the schooner, which
returns a hard-coded zero — `Schooner.activeOvertopSprayCount()`), and — as an
explicitly optional last phase — the Kelvin wave pattern.

**Is not:** physics. Nothing in this project applies a force to the ship,
writes to `CanonicalWorldState`, or alters what the buoyancy sampler sees.
Slamming impulses, green-water loads and shipped-water mass belong to the
motion physics thread (its Phase 4) and are not built here; where this project
wants a slam *cue* it keys off the same `normalEntrySpeedMps` the physics
would use, without waiting for or creating the force. If the physics thread
later lands real slamming events, the cue re-points at them.

The relationship to the existing ocean systems is **consumer, not owner**.
`WaveField` owns evaluation and phase; `FoamField` owns whitewater
persistence; `CrestSpray` owns airborne water; the sea state decides what the
sea is. This project adds *hull-sourced inputs* to those systems and only
where unavoidable adds new machinery of its own.

---

## 2. What the sea actually does around this hull

The schooner's working envelope, from the committed polar
(`evidence/ship-sailing/polar-baseline.json`): roughly 1.5–3.5 m/s through
the water in ordinary winds. Her hull speed is **4.7 m/s** — the classic
1.34 kn·√LWL(ft) for the 14.3 m waterline, canonical as
`SAILING_HULL_SPEED_MPS` in `SailingForceEvidence.ts`; the 5.875 m/s figure
that appears in the sailing documents is that same number times the polar's
stated 1.25 surfing allowance, not a competing bound. `wakePolicy.ts`
non-dimensionalises against 4.7 and saturates above it (the agreement between
the two constants is pinned by test). All this places her at low-to-moderate
Froude number in normal sailing, which decides what her wake honestly looks
like:

- **The turbulent trail dominates.** A displacement sailing hull at 6 knots
  leaves, above all, a smoothed, bubble-laden band astern: hull-boundary-layer
  turbulence flattens the short chop, entrained air whitens it, and the band
  survives for tens of seconds — visibly *calmer and paler* than the sea
  beside it long after any wave pattern has dispersed. No propeller wash: she
  is quieter astern than any motor vessel, and the trail is the wake.
- **The bow work is second.** A bow wave stands at the stem, sheets up the
  hull as speed rises, and breaks into a white collar running aft along the
  waterline. In any seaway this is punctuated by events: the bow drives into
  a crest and throws spray. The events are episodic and directional, not a
  continuous fountain.
- **The wave pattern is third, and subtle at these speeds.** Transverse wake
  wavelength is `λ = 2πV²/g`: 4.3 m at 2.6 m/s, 7.2 m at 3.35 m/s — short
  waves of low amplitude, easily lost under any real sea. The divergent arms
  at the Kelvin half-angle (19.47°) read clearly only on near-glassy water.
  This ordering is why the Kelvin pattern is the *last* phase and an explicit
  Ash decision gate, not the headline: on most of this game's seas, honest
  physics says you would barely see it.
- **Leeway shows in the trail.** She does not travel the way she points; the
  trail streams along the *course*, not the heading, so the wake leaves the
  quarter at a small angle. This falls out of correct architecture for free
  (§4.2) and is exactly the kind of quiet truth this codebase values —
  the trail is a visible record of leeway, tacks and turns.

Everything above scales with two inputs: **speed through water** and **how
much the ambient sea is already doing**. A wake must vanish gracefully at
anchor and drown gracefully in `SOUTHERN_OCEAN_ROUGH`, where the sea's own
whitewater out-shouts anything the hull adds.

---

## 3. Design invariants

Numbered so round specs can cite them. These bind every WK round.

1. **One-way coupling.** Physics → effects, never back. No forces, no state
   in `CanonicalWorldState`, no change to what buoyancy or resistance sample.
2. **One geometry.** Every effect reads `HullWaterContact` (station regions,
   waterline intersections, relative flow, entry speeds) and, where needed,
   `hullForm.ts` derivations at module load. No second waterline, no
   effect-private hull model. If a needed fact is missing from the contract,
   extend the contract; do not re-derive beside it.
3. **The surface stays authoritative.** The CPU/GPU wave parity that the
   buoyancy round bought is untouchable. Any wake *displacement* is
   presentation-only (fragment/normal work, or vertex offsets the physics
   never samples) and is recorded in the simplifications ledger (§9) as a
   documented lie.
4. **Persistence lives in `FoamField`.** No parallel trail buffer, no sprite
   ribbons astern. Hull-sourced whitewater is *injected* into the existing
   field and inherits its advection, decay, lighting and breakup for free.
   The field is indexed in Gerstner parameter space and already carries its
   contents past a moving observer (`observerVelocity` in
   `FoamField.simulate`) — the trail-behind-the-ship problem is *already
   solved* by that one line, including turns and leeway. We add sources, not
   mechanisms.
5. **Policy, not presets.** One scaling policy maps
   (speed through water, sea state, wind) → every subsystem gain,
   continuously. No per-preset wake tables.
6. **Spray obeys the spray lessons.** Airborne water uses `CrestSpray`'s
   aerodynamic model — relaxation toward wind minus terminal velocity, no
   ballistic gravity arcs — and is lit with foam-equivalent gains. Both
   lessons were paid for once (`docs/ocean/OCEAN_CREST_SPRAY_REPORT.md`: the arcs, and
   the spray that was lit ten times darker than the foam it came off) and are
   not to be re-learned.
7. **Determinism where evidence looks.** Anything an exporter or test
   measures is seeded and fixed-step. Visual-only jitter may use unseeded
   randomness only where `OvertopSpray` already does.
8. **Perf is budgeted, not hoped.** The whole thread ships within **1.5 ms
   GPU on the desktop baseline** (2560×1440, M2, default cinematic view,
   `CURRENT_MODERATE`), measured by the paired-interleaved-blocks method
   (`docs/ocean/OCEAN_PERF_HANDOVER.md`), against a frame currently at ~17–19 ms. Each
   round carries its own slice of that budget and measures off/on.
9. **Anything visible needs Ash.** Every round with a visible change ends in
   an A/B checkpoint at agreed reference states before merge.
   "Pixel-identical" is the only self-certifiable visual claim.
10. **Surface findings in full.** Anything wrong or suspicious found along
    the way goes in the round handover, in scope or not. Ash decides scope.

---

## 4. Architecture — five subsystems

### 4.1 Sources: the contact contract feeds everything

`Schooner.body` is a shared `BuoyantBody`; its `contacts` buffer
(`HullWaterContactView[]`) is refreshed every physics step with, per station:
bow/midships/stern and port/centre/starboard classification, active waterline
intersection points on each side, water and hull-point velocities, their
difference, `normalEntrySpeedMps`, immersion ratio, and `overtopping`. The
`overtopEvents` list is populated by the same detection the raft's spray
already consumes.

The effects layer receives, per rendered frame:

- the contact buffer (read-only view, no allocation);
- the resolved observer velocity through the wave frame (`encounterVelocity`
  in `main.ts` — canonical horizontal velocity in the local frame, the same
  vector the foam advection already consumes);
- the sea state and wind the other ocean consumers read.

Speed through water is `|encounterVelocity|` until the physics thread lands
current and leeway decomposition; when it does, this layer re-points at speed
through water proper. One adapter (`WakeSources`, new) condenses contacts
into the small set of numbers the consumers below want — stern waterline
segment, bow waterline points, per-region mean entry speeds, event list — so
the shader- and particle-facing code never iterates stations itself.

### 4.2 Persistence: the foam field grows a third channel

`FoamField` stores R = active foam (τ ≈ 0.7 s) and G = residual foam
(τ = the sea state's persistence). The texture is RGBA; **B is free**, and it
becomes **hull turbulence**: the smoothed, aerated water of the trail,
injected at the stern and along the breaking bow collar, decayed with its own
time constant (order 20–40 s, policy-scaled), advected identically to foam.

Injection: the existing inject pass evaluates sources per texel; hull sources
arrive as a handful of uniforms (stern segment endpoints, bow points,
per-source radius and strength from the policy) and accumulate in the same
pass — no new render pass, no new target. Foam injection (R and G at the bow
collar and stern, for the white component) and turbulence injection (B, for
the smooth component) share those uniforms. Decay generalises `uDecay` from
vec2 to vec3. The advect/decay blend treats all channels alike today; the
implementing round must verify the blend state against a third channel and
the alpha write rather than assume it.

What this buys, for nearly nothing: the trail streams correctly astern
because injection happens at the hull while the field's contents are carried
backwards past the observer; it curves through tacks because injection
follows the actual track; it shows leeway because advection uses the velocity
vector, not the heading; it heaves with the swell because the field rides
Gerstner parameter space; it is lit, broken up and streaked by machinery that
already exists. `warmUp()` cannot reconstruct a pre-existing trail after a
reset (it knows the sea's history, not the ship's); a reset therefore starts
her trail-less, which is accepted and documented.

### 4.3 The smooth band: what the trail looks like when the white fades

The B channel's consumer is the ocean fragment shader: where hull turbulence
is present, damp the detail octaves and flatten the micro-normal — the glassy
band — and mildly suppress ambient whitecap injection so the trail reads as
*worked* water, not just white paint. The pale bubble haze comes from a small
albedo term scaled by B, distinct from the R/G foam texture so a faded trail
is smooth-and-pale rather than foam-textured. This is the single highest-value
visual in the project: it is what makes a wake legible at a glance in
photographs of real sailing vessels, and it survives long after the foam.

### 4.4 Particles: bow spray, and the overtop port

One new emitter, `BowSpray` (working name), owning episodic airborne water at
the hull: entry spray when bow-region stations close with the surface above a
threshold `normalEntrySpeedMps`, throw direction from
`relativeWaterVelocityWorldMps` and the surface normal — never a scripted
"up and out". It follows `CrestSpray`'s droplet-ensemble model and lighting
(invariant 6), at a capped budget (order 200–400 particles desktop). Whether
it is implemented as its own points system in `CrestSpray`'s image or as a
second emission source *into* `CrestSpray`'s existing pool is the
implementing round's call after reading that class — the report's
merge-don't-duplicate history (`Spindrift` was deleted for good reasons)
argues for feeding the existing pool if its schedule allows.

Overtopping: `OvertopSpray` already consumes `BuoyantBody.overtopEvents` and
the schooner already produces them; the port is wiring plus re-tuning
`strength()` for a 15.5 m vessel's freeboard, and making
`Schooner.activeOvertopSprayCount()` honest.

### 4.5 The pattern: Kelvin wake, optional and last

An analytic hull-frame pattern in the ocean shader — transverse wavelets at
`λ = 2πV²/g` and divergent arms at 19.47° — as normal perturbation only, no
vertex displacement in the first cut. Gated by speed, faded by ambient sea
energy (§2 says honest physics barely shows it on rough water) and faded by
turn rate, because an analytic steady-state pattern is only true on a straight
run; the trail handles turns truthfully, the pattern declines to lie about
them. This subsystem is behind an explicit **decision gate**: after WK1–WK3
land, Ash looks at the ship and decides whether the pattern earns its
complexity at all. It is designed so that cutting it removes a shader block
and nothing else.

---

## 5. The scaling policy

One module (`wakePolicy.ts`, new) maps the drive inputs to every gain:

- **Speed through water** sets bow-collar strength (onset ~0.8 m/s, saturating
  toward hull speed), stern injection rate (∝ V², capped), turbulence decay
  target, pattern amplitude and wavelength.
- **Sea state** sets masking: ambient whitecap fraction raises the floor the
  wake must clear; on `SOUTHERN_OCEAN_ROUGH` the trail narrows to what a real
  sea would let survive, and entry-spray thresholds rise so only genuine bow
  plunges fire above the ambient violence.
- **Wind** tears the bow collar downwind at the same coupling `CrestSpray`
  uses, so hull spray and sea spray never disagree about the wind.

Numbers above are engineering priors to seed the A/B, not commitments; each
is a named constant in the policy with a comment tying it to what Ash actually
accepted. Perceptual targets to calibrate with Ash at three reference states
(glassy long swell · `CURRENT_MODERATE` · `SOUTHERN_OCEAN_ROUGH`), all at
polar speed for the state's wind:

1. Trail legible for **2–4 boat lengths** astern in moderate conditions.
2. Bow collar visible from the deck (embodied camera) at working speed.
3. In the storm, the hull's own effects read as *punctuation* over the sea's
   violence — never a clean painted V on top of chaos.

---

## 6. Lighting

Hull-sourced foam and turbulence inherit the ocean shader's foam lighting
because they live in the same field — no separate shading path exists to
drift out of agreement (the exact failure `docs/ocean/OCEAN_CREST_SPRAY_REPORT.md`
records for spray). `BowSpray` takes the foam-equivalent gains from the same
optics profile as `CrestSpray`. Night: the trail is whatever the foam is
under moonlight, for free; the lamp lighting the near wake from the deck is a
check in the night A/B, not a new system.

---

## 7. Performance

Budget: **≤ 1.5 ms GPU desktop** for the whole thread (invariant 8),
provisionally sliced: trail + smooth band 0.6, bow collar 0.2, spray 0.3,
pattern 0.3, reserve 0.1. Mobile: injection uniforms cost the same, particle
caps halve, the pattern is off by default. Measurement per round: the
headless paired-interleaved-blocks method with the effect toggled off/on
(every subsystem gets a lab toggle the day it is born, which is also what
makes the A/B possible). The foam inject/advect passes run at 24 Hz over
256²+128² texels; added per-texel uniform math there is near-free, and the
ocean-shader additions (B lookup shares the existing foam fetches; the
pattern block) are where the budget actually goes.

---

## 8. Validation and evidence

- **Headless exporter** (`npm run ship:wake` → `evidence/ship-wake/`):
  seeded runs at the three reference states × polar speeds, recording
  per-region waterline-crossing rates, entry-speed distributions, overtop
  event counts, injection-source values over time. Deterministic JSON,
  regenerated only intentionally, committed with the code that changed it
  (house rule). WK0 builds it *before* any effect exists, so every later
  round's emitters are sized against measured contact statistics rather than
  guesses, and so policy changes show up as diffs.
- **Contract tests:** injection sources zero at zero speed; sources follow
  the course vector under leeway (sign test, born the same day as the code —
  this codebase has burned rounds on signs); B-channel decay exactness;
  pattern wavelength matches `2πV²/g` analytically.
- **Contact sheet** (`wakeContactSheet.ts`, in the `shipContactSheet` mould):
  pinned camera, the reference states, effect toggles in all combinations,
  for the A/B record.
- **Perf pairs** per round, as above.

---

## 9. Simplifications ledger

Documented lies, deliberate:

1. No displacement coupling: the wake does not lift the hull or alter
   buoyancy; the surface the physics samples is wake-free (invariant 3).
2. The trail does not damp *incoming* waves; it damps rendered detail and
   whitecap injection in its band. A swell rolls through the wake unchanged.
3. Entry spray keys off contact kinematics, not a slamming pressure model;
   slam forces are the physics thread's Phase 4, not ours.
4. The Kelvin pattern (if kept) fades under turn rate rather than bending;
   the trail is the truthful record of the track.
5. Overtopping remains an acknowledgement, not water on deck; shipped-water
   mass is explicitly out of scope (motion handover's own rule).
6. A world reset starts trail-less; foam warm-up cannot invent hull history.
7. Wake sources are point/segment approximations of a continuous hull —
   stations quantise the waterline, and the collar interpolates between them.

---

## 10. Open questions for Ash

1. **Exaggeration policy.** Honest wakes at these Froude numbers are subtle.
   How far toward "beautiful lie" do we push the trail's persistence and the
   collar's brightness? (The A/B reference-state targets in §5 are my
   proposal; they are yours to move.)
2. **The Kelvin gate.** Prior probability the pattern earns its shader cost
   on this game's seas is maybe 50%. Happy to build WK4 last and let you kill
   it at the gate.
3. **Where does the budget come from?** 1.5 ms rides on a frame you fought to
   18 ms. If that is too rich, the pattern and half the spray budget are the
   compressible items.
4. **Embodied-camera priority.** The deck view sees the bow collar and spray
   up close and the trail barely at all; the cinematic camera reverses that.
   Which view leads the tuning?

---

## 11. Planned file map

| Concern | File |
| --- | --- |
| Contact → source condensation | `src/vessel/WakeSources.ts` (new) |
| Scaling policy, all gains | `src/scene/wakePolicy.ts` (new) |
| Hull-source uniforms in inject pass, B decay | `src/scene/FoamField.ts` (extend) |
| Smooth band, pale haze, whitecap suppression, pattern block | `src/scene/Ocean.ts` + `src/scene/shaders` (extend) |
| Entry/bow spray emitter | `src/scene/BowSpray.ts` (new) or fold into `src/scene/CrestSpray.ts` — implementer's call, §4.4 |
| Overtop port | `src/vessel/schooner/Schooner.ts` + `src/scene/OvertopSpray.ts` (retune) |
| Lab panel + toggles | `src/debug/OceanLab.ts` / `SchoonerViewer.ts` (extend) |
| Contact sheet | `src/debug/wakeContactSheet.ts` (new) |
| Evidence exporter | `tools/export-ship-wake.mjs` (new), `npm run ship:wake` |
| Evidence | `evidence/ship-wake/*.json` (new) |
| Wiring | `src/main.ts` (minimal, additive) |
