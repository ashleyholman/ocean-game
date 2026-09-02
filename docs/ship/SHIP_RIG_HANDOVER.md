# The rig — M2 handover

**Status: M2 built, and the sail plan reviewed by eye and rebuilt.**
Read this before touching `src/vessel/schooner/rig.ts`. `docs/ship/SHIP_SPEC.md` is the authority on
what the ship is; `docs/ship/SHIP_ROUND_HANDOVER.md` on build order; this on what the rig
is, why it is shaped the way it is, and which of its faults are still open.

---

## 1. What exists

| File | What it is |
|---|---|
| `src/vessel/schooner/rig.ts` | The topology graph. Named points, spars, standing and running rigging, sails as corner lists. Pure maths, no THREE. |
| `src/vessel/schooner/rigGeometry.ts` | Lofts the graph into meshes. Same relationship `shipGeometry.ts` has to `hullForm.ts`. |
| `src/debug/rigLayoutSheet.ts` | The orthographic flat drawing. **Use this first.** |
| `tests/ship-rig.test.ts` | 48 assertions. Silhouette, intersections, winding, fittings, walkability, budget, mass. |

**Budget: 13 draw calls, 28,306 triangles** against ≤120 / ≤200k. Both asserted
headless with ratlines and running rigging built. The ≤2 ms GPU figure is *not*
claimed — see §6.

**Eight sails, 200.7 m²** — and note that total is within a metre of what the
first version carried, despite almost every sail changing size. The plan was
never too small; it was distributed wrongly.

| Sail | m² |
|---|---|
| mainsail | 60.8 |
| fore topsail (square) | 35.3 |
| foresail | 28.2 |
| flying jib | 22.2 |
| jib | 16.3 |
| main topmast staysail (fisherman) | 14.8 |
| fore staysail | 11.6 |
| main gaff topsail | 11.5 |

---

## 2. THE TOOL THAT WORKS, AND ITS ONE TRAP

`window.schoonerViewer.rigLayout()` — orthographic, flat, unlit, no sea, cloth at 55%
so overlaps read as a darker patch. **Judge layout here; judge light on the
contact sheet.** Every layout fault in both rig rounds was invisible under real
light and obvious in thirty seconds on the flat drawing.

It now pins `NoToneMapping` at exposure 1 for the capture. It did not, and the
consequence was that a drawing calling itself "flat and unlit" changed shade with
the time of day in the scene — two sheets taken minutes apart came out visibly
different with nothing changed but the world clock. **A drawing whose ink changes
depending on when you print it is not a drawing.** Sheets are now comparable
pixel for pixel.

Dev server: the `drift-rig-m2` launch config, **port 5195** (5193 belongs to the
earlier rig worktree; do not kill it). Capture server on **5203** via
`?capturePort=5203`.

---

## 3. THE LESSON OF THIS ROUND

Ash reviewed the sail plan by eye across six passes and found roughly twenty
faults. **The tests were green for every single one of them.** That is the thing
worth carrying, and it has a shape:

> Every fault was in a relationship the test suite had no *category* for.

- sails were checked against `SPARS` — so the **tops** (`CROSSTREES`, a different
  list) went unchecked, and the fore top projected 0.72 m through the square
  topsail;
- and the **gaffs** were never checked against the tops either, so both of them
  passed straight through their own trestletrees and *could not have swung*;
- ropes were never checked against **cloth** at all, so a peak halyard ran
  through the new gaff topsail;
- ropes were never checked against the **hull**, so three headsail sheets ran
  through the bulwark;
- and the rig described the **bulwark** itself with a hardcoded guess, so every
  fitting on the rail was placed against a wall that was not there.

All five gaps are closed with tests now. But the general form is what matters:
**an intersection suite keyed to one list silently stops covering the ship the
moment someone adds geometry to a different list.** When you add a category of
object, ask what it can now collide with.

Three more failure modes worth naming, because each cost a round:

**A test that derives the truth the same wrong way as the code cannot fail.**
The bulwark check used the identical wrong expression the fittings were placed
with, and agreed they were fine while Ash could see them in the planking. The
same thing happened with the pin rail: my first test computed the board's seat
exactly as the loft did. The fix is that the swept path is now *data* the loft
consumes, and the test checks that data.

**Verification that silently covers less than it claims.** The check that proved
the sheets no longer pierced the hull matched runs whose names ended in `Sheet` —
and every one of those ropes has a second half named `SheetFall`. It reported
success for ropes it had never looked at, twice.

