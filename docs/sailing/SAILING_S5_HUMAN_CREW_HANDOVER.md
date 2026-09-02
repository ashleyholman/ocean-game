# S5 human crew control — approved implementation handover

**Status: APPROVED DESIGN HANDOVER · 2026-08-11 · IMPLEMENTED 2026-08-11
(helm) and 2026-08-15 (trimmers).** This is the implementation authority for
S5, and it remains the authority for what a *human* operator may know — S6's
navigator was built to the same contract. Where it is more specific than
`SAILING_MODEL_DESIGN.md` §7 or `SAILING_PROJECT_PLAN.md` §S5, this handover
supersedes those earlier words. For what was actually built, read
`docs/sailing/SAILING_ROUND_HANDOVER.md` §S5.

Read, in order:

1. `docs/sailing/SAILING_MODEL_DESIGN.md` — physics, controls and command tiers.
2. `docs/sailing/SAILING_PROJECT_PLAN.md` §S5 — round goal and inherited gates.
3. This handover — the agreed meaning of a *human* helmsman and trimmer.
4. `docs/sailing/SAILING_ROUND_HANDOVER.md` §S4 — the live control surface and
   its two-clock actuation rules.

*Historical note, checked 2026-08-17: this section used to warn against an
unaccepted implementation spike on `codex/s5-crew-orders` that wrapped exact
simulation telemetry in a continuous controller. That branch as it stands
contains only this document and the plan's S5 section — no code — and S5 was in
fact implemented from `master` against this handover, as instructed. The warning
is kept as a record of the decision, not as a live hazard.*

---

## 1. The correction

The old S5 wording asked for a "human-shaped" course holder, then named only a
deadband, yaw anticipation and the existing rudder rate limit. That was not
enough. A continuous controller with perfect heading, yaw rate, wind angle,
heel and luff state is still an autopilot even if its output moves slowly.

The governing requirement is now:

> **Crew may consume only simulated observations that a person aboard could
> plausibly obtain. Crew logic must never read exact vessel or aerodynamic
> truth directly.**

The complete path is:

```text
simulation truth
  → physical instrument / bodily or visual cue
  → perceived observation
  → spoken-order and human response state
  → discrete control decision
  → SailingControls target
  → existing fixed-step physical actuation
```

Each arrow is real state. Do not collapse instrument lag, perception delay,
decision delay and physical movement into one convenient smoothing constant.

### 1.1 What remains invariant

- `SailingControls` is still the sole actuator. Human operators write targets;
  they never write forces or current control positions.
- Crew and direct player control still use the same targets, limits and S3/S4
  actuation rates.
- Forces alone move the ship.
- Crew state remains vessel/control state, never `CanonicalWorldState`.
- All evidence is seeded and deterministic on the fixed 240 Hz substep grid.
- Direct player input wins immediately. A standing order may resume on release,
  exactly as the S5 plan states.

---

## 2. Agreed abstraction boundary

S5 assumes that a competent operator is already present at every station that
needs one. Operators can work different controls at the same time.

**In scope:**

- a physical compass-card model;
- plausible visual, bodily, wind/sail and tiller-load cues;
- imperfect zero-mean perception;
- variable attention focus rather than a fixed observation ticker;
- spoken-order duration, recognition, processing and motor-initiation delay;
- event-like helm and sheet interventions followed by observation;
- one generic, competent and actively working operator profile;
- a developer HUD that makes truth, indication, perception and action legible;
- deterministic headless evidence plus Ash's live feel review.

**Explicitly out of scope:**

- named crew, stable personal traits or persistent personal reading biases;
- watches, rosters, sleep, fatigue, morale, injury, skill progression or failure;
- walking to a station, availability, limited hands or task contention;
- misheard, misunderstood, refused or forgotten orders;
- detailed speech audio, line purchase, belaying, hand placement or animation;
- magnetic variation, vessel-specific compass deviation and navigation error;
- a rendered 3D binnacle or production player-facing order UI.

The future crew system inserts availability and travel here without replacing
S5:

```text
order understood → [future: wait / travel / take station] → human action loop
```

For S5 the bracketed phase completes immediately.

### 2.1 No artificial anti-synchronisation

Every staffed station owns its own order, observation and action state. Use
independent deterministic random streams and independently sampled transition
times. That will usually produce different timing, but **sails moving together
is not a failure and sails moving separately is not a gate**. Several crew may
plausibly act at once. Do not add offsets or a scheduler whose purpose is merely
to stop controls looking synchronised.

---

## 3. Spoken orders and human response

An order is an event, not an immediate mode bit. Its state path is:

