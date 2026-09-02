# The wind cues — round report

**Status: done and merged to master. 636 tests.**

She had no wind indicator of any kind. `docs/ship/SHIP_DECK_HANDOVER.md` §12 recorded that
as *"a gap in the spec rather than a deferred milestone… it is how a helmsman
reads the wind, and the sailing model will want it."* This round fills it.

---

## 1. What landed

| File | What it is |
|---|---|
| `src/vessel/schooner/windCues.ts` | The three cues as data, in placed coordinates, plus the shape of the cloth and the attitude policy. |
| `src/vessel/schooner/windCueGeometry.ts` | The loft. Two buffers: the staffs, merged and static; one piece of cloth per cue, in its own frame. |
| `src/vessel/schooner/windCueSet.ts` | The meshes, and the per-frame aim. |
| `tests/ship-wind-cues.test.ts` | 32 tests. The sweep is the important one. |

Changed outside the module: `VesselUpdateContext` gained `apparentWindRender`;
`main.ts` grew `computeApparentWindRender`, which the developer readout and the
cues now share; `Schooner.ts` carries a `WindCueSet` and aims it after `pose`.

**What is aboard:** an **ensign** on a taffrail staff, a broad **pennant** on a
pig stick above the main truck, and a **dogvane** on a bracket outboard of the
starboard quarter caprail, where a helmsman can read it from the tiller.

### The one-line contract

**Fixed in shape, live in orientation.** The cloth is a rigid strip with a
standing wave baked in — no flutter, no shiver, no cloth dynamics, all of which
are M6 — and its attitude is recomputed every frame from the instantaneous
apparent wind, gusts included.

---

## 2. Why they are not treated like the sails

Ash's question at the top of the round was whether these should get the sails'
treatment: drawn in a fixed pose now, animated later.

Mostly no, and the difference is worth keeping. **A sail's frozen angle is a
trim decision.** `SHEET_MAIN = 26°` is not a lie; it is a vessel that has been
sheeted and left. **A wind indicator's only job is to point**, so a pennant at
an authored angle is not an unanimated pennant — it is an instrument showing a
wrong reading, and the correct reading has existed since S1. The expensive half
(cloth) is deferred; the cheap half (pointing) is not, because it is the whole
value.

**The truth ships even where it contradicts the rig.** Ash's call, explicitly:
she is drawn as a correctly-trimmed starboard-tack vessel with everything
sheeted to port while her heading is free, so on most headings the cues show a
wind the sails are not set for. That is the honest state of the ship until S4
lets the trim move. A dev pin to hide the disagreement was offered and declined.

---

## 3. Placement was a solve, and what it rejected matters

Every other object aboard is *somewhere*. A wind cue is **everywhere on a
disc** — it points anywhere in 360° and droops as the wind drops — so its
placement is a swept volume, and a clearance measured at one wind direction says
nothing about the other 359. `ship-wind-cues.test.ts` sweeps direction × droop ×
the drawn cloth against the whole rig, and that sweep chose every number below.

**The gaff peak cannot carry a rigid ensign**, which is where a gaff vessel
actually wears one. The peak is the gaff's own end, so a flag streaming forward
from it lies *along* the spar it is bent to — 0.071 m inside it at the worst
heading. A lateral standoff does not fix it: the standoff rotates with the wind,
so the cloth crosses the spar 0.28 m out instead of at 0. A real ensign does lie
on its gaff; cloth can do that and a rigid quadrilateral cannot. **A standoff
that rotates with the thing it is protecting protects nothing.**

**The main sheet, not the transom, set the ensign staff's height.** It drops
from the boom to the horse abaft the rudder head, through the airspace over the
taffrail, and clearance is monotone in staff height: 1.86 m of staff fouls it,
2.16 m grazes by 0.010 m. The last 130 mm came from the *limp* case instead —
below 1.75 m the drooping cloth hangs under the taffrail and over the counter.

**The pennant's droop bound is set by two ropes that end where it does.** The
topsail braces run from the yardarms up to the main topmast head, arriving at
the exact point the pennant hoists at. Pig-stick length buys droop in
proportion, because the higher the hoist the further the braces have fallen away
by the time the cloth reaches them: at 0.9 m of stick they bit at 40°, at 1.4 m
the cloth clears by 0.32 m at 50°.

### The numbers, and what set each

