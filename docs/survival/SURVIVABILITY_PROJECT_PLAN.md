# Ship survivability — green water, flooding, capsize, and sinking

Status: authorised 2026-08-17. This is the canonical roadmap for consequences
of severe weather. It consolidates work that was previously scattered across
the wake, ship-motion, interior, closures, weather, and provisioning documents.

## 1. Outcome

Severe seas must become physical threats rather than dramatic backgrounds.
Water that crosses the rail or enters an opening must be conserved, move to a
real low point, drain or be pumped, alter the vessel's mass and stability, drown
interior systems, and—if the crew loses the fight—produce capsize or sinking.

The target player story is legible without a developer panel:

1. a crest comes aboard at a place and direction the contact model measured;
2. water visibly runs across the deck toward scuppers and openings;
3. open closures admit water below while shut ones prevent it;
4. the bilge rises, lamps drown, and the pump has a reason to exist;
5. shipped water makes the next roll worse through weight and free-surface loss;
6. drainage, pumping, course, canvas, and closures can recover the ship;
7. an unrecovered vessel can downflood, capsize, founder, or sink.

No scripted “health reaches zero” shortcut may replace this chain.

## 2. What exists now

- `BuoyantBody` integrates heave, pitch, and roll from distributed hydrostatic
  contacts at 240 Hz. The hull has a real righting moment and amplitude-dependent
  roll damping.
- The body emits `OvertopEvent` records containing position, depth, entry speed,
  horizontal flow, fixed-step duration, canonical station identity, resolved
  rail side, contact width, and tributary deck area. Presentation consumes them.
  The production horizontal-motion path now resolves those facts into conserved
  named deck-cell ingress without feeding the resulting water back into motion.
- The production schooner reaches roughly 38° roll beam-on in
  `SOUTHERN_OCEAN_ROUGH`, within two degrees of the hard attitude limiter.
- `HULL_ATTITUDE_LIMIT_RADIANS` clamps pitch and roll to ±0.7 rad. A capsize is
  therefore impossible by construction, regardless of sea or damage.
- The cargo hatch boards, fore scuttle, and stern deadlights are one closure
  table read by interaction, geometry, light, and collision systems.
- A deck pump, tube, and bilge well are drawn and geometrically continuous.
  They move no water and have no operating interaction.
- Interior lamps already accept a flooding ratio and extinguish progressively;
  no production flooding state drives it.
- The wake plan explicitly deferred slamming loads, green-water loads, and
  shipped-water mass to this stream.

## 3. Rules

1. **Conserve water.** Every ingress, transfer, drain, and pump term is a volume
   rate integrated on an authoritative clock. Presentation never invents mass.
2. **One compartment graph.** Flooding, light, closures, interaction, sound, and
   later provisions read the same named spaces and openings.
3. **Contacts remain facts.** Overtopping detection stays in `BuoyantBody`.
   This stream converts detected crossings into flux; it does not retune waves
   until evidence proves the detector itself wrong.
4. **Fixed-step outcomes.** Caller rate, time compression, panel visibility, and
   render quality cannot change accumulated water.
5. **No capsize flag.** Capsize is an attitude and energy outcome of the rigid
   body. “Capsized” may be derived for gameplay only after the body is there.
6. **Openings are geometry.** A hatch admits water only when its closure and the
   water path both permit it. Vertical proximity is not a water path.
7. **Pumps have capacity and labour.** A decorative pump animation or passive
   magic drain is not the system.
8. **Large-angle physics precedes limiter removal.** The current limiter cannot
   be deleted until immersion, restoring arm, integration, and rendering are
   tested through knockdown, inversion, and recovery.
9. **Every dramatic preset gets an outcome ledger.** For each heading and sail
   plan: shipped water, drained water, maximum bilge, maximum roll, downflooding,
   capsize, and survival time.

## 4. Authoritative model

### 4.1 Water volumes

`ShipWaterState` owns stable records for:

- weather deck cells, split fore/aft and port/starboard so water can run with
  gravity and heel rather than becoming one centred weight;
- hold/bilge;
- wardroom;
- forecastle;
- captain's cabin;
- the companionway landing, because it is a real reachable intermediate volume;
- later local damage voids without changing the public contract.