```text
ISSUED → UTTERANCE COMPLETE → HEARD → PROCESSING → ACTING → WATCHING
```

For each order record at least its sequence id, kind, target station(s), issue
time and standing/cancelled state. For each target station record the phase and
transition times so the HUD and evidence can explain what happened.

### 3.1 Timing components

- **Utterance duration** belongs to the order and is shared by everyone who
  hears it. Model the time needed to say the whole command; acoustic travel
  across this vessel is immaterial beside human response.
- **Recognition delay** belongs to each station: notice the order and recognise
  that it applies there.
- **Processing delay** belongs to each station and order type: understand the
  required action.
- **Motor-initiation delay** is the interval between deciding and beginning the
  target change.
- **Physical actuation** is the existing `SailingControls` rate limiter, not a
  second sampled duration.

Sample a transition time once on entry to its phase. Never redraw it every
frame. Human response times are positive and right-skewed; use one named,
bounded shifted-gamma or shifted-lognormal profile rather than a symmetric
normal distribution. Put distribution parameters and bounds in one auditable
profile. The numbers are provisional until live review.

Use deterministic streams keyed by station and purpose (order response,
attention, perception, action). Adding a sail station later must not change the
helmsman's trace by consuming its random draws.

There is no stable per-person multiplier yet. Variation is event-to-event in
one generic competent-crew population. A later named operator may supply a
stable modifier without changing the phase model.

### 3.2 Standing versus direct orders

`trim to draw` activates a standing duty independently at each relevant sail
station after that station hears and processes it. Later hauling/easing comes
from the station's local observation loop, not repeated captain's orders.

A targeted direct order such as `ease mainsail` enters only the mainsail
station's response pipeline. S5 need not expose all such captain verbs, but the
order representation must not make them impossible.

Standing down is also a spoken order and ordinarily has a response delay.
Direct physical player takeover is not spoken: it overrides immediately.

---

## 4. Compass instrument contract

The S5 helmsman steers a **compass course**, not exact true course. Magnetic
north equals true north in S5 and settled compass deviation is zero. S6's
navigator will later own true-route-to-compass-course conversion, variation and
deviation.

The traditional presentation is a rotating compass card beneath a fixed
lubber line. The instrument model is authoritative for both crew perception and
the temporary HUD; do not create separate numbers for them.

### 4.1 Inputs and state

Only the instrument layer may receive exact vessel truth. It advances from the
previous completed fixed-step instant and owns, at minimum:

- wrap-safe indicated compass heading;
- card angular velocity;
- named response/damping parameters;
- a bounded seaway-disturbance state if required by the chosen physical model.

Model the card as a damped angular system, not `trueHeading + randomNoise`.
Required behaviour:

- finite response to a hull turn rather than a snap;
- plausible settling, including limited overshoot/oscillation if underdamped;
- wrap continuity through north;
- disturbance correlated in time and/or derived from vessel motion, never
  independent frame-white-noise twitch;
- zero long-term error in a settled, disturbance-free case.

Do **not** add a constant human reading bias. Transient perceptual error is
zero-mean. Do not add magnetic variation or compass deviation in S5.

The exact damping and disturbance values are tunable feel parameters. Establish
them with a committed step-response trace and the HUD before tuning the
helmsman around them.

### 4.2 Research basis

The model follows period seamanship rather than modern autopilot behaviour:

- The 1871 Royal Navy training manual describes the compass card moving beneath
  a lubber's point fixed in the ship's head:
  <https://whalesite.org/anthology/1870_Boys_Manual_Pages.htm>.
- Luce's *Text-Book of Seamanship* instructs the helmsman not to trust the card
  alone, but to alternate between it and the ship's head against clouds, sea or
  other external references; it also names helm pressure and wind as earlier
  cues to motion:
  <https://maritime.org/doc/luce/part7.php>.
- US Maritime Service training likewise warns against correcting every
  heavy-weather yaw and teaches experienced hands to watch the ship's head or
  horizon as well as the compass:
  <https://maritime.org/doc/merchant/deck/index.php>.

---

## 5. Helm observations

The helmsman receives a `HelmObservation`, never exact heading, yaw rate,
apparent-wind angle, heel or rudder-force telemetry. The observation layer may
derive cues from truth, but its public surface must expose only what the person
could plausibly know.

### 5.1 Sensory channels

**Compass reading — long-term course reference.** A delayed, limited-resolution
perception of the physical card. Preserve a short history so perceptual delay
reads past instrument state rather than the current value with noise added.

**Ship-head / horizon cue — short-term swing.** A coarse visual sense of the
bow moving against horizon, clouds, stars or waves. It provides turn direction
and trend sooner than the compass but is not an absolute true heading. Its
long-term reference ages and drifts, which is why the compass remains necessary.