**When a geometry problem only has bad answers, the premise is usually wrong.**
The jib intersected the square topsail, and I spent five rounds trading between
the yard's truss standoff, the topsail yard's height, the jib's tack, the camber,
the stay standoff, and an invented pendant — every one a compromise, none better
than a whisker. The premise was that a headsail's head is the top of its stay. It
is not: the stay runs to the masthead and the sail is hoisted part-way up it, with
bare stay above. Ash sent three photographs. The gap went from *intersecting* to
**0.90 m** with nothing traded away.

---

## 4. The rig facts that took longest to find

- **A headsail's head is not the top of its stay** (`HEADSAIL_HEAD_ON_STAY`,
  0.28). See above. This also fixed the long-standing finding that the flying jib
  was the largest headsail: taking the heads down the stays cuts the outer sails
  hardest, and the fan now steps 11.6 / 16.3 / 22.2.
- **`THROAT_BELOW_HOUNDS` decides whether a gaff can swing.** A gaff rises aft at
  ~1.1 m aft per metre of rise, so a throat too close under the hounds puts the
  spar inside the trestletrees. It is 0.70, paired with tops shortened to
  0.70/0.60 fore-and-aft. **The two numbers are a pair** — a longer top needs a
  lower throat. There is a test that measures the clearance.
- **`YARD_FORWARD_OF_MAST` is pinched, not chosen** (0.24). Larger clears the
  masthead behind the sail; smaller keeps it out of the jib. The window is one
  step wide and the masthead clearance at 0.24 is 0.13 m. Re-run the sweep if the
  mast, doubling or headsail fan move — the two constraints are invisible from
  each other's test.
- **A gaff topsail must be cut to clear its own peak halyard.** A halyard from the
  gaff to the masthead is *by definition* inside the triangle a gaff topsail
  occupies; no offset fixes it. The sail is set flying, tacked above the masthead
  block (15.35), so the halyard passes underneath. That is why the cut exists.
- **A pendant only carries load along its own line.** A horizontal one drawn
  square across a stay's pull holds nothing. Dressing a fictional coordinate in a
  rope does not make the coordinate real.
- **A board bolted to a curved ship is not straight.** Pin rails are swept along
  the wall, height following the sheer as well as breadth. A fitting that sits on
  the hull must ask the hull where it is *at the point where it sits*.
- **`side` on a `Sail` is a sign on the corner patch's normal, not a world
  direction.** It was documented as "+1 to starboard" and every fore-and-aft sail
  was consequently bellied to *windward*. There is no sign convention that fixes
  this — the quantity genuinely depends on corner order. **Set it by running the
  belly test, never by reasoning.**
- **She is on the STARBOARD tack** — *amended 2026-08-05 by the W1 relabel
  (`docs/sailing/SAILING_ROUND_HANDOVER.md`, `hullForm.ts`)*. This bullet originally read
  "PORT tack — wind over the port side, everything sheeted to starboard,
  everything bellied to starboard", which was written in the old mirrored side
  labels (model +x was then called starboard). Nothing about the drawn ship
  changed: in labels that agree with the compass, the wind comes over her
  starboard side and everything is sheeted and bellied to port. The tack-naming
  history is told in full at the `SAILS` doc block in `rig.ts`.
- Every rope must end at a thing, **and the run between the ends must be a path a
  rope could take.** Endpoints being right is not enough — that is how the sheets
  ended up passing through a solid wall to reach a correct pin.
- A **square sail bellies forward**; it is the only sail with `side: -1`.
- Masts **rake aft** — fore 4°, main 5.5° — measured about the deck partner.
- Sails self-shadow; each needs a per-mesh `customDepthMaterial`, not `shadowSide`.

---

## 5. What changed structurally

**`hullForm.ts` now owns the bulwark and caprail** — `BULWARK_THICKNESS`,
`CAPRAIL_*`, `bulwarkOuterHalfBeam()`, `railSection()`. They were in
`shipGeometry.ts`, so anything that was not the loft had to guess, and `rig.ts`
did. `shipGeometry.ts` imports them; the hull's geometry is byte-identical.
**Nothing outside `hullForm.ts` may re-derive where the ship's side is.**

`docs/ship/SHIP_SPEC.md` §7.1 amended (six sails → eight, adding the main gaff topsail);
§7.2 now says **square** main topsail in bold, because that clause was being read
across to fore-and-aft canvas it never covered; new §7.2.1 records that a single
square topsail on two yards is period-correct and must not be "improved" into a
double topsail.