Each record carries water volume, free-surface area, centroid in the ship frame,
and maximum geometrically meaningful capacity. Rooms use the existing space
bounds; the weather deck needs its first named volume rather than another set of
hand-authored boxes.

### 4.2 Openings and transfers

One directed opening graph describes:

- rail and bulwark entry from overtopping events;
- deck scuppers to sea;
- hatchway and fore-scuttle paths from deck to rooms;
- room-to-bilge leakage and limber holes;
- pump suction from the bilge and discharge overboard;
- future hull breaches.

Flow uses available head, opening area, discharge coefficient, orientation, and
closure state. Every edge reports its integrated volume so conservation can be
asserted exactly apart from recorded numerical tolerance.

The four weather-deck nodes also have eight directed numerical interfaces: both
directions across the beam in each longitudinal half and both directions across
the fore/aft split on each side. They are control-volume boundaries, not physical
apertures. SURV1's transport core compares mean shallow-water surface heads
under the production roll/pitch convention, then moves only a bounded fraction
of the pairwise equalising volume on the same 240 Hz water clock. The body
publishes its start-of-step pitch and roll beside each contact step, so
production consumes the pose actually used by that step rather than repeating
the frame-final attitude across the batch.

### 4.3 Overtopping flux

The event now carries fixed-step duration, resolved contact width, and tributary
deck area from the same station geometry that detected the crossing. SURV1's
pure provisional broad-crested-weir resolver converts head and width to bounded
flow with its theoretical coefficient named and cited. The 39 station strips
partition the 15.5 m hull length exactly, and each event owns one rail side and
one half-deck tributary prism. The ingress boundary validates station index,
fixed-step identity, canonical z, width, and tributary area before routing.
Repeated facts for the same station and substep are de-duplicated; distinct
simultaneous station strips add because their longitudinal widths do not
overlap. The unity coefficient remains the ideal critical-depth result and a
transparent provisional upper-bound input: deterministic game evidence bounds
its output but is not physical full-scale calibration, and it must never be
fitted to a desired sinking time.

### 4.4 Stability coupling

Flood water contributes:

- weight at the live water centroid;
- pitch and roll moments as it moves;
- vertical, pitch, roll, and yaw inertia;
- free-surface correction proportional to the liquid surface's second moment;
- damping from internal slosh only after the quasi-static model is stable.

The dry mass model remains immutable provenance. A separate dynamic-load seam
publishes the water mass properties into buoyancy and horizontal dynamics once
per fixed substep. It must not be approximated as only an external downward
force: doing so changes displacement without changing inertia or centre of mass.

### 4.5 Capsize and sinking

Large-angle hydrostatics must be validated across at least 0–180° roll and
represent loss and possible recovery of righting arm. The attitude representation
must pass through 90° without clamping or Euler discontinuity in physics.

Sinking is derived when flooding plus lost reserve buoyancy drives the hull to a
stable state with critical openings submerged and no recoverable pumping/drainage
path. The first milestone may model an intact hull only; breach damage is later.

## 5. Rounds

### SURV0 — Baseline and architecture

Status: `complete` (2026-08-17; see `SURV0_SURV1_FOUNDATION.md`).

- Freeze deterministic severe-sea cases by heading, speed, sail plan, closure
  state, and duration.
- Record current overtop flux inputs and the exact attitude-limiter touches.
- Define `ShipWaterState`, compartment names, opening graph, and dynamic-load
  seam without changing production behaviour.
- Add conservation and caller-rate test harnesses.

Gate: zero-water state is bit-identical to current motion and presentation.

Gate result: passed. The production schooner owns an exact-zero water sidecar,
but no water load is read by either motion solver. A paired 180-frame dynamics
test compares every published vertical/attitude scalar with `Object.is` while
advancing the dry ledger and finds bit identity.

### SURV1 — Water on deck

Status: `in_progress` (boarding ingress and production deck-transport gates
landed; wash remains open).

- Extend overtopping facts with tributary geometry.
- Convert crossings into conserved deck-water volume.
- Advect water across named deck cells from ship-frame gravity and heel; add event momentum only with evidence.
- Draw a shallow wet/wash layer from the authoritative volume.

Gate: a deterministic boarding sea produces the same integrated ingress at
30, 60, 120, and 240 Hz; no event means exactly zero water.

