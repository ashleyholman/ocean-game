# SURV0 / SURV1 boarding foundation handover

Status: updated and verified 2026-08-18. This note records the precise boundary;
it does not advance any later survival-round claim.

## What landed

`ShipWaterState` is the authoritative onboard-volume ledger. Its stable control
volumes are four weather-deck cells (fore/aft, port/starboard), hold/bilge,
captain's cabin, companionway landing, wardroom, and forecastle. Deck geometry
is integrated from the same cambered deck and bulwark levels used by walking
and drawing. Room geometry is integrated from the existing sole, side, and
deckhead queries. The hold entry is intentionally the known working bilge-well
volume; stow displacement and broader bilge runs remain future geometry work.

The directed opening catalogue now names four rails, four scuppers,
companionway, two cargo-grating halves, fore scuttle, stern deadlights,
hatchway boards, four limber paths, and the bilge pump. Known rectangular clear
areas come from existing geometry. Scupper, companionway, limber, and pump areas
remain explicitly `null` with the round that owes them, rather than carrying a
made-up non-zero capacity. Fore scuttle, deadlights, and hatchway paths read the
canonical closure polarity: `true` is open.

The ledger advances at 1/240 s on an integer step index. A caller supplies only
non-negative rates on named openings; endpoints come from the graph. Concurrent
source shortage and destination capacity are shared proportionally. A full
destination does not use simultaneous outflow as same-step room, avoiding
order-dependent pass-through chains. Every opening reports requested,
transferred, and rejected volume; external ingress, external discharge,
internal transfer, onboard volume, and conservation residual are also exposed.

The separate dynamic-water-load view publishes total mass, centroid, pitch,
roll and yaw inertia, and pitch/roll free-surface second moments. At exact zero
it returns one frozen canonical all-zero object. `Schooner.waterState` owns the
sidecar, but neither buoyancy nor horizontal dynamics reads this view yet. That
coupling remains SURV5 and must not be smuggled in as only a downward force.

## SURV1 boarding and deck-transport foundation

Every flotation contact station now carries a finite overtopping contact width
and tributary deck-plan area. `OvertopEvent` publishes those values plus the
fixed substep duration, canonical station and batch-step identity, local station
z, and one resolved boarding side. Existing spray and wake consumers ignore the
added facts, so their presentation policy is unchanged.

The 39 longitudinal station strips are 15.5/39 m wide and sum exactly to the
15.5 m hull length. A contact owns one rail side and the matching half-deck
tributary prism, rather than claiming both port and starboard deck areas. This
is the calibrated geometry boundary: it derives from the same station and deck
functions as hydrostatic contact, not from a hand-tuned ingress target.

The pure flux resolver uses the rectangular broad-crested critical-depth
relation

`Q = Cd * b * sqrt(g) * (2h/3)^(3/2)`

with a named provisional unity coefficient. The derivation follows the
[US Bureau of Reclamation Water Measurement Manual, chapter 2 section 13](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_13.html).
Unity represents the ideal critical-depth result and is retained as a
transparent theoretical upper bound while there is no physical full-scale rail
wash measurement. The deterministic case below bounds its game output; it does
not turn that value into empirical calibration. Each result is independently
capped by the finite event prism `depth * tributaryArea`, and neither input is
fitted to a desired flooding or sinking time. The resolver mutates no sea,
ship, or ledger state.

The production horizontal-motion path now converts each completed body batch
into named rail requests on the authoritative 240 Hz water clock. The ingress
boundary rejects a fact unless its station index, canonical z, strip width,
one-side tributary area, duration, and batch-step index agree with schooner
geometry. Repeated `(batchStepIndex, stationIndex)` facts are one contact and
retain the larger resolved volume once; different simultaneous station strips
add because their widths do not overlap. Port/starboard comes from the contact
fact, ordinary strips route fore or aft by geometric overlap, and the middle
strip is divided exactly between the two longitudinal cells.

The resulting water remains a sidecar: no production motion solver reads its
mass, centroid, inertia, or free-surface terms. The production opening-state
restart clears the ledger along with the motion integrators, so a new sea trial
cannot inherit shipped water from the last one.

## Deterministic boarding evidence

The frozen gate runs 22 seconds of `SOUTHERN_OCEAN_ROUGH` at 75° presentation
heading with the production 240 Hz body and water clocks. The complete result
object is strictly equal when called at 30, 60, 120, or 240 Hz:

- 5,280 fixed water steps;
- 835 emitted and 835 unique station contacts, with no prism caps;
- peak measured overtop depth 0.8268342232357601 m;
- maximum simultaneous width 3.1794871794871793 m, exactly eight station strips;
- 0.6005345832978084 m³ requested, transferred, recorded as external ingress,
  and retained aboard; and
- zero conservation residual.

This phase-realisation boards over the aft starboard rail only; separate unit
evidence covers port, fore, aft, exact middle-strip splitting, repeated-contact
de-duplication, and rejection of malformed station geometry. A 2,400-substep
no-event run leaves all compartments and ledger terms at exact zero and returns
the same canonical `ZERO_SHIP_DYNAMIC_WATER_LOAD` object. Dry caller batches
also reuse one immutable ingress result per substep count plus one shared empty
flow resolver, avoiding a production-frame Map and per-substep buffer churn
before the ledger's own zero-request fast path.

## Deck-water transport and production composition

