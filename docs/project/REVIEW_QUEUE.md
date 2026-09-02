# The review queue — what is waiting on Ash's eye

Assembled 2026-08-16 at master `63308dc` by sweeping every handover in `docs/`
for the sentences that end "…and this wants Ash's verdict".

This file exists because that backlog had become invisible. Each round records
its own open verdict in its own handover, and nobody was reading twenty
handovers at once, so finished work sat unaccepted for weeks while new work was
built on top of it. Two of the items below have been waiting since the ship was
a raft.

**How to use it.** Nothing here is a bug report and nothing here is urgent in
itself. Every line is a decision only you can make, with what it costs you to
make it and what it unblocks. Work down a section in one sitting; most sections
are one dev-server session. When a verdict lands, strike the line here *and* in
the round's own handover, and say which value it settled.

**The standing rule this file enforces:** only "pixel-identical" is
self-certifiable. Anything softer needs your A/B, so an implementer who cannot
get one has to either stop or ship behind a default-off switch. The switches
are named per item so you can A/B them live rather than from a description.

**Twenty of these are pictures now rather than sessions.**
[`evidence/ab/README.md`](../../evidence/ab/README.md) is the index: each sheet
is the two arms side by side with an amplified difference panel, shot
deterministically at an asserted render tier, and the numbers the arms differ
by. Rows below carrying a **[sheet]** link can be answered from the PNG. Rows
that do not carry one are listed in the index's "could not be given a sheet"
table with the precise reason — a switch that does not exist, a scene that
cannot be staged — and that reason is the actual blocker for the line.

Three answered themselves: `starDome` and `vesselSkyOcclusion` came out with
their two arms **bit-identical** against a control that proves the harness would
have seen a difference. See the top of the index.

---

## 1. The ship, below decks — one walk, ~20 minutes

The whole interior has been built without you ever having stood in it. The
captain's quarters handover opens with the sentence "Nothing here has been
looked at."

| # | What to look at | Where | What it settles |
|---|---|---|---|
| 1.1 | The captain's quarters entire — berth, lockers, panelling, chronometer | walk below, day and night | whether the furnishing round's arrangement stands or is redone |
| 1.2 | The desk, standing and seated | the desk's `use` interaction | the desk sits 6.6° off; keep or square it |
| 1.3 | The forecastle's 1.728 m headroom at the sides | walk the forecastle edges | the walker's duck fires here for the first time; "expect it to be wrong" |
| 1.4 | Dark reds on the cabin's stern wall | night, then a lit lamp | they crush to black when dim and clip pink when lit — a palette or a toe decision |
| 1.5 | The lantern glow leaving the ship | on deck at night, looking at the companionway and the stern windows | whether interior light should spill outward at all |
| 1.5a | **The wardroom and the forecastle are furnished now** — mess table and a form each side, surgeon's and mate's cabins, chests, galley hearth and dresser, four berths in two tiers | walk both rooms | the mate's cabin came out at 0.799 m inside against the surgeon's 1.251, so it is a bed-place rather than a room. **That is the one thing the builder would reverse** — but only if the wardroom's forward lantern may move 0.26 m, and the lantern is your ray mark. Also wanting your eye: the 0.54 m crew leaf and the bunks' 24.6° V |
| 1.5b | Oak partitions against oak lining in an unlit room | the wardroom, unlit | flagged and explicitly *not solved* by the round that built it. Same class as 1.4 and 1.6 — see also [material is about what is behind it] |
| 1.5c | **The furniture can be used now** — eleven stations: the chart chair, a form each side of the mess table, the port sea chest, and all seven berths. A berth is a pose and a view; the eye lands just above the lee board, so you see out and cannot sit up | walk below and use them, in this order: turn in to the crew's upper bunk, then the captain's berth (he wakes looking *forward*, windows behind his head), then sit at the mess, then the port chest | whether "Turn in / Turn out" is the right verb, and whether a berth wants to be more than a pose. The time-skip seam is left deliberately unbuilt — that decision belongs with provisioning |
| 1.5d | **The deadlights are shipped.** Four shutters on one closure, lofted on the stern wall's 18° rake | at night with the lamp lit — that is the whole contrast argument — and then at noon | they zero the windows' light channel one line from where the hold's boards zero theirs: **65% of the cabin's metered daylight at noon, 94% with the sun astern**. They are fitting timber at 0.28 luminance against the lining's 0.52, which is this round's answer to the oak-on-oak problem 1.5b could not solve |
| 1.5e | **The hatchway boards and the fore scuttle's soffit are drawn in the stow's oak on the lining's finish**, and nobody chose that pairing — it is what fell out of a colour argument that never reached a pixel. Two halves, both small, both yours | the hold shaft and the forecastle deckhead, unlit | (a) they carry roughness **0.72**, the lining's, where the fitting oak they are drawn in is **0.86** — a pairing that exists nowhere else aboard; (b) the geometry's own comments say these pieces *are* lining and should be the paler **0xa08258** rather than oak's **0x5b452c**, which is a **1.8× albedo change** in an unlit room and lands straight on 1.5b. The classification is now honest in the code and neither pixel has moved |
| 1.6 | The timber | anywhere below | you have already called it "flat orange and ugly"; this decides whether a materials round gets funded |

