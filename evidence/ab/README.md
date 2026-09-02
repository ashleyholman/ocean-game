# Paired A/B sheets — the review queue, as pictures

Twenty sheets, each answering one line of `docs/project/REVIEW_QUEUE.md`
without a dev-server session. Open the PNG, look at the two arms and the
amplified difference beside them, and say which one ships.

Built by `tools/ab-sheet.mjs`, documented in `docs/graphics/AGENT_INSPECTION.md`.
Each directory holds the sheet and its manifest; the individual full-size frames
are written beside them but deliberately not tracked, because the manifest
records everything needed to re-shoot them.

---

## Read this first: three pairs came out identical

Not "similar". **Bit-identical** — the two arms produced the same pixels, and
the same-arm control proves the harness could have seen a difference if there
had been one. Each of these is a finding rather than a picture, and each
closes or re-aims a queue line without Ash looking at anything.

| switch | queue line | what the arms measured |
| --- | --- | --- |
| **`starDome` near vs far** | 3.11 | **0 % of pixels, max 0**, at four pitches (+25°, +5°, −2°, −12°) at the Stem with the headland mounted, sun −34°. The dome radius demonstrably moves — 485 m against 46 540 m, read back live — and reaches no pixel. Stars *are* drawn in these frames (0.09–0.23 % of pixels, max 85–218, measured by hiding the mesh), so the population the fix moves simply is not in frame. The queue's own arithmetic says why: at most Sirius and Canopus, in a band under 0.4° tall, which is about seven pixels at this framing. **3.11 needs no verdict.** |
| **`vesselSkyOcclusion` on vs off** | 3.7 | **0.006–0.027 % of pixels, max 1/255, mean 0.0003** at sun 48°, 9° and −34°, including a scene looking down over the rail at the water alongside the hull (yaw 90°, pitch −38°). `setVesselSkyOcclusion(false)` zeroes *both* `VESSEL_SKY_OCCLUSION` and `VESSEL_MIRROR_OCCLUSION`, so this is 0.85 → **0.0**, a larger move than the 0.85 → 0.6 the queue asks about. If the whole term is invisible, the constant inside it cannot matter. **3.7 is moot at these viewpoints** — the sheet is kept as the evidence, not as a comparison. |
| **`sunDomeMean` on the old capture path** | 3.10a | Before the harness fix below, this measured mean **3.34**/255 against a same-arm floor of **3.33**. The sheet was a photograph of the harness. It is now real (see the index) — but the shape of that mistake is worth keeping: an unsigned mean can be entirely noise. |

---

## How to read a row

Three panels: **arm A**, **arm B**, and their difference amplified by the gain
in the caption. The difference panel says *where* the change is and never how
big; the numbers say how big. At high gain the panel also amplifies the
renderer's one-level output dither into visible confetti — read it for the shape
of the change, not for its texture.

| number | what it means |
| --- | --- |
| **% of pixels** | how much of the frame moved at all |
| **max** | the largest single-channel move, 0–255 |
| **mean** | the average unsigned move — sensitive to edges, rigging and glitter |
| **signed luma** | arm B minus arm A, in sRGB code levels. This is the number for a question about *level*. A large mean beside a signed luma near zero means the frame changed without getting brighter or darker, which is what a hue change looks like — `legacySkyHue` moves a mean of 9.2 levels and a signed 0.7 |

Every live sheet also carries a **same-arm control**: the identical path, same
arm both times. All of them come out bit-identical (0 %, max 0), so the whole of
every delta below is the switch. The two page-load sheets (`shoulder`, `noToe`)
have a cross-page control instead, which cannot be bit-identical and is quoted
with them.

`sunElevationDeg` is a **request**. The solar walk lands on the nearest instant
in the scene's day and the manifest records what was drawn. The opening day tops
out near 76° and bottoms out at **−34°**, so a scene asking for −40° gets −34°.

Every shot now also records **`moonElevationDeg`, `moonIlluminatedFraction` and
`moonPower`** — `power` is post-gate, so zero means the moon contributes nothing
to that frame whatever the almanac says — and **`trueWindAngleDeg`**, the point
of sail the scene was staged on, or null when it named none.

---

## The index

### Night — REVIEW_QUEUE §3