---

## 6. Open, and Ash's calls

1. **The mass model still disagrees with the drawn spars, deliberately.** Drawn
   1,600 kg at KG 8.36; `massModel.ts` assumes 1,846 at 8.67 and treats the lower
   masts as deck-stepped when they step on the keelson. Correcting it moves GM and
   therefore roll rate. **Ash's explicit call this round was to leave it alone.**
   Re-run `rigMassAudit()` before acting — the spars have moved a great deal.
2. **The fisherman is still the roughest sail aboard.** Its corners are in the
   right order now (clew below tack, sheeted sideways to the mainmast) but its
   luff occupies only part of its stay, and a rigid surface cannot lie against the
   foresail the way cloth does. Sails-round work.
3. **The fore top is now 0.70 × 1.70 m** — small for `docs/ship/SHIP_SPEC.md` §5.4's
   lookout. M5 should build a proper top on those trestletrees rather than inherit
   these. Lengthening it requires re-deriving `THROAT_BELOW_HOUNDS` (§4).
4. **GPU time is unquoted.** `GpuProfiler` still has no ship pass, and adaptive
   resolution makes a frame-time A/B measure the resolution controller.
5. **Nothing is collidable yet.** M3 decides. Recommendation from these rounds:
   ropes should **not** collide; solid fittings (fife rails, horses, pin rails,
   masts) should, with horses treated as step-over. Measured gangways: fife rails
   1.16 / 1.27 m each side, horses 0.50 / 0.86 m, masts 1.70 / 1.78 m.
6. **Sail-vs-sail collision is M6's problem, not a bigger static gap.** The
   tightest pairs are foresail/staysail 0.17 m and mainsail/gaff-topsail 0.18 m.
   Those are fine standing still and will not survive deformable cloth.
7. **The backstays land on the channels, outboard, and that is correct** — the
   channel exists to spread shrouds *and* backstays clear of the rail. They are
   standing rigging, set up once with deadeyes and lanyards. Asked and answered;
   do not "fix" it.

---

## 7. Two hull faults fixed in an earlier pass

- **The stern bulwark was one-sided** — transparent from anywhere forward. It has
  an `inboardBulwark` face now, as the sides always did.
- **The caprail stopped at the stern.** It turns the corner now, so she has a
  taffrail.

---

# M6 — Sails alive

**Status: built and gated headlessly. Ash's eye is the accept-when and has not
been asked yet.** The eight sails are deformable cloth whose every shape is
read off state the physics already computes. `?cloth=flat` restores exactly
what shipped, for the A/B.

## 8. What the cloth does now

One bilinear patch per sail, as before — but the displacement off it is no
longer a single fixed belly. It is five mode shapes, each of which exists
because a particular edge of a particular sail is free to move, and each of
which is **zero at all four corners**. That last property is the design:
`rig.ts` owns the corners, the aero reads them, and the cloth is only ever
allowed to shape the surface *between* them.

| Mode | What it is | Driven by |
|---|---|---|
| draft | the belly | `sailLuffFactor(aoaDeg)` — the aero's own attachment curve |
| twist | the upper leech falling off to leeward | how far the sheet is eased, against `RIG_TRIM_LIMITS` |
| luff sag | the stay bowing to leeward under load | apparent wind squared × attachment |
| foot round | a loose foot bagging below the tack–clew line | the draft it scales with |
| flogging | slatting canvas | `1 − attach`, killed as the sail goes firmly aback |

Four states the numbers already knew and the cloth now says out loud:

- **drawing** — full draft, on the same degrees of AoA the lift is on;
- **luffing** — draft to zero across the aero's own luff band, and the cloth
  starts to shake;
- **aback** — the belly *inverts*. The wind is on the leeward face and the
  cloth is pressed the other way;
- **cannot draw** — the trimmer's sustained report caps attachment at 0.5, so
  the sail is never drawn more than half filled however flattering this
  instant's AoA is.

Plus **blanketing**: a sail in another's wind shadow stands in less pressure
and goes soft. The aero has computed `blanketFactor` since S2 and nothing
looked at it.

### The three things previous rounds paid for

- **A hoist lowers the gaff.** Unchanged and now tested from the spar's side as
  well as the cloth's: `SPARS.mainGaff.heel` *is* `rigNode('mainThroat')`, so
  lowering the hoist carries the drawn timber, and the spar region's geometry
  is asserted to change when only a hoist moves.