**Wind and sail cue.** A delayed, coarse sense of apparent wind and whether the
working sails are beginning to luff or load. This is primary when steering by
wind angle and secondary when holding a compass course. It must not expose the
mathematical apparent-wind vector.

**Body-motion cue.** A coarse vestibular sense of a meaningful swing or heel.
Do not pass exact yaw/roll rates through under a human-facing name.

**Tiller-load cue.** Signed, filtered pressure in the hand, available regardless
of gaze focus. It says that the helm is light, loading, easing or receiving a
wave kick; it does not reveal an exact heading or yaw rate.

### 5.2 Tiller load

Derive tiller load from the existing rudder hydrodynamics and authored geometry:

- reuse the resistance evaluation's rudder inflow/force state;
- derive any stock/hinge arm from the canonical rudder geometry — no guessed
  second blade;
- derive hand force/torque through the existing `TILLER_LENGTH` authority;
- pin the sign with tests on headway, sternway and both helm directions.

This is a sensory output only. It must not add a second force to the vessel.
Detailed arm strength, fatigue and load-dependent injury are deferred. The S4
rudder movement limit remains the motor envelope for this round.

---

## 6. Helmsman attention and action

Do not implement a fixed one-second observation ticker. Smooth instruments and
perceptual histories may advance every fixed substep, while human decisions are
state/event driven.

The minimum focus states are:

- `LOOKING_AHEAD` — ship-head/horizon precision is highest; the last compass
  estimate ages.
- `CHECKING_COMPASS` — compass precision is highest after acquisition delay.
- `WATCHING_RESPONSE` — follows bow motion, card trend and tiller load while a
  correction takes effect.
- `CHECKING_SAILS_WIND` — wind/luff precision is highest, especially for
  apparent-wind steering.

Focus is not an exclusive on/off switch for all senses. Tiller pressure and
coarse body motion remain available; non-focused visual cues merely become less
precise. Looking away from the compass is ordinary helming, not negligence.

Choose the next focus and its bounded dwell from conditions plus the seeded
attention stream:

- remain engaged while acquiring, correcting or verifying;
- check the compass after an order, an uncertain swing or an ageing estimate;
- look ahead for short-term anticipation;
- spend longer away from the compass after the course has remained comfortable;
- look more often in a seaway without becoming a metronome.

Do not add rare gross distraction or fatigue events in S5.

### 6.1 Compass-course behaviour

A competent cycle is:

1. hear and process the ordered compass course;
2. acquire the card and establish a remembered course;
3. look ahead and feel the vessel while the course is acceptable;
4. detect a likely drift from visual/body/tiller cues;
5. check the card when confirmation or long-term correction is needed;
6. after processing and motor delay, request a modest rudder target;
7. watch the response rather than blindly holding the target;
8. ease or counter-correct as the ship answers;
9. re-check the card to remove accumulated visual error;
10. return attention ahead once settled.

This must produce recognisable intervention episodes: leave the tiller alone,
notice drift, correct, watch, ease, then leave it alone again. Do not calculate
and write an ideal rudder target every frame. Do not feed exact yaw rate into a
P-D law. Anticipation comes from recent perceived card/head trend and tiller
load.

Motor inaccuracy is transient and zero-mean: a requested correction may be a
little too much or too little and may be held slightly too long. No constant
left/right tendency is authored. Instrument lag, perception, vessel momentum
and motor delay should make overshoot emerge rather than adding a periodic
oscillator.

### 6.2 Apparent-wind behaviour

`hold apparent wind angle` remains an S5 order, but the helmsman must not receive
the exact apparent-wind angle. The wind/sail cue, horizon swing and tiller load
are primary; the compass is a secondary reference. Luffing in a puff may prompt
a human correction only after cue and response delay.

It is acceptable to implement and review compass-course steering first. S5 is
not complete until apparent-wind hold uses the same observation discipline.

### 6.3 Direct takeover

While the player holds the tiller, the helmsman writes nothing. Preserve the
standing order and age its observations normally. On release, the operator must
reacquire the situation before issuing a correction; do not resume with a
perfect immediate target from hidden truth.

---

## 7. Trimmer stations

The rig has eight sails but not eight independent continuous trim controls:

- independent sheets: mainsail, foresail, fore staysail, jib, flying jib;
- independent brace: fore topsail;
- main gaff topsail: slaved to the mainsail by the S4 rig contract;
- fisherman (`mainTopmastStaysail`): fixed trim with a commanded side/dip
  operation rather than ordinary continuous trimming.