| | value | what set it |
|---|---|---|
| Ensign staff | 1.75 m above the caprail, 2.59 m off the deck, plumb | the main sheet, then the limp case; 0.43 m clear at every direction and droop |
| Ensign | 1.1 m fly × 0.7 m drop, droop ≤ 60° | bound by the collapse, not by the rig |
| Pig stick | 1.4 m above the main truck | the topsail braces — it is what buys droop |
| Pennant | 2.4 m fly, 0.42 → 0.05 m deep, droop ≤ 50° | 0.32 m clear of the braces; deep for legibility, see §5 |
| Dogvane | 0.4 m fly, 0.8 m spindle, 0.11 m bracket, droop ≤ 62° | 0.88 m of clear air; the bracket is the walker's doing, §4 |
| Droop policy | `tan(droop) = (limp speed / apparent speed)²` | cloth weight against a push that goes as v²; one fitted number per cue |

**The droop bound is an honest limit, not a tuning.** `FLAT` carries 0 m/s, so
the limp case is a real state of this world, and a limp flag does two things a
rigid quadrilateral cannot: it hangs *against* its spar, and its fly and drop
fall the same way so the cloth folds on itself. Past ~60° the sheared
quadrilateral closes to a sliver. Each cue names which of the two bounds it —
the rig it would foul, or the collapse — and in a dead calm shows a heavy
light-air attitude rather than a dead vertical one. That is the one thing here
an eye can catch as wrong, and it is cloth behaviour.

---

## 4. What the round found

**The cloth's winding was inverted on every triangle.** These grids run along
the fly in rows and across the drop in columns, which is the same *description*
`rigGeometry.ts` gives its grids, so the file was written with that file's
`flip = true`. The description was the trap: `rigGeometry`'s columns run
**around a closed tube**, a flag's run **across an open sheet**, and the sheet's
normal already comes from a `du × dv` with the handedness `addGrid` wants
unflipped. **Two grids that read identically in prose can have opposite
winding.** Fourth ordering-dependent quantity on this ship to come out reversed
from an argument that sounded right; the winding check caught it on the first
run, as it did the 488 cap discs.

**The ratline obstacles resolved to nothing, silently.** A rung names the *node*
its ends land on (`mainChannelPort0`, a chain-plate seat) and not the run
(`mainShroud10`), so a lookup by run name found none of them and 86 objects were
absent from the sweep. Only an asserted count found it. **An obstacle set that
quietly contains fewer objects than it claims is the shape of every fault this
ship's tests have caught.**

**The staff-foot check measured the nearest drawn *vertex*** and reported the
ensign staff 1.002 m off a taffrail it is bang in the middle of. The transom's
caprail is one quad the full width of the stern, so its only vertices are four
corners. **A vertex is not the surface**, and on a loft that emits large flat
panels the difference is the width of the panel. It measures triangles now.

**The dogvane's classification was false by 20 mm.** On the middle of the
caprail its spindle stood 0.240 m from the nearest place a body can put its
whole footprint, against a 0.26 m body — so "out of reach" was a claim the ship
did not support. It is on a bracket clamped outboard of the rail now, 0.42 m
clear, which is where a vane socket is fitted anyway. The first version of *that
test* was also wrong in the same direction: it measured to the nearest standable
point rather than to the last place a body can stand, which understates the gap
by exactly one body radius.

**The droop was built as a rotation, and Ash caught it in the first frame.**
Rotating the whole flag by its droop swings the luff away from the staff along
with the fly — 0.28 m at 24° on the ensign, which reads as a flag detached from
its own pole. **A flag is held along its luff by a halyard, and the halyard does
not tip: only the fly falls.** It is a shear now, `windCueBasis` returns a
deliberately non-orthogonal basis, and the cue's transform is a matrix rather
than a quaternion. The ensign staff went plumb in the same change, because a
raked staff and a gravity-hung luff diverge by 43 mm over the flag's depth —
more than the standoff.

---

## 5. Two decisions that are Ash's to revisit

- **The ensign carries no device and no nationality.** `docs/ship/SHIP_SPEC.md` describes
  a trader bought or chartered into expedition service and never says whose flag
  she wears, so inventing one would be inventing a fact about the ship. A plain
  weathered-madder field is what is left; it is one constant to change.