| queue | sheet | look at | the arms differ by |
| --- | --- | --- | --- |
| ~~**3.1**~~ Is the night legible? | [`scotopic/`](scotopic/scotopic-sheet.png) | **historical verdict sheet; Ash rejected the lifted arm and 0 now ships.** Open sea over the rail and deck lamp; row 3 is where the operator retires | moderate sea, sun −34°: **99.2 % of pixels, max 180, mean 30.0, signed +21.5 levels**. Southern Ocean, sun −34°: 98.2 %, max 183, mean 28.9, **signed +21.4**. Civil twilight, sun −6°: 34.3 %, max 150, **mean 0.39, signed +0.008** — effectively retired |
| **3.2a** Breaking crests at night | [`scotopic/`](scotopic/scotopic-sheet.png) row 2 | the whitewater on the Southern Ocean row against the sea behind it | the crests move with the rest of the frame: signed **+21.4** levels, max **183**. **Caveat: this is not a clean A/B of 3.2a.** There is no switch for "`CrestSpray` tone-mapped or not", so this row shows the operator and the spray fix together and cannot separate them |
| **3.4** Tone-curve toe strength | [`no-toe/`](no-toe/noToe-sheet.png) | the shadowed deck and the hull's dark side at a 9° sun; the toe is the only thing between them and black | **99.9 % of pixels, max 57, mean 9.0, signed +6.8 levels** — removing the toe lifts the shadows by seven levels. Cross-page control 1.4 % of pixels, mean 0.014, so the margin is about 600× |
| **3.9** Cached cloud march vs live | [`cloud-live-march/`](cloud-live-march/cloudLiveMarch-sheet.png) | the cloud edges overhead at pitch +32°: this is a sharpness question, so read the silhouettes, not the level | sun 48°: **8.5 % of pixels, max 106, mean 0.53, signed +0.08**. Sun 9°: 10.2 %, max 126, mean 0.62. Localised at the edges, as a sharpness difference should be |
| **3.10a** The sun's aureole | [`sun-dome-mean/`](sun-dome-mean/sunDomeMean-sheet.png) | the shadowed deck and hull across four sun elevations — this is a *fill* question, so the signed number is the one that matters | sun 20°: signed **+0.11**. Sun 26°: **+2.01** levels over 98.7 % of the frame. Sun 34°: **+1.09**. Sun 55°: **+0.44**. The spike is at 26° exactly as the queue predicted, and it is worth 2 sRGB levels of whole-frame brightening |
| **3.10b** The estimator under the fill | [`fibonacci-ambient/`](fibonacci-ambient/fibonacciAmbient-sheet.png) | the same shadowed surfaces, and the **sign flip** between 45° and 53° | sun 26°: signed **−1.38**. 40°: **−1.41**. 45°: **−1.06**. 53°: **+0.56** — the direction reverses. Night (−34°): **+0.09**, so the night thread is barely touched. Daylight is about 1.4 levels darker with the fix, which matches the "~5 % darker" the round measured |
| **3.2** Moonlight strength | [`legacy-moonlight/`](legacy-moonlight/legacyMoonlight-sheet.png) | the whole frame's level, and the deck — this is a *fill* question, so read the signed number. Left arm ships | full moon **27.5° up, 100 % lit** (day 32), sun −30°: **99.9 % of pixels, max 185, mean 26.4, signed −8.87 levels**. **91 % lit at 52°** (day 35): 99.8 %, max 185, mean 25.3, **signed −6.39**. Same-arm control **bit-identical** in both rows |
| **3.11** The star dome moved | [`star-dome/`](star-dome/starDome-sheet.png) | nothing — see the identical-pairs table above | **0 %, max 0**, at four pitches |

### Colour pipeline — the six switches the colour round left behind

The queue does not carry a line for five of these, which is itself a finding:
they have been waiting for a verdict since the colour-pipeline round and are
invisible in the backlog. Each is one glance now.