Boarding-ingress gate result: passed. A fixed 22 s `SOUTHERN_OCEAN_ROUGH`
boarding case at 75° presentation heading emits 835 canonical station contacts,
ships 0.6005345832978084 m³, and produces byte-for-byte equal result objects at
30, 60, 120, and 240 Hz. Its maximum simultaneous contact is eight disjoint
station strips (3.1794871794871793 m); none of the events reaches the tributary
prism cap. A 2,400-substep no-event run leaves every compartment, ledger term,
and the canonical dynamic-load object at exact zero.

Deck-transport gate result: passed. A fixed 0.12 m³/s rail inflow for
2 s at 0.24 rad roll and 0.10 rad pitch is then transported for an 8 s total
run. The complete four-cell state, ledger and dynamic-load view are strictly
equal at 30, 60, 120 and 240 Hz; 0.24 m³ remains aboard, internal transfer is
positive, no cell becomes negative, and conservation residual remains below
1e-12 m³. A separate 2,400-step dry run returns the canonical empty request and
zero-load objects throughout.

Production composition gate result: passed. Every completed body step publishes
the start-pose attitude used by its contact solve under the same batch index as
its overtopping facts. Production validates that one-to-one clock, resolves
boarding and transport from the same pre-step ledger, and applies both together;
newly boarded water can move on the following step, not through an
order-dependent same-step chain. The 22 s rough-sea case remains byte-for-byte
equal at 30, 60, 120 and 240 Hz with 835 contacts, 0.6005345832978084 m³ aboard,
positive internal deck transfer and no rejected volume. The no-event production
path remains exact zero and reuses its attitude objects, cached ingress result
and canonical empty resolver. Wash presentation remains open, so SURV1 itself
is not yet complete.

### SURV2 — Scuppers and drainage

Status: `in_progress` (authored geometry and headless positive-head drainage
landed; production wave sampling, blocked arms, and the full calm-drainage gate
remain open; see `SURV2_SCUPPER_FOUNDATION.md`).

- Author scupper positions and effective areas from deck geometry.
- Drain only when the outlet has positive head to sea.
- Preserve trapped water on the low side under heel.
- Add blocked-scupper diagnostic arms for evidence.

Gate: calm drainage closes a mass ledger; heel changes side and rate correctly.

Foundation gate result: passed. Sixteen authored 0.42 × 0.13 m freeing slots
are placed from the canonical deck edge and bulwark geometry, grouped as four
physical apertures per existing fore/aft-side graph edge. They provide 0.4368
m² clear area per side and use a named provisional 0.61 discharge coefficient.
A pure resolver integrates free and submerged rectangular-slot head across the
pitched slot width, requests only positive inside-to-sea discharge, converges
continuously to its canonical dry result, favours the low side under heel, and
produces strict-equal ledgers at 30, 60, 120 and 240 Hz. It is not yet wired to
production body/world-wave samples or rendered as holes in the bulwark.

### SURV3 — Downflooding and closures

Status: `not_started`.

- Define the weather-deck volume and connect hatchway/scuttle openings.
- Use live closure state and actual opening geometry.
- Transfer water between rooms and bilge through named paths.
- Drive room flooding ratios, lamp extinction, and appropriate sound muffling.
- Add rain ingress through open closures once WX5 exists.

Gate: shut closures admit exactly zero; open closures admit water only when a
physical water surface reaches them.

### SURV4 — Pump and crew response

Status: `not_started`.

- Make the existing deck pump operable through the repaired action model.
- Model stroke volume, cadence, suction head, priming, and discharge.
- Give the crew an order and duty station; time compression advances labour,
  not an instantaneous water deletion.
- Report bilge depth and pump effectiveness through an in-world sounding.

Gate: pumping removes exactly the discharged volume and cannot draw below the
suction level or exceed the pump's physical capacity.

### SURV5 — Flood-water mass and free surface

Status: `not_started`.

- Add dynamic mass, centre-of-mass, and inertia to both motion solvers.
- Apply free-surface stability correction from each live compartment.
- Let deck water run to leeward and feed back into heel.
- Produce righting-arm and roll-decay evidence at controlled water loads.

Gate: zero load reproduces baseline; symmetric fixed water changes sinkage but
not heel; asymmetric/free water changes heel and GM in the predicted direction.

