# Handover — the parallel session of 2026-08-16/17

Written for whoever picks this up next, on the assumption that they have **none
of the conversation** it came out of and may not be the same model or harness.
Everything load-bearing is in the repository; nothing important lives only in an
assistant's memory. Where this document says "see X", X is a committed file.

## What this session was

One coordinating thread and a rotating fleet of implementation agents, each in
its own git worktree off `master`, integrated one at a time through a staging
branch with the fast suite run after every merge. Sixteen rounds were dispatched
across nine work streams. The session hit an account quota limit three times;
each time the interrupted work was snapshotted into a WIP commit and the agents
were resumed from their own transcripts, which is why several commits in this
range have an unusual history.

**Master went from 1169 tests to 1657**, plus a slow tier that is unchanged in
shape. Typecheck and build are clean.

## The three documents to read first

1. **`docs/project/REVIEW_QUEUE.md`** — every look and feel verdict waiting on
   Ash, grouped by sitting rather than by round, each with the switch that A/Bs
   it and what the answer settles. This file exists because that backlog had
   become invisible: each round recorded its own verdict in its own handover,
   nobody read twenty handovers at once, and finished work sat unaccepted for
   weeks while new work was built on top of it. **Keep it current.** When a
   verdict lands, strike the line here *and* in the round's own handover.
2. **`docs/project/COLD_MACHINE_MEASUREMENTS.md`** — eleven numbers this project
   has promised itself and never taken, with the method that is not optional.
   Nothing in this session was measured for performance, deliberately: the
   laptop was running up to eight agents and was thermally throttled, and a
   throttled GPU measures its own heat. Ash schedules that pass separately.
3. **`docs/project/FUTURE_ROUNDS.md`** — what is built and what is deliberately
   not. It was badly stale at the start of this session (it called the schooner
   "planned and specified, not started") and was rewritten against the code.

## What landed, by stream

Each of these has its own handover section with the numbers; this is the index.

**Sailing.** S6, the navigator: she sails to a point — direct course when she
can lay it, boards to windward when she cannot, tack or gybe by which way round
the wind is shorter, and the navigator writes no control at all, only spoken
orders. Both S5 debts closed (16 m/s heel 26.4° → 21.0° under the canvas policy;
the square topsail struck 4.0 s after the hand reports it cannot draw). Then the
**coefficient round**, which is the largest behavioural change in the session:
the aero never scaled drag with lift, and now does. See
`docs/sailing/SAILING_ROUND_HANDOVER.md`.

**The ship.** M6 "sails alive" — six sails as deformable cloth on five
deformation modes, driven by the same state the aero uses, with `?cloth=flat`
restoring the old presentation. The wardroom and forecastle furnished. Eleven
seated and lying stations, and the stern deadlights. See
`docs/ship/SHIP_RIG_HANDOVER.md` and `docs/ship/SHIP_INTERIOR_HANDOVER.md`.

**Night, as landed.** A scotopic post pass (night-only by construction),
moonlight raised from 1.79× to 12.14× on `ambientRadiance`, and a display
calibration for that pass. **Follow-up verdict:** Ash rejected the scotopic look;
it now ships fully off. The moon retune remains, while the calibration is only
offered for an explicit `?scotopic=1` lab session. See the follow-up below.

**Weather, new stream.** A concept document that critiques the stage-4 spec
against the code, five decisions taken, then WX1 — one pressure record upstream
of everything, and the barometer the quarters round had to cut for want of it.
Then WX2, which separates the present wind from the wind that grew the sea. See
`docs/weather/WEATHER_CONCEPT.md`.

**Sound, new stream.** A listener, six voices derived from state that already
existed, and closure-driven muffling below decks. See
`docs/audio/SOUND_ROUND_HANDOVER.md`.

**Wake.** WK3 — bow-entry spray as a tear rather than a burst, and the overtop
port. See `docs/wake/WAKE_WATER_HANDOVER.md`.

**Tooling.** A headless A/B capture instrument that cannot lie about its render
tier, and a determinism round that made re-staging reproduce to the 8-bit
quantisation floor. See `docs/graphics/AGENT_INSPECTION.md`.

**Correctness.** Stars no longer paint over terrain; the cloud march-comb
question closed by arithmetic; the Fibonacci ambient set; roughly twenty false
claims corrected across the documents.