| switch | sheet | look at | the arms differ by |
| --- | --- | --- | --- |
| `legacyToneCurve` — ACES against the hue-preserving curve | [`legacy-tone-curve/`](legacy-tone-curve/legacyToneCurve-sheet.png) | the sky-to-sea gradient and the red ensign, at three conditions | midday: **99.96 %, max 66, mean 26.5, signed +15.3**. Southern Ocean at 9°: 99.7 %, max 47, mean 16.2, signed +4.4. Night: 100 %, max 59, mean 15.1, **signed −13.2** — ACES is much brighter by day and much darker at night |
| `legacyExposure` — the fixed 0.335 plateau against the adaptation curve | [`legacy-exposure/`](legacy-exposure/legacyExposure-sheet.png) | overall level; this is the largest switch in the set | midday: 100 %, mean **32.9**, **signed −26.1**. Sun 9°: mean 38.7, **signed −30.9**. Night: mean 6.5, signed −4.8 |
| `noChromaTrim` — the sky's 1.25 chroma stretch | [`no-chroma-trim/`](no-chroma-trim/noChromaTrim-sheet.png) | the blue of the sky band above the horizon | midday: 99.2 %, max 21, mean 8.4, **signed +3.1**. Sun 9°: 99.9 %, max 16, mean 6.7, signed +0.6 |
| `legacySkyHue` — hand-fitted against spectrally derived | [`legacy-sky-hue/`](legacy-sky-hue/legacySkyHue-sheet.png) | the sky's hue only — the level barely moves | midday: 99.2 %, max 22, **mean 9.2 but signed only −0.71**. Sun 9°: 99.9 %, max 22, mean 7.6, signed +0.29. A textbook hue-not-level change |
| `legacyWaterHue` — near-grey backscatter against seawater's 3.63 blue:red | [`legacy-water-hue/`](legacy-water-hue/legacyWaterHue-sheet.png) | the water in shadow and in the troughs, where backscatter is not swamped by reflection | midday moderate: **9.1 % of pixels**, max 19, mean 0.92. Southern Ocean at 9°: 24.8 %, max 12, mean 1.70. A small, localised change |
| `flatSkyMean` — rough-sea reflection collapsed to a cosine mean | [`flat-sky-mean/`](flat-sky-mean/flatSkyMean-sheet.png) | the reflection on the steep faces of a rough sea | Southern Ocean at 48°: 18.6 %, max 27, mean 0.44. At 9°: 17.3 %, max 26, mean 0.35, signed −0.21 |
| `shoulder` 0.80 vs 0.70 (page-load) | [`shoulder/`](shoulder/shoulder-sheet.png) | the blue band of sky, which 0.70 spreads over ~9 levels instead of 3 | **44.1 % of pixels, max 142, mean 1.96, signed −1.42**. Cross-page control 0.07 % of pixels, mean 0.0015 — a margin of about 1300× |

### The rig — REVIEW_QUEUE §2.6, the M6 cloth

Four sheets rather than one, because the question is not "what does cloth look
like" but "what does it do on each point of sail", and a point of sail is a
scene rather than a viewpoint. Left arm ships. The `trueWindAngleDeg` scene
field is what made these stageable at all — it commands the heading, snaps the
yaw and **re-sides the sheets for the resulting tack**, without which a scene on
the other tack draws every sail aback and captions it a broad reach.

| sheet | look at | the arms differ by |
| --- | --- | --- |
| [`cloth-topsail-aback/`](cloth-topsail-aback/cloth-sheet.png) — the square topsail on a beat | aloft from the break at +45° pitch, wind 45° off the bow. The biggest silhouette change of the six, and the one the M6 handover leads with | **33.4 % of pixels, max 180, mean 2.63, signed +0.24**. Cross-page control mean 0.0022 — a margin of about **1190×**, the cleanest page-load pair in this directory |
| [`cloth-eased-main/`](cloth-eased-main/cloth-sheet.png) — twist on an eased main | from the helm looking forward at +25°, wind 135° off the bow: the mainsail fills the frame, so read the leech and the foot | 16.8 % of pixels, max 187, mean 0.85, **signed −0.31**. Control mean 0.053, so about 16× |
| [`cloth-head-to-wind/`](cloth-head-to-wind/cloth-sheet.png) — slatting | wind 5° off the bow — the shape a tack passes through, held still | 32.1 %, max 152, mean 2.23, **signed +0.66**. Control mean 0.040, about 56× |
| [`cloth-beat/`](cloth-beat/cloth-sheet.png) — close-hauled from the deck | the same beat as the first row from eye level at +22°, which is where a player actually stands | 33.8 %, max 149, mean 2.35, **signed +0.55**. Control mean 0.076, about 31× |