Rounds waiting on this section: the below-decks furnishing slice (wardroom and
forecastle) is being built now and lands into the same rooms.

## 2. How she sails — one sail, ~30 minutes

| # | What to look at | Where | What it settles |
|---|---|---|---|
| 2.1 | The crew's hands: standing trim duty and the dogvane helm | sailing panel, `CURRENT_MODERATE` | S5's accept-when. Tuning levers are `TRIM_STEP_DEG` and the trimmers' probe interval |
| 2.2 | The moving rig itself, and the smoothness of it | any point of sail, ±5° trim | S4's A/B bundle, never signed off |
| 2.3 | Placeholder furl rolls, and the new starboard pin rails | strike the kites; look at both rails | whether the honest placeholder furl is good enough to keep |
| 2.4 | The 30× evolution clock | order a sail evolution under time compression | you said you would "have to eyeball it"; this is that eyeball |
| 2.5 | **The navigator beating to a pin upwind** — built and gated: she fetched a 4 km dead-upwind mark in 644 s on three tacks, and gybes rather than tacks downwind | drop a pin upwind in `WIND_CHOP`, order "sail there", watch from the deck | S6's accept-when. The headless evidence proves the contract and the bounds; it cannot prove that a beat *reads* as a beat |
| 2.6 | **The sails are cloth now.** Six things to look at, in the M6 handover §13: the aback square topsail on a beat (the biggest silhouette change), twist on an eased main, slatting through a tack, the resized furl rolls, and the dead-calm bag | **Four sheets**, `?cloth=alive` against `?cloth=flat`, each on a named point of sail — this is why the cloth was unphotographable until now, and both blockers are built: [**the square topsail on a beat**](../../evidence/ab/cloth-topsail-aback/cloth-sheet.png), aloft at +45° pitch, wind 45° off the bow (33.4 % of pixels, max 180, **1190×** its cross-page floor) · [**an eased main**](../../evidence/ab/cloth-eased-main/cloth-sheet.png) from the helm looking forward, wind 135° (16.8 %, max 187, signed **−0.31**) · [**head to wind**](../../evidence/ab/cloth-head-to-wind/cloth-sheet.png), wind 5° off the bow, the shape a tack passes through (32.1 %, max 152, signed **+0.66**) · [**close-hauled from the deck**](../../evidence/ab/cloth-beat/cloth-sheet.png) (33.8 %, max 149, signed **+0.55**). `?cloth=still` freezes the flogging clock and is not on the sheets — a still cannot show a clock | M6's accept-when. Two admissions come with it: there is no hang model, so a sail in a dead calm is shaped rather than drooping, and `rigLayout()` still draws the flat arm. Two of the six are still not on a sheet: the **furl rolls** want a struck kite and the **dead-calm bag** wants a calm preset, and neither is a point of sail |

| ~~2.7~~ | ~~She has induced drag now~~ **ACCEPTED 2026-08-17.** Ash: "polar change due to aero is fine." She points much less well and reaches slightly better, and that stands | | settled |
| 2.8 | Two gates deliberately reversed by that round | | **Irons flipped toward success**: backing a headsail frees her in 48.4 s where she was pinned for the full 240 s. **Tack completion flipped toward failure**: she crosses the eye every time but hangs at 21–33° on the new bow, and the dominant term is the aback square topsail at 35 m². She still tacks — the voyage beats 4 km to windward on 3 of 3 — because the script now hands the topsail at the order, which the navigator already did |