- **A furl roll is sized by conserving cloth.** It was not, and the size of the
  lie is in §10. It is now `set area − standing area`, measured.
- **No rationed rebuild.** The flogging phase is explicitly outside the
  re-loft thresholds, because rationing an animation is FAULT 2 of the S4
  review in a new costume.

## 9. The switch

`?cloth=alive | still | flat` — `src/runtime/RuntimeOptions.ts`.

- **`alive`** (default, the milestone) — everything above.
- **`still`** — the same shapes with the flogging clock frozen. It exists so a
  cold-machine pass can separate "the new shape costs more per vertex" from
  "animating means re-lofting on frames that used to be free".
- **`flat`** — the pre-M6 presentation. Not "approximately what shipped":
  `tests/ship-rig-cloth.test.ts` carries checksums of the drawn cloth surface
  taken from **master 63308dc** at three poses and asserts this arm still
  reproduces them exactly.

Mechanically the arm is one thing: `flat` never attaches a `cloth` field to
`RigLoftState`, and every M6 mode is gated on its presence.

## 10. What was measured (no timings — see §12)

**Cloth conservation, before and after.** The roll used to hold
`setArea · (1 − hoist)` — the assumption that a sail loses canvas in
proportion to its halyard. No family aboard does:

| sail | hoist | canvas before | canvas after |
|---|---|---|---|
| jib / fore staysail | 0.75 | **−17.7%** | +1.1% |
| jib / fore staysail | 0.55 | **−24.2%** | +0.6% |
| mainsail | 0.75 | +5.4% | +2.6% |
| mainsail | 0.55 | +6.2% | +2.8% |
| fore topsail | 0.75 | −0.8% | +2.0% |

A headsail shrinks toward its tack in both directions at once, so its area
goes as `hoist²` while the roll took `1 − hoist`; a quarter of the jib's cloth
was simply gone. The gaff sails lose area more slowly than linearly near the
top, so their rolls were ~12% too fat. Only the square topsail, whose clews
rise straight to the yard, was near-linear — and it was the one that looked
right.

The residual **+2%** is not error: the aero's set area and the roll's cloth are
both flat planform, and a bellied surface has about 2% more area than its own
planform. It is one-sided and it grows near full furl, where the planform has
nearly collapsed and its belly has not.

**Geometry budget — unchanged.** 12,658 triangles, 11,363 vertices, 4 regions,
live half 4,930 triangles, identical on master and on this branch in all three
arms. **The M6 cloth adds no geometry at all**; it moves vertices that already
existed. Whatever it costs is CPU in the loft, not draw.

**Deepest bearing into anything a sail is not bent to**, swept over four
weathers × the coherent points of sail: **13.0 mm** at the sweep's own
sampling (21 mm on a finer 11 × 11 probe) — the fore staysail's leech flogging
against the foremast close-hauled. That is contact, which canvas does; nothing
penetrates. The deepest *M6-caused* contact in the body of a sail is 9 mm (the
gaff topsail on the main backstay, eased right out) and 7 mm (the foresail on
a fore shroud).

**Square topsail headroom: 0.094 m.** Its flat patch clears the fore topmast by
94 mm, so an aback belly of any real size would go through the stick.
`CLOTH_CUTS.foreTopsail.aback` is 0.10 — the small number in that table — for
exactly this reason, and this is the sail FINDING S5-3 says she carries aback
on every beat, so the state is common rather than exotic.

## 11. Findings

Faults in code that already existed, whether or not they were this round's job.

1. **The trim envelope's reefed poses were not reefed.** `applyRigTrim(pose.trims)`
   was called with no hoists while `state.hoists` said 0.55/0.75. For the two
   gaff sails `gatherSailCorners` returns immediately — their hoist lowers a
   spar rather than compressing cloth — so the corners the sweep read were the
   peaked ones `applyRigTrim` had left in the graph. The one category of pose
   the sweep added for shortened canvas was the one category it was not
   testing. **Fixed.**
2. **The furl roll's cloth accounting** — §10. **Fixed.**
3. **The square topsail's draft was skewed to starboard.** `DRAFT_POSITION = 0.4`
   means "40% aft of the luff", which is a fore-and-aft idea. The square sail's
   `u` runs from one leech to the other and it has no luff, so a symmetric sail
   was bellied asymmetrically. **Fixed in the `alive` arm** (0.5 for that cut);
   the `flat` arm keeps the skew deliberately, because it is what shipped.