The four weather-deck cells are joined by eight directed ledger edges: both
directions across the beam in each fore/aft half and both directions across the
fore/aft split on each side. These are numerical control interfaces over one
continuous deck, not physical apertures. They remain distinct from scuppers and
downflooding paths, which this slice does not resolve.

For cell mean depth `d` and representative local `(x, z)`, the resolver compares
the world-up surface head

`H = d cos(roll) cos(pitch) + x sin(roll) cos(pitch) - z sin(pitch)`.

That is the production attitude convention: positive roll lowers starboard and
positive pitch lowers the bow. The cells' different mean deck elevations are
not treated as sills because the fore/aft and centreline cuts are artificial;
their plan areas and representative horizontal centroids come from the existing
integrated cell geometry.

For each connected pair, the candidate transfer is the exact volume that would
equalise those two mean heads, multiplied by `step / relaxationTime`. Relaxation
time is the centroid distance divided by a named provisional 2 m/s propagation
input, with a 0.5 s floor. Source volume and destination room cap the same
candidate. Every cell has two interfaces and the step is 1/240 s, so even the
minimum time constant requests at most 1/60 of one source per step before the
ledger's independent proportional source/capacity guards. This is a stable
numerical response, not a calibrated sheet-flow speed.

The dry resolver validates attitude, then returns one canonical frozen empty
request without reading derived compartment records or performing trigonometry.
The non-dry path is restricted to the current ±0.7 rad production credibility
band. It models quasi-static gravity spreading only: event momentum, wash
rendering, scuppers, downflooding and water-load feedback remain outside it.

The transport resolver remains a pure headless core, but production now composes
it without approximating time. `BuoyantBody` publishes one transient attitude
fact at the start of every integrated substep, exactly where that step's contact
and overtopping solve samples the body. Its `batchStepIndex` and duration share
the overtopping clock. The objects are pooled across batches; consumers finish
reading the current batch before the next non-preserving body update reuses them.

`advanceSchoonerDeckWater` rejects missing, extra, mis-indexed or off-clock
attitudes before mutating the ledger. For each valid step it resolves canonical
boarding requests and quasi-static transport against the same pre-step volumes,
then hands both to `ShipWaterState` together. Newly boarded water is available
to transport on the next step, avoiding order-dependent pass-through. This is
the production path in `Schooner`; it never repeats the body's frame-final heel
over an earlier substep.

The transport gate applies 0.12 m³/s for 2 s through the aft-port rail at fixed
0.24 rad roll and 0.10 rad pitch, then runs to 8 s. The complete four-cell state,
ledger and dynamic-load result are strictly equal at 30, 60, 120 and 240 Hz:
0.24 m³ remains aboard, internal transfer is positive, every cell is non-negative
and the conservation residual is below 1e-12 m³. A separate 12 s bound test starts
with 0.4 m³ in one high-side cell and records no rejected transfer, overfill,
negative volume or loss.

The full 22 s `SOUTHERN_OCEAN_ROUGH` boarding case now exercises that production
composition with the body's changing attitude facts. At 30, 60, 120 and 240 Hz,
the complete four-cell state, ledger and dynamic-load result are strictly equal:
835 unique contacts ship 0.6005345832978084 m³, internal transfer is positive,
no transfer is rejected and conservation remains closed. An ordered two-pose
gate also produces less high-to-low-side transfer than deliberately repeating
its final pose, so the test can detect attitude smearing rather than merely
checking an array length.

## Large-angle credibility boundary

The headless imposed-roll probe reuses the loaded dry mass and the production
station-section clip. At each requested heel it solves a flat-world waterline
for exact displacement, then reports centre of buoyancy, horizontal righting
lever, and signed buoyancy moment.

- `|roll| <= 0.7 rad` (`40.107°`) is the only band represented by current
  production motion. The probe is useful there as a quasi-static cross-check.
- `0.7 rad < |roll| < 90°` is diagnostic geometry only. The section clip remains
  finite, but production clamps before it and no large-angle dynamics evidence
  exists.
- At `90°`, the current local waterline graph is singular. Beyond it, immersed
  water requires the opposite clipping half-plane; production also forces the
  local-up projection positive. The probe therefore reports unsupported at
  and beyond 90°, rather than pretending it validates inversion.

The SURV6 requirement for validated 0–180° hydrostatics, a nonsingular attitude
representation, knockdown, inversion, and recovery remains wholly open. The
probe is evidence for why the limiter must stay, not grounds to remove it.

## Verification

- `npx vitest run tests/ship-survivability.test.ts` — 19 tests passed.
- `npx vitest run tests/overtop-spray.test.ts tests/wake-sources.test.ts tests/ship-horizontal-dynamics.test.ts`
  — 26 tests passed.
- `npx tsc --noEmit --pretty false` — passed.

The focused suite covers stable geometry/graph names, exact dry records and
reset, exact 30/60/120/240 Hz caller equivalence, closure-gated conservation,
live dynamic-load properties, 180-frame dry motion bit identity, canonical
station geometry and malformed-fact rejection, named cell routing, centre-strip
splitting, station/substep de-duplication, the full deterministic boarding gate,
pure flux and prism caps, ship-frame deck-flow direction, bounded non-negative
transport, exact dry identity, the transported 30/60/120/240 Hz gate, restoring
sign through 40°, reusable start-pose facts, clock rejection, ordered-pose
anti-smearing, production boarding/transport composition, the diagnostic-only
band, and explicit rejection of 90–180° inversion claims.