| 2.9 | **A decision WX3 is waiting on, and it is cheaper to answer before anything is built on top of it.** A preset's authored *maturity* caps how big a freshening wind can make its sea: `CURRENT_MODERATE` is `maturity: 0.28`, fetch-limited water, so even a sustained 14 m/s builds its wind sea only to 0.98 m | the Weather panel's three-wind readout, watching the water as the glass falls | correct physics, and it is what keeps every preset itself at rest. But if the intent is that weather eventually makes the sea **big**, the dial is the presets' maturity — or a later round makes maturity a duration state and gives up an exact identity. The narrower form of the question: should a freshening wind build a *bigger* sea, or merely a *steeper* one? |

## 3. The look of the water and the sky — sit with it, ~30 minutes

These are the ones that move pixels, and the reason several rounds stopped where
they did.

| # | The question | The lever | Consequence |
|---|---|---|---|
| ~~3.1~~ | ~~Is the night legible?~~ **ANSWERED AND IMPLEMENTED 2026-08-17: REJECTED.** Scotopic vision now ships **off, at 0%**. The direct path neither engages nor precompiles its pass. Part B remains at 12.14× after a lift-free display audit (sea code 17 moonless → 52 full moon); Part C is inactive and hidden unless a non-zero `?scotopic=` explicitly opts in | `?scotopic=1` remains the non-shipping comparison arm | settled |
| 3.2 | Moonlight strength — a full moon moved ambient 1.8× where reality is 100–300× | **[sheet](../../evidence/ab/legacy-moonlight/legacyMoonlight-sheet.png)** — `legacyMoonlight`, off by default and byte-identical off, restores the pre-Part-B sky power of 0.070. Two nights, both at a −30° sun: a **full moon 27.5° up** (99.9 % of pixels, max 185, **signed −8.87 levels** — the shipping moon is nine sRGB codes brighter than the old one over the whole frame) and a **91 %-lit moon 52° up** (99.8 %, signed **−6.39**). Same-arm control **bit-identical** in both rows, so the whole delta is the switch | Part B's numeric gate is met (12.14× on `ambientRadiance`); this is the eye on top of it. Dial is `MOON_SKY_POWER` |
| ~~3.2a~~ | ~~Breaking crests at night got much brighter through the scotopic pass.~~ The rejected pass now ships off, so `CrestSpray` follows its pre-Part-A direct path again. The old sheet remains valid evidence for the optional `?scotopic=1` arm, not for the product default | **[historical partial sheet](../../evidence/ab/scotopic/scotopic-sheet.png)**, row 2 | settled with 3.1; whether spray should tone-map is a separate future change |
| ~~3.2b~~ | ~~The lamp's flame core was bleached to neutral.~~ **ANSWERED AND IMPLEMENTED 2026-08-17:** the wick no longer receives its own co-located point light, visible burn is tone-safe, and measured display RGB remains warm at 0.983/0.673/0.444 | deck and cabin lamps checked close at night | settled |
| 3.3 | Sun behind cloud is one ray driving the whole world's key light — no patchiness | needs building | named the biggest "weather over water" win on the roadmap |
| 3.4 | Tone-curve toe strength | **[sheet](../../evidence/ab/no-toe/noToe-sheet.png)** — `TONE_TOE_STRENGTH = 0.5`, page-load `?noToe=1`. **The plumbing was never the blocker for a verdict:** a paired sheet does not need a live flip. Removing the toe lifts the frame by a signed **+6.8 levels**, max 57, against a cross-page floor of 0.014 | cannot be judged live until it is a uniform rather than a page-load switch — that plumbing is the actual blocker |
| 3.5 | Horizon band thinning — physically right at 4.90×, thinned deliberately | live, but **no registered switch**, so no sheet — the thinning is a constant with no second arm | whether we keep departing from the physics here |
| 3.6 | Sun-versus-ambient balance: delete `pow(sunMag, 0.52)` | **no registered switch**, so no sheet | moves every lit surface in the game |
| ~~3.7~~ | ~~`VESSEL_MIRROR_OCCLUSION` 0.85 versus 0.6~~ **ANSWERED — no verdict needed.** The A/B is bit-identical to 0.006% of pixels, max 1/255, at three sun elevations including one looking down at the water alongside the hull — and the switch moves *more* than the constant does | | struck 2026-08-17 |
| 3.8 | The sun disc at sunset is a pale dot | **not an A/B** — one arm only, so it wants a single frame rather than a sheet | |
| 3.9 | Cached cloud march versus live march sharpness | **[sheet](../../evidence/ab/cloud-live-march/cloudLiveMarch-sheet.png)** — `setLiveMarch()`, now registered as `cloudLiveMarch`. 8.5–10.2 % of pixels, max 106–126, confined to cloud edges as a sharpness difference should be | whether the cache's softness is acceptable |
| 3.10 | The foam's beauty pass | unbuilt work rather than an A/B, so no sheet. (`foamLookupLegacy` is indexed separately and is a different question) | you have asked for "stunning foam" and it is still owed |
| 3.10a | The sun's aureole: the seven-sample ambient mean spikes the whole scene's fill as the sun crosses the sample rings — 0.36 → 1.296 at 26° | **[sheet](../../evidence/ab/sun-dome-mean/sunDomeMean-sheet.png)** — `?sunDomeMean=1`, default **off** and gated byte-identical off. Four elevations: the spike is at **26° exactly as predicted**, worth a signed **+2.01 levels** whole-frame, falling to +1.09 at 34°, +0.44 at 55° and +0.11 at 20° | the fix makes it a smooth monotone rise. It moves daylight, which is why it ships off; the deeper fix that would end the whole class wants its own round |
| 3.10b | **Two thirds of the fill's apparent response to cloud was the estimator.** The ambient fill is a flat average of seven fixed directions against an aerosol lobe of g = 0.94, so it wanders 13% dark under a thick deck at a 76° sun and 13% bright under the same deck at 39°, swinging **2.82× while the sky itself changes by 1.13×** | **[sheet](../../evidence/ab/fibonacci-ambient/fibonacciAmbient-sheet.png)** — `?fibonacciAmbient=1`, default **off**, byte-identical off. Five elevations: **−1.38 levels at 26°, −1.41 at 40°, −1.06 at 45°, and the sign flips to +0.56 at 53°**; night is barely touched at +0.09. The drifting-deck condition is *not* in the sheet — cloud cover is not a scene field | 256 Fibonacci directions instead — and they cost nothing, because the harmonic probe already evaluates and caches them, so the ON arm *removes* seven sky evaluations and seven cloud marches per frame. Clear daylight comes out ~5% darker, moving **toward** the converged integral rather than away. Worth A/B-ing at 26° vs 40° sun, then under a drifting deck at 45° — that second one is the bigger fault |
| ~~3.11~~ | ~~The star dome moved~~ **ANSWERED — no verdict needed.** 0% of pixels differ at four pitches with the headland mounted. The dome radius demonstrably moves (485 m against 46,540 m, read back live) and reaches no pixel; the stars it moves are not in frame, exactly as this line's own arithmetic predicted | | struck 2026-08-17 |
| 3.12 | **The M1 hull look decisions were never re-judged**, and the graphics TODO section that demanded it has been sitting closed-looking ever since | **no registered switch**, so no sheet: every roughness is a separate authored constant with no "old" arm to photograph | `Schooner.ts` records that the hull roughnesses were fitted against a 0.3-strength sky probe and have been reflecting the sky at 3.3× that ever since. Every roughness on the ship is therefore a value chosen under a transform that no longer exists |