Assume an operator is already at every station required by the current order.
Different stations may act concurrently.

### 7.1 Observation contract

A trimmer must not receive exact sail AoA, exact apparent-wind angle, exact heel
or the physics `luffing` boolean as knowledge. Build local perceived cues from:

- delayed/filtered onset and degree of luffing;
- coarse drawing/fullness response;
- coarse sheet/load cue if derivable without inventing new force geometry;
- wind/sail motion around the station;
- sustained bodily sense that the vessel is overpowered.

The ideal S4 trim-to-draw schedule remains an evidence/reference curve. It is
not an oracle the production trimmer may call every frame.

### 7.2 Action loop

For each independent station:

1. activate the standing duty after its spoken-order pipeline completes;
2. observe locally;
3. decide `acceptable`, `haul`, `ease`, `overpowered ease` or `cannot draw`;
4. after motor delay, request one finite target adjustment;
5. wait for enough physical/sail response to become observable;
6. reassess and make another discrete adjustment only if needed.

Each station owns its own timers and deterministic streams. Do not force or
forbid synchrony. Do not introduce crew capacity, walking or task allocation.

Heel response is likewise human: sustained perceived heel leads to delayed,
incremental easing. There is no exact threshold crossing at which every sheet
instantly receives the same formula.

Report `cannot draw` from sustained observed evidence, not one exact physics
flag. Set/reef/strike sequencing remains S6 except for existing direct S4
control operations.

---

## 8. Developer HUD — required acceptance surface

This is temporary developer UI, not the production S7 captain interface. It
must be cheap to remove or hide, but it is a required S5 deliverable because
Ash needs to judge the human rhythm directly.

### 8.1 Helm display

Show, compactly:

- rotating compass card beneath a fixed lubber line;
- ordered compass-course marker;
- helmsman's perceived compass reading;
- optional faint, explicitly labelled **DEV TRUTH** heading marker;
- actual rudder position and current requested target on one signed gauge;
- signed perceived tiller-load gauge (`light`, `loading`, `easing`, `heavy`);
- current focus and response phase;
- a visible pulse/marker whenever a new rudder intervention is decided, with
  direction and magnitude.

Add a short scrolling trace (roughly 30–60 seconds) of ordered course, true
heading, indicated card, perceived reading, requested/actual rudder and
intervention events. Truth is allowed in developer presentation; it is not
allowed in the controller input.

### 8.2 Crew/order display

For helmsman and each active sail station show the current order phase:

`ORDERED · HEARD · PROCESSING · ACTING · WATCHING · STANDING DOWN`

Expose sampled transition times or elapsed time so suspicious delays can be
explained. A sail-control action should identify `haul`, `ease` or
`overpowered ease` and the finite requested change.

The HUD must read the same instrument, perception and operator state used by
production logic. Do not reconstruct an approximate story for display.

---

## 9. Determinism and architecture gates

1. **No truth leak.** Helmsman/trimmer public inputs contain observation types,
   not heading, yaw rate, apparent-wind angle, exact heel, AoA or raw luff flags.
   Pin this structurally in tests.
2. **One actuator.** Crew only calls `SailingControls` target commands. Existing
   rate limits remain the only movement path.
3. **Fixed-step time.** Instruments, histories, sampled transition deadlines
   and actions are advanced on ordinary physics seconds on the 240 Hz grid.
4. **Caller-rate invariance.** Identical commands/seeds at 30/60/120 Hz caller
   rates produce identical fixed-step crew and control traces.
5. **Stream isolation.** Adding or disabling one sail station does not alter
   another station's or the helmsman's random sequence.
6. **No frame randomness.** No `Math.random`, wall clock or random draw per
   render/update frame.
7. **No anti-synchrony.** There is no phase offset or scheduler whose purpose is
   to make simultaneous sail motion impossible.
8. **No constant human bias.** Settled perceptual error is zero-mean; any future
   compass deviation belongs to the physical/navigation layer.

---

## 10. Evidence

Add a deterministic S5 exporter and committed baseline. The exact filename and
script may follow the established `ship:*` pattern, but the evidence must expose
the internal chain rather than only final RMS error.

### 10.1 Compass cases

- heading step in flat water: truth, card angle and card rate through settle;
- north-wrap steps in both directions;
- steady hull: zero long-term indicated error;
- repeated seaway case: bounded correlated agitation, no white-noise twitch;
- same seed identical; caller-rate invariant.

Gate settling time, overshoot and residual error with broad provisional bands.
The first browser checkpoint is allowed to retune those bands with Ash; record
the accepted values in the round handover.