4. **Two copies of the belly normal.** `sailAero.belliedNormal` and
   `rigGeometry.sailPatch` each computed the same cross product and agreed
   because someone kept them agreeing. There is now one exported
   `sailLeewardNormal` and the loft calls it. **Fixed** — the milestone's
   "belly agrees with the aero by construction" is now literally that.
5. **§1's sail-area table is stale.** Measured: mainsail **57.60 m²** where the
   table says 60.8, main gaff topsail **15.46 m²** where it says 11.5. The
   other six agree to 0.05 m². Total 201.5 m², not 200.7. Not corrected in §1
   this round because that table is M2's record of M2.
6. **The aero's `CLmax` still reads the static design camber.** `sailClMax`
   takes `sail.camber`, and the drawn camber is now a live quantity. The
   picture and the coefficient no longer agree about how full a sail is.
   Physics was deliberately not touched — changing it re-prices every committed
   sailing number — but this belongs in the coefficient round alongside
   FINDING S4-1, and it should be decided there rather than inherited.
7. **`furlRoll` briefly grew a hidden precondition.** Measuring live area from
   the posed graph gave it a "caller must hold `applyRigTrim` open at the same
   hoist" contract that a caller could satisfy by accident. An existing test
   caught it. It now derives its own corners at the authored trims — the roll's
   cloth is a question about halyard, not about sheet.

### The three the new tests found in this round's own work

Each of these is a test failing against a real mechanism, which is the whole
reason to write the test before believing the code.

1. **A measurement that read three modes and called the sum "the belly."** The
   first "draft follows the attachment curve" test sampled the drawn surface at
   `(0.5, 0.5)` and got 0.093 where the curve predicted 0.247. The patch centre
   carries the twist and the flogging wave too, and at 7° AoA the shake is at
   full amplitude with a phase-0 value of −0.95 right there. The code was
   correct and the measurement was not. The assertion moved to `draftScale`.
2. **A 1.2 m wave in the mainsail.** The first `CLOTH_CUTS` shake fractions were
   0.3–0.45 *of the chord*, which on a 6.7 m gaff main is over a metre of
   flogging — so far past plausible that the reach rail was clipping it, which
   is a rail doing a shaper's job. Retuned to 0.05–0.11, and there is now a
   test that the flogging amplitude in metres lands between 0.05 and 0.6 for
   every sail.
3. **`cannotDraw` as a gain on the shake was a no-op.** Shake is `1 − attach`,
   so it is already saturated at 1 everywhere inside the luff band — which is
   the only place the crew ever raise that report. The gain multiplied 1 by 1.6
   and clamped back to 1. Replaced with a cap on *attachment* at 0.5, which is
   `PerSailForce.luffing`'s own threshold: the draft coming off and the shake
   coming on are then one number moving, and the two cannot disagree about how
   unsettled the sail is.

## 12. The cost, and what a cold machine must measure

**No timing was taken this round** — the machine was thermally throttled, and a
throttled number is worse than no number because it gets quoted. What is known
without a clock: the geometry is byte-for-byte the same size (§10), so the draw
side is unchanged and the whole question is CPU in the loft.

What the cold-machine pass should measure, in paired interleaved blocks:

1. **`still` against `flat`, whole-rig `buildRigGeometry`.** Isolates the
   per-vertex cost of the new modes. Four extra separable terms per vertex in
   position and in both tangents, all table lookups — the prediction is that it
   is small against S4's 2.1 ms, and the prediction is worth nothing until
   measured.
2. **`still` against `flat`, `refreshLiveRigGeometry`.** The per-frame path, the
   one that matters. S4 measured this at 0.46 ms in node / 0.6 ms in the pane.
3. **`alive` against `still`, in a scene with a sail actually luffing.** This is
   the real question and it is not a per-vertex question: it is *how often*.
   A steady rig in a steady breeze re-lofts on no frames at all (thresholded,
   and `tests/vessel-runtime.test.ts` pins it); a rig with one sail flogging
   re-lofts on **every** frame. The number to get is the frame-time delta
   between a beat with everything drawing and the same beat with the square
   topsail aback and the staysail on the edge, which is a common state, not a
   contrived one.
4. **The thresholds themselves.** `CLOTH_AOA_EPSILON_DEG` 0.25 /
   `CLOTH_WIND_EPSILON_MPS` 0.05 / `CLOTH_BLANKET_EPSILON` 0.01 in
   `VesselRuntime.ts` were chosen so a quarter-degree of AoA — under a
   millimetre of drawn belly — does not trigger a rebuild. If (3) says
   animation is expensive, these are the dial, and they must never be applied
   to the flogging phase.