### 3.13 The colour pipeline's other five — never given a line here, all shot

Assembling this file missed them: the colour-pipeline round shipped six A/B
switches and only the tone curve reached the queue. The other five have been
waiting for a verdict since, invisibly. They are one glance each now.

| switch | sheet | the arms differ by |
|---|---|---|
| `legacyToneCurve` — ACES against the hue-preserving curve | [sheet](../../evidence/ab/legacy-tone-curve/legacyToneCurve-sheet.png) | midday signed **+15.3** levels, Southern at 9° **+4.4**, night **−13.2** — ACES is much brighter by day and much darker at night |
| `legacyExposure` — the fixed 0.335 plateau against the adaptation curve | [sheet](../../evidence/ab/legacy-exposure/legacyExposure-sheet.png) | the largest switch in the set: signed **−26.1** at midday, **−30.9** at 9°, −4.8 at night |
| `noChromaTrim` — the sky's 1.25 chroma stretch | [sheet](../../evidence/ab/no-chroma-trim/noChromaTrim-sheet.png) | 99.2 % of pixels, max 21, signed **+3.1** at midday |
| `legacySkyHue` — hand-fitted against spectrally derived | [sheet](../../evidence/ab/legacy-sky-hue/legacySkyHue-sheet.png) | mean **9.2** but signed only **−0.71** — a hue change, not a level change |
| `legacyWaterHue` — near-grey backscatter against seawater's 3.63 blue:red | [sheet](../../evidence/ab/legacy-water-hue/legacyWaterHue-sheet.png) | small and localised: 9.1 % of pixels at midday, 24.8 % on a rough sea at 9° |
| `flatSkyMean` — rough-sea reflection collapsed to a cosine mean | [sheet](../../evidence/ab/flat-sky-mean/flatSkyMean-sheet.png) | 17–19 % of pixels, max 26–27, mean 0.35–0.44 |
| `shoulder` 0.80 vs 0.70 | [sheet](../../evidence/ab/shoulder/shoulder-sheet.png) | 44.1 % of pixels, max 142, signed **−1.42**, against a cross-page floor of 0.0015 |