## What is NOT on master

Nothing. Every round dispatched this session is merged, including ship M5, which
was the last hold-out — it came in green at the end after its author fixed three
of its own assertion errors, cut one test that could not be written honestly
(see below), and folded its WIP snapshot away.

Master carries **1717 fast tests and 27 slow**, typecheck and build clean.

## Five things found at the very end, each worth more than the round it came from

- **`getNearestLandM()` was over-reporting clearance by up to 5.07 km, always
  unsafely.** It returned the placement solver's offset — one bearing, measured
  at mount — subtracted forever after. The voyage governor divides by that value
  and the 500 m approach warning compares against it. Now an exact coastline
  query, with a test that reconstructs the old arithmetic verbatim so a revert
  fails.
- **The A/B harness was photographing itself.** Two defects corrupted every live
  sheet ever taken: `setPaused` stops the calendar but not the vessel, so the eye
  moved between arms (same arm twice measured mean 3.33/255 over 48% of frame,
  with signed luma zero — a picture that *moved*, not one that changed); and half
  the switch registry moved a term the renderer never re-read, so a real change
  measured as nothing. Both fixed, a null control and a signed-luma statistic
  added, and every live sheet re-shot.
- **Three A/B pairs are bit-identical**, with controls proving the harness could
  have seen a difference. The star dome (queue 3.11) moves no pixel in frame —
  exactly as that line's own arithmetic predicted — and `vesselSkyOcclusion`
  (3.7) moves 0.006%. **Both need no verdict; strike them.**
- **The timber round's correction produced no change, and that redirects it.**
  Roughness 0.55 → 0.95 moves the finished picture by at most 1.6 levels of 255:
  outdoors the lobe is already wider than the sky's variation, and below decks
  the portal path scales environment reflection by a baked sky visibility of
  *zero*, so there is no glossy term at all. The flatness Ash complains about is
  **not answerable by finish**. What the measurement did find is that seven
  timbers sit between hue 31.9° and 36.7° — the lining and the companionway
  coaming are literally the same hex — and `jitter()` scales r, g and b by one
  factor, so nothing anywhere varies in hue or chroma.
- **`SHIP_SPEC.md` §5.4's masthead motion table is about 8% low.** It assumes the
  roll axis is near the waterline; `BuoyantBody` rotates about the centre of mass
  at y = 1.887, making the real lever 12.48 m rather than 11.5.

## One test deliberately deleted rather than made to pass

M5's cloth-occlusion sweep measured 45 of 72 bearings blocked from the lookout,
and it was wrong: a bilinear sail patch on a 17×17 grid puts a sample within a
third of a metre of almost any ray cast over forty metres, so a proximity test
cannot answer "does cloth occlude this bearing". It needs real triangle–ray
intersection against the drawn surface. Deleted, with the gap recorded in both
the test file and the handover. What replaced it is what was actually built: the
nearest cloth approach to the eye, asserted at 0.30 m so it cannot get into the
lens.

## Traps this session paid for, which will recur

- **A squash-merge makes a fully-landed branch look unmerged.** This session
  opened by mistakenly reporting that completed ocean work had been lost off
  master. It had not: it was squashed into `ee69193`, and `git merge-base` still
  reported the pre-squash fork point, so three branches showed "6/10/14 commits
  ahead" while being byte-identical in content. The reliable test is
  `git merge-tree --write-tree <a> <b>` compared against the suspected squash
  commit's tree. Ahead-count is not evidence.
- **A round cannot see the round beside it.** Three rounds derived "how much is
  this sail shaking" independently within a day, from the same three constants
  in three files. The duplication was only visible at the merge. When two rounds
  touch the same idea, the integrator has to look for it — nobody else can.
- **`preview_start` with a bare `npm run dev` serves the session's own working
  directory, not the worktree being edited.** Two agents lost time to "my change
  isn't there" when it was only absent from the branch being served. Use
  `--prefix`, following the `drift-master` precedent in `.claude/launch.json`.
- **The browser pane is 854 px wide, which silently selects the mobile quality
  tier.** So is headless Chrome at `--window-size=1280,720`, whose content area
  is 633 px. Any number or image read off either is from a different renderer
  than the one being judged. The capture instrument now asserts the tier.