Two of 2.6's six items are still not here and neither is a point of sail: the
resized **furl rolls** want a struck kite, and the **dead-calm bag** wants a calm
preset. `?cloth=still` is not on a sheet either, and cannot be — it freezes a
clock, and a still frame has no clock in it.

### Water and wake — REVIEW_QUEUE §4

| queue | sheet | look at | the arms differ by |
| --- | --- | --- | --- |
| **4.2** Keep or kill the Kelvin far field | [`kelvin-pattern/`](kelvin-pattern/kelvinPattern-sheet.png) | the wedge astern from the helm at pitch −22°, and whether it reads as part of the water or as a decal on top of it | sun 48°: **10.7 % of pixels, max 88, mean 1.30**. Sun 9°: 11.0 %, **max 230**, mean 1.56. Confined to the wedge, which is what a far-field pattern should look like |
| (not a queue line) `foamLookupLegacy` | [`foam-lookup-legacy/`](foam-lookup-legacy/foamLookupLegacy-sheet.png) | foam edges on a rough sea | 22.3 % of pixels, **max 196**, mean 1.35, signed −0.02 — a large local change with no level change, i.e. the foam moves rather than brightens. This is *not* 3.10's "beauty pass", which is unbuilt work rather than an A/B |

---

## Queue lines that could NOT be given a sheet, and exactly why

Naming the blocker is the deliverable for these. None of them is "ran out of
time"; each is a specific missing capability, and most are one small change away.

| queue | why there is no sheet | what would unblock it |
| --- | --- | --- |
| ~~**2.6**~~ The sails are cloth now | **BOTH BLOCKERS BUILT 2026-08-17** — see the cloth section above. `VesselRuntime.sailClothMode` reads the arm back off the loft state, and `trueWindAngleDeg` names the point of sail | |
| ~~**3.2**~~ Moonlight strength | **BUILT 2026-08-17** — `dayOfYear` lets the search leave the opening day, and `legacyMoonlight` is the second arm nobody had asked for out loud | |
| ~~**3.2a**~~ `CrestSpray` brightness at night | the `scotopic` sheet's Southern Ocean row records the bundled change | **settled with 3.1:** the pass now ships off, restoring the pre-Part-A spray path. An isolated tone-mapping change would be a new round |
| **3.2b** The lamp's flame core is bleached | not an A/B — there is nothing to compare against. It wants a single close frame of a lit lamp, which the capture host can stage (`stand=Cabin` at night) but `ab-sheet` cannot express | a single-frame capture mode, or `inspect:view` |
| **3.3** Sun behind cloud | the queue says "needs building", correctly. There is no second arm |
| **3.5** Horizon band thinning (4.90× vs thinned) | no switch. The thinning is a constant with no A/B arm | a registered switch over the two values |
| **3.6** Delete `pow(sunMag, 0.52)` | no switch. Same shape as 3.5 | a registered switch |
| **3.8** The sun disc at sunset is a pale dot | not an A/B — one arm only. Same shape as 3.2b |
| **3.10** The foam's beauty pass | unbuilt work, not a comparison. `foamLookupLegacy` is a different question and is indexed above so it is not mistaken for this |
| **3.12** The M1 hull roughnesses | no switch. Every roughness on the ship is a separate authored constant in `Schooner.ts`/`shipPalettes.ts`; there is no "old vs new" arm to photograph | a bundled `legacyHullRoughness` switch, which is a round of its own |
| **4.3** WK3 spray rhythm | rhythm is temporal and a sheet is a still. The gate is "do the bursts land when the bow visibly plunges and *only* then", which no pair of frames can answer | a video capture, or the lab line Ash already has |
| **4.4** Overtop at 135° in Southern | needs the ship on a specific point of sail relative to the sea. Same missing capability as 2.6 |
| **1.5e** The boards' and soffit's finish | no switch. The oak-on-lining-roughness pairing is one authored constant against another (0.72 vs 0.86) and the albedo question is a third (0x5b452c vs 0xa08258), with no "old" arm to photograph. Same shape as 3.5 | a registered switch over the two finishes, which is worth building alongside 1.5b rather than alone |
| **§1** below decks (1.1–1.6) | the capture host *can* stand below (`stand=Cabin`, `Wardroom`, `Forecastle`), so several of these are reachable as single frames or day/night pairs — but none of them is a switch A/B, so `ab-sheet` is the wrong instrument. 1.4 (dark reds crushing at night, clipping pink when lit) is the closest to a pair and would want a lamp-on/lamp-off switch |