### 3.14 Weather MVP — one bounded eye-and-ear pass

A follow-up browser pass cleared bright-water rain, dark storm rain, the solid
wind vector at the helm and outside, and the night review bolt. The remaining
rows are narrower taste checks; thunder has not been auditioned.

| # | What to review | Where | What it settles |
|---|---|---|---|
| 3.14a | Off, clear, rain, and storm coherence | `?debug=weather`, same camera and time | whether cloud cover and haze feel like weather rather than a grade change |
| 3.14b | Remaining rain and wind-vector placement | moonlight, diagnostic raft, and remaining cinematic distance knots | whether the vessel-scaled cue and bounded near field stay clean outside the passed schooner views |
| 3.14c | Lightning and delayed thunder | **Trigger review strike** by day, then listen on deck/below decks | daylight bolt width; thunder level, delay, decay, and enclosure muffling |

Five more sit in `docs/ocean/OCEAN_LOOK_ROUND_HANDOVER.md` §5: the fuzzy
afternoon horizon, the missing pale aerosol band above the horizon (flagged
there as "likely the real remaining bright-day cue"), crest skew without the
clamp that made warts, an independent sky-dome gain, and sea-on-sea sun
shadowing.

## 3b. Display calibration — retired with the rejected default

Part C only derives Part A's lift, and Part A now ships at zero. A default player
is no longer asked to perform a measurement that cannot affect the picture.
Settings exposes the five-second patch ladder only in an explicit
a non-zero `?scotopic=` lab session; saved measurements remain inert otherwise. The old
15/29/49 code measurements remain valid for that optional arm only.

## 3c. Twenty of these are now pictures

`evidence/ab/` holds twenty committed A/B sheets with an index mapping each to
its queue line, so most of section 3 is a glance rather than a dev-server
session. Answerable from an image now: **3.1** scotopic (signed +21.5 levels on
the night sea), **3.4** the tone toe (+6.8, six hundred times its floor — the
"needs a uniform first" objection was never a blocker for a *sheet*), **3.9**
cached versus live cloud march, **3.10a** the sun's aureole (the spike at 26° is
confirmed), **3.10b** the Fibonacci fill (−1.38 at 26°, and the **sign flips** to
+0.56 at 53°), **4.2** the Kelvin pattern, and five colour-pipeline switches that
had been waiting invisibly because this queue never listed them.

**2.6 and 3.2 joined them on 2026-08-17**, when the three capabilities they were
waiting on were built: a read-back for `?cloth=`, a `trueWindAngleDeg` scene
field that puts her on a named point of sail, and a `dayOfYear` field that lets
the search leave the opening day and find a moon. 3.2 turned out to want a
switch as well — `legacyMoonlight`, the pre-Part-B sky power — which nobody had
said out loud.

Still not answerable, each for a named reason rather than for want of trying:
**3.5, 3.6, 3.12** (constants with no second arm registered) · **3.8** (one arm
only — it wants a single frame, which `ab-sheet` cannot express, though
`tools/inspect-view.mjs` can) · **4.3, 4.4** (rhythm is temporal and a sheet is
a still) · **1.5e** (a look decision with no arm built, like 3.5).

## 0. Read first — Ash walked her on 2026-08-17