- **`readPixels` returns black because of a same-task rule, not a timing one.**
  `preserveDrawingBuffer` is false, so a copy is only valid in the same task as
  the render that filled it. Sleeping is what breaks it.
- **A test that merely fits the default timeout is not safe.** `vite.config.ts`
  records 3–6× inflation under contention, and this machine often carries
  another session. A red suite at round start may be load, not regression.
- **The `evidence/` `.gitignore` is an allowlist.** A new evidence product stays
  untracked while the suite passes locally. Add the `!evidence/...` line in the
  same commit that creates the baseline.

## Where to start next

In rough order of value, and none of these is blocked on anything but time:

1. **Sit down with `REVIEW_QUEUE.md`.** The scotopic and polar verdicts are now
   implemented/recorded, but the remaining look decisions still need review.
2. **Finish M5** — get its five tests green or cut them, then merge.
3. **The cold-machine measurement pass**, on a quiet laptop.
4. **S7, the captain aboard** — the tiller as real deck geometry, a haul-and-ease
   grammar at the pins, and the first real order surface. Its accept-when
   sentence is the sailing project's own definition of done, and its interaction
   grammar is explicitly meant to be prototyped *with* Ash rather than delivered
   to him.
5. **WX3 onward** in `docs/weather/WEATHER_CONCEPT.md` §6.

## One standing rule worth restating

Only "pixel-identical" is self-certifiable. Anything softer needs Ash's A/B, so
an implementer who cannot get one either stops or ships behind a default-off
switch. Every look change made this session is behind such a switch, gated
byte-identical when off, and named in the review queue with the switch that
compares it. Keep that discipline; it is the reason this session could change
this much without anybody having to trust it.

## Housekeeping done at the checkpoint

All nineteen branches this session created are **fully merged into master** —
`git rev-list --count master..<branch>` is zero for every one of them. They are
kept rather than deleted, because each is the readable history of one round and
the merge commits point at them by name; nothing depends on them.

The nine worktrees the session created under `.claude/worktrees/coord-*` have
been **removed** (the branches survive). That is deliberate rather than tidiness:
two agents lost time this session to a dev server started in the wrong checkout,
and a worktree holding a stale branch is exactly what makes that mistake
possible. If you need one back, `git worktree add` it from the branch.

Verified at the checkpoint: `npm test` 1717 passed, `npm run test:slow` 27
passed, `npx tsc --noEmit` clean, `npm run build` clean, and `git status` empty.

---

# The loose-ends round, 2026-08-17

The last round of the session, and its whole job was to leave nothing dangling.
Two halves: the three capabilities the A/B harness was missing, and the faults
sixteen rounds reported but deliberately did not fix because each was out of its
own lane.

## The three unblockers, and the two sheets they bought

**Sixteen queue lines became pictures the day the capture instrument landed;
three could not, each for a named missing capability rather than for want of
trying.** All three exist now.

1. **`?cloth=` has a read-back.** `VesselRuntime.sailClothMode` is a getter, on
   `SimHandle` as a capability, and registered as the `cloth` A/B switch (page
   load, arms `alive | flat`, ships `alive`). It is derived from the LOFT
   STATE — `cloth` is absent from it only for `flat`, `animate` is true only for
   `alive` — rather than echoed back from `options.sailClothMode`, because a
   switch that reports the value it was handed cannot detect the one thing the
   registry's read-back rule exists to catch.
2. **`CaptureSceneSpec.trueWindAngleDeg`** — the signed true wind angle off the
   bow. It does three things in one call
   (`VesselRuntime.poseOnTrueWindAngleDeg`), and each of them alone gives a
   picture that lies: the heading is commanded, which puts her on the captive
   tow at the speed she is making; the model yaw is snapped to it; and the
   sheets are re-sided for the resulting tack by the rule the opening condition
   already used (`trimDegForTrueWindAngle`, split out of `openingTrimDeg`).
   Without that third step a scene on the other tack draws **every sail aback**
   and captions it a broad reach. `SailingControls.setInitialTrimDeg` is what
   makes the sheets arrive rather than walk: a staging is 1.2 s and the
   trimmers' probe interval is 22–40.