### SURV6 — Knockdown and capsize

Status: `not_started`.

- Replace the ±0.7 rad attitude clamp with validated large-angle integration.
- Validate station immersion and restoring moment through 180°.
- Handle mast/sail water contact and canvas consequences at minimum viable
  fidelity; sails cannot keep producing ordinary air forces underwater.
- Derive knockdown, capsized, inverted, and recovered states from attitude and
  angular motion.

Gate: calm releases recover below the positive-stability limit; cases beyond
the limit capsize without NaNs, teleporting, or an authored outcome flag.

### SURV7 — Foundering and sinking

Status: `not_started`.

- Couple downflooding to reserve buoyancy and opening submergence.
- Model progressive loss of freeboard and pump head.
- Add abandon-ship/end-state seams without scripting the physical descent.
- Preserve canonical world position and time throughout sinking.

Gate: survivable cases recover; unrecoverable cases cross named physical
thresholds and descend continuously.

### SURV8 — Presentation, sound, and final ledger

Status: `not_started`.

- Deck wash, interior waterline, wet materials, pump animation, slosh, drains,
  hull groans, alarms, and thunder/wind composition.
- Player footing and interaction consequences on wet/heeled decks.
- Mobile/quality caps that never alter physics.
- Final severe-sea matrix and cumulative performance ledger.

Gate: every consequence has a physical source, every quality arm preserves the
same outcome, and all roadmap acceptance cases are recorded.

## 6. Deterministic case matrix

At minimum:

| Case | Heading / state | Closures | Expected purpose |
|---|---|---|---|
| Dry control | `FLAT`, stopped | all shut | bit-identical zero-water control |
| Rain control | heavy rain, calm | all shut/open pair | weather ingress and closure gate |
| Moderate bow boarding | `CURRENT_MODERATE`, reach | all shut | deck flux and scupper recovery |
| Southern reach | `SOUTHERN_OCEAN_ROUGH`, working sail | all shut | survivable heavy-weather case |
| Southern running | 135° off bow | scuttle pair | known overtop-rich downflooding case |
| Beam-on knockdown | Southern, no corrective helm | mixed | free-surface and capsize boundary |
| Extreme failure | `EXTREME_DEBUG` | openings open, pump idle | bounded unrecoverable foundering |
| Pump recovery | matched ingress initial condition | pump crew active | capacity and recovery proof |

Each records ingress, drainage, transfers, pump discharge, total onboard water,
mass-ledger residual, maximum roll/pitch, limiter contact, downflooding time,
capsize time, and final disposition.

## 7. Dependencies and lanes

- The interaction-system repair precedes the pump action.
- WX5 rain feeds SURV3 but does not block overtopping, scuppers, or pumping.
- S7 captain controls will eventually surface closure, course, canvas, and pump
  orders; this roadmap exposes commands without inventing a second order system.
- Wake presentation may read water-on-deck facts but never writes them.
- Provisioning may later make flooded stores consequences; it cannot own water.
- Terrain and global travel are independent except for save-state versioning.

## 8. Immediate queue

1. **Complete (2026-08-17):** justify the event contact width from the exact
   39-strip hull partition and bound the explicitly provisional unity discharge
   coefficient against deterministic boarding-sea evidence; neither is fitted
   to sinking.
2. **Complete (2026-08-17):** route resolved event volume into the correct named
   deck cell on the water clock, validating canonical station ownership and
   de-duplicating only repeated station/substep facts.
3. **Complete (2026-08-18):** add bounded, conservative four-cell deck transport
   under ship-frame heel and pitch, with exact dry and caller-rate gates.
4. **Complete (2026-08-18):** publish one start-pose attitude fact per body
   substep and compose boarding plus transport without frame-final smearing.
5. Draw the shallow-wash presentation from authoritative cell volumes.
6. **Complete (2026-08-18):** author sixteen freeing slots from the canonical
   deck/bulwark and prove free/submerged positive-head drainage, heel-side
   selection, exact dry bypass and caller-rate equality headlessly.
7. Compose scupper drainage with each production water substep's body pose and
   outside wave height; add blocked-scupper arms and close the calm-drainage
   ledger gate.
8. Replace the large-angle graph clip and Euler/positive-up guard before any
   attempt to remove the production attitude limiter.