---

## What the round found about the instrument itself

Two defects in the live A/B path, both fixed in `src/debug/captureHost.ts`, and
both of which had been silently corrupting every live sheet taken before them.

**1. The ship was still under way between the two arms.** `captureAb` settled
three frames at 1/60 s after applying each arm, and `setPaused` stops the
calendar, not the vessel. Measured: the eye moved 7 mm along the deck and 6 mm
across it in those three frames, and 64 mm in forty-eight. In a frame full of
rigging, glitter and foam a sub-pixel shift resamples every edge — the same arm
photographed twice through that settle differed by a mean of **3.33**/255 over
48 % of the frame, growing to 24.7 at forty-eight frames, with its **signed luma
at zero throughout**, which is the signature of a picture that moved rather than
one that changed. `sunDomeMean` measured 3.34 against that 3.33. Settling at
**dt = 0** instead — nothing may integrate between two arms — puts the eye at
identical coordinates to six decimal places and the same-arm control at
**0 % of pixels, max 0**.

**2. Half the registry moves a term the render never re-read.** Several switches
move a CPU-side lighting quantity — the ambient fill above all — which reaches
the picture through `refreshLighting`/`refreshWorldLighting`, not through a
uniform the next render happens to upload. `sunDomeMean` moved the fill to
**0.85×** at a 27° sun and moved the frame by nothing. `captureAb` now refreshes
the lighting after applying an arm; the same flip then moves the frame by a
signed **+2.32** levels over 99 % of it.

Three smaller additions came out of the same work, all in the tool or the
registry:

- **A null control on every live sheet.** The page-load path always measured its
  floor with a third page at the same arm and failed the run if the floor was
  not clearly smaller. The live path had nothing equivalent and needed it more.
  It now shoots the same arm twice through the identical path, per scene, and
  fails the run when the delta does not clear the floor by 2× — or when the two
  arms come out bit-identical, which is how `starDome` and `vesselSkyOcclusion`
  reported themselves.
- **A signed luma statistic.** The unsigned mean cannot tell "the deck is two
  levels brighter" from "every specular edge resampled". Both of the defects
  above were found by the signed number being zero where the unsigned one was
  not.
- **The sun elevation that was actually drawn**, on every shot, because the
  solar walk lands on the nearest instant it can find and a caption reading
  "sun −40°" over a frame at −34° is exactly the substitution this instrument
  exists to refuse. The three sheets committed before this round all carried
  that error.

**The three sheets committed before tonight were stale** and have been
re-shot. Their manifests' switch stamps show it: they were taken against a build
with no `sunDomeMean`, no `fibonacciAmbient` and no `scotopic` in the registry,
which is to say before the ambient-set and night rounds landed. A night frame
from that build is visibly a different night. A sheet's tier stamp is what
dates it — check it before trusting an old one.

Also removed: each manifest was carrying a 4.6 MB base64 PNG in its
`determinism.baselineDataUrl`, so three manifests were 13.6 MB of image in files
that are otherwise a page of numbers. That baseline is a frame like any other
and is now written beside the sheet as `determinism-baseline.png`, untracked.
The three existing manifests came down to 11.5 KB together.

## Re-shooting any of these

Everything a sheet needs is in its manifest — arms, scenes, tier, surface, diff
gain, terrain, and any extra URL parameters. For example:

```bash
node tools/ab-sheet.mjs --switch sunDomeMean --arm 0 --arm 1 \
  --scene 'seaState=CURRENT_MODERATE,waveTimeSeconds=120,lookYawDeg=140,stand=Waist,sunElevationDeg=26' \
  --diff 12 --verify --out evidence/ab/sun-dome-mean
```

`node tools/ab-sheet.mjs --list` prints the whole registry.