He gave seven pieces of feedback and two verdicts at the end of that session,
recorded in full at the foot of `docs/project/SESSION_HANDOVER_2026-08-17.md`.
The scotopic rejection is now implemented and the new polar recorded accepted;
unresolved faults still outrank everything below. The climb interaction faults
are also implemented: gaze/storey selection, walk-in/walk-out and below-deck
exclusion are gated, and the captain's berth curtain is a real privacy closure.
The running rigging now crosses with the sails, and the Moon is a deliberately
larger continuously lit sphere. The rebuilt bow-entry spray has now passed a
live agent browser check at shipping density; Ash's final taste verdict remains
welcome rather than blocking.

## 4. The wake — one tow, ~10 minutes

| # | The question | Why it is stuck |
|---|---|---|
| 4.1 | **A question you were asked and have not answered.** The ghost streak you reported — does it approach from ahead and pass, or hold station off the beam? | the two answers have completely different causes; the harness could not reproduce it either way, so the thread cannot proceed without this |
| 4.2 | WK4: keep or kill the Kelvin far field | **[sheet](../../evidence/ab/kelvin-pattern/kelvinPattern-sheet.png)** — now registered as `kelvinPattern`. From the helm looking astern: 10.7–11.0 % of pixels, max 88–230, confined to the wedge. It is off by default and reads as a decal because a normal-only wake cannot mix with water that has height |
| 4.3 | **WK3 bow spray was rebuilt after Ash could not see it.** A real tear now sheds 3× the water, throws higher/farther outboard, and measures 62 droplets/s moderate / 158/s Southern running while remaining exactly zero at anchor and on glass | embodied on the foredeck at ~3.3 m/s in moderate, then ~5.2 m/s in Southern. The lab labels it bow-only and adds a ×0–4 density control independent of timing | **Agent browser pass:** a shipping-density Southern running event coincided with a visible plunge and cleared the bow as a large, unmistakable white ejection. Physical arms remain 0.5/1.5; the two reaches retain the same 0.133/s rhythm |
| 4.4 | **Southern running at 135° is the only state where the overtop cue draws at all**, and both its new behaviours (the landing, the inboard fold) are unreviewed | that state specifically, plus one look at the puffs against a twilight sky | `CrestSpray` is additive and `OvertopSpray` is alpha-blended, each carrying a comment saying the other is wrong, and nobody has ever seen overtop puffs against a bright sky |


## 5. The voyage and the clock

| # | The question | Recommendation |
|---|---|---|
| 5.1 | Voyage clock: honest 1× or governed | currently defaults to honest 1× while the calendar stays 30×; that split is implemented and wants your verdict, not a rebuild |
| 5.2 | Should the calendar follow the voyage rate? | |
| 5.3 | Terrain R1's overall verdict (TERR-136) | R2, the real-data spike, is not authorised until R1 exits — this is the gate |
| 5.4 | Does `?terrain=global` read as one world across globe and post-teleport local tiles? | Globe relief passed an initial eye check. Review several land/ocean teleports and a near-coast local view. Synthetic remains default (the authored opening of the time was a city centre on land); this does not accept R1, Gate A, or GLO-30. |

## 6. Designs written and never read

Three concept documents are finished, unmerged and unread. They cost you
reading time, not dev-server time.

| # | Document | The load-bearing question inside it |
|---|---|---|
| 6.1 | `PROVISIONING_CONCEPT.md` — the ledger is the interface, the hold is the truth | pacing: at 30×, 150 water-days is ~120 real hours. The rate tuning cannot be set until you say whether a voyage can ever be skipped or slept through |
| 6.2 | `CREW_COMFORTS_CONCEPT.md` — alcohol as a captain-identity dial, morale as five channels, no shanties | does the game depict flogging at all? It shapes the whole discipline design |
| 6.3 | `PAY_AND_MONEY_CONCEPT.md` — money as a ledger and a port interface, never a gauge | |

All three are on `claude/ship-resource-management-c6b385`, which is behind
master.

---

## What is *not* in this queue

Work that is genuinely headless — physics with measurable gates, geometry with
invariants, tooling, documentation — does not appear here and should not wait
for you. If a round is sitting still and its open item is not on this list, it
is not blocked on you and someone should say why it stopped.

SURV0 and the current SURV1 foundation are in that headless category. Their
remaining production ingress and motion coupling are implementation gates, not
look-and-feel verdicts.