### 10.2 Helmsman cases

For calm and `CURRENT_MODERATE`, record at fixed intervals and at every event:

- true heading;
- compass indication and card rate;
- perceived compass/head/wind/tiller cues;
- focus and order/response phase;
- intervention decision and sampled delay;
- requested and actual rudder;
- course error and vessel response.

Keep the plan's broad upper RMS bands (calm about 2°, moderate about 5°), but do
not accept accuracy alone. Also gate:

- nonzero order/perception/motor latency;
- a bounded human intervention rate rather than frame-rate target writes;
- meaningful intervals with an unchanged tiller target;
- visible drift/correct/watch/ease episodes;
- bounded overshoot and recovery;
- no exact relationship between one truth error sample and one immediate
  command;
- direct takeover silence and delayed reacquisition on release.

Do not use a token lower bound such as `RMS ≥ 0.05°` as proof of humanity. The
trace shape and event cadence are first-class evidence.

### 10.3 Trimmer cases

- standing-order activation delays per station are deterministic and bounded;
- no local adjustment begins before observation plus motor delay;
- controls move in finite haul/ease episodes with observation gaps;
- multiple stations may coincide or differ naturally — no synchrony gate;
- steady performance remains a stated useful fraction of the ideal S4 polar
  without reproducing it exactly;
- gust case: perceived overpowering, delayed incremental ease and bounded heel;
- a cannot-draw report requires sustained perceived evidence.

### 10.4 Spoken-order cases

- utterance duration is shared; station recognition/processing/motor delays are
  independently sampled;
- every in-scope operator eventually hears and acts — no failure model;
- same seed/order sequence is exact; unrelated station count does not perturb
  the trace;
- standing duty continues on local perception after the initial order.

---

## 11. Implementation sequence and mandatory checkpoint

Do not build the whole crew layer and present it as a finished fait accompli.

1. Build the fixed-step compass instrument, its step evidence and the compass
   portion of the HUD.
2. Build the helm observation types, tiller-load cue and attention/response
   state machine.
3. Implement compass-course standing order only, through `SailingControls`.
4. Add the helm trace/evidence and run the full non-slow suite.
5. **Stop for Ash's live review:** watch the card, gaze/focus state, tiller load,
   interventions and vessel response in `CURRENT_MODERATE`. Retune only against
   what is visible and record the accepted values.
6. Add apparent-wind steering through wind/sail observations; review again if
   its behaviour materially differs.
7. Apply the accepted human operator pattern to the trimmer stations and spoken
   multi-station orders.
8. Regenerate evidence, run the full relevant slow sailing gates, update
   `SAILING_PROJECT_PLAN.md`, and append the implementation truth to
   `SAILING_ROUND_HANDOVER.md`.

The round is not accepted until step 5 happens. Headless evidence may prove the
contract and bounds; it cannot certify that the helmsman's rhythm reads human.

---

## 12. Suggested file map

Names may change if the runtime architecture demands it; responsibilities may
not be collapsed:

| Responsibility | Suggested home |
|---|---|
| physical compass card | `src/vessel/schooner/crew/CompassInstrument.ts` |
| seeded streams and response profile | `src/vessel/schooner/crew/HumanOperator.ts` |
| spoken-order phases | `src/vessel/schooner/crew/CrewOrders.ts` |
| observation types/cue construction | `src/vessel/schooner/crew/CrewObservations.ts` |
| helm attention and decisions | `src/vessel/schooner/crew/Helmsman.ts` |
| per-station sail loops | `src/vessel/schooner/crew/Trimmers.ts` |
| orchestration and public API | `src/vessel/schooner/crew/SailingCrew.ts` |
| HUD | `src/debug/SailingCrewHud.ts` or the existing Sailing panel |
| deterministic evidence | `src/vessel/schooner/SailingCrewEvidence.ts` |
| contracts and gates | `tests/ship-sailing-crew.test.ts` plus focused files as useful |

If exact truth and human policy end up imported into the same module for
convenience, the architecture has already failed. Keep truth-to-cue adapters at
the boundary and keep operator inputs human-readable.

---

## 13. Acceptance statement

Ash must be able to watch the temporary HUD and explain every correction in
ordinary language:

> He was looking ahead; the bow began to fall off and the tiller loaded. He
> checked the card, decided it was worth correcting, put on a little helm,
> watched her answer, then eased before she crossed back too far.

And for a sail:

> The order reached that station; the hand saw the luff after a delay, hauled a
> finite amount, waited for the cloth to draw, and left it alone.

If the explanation instead is "the controller read the exact error and wrote a
new target," S5 has not met this handover regardless of its RMS score.