Use the headless GPU harness, not the browser pane
(`docs/…/headless-chrome-gpu-benchmark`), and say what the load was.

## 13. What is owed to Ash's eye

None of this certifies that she *looks* right. What to look at, and which
switch A/Bs it:

1. **A beat with the square topsail aback.** `?cloth=alive` against
   `?cloth=flat`. FINDING S5-3 says she carries it aback on every beat; that
   sail now bellies the wrong way and lies nearly flat against the topmast
   instead of standing there full and pretending to draw. This is the single
   biggest change to the silhouette.
2. **Ease a sheet right out on the main and watch the leech.** Twist is the
   mode with the most visual authority and the least physical anchoring — the
   gain (`CLOTH_CUTS.*.twist`, 0.2–0.55) is a feel number, not a derived one.
3. **Tack her, and watch the sails cross.** Slatting is new. Amplitude and
   frequency (`SHAKE_HZ_AT_1M = 2.4`, scaled by `1/√chord`) are both feel
   numbers. The honest question is whether it reads as canvas or as a ripple
   shader.
4. **Reef the main, then furl it.** The roll is a different size than it was
   — thinner on the gaff sails, much fatter on the headsails. It is right now
   in the sense of conserving cloth; whether 12 mm of packed thickness makes a
   sausage the right size is by eye.
5. **A dead calm.** Every sail goes to a 15% soft bag rather than a plane, and
   that floor is an admission, not a model: nothing here makes a becalmed sail
   hang in vertical folds. If it reads badly, the fix is a hang mode, not a
   bigger floor.
6. **The flat drawing.** `window.schoonerViewer.rigLayout()` still builds with
   no cloth state, so it shows the `flat` arm. That is probably right — layout
   is a question about corners — but it means the M6 cloth cannot be judged
   there, and §2's "judge layout here" now has an exception worth knowing.

## 14. Still open

- **Sail-vs-sail contact under deformation.** §6.6 warned the tightest pairs
  (foresail/staysail 0.17 m, mainsail/gaff topsail 0.18 m) "will not survive
  deformable cloth". They did — the sweep is clean in four weathers at every
  coherent point of sail — but that is a *sampled* claim on a 10 × 8 grid, and
  the ±5° flogging exemption still covers cloth crossing the centreline.
- **The fisherman is still the roughest sail aboard** (§6.2). Its luff still
  occupies only part of its stay. The cloth model gives it a sagging luff and
  a rounded foot, which helps, and does nothing about the underlying cut.
- **No hang.** See §13.5.
- **The drawn camber and the aero's `CLmax`** — finding 6.

## 15. Post-walk repair — the running rig crosses with the sails

Ash's first live tack exposed a state relationship the static and authored-pose
tests could not see. The boom end, gaff, clew and cloth crossed the centreline,
but several inboard ends of their running gear remained on the authored
starboard side. A moving rope with one end left behind becomes a chord through
the sail: most visibly the main and fore topping lifts and the fore halyard
fall, with the same latent fault in the main peak halyard and fisherman sheet.

The repair is in `trimmedRigNodePositions`, not in a second presentation state.
The signed trims already consumed by `liveSailCorners` now select the weather
side for all of the tack-coupled fittings:

- main and fore masthead blocks and their fife-rail pins;
- both ends of the main peak halyard;
- the fisherman's mainmast cheek block and its fife-rail pin.

The outboard end still comes from the moving spar or clew. The inboard end now
comes from the mirrored fitting on the weather side, and `applyRigTrim` holds
that one overlay open while the live spars, blocks, ropes and cloth are lofted.
There is no copied tack boolean and no rope-owned sail angle. At the authored
trim the selected fittings are the original ones, so the authored live path
remains bit-identical.

Two focused gates now hold the relationship in `tests/ship-rig.test.ts`:

1. seven running-rope midpoints and eight fittings must be exact x-mirrors at
   mirrored trims;
2. the tack-coupled lines are swept at five trim fractions on both tacks,
   against both the flat A/B cloth and a fully drawing M6 surface, and may not
   intersect the sail they work.

The remaining abstraction is the same one the headsail sheets already use: at
the centreline crossing the loft selects which side's working lead is active;
it does not animate hands casting off one pin, taking up the mirrored lead, or
the slack twin. That belongs to a future crew/line-tension treatment. It no
longer leaves a taut visible line behind inside the cloth.