- **The pennant is a broad pennant, not a ribbon.** A commissioning pennant is
  literally a ribbon, and at 23 m it read as a scratch — Ash's first note was
  that it had no height. 0.42 m deep is legibility over precedent, deliberately:
  the masthead cue is the one a sailor looks at first and the furthest from the
  eye, so it is the one that can least afford to be correct and invisible.

### The three roles, since two of them are aft

| | job | why it is that one |
|---|---|---|
| Masthead pennant | the **undisturbed** wind | the only cue clear of the sails' and hull's dirty air, readable at distance from any angle |
| Dogvane | the **helmsman's** instrument | lightest cloth aboard, so it stands out at 1 m/s when the ensign still hangs; at eye height 2.4 m forward of the tiller |
| Ensign | identity, and wind **strength** | heaviest and deepest cloth, so it is the one that visibly sags as the breeze dies; also what a following camera sees |

Ash reviewed all three by eye and kept them. Noted for whoever is next: **the
dogvane's payoff is anticipatory** — its whole point is reading the wind with
your hands on the tiller, and nobody can take the tiller until S3. If the aft
pair ever reads as clutter, the option that was costed is moving it up into the
weather main shrouds, which splits them in frame and is the more traditional
station, at the cost of re-solving its clearance against the ratlines.

---

## 6. The guards, and what each enumerates

`OBSTACLE_SOURCES` enumerates `rig.ts`; `FITTING_KINDS` enumerates
`deckFittings.ts`. Neither can see this module and both would have gone on
passing while a third list of solid objects grew beside them — **a completeness
check is only complete about the thing it enumerates.** So `WIND_CUE_KINDS` is
the third one.

| guard | fails when |
|---|---|
| `WIND_CUE_KINDS` | a kind is unclassified, classified and unused, or classified without a reason |
| swept clearance | any cue's drawn cloth comes within its stated margin of any spar, rope, sail, ratline or another cue's staff, at any wind direction and any droop |
| hull envelope | any swept point is inside the hull, the bulwark or the caprail — through `counterStationZ`, because the ensign staff stands abaft the counter's shear |
| droop bound is real | the pennant still clears 15° past its bound (stale bound), or a cue documented as unbound fouls past it |
| luff on the staff | any luff point is more than the standoff off its own staff, at any droop — the regression for the rotation-versus-shear fault |
| winding | any cloth or staff triangle's supplied normal disagrees with its winding |
| closure | a staff has an open end, **or** a piece of cloth was closed into a solid |
| draws nothing extra | a cloth vertex falls outside the fly, drop and wave amplitude the data describes |
| staffs land on the ship | a staff foot is off the drawn taffrail, caprail or truck, measured against triangles |
| out of reach | any cue is within a body radius of where a body can stand with its whole footprint on deck |
| convention | the fly does not lie down the wind in the axes every wind quantity here uses |
| caller-rate invariance | the settling lag depends on how the frame time is chopped up |

---

## 7. What is deliberately not here

- **Cloth motion of any kind.** M6.
- **The point velocity at the cue's own position.** A rolling masthead sweeps
  air at 5.8 m/s in a 20° roll — comparable to the wind itself in
  `CURRENT_MODERATE` — so the physically complete input would swing the pennant
  hard through every roll, and a rigid strip with no inertia presents that as
  snapping. What damps it on a real pennant is the cloth. `apparentWindRender`
  takes any point velocity, so it is one argument to change when there is
  something that can absorb it.
- **A binnacle and compass.** She still has none: `docs/ship/SHIP_SPEC.md` §477 asks for
  one, `docs/ship/SHIP_DECK_HANDOVER.md` §6.7 held the whole dressing pass out of M3, and
  `docs/project/FUTURE_ROUNDS.md` has player instruments as its own round. A binnacle by the
  tiller is the natural companion to a dogvane — wind and course are the two
  things a helmsman reads — and it was offered this round and left where the
  spec put it.
- **Telltales on the shrouds.** A few centimetres of wool at 15.5 m would read
  as render noise rather than as information.

## 8. For the next session

`SchoonerSailForces` samples the instantaneous wind on the 240 Hz substep clock;
the cues sample it once a frame in `main.ts`. One authority, two sample rates,
both deliberate — physics needs sub-frame values and an indicator does not. If a
third consumer appears, it goes through `computeApparentWindRender` rather than
building a fourth expression of the same quantity.

When S4 makes trim live, the ensign's clearance is the thing to re-measure
first: the main sheet is what bounds it, and the sheet is the rope S4 moves.