3. **`CaptureSceneSpec.dayOfYear`** — the solar search's base instant, offset by
   whole UTC days. The window stays one whole day so an elevation is still
   reachable; what moves is the date, and with it the moon. Every shot now also
   reports `moonElevationDeg`, `moonIlluminatedFraction` and `moonPower`, and
   `ab-sheet` **fails** a run whose switch is about the moon when no shot on it
   has any moon in it — because two moonless frames look exactly like two
   moonlit ones that did not change.

**Queue 3.2 also needed a switch, which nobody had said out loud.** `legacyMoonlight`
restores the pre-Part-B sky power of 0.070, moving the sky power alone and
leaving `MOON_IRRADIANCE_SCALE` where it ships — which is precisely the change
Part B made, since the direct moonlight went from a hand-set 0.34 to a derived
0.36 and was never the fault. Default is the shipping arm and off is
byte-identical.

Useful days from the opening location at a −30° sun, found by walking the
astronomy: **32** is a full moon 27.5° up, **35** is 91 % lit at 52°, **18** is
moonless with the moon 28° below the horizon.

## What is now closed

- **Queue 2.6** (the cloth) — **four sheets** under `evidence/ab/cloth-*`, each
  on a named point of sail. The square topsail aback on a beat is 33.4 % of
  pixels at max 180 against a cross-page floor of 0.0022, a margin of about
  **1190×** and the cleanest page-load pair in the directory; the eased main
  16.8 % / signed −0.31; head to wind 32.1 % / signed +0.66; close-hauled from
  the deck 33.8 % / signed +0.55. Two of that line's six items are still not on
  a sheet and neither is a point of sail — the furl rolls want a struck kite and
  the dead-calm bag wants a calm preset.
- **Queue 3.2** (moonlight) — `evidence/ab/legacy-moonlight`. A full moon 27.5°
  up and 100 % lit at a −30° sun: **99.9 % of pixels, max 185, signed −8.87
  levels** — the shipping moon is nine sRGB codes brighter over the whole frame
  than the one it replaced. A 91 %-lit moon at 52°: signed −6.39. The same-arm
  control is **bit-identical** in both rows, so the whole delta is the switch.
- **`?scotopic=` parsed itself.** Moved to `RuntimeOptions` behind
  `parseScotopicStrength`, pushed in from `main.ts` beside `setTimberMode` and
  before `ScenePresentPass` latches a rod state off it. The throw stays with the
  value it validates and is deliberately stricter than the setter, which clamps:
  a slider that runs off its end should stop, a URL that asks for a strength
  that does not exist should say so. **The same pattern is still live in five
  other modules** — `displayCalibration.ts` (`blackFloor`), `toneMapping.ts`
  (`shoulder`), `colourPipeline.ts` (four of them) and `labCapture.ts`
  (`capturePort`, already duplicated in `RuntimeOptions`). Not touched: each is
  the same small move and none was in this round's list.
- **The World panel's `sail up/down`.** `WorldPanelTelemetry.sailUp` is
  `boolean | null` and `main.ts` passes null on anything that is not a drift-sail
  vessel, so the clause disappears on the schooner where it read "down" on every
  frame of every session. The mechanism is untouched; the raft still needs it.
- **`interior:boards:*` and `interior:scuttleSoffit`,** as far as it can be
  closed without moving a pixel. Both materials named the lining as their colour
  and neither reached a pixel with it — `dressTimber` calls `color.setScalar(1)`
  before they draw, and the vertex attribute was filled from the fitting oak. The
  declarations now say oak, which is byte-identical, and `TIMBER_OF_MATERIAL`'s
  row stops describing a fault. **Two halves remain and both are look decisions,
  now queue 1.5e**: the roughness is the lining's 0.72 where the oak they are
  drawn in is 0.86, and the geometry's own comments say these pieces should be
  lining at 0xa08258 rather than oak at 0x5b452c — a 1.8× albedo change in an
  unlit room, which is queue 1.5b's question about the same surfaces.
- **`OCEAN_CREST_SPRAY_REPORT.md`'s parameter table.** Reported as stale in three
  rows; it was **five of six**. `SHEET_OPACITY` 0.11 → `SPRAY_OPACITY` 0.0385 (a
  rename and a 2.9× cut), `particlesPerMetreSecond` 30 → 18 desktop / 6 mobile,
  `SALT_DENSITY_FULL` 0.0011 → 0.00385, `SHEET_SUN_GAIN` → `SPRAY_SUN_GAIN`, and
  `SHED_PERIOD_FRACTION` **deleted outright** — a tear has no duration any more.
  §5.4's second bullet and the "Sheet strength" slider name went with it.
- **`CameraSystem.telemetry()`'s allocation: documented, not fixed, deliberately.**
  It allocates exactly one object literal, and no caller in `src/` is on a frame
  path — the panel is throttled to 10 Hz *and* gated on its tab being open, and
  it allocates twenty strings on the same tick. More to the point, two
  `RuntimeVisualDiagnostics` callers hold the result **across awaits** while
  moving the camera, so a reused scratch would let the saved pose follow the
  camera it is a record of and turn the restore into a silent no-op. The
  reasoning is now in the method's own doc comment, with the escape hatch
  (`readTelemetry(out)` beside it) named.

## What is deliberately left, and why

- **The fore scuttle can still be opened from the surgeon's cabin, and the
  earlier fix closed the wrong half.** `foreScuttleUnderBox` was clamped to the
  bulkhead and is honest now; the live leak is the **lid** box, and it goes UP
  through the deckhead. Measured with `buildShipInteractables().pick`: a body
  anywhere in the surgeon's cabin from z 2.0 to 2.56, looking forward, up, or
  anywhere between, is offered "Open the scuttle" — at 0.60 m from the after end
  of the room and **0.04 m** from its forward end.

  Four millimetres past nothing, and that is why no clamp fixes it: the platform
  sole is 1.80 and the eye 1.6 above it, so a body below has its head at 3.40
  while the lid box's floor is the planking at about 3.44. Shrinking the box in
  z does not help either — `Interactables` scores "standing over" from the plan
  footprint with 0.35 m of slack and the room reaches to within 0.05 m of the
  bulkhead. The two volumes are simply adjacent and the only thing between them
  is a deck that nothing in the pick knows about.

  **A plural `within` is the right shape and is not sufficient.** The table would
  take it easily — `within` has exactly one consumer and `Interactable.within` is
  a plain containment veto — but the list this closure needs is "forecastle OR
  the open deck", and the open deck is not a named volume: `SpaceName` is the
  four rooms below, `roomVolume` takes nothing else, and `weatherDeck` exists
  only as a `StationRoom` label with hand-built boxes. Somebody has to define the
  weather deck as a volume first, and that is deck geometry rather than a closure
  fix. The whole diagnosis is in `shipClosures.ts` at the closure, so the next
  attempt starts from the measurement instead of from the wrong half again.
- **The `evidence/` allowlist needed no new line.** The trap is real and was
  named at the checkpoint, but `evidence/ab/` was already given a generic rule
  (`!evidence/ab/*/`, `evidence/ab/*/*`, `!…/*-sheet.png`, `!…/*-manifest.json`),
  so a new sheet directory is tracked and its regenerable frames are not.
  Verified rather than assumed, with `git status --untracked-files=all` over a
  throwaway directory.
- **No performance number was taken.** The machine has been throttled all
  session; `COLD_MACHINE_MEASUREMENTS.md` is still where the owed numbers go, and
  this round added none to it.

## One thing found about the instrument

**The re-stage residue is far larger at night than the daylight figure
`AGENT_INSPECTION.md` quotes.** Staging the moonlight scene twice on one page
came back 93.6 % of pixels apart, mean 11.85 of 255, against the ~0.04 measured
in daylight. It does not touch the sheet — both arms come off ONE staging and the
same-arm control is bit-identical, 0 % of pixels — but it means the re-stage
determinism claim is a *daylight* claim, and anything that compares across two
stagings at night is resting on nothing. Recorded in `AGENT_INSPECTION.md`.

---

# Ash's feedback, 2026-08-17, after his first walk-through

**Recorded verbatim in substance at the quota boundary.** It was deliberately
not acted on in the original session. Follow-up work now records implementation
status inline; anything still open remains the top of the queue.

## Verdicts given

1. **Scotopic night vision: rejected and IMPLEMENTED. It ships OFF, at 0%.**
   Absent `?scotopic=`, runtime parsing, live state and the A/B registry all now
   select zero. The direct presentation path cannot engage or precompile the
   alternate pass. Part B was re-measured without the lift: the representative
   ambient-lit sea is sRGB 17 moonless and 52 under a full moon at 40°, so the
   12.14× moon radiance calibration remains and needs no compensating retune.
   Part C now loads and applies only on an explicit non-zero observer arm; its
   Settings entry is hidden at the shipped default and its summary states that
   a stored measurement cannot change the shipped picture.

2. **The polar change from the induced-drag round is accepted.** She points much
   less well and reaches slightly better; that is fine. Queue line 2.7 is
   settled — strike it.

## Faults found

3. **The running rigging did not follow the sails across — IMPLEMENTED.** The
   live trim/tack transform now carries masthead blocks, fife pins and their
   rope paths with the cloth. Exact-path tests cover both tacks and five trim
   fractions without duplicating the aerodynamic tack state.

4. **Going aloft loses the interaction contest — IMPLEMENTED.** Standing at
   the mast he kept getting *turn off lamp* for the lantern below decks, or
   *open hatch* for the scuttle, instead of the climb. The fix is in the core
   picker rather than an object priority: every target now carries its reachable
   room/storey, occupancy no longer counts as gaze, and the same 35° gaze rule
   applies to floor objects and furniture. The lower mast is explicit climb
   gaze geometry, so looking at it or up it selects the correct gang while a
   lamp, hatch or scuttle on another deck cannot compete.

5. **Going aloft should not need a click — IMPLEMENTED.** A deliberate walk
   into either gang from body distance now takes its ordinary climb station;
   holding the descent input through the final rung steps back onto the deck.
   Re-entry is latched until movement is released, so one held gesture cannot
   walk off and immediately take the gang again. The action remains available
   as an equivalent route.

6. **Go-aloft is offered where it cannot apply — IMPLEMENTED.** The climb reach
   volume begins at the actual weather-deck surface rather than inheriting the
   shroud approach box's below-deck tolerance. A sweep across every below-decks
   space, including the forecastle directly under the foremast, now refuses it.

7. **The moon did not read as a sphere — IMPLEMENTED.** The softened binary
   phase stencil is now continuous rough-sphere illumination from the real
   Sun→Moon geometry. Its presentation diameter is deliberately 1.40° (2.62×
   life-size); direct moonlight, sky fill, glitter and astronomy remain on the
   existing physical path. Full and 65%-lit nights were checked in-game.

## Question he asked, now answered in the follow-up

8. **He could not see the wake spray at all.** It is entirely **bow-entry**
   spray; the label and live diagnostic now say that explicitly. Shipping tears
   shed three times the water, throw higher and farther outboard, and arm at
   0.5/1.5 rather than 0.8/2.4. Fresh evidence measures 62 droplets/s in the
   moderate reach and 158/s in Southern running, with exact zero at anchor and
   in glassy swell. Ocean Lab now has a bow-only ×0–4 density control which does
   not alter physical event timing.

9. **The captain's berth curtain looked operable but was decorative —
   IMPLEMENTED.** The gathered linen and its rail were already modelled, with a
   source comment explicitly saying there was no state that drew it. It is now
   a real cabin closure: *Draw the berth curtain* / *Draw back the berth
   curtain*, with gathered-open and pleated-closed meshes. Closed cloth spans
   and visually screens the berth mouth and prevents selecting the berth behind
   it; it never becomes a false floor or collider.

---

# Continuous follow-up integration, 2026-08-17

This section describes the integrated work prepared after checkpoint `c065057`.

- Weather now offers coherent off/live/clear/rain/storm states with shared wind, sky, haze, rain, lightning, thunder, and wind cues.
- A shared Natural Earth source drives `?terrain=global` globe relief and local tiles across teleports.
- Synthetic remains default (the authored opening of the time was a city centre on land); GLO-30/WBM acquisition, Gate A, and production LOD remain open.
- The Moon uses continuous spherical lighting at 2.62× apparent size; lamp wicks remain warm through tone mapping.
- SURV0 completed the deterministic onboard-water ledger; SURV1 has tributary geometry and pure flux, without production ingress.
- Latest integrated gate: 1,801 tests passed, 27 skipped; typecheck and build passed.

Browser review cleared rain, the schooner wind cue, the night bolt, and globe
relief. Thunder, raft/daylight weather taste, and near-coast terrain remain in
`REVIEW_QUEUE.md`.
